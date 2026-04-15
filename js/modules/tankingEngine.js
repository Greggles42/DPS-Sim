/**
 * Tanking simulation engine for gSim.
 * Simulates incoming mob melee attacks against a player defender.
 * Uses EQMacEmu formulas from attack.cpp, npc.cpp, client_process.cpp.
 *
 * Key references:
 *   attack.cpp: Mob::AvoidanceCheck, Mob::AvoidDamage, Mob::CalcMeleeDamage, RollD20
 *   attack.cpp: Client::GetMitigation, Client::GetAvoidance, NPC::GetOffense, NPC::GetDamageBonus
 *   npc.cpp:    NPC skill init (weaponSkill = 250+level in PoP, else min(level*5,250))
 *   Riposte: counter-attack using player mainhand weapon + offense stats.
 *   CH chain: derived from DTPS and player HP to guide healer rotation.
 */
(function (global) {
  'use strict';

  // Standard Complete Heal cast time in seconds (Cleric, unmodified)
  var CH_CAST_TIME_SEC = 10;

  // Safety multiplier for recommended CH interval: 1.5 = allow 50% spike above mean DTPS
  var CH_SAFETY_FACTOR = 1.5;

  function getEQCombat() {
    return global.EQCombat || null;
  }

  // ---- Avoidance helpers ----

  /**
   * Player avoidance used in the mob's hit-chance check (AvoidanceCheck).
   * Source: Client::GetAvoidance() in attack.cpp — based on a Sony developer post decompile.
   *   defenseAvoidance = defense_skill * 400 / 225
   *   agiAvoidance     = level+AGI-dependent table (max 53 at level 40+, AGI 200)
   * No hard cap applies to clients (unlike NPCs which cap at 400/460).
   */
  function getPlayerAvoidance(level, defenseSkill, agi) {
    var L   = level != null ? level : 60;
    var def = defenseSkill != null ? defenseSkill : 200;
    var agiVal = agi != null ? agi : 100;

    var defenseAvoidance = def > 0 ? Math.floor(def * 400 / 225) : 0;

    // AGI avoidance — decompile by Secrets (see attack.cpp Client::GetAvoidance)
    var agiAvoidance = 0;
    if (agiVal < 40) {
      agiAvoidance = Math.floor(25 * (agiVal - 40) / 40);          // -25 to 0
    } else if (agiVal >= 60 && agiVal <= 74) {
      agiAvoidance = Math.floor(2 * (28 - Math.floor((200 - agiVal) / 5)) / 3);
    } else if (agiVal >= 75) {
      var bonusAdj = L < 7 ? 35 : L < 20 ? 55 : L < 40 ? 70 : 80;
      if (agiVal < 200) {
        agiAvoidance = Math.floor(2 * (bonusAdj - Math.floor((200 - agiVal) / 5)) / 3);
      } else {
        agiAvoidance = Math.floor(2 * bonusAdj / 3);
      }
    }

    var avoidance = defenseAvoidance + agiAvoidance;
    if (avoidance < 1) avoidance = 1;
    return avoidance;
  }

  /**
   * Individual per-swing probabilities for each avoidance skill (AvoidDamage, applied after hit check).
   * Source: attack.cpp Mob::AvoidDamage — checks fire in order: Block → Parry → Riposte → Dodge.
   *   chance = (skill + 100) / divisor;  Roll(chance) = random(0,99) < chance  → chance/100 probability.
   *   Block divisor=25, Parry divisor=50, Riposte divisor=55, Dodge divisor=45.
   * Note: parry/riposte require InFront and not ranged; riposte requires a weapon equipped (Client rule).
   */
  function getAvoidanceRates(opts) {
    function rate(skill, divisor) {
      if (!skill || skill <= 0) return 0;
      return Math.min(1, Math.floor((skill + 100) / divisor) / 100);
    }
    return {
      block:   rate(opts.playerBlockSkill,   25),
      parry:   rate(opts.playerParrySkill,   50),
      riposte: rate(opts.playerRiposteSkill, 55),
      dodge:   rate(opts.playerDodgeSkill,   45)
    };
  }

  /**
   * Combined chance that at least one avoidance check succeeds on a swing that passed the hit check.
   * Checks fire in order Block → Parry → Riposte → Dodge; each is independent.
   */
  function getCombinedAvoidanceChance(rates) {
    return 1 - (1 - rates.block) * (1 - rates.parry) * (1 - rates.riposte) * (1 - rates.dodge);
  }

  // ---- Mitigation ----

  /**
   * Player mitigation fed into RollD20 for incoming NPC damage.
   * Source: Client::GetMitigation() in attack.cpp.
   *
   * Inputs:
   *   itemAC      — raw sum of AC on all equipped items (NOT displayed AC)
   *   spellAC     — spell/buff AC bonus
   *   classId     — player class string
   *   defSkill    — defense skill value
   *   agi         — AGI stat
   *   era         — era string: 'classic','kunark','velious','luclin','pop'
   *
   * Key rules:
   *   • Item AC multiplied by 4/3 for non-casters (Nec/Wiz/Mag/Enc get raw value).
   *   • Anti-twink cap: level < 50 → min(acSum, level*6+25).
   *   • Defense skill: /3 for non-casters, /2 for casters.
   *   • Spell AC: /4 for non-casters, /3 for casters.
   *   • AGI bonus: floor(agi/20) when agi > 70.
   *   • Softcap by era/class (350 Classic; up to 430 Warrior Velious+).
   *   • Overcap scaling in Luclin/PoP: varies by class/level (1:3 for warriors at L60 PoP).
   */
  function getPlayerMitigation(level, itemAC, spellAC, classId, defSkill, agi, era) {
    var L   = level  != null ? level  : 60;
    var cls = (classId || '').toLowerCase();
    var isCaster = cls === 'wizard' || cls === 'magician' || cls === 'necromancer' || cls === 'enchanter';

    // Item AC — multiply by 4/3 for non-casters
    var acSum = itemAC || 0;
    if (!isCaster) acSum = Math.floor(4 * acSum / 3);

    // Anti-twink cap (level < 50)
    if (L < 50 && acSum > L * 6 + 25) acSum = L * 6 + 25;

    // Rogue AGI bonus (max 12)
    if (cls === 'rogue' && L >= 30 && (agi || 0) > 75) {
      var rogAgi = agi || 0;
      var rogScale = L - 26;
      var rogBonus = rogAgi < 80  ? Math.floor(rogScale / 4) :
                     rogAgi < 85  ? Math.floor(rogScale * 2 / 4) :
                     rogAgi < 90  ? Math.floor(rogScale * 3 / 4) :
                     rogAgi < 100 ? rogScale : Math.floor(rogScale * 5 / 4);
      acSum += Math.min(12, rogBonus);
    }
    // Beastlord AGI bonus (max 16)
    if (cls === 'beastlord' && L > 10 && (agi || 0) > 75) {
      var bstAgi = agi || 0;
      var bstScale = L - 6;
      var bstBonus = bstAgi < 80  ? Math.floor(bstScale / 5) :
                     bstAgi < 85  ? Math.floor(bstScale * 2 / 5) :
                     bstAgi < 90  ? Math.floor(bstScale * 3 / 5) :
                     bstAgi < 100 ? Math.floor(bstScale * 4 / 5) : bstScale;
      acSum += Math.min(16, bstBonus);
    }

    if (acSum < 0) acSum = 0;

    // Defense skill contribution
    var def = defSkill || 0;
    if (def > 0) acSum += isCaster ? Math.floor(def / 2) : Math.floor(def / 3);

    // Spell AC
    acSum += Math.floor((spellAC || 0) / (isCaster ? 3 : 4));

    // AGI bonus: +1 per 20 AGI above 70
    if ((agi || 0) > 70) acSum += Math.floor((agi || 0) / 20);

    if (acSum < 0) acSum = 0;

    // Softcap by era and class
    var isVelious = era === 'velious' || era === 'luclin' || era === 'pop';
    var isLuclin  = era === 'luclin'  || era === 'pop';
    var isPop     = era === 'pop';

    var softcap = 350;
    if (L > 50 && isVelious) {
      if      (cls === 'warrior')                                             softcap = 430;
      else if (cls === 'paladin' || cls === 'shadowknight' ||
               cls === 'cleric'  || cls === 'bard')                          softcap = 403;
      else if (cls === 'ranger'  || cls === 'shaman')                        softcap = 375;
      // monk, rogue, druid, bst, wiz, enc, nec, mag → 350
    }

    if (acSum <= softcap) return acSum;

    // Over softcap
    if (L <= 50 || !isLuclin) return softcap;  // hard cap pre-Luclin

    var overcap = acSum - softcap;
    var returns = 20; // default (melee non-warrior classes in PoP, and Luclin)

    if (!isPop) {
      // Luclin era: 1:12 returns; casters get no overcap
      if (isCaster) overcap = 0;
      else returns = 12;
    } else {
      // PoP era: class-specific returns
      if (cls === 'warrior') {
        returns = L <= 61 ? 5 : L <= 63 ? 4 : 3;
      } else if (cls === 'paladin' || cls === 'shadowknight') {
        returns = L <= 61 ? 6 : L <= 63 ? 5 : 4;
      } else if (cls === 'bard') {
        returns = L <= 61 ? 8 : L <= 63 ? 7 : 6;
      } else if (cls === 'monk' || cls === 'rogue') {
        returns = L <= 61 ? 20 : L === 62 ? 18 : L === 63 ? 16 : L === 64 ? 14 : 12;
      } else if (cls === 'ranger' || cls === 'beastlord') {
        returns = L <= 61 ? 10 : L === 62 ? 9 : L === 63 ? 8 : 7;
      }
      // casters in PoP still get returns=20 (they can overcap in PoP)
    }

    return softcap + Math.floor(overcap / returns);
  }

  // ---- Mob attack ----

  /**
   * Mob to-hit value (used in AvoidanceCheck hit-chance formula).
   * Source: Mob::GetToHit() in attack.cpp = 7 + GetSkill(SkillOffense) + GetSkill(weaponSkill).
   * NPC weapon/offense skills from npc.cpp:
   *   PoP (PlanesEQ): weaponSkill = 250 + level  (for level > 50)
   *   Other eras:     weaponSkill = min(level*5, 250)
   * If mobAccuracy > 0 it overrides (maps directly to the accuracy DB field added to toHit).
   */
  function getMobToHit(mobLevel, mobAccuracy, isPoP) {
    var L = mobLevel != null ? mobLevel : 60;
    if (mobAccuracy != null && mobAccuracy > 0) {
      // User-supplied accuracy: treat as the full toHit override
      var baseSkill = isPoP && L > 50 ? (250 + L) : Math.min(L * 5, 250);
      return 7 + baseSkill + baseSkill + mobAccuracy;
    }
    var weaponSkill = isPoP && L > 50 ? (250 + L) : Math.min(L * 5, 250);
    return 7 + weaponSkill + weaponSkill;
  }

  /**
   * NPC melee base damage (DI * 10) derived from min/max hit range.
   * Source: NPC::GetBaseDamage() in attack.cpp.
   *   di1k = floor((max-min)*1000/19), rounded to nearest 100 (i.e. nearest 0.1 DI)
   *   baseDamage = di1k / 100 = DI * 10
   * The D20 roll [1..20] maps this to the [min..max] hit range when combined with damageBonus.
   */
  function getMobBaseDamage(minDmg, maxDmg) {
    if (maxDmg <= minDmg) return Math.max(1, minDmg);
    var di1k = Math.floor((maxDmg - minDmg) * 1000 / 19);
    di1k = Math.floor((di1k + 50) / 100) * 100;  // round to nearest 0.1
    return Math.max(1, Math.floor(di1k / 100));
  }

  /**
   * NPC offense rating (used in RollD20 damage roll).
   * Source: Mob::GetOffense() in attack.cpp.
   *   baseOffense = min(level*5.5 - 4, 320)  (flat cap at 320)
   *   strOffense  = level*2 - 40  (for level >= 30; +20 in PoP zones)
   *   offense     = baseOffense + strOffense + mob ATK bonus
   * Note: level 46-50 NPCs use level=45 for offense (skill cap plateau); skipped here
   *       as it only matters for non-raid trash in that narrow range.
   */
  function getMobOffenseRating(mobLevel, isPoP, mobATK) {
    var L   = mobLevel != null ? mobLevel : 60;
    var atk = mobATK || 0;

    var baseOffense = Math.min(Math.floor(L * 55 / 10) - 4, 320);

    var strOffense;
    if (L < 6) {
      baseOffense = L * 4;
      strOffense  = L;
    } else if (L < 30) {
      strOffense = Math.floor(L / 2) + 1;
    } else {
      strOffense = L * 2 - 40;
      if (isPoP) strOffense += 20;
    }

    return Math.max(1, baseOffense + strOffense + atk);
  }

  /**
   * Roll a single NPC damage hit using CalcMeleeDamage / RollD20.
   * Source: NPC::GetBaseDamage() + Mob::CalcMeleeDamage() in attack.cpp.
   *   baseDamage = getMobBaseDamage(min,max)  — fixed DI*10, NOT a random value
   *   damage     = floor(D20roll * baseDamage + 5) / 10 + damageBonus
   * The D20 roll [1..20] scales base from min_dmg (roll=1) to max_dmg (roll=20).
   */
  function rollNPCDamage(minDmg, maxDmg, offenseRating, mitigation, damageBonus, rng) {
    var eq = getEQCombat();
    var baseDamage = getMobBaseDamage(minDmg, maxDmg);
    if (eq && eq.rollD20) {
      var roll = eq.rollD20(offenseRating, mitigation, rng);
      var dmg  = Math.floor((roll * baseDamage + 5) / 10);
      if (dmg < 1) dmg = 1;
      return dmg + (damageBonus || 0);
    }
    // Fallback: average damage
    return Math.floor((minDmg + maxDmg) / 2);
  }

  // ---- Riposte damage ----

  /**
   * Compute player offense rating for riposte counter-attack.
   * Matches combat.js: offenseRating = offenseSkill + STR_bonus + wornAttack + spellAttack.
   * STR_bonus = floor((2*STR - 150) / 3) when STR >= 75, else 0.
   */
  function getPlayerOffenseRating(offenseSkill, str, wornAttack, spellAttack) {
    var skill   = offenseSkill != null ? Math.min(255, Math.max(0, offenseSkill)) : 200;
    var s       = str != null ? str : 100;
    var strBonus = s >= 75 ? Math.floor((2 * s - 150) / 3) : 0;
    var atk     = (wornAttack || 0) + (spellAttack || 0);
    return Math.max(1, skill + strBonus + atk);
  }

  /**
   * Mob mitigation for player riposte damage roll.
   * Uses level-based formula from combat.js (same getMitigation), feeding mobAC.
   */
  function getMobMitigation(mobLevel, mobAC) {
    var eq = getEQCombat();
    if (eq && eq.getMitigation) {
      return eq.getMitigation(mobLevel, mobAC || 0, 0, 0);
    }
    var L = mobLevel != null ? mobLevel : 60;
    var mit;
    if (L < 15) { mit = L * 3; if (L < 3) mit += 2; }
    else { mit = Math.floor(L * 41 / 10) - 15; }
    if (mit > 200) mit = 200;
    var ac = mobAC || 0;
    if (mit === 200 && ac > 200) mit = ac;
    if (mit < 1) mit = 1;
    return mit;
  }

  /**
   * Roll one riposte counter-attack.
   * Uses calcMeleeDamage + getDamageBonusClient from combat.js.
   * Crit chance is applied via rollMeleeCrit.
   * @returns {number} damage dealt on riposte
   */
  function rollRiposteDamage(opts, mobMitigation, rng) {
    var eq = getEQCombat();
    if (!eq || !eq.calcMeleeDamage) {
      // Simple fallback: random in [1, weaponDamage]
      return 1 + Math.floor(rng() * Math.max(1, opts.playerWeaponDamage || 10));
    }
    var weaponDmg = opts.playerWeaponDamage != null ? opts.playerWeaponDamage : 10;
    var delay     = opts.playerWeaponDelay  != null ? opts.playerWeaponDelay  : 30;
    var is2H      = !!opts.playerWeaponIs2H;
    var classId   = opts.playerClassId || 'warrior';
    var level     = opts.playerLevel   != null ? opts.playerLevel : 60;

    var offenseRating = getPlayerOffenseRating(
      opts.playerOffenseSkill,
      opts.playerStr,
      opts.playerWornAttack,
      opts.playerSpellAttack
    );
    var damageBonus = eq.getDamageBonusClient
      ? eq.getDamageBonusClient(level, classId, delay, is2H)
      : 0;

    var dmg = eq.calcMeleeDamage(weaponDmg, offenseRating, mobMitigation, rng, damageBonus);

    // Crit check (uses rollMeleeCrit)
    if (eq.rollMeleeCrit) {
      var dex = opts.playerDex != null ? opts.playerDex : 150;
      var critMult = opts.playerCritChanceMult || 0;
      var critResult = eq.rollMeleeCrit(dmg, damageBonus, level, classId, dex, critMult, false, false, 0, false, rng);
      dmg = critResult.damage;
    }

    return Math.max(1, dmg);
  }

  /**
   * Roll Return Kick damage (monk AA): uses flying kick formula (skillBase=29, min=level*4/5).
   */
  function rollReturnKickDamage(opts, mobMitigation, rng) {
    var eq = getEQCombat();
    var level = opts.playerLevel != null ? opts.playerLevel : 60;
    var FK_SKILL_BASE = 29;
    if (!eq || !eq.calcMeleeDamage) {
      return Math.max(1, Math.floor(level * 4 / 5));
    }
    var offenseRating = getPlayerOffenseRating(
      opts.playerOffenseSkill,
      opts.playerStr,
      opts.playerWornAttack,
      opts.playerSpellAttack
    );
    var dmg = eq.calcMeleeDamage(FK_SKILL_BASE, offenseRating, mobMitigation, rng, 0);
    var fkMin = Math.floor(level * 4 / 5);
    dmg = Math.max(1, Math.max(dmg, fkMin));
    if (eq.rollMeleeCrit) {
      var dex = opts.playerDex != null ? opts.playerDex : 150;
      var critMult = opts.playerCritChanceMult || 0;
      var critResult = eq.rollMeleeCrit(dmg, 0, level, opts.playerClassId || 'monk', dex, critMult, false, false, 0, false, rng);
      dmg = critResult.damage;
    }
    return Math.max(1, dmg);
  }

  // ---- Complete Heal chain analysis ----

  /**
   * Compute Complete Heal chain metrics from DTPS and player HP.
   *
   * A Complete Heal fills the tank to max HP. The chain must land before the tank dies.
   * castTimeSec: how long the spell takes to land (default 10 sec for unmodified Cleric CH).
   *
   * Max safe interval  = HP / DTPS
   *   → If a CH lands every T seconds and fills HP to max, the tank can survive T seconds.
   *
   * Recommended interval = HP / (DTPS × safety_factor)
   *   → Leaves headroom for incoming spike damage above the mean DTPS.
   *
   * Clerics needed = ceil(castTimeSec / recommendedInterval)
   *   → Each cleric stagger-casts; they need to fire fast enough for the chain to land
   *     at the recommended interval.
   *
   * CH call threshold = DTPS × castTimeSec
   *   → The HP value at which a cleric must *start* casting so CH lands before death.
   *     If HP is below this and no CH is in flight, the tank is in danger.
   *
   * @param {number} dtps - damage taken per second (post-avoidance, post-mitigation)
   * @param {number} playerHP - player max HP
   * @param {number} castTimeSec - CH cast time in seconds (default 10)
   * @returns {Object}
   */
  function calcCHChain(dtps, playerHP, castTimeSec) {
    var cast = castTimeSec != null ? castTimeSec : CH_CAST_TIME_SEC;
    if (dtps <= 0) {
      return {
        maxIntervalSec: Infinity,
        recommendedIntervalSec: Infinity,
        clericsNeeded: 0,
        chCallThresholdHP: 0,
        castTimeSec: cast,
        sustainable: true
      };
    }
    var maxInterval  = playerHP / dtps;
    var recInterval  = playerHP / (dtps * CH_SAFETY_FACTOR);
    var clericsNeeded = Math.ceil(cast / recInterval);
    var callThreshold = Math.ceil(dtps * cast);

    return {
      maxIntervalSec:         maxInterval,
      recommendedIntervalSec: recInterval,
      clericsNeeded:          clericsNeeded,
      chCallThresholdHP:      callThreshold,
      castTimeSec:            cast,
      sustainable:            false
    };
  }

  // ---- Main simulation ----

  /**
   * Simulate a mob attacking a player defender.
   *
   * New inputs vs. previous version:
   *   options.playerWeaponDamage   {number}  Mainhand base damage (for riposte)
   *   options.playerWeaponDelay    {number}  Mainhand delay in deciseconds (for damage bonus)
   *   options.playerWeaponIs2H     {boolean} 2H weapon (affects damage bonus formula)
   *   options.playerClassId        {string}  Class ID (for damage bonus formula)
   *   options.playerOffenseSkill   {number}  Offense skill (for riposte offense rating)
   *   options.playerStr            {number}  STR stat (for riposte offense rating)
   *   options.playerDex            {number}  DEX stat (for riposte crit chance)
   *   options.playerWornAttack     {number}  Worn ATK bonus (for riposte offense rating)
   *   options.playerSpellAttack    {number}  Spell ATK bonus (for riposte offense rating)
   *   options.playerCritChanceMult {number}  Combat Fury flat crit % (for riposte crits)
   *   options.mobAC                {number}  Mob AC (for player riposte damage roll)
   *   options.chCastTimeSec        {number}  CH cast time override (default 10)
   *
   * @param {Object} options
   * @returns {Object} tanking report
   */
  function runTankingFight(options) {
    var eq = getEQCombat();
    var rng;
    if (eq && eq.createRng) {
      rng = eq.createRng(options.seed);
    } else {
      var seed = options.seed != null ? options.seed : Date.now();
      rng = function () {
        seed = (seed * 1664525 + 1013904223) & 0xffffffff;
        return ((seed >>> 0) / 0x100000000);
      };
    }

    // ---- Mob stats ----
    var mobLevel          = options.mobLevel        != null ? options.mobLevel        : 60;
    var mobMinDmg         = options.mobMinDamage    != null ? Math.max(1, options.mobMinDamage) : 10;
    var mobMaxDmg         = options.mobMaxDamage    != null ? Math.max(mobMinDmg, options.mobMaxDamage) : 50;
    var mobAttackDelaySec = options.mobAttackDelay  != null ? options.mobAttackDelay / 10 : 2.0;
    var mobAttackDelayMs  = mobAttackDelaySec * 1000;
    var mobAttackCount    = options.mobAttackCount  != null ? Math.max(1, Math.min(4, options.mobAttackCount)) : 1;
    var isPoP             = options.era === 'pop';
    var mobToHit          = getMobToHit(mobLevel, options.mobAccuracy, isPoP);
    var mobOffenseRating  = getMobOffenseRating(mobLevel, isPoP, options.mobATK || 0);
    var mobAC             = options.mobAC           != null ? options.mobAC           : 0;

    // ---- Player stats ----
    var playerLevel       = options.playerLevel     != null ? options.playerLevel     : 60;
    var playerAC          = options.playerAC        != null ? options.playerAC        : 0;  // raw item AC sum
    var playerSpellAC     = options.playerSpellAC   != null ? options.playerSpellAC   : 0;
    var playerAGI         = options.playerAGI       != null ? options.playerAGI       : 100;
    var playerDefSkill    = options.playerDefenseSkill != null ? options.playerDefenseSkill : 200;
    var playerClassId     = options.playerClassId   || 'warrior';
    var naturalDurabilityRank = (options.naturalDurabilityRank | 0) || 0;
    var NATURAL_DURABILITY_BONUS = [0, 0.02, 0.05, 0.10];
    var naturalDurabilityFactor = NATURAL_DURABILITY_BONUS[Math.min(naturalDurabilityRank, 3)];
    var playerHPTotal     = options.playerHPTotal   != null ? options.playerHPTotal   : 4000;
    if (naturalDurabilityFactor > 0) playerHPTotal = Math.floor(playerHPTotal * (1 + naturalDurabilityFactor));
    var playerHPRegen     = options.playerHPRegen   != null ? options.playerHPRegen   : 0;
    var healerHPS         = options.healerHPS       != null ? options.healerHPS       : 0;
    var netRegenPerSec    = playerHPRegen + healerHPS;
    var fightDurationSec  = options.fightDurationSec != null ? options.fightDurationSec : 60;
    var durationMs        = fightDurationSec * 1000;

    // ---- Derived defense values ----
    var playerAvoidance  = getPlayerAvoidance(playerLevel, playerDefSkill, playerAGI);
    var playerMitigation = getPlayerMitigation(playerLevel, playerAC, playerSpellAC,
                             playerClassId, playerDefSkill, playerAGI, options.era || 'pop');
    var mobMitigation    = getMobMitigation(mobLevel, mobAC);

    // ---- Luclin/PoP AAs: mitigation and avoidance bonuses ----
    var combatStabilityRank  = (options.combatStabilityRank  | 0) || 0;
    var combatAgilityRank    = (options.combatAgilityRank    | 0) || 0;
    var innateDefenseRank    = (options.innateDefenseRank    | 0) || 0;
    var lightningReflexesRank = (options.lightningReflexesRank | 0) || 0;
    var COMBAT_STABILITY_BONUS = [0, 0.02, 0.05, 0.10]; // damage reduction % per rank (2/5/10%)
    var COMBAT_AGILITY_BONUS   = [0, 0.02, 0.05, 0.10]; // avoidance rate bonus per rank (2/5/10%)
    var combatStabilityFactor  = COMBAT_STABILITY_BONUS[Math.min(combatStabilityRank, 3)];
    var combatAgilityFactor    = COMBAT_AGILITY_BONUS[Math.min(combatAgilityRank, 3)];
    // Innate Defense: +2% mitigation per rank (stacks with Combat Stability)
    var innateDefenseFactor   = Math.min(innateDefenseRank, 5) * 0.02;
    // Lightning Reflexes: +2% avoidance per rank (stacks with Combat Agility)
    var lightningReflexesFactor = Math.min(lightningReflexesRank, 5) * 0.02;
    // Boost player mitigation by Combat Stability + Innate Defense
    var totalMitigationFactor = combatStabilityFactor + innateDefenseFactor;
    if (totalMitigationFactor > 0) {
      playerMitigation = Math.floor(playerMitigation * (1 + totalMitigationFactor));
    }

    // Per-skill individual avoidance rates (applied to swings that pass the hit check)
    var rates    = getAvoidanceRates(options);
    var hitChance = (eq && eq.getHitChance)
      ? eq.getHitChance(mobToHit, playerAvoidance)
      : (function () {
          var a = mobToHit + 10, b = playerAvoidance + 10;
          return a * 1.21 > b ? 1.0 - b / (a * 1.21 * 2.0) : (a * 1.21) / (b * 2.0);
        })();
    // Apply Combat Agility + Lightning Reflexes: reduce effective hit chance (more avoidance)
    var totalAvoidanceFactor = combatAgilityFactor + lightningReflexesFactor;
    if (totalAvoidanceFactor > 0) {
      hitChance = Math.max(0, hitChance - totalAvoidanceFactor);
    }
    var missChance = Math.max(0, 1 - hitChance);

    // Double Riposte: chance for a second riposte counter-attack per riposte
    var doubleRiposteRank = (options.doubleRiposteRank | 0) || 0;
    var DOUBLE_RIPOSTE_CHANCE = [0, 0.15, 0.35, 0.50];
    var doubleRiposteChance = DOUBLE_RIPOSTE_CHANCE[Math.min(doubleRiposteRank, 3)];

    // Return Kick (monk): bonus flying kick on riposte
    var returnKickRank = (options.returnKickRank | 0) || 0;
    var RETURN_KICK_CHANCE = [0, 0.25, 0.35, 0.50];
    var returnKickChance = RETURN_KICK_CHANCE[Math.min(returnKickRank, 3)];

    // NPC damage bonus (from min/max spread)
    var npcDamageBonus = (eq && eq.getDamageBonusNPC)
      ? eq.getDamageBonusNPC(mobMinDmg, mobMaxDmg)
      : 0;

    // ---- Report skeleton ----
    var report = {
      mobName:              options.mobName || ('Level ' + mobLevel + ' NPC'),
      mobLevel:             mobLevel,
      mobMinDamage:         mobMinDmg,
      mobMaxDamage:         mobMaxDmg,
      mobAttackDelayMs:     mobAttackDelayMs,
      mobAttackCount:       mobAttackCount,
      mobToHit:             mobToHit,
      mobOffenseRating:     mobOffenseRating,
      mobDamageBonus:       npcDamageBonus,
      mobAC:                mobAC,

      playerLevel:          playerLevel,
      playerClassId:        playerClassId,
      playerAC:             playerAC,
      playerSpellAC:        playerSpellAC,
      playerAvoidance:      playerAvoidance,
      playerMitigation:     playerMitigation,
      playerHPTotal:        playerHPTotal,
      playerHPRegen:        playerHPRegen,
      healerHPS:            healerHPS,
      durationSec:          fightDurationSec,

      // Computed avoidance rates (analytical, not simulated)
      hitChance:            hitChance,
      missChance:           missChance,
      dodgeRate:            rates.dodge,
      parryRate:            rates.parry,
      riposteRate:          rates.riposte,
      blockRate:            rates.block,
      skillAvoidanceRate:   getCombinedAvoidanceChance(rates),

      // Simulation tallies
      rounds:               0,
      swingAttempts:        0,
      missedSwings:         0,
      dodgedSwings:         0,
      parriedSwings:        0,
      ripostedSwings:       0,
      blockedSwings:        0,
      landedSwings:         0,
      totalDamageTaken:     0,
      maxHitTaken:          0,
      minHitTaken:          Infinity,
      hitList:              [],

      // Riposte counter-damage
      riposteDamageTotal:   0,
      riposteMaxHit:        0,
      riposteCrits:         0,
      doubleRiposteHits:    0,
      returnKickHits:       0,
      returnKickDamage:     0,

      // Summary (computed after loop)
      dtps:                 0,
      effectiveDtps:        0,
      survivalTimeSec:      null,
      avoidanceRate:        0,
      mitigationPercent:    0,
      riposteDps:           0,

      // CH chain (computed after loop)
      chChain:              null
    };

    var hasRiposteWeapon = options.playerWeaponDamage != null && options.playerWeaponDamage > 0;
    var nextAttackMs = 0;
    var currentHP    = playerHPTotal;
    var survivalMs   = null;

    while (nextAttackMs < durationMs) {
      // HP regen between rounds
      if (netRegenPerSec > 0 && nextAttackMs > 0) {
        currentHP = Math.min(playerHPTotal, currentHP + netRegenPerSec * (mobAttackDelayMs / 1000));
      }

      report.rounds++;

      for (var i = 0; i < mobAttackCount; i++) {
        report.swingAttempts++;

        // 1. Hit check: does the mob's swing even connect?
        if (rng() >= hitChance) {
          report.missedSwings++;
          continue;
        }

        // 2. Block check (AvoidDamage order: Block → Parry → Riposte → Dodge)
        if (rates.block > 0 && rng() < rates.block) {
          report.blockedSwings++;
          continue;
        }

        // 3. Parry check
        if (rates.parry > 0 && rng() < rates.parry) {
          report.parriedSwings++;
          continue;
        }

        // 4. Riposte check — player counter-attacks if weapon equipped
        if (rates.riposte > 0 && rng() < rates.riposte) {
          report.ripostedSwings++;
          // Roll riposte counter-damage (uses player's weapon and offense stats)
          if (hasRiposteWeapon) {
            var riposteDmg = rollRiposteDamage(options, mobMitigation, rng);
            report.riposteDamageTotal += riposteDmg;
            if (riposteDmg > report.riposteMaxHit) report.riposteMaxHit = riposteDmg;
            // Double Riposte: chance for a second counter-attack
            if (doubleRiposteChance > 0 && rng() < doubleRiposteChance) {
              report.doubleRiposteHits++;
              var riposteDmg2 = rollRiposteDamage(options, mobMitigation, rng);
              report.riposteDamageTotal += riposteDmg2;
              if (riposteDmg2 > report.riposteMaxHit) report.riposteMaxHit = riposteDmg2;
            }
            // Return Kick (monk): bonus flying kick counter on riposte — uses FK damage formula
            if (returnKickChance > 0 && rng() < returnKickChance) {
              report.returnKickHits++;
              var rkDmg = rollReturnKickDamage(options, mobMitigation, rng);
              report.returnKickDamage += rkDmg;
              report.riposteDamageTotal += rkDmg;
              if (rkDmg > report.riposteMaxHit) report.riposteMaxHit = rkDmg;
            }
          }
          continue; // swing was negated
        }

        // 5. Dodge check
        if (rates.dodge > 0 && rng() < rates.dodge) {
          report.dodgedSwings++;
          continue;
        }

        // 6. Damage lands
        var dmg = rollNPCDamage(mobMinDmg, mobMaxDmg, mobOffenseRating, playerMitigation, npcDamageBonus, rng);
        if (dmg < 1) dmg = 1;

        report.landedSwings++;
        report.totalDamageTaken += dmg;
        report.hitList.push(dmg);
        if (dmg > report.maxHitTaken) report.maxHitTaken = dmg;
        if (dmg < report.minHitTaken) report.minHitTaken = dmg;

        // Survival tracking (first death only)
        if (survivalMs === null) {
          currentHP -= dmg;
          if (currentHP <= 0) survivalMs = nextAttackMs;
        }
      }

      nextAttackMs += mobAttackDelayMs;
    }

    if (report.minHitTaken === Infinity) report.minHitTaken = null;

    // ---- Summary stats ----
    report.dtps          = fightDurationSec > 0 ? (report.totalDamageTaken / fightDurationSec) : 0;
    report.effectiveDtps = Math.max(0, report.dtps - netRegenPerSec);
    report.riposteDps    = fightDurationSec > 0 ? (report.riposteDamageTotal / fightDurationSec) : 0;
    report.survivalTimeSec = survivalMs !== null ? (survivalMs / 1000) : null;

    // Total avoidance rate from simulation
    var totalAvoided = report.missedSwings + report.dodgedSwings + report.parriedSwings + report.ripostedSwings + report.blockedSwings;
    report.avoidanceRate = report.swingAttempts > 0 ? totalAvoided / report.swingAttempts : 0;

    // Mitigation: % damage reduced vs theoretical max (maxDmg × landed)
    var theoreticalMax = mobMaxDmg * report.landedSwings;
    report.mitigationPercent = theoreticalMax > 0
      ? (1 - report.totalDamageTaken / theoreticalMax) * 100
      : 0;

    // Survival with regen/healing
    if (netRegenPerSec > 0 && report.effectiveDtps > 0) {
      report.survivalTimeWithHealsSec = playerHPTotal / report.effectiveDtps;
    } else if (report.effectiveDtps <= 0) {
      report.survivalTimeWithHealsSec = Infinity;
    } else {
      report.survivalTimeWithHealsSec = fightDurationSec > 0 ? (playerHPTotal / report.dtps) : null;
    }

    // CH chain analysis
    report.chChain = calcCHChain(report.dtps, playerHPTotal, options.chCastTimeSec);

    return report;
  }

  // ---- Report formatter ----

  function formatTankingReport(report, runsAveraged) {
    if (report.error) return report.error;
    var runs = runsAveraged != null ? runsAveraged : 1;
    var C = 50; // value column
    function pad(label, value) {
      return label + ' '.repeat(Math.max(1, C - label.length)) + value;
    }
    function fmt(v, d) {
      if (v == null || v === Infinity) return '\u2014';
      return d != null ? Number(v).toFixed(d) : (Number.isInteger(v) ? String(v) : v.toFixed(2));
    }
    function pct(v, d) {
      return v == null ? '\u2014' : fmt(v * 100, d != null ? d : 1) + '%';
    }

    var lines = [];

    // ---- Mob ----
    lines.push('=== Mob (Attacker) ===', '');
    lines.push(pad('  Mob:', report.mobName));
    lines.push(pad('  Level:', String(report.mobLevel)));
    lines.push(pad('  Damage range:', report.mobMinDamage + ' \u2013 ' + report.mobMaxDamage + '  (+' + report.mobDamageBonus + ' DB)'));
    lines.push(pad('  Attack speed:', fmt(report.mobAttackDelayMs / 1000, 2) + ' sec/round'));
    lines.push(pad('  Attacks per round:', String(report.mobAttackCount)));
    lines.push(pad('  Calculated to-hit:', String(report.mobToHit)));
    lines.push(pad('  Mob AC (for riposte calc):', report.mobAC > 0 ? String(report.mobAC) : 'estimated from level'));
    if (runs > 1) lines.push(pad('  Runs averaged:', String(runs)));
    lines.push('');

    // ---- Player Defense ----
    lines.push('=== Player Defense ===', '');
    lines.push(pad('  Level:', String(report.playerLevel)));
    lines.push(pad('  Worn AC:', String(report.playerAC)));
    lines.push(pad('  Spell/Buff AC:', String(report.playerSpellAC)));
    lines.push(pad('  Total AC:', String(report.playerAC + report.playerSpellAC)));
    lines.push(pad('  Computed mitigation value:', String(report.playerMitigation) + '  (fed into damage roll formula)'));
    lines.push(pad('  Computed avoidance value:', String(report.playerAvoidance) + '  (fed into hit-chance formula)'));
    lines.push(pad('  Max HP:', String(report.playerHPTotal)));
    lines.push(pad('  HP regen/sec (self):', fmt(report.playerHPRegen, 1)));
    lines.push(pad('  Healer HPS:', fmt(report.healerHPS, 1)));
    lines.push('');

    // ---- Avoidance Breakdown ----
    lines.push('=== Avoidance Breakdown ===', '');
    lines.push(pad('  Miss chance (hit formula):', pct(report.missChance, 1) + '  (mob to-hit vs player avoidance value)'));
    lines.push('  -- Per-swing skill checks (applied to swings that pass the hit check) --');
    lines.push(pad('  Dodge chance:', pct(report.dodgeRate, 1)));
    lines.push(pad('  Parry chance:', pct(report.parryRate, 1)));
    lines.push(pad('  Riposte chance:', pct(report.riposteRate, 1) + '  (negates swing + counter-attacks)'));
    lines.push(pad('  Block chance:', pct(report.blockRate, 1)));
    lines.push(pad('  Combined skill avoidance:', pct(report.skillAvoidanceRate, 1) + '  (1 \u2212 P(all fail))'));
    lines.push('');
    lines.push('  -- Simulated results --');
    lines.push(pad('  Total swings:', String(report.swingAttempts)));
    lines.push(pad('  Missed (hit check):', report.missedSwings + '  (' + pct(report.swingAttempts ? report.missedSwings / report.swingAttempts : 0, 1) + ')'));
    lines.push(pad('  Dodged:', report.dodgedSwings  + '  (' + pct(report.swingAttempts ? report.dodgedSwings  / report.swingAttempts : 0, 1) + ')'));
    lines.push(pad('  Parried:', report.parriedSwings + '  (' + pct(report.swingAttempts ? report.parriedSwings / report.swingAttempts : 0, 1) + ')'));
    lines.push(pad('  Riposted:', report.ripostedSwings + '  (' + pct(report.swingAttempts ? report.ripostedSwings / report.swingAttempts : 0, 1) + ')'));
    lines.push(pad('  Blocked:', report.blockedSwings + '  (' + pct(report.swingAttempts ? report.blockedSwings / report.swingAttempts : 0, 1) + ')'));
    lines.push(pad('  Landed hits:', report.landedSwings + '  (' + pct(report.swingAttempts ? report.landedSwings / report.swingAttempts : 0, 1) + ')'));
    lines.push(pad('  Overall avoidance rate:', pct(report.avoidanceRate, 1)));
    lines.push('');

    // ---- Damage Taken ----
    lines.push('=== Damage Taken ===', '');
    lines.push(pad('  Total damage taken:', String(report.totalDamageTaken)));
    lines.push(pad('  DTPS (raw):', fmt(report.dtps, 2)));
    lines.push(pad('  Effective DTPS (after self-regen/heals):', fmt(report.effectiveDtps, 2)));
    lines.push(pad('  Mitigation (vs theoretical max dmg):', fmt(report.mitigationPercent, 1) + '%'));
    lines.push(pad('  Max hit taken:', String(report.maxHitTaken)));
    lines.push(pad('  Min hit taken:', report.minHitTaken != null ? String(report.minHitTaken) : '\u2014'));
    if (report.hitList.length > 0) {
      var sum = report.hitList.reduce(function (a, b) { return a + b; }, 0);
      lines.push(pad('  Average hit taken:', fmt(sum / report.hitList.length, 1)));
    }
    lines.push('');

    // ---- Riposte ----
    lines.push('=== Riposte Counter-Damage ===', '');
    if (report.ripostedSwings === 0) {
      if (report.riposteRate === 0) {
        lines.push('  No riposte skill entered — riposte counter-damage not calculated.');
      } else {
        lines.push('  No ripostes landed this simulation.');
      }
    } else {
      lines.push(pad('  Riposte swings:', String(report.ripostedSwings)));
      if (report.doubleRiposteHits > 0) {
        lines.push(pad('  Double Riposte extra hits:', String(report.doubleRiposteHits)));
      }
      if (report.returnKickHits > 0) {
        lines.push(pad('  Return Kick hits:', String(report.returnKickHits)));
      }
      lines.push(pad('  Total riposte damage:', String(report.riposteDamageTotal)));
      lines.push(pad('  Riposte DPS:', fmt(report.riposteDps, 2) + '  (outgoing damage to mob)'));
      lines.push(pad('  Max riposte hit:', String(report.riposteMaxHit)));
      if (report.riposteDamageTotal > 0 && report.ripostedSwings > 0) {
        lines.push(pad('  Average riposte hit:', fmt(report.riposteDamageTotal / report.ripostedSwings, 1)));
      }
    }
    lines.push('');

    // ---- Survivability ----
    lines.push('=== Survivability ===', '');
    if (report.survivalTimeSec != null) {
      lines.push(pad('  Time to death (no heals):', fmt(report.survivalTimeSec, 1) + ' sec'));
    } else {
      lines.push(pad('  Time to death (no heals):', 'Survived full ' + report.durationSec + ' sec fight'));
    }
    if (report.survivalTimeWithHealsSec === Infinity) {
      lines.push(pad('  Sustainable with current healing:', 'Yes \u2014 healing exceeds DTPS'));
    } else if (report.survivalTimeWithHealsSec != null) {
      lines.push(pad('  Time to death (with current healing):', fmt(report.survivalTimeWithHealsSec, 1) + ' sec'));
    }
    lines.push('');

    // ---- Complete Heal Chain ----
    var ch = report.chChain;
    lines.push('=== Complete Heal Chain Analysis ===', '');
    if (ch && ch.sustainable) {
      lines.push('  DTPS is 0 or negative \u2014 no CH chain needed.');
    } else if (ch && report.dtps > 0) {
      lines.push(pad('  CH cast time used:', fmt(ch.castTimeSec, 0) + ' sec'));
      lines.push(pad('  DTPS:', fmt(report.dtps, 2)));
      lines.push('');
      lines.push(pad('  Max CH interval (absolute):', fmt(ch.maxIntervalSec, 1) + ' sec'
        + '  \u2190 HP / DTPS; tank dies if CH lands slower'));
      lines.push(pad('  Recommended CH interval (\xd71.5 buffer):', fmt(ch.recommendedIntervalSec, 1) + ' sec'
        + '  \u2190 headroom for spike hits above mean'));
      lines.push(pad('  Clerics needed for full chain:', String(ch.clericsNeeded)
        + '  (stagger casts every ' + fmt(ch.recommendedIntervalSec, 1) + ' sec each)'));
      lines.push('');
      lines.push(pad('  CH call threshold:', String(ch.chCallThresholdHP) + ' HP'
        + '  \u2190 cleric must BEGIN casting when tank HP drops to this value'));
      lines.push('  \u2514 If HP is below this with no CH in flight, the tank will die before CH lands.');
      lines.push('');
      // Stagger schedule
      if (ch.clericsNeeded > 1) {
        lines.push('  Stagger schedule (' + ch.clericsNeeded + ' clerics, ' + fmt(ch.castTimeSec, 0) + '-sec CH):');
        var stagger = ch.castTimeSec / ch.clericsNeeded;
        for (var c = 0; c < ch.clericsNeeded; c++) {
          var startSec = stagger * c;
          var landSec  = startSec + ch.castTimeSec;
          lines.push('    Cleric ' + (c + 1) + ': start cast at t=' + fmt(startSec, 1)
            + 's  \u2192  CH lands at t=' + fmt(landSec, 1) + 's');
        }
      } else {
        lines.push('  Single cleric can sustain the chain at this DTPS.');
      }
    } else {
      lines.push('  Run the simulation to generate CH chain data.');
    }

    return lines.join('\n');
  }

  global.TankingEngine = {
    runTankingFight:     runTankingFight,
    formatTankingReport: formatTankingReport,
    calcCHChain:         calcCHChain,
    getPlayerAvoidance:  getPlayerAvoidance,
    getPlayerMitigation: getPlayerMitigation,
    getMobToHit:         getMobToHit,
    getMobOffenseRating: getMobOffenseRating,
    getAvoidanceRates:   getAvoidanceRates
  };
})(typeof self !== 'undefined' ? self : this);
