/**
 * NPC offense model for the tanking simulation.
 *
 * Everything a mob does to you in a melee round, faithful to EQMacEmu/Quarm:
 *   mob_ai.cpp        AI_Process combat block, DoMainHandRound, DoOffHandRound, Flurry
 *   attack.cpp        NPC::Attack, AvoidDamage, AvoidanceCheck, CalcMeleeDamage, GetOffense
 *   special_attacks.cpp  DoClassAttacks, DoSpecialAttackDamage, DoBash/DoKick, TryBashKickStun
 *   npc.cpp           NPC skill initialisation by class and level
 *   emu_constants.h   SpecialAbility ids
 *
 * The player-defence side lives in playerDefense.js; the shared damage/hit
 * primitives (rollD20, getHitChance, calcMeleeDamage) come from combat.js and are
 * used unchanged.
 */
(function (global) {
  'use strict';

  function getEQCombat() { return global.EQCombat || null; }

  // ---- SpecialAbility ids (common/emu_constants.h) ----
  var SA = {
    Summon: 1, Enrage: 2, Rampage: 3, AreaRampage: 4, Flurry: 5,
    TripleAttack: 6, DualWield: 7, DisallowEquip: 8, BaneAttack: 9,
    MagicalAttack: 10, RangedAttack: 11, SlowImmunity: 12,
    MesmerizeImmunity: 13, CharmImmunity: 14, StunImmunity: 15,
    SnareImmunity: 16, FearImmunity: 17, DispellImmunity: 18,
    MeleeImmunity: 19, MagicImmunity: 20, FleeingImmunity: 21,
    MeleeImmunityExceptBane: 22, MeleeImmunityExceptMagical: 23,
    AggroImmunity: 24, BeingAggroImmunity: 25, CastingFromRangeImmunity: 26,
    FeignDeathImmunity: 27, TauntImmunity: 28, TunnelVision: 29,
    NoBuffHealFriends: 30, PacifyImmunity: 31, Leash: 32, Tether: 33,
    PermarootFlee: 34, HarmFromClientImmunity: 35, AlwaysFlee: 36,
    FleePercent: 37, AllowBeneficial: 38, DisableMelee: 39,
    NPCChaseDistance: 40, AllowedToTank: 41, ProximityAggro: 42,
    AlwaysCallHelp: 43, UseWarriorSkills: 44, AlwaysFleeLowCon: 45,
    NoLoitering: 46, BadFactionBlockHandin: 47, PCDeathblowCorpse: 48,
    CorpseCamper: 49, ReverseSlow: 50, HasteImmunity: 51,
    DisarmImmunity: 52, RiposteImmunity: 53, ProximityAggro2: 54
  };

  // Names for the ones a tank actually cares about, for UI display.
  var SA_DISPLAY = {
    1: 'Summon', 2: 'Enrage', 3: 'Rampage', 4: 'Area Rampage', 5: 'Flurry',
    7: 'Dual Wield', 12: 'Slow Immune', 15: 'Stun Immune', 19: 'Melee Immune',
    22: 'Melee Immune (except bane)', 23: 'Melee Immune (except magical)',
    39: 'No Melee', 44: 'Warrior Skills', 50: 'Reverse Slow',
    51: 'Haste Immune', 53: 'Riposte Immune'
  };

  // EQ class ids as used by npc_types.class
  var CLASS = {
    Warrior: 1, Cleric: 2, Paladin: 3, Ranger: 4, ShadowKnight: 5, Druid: 6,
    Monk: 7, Bard: 8, Rogue: 9, Shaman: 10, Necromancer: 11, Wizard: 12,
    Magician: 13, Enchanter: 14, Beastlord: 15
  };

  // common/features.h reuse times, in seconds
  var REUSE = {
    bash: 8, kick: 8, backstab: 10, flyingkick: 8, roundkick: 8,
    tigerclaw: 7, eaglestrike: 6, dragonpunch: 6
  };

  // skills.cpp GetSkillBaseDamage base values, before the skill-level steps
  var SKILL_BASE = {
    bash: 2, kick: 3, dragonpunch: 12, flyingkick: 25,
    roundkick: 5, eaglestrike: 7, tigerclaw: 4
  };

  var MIN_HASTED_DELAY_MS = 400;   // RuleI(Combat, MinHastedDelay)
  var DEFAULT_FLURRY_CHANCE = 20;  // RuleI(Combat, NPCFlurryChance)
  var DEFAULT_RAMPAGE_CHANCE = 20;
  var ENRAGE_HP_PCT = 10;          // RuleI(NPC, StartEnrageValue)
  var ENRAGE_DURATION_MS = 10000;
  var ENRAGE_COOLDOWN_MS = 360000;
  var STUN_DURATION_MS = 2000;

  // ---- special_abilities parsing -------------------------------------------

  /**
   * npc_types.special_abilities is "id,param0,param1^id,param0^..." — parse it
   * into { id: [param0, param1, ...] }.
   */
  function parseSpecialAbilities(str) {
    var out = {};
    if (!str || typeof str !== 'string') return out;
    var groups = str.split('^');
    for (var i = 0; i < groups.length; i++) {
      var parts = groups[i].split(',');
      var id = parseInt(parts[0], 10);
      if (!isFinite(id) || id <= 0) continue;
      var params = [];
      for (var j = 1; j < parts.length; j++) {
        var v = parseInt(parts[j], 10);
        params.push(isFinite(v) ? v : 0);
      }
      out[id] = params;
    }
    return out;
  }

  /** Is the ability present and enabled? param0 of 0 means "off" for most flags. */
  function hasAbility(parsed, id) {
    var p = parsed && parsed[id];
    if (!p) return false;
    return p.length === 0 || p[0] !== 0;
  }

  /** Read a parameter, falling back to dflt when absent or zero. */
  function abilityParam(parsed, id, index, dflt) {
    var p = parsed && parsed[id];
    if (!p || p[index] === undefined || p[index] === 0) return dflt;
    return p[index];
  }

  /** Human-readable list for the mob card. */
  function describeSpecialAbilities(parsed) {
    var out = [];
    for (var id in parsed) {
      if (!Object.prototype.hasOwnProperty.call(parsed, id)) continue;
      if (!hasAbility(parsed, id)) continue;
      var name = SA_DISPLAY[id];
      if (!name) continue;
      if (Number(id) === SA.Flurry) {
        name += ' (' + abilityParam(parsed, SA.Flurry, 0, DEFAULT_FLURRY_CHANCE) + '%)';
      } else if (Number(id) === SA.Rampage || Number(id) === SA.AreaRampage) {
        name += ' (' + abilityParam(parsed, Number(id), 0, DEFAULT_RAMPAGE_CHANCE) + '%)';
      }
      out.push(name);
    }
    return out;
  }

  // ---- NPC skills (npc.cpp:300-405) ----------------------------------------

  /**
   * NPCs ignore client class-skill availability and caps; they get a flat
   * level-derived value. Note the pre-PoP cap is 210, not 250.
   */
  function getNpcSkillLevel(level) {
    return level > 50 ? 250 : Math.min(level * 5, 210);
  }

  function getNpcWeaponSkill(level, isPoP) {
    if (isPoP) return level > 50 ? (250 + level) : Math.min(level * 6, 275);
    return getNpcSkillLevel(level);
  }

  /**
   * Which class attack an NPC leads with, following DoClassAttacks' priority
   * chain: backstab, then monk specials in descending order, then bash/kick.
   * Returns null when the class has no class attack at this level.
   */
  function getNpcClassAttack(classId, level) {
    var skill = getNpcSkillLevel(level);
    var warriorSkills = classId === CLASS.Warrior;

    if (classId === CLASS.Rogue && level > 9) {
      return { skill: 'backstab', reuseSec: REUSE.backstab, skillLevel: skill };
    }
    if (classId === CLASS.Monk) {
      if (level > 29) return { skill: 'flyingkick', reuseSec: REUSE.flyingkick, skillLevel: skill };
      if (level > 24) return { skill: 'dragonpunch', reuseSec: REUSE.dragonpunch, skillLevel: skill };
      if (level > 19) return { skill: 'eaglestrike', reuseSec: REUSE.eaglestrike, skillLevel: skill };
      if (level > 9)  return { skill: 'tigerclaw', reuseSec: REUSE.tigerclaw, skillLevel: skill };
      if (level > 4)  return { skill: 'roundkick', reuseSec: REUSE.roundkick, skillLevel: skill };
      return null;
    }

    var hasKick = (warriorSkills || classId === CLASS.Ranger) && level > 15;
    var hasBash = (warriorSkills || classId === CLASS.Paladin ||
                   classId === CLASS.ShadowKnight || classId === CLASS.Cleric) && level > 5;

    if (hasKick && hasBash) {
      // DoClassAttacks rolls 66% for bash when the NPC has both.
      return { skill: 'kick', altSkill: 'bash', altChance: 66,
               reuseSec: REUSE.kick, altReuseSec: REUSE.bash, skillLevel: skill };
    }
    if (hasKick) return { skill: 'kick', reuseSec: REUSE.kick, skillLevel: skill };
    if (hasBash) return { skill: 'bash', reuseSec: REUSE.bash, skillLevel: skill };
    return null;
  }

  /**
   * The mob's own block/parry/riposte/dodge skills, used when the player
   * counter-attacks on a riposte. Only some classes get parry and riposte
   * (npc.cpp:340-405); everyone above level 10 dodges.
   */
  function getNpcDefenseSkills(classId, level) {
    var L = level;
    // Note the reassignment in npc.cpp before the defensive skills are set.
    var skillLevel = L > 50 ? 250 : Math.min(L * 5, 225);

    var hasParry = classId === CLASS.Warrior || classId === CLASS.Paladin ||
                   classId === CLASS.ShadowKnight || classId === CLASS.Ranger ||
                   classId === CLASS.Rogue || classId === CLASS.Bard;
    var hasRiposte = hasParry || classId === CLASS.Monk;
    var isMonk = classId === CLASS.Monk;

    return {
      block:   isMonk && L > 11 ? skillLevel : 0,
      parry:   hasParry && L > 6 ? Math.min(L * 5, 230) : 0,
      riposte: hasRiposte && L > 11 ? Math.min(L * 5, 225) : 0,
      dodge:   L > 10 ? Math.min(L * 5, isMonk ? 230 : 190) : 0
    };
  }

  /** skills.cpp GetSkillBaseDamage — base plus one step at skill 25/75/125/175. */
  function getSkillBaseDamage(skillName, skillLevel) {
    var base = SKILL_BASE[skillName];
    if (!base) return 0;
    if (skillLevel >= 25)  base++;
    if (skillLevel >= 75)  base++;
    if (skillLevel >= 125) base++;
    if (skillLevel >= 175) base++;
    return base;
  }

  // ---- Damage / offense derivation ------------------------------------------

  /**
   * NPC::GetBaseDamage — the "DI" (damage interval) implied by min/max hit.
   * Pairs with getDamageBonus so roll 1 lands on min_dmg and roll 20 on max_dmg.
   */
  function getBaseDamage(minDmg, maxDmg) {
    if (maxDmg <= minDmg) return Math.max(1, minDmg);
    var di1k = Math.floor((maxDmg - minDmg) * 1000 / 19);
    di1k = Math.floor((di1k + 50) / 100) * 100;
    return Math.max(1, Math.floor(di1k / 100));
  }

  /** NPC::GetDamageBonus — the flat "DB" added on top of every swing. */
  function getDamageBonus(minDmg, maxDmg) {
    if (minDmg > maxDmg) return minDmg;
    var di1k = Math.floor((maxDmg - minDmg) * 1000 / 19);
    di1k = Math.floor((di1k + 50) / 100) * 100;
    return Math.floor((maxDmg * 1000 - di1k * 20) / 1000);
  }

  /**
   * Mob::GetOffense. Levels 46-50 are flattened to 45 for non-pets — a real
   * plateau in the server's offense curve.
   */
  function getOffense(level, isPoP, atk, isPet) {
    var L = level != null ? level : 60;
    if (!isPet && L > 45 && L < 51) L = 45;

    var baseOffense = Math.min(Math.floor(L * 55 / 10) - 4, 320);
    var strOffense;
    if (L < 6) {
      baseOffense = L * 4;
      strOffense = L;
    } else if (L < 30) {
      strOffense = Math.floor(L / 2) + 1;
    } else {
      strOffense = L * 2 - 40;
      if (isPoP) strOffense += 20;
    }

    return Math.max(1, baseOffense + strOffense + (atk || 0));
  }

  /** Mob::GetToHit = 7 + offense skill + weapon skill + accuracy rating. */
  function getToHit(level, isPoP, accuracyRating) {
    var ws = getNpcWeaponSkill(level, isPoP);
    var acc = accuracyRating || 0;
    if (level < 3) acc += 2;
    return 7 + ws + ws + acc;
  }

  /**
   * Effective swing delay after haste/slow.
   *   NPC::SetAttackTimer — delay < 401 is deciseconds, so scale by 100.
   *   Mob::GetHaste — a slowed mob returns 100 + spellbonuses.haste directly;
   *   NPCs never receive worn-item haste.
   * hastePct is the net spell haste/slow: -60 means a 60% slow.
   * slow_mitigation reduces how much of a slow actually lands (bonuses.cpp:1144).
   */
  function getAttackDelayMs(attackDelay, hastePct, slowMitigationPct) {
    var delay = attackDelay != null ? attackDelay : 30;
    if (delay < 401) delay *= 100;

    var hasteMod = getEffectiveHaste(hastePct, slowMitigationPct) / 100;
    if (hasteMod <= 0) hasteMod = 0.01;

    return Math.max(MIN_HASTED_DELAY_MS, Math.floor(delay / hasteMod));
  }

  /**
   * Mob::GetHaste as a percentage (100 = unhasted). A slow is negative spell
   * haste; slow_mitigation gives some of it back.
   */
  function getEffectiveHaste(hastePct, slowMitigationPct) {
    var pct = hastePct || 0;
    if (pct < 0 && slowMitigationPct > 0) {
      pct = pct - Math.floor(pct * slowMitigationPct / 100);
    }
    return Math.max(1, 100 + pct);
  }

  // ---- Mob profile -----------------------------------------------------------

  /**
   * Derive everything the simulation needs about the mob, once, up front.
   *
   * @param {Object} o
   *   level, classId, minDamage, maxDamage, attackDelay, attackCount, ac, atk,
   *   accuracy, hp, specialAbilities (raw string or parsed object),
   *   hastePct, slowMitigation, era, npcAvoidance, forceDualWield (used by
   *   the pet DPS sim's "Always Dual Wield" toggle — see petCombat.js),
   *   disableDualWield (tanking sim override that forces off-hand rounds off
   *   even when the NPC's own DualWield ability would grant them),
   *   isPet (skips the level 46-50 offense plateau real NPCs get; pets are
   *   exempt from it server-side, same as the existing getOffense param)
   */
  function buildMobProfile(o) {
    var level = o.level != null ? o.level : 60;
    var isPoP = o.era === 'pop';
    var parsed = typeof o.specialAbilities === 'string'
      ? parseSpecialAbilities(o.specialAbilities)
      : (o.specialAbilities || {});

    var minDmg = Math.max(1, o.minDamage != null ? o.minDamage : 10);
    var maxDmg = Math.max(minDmg, o.maxDamage != null ? o.maxDamage : 50);

    // attack_count of -1 or 0 is the DB's "just one swing" sentinel.
    var attackCount = o.attackCount != null && o.attackCount > 1 ? o.attackCount : 1;

    // Every NPC above level 7 gets double attack, at the flat NPC skill value —
    // it is not gated by class the way client double attack is.
    var daSkill = level > 7 ? getNpcSkillLevel(level) : 0;
    var daChance = daSkill > 0
      ? Math.min(1, (daSkill + (level > 35 ? level : 0)) / 500)
      : 0;

    var classId = o.classId != null ? o.classId : CLASS.Warrior;

    // Off-hand rounds need the DualWield ability (or an equipped secondary,
    // which the DB does not expose to us).
    var dualWield = !o.disableDualWield && (hasAbility(parsed, SA.DualWield) || !!o.forceDualWield);

    // Having the DualWield ability doesn't mean every off-hand tick actually
    // swings — Mob::CheckDualWield rolls dualWieldEffective > random(0,374)
    // each time, same shape as the double attack roll but against skill+level
    // over 375 instead of 500 (NPCs share the same skill value for both).
    var dualWieldChance = dualWield
      ? Math.min(1, (daSkill + (level > 35 ? level : 0)) / 375)
      : 0;

    var classAttack = getNpcClassAttack(classId, level);

    return {
      name: o.name || ('Level ' + level + ' NPC'),
      level: level,
      classId: classId,
      isPoP: isPoP,

      minDamage: minDmg,
      maxDamage: maxDmg,
      baseDamage: getBaseDamage(minDmg, maxDmg),
      damageBonus: getDamageBonus(minDmg, maxDmg),

      offense: getOffense(level, isPoP, o.atk || 0, !!o.isPet),
      toHit: getToHit(level, isPoP, o.accuracy),
      ac: o.ac || 0,
      hp: o.hp || 0,
      avoidance: o.npcAvoidance || 0,

      attackDelayMs: getAttackDelayMs(o.attackDelay, o.hastePct, o.slowMitigation),
      // GetHaste() as a percentage — also scales class-attack reuse.
      hastePctTotal: getEffectiveHaste(o.hastePct, o.slowMitigation),
      attackCount: attackCount,

      doubleAttackSkill: daSkill,
      doubleAttackChance: daChance,
      // Warriors and Monks at 60+ only, and only after a double connects.
      hasTripleAttack: (classId === CLASS.Warrior || classId === CLASS.Monk) && level >= 60,

      dualWield: dualWield,
      dualWieldChance: dualWieldChance,
      // The off-hand's own double attack needs 150+ double attack skill.
      offhandDoubleAttack: daSkill >= 150,

      flurryChance: hasAbility(parsed, SA.Flurry)
        ? abilityParam(parsed, SA.Flurry, 0, DEFAULT_FLURRY_CHANCE) / 100 : 0,
      rampageChance: hasAbility(parsed, SA.Rampage)
        ? abilityParam(parsed, SA.Rampage, 0, DEFAULT_RAMPAGE_CHANCE) / 100 : 0,
      rampageDamagePct: abilityParam(parsed, SA.Rampage, 2, 100),
      areaRampageChance: hasAbility(parsed, SA.AreaRampage)
        ? abilityParam(parsed, SA.AreaRampage, 0, DEFAULT_RAMPAGE_CHANCE) / 100 : 0,
      areaRampageDamagePct: abilityParam(parsed, SA.AreaRampage, 2, 100),

      canEnrage: hasAbility(parsed, SA.Enrage),
      riposteImmune: hasAbility(parsed, SA.RiposteImmunity),
      meleeDisabled: hasAbility(parsed, SA.DisableMelee),
      stunImmune: hasAbility(parsed, SA.StunImmunity),
      slowImmune: hasAbility(parsed, SA.SlowImmunity),

      classAttack: classAttack,
      specialAbilities: parsed,
      specialAbilityNames: describeSpecialAbilities(parsed)
    };
  }

  // ---- Swing resolution -----------------------------------------------------

  /**
   * Resolve one incoming swing against the player.
   *
   * Order is the server's (NPC::Attack): AvoidDamage first — block, parry,
   * riposte, dodge, first success wins — then AvoidanceCheck for the hit roll,
   * then the damage roll. This is deliberately *not* hit-check-first.
   *
   * @param {Object} mob      profile from buildMobProfile
   * @param {Object} defense  from PlayerDefense.build
   * @param {Object} ctx      mutable fight state: { stunned, mobEnraged, runeRemaining }
   * @param {Function} rng
   * @param {Object} [opts]   { baseDamage, damagePct, source, skill }
   * @returns {{outcome:string, damage:number, source:string, stun:boolean}}
   */
  function resolveSwing(mob, defense, ctx, rng, opts) {
    opts = opts || {};
    var source = opts.source || 'mainhand';
    var result = { outcome: 'miss', damage: 0, source: source, stun: false };

    var rates = defense.rates;

    // A stunned or sitting defender avoids nothing; sitting also forces max damage,
    // which we do not model (a tank is never sitting).
    var canAvoid = !ctx.stunned;

    if (canAvoid) {
      if (rates.block > 0 && rng() < rates.block) { result.outcome = 'block'; return result; }
      if (rates.parry > 0 && rng() < rates.parry) { result.outcome = 'parry'; return result; }

      // An enraged mob cannot be riposted, nor can one flagged riposte-immune.
      var riposteAllowed = !ctx.mobEnraged && !mob.riposteImmune;
      if (riposteAllowed && rates.riposte > 0 && rng() < rates.riposte) {
        result.outcome = 'riposte';
        return result;
      }
      if (rates.dodge > 0 && rng() < rates.dodge) { result.outcome = 'dodge'; return result; }
    }

    // AvoidanceCheck — the pure hit roll.
    if (rng() >= defense.hitChance) { result.outcome = 'miss'; return result; }

    result.outcome = 'hit';
    result.damage = rollDamage(mob, defense, rng, opts);

    // Bash, kick and dragon punch roll a stun before damage is applied.
    if (opts.skill === 'bash' || opts.skill === 'kick' || opts.skill === 'dragonpunch') {
      result.stun = rollStun(mob, defense, rng);
    }

    return result;
  }

  /**
   * Mob::CalcMeleeDamage.
   *   damage = damageBonus + floor((RollD20(offense, mitigation) * base + 5) / 10)
   *
   * SE_MeleeMitigation (Defensive Discipline and friends) scales `base` *before*
   * the roll, so it never touches the flat damage bonus — which is why Defensive
   * is worth appreciably less than its nominal 50% against high-DB mobs.
   */
  function rollDamage(mob, defense, rng, opts) {
    opts = opts || {};
    var eq = getEQCombat();
    var base = opts.baseDamage != null ? opts.baseDamage : mob.baseDamage;

    var mitPct = defense.meleeMitigationPct || 0;
    if (mitPct !== 0) base = base + Math.floor(base * mitPct / 100);
    if (base < 1) base = 1;

    var damage;
    if (eq && eq.rollD20) {
      var roll = eq.rollD20(mob.offense, defense.mitigation, rng);
      damage = Math.floor((roll * base + 5) / 10);
    } else {
      damage = Math.floor(base * (1 + rng() * 19) / 10);
    }
    if (damage < 1) damage = 1;

    damage += mob.damageBonus;

    var pct = opts.damagePct != null ? opts.damagePct : 100;
    if (pct !== 100) damage = Math.floor(damage * pct / 100);

    return Math.max(1, damage);
  }

  /**
   * TryBashKickStun (special_attacks.cpp:100).
   *   chance = (level > 60 ? 40 : 45), then +/- levelDiff^2 / 2, floor of 2.
   */
  function rollStun(mob, defense, rng) {
    if (mob.stunImmune) return false;
    if (defense.stunImmune) return false;

    var chance = mob.level > 60 ? 40 : 45;
    var levelDiff = mob.level - defense.level;
    chance += levelDiff < 0
      ? -Math.floor(levelDiff * levelDiff / 2)
      : Math.floor(levelDiff * levelDiff / 2);
    if (chance < 2) chance = 2;

    if (rng() * 100 >= chance) return false;
    // Ogres cannot be stunned from the front.
    if (defense.frontalStunImmune) return false;
    if (defense.stunResistPct > 0 && rng() * 100 < defense.stunResistPct) return false;
    return true;
  }

  // ---- Rounds ---------------------------------------------------------------

  /**
   * Mob::DoMainHandRound — attack_count swings, then procs, then one double
   * attack check, and only on a successful double a 13.5% triple for
   * warriors/monks at 60+.
   *
   * `emit(swingOpts)` resolves and records a single swing; it is supplied by the
   * engine so every damage source flows through the same accounting.
   */
  function doMainHandRound(mob, rng, emit, damagePct) {
    var i;
    for (i = 0; i < mob.attackCount; i++) {
      emit({ source: 'mainhand', damagePct: damagePct });
    }

    emit({ source: 'proc', proc: true });

    if (mob.doubleAttackChance > 0 && rng() < mob.doubleAttackChance) {
      emit({ source: 'double', damagePct: damagePct });
      if (mob.hasTripleAttack && rng() * 1000 < 135) {
        emit({ source: 'triple', damagePct: damagePct });
      }
    }
  }

  /** Mob::DoOffHandRound — proc, one swing, plus a double at 150+ skill. */
  function doOffHandRound(mob, rng, emit, damagePct) {
    emit({ source: 'proc', proc: true, hand: 'offhand' });
    emit({ source: 'offhand', damagePct: damagePct });
    if (mob.offhandDoubleAttack && mob.doubleAttackChance > 0 && rng() < mob.doubleAttackChance) {
      emit({ source: 'offhandDouble', damagePct: damagePct });
    }
  }

  /**
   * Mob::Flurry — a full extra main-hand round plus an off-hand round, and it
   * fires the class attack twice on top.
   */
  function doFlurry(mob, rng, emit, emitClassAttack) {
    if (emitClassAttack) { emitClassAttack('flurry'); emitClassAttack('flurry'); }
    doMainHandRound(mob, rng, emit, 100);
    if (mob.dualWield) doOffHandRound(mob, rng, emit, 100);
  }

  /**
   * Rampage / AreaRampage — a full round against everyone on the hate list in
   * range. With the tank as the only target it simply lands on the tank.
   */
  function doRampage(mob, rng, emit, damagePct) {
    doMainHandRound(mob, rng, emit, damagePct);
    if (mob.dualWield) doOffHandRound(mob, rng, emit, damagePct);
  }

  /**
   * NPC::DoClassAttacks — picks the attack and returns its reuse in ms so the
   * engine can reschedule. Returns null when the mob has no class attack.
   */
  function pickClassAttack(mob, rng) {
    var ca = mob.classAttack;
    if (!ca) return null;

    var skill = ca.skill;
    var reuseSec = ca.reuseSec;
    if (ca.altSkill && rng() * 100 < ca.altChance) {
      skill = ca.altSkill;
      reuseSec = ca.altReuseSec;
    }

    return {
      skill: skill,
      baseDamage: getSkillBaseDamage(skill, ca.skillLevel),
      // Reuse is haste-scaled: reuse * 1000 / GetHaste() * 100.
      reuseMs: Math.max(1000, Math.floor(reuseSec * 1000 * 100 / mob.hastePctTotal))
    };
  }

  global.NpcCombat = {
    SpecialAbility: SA,
    CLASS: CLASS,
    STUN_DURATION_MS: STUN_DURATION_MS,
    ENRAGE_HP_PCT: ENRAGE_HP_PCT,
    ENRAGE_DURATION_MS: ENRAGE_DURATION_MS,
    ENRAGE_COOLDOWN_MS: ENRAGE_COOLDOWN_MS,

    parseSpecialAbilities: parseSpecialAbilities,
    hasAbility: hasAbility,
    abilityParam: abilityParam,
    describeSpecialAbilities: describeSpecialAbilities,

    getNpcSkillLevel: getNpcSkillLevel,
    getNpcWeaponSkill: getNpcWeaponSkill,
    getNpcClassAttack: getNpcClassAttack,
    getNpcDefenseSkills: getNpcDefenseSkills,
    getSkillBaseDamage: getSkillBaseDamage,

    getBaseDamage: getBaseDamage,
    getDamageBonus: getDamageBonus,
    getOffense: getOffense,
    getToHit: getToHit,
    getAttackDelayMs: getAttackDelayMs,
    getEffectiveHaste: getEffectiveHaste,

    buildMobProfile: buildMobProfile,
    resolveSwing: resolveSwing,
    rollDamage: rollDamage,
    rollStun: rollStun,

    doMainHandRound: doMainHandRound,
    doOffHandRound: doOffHandRound,
    doFlurry: doFlurry,
    doRampage: doRampage,
    pickClassAttack: pickClassAttack
  };

})(typeof window !== 'undefined' ? window : globalThis);
