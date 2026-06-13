/**
 * EverQuest combat simulator – formulas from EQMacEmu attack.cpp
 * https://github.com/SecretsOTheP/EQMacEmu/blob/main/zone/attack.cpp
 *
 * Important: Hit chance uses AVOIDANCE (GetAvoidance: level*9+5, cap 400/460), not AC.
 * Damage roll uses MITIGATION (GetMitigation: level-based, cap 200, or DB AC when AC>200).
 * Do not use the same value for both; the sim uses getAvoidanceNPC(mobLevel) for hit chance.
 */

(function (global) {
  'use strict';

  /** When true and duelist is active, add +1 to backstab final damage (hidden debug, no UI). */
  var FENCEPOSTBACKSTABDEBUG = true;

  /** When true, rollDamageMultiplier uses Math.ceil instead of Math.floor for the multiplier step. */
  var _roundMultUp = false;

  // ============================================================
  // Named constants — replaces magic numbers throughout the file.
  // Source: EQMacEmu attack.cpp, special_attacks.cpp, spells.cpp
  // ============================================================

  /** EQMacEmu AvoidanceCheck: toHit multiplier (Mob::GetHitChance) */
  var HIT_CHANCE_MULTIPLIER = 1.21;

  /** Base proc rate constant (EQMacEmu: Mob::GetProcChance base) */
  var PROC_BASE_RATE = 0.0004166667;

  /** DEX scalar for proc rate (EQMacEmu: Mob::GetProcChance dex factor) */
  var PROC_DEX_SCALAR = 1.1437908496732e-5;

  /** Dual wield skill divisor (EQMacEmu: CheckDualWield random(0,374)) */
  var DUAL_WIELD_DIVISOR = 375;

  /** Double attack skill divisor (EQMacEmu: CheckDoubleAttack random(0,499)) */
  var DOUBLE_ATTACK_DIVISOR = 500;

  /** Triple attack chance on a successful double attack round */
  var TRIPLE_ATTACK_CHANCE_ON_DOUBLE = 0.135;

  // NPC defense skill caps by class (EQMacEmu skills.cpp class cap tables).
  // [block, parry, riposte, dodge]. 0 = class cannot use that skill.
  // Class IDs: 1=Warrior, 2=Cleric, 3=Paladin, 4=Ranger, 5=Shadow Knight,
  //            6=Druid, 7=Monk, 8=Bard, 9=Rogue, 10=Shaman,
  //            11=Necromancer, 12=Wizard, 13=Magician, 14=Enchanter, 15=Beastlord
  var NPC_DEFENSE_CAPS = {
    1:  [200, 230, 200, 260],  // Warrior
    2:  [0,    85,   0, 200],  // Cleric
    3:  [200, 220, 175, 250],  // Paladin
    4:  [0,   220, 175, 250],  // Ranger
    5:  [200, 205, 160, 250],  // Shadow Knight
    6:  [0,    85,   0, 200],  // Druid
    7:  [0,   175, 175, 260],  // Monk
    8:  [0,   175, 175, 260],  // Bard
    9:  [0,   185, 270, 260],  // Rogue
    10: [0,    85,   0, 200],  // Shaman
    11: [0,    50,   0, 175],  // Necromancer
    12: [0,    50,   0, 175],  // Wizard
    13: [0,    50,   0, 175],  // Magician
    14: [0,    50,   0, 175],  // Enchanter
    15: [0,   145, 100, 220],  // Beastlord
  };
  // Default caps for unknown/unspecified NPC class (generic melee mob)
  var NPC_DEFENSE_CAPS_DEFAULT = [75, 150, 100, 230];

  /** Minimum effective weapon delay after haste, in deciseconds */
  var MIN_DELAY_DECISEC = 4;

  /** Deciseconds to milliseconds conversion */
  var DECISEC_TO_MS = 100;

  /** Default haste cap bonus at level 60 (RuleI Character,HasteCap) */
  var DEFAULT_CHARACTER_HASTE_CAP_60_BONUS = 100;

  /** Proc DoT tick interval in milliseconds (6 seconds) */
  var PROC_TICK_INTERVAL_MS = 6000;

  // ----- Hit chance (AvoidanceCheck) -----
  // Server: toHit = GetToHit(skill) = 7 + Offense SKILL + Weapon skill + accuracy (typically 400–550). Offense skill is the 0–255 value; offense RATING is what affects damage (skill + STR + worn/spell).
  // toHit += 10, avoidance += 10
  // if (toHit * 1.21 > avoidance) hitChance = 1.0 - avoidance / (toHit * 1.21 * 2.0)
  // else hitChance = toHit * 1.21 / (avoidance * 2.0)
  // No cap on toHit (matches server AvoidanceCheck; Eagle Eye / high skill can exceed 550).
  function getHitChance(toHit, avoidance) {
    const effectiveToHit = toHit != null ? toHit : 400;
    const a = effectiveToHit + 10;
    const b = (avoidance != null ? avoidance : 460) + 10;
    if (a * HIT_CHANCE_MULTIPLIER > b) {
      return 1.0 - b / (a * HIT_CHANCE_MULTIPLIER * 2.0);
    }
    return (a * HIT_CHANCE_MULTIPLIER) / (b * 2.0);
  }

  // frontAvoidChance: 0 = attacking from behind (no block/parry/riposte/dodge); hit roll still applies.
  // Non-zero = combined avoidance probability from NPC skill checks (block→parry→riposte→dodge).
  function rollHit(toHit, avoidance, rng, frontAvoidChance) {
    const chance = getHitChance(toHit, avoidance);
    if (rng() >= chance) return false;
    if (!frontAvoidChance) return true;
    return rng() >= frontAvoidChance;
  }

  // ----- Defender GetAvoidance() – used for HIT CHANCE only (AvoidanceCheck), NOT for damage -----
  // attack.cpp: avoidance = level*9+5; if (level<=50 && avoidance>400) avoidance=400; else if (avoidance>460) avoidance=460;
  // + AGI/item bonuses. We use base formula; pass options.avoidance to override (e.g. client defender).
  function getAvoidanceNPC(level) {
    const L = level != null ? level : 60;
    let avoidance = L * 9 + 5;
    if (L <= 50 && avoidance > 400) avoidance = 400;
    else if (avoidance > 460) avoidance = 460;
    if (avoidance < 1) avoidance = 1;
    return avoidance;
  }

  // ----- NPC defense skills (block/parry/riposte/dodge) for front-attack avoidance -----
  // NPC skill at level L = min(L * 5, class_cap), matching EQMacEmu GetSkill() NPC scaling.
  function getNpcDefenseSkills(level, npcClass) {
    const L = level != null ? level : 60;
    const caps = (npcClass != null && NPC_DEFENSE_CAPS[npcClass]) ? NPC_DEFENSE_CAPS[npcClass] : NPC_DEFENSE_CAPS_DEFAULT;
    return caps.map(function(cap) { return cap > 0 ? Math.min(L * 5, cap) : 0; });
  }

  // Combined front avoidance probability from sequential block→parry→riposte→dodge checks.
  // Divisors from EQMacEmu attack.cpp Mob::AvoidDamage: block/25, parry/50, riposte/55, dodge/45.
  function computeFrontAvoidChance(level, npcClass) {
    var skills = getNpcDefenseSkills(level, npcClass);
    function rate(skill, div) { return skill > 0 ? Math.min(1, Math.floor((skill + 100) / div) / 100) : 0; }
    var block   = rate(skills[0], 25);
    var parry   = rate(skills[1], 50);
    var riposte = rate(skills[2], 55);
    var dodge   = rate(skills[3], 45);
    return 1 - (1 - block) * (1 - parry) * (1 - riposte) * (1 - dodge);
  }

  // ----- Defender GetMitigation() – mob's mitigation for DAMAGE ROLL only (RollD20), NOT hit chance -----
  // Level-based formula, cap 200; if mit==200 && mobAC>200 use mobAC; then + item/spell AC.
  function getMitigation(mobLevel, mobAC, itemAcBonus, spellAcBonus) {
    const level = mobLevel != null ? mobLevel : 60;
    let mit;
    if (level < 15) {
      mit = level * 3;
      if (level < 3) mit += 2;
    } else {
      mit = Math.floor(level * 41 / 10) - 15;
    }
    if (mit > 200) mit = 200;
    if (mit === 200 && mobAC != null && mobAC > 200) mit = mobAC;
    const itemBonus = (itemAcBonus != null ? itemAcBonus : 0);
    const spellBonus = (spellAcBonus != null ? spellAcBonus : 0);
    mit += Math.floor(4 * itemBonus / 3) + Math.floor(spellBonus / 4);
    if (mit < 1) mit = 1;
    return mit;
  }

  // ----- Damage roll (RollD20 + CalcMeleeDamage) – matches server CalcMeleeDamage -----
  // roll = RollD20(offenseRating, defender->GetMitigation()); damage = (roll * baseDamage + 5) / 10, min 1
  // RollD20: atkRoll = Roll0(offenseRating+5), defRoll = Roll0(mitigation+5)
  // Here "offense" is offense RATING (skill + STR + worn/spell), not the offense skill value alone.
  function rollD20(offenseRating, mitigation, rng) {
    const atkRoll = Math.floor(rng() * (offenseRating + 5));
    const defRoll = Math.floor(rng() * (mitigation + 5));
    const avg = Math.floor((offenseRating + mitigation + 10) / 2);
    if (avg <= 0) return 1;
    let index = Math.max(0, (atkRoll - defRoll) + Math.floor(avg / 2));
    index = Math.floor((index * 20) / avg);
    index = Math.max(0, Math.min(19, index));
    return index + 1;
  }

  function calcMeleeDamage(baseDamage, offenseRating, mitigation, rng, damageBonus) {
    const roll = rollD20(offenseRating, mitigation, rng);
    let damage = Math.floor((roll * baseDamage + 5) / 10);
    if (damage < 1) damage = 1;
    if (damageBonus) damage += damageBonus;
    return damage;
  }

  // ----- Anti-twink base damage caps (from decompiles; level < 40 only) -----
  // Priest: Druid, Cleric, Shaman. Caster: Wizard, Magician, Necromancer, Enchanter. Default: all others.
  function getBaseDamageCap(level, classId) {
    if (level == null || level >= 40) return null;
    const c = (classId || '').toLowerCase();
    const isPriest = c === 'druid' || c === 'cleric' || c === 'shaman';
    const isCaster = c === 'wizard' || c === 'magician' || c === 'necromancer' || c === 'enchanter';
    if (level < 10) {
      if (isPriest) return 9;
      if (isCaster) return 6;
      return 10;
    }
    if (level < 20) {
      if (isPriest) return 12;
      if (isCaster) return 10;
      return 14;
    }
    if (level < 30) {
      if (isPriest) return 20;
      if (isCaster) return 12;
      return 30;
    }
    if (level < 40) {
      if (isPriest) return 26;
      if (isCaster) return 18;
      return 60;
    }
    return null;
  }

  // Elemental damage vs target resistance: amount added depends on mob's resist for that element.
  // If resist > 200: full resist, 0 damage. Else roll = random(1,201) - resist; if roll < 1 then 0; if roll <= 99 then weaponDamage * roll/100; else full weaponDamage.
  function applyElementalResist(weaponDamage, resistValue, rng) {
    if (resistValue > 200) return 0;
    const roll = Math.floor(rng() * 201) + 1 - resistValue;
    if (roll < 1) return 0;
    if (roll <= 99) return Math.floor(weaponDamage * roll / 100);
    return weaponDamage;
  }

  // Target mob's resistance for the given element (from options.targetFR / targetCR / targetPR / targetDR / targetMR; default 35).
  function getResistForElemType(options, elemType) {
    const key = elemType === 'fire' ? 'targetFR' : elemType === 'cold' ? 'targetCR' : elemType === 'poison' ? 'targetPR' : elemType === 'disease' ? 'targetDR' : elemType === 'magic' ? 'targetMR' : null;
    return key != null && options[key] != null ? options[key] : 35;
  }

  // Elemental damage is added to base damage BEFORE the melee swing. The adder goes through applyElementalResist first.
  function getElementalBaseAdder(weapon, options, rng) {
    if (!weapon || !weapon.elemType || !(weapon.elemDamage > 0)) return 0;
    const resist = getResistForElemType(options, weapon.elemType);
    return applyElementalResist(weapon.elemDamage, resist, rng);
  }

  // ----- Client::RollDamageMultiplier (applied to every client melee swing) -----
  function getRollDamageMultiplierParams(level, classId) {
    const isMonk = classId === 'monk';
    if (isMonk && level >= 65) return { rollChance: 83, maxExtra: 300, minusFactor: 50 };
    if (level >= 65 || (isMonk && level >= 63)) return { rollChance: 81, maxExtra: 295, minusFactor: 55 };
    if (level >= 63 || (isMonk && level >= 60)) return { rollChance: 79, maxExtra: 290, minusFactor: 60 };
    if (level >= 60 || (isMonk && level >= 56)) return { rollChance: 77, maxExtra: 285, minusFactor: 65 };
    if (level >= 56) return { rollChance: 72, maxExtra: 265, minusFactor: 70 };
    if (level >= 51 || isMonk) return { rollChance: 65, maxExtra: 245, minusFactor: 80 };
    return { rollChance: 51, maxExtra: 210, minusFactor: 105 };
  }

  function rollDamageMultiplier(offenseRating, damage, level, classId, isArchery, rng) {
    const params = getRollDamageMultiplierParams(level || 60, classId || '');
    let baseBonus = Math.floor((offenseRating - params.minusFactor) / 2);
    if (baseBonus < 10) baseBonus = 10;

    if (rng() * 100 < params.rollChance) {
      let roll = Math.floor(rng() * (baseBonus + 1)) + 100;
      if (roll > params.maxExtra) roll = params.maxExtra;
      damage = _roundMultUp ? Math.ceil(damage * roll / 100) : Math.floor(damage * roll / 100);
      if (level >= 55 && damage > 1 && !isArchery && isWarriorClass(classId)) damage++;
      return { damage: damage < 1 ? 1 : damage, isCrit: roll > 100 };
    }
    return { damage: damage < 1 ? 1 : damage, isCrit: false };
  }

  // ----- Melee critical hit chance (client: DEX, class, AA, discipline) -----
  // critChance is in percent (0–100). Warrior has innate base; Combat Fury 1/2/3 add flat +2%/+4%/+6% (critChanceMult) on top.
  function getCritChance(level, classId, dex, clientBaseCritChance, critChanceMult, isArchery) {
    let critChance = (clientBaseCritChance != null ? clientBaseCritChance : 0);
    const dexCap = Math.min(dex != null ? dex : 255, 255);
    const overCap = (dex != null && dex > 255) ? (dex - 255) / 400 : 0;

    if (classId === 'warrior' && level >= 12) {
      critChance += 0.5 + dexCap / 90 + overCap;
    } else if (isArchery && classId === 'ranger' && level > 16) {
      critChance += 1.35 + dexCap / 34 + overCap * 2;
    } else if (classId !== 'warrior' && (critChanceMult || 0) > 0) {
      critChance += 0.275 + dexCap / 150 + overCap;
    }
    critChance += (critChanceMult || 0);
    return Math.max(0, Math.min(100, critChance));
  }

  // ----- Melee critical hit damage: ((damage - damageBonus) * critMod + 5) / 10 + 8 + damageBonus -----
  // critMod 17 = normal crit, 29 = crippling blow / berserk. cripSuccess adds +2 damage.
  // furyDmgBonusPct: Fury of the Ages (warrior PoP AA), rank 1–5: +5/10/15/20/25% bonus after crit calc.
  function applyCritDamage(damage, damageBonus, critMod, cripSuccess, furyDmgBonusPct) {
    let dmg = Math.floor(((damage - (damageBonus || 0)) * critMod + 5) / 10) + 8 + (damageBonus || 0);
    if (cripSuccess) dmg += 2;
    if (furyDmgBonusPct > 0) dmg = Math.floor(dmg * (100 + furyDmgBonusPct) / 100);
    return dmg < 1 ? 1 : dmg;
  }

  // Roll for crit, then apply crit damage if it lands. Returns { damage, isCrit }.
  // damageBonus = main-hand damage bonus (0 for offhand). isArchery, isBerserk, cripplingBlowChance optional.
  // furyDmgBonusPct: Fury of the Ages warrior AA bonus % applied after crit formula.
  function rollMeleeCrit(damage, damageBonus, level, classId, dex, critChanceMult, isArchery, isBerserk, cripplingBlowChance, critDmgDebugDmgBonus, rng, furyDmgBonusPct) {
    const clientBaseCritChance = 0;
    const critChancePct = getCritChance(level, classId, dex, clientBaseCritChance, critChanceMult || 0, !!isArchery);
    if (critChancePct <= 0) return { damage, isCrit: false };

    if (rng() >= critChancePct / 100) return { damage, isCrit: false };

    let critMod = 17;
    let cripSuccess = false;
    if (isBerserk || (cripplingBlowChance && rng() * 100 < cripplingBlowChance)) {
      critMod = 29;
      cripSuccess = true;
    }
    let newDamage = applyCritDamage(damage, damageBonus, critMod, cripSuccess, furyDmgBonusPct || 0);
    // Debug parity toggle: add +1 to melee crits after all other crit calculations.
    if (critDmgDebugDmgBonus && !isArchery) newDamage += 1;
    return { damage: newDamage, isCrit: true };
  }

  // ----- Double Attack (CheckDoubleAttack) -----
  // effective skill > random(0, 499). effective = skill + level (and AA). 1% per 5 skill.
  function getDoubleAttackEffective(toHitOrLevel, doubleAttackSkill) {
    return doubleAttackSkill + (toHitOrLevel || 0);
  }

  function checkDoubleAttack(doubleAttackEffective, rng, classId) {
    if (classId === 'bard' || classId === 'beastlord') return false;
    return doubleAttackEffective > Math.floor(rng() * DOUBLE_ATTACK_DIVISOR);
  }

  // ----- Triple Attack (main hand only; offhand does not triple) -----
  // Triple happens on 13.5% of rounds that already had a successful double attack.
  // Only warrior and monk at level 60+ can triple attack.
  function canTripleAttack(level, classId) {
    return (classId === 'warrior' || classId === 'monk') && (level != null ? level : 0) >= 60;
  }

  function checkTripleAttack(rng, level, classId) {
    if (!canTripleAttack(level, classId)) return false;
    return rng() < TRIPLE_ATTACK_CHANCE_ON_DOUBLE;
  }

  // ----- Flurry (Luclin AA: warrior/monk, 3 ranks) -----
  // Extra swing after a successful triple attack round. Rank 1/2/3: 10%/20%/30%.
  var FLURRY_CHANCE_BY_RANK = [0, 0.10, 0.20, 0.30];
  function checkFlurry(rank, level, classId, rng) {
    if (!rank || rank < 1) return false;
    if (classId !== 'warrior') return false;
    if ((level || 0) < 60) return false;
    const chance = FLURRY_CHANCE_BY_RANK[Math.min(rank, 3)];
    return rng() < chance;
  }

  // ----- Client::GetDamageBonus – main hand damage bonus (level, 1h/2h, delay) -----
  // Applied after all other damage calculations. All classes, level >= 28.
  function isWarriorClass(classId) {
    return classId === 'warrior' || classId === 'ranger' || classId === 'paladin' ||
      classId === 'shadowknight' || classId === 'bard' ||
      classId === 'monk' || classId === 'rogue' || classId === 'beastlord';
  }

  function getDamageBonusClient(level, classId, delay, is2H) {
    if (level < 28 || !isWarriorClass(classId)) return 0;
    const delayVal = delay != null ? delay : 1;
    let bonus = 1 + Math.floor((level - 28) / 3);

    if (is2H) {
      if (delayVal <= 27) return bonus + 1;
      if (level > 29) {
        let level_bonus = Math.floor((level - 30) / 5) + 1;
        if (level > 50) {
          level_bonus++;
          let level_bonus2 = level - 50;
          if (level > 67) level_bonus2 += 5;
          else if (level > 59) level_bonus2 += 4;
          else if (level > 58) level_bonus2 += 3;
          else if (level > 56) level_bonus2 += 2;
          else if (level > 54) level_bonus2++;
          level_bonus += Math.floor(level_bonus2 * delayVal / 40);
        }
        bonus += level_bonus;
      }
      if (delayVal >= 40) {
        let delay_bonus = Math.floor((delayVal - 40) / 3) + 1;
        if (delayVal >= 45) delay_bonus += 2;
        else if (delayVal >= 43) delay_bonus++;
        bonus += delay_bonus;
      }
      return bonus;
    }
    return bonus;
  }

  // ----- Damage bonus (NPC::GetDamageBonus from attack.cpp – DB from min/max damage) -----
  function getDamageBonusNPC(min_dmg, max_dmg) {
    if (min_dmg == null || max_dmg == null) return 0;
    if (min_dmg > max_dmg) return min_dmg;
    let di1k = ((max_dmg - min_dmg) * 1000) / 19;
    di1k = Math.floor((di1k + 50) / 100) * 100;
    const db = max_dmg * 1000 - di1k * 20;
    return Math.floor(db / 1000);
  }

  // ----- Dual Wield (CheckDualWield) -----
  // effective > random(0, 374). effective = skill + level + ambidexterity. 1% per 3.75 skill.
  function getDualWieldEffective(level, dualWieldSkill, ambidexterity) {
    return (dualWieldSkill || 0) + (level || 0) + (ambidexterity || 0);
  }

  function checkDualWield(dualWieldEffective, rng) {
    return dualWieldEffective > Math.floor(rng() * DUAL_WIELD_DIVISOR);
  }

  // ----- Haste: effective delay (deciseconds, 10 = 1 sec) -----
  // haste_mod = 1 + hastePercent/100. Timer = delay / haste_mod (delay in decisec).
  // All inputs (delay, fightDurationSec, cooldownDecisec) stay in deciseconds; internal timers use milliseconds.
  function getHasteCapTotal(level, hasteCap60Bonus) {
    const lvl = level != null ? level : 60;
    const cap60Bonus = (hasteCap60Bonus != null && !Number.isNaN(Number(hasteCap60Bonus)))
      ? Number(hasteCap60Bonus)
      : DEFAULT_CHARACTER_HASTE_CAP_60_BONUS;
    let cap = 100;
    if (lvl > 59) cap += cap60Bonus;
    else if (lvl > 50) cap += 85;
    else cap += lvl + 25;
    return cap;
  }
  function getEffectiveHastePercent(hastePercent, level, hasteCap60Bonus) {
    const raw = !Number.isNaN(Number(hastePercent)) ? Number(hastePercent) : 0;
    // Mob::GetHaste(): if spellbonuses.haste < 0, return 100 + spellbonuses.haste (slow path).
    if (raw < 0) return raw;
    // UI provides aggregate haste%. With no v1/v2/item/v3 split, cap to maximum final total:
    // GetHasteCap() pre-v3 cap + v3 cap (10 at <=50, 25 at >=51).
    const lvl = level != null ? level : 60;
    const capTotal = getHasteCapTotal(lvl, hasteCap60Bonus);
    const v3Cap = lvl > 50 ? 25 : 10;
    const maxBonus = (capTotal - 100) + v3Cap;
    return Math.min(raw, maxBonus);
  }
  function effectiveDelayDecisec(delay, hastePercent, minDelay) {
    const hasteMod = 1 + (hastePercent || 0) / 100;
    const floor = (minDelay != null) ? minDelay : MIN_DELAY_DECISEC;
    return Math.max(floor, delay / hasteMod);
  }
  // Effective delay in ms for timer math (inputs still decisec).
  function effectiveDelayMs(delayDecisec, hastePercent) {
    return effectiveDelayDecisec(delayDecisec, hastePercent) * DECISEC_TO_MS;
  }

  // ----- Proc chance (server formula) -----
  // chance = (0.0004166667 + 1.1437908496732e-5 * dex) * weapon_speed; offhand: chance *= 50 / GetDualWieldChance().
  // weapon_speed = effective delay (deciseconds). dualWieldChance = 0..100 (same scale as GetDualWieldChance).
  function getProcChancePerSwing(effectiveDelayDecisec, isOffhand, dualWieldChance, dex) {
    if (effectiveDelayDecisec <= 0) return 0;
    const d = dex != null ? dex : 150;
    let chance = (PROC_BASE_RATE + PROC_DEX_SCALAR * d) * effectiveDelayDecisec;
    if (isOffhand) {
      const dw = Math.max(1, dualWieldChance != null ? dualWieldChance : 100);
      chance *= 50 / dw;
    }
    return Math.min(1, Math.max(0, chance));
  }

  function checkProc(procChance, rng) {
    return procChance > 0 && rng() < procChance;
  }

  // Item proc level gate: if character level is below proclevel, proc cannot fire.
  function canTriggerProcAtLevel(weapon, level) {
    if (!weapon) return false;
    const req = weapon.procLevel != null ? parseInt(weapon.procLevel, 10) : NaN;
    if (Number.isNaN(req) || req <= 0) return true;
    return (level != null ? level : 60) >= req;
  }
  function getProcLevelRequirement(weapon) {
    if (!weapon) return null;
    const req = weapon.procLevel != null ? parseInt(weapon.procLevel, 10) : NaN;
    return (!Number.isNaN(req) && req > 0) ? req : null;
  }

  // ----- Spell proc resist (EQMacEmu spells.cpp CheckResistSpell / ResistSpell) -----
  // Resist types: 0 = none (unresistable), 1 = magic (MR), 2 = fire (FR), 3 = cold (CR), 4 = disease (DR), 5 = poison (PR).
  // Resist modifier (ResistDiff) is spell-based; negative values make the spell land more easily.
  // DoT procs are resisted only when applied, not on each tick.
  var RESIST_TYPE_NONE = 0;
  function getTargetResistBySpellType(options, resistType) {
    if (resistType == null || resistType === RESIST_TYPE_NONE) return 0;
    const key = resistType === 1 ? 'targetMR' : resistType === 2 ? 'targetFR' : resistType === 3 ? 'targetCR' : resistType === 4 ? 'targetDR' : resistType === 5 ? 'targetPR' : null;
    return key != null && options[key] != null ? options[key] : 35;
  }

  /**
   * Check if target is immune to this proc (e.g. movement immune vs root/snare).
   * @param {Object} weapon - weapon with optional procSpellMovementEffect
   * @param {Object} options - options.targetMovementImmune
   * @returns {boolean} true if proc should do no damage
   */
  function checkProcSpellImmunity(weapon, options) {
    if (!weapon || !options) return false;
    if (weapon.procSpellMovementEffect && options.targetMovementImmune) return true;
    return false;
  }

  /**
   * EQEmu spell target types that restrict by body type (see docs target-types and body-types).
   * Maps spell targettype ID -> array of allowed NPC bodytype IDs. If target's bodytype is not in the set, proc cannot land.
   */
  var SPELL_TARGET_TYPE_TO_BODY_TYPES = {
    9: [21],           // Animal -> Animal
    10: [3],           // Undead -> Undead
    11: [27, 28],      // Summoned -> Summoned Creature(s)
    15: [],            // Corpse (no living body type matches)
    16: [25],          // Plant -> Plant
    17: [4, 9],        // Uber Giants -> Giant, Raid Giant
    18: [26, 29, 30, 32], // Uber Dragons -> Dragon variants
    24: [3],           // AOE Undead -> Undead
    25: [27, 28],      // AOE Summoned -> Summoned
    35: [34]           // Muramite -> Muramite
  };

  /**
   * Check whether a proc spell can land on the current target based on spell target type vs target body type.
   * @param {Object} weapon - weapon with optional procSpellTargetType (EQEmu spell targettype)
   * @param {Object} options - options.targetBodyType (NPC bodytype)
   * @returns {boolean} true if proc can land (no restriction, or target body type is allowed)
   */
  function canProcLandOnTarget(weapon, options) {
    if (!weapon || weapon.procSpellTargetType == null) return true;
    const targetBodyType = options && options.targetBodyType != null ? options.targetBodyType : null;
    if (targetBodyType == null) return true;
    const allowed = SPELL_TARGET_TYPE_TO_BODY_TYPES[weapon.procSpellTargetType];
    if (allowed == null) return true;
    return allowed.indexOf(targetBodyType) !== -1;
  }

  /**
   * Spell resist roll for procs. Based on EQMacEmu CheckResistSpell.
   * @param {number} resistType - 0=none, 1=magic, 2=fire, 3=cold, 4=disease, 5=poison
   * @param {number} targetResist - target's resist value for that type
   * @param {number} resistModifier - spell ResistDiff (negative = easier to land)
   * @param {number} casterLevel
   * @param {number} targetLevel
   * @param {boolean} noPartialResist - if true, full resist on failed roll (no partial)
   * @param {number} targetResistChanceBonus - extra % chance to fully resist (e.g. Sanctification)
   * @param {Function} rng
   * @returns {number} effectiveness 0–100 (100 = full damage, 0 = full resist, partial = scaled)
   */
  function calcProcSpellResist(resistType, targetResist, resistModifier, casterLevel, targetLevel, noPartialResist, targetResistChanceBonus, rng) {
    if (resistType == null || resistType === RESIST_TYPE_NONE) return 100;
    if (targetResistChanceBonus > 0 && rng() * 100 < targetResistChanceBonus) return 0;
    const levelDiff = (targetLevel != null ? targetLevel : 60) - (casterLevel != null ? casterLevel : 60);
    let tempLevelDiff = levelDiff;
    if (tempLevelDiff > 15) tempLevelDiff = 15;
    if (tempLevelDiff < -9) tempLevelDiff = -9;
    let levelMod = Math.floor((tempLevelDiff * tempLevelDiff) / 2);
    if (tempLevelDiff < 0) levelMod = -levelMod;
    let resistChance = targetResist + levelMod + (resistModifier != null ? resistModifier : 0);
    resistChance = Math.max(0, Math.min(200, resistChance));
    const roll = Math.floor(rng() * 201);
    if (roll > resistChance) return 100;
    if (noPartialResist) return 0;
    const partialModifier = resistChance > 0 ? Math.floor(150 * (resistChance - roll) / resistChance) : 100;
    const effectiveness = Math.max(0, Math.min(100, 100 - partialModifier));
    return effectiveness;
  }

  /**
   * Resolve proc spell effectiveness (immunity + resist). DoT is resisted only on application.
   * @param {Object} weapon - { procSpellResistType?, procSpellResistModifier?, procSpellNoPartialResist?, procSpellMovementEffect? }
   * @param {Object} options - target resists (targetMR/FR/CR/DR/PR), level, mobLevel, targetResistChanceBonus?, targetMovementImmune?
   * @param {number} casterLevel
   * @param {Function} rng
   * @returns {number} effectiveness 0–100
   */
  function getProcSpellEffectiveness(weapon, options, casterLevel, rng) {
    if (!weapon) return 100;
    if (checkProcSpellImmunity(weapon, options)) return 0;
    // EQEmu resisttype 0 = none (unresistable). Must not treat 0 as falsy — only null/undefined → default magic (1).
    let resistType = RESIST_TYPE_NONE;
    const rawRt = weapon.procSpellResistType;
    if (rawRt != null && rawRt !== '') {
      const n = typeof rawRt === 'number' ? rawRt : parseInt(String(rawRt), 10);
      resistType = !isNaN(n) ? n : 1;
    } else {
      resistType = 1;
    }
    const targetResist = getTargetResistBySpellType(options, resistType);
    const resistModifier = weapon.procSpellResistModifier != null ? weapon.procSpellResistModifier : 0;
    const targetLevel = options.mobLevel != null ? options.mobLevel : 60;
    const noPartial = !!(weapon.procSpellNoPartialResist);
    const resistChanceBonus = options.targetResistChanceBonus != null ? options.targetResistChanceBonus : 0;
    return calcProcSpellResist(resistType, targetResist, resistModifier, casterLevel, targetLevel, noPartial, resistChanceBonus, rng);
  }

  /**
   * Spell Casting Fury (Paladin, Shadowknight, Ranger, Bard, Beastlord): 2/4/7% spell crit, +33/66/100% damage on crit.
   * Applies to proc spell damage. Returns { apply, critChance, multPercent }.
   */
  function getSpellCastingFury(options) {
    const rank = options.spellCastingFury | 0;
    if (rank < 1 || rank > 3) return { apply: false, critChance: 0, multPercent: 0 };
    const classId = (options.classId || '').toLowerCase();
    const scfClasses = ['paladin', 'shadowknight', 'ranger', 'bard', 'beastlord'];
    if (scfClasses.indexOf(classId) < 0) return { apply: false, critChance: 0, multPercent: 0 };
    return { apply: true, critChance: [2, 4, 7][rank - 1], multPercent: [33, 66, 100][rank - 1] };
  }

  function applySpellCastingFuryProc(damage, options, rng) {
    const scf = getSpellCastingFury(options);
    if (!scf.apply || damage <= 0) return { damage: damage, isCrit: false };
    if (rng() * 100 >= scf.critChance) return { damage: damage, isCrit: false };
    return { damage: Math.floor(damage * (100 + scf.multPercent) / 100), isCrit: true };
  }

  // ----- Slay Undead (Paladin AA, 3 ranks) -----
  // Only vs undead targets (body type 3 Undead, 8 Undead Pet, 12 Vampire). Rank 1/2/3: 2.25%/2.35%/2.4% chance, 15x/16x/17x damage multiplier.
  var SLAY_UNDEAD_BODY_TYPES = [3, 8, 12];
  function getSlayUndead(options) {
    const rank = options.slayUndead | 0;
    if (rank < 1 || rank > 3) return { apply: false, slayChance: 0, slayDmgBonusPercent: 0 };
    const classId = (options.classId || '').toLowerCase();
    if (classId !== 'paladin') return { apply: false, slayChance: 0, slayDmgBonusPercent: 0 };
    return {
      apply: true,
      slayChance: [0.0225, 0.0235, 0.024][rank - 1],
      slayDmgBonusPercent: [1500, 1600, 1700][rank - 1]
    };
  }
  function isUndeadTarget(options) {
    const bt = options.targetBodyType;
    if (bt == null) return false;
    return SLAY_UNDEAD_BODY_TYPES.indexOf(Number(bt)) !== -1;
  }
  function trySlayUndead(damage, damageBonus, minBase, options, rng) {
    const slay = getSlayUndead(options);
    if (!slay.apply || damage <= 0) return null;
    if (!isUndeadTarget(options)) return null;
    if (rng() >= slay.slayChance) return null;
    const db = damageBonus || 0;
    let slayDmg = Math.floor(((damage - db + 6) * slay.slayDmgBonusPercent) / 100) + db;
    const minSlay = Math.floor((minBase + 5) * slay.slayDmgBonusPercent / 100) + db;
    if (slayDmg < minSlay) slayDmg = minSlay;
    return { damage: slayDmg, isSlay: true };
  }

  // ----- Special attacks (Flying Kick, Backstab, Kick, Bash, etc.) -----
  // Per EQMacEmu special_attacks.cpp: Bash (Warrior/Paladin/SK/Cleric), Slam (Ogre/Troll/Barbarian = Bash without shield), Kick (Warrior/Ranger/Beastlord), Flying Kick (Monk), Backstab (Rogue).
  // Flying Kick uses skill/level-based base only; Kick/Bash use GetSkillBaseDamage (skill-based base, not weapon).
  // Base reuse times (seconds); player haste reduces effective reuse: effectiveReuseSec = baseReuseSec / (1 + hastePercent/100)
  var SPECIAL_ATTACK_REUSE_TIMES = {
    FeignDeathReuseTime: 9,
    SneakReuseTime: 7,
    HideReuseTime: 8,
    TauntReuseTime: 6,
    InstillDoubtReuseTime: 9,
    FishingReuseTime: 11,
    ForagingReuseTime: 50,
    MendReuseTime: 290,
    BashReuseTime: 8,
    BackstabReuseTime: 10,
    KickReuseTime: 8,
    TailRakeReuseTime: 6,
    EagleStrikeReuseTime: 6,
    RoundKickReuseTime: 8,
    TigerClawReuseTime: 7,
    FlyingKickReuseTime: 8,
    SenseTrapsReuseTime: 9,
    DisarmTrapsReuseTime: 9,
    HarmTouchReuseTime: 4320,
    LayOnHandsReuseTime: 4320,
    HarmTouchReuseTimeNPC: 2400,
    LayOnHandsReuseTimeNPC: 2400,
    FrenzyReuseTime: 10,
  };
  const SPECIAL_ATTACKS_BY_TYPE = {
    flying_kick: { name: 'Flying Kick', reuseSec: SPECIAL_ATTACK_REUSE_TIMES.FlyingKickReuseTime, useWeaponDamage: false, skillBaseDamage: 29, minDamageFormula: 'level*4/5' },
    backstab: { name: 'Backstab', reuseSec: SPECIAL_ATTACK_REUSE_TIMES.BackstabReuseTime, fromBehindOnly: true },
    kick: { name: 'Kick', reuseSec: SPECIAL_ATTACK_REUSE_TIMES.KickReuseTime, useWeaponDamage: false, skillBaseDamage: 20 },
    bash: { name: 'Bash/Slam', reuseSec: SPECIAL_ATTACK_REUSE_TIMES.BashReuseTime, useWeaponDamage: false, skillBaseDamage: 15 },
  };
  function canClassUseSpecialType(classId, type) {
    const c = (classId || '').toLowerCase();
    if (type === 'flying_kick') return c === 'monk';
    if (type === 'backstab') return c === 'rogue';
    if (type === 'kick') return c === 'warrior' || c === 'ranger' || c === 'beastlord';
    if (type === 'bash') return c === 'warrior' || c === 'paladin' || c === 'shadowknight' || c === 'cleric';
    return false;
  }
  function getDefaultSpecialTypeForClass(classId) {
    const c = (classId || '').toLowerCase();
    if (c === 'rogue') return 'backstab';
    if (c === 'monk') return 'flying_kick';
    if (c === 'warrior' || c === 'ranger' || c === 'beastlord') return 'kick';
    if (c === 'paladin' || c === 'shadowknight' || c === 'cleric') return 'bash';
    return null;
  }
  const SPECIAL_ATTACKS = {
    monk: SPECIAL_ATTACKS_BY_TYPE.flying_kick,
    rogue: SPECIAL_ATTACKS_BY_TYPE.backstab,
  };
  // Monk skills randomly selected by Technique of Master Wu (EQMacEmu special_attacks.cpp MonkSPA[4])
  // Assumption: monk is always at max skill (225) for Eagle Strike, Tiger Claw, and Round Kick.
  // Base damage from EQ::skills::GetSkillBaseDamage() at skill 225 (base + 4 threshold bonuses at 25/75/125/175):
  //   FlyingKick: 25+4=29  EagleStrike: 7+4=11  TigerClaw: 4+4=8  RoundKick: 5+4=9
  // Only Flying Kick has the level*4/5 min damage formula; others default to min 1.
  const WU_MONK_SKILLS = [
    { name: 'Flying Kick',  skillBaseDamage: 29, minDamageFormula: 'level*4/5' },
    { name: 'Eagle Strike', skillBaseDamage: 11 },
    { name: 'Tiger Claw',   skillBaseDamage:  8 },
    { name: 'Round Kick',   skillBaseDamage:  9 },
  ];

  // ----- Ranged (archery) combat -----
  // Simulates Client::RangedAttack flow: one shot per ranged_timer (weapon delay + haste).
  // Requires ranged weapon (bow) and ammo (arrow). Damage = RollD20(baseDamage, mitigation) + multiplier + crit; proc on hit.
  /**
   * Run a single ranged (archery) fight simulation.
   * @param {Object} options
   * @param {Object} options.rangedWeapon - { damage, delay, procSpell?, procSpellDamage?, procSpellNonDamagingDetrimental? }
   * @param {Object} options.arrow - { damage }
   * @param {number} options.hastePercent - standard haste % (worn + spell; subject to 125% cap)
   * @param {number} [options.quiverHaste=0] - quiver haste as decimal (e.g. 0.15 = 15%); applied after standard haste, not subject to cap; reduction = quiver_haste*speed+1, only if speed−reduction>1000
   * @param {number} [options.level=60]
   * @param {number} options.targetAC - mob AC for mitigation
   * @param {number} [options.mobLevel=60]
   * @param {number} [options.targetMaxHp] - mob max HP; if omitted, generic HP from mobLevel (22105 at 60)
   * @param {number} options.fightDurationSec
   * @param {number} [options.offenseSkill=252] - archery to-hit
   * @param {number} [options.wornAttack=0]
   * @param {number} [options.spellAttack=0]
   * @param {number} [options.dex=255] - offense rating stat (archery uses DEX), proc rate, crit
   * @param {number} [options.maxDex=255] - cap DEX for offense calc (EQ GetMaxDEX)
   * @param {string} [options.classId] - if 'ranger' and level>54, offense += level*4-216
   * @param {number} [options.critChanceMult=0] - Combat Fury flat crit % (0, 2, 4, 6)
   * @param {number} [options.archeryMastery=2] - 1, 2, or 3 (AA)
   * @param {boolean} [options.mobStationary=false] - target NPC is not moving and not temporarily rooted; enables Ranger 51+ 2× damage bonus (beacon.cpp ArcheryBonusRequiresStationary)
   * @param {boolean} [options.useWalledMobPenalty=false] - if true, apply wall/corner penalty as a damage reduction (not default; Quarm rules default to 1.0)
   * @param {boolean} [options.trueshot=false] - ranger: 2 min random window: +105% archery damage, +12% archery skill (accuracy)
   * @param {number} [options.seed]
   */
  function runRangedFight(options) {
    _roundMultUp = !!options.roundMultUp;
    const rng = createRng(options.seed);
    const procRng = createRng(options.seed != null ? options.seed + 9999 : undefined);
    const elemRng = createRng(options.seed != null ? options.seed + 54321 : undefined);
    const level = options.level != null ? options.level : 60;
    const effectiveHastePercent = getEffectiveHastePercent(options.hastePercent, level, options.hasteCap60Bonus);
    const targetAC = options.targetAC != null ? options.targetAC : 300;
    const mobLevel = options.mobLevel != null ? options.mobLevel : 60;
    const avoidance = options.avoidance != null ? options.avoidance : getAvoidanceNPC(mobLevel);
    const mitigation = getMitigation(mobLevel, targetAC, 0, 0);
    // Archery uses DEX for offense rating (EQ: SkillArchery/SkillThrowing use DEX; others use STR)
    const maxDex = options.maxDex != null ? Math.min(255, Math.max(0, options.maxDex)) : 255;
    const dex = Math.min(options.dex != null ? options.dex : 255, maxDex);
    const dexBonus = dex >= 75 ? Math.floor((2 * dex - 150) / 3) : 0;
    const wornAttack = options.wornAttack != null ? options.wornAttack : 0;
    const spellAttack = options.spellAttack != null ? options.spellAttack : 0;
    const OFFENSE_SKILL = options.offenseSkill != null ? Math.min(255, Math.max(0, options.offenseSkill)) : 252;
    const bow = options.rangedWeapon;
    const arrow = options.arrow;
    if (!bow || bow.damage == null || bow.delay == null || !arrow || arrow.damage == null) {
      return { error: 'Missing rangedWeapon (damage, delay) or arrow (damage)' };
    }
    const rangerArcheryCap = Math.min(240, Math.floor(level * 4));
    const rawArchery = options.archerySkill != null ? Math.max(0, Math.floor(options.archerySkill)) : rangerArcheryCap;
    const ARCHERY_SKILL_BASE = options.archerySkillFixed ? Math.min(252, rawArchery) : Math.min(rangerArcheryCap, Math.min(252, rawArchery));
    const archeryAccuracy = options.archeryAccuracy || 'none';
    // Hawk/Falcon/Eagle Eye: server HitChanceEffect-style toHit percent (+10% / +20% / +40%), single roll (default behavior).
    const ARCHERY_ABSOLUTE_CAP = 252;
    const accuracySkillBonus = 0;
    const archeryBaseWithAccuracy = Math.min(ARCHERY_ABSOLUTE_CAP, ARCHERY_SKILL_BASE + accuracySkillBonus);
    const archeryModPercent = (!options.archerySkillFixed && bow.archeryModPercent != null && !Number.isNaN(Number(bow.archeryModPercent))) ? Number(bow.archeryModPercent) : 0;
    const ARCHERY_SKILL_MODIFIED = Math.floor(archeryBaseWithAccuracy * (100 + archeryModPercent) / 100);
    const ARCHERY_SKILL_EFFECTIVE = Math.min(252, ARCHERY_SKILL_MODIFIED);
    const baseToHit = 7 + OFFENSE_SKILL + ARCHERY_SKILL_EFFECTIVE;
    const accuracyToHitPct = archeryAccuracy === 'hawk' ? 10 : archeryAccuracy === 'falcon' ? 20 : archeryAccuracy === 'eagle' ? 40 : 0;
    const toHit = accuracyToHitPct > 0 ? Math.floor(baseToHit * (100 + accuracyToHitPct) / 100) : baseToHit;
    const trueshot = !!options.trueshot;
    const TRUESHOT_DURATION_MS = 120000;
    const durationMs = Math.floor(options.fightDurationSec * 1000);
    const trueshotStartMs = 0;
    const trueshotEndMs = trueshot ? Math.min(TRUESHOT_DURATION_MS, durationMs) : 0;
    const archerySkillTrueshot = Math.min(252, Math.floor(ARCHERY_SKILL_EFFECTIVE * 1.12));
    const baseToHitTrueshot = 7 + OFFENSE_SKILL + archerySkillTrueshot;
    const toHitTrueshot = accuracyToHitPct > 0 ? Math.floor(baseToHitTrueshot * (100 + accuracyToHitPct) / 100) : baseToHitTrueshot;
    // Offense RATING (for damage): server GetOffense(SkillArchery) uses the archery skill, not the Offense/Attack skill.
    let offenseRating = ARCHERY_SKILL_EFFECTIVE + dexBonus + wornAttack + spellAttack;
    if (offenseRating < 1) offenseRating = 1;
    const rangerOffenseBonus = (options.classId === 'ranger' && level > 54) ? (level * 4 - 216) : 0;
    if (rangerOffenseBonus > 0) offenseRating += rangerOffenseBonus;
    const mastery = options.archeryMastery != null ? Math.max(0, Math.min(3, Math.floor(options.archeryMastery))) : 2;
    // Archery Mastery AA: aabonuses.ArcheryDamageModifier — % bonus to base damage
    // (special_attacks.cpp DoArcheryAttackDmg line 947: applied before CalcMeleeDamage).
    // The server applies mastery to the full (pre-halve) base; here we apply it to the
    // already-halved base — mathematically equivalent since both sides are linear.
    // Rank 0=none, 1=+30%, 2=+60%, 3=+100%.
    const masteryPct = mastery === 1 ? 30 : mastery === 2 ? 60 : mastery === 3 ? 100 : 0;
    if ((bow.damage || 0) + (arrow.damage || 0) < 1) {
      return { error: 'Ranged weapon + arrow damage must be at least 1' };
    }

    let delayDecisec = effectiveDelayDecisec(bow.delay, effectiveHastePercent);
    const quiverHaste = (options.quiverHaste != null && !Number.isNaN(Number(options.quiverHaste)) && Number(options.quiverHaste) > 0) ? Number(options.quiverHaste) : 0;
    if (quiverHaste > 0) {
      const speedMs = delayDecisec * DECISEC_TO_MS;
      const bowDelayReduction = Math.floor(quiverHaste * speedMs) + 1;
      if (speedMs - bowDelayReduction > 1000) {
        delayDecisec = (speedMs - bowDelayReduction) / DECISEC_TO_MS;
      }
    }
    const delayMs = delayDecisec * DECISEC_TO_MS;
    // Ranged procs use same chance as primary (main hand): (base + dex factor) * weapon_speed; no offhand penalty. Apply proc rate modifier.
    const baseRangedProcChance = (bow.procSpell != null && bow.procSpell !== '' && canTriggerProcAtLevel(bow, level))
      ? getProcChancePerSwing(delayDecisec, false, 0, options.dex || 150)
      : 0;
    const rangedProcRate = (bow.procRate != null && !Number.isNaN(Number(bow.procRate))) ? Number(bow.procRate) : 0;
    const procChance = Math.min(1, Math.max(0, baseRangedProcChance * (100 + rangedProcRate) / 100));
    // Ranger 51+ stationary bonus: beacon.cpp lines 381–405.
    // Condition (with ArcheryBonusRequiresStationary=true, UseArcheryBonusRoll=false):
    //   Ranger, level > 50, target is NPC, not moving, and not temporarily rooted.
    //   weapon_dmg *= 2 BEFORE TryCriticalHit (RollDamageMultiplier + crit).
    const mobStationary = !!(options.mobStationary);
    const rangerStationaryBonus = (options.classId === 'ranger') && level > 50 && mobStationary;
    const useWalledMobPenalty = !!options.useWalledMobPenalty;
    const WALL_PENALTY_CHANCE = 0.35;
    const WALL_PENALTY_FACTOR = 0.5;

    const report = {
      ranged: {
        swings: 0,
        hits: 0,
        totalDamage: 0,
        maxDamage: 0,
        minDamage: Infinity,
        hitList: [],
        swingThreat: 0,
        procThreat: 0,
        procs: 0,
        procDamageTotal: 0,
        procResists: 0,
        procFullResists: 0,
        procPartialResists: 0,
        procResistDamageLost: 0,
        spellProcCrits: 0,
        maxSpellProcCritDmg: 0,
        procLevelBlocked: false,
        procLevelRequired: null,
        procLevelCurrent: level,
      },
      durationSec: options.fightDurationSec,
      rawHastePercent: !Number.isNaN(Number(options.hastePercent)) ? Number(options.hastePercent) : 0,
      effectiveHastePercent: effectiveHastePercent,
      quiverHastePercent: quiverHaste > 0 ? (quiverHaste * 100) : undefined,
      totalDamage: 0,
      elementalDamageTotal: 0,
      critHits: 0,
      critDamageGain: 0,
      wallPenaltyDamageLost: useWalledMobPenalty ? 0 : undefined,
      calculatedToHit: toHit,
      offenseSkill: OFFENSE_SKILL,
      offenseRating: offenseRating,
      offenseRatingFromDex: dexBonus,
      rangerOffenseBonus: rangerOffenseBonus || undefined,
      archerySkill: ARCHERY_SKILL_BASE,
      archerySkillModified: ARCHERY_SKILL_MODIFIED,
      archerySkillEffective: ARCHERY_SKILL_EFFECTIVE,
      archeryModPercent: archeryModPercent,
      displayedAttack: Math.floor((offenseRating + toHit) * 1000 / 744),
      attackTimerMs: Math.round(delayMs),
      // Base damage breakdown for the Weapon Overview section
      bowBaseDamage: bow.damage || 0,
      arrowBaseDamage: arrow.damage || 0,
      masteryPct: masteryPct,
      rangerStationaryBonus: rangerStationaryBonus,
    };
    // Theoretical max hit for ranged — mirrors exact sim pipeline:
    //   physBase = bow+arrow → mastery → [trueshot] → halve   (matches DoArcheryAttackDmg)
    //   rangedElemAdder added AFTER halving, passed to calcMeleeDamage as extra base
    //   D20=20 on (physBase + maxElem)
    //   stationary ×2 on D20 result
    //   rollDamageMultiplier max
    //   optional crit
    {
      const _rMultParams = getRollDamageMultiplierParams(level, 'ranger');
      const _hasCritRanged = getCritChance(level, 'ranger', options.dex || 150, 0, options.critChanceMult || 0, true) > 0;
      // Max elemental from bow + arrow (each through applyElementalResist separately, take max possible)
      function _maxElemAdderR(weapon) {
        if (!weapon || !(weapon.elemDamage > 0)) return 0;
        const resist = getResistForElemType(options, weapon.elemType);
        if (resist > 200) return 0;
        const maxRoll = 201 - resist;
        if (maxRoll > 99) return weapon.elemDamage;
        return Math.floor(weapon.elemDamage * maxRoll / 100);
      }
      const _maxElemRanged = _maxElemAdderR(bow) + _maxElemAdderR(arrow);
      function _calcRangedTheoMax(halvedBase, withCrit) {
        // elem is added to already-halved base before D20 (matches line: calcMeleeDamage(physicalBase + rangedElemAdder, ...))
        const d20 = Math.floor((20 * (halvedBase + _maxElemRanged) + 5) / 10);
        const afterStat = rangerStationaryBonus ? d20 * 2 : d20;
        const afterMult = _roundMultUp ? Math.ceil(afterStat * _rMultParams.maxExtra / 100) : Math.floor(afterStat * _rMultParams.maxExtra / 100);
        return withCrit ? applyCritDamage(afterMult, 0, 17, false, 0) : afterMult;
      }
      let physBaseNoTS = (bow.damage || 0) + (arrow.damage || 0);
      if (masteryPct > 0) physBaseNoTS += Math.floor(physBaseNoTS * masteryPct / 100);
      if (physBaseNoTS > 1) physBaseNoTS = Math.floor(physBaseNoTS / 2);
      let physBaseTS = (bow.damage || 0) + (arrow.damage || 0);
      if (masteryPct > 0) physBaseTS += Math.floor(physBaseTS * masteryPct / 100);
      physBaseTS += Math.floor(physBaseTS * 105 / 100);
      if (physBaseTS > 1) physBaseTS = Math.floor(physBaseTS / 2);
      report.ranged.theoreticMaxHitStd      = _calcRangedTheoMax(physBaseNoTS, false);
      report.ranged.theoreticMaxHitCrit     = _hasCritRanged ? _calcRangedTheoMax(physBaseNoTS, true) : null;
      report.ranged.theoreticMaxHitDisc     = _calcRangedTheoMax(physBaseTS, false);
      report.ranged.theoreticMaxHitDiscCrit = _hasCritRanged ? _calcRangedTheoMax(physBaseTS, true) : null;
      report.trueshotEnabled = trueshot;
      report.hasCritRanged = _hasCritRanged;
    }
    if (options.captureCombatLog) report.combatLog = [];
    report.targetName = options.targetName || 'the mob';
    function pushRangedLog(tMs, attackName, hit, damage, logTags) {
      if (!report.combatLog) return;
      var entry = { tMs: tMs, type: 'ranged', weapon: 'ranged', attackName: attackName, hit: hit, damage: damage };
      if (logTags && typeof logTags === 'object') Object.keys(logTags).forEach(function (k) { entry[k] = logTags[k]; });
      report.combatLog.push(entry);
    }
    const rangedProcLevelReq = getProcLevelRequirement(bow);
    if (bow.procSpell != null && bow.procSpell !== '' && rangedProcLevelReq != null && level < rangedProcLevelReq) {
      report.ranged.procLevelBlocked = true;
      report.ranged.procLevelRequired = rangedProcLevelReq;
    }
    if (procChance > 0 && delayMs > 0) {
      report.ranged.anticipatedProcChancePerShot = procChance;
      report.ranged.anticipatedProcsPerMinute = procChance * (60 * 1000 / delayMs);
    }

    const TR = global.EQThreat;
    const rangedProcCap = options.procThreatCap != null ? options.procThreatCap : 400;
    function resolveTargetMaxHpRanged(opts) {
      if (opts.targetMaxHp != null && opts.targetMaxHp > 0) return opts.targetMaxHp | 0;
      if (TR && typeof TR.genericMobMaxHpForLevel === 'function') return TR.genericMobMaxHpForLevel(opts.mobLevel != null ? opts.mobLevel : 60);
      const ml = opts.mobLevel != null ? opts.mobLevel : 60;
      return Math.floor(22105 * Math.min(70, Math.max(1, ml | 0)) / 60);
    }
    let rangedThreatAcc = 0;
    let rangedSwingThreatAcc = 0;
    let rangedProcThreatAcc = 0;
    function addRangedSwingThreat() {
      if (!TR) return;
      const h = TR.rangedSwingThreat(bow.damage, arrow.damage);
      rangedSwingThreatAcc += h;
      rangedThreatAcc += h;
    }
    function addRangedProcThreat(baseProcDmg, isNonDamagingDetrimental) {
      if (!TR) return;
      let h = 0;
      if (isNonDamagingDetrimental && bow.procSpellNonDamagingDetrimental && TR.detrimentalNonDamageSpellThreat) {
        h += TR.detrimentalNonDamageSpellThreat(resolveTargetMaxHpRanged(options));
      } else if (baseProcDmg > 0) {
        h += TR.procSpellThreatFromDamage(baseProcDmg, rangedProcCap);
      }
      if (!isNonDamagingDetrimental && bow.procSpellCcAddsMobHpThreat && baseProcDmg > 0 && TR.detrimentalNonDamageSpellThreat) {
        h += TR.detrimentalNonDamageSpellThreat(resolveTargetMaxHpRanged(options));
      }
      const flat = bow.procSpellBonusHate != null ? (bow.procSpellBonusHate | 0) : 0;
      if (flat !== 0) h += TR.procFlatHate ? TR.procFlatHate(flat) : flat;
      if (h === 0) return;
      rangedProcThreatAcc += h;
      rangedThreatAcc += h;
    }

    let nextRangedAtMs = 0;

    while (nextRangedAtMs < durationMs) {
      const trueshotActive = trueshot && nextRangedAtMs >= trueshotStartMs && nextRangedAtMs < trueshotEndMs;
      const currentToHit = trueshotActive ? toHitTrueshot : toHit;
      report.ranged.swings++;
      addRangedSwingThreat();
      // Proc is attempted every swing (even on miss)
      let procDamageThisShot = 0;
      if (procChance > 0 && checkProc(procChance, procRng) && canProcLandOnTarget(bow, options)) {
        report.ranged.procs++;
        const procDmg = bow.noDamageVsTarget ? 0 : ((bow.procSpellDamage != null ? bow.procSpellDamage : 0) || 0);
        const effectiveness = getProcSpellEffectiveness(bow, options, level, procRng);
        if (bow.procSpellNonDamagingDetrimental) {
          if (effectiveness === 0) {
            report.ranged.procFullResists++;
            report.ranged.procResists++;
          } else if (effectiveness < 100) {
            report.ranged.procPartialResists++;
            report.ranged.procResists++;
          }
          if (effectiveness > 0) addRangedProcThreat(0, true);
          procDamageThisShot = 0;
        } else {
          let actualProcDmg = Math.floor(procDmg * effectiveness / 100);
          const scfResult = applySpellCastingFuryProc(actualProcDmg, options, procRng);
          actualProcDmg = scfResult.damage;
          if (scfResult.isCrit) {
            report.ranged.spellProcCrits++;
            report.ranged.maxSpellProcCritDmg = Math.max(report.ranged.maxSpellProcCritDmg || 0, actualProcDmg);
          }
          report.ranged.procDamageTotal += actualProcDmg;
          procDamageThisShot = actualProcDmg;
          if (procDmg > 0) {
            addRangedProcThreat(procDmg, false);
          } else if (effectiveness > 0) {
            addRangedProcThreat(0, false);
          }
          if (procDmg > 0) {
            if (actualProcDmg === 0) {
              report.ranged.procFullResists++;
              report.ranged.procResists++;
              report.ranged.procResistDamageLost += procDmg;
            } else if (actualProcDmg < procDmg) {
              report.ranged.procPartialResists++;
              report.ranged.procResists++;
              report.ranged.procResistDamageLost += (procDmg - actualProcDmg);
            }
          } else {
            if (effectiveness === 0) {
              report.ranged.procFullResists++;
              report.ranged.procResists++;
            } else if (effectiveness < 100) {
              report.ranged.procPartialResists++;
              report.ranged.procResists++;
            }
          }
        }
      }
      let hit = rollHit(currentToHit, avoidance, rng, 0);
      if (!hit) {
        nextRangedAtMs += delayMs;
        pushRangedLog(nextRangedAtMs - delayMs, 'shoot', false, undefined, { miss: true });
        if (procDamageThisShot > 0) {
          report.ranged.totalDamage += procDamageThisShot;
          report.totalDamage += procDamageThisShot;
          report.ranged.maxDamage = Math.max(report.ranged.maxDamage, procDamageThisShot);
          if (procDamageThisShot < report.ranged.minDamage) report.ranged.minDamage = procDamageThisShot;
          report.ranged.hitList.push(procDamageThisShot);
          pushRangedLog(nextRangedAtMs - delayMs, 'proc', true, procDamageThisShot, { proc: true });
        }
        continue;
      }
      report.ranged.hits++;
      const rangedElemAdder = getElementalBaseAdder(bow, options, elemRng) + getElementalBaseAdder(arrow, options, elemRng);
      report.elementalDamageTotal += rangedElemAdder;
      // special_attacks.cpp DoArcheryAttackDmg: server applies ArcheryBaseDamageBonus (rule, default 1.0),
      // then aabonuses.ArcheryDamageModifier (Archery Mastery), then spellbonuses.ArcheryDamageModifier
      // (Trueshot = 105%), all to the full base BEFORE CalcMeleeDamage halves it (line 952).
      // Halving and mastery applied here in opposite order but result is identical (linear operations).
      // Build base damage matching DoArcheryAttackDmg order:
      //   1. bow + arrow  2. ArcheryBaseDamageBonus (1.0 default)  3. Archery Mastery  4. Trueshot
      //   5. CalcMeleeDamage (halves for SkillArchery internally)
      let physicalBase = (bow.damage || 0) + (arrow.damage || 0);
      if (masteryPct > 0) physicalBase += Math.floor(physicalBase * masteryPct / 100);
      if (trueshotActive) physicalBase += Math.floor(physicalBase * 105 / 100); // spellbonuses.ArcheryDamageModifier=105
      if (physicalBase > 1) physicalBase = Math.floor(physicalBase / 2); // CalcMeleeDamage archery halving
      let baseDmg = calcMeleeDamage(physicalBase + rangedElemAdder, offenseRating, mitigation, rng, 0);
      baseDmg = Math.max(1, baseDmg);
      // Stationary bonus doubles weapon_dmg before TryCriticalHit (beacon.cpp line 401-413).
      if (rangerStationaryBonus) baseDmg *= 2;
      const mult = rollDamageMultiplier(offenseRating, baseDmg, level, 'ranger', true, rng);
      let dmg = mult.damage;
      const beforeCrit = dmg;
      const critResult = rollMeleeCrit(dmg, 0, level, 'ranger', options.dex, options.critChanceMult || 0, true, false, 0, options.critDmgDebugDmgBonus, rng);
      dmg = critResult.damage;
      if (critResult.isCrit) {
        report.critHits++;
        report.critDamageGain += (dmg - beforeCrit);
      }
      if (useWalledMobPenalty && rng() < WALL_PENALTY_CHANCE) {
        const actualDamage = Math.max(1, Math.floor(dmg * WALL_PENALTY_FACTOR));
        report.wallPenaltyDamageLost += (dmg - actualDamage);
        dmg = actualDamage;
      }
      if (bow.noDamageVsTarget) { report.elementalDamageTotal -= rangedElemAdder; dmg = 0; procDamageThisShot = 0; }
      const physDmg = dmg;
      dmg += procDamageThisShot;
      report.ranged.totalDamage += dmg;
      report.totalDamage += dmg;
      report.ranged.maxDamage = Math.max(report.ranged.maxDamage, dmg);
      if (dmg < report.ranged.minDamage) report.ranged.minDamage = dmg;
      report.ranged.hitList.push(dmg);
      pushRangedLog(nextRangedAtMs, 'shoot', true, physDmg, { isCrit: critResult.isCrit, trueshotActive: trueshotActive });
      if (procDamageThisShot > 0) pushRangedLog(nextRangedAtMs, 'proc', true, procDamageThisShot, { proc: true });
      nextRangedAtMs += delayMs;
    }

    if (report.ranged.minDamage === Infinity) report.ranged.minDamage = null;
    report.totalThreat = rangedThreatAcc;
    report.swingThreat = rangedSwingThreatAcc;
    report.procThreat = rangedProcThreatAcc;
    report.ranged.swingThreat = rangedSwingThreatAcc;
    report.ranged.procThreat = rangedProcThreatAcc;
    return report;
  }

  function formatRangedReport(report, runsAveraged) {
    if (report.error) return report.error;
    const r = report.ranged;
    const dur = report.durationSec;
    const totalDPS = dur ? (report.totalDamage / dur).toFixed(2) : '—';
    const runs = runsAveraged != null ? runsAveraged : 1;
    const VALUE_COL = 48;
    function padLine(prefix, value) {
      return prefix + ' '.repeat(Math.max(0, VALUE_COL - prefix.length)) + value;
    }
    function fmt(v) {
      return v == null ? '—' : (Number.isInteger(v) ? String(v) : v.toFixed(2));
    }
    function hitStatsFromList(arr) {
      if (!arr || arr.length === 0) return { min: null, max: null, mean: null, median: null, mode: null };
      const min = Math.min.apply(null, arr);
      const max = Math.max.apply(null, arr);
      const sum = arr.reduce((a, b) => a + b, 0);
      const mean = sum / arr.length;
      const sorted = arr.slice().sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
      const counts = {};
      let mode = arr[0], maxCount = 0;
      for (let i = 0; i < arr.length; i++) {
        const v = arr[i];
        counts[v] = (counts[v] || 0) + 1;
        if (counts[v] > maxCount) { maxCount = counts[v]; mode = v; }
      }
      return { min, max, mean, median, mode };
    }
    const lines = [];

    // 1. Executive Summary
    lines.push('=== Executive Summary ===', '');
    if (report.baseDamageCap && report.baseDamageCap.cap != null) {
      lines.push(`  Base damage cap (anti-twink): ${report.baseDamageCap.cap} (level < 40, imposed on weapon base damage)`);
      lines.push('');
    }
    lines.push(padLine('  Duration:', `${dur} seconds`));
    lines.push(padLine('  Runs averaged:', String(runs)));
    lines.push(padLine('  Total DPS:', totalDPS));
    if (runs > 1 && report.dpsStdDev != null && report.dpsStdDev >= 0) {
      lines.push(padLine('  DPS std dev:', report.dpsStdDev.toFixed(2)));
    }
    lines.push(padLine('  Total damage:', String(report.totalDamage)));
    if (report.totalThreat != null && report.totalThreat >= 0) {
      const tps = dur ? (report.totalThreat / dur).toFixed(2) : '—';
      const swT = report.swingThreat != null ? report.swingThreat : 0;
      const prT = report.procThreat != null ? report.procThreat : 0;
      lines.push(padLine('  TPS (threat, approx):', tps));
      lines.push(padLine('  Total threat:', String(Math.round(report.totalThreat)) + '  (swing + proc; not equal to damage)'));
      lines.push(padLine('  Swing TPS (threat, approx):', dur ? (swT / dur).toFixed(2) : '—'));
      lines.push(padLine('  Proc TPS (threat, approx):', dur ? (prT / dur).toFixed(2) : '—'));
      lines.push(padLine('  Swing threat (approx):', String(Math.round(swT))));
      lines.push(padLine('  Proc threat (approx):', String(Math.round(prT))));
    }
    if (report.critHits != null && report.critHits >= 0) {
      const hits = report.ranged && report.ranged.hits > 0 ? report.ranged.hits : 0;
      const critPct = hits > 0 ? ((report.critHits / hits) * 100).toFixed(1) : '0.0';
      lines.push(padLine('  Ranged crit %:', `${critPct}%`));
      lines.push(padLine('  Ranged crit count:', String(report.critHits)));
    }
    if (report.critDamageGain != null && report.critDamageGain >= 0) {
      lines.push(padLine('  Crit DPS gain:', `${(report.critDamageGain / dur).toFixed(2)} (vs non-crit baseline)`));
    }
    if (report.elementalDamageTotal != null && report.elementalDamageTotal > 0) {
      lines.push(padLine('  Elemental damage:', String(report.elementalDamageTotal)));
    }
    lines.push('');

    // 2. Offense & To-Hit Model (align with melee: offense skill, archery skill, rating breakdown, ATK, haste)
    lines.push('=== Offense & To-Hit Model ===', '');
    if (report.calculatedToHit != null) lines.push(padLine('  Calculated to-hit:', String(report.calculatedToHit)));
    if (report.offenseSkill != null) lines.push(padLine('  Offense skill:', `${report.offenseSkill}  (0–255, used for to-hit only)`));
    if (report.archerySkill != null) lines.push(padLine('  Archery skill level:', `${report.archerySkill}  (base, 0–252)`));
    if (report.archerySkillModified != null) {
      const modNote = report.archeryModPercent > 0 ? `  (+${report.archeryModPercent}% skill mod)` : '';
      lines.push(padLine('  Modified archery skill:', `${report.archerySkillModified}${modNote}`));
    }
    if (report.archerySkillEffective != null) {
      const effNote = report.archeryModPercent > 0 ? '  (with skill mod, capped at 252, used in to-hit)' : '  (capped at 252, used in to-hit)';
      lines.push(padLine('  Effective archery skill:', `${report.archerySkillEffective}${effNote}`));
    }
    if (report.offenseRating != null) lines.push(padLine('  Offense rating:', `${report.offenseRating}  (used for damage)`));
    if (report.offenseRatingFromDex != null) lines.push(padLine('    From DEX:', String(report.offenseRatingFromDex)));
    if (report.rangerOffenseBonus != null && report.rangerOffenseBonus > 0) lines.push(padLine('    Ranger level>54 bonus:', `+${report.rangerOffenseBonus}`));
    if (report.offenseRating != null && report.offenseRatingFromDex != null) {
      const other = report.offenseRating - report.offenseRatingFromDex - (report.rangerOffenseBonus || 0);
      lines.push(padLine('    From other:', `${other}  (skill + worn + spell)`));
    }
    if (report.displayedAttack != null) lines.push(padLine('  Displayed ATK:', String(report.displayedAttack)));
    lines.push(padLine('  ATK formula:', '(offense rating + toHit) * 1000 / 744'));
    if (report.rawHastePercent != null || report.effectiveHastePercent != null) {
      const raw = report.rawHastePercent != null ? Number(report.rawHastePercent).toFixed(1) : '—';
      const eff = report.effectiveHastePercent != null ? Number(report.effectiveHastePercent).toFixed(1) : '—';
      lines.push(padLine('  Haste (raw / effective):', `${raw}% / ${eff}%  (standard cap; quiver separate)`));
    }
    if (report.attackTimerMs != null) lines.push(padLine('  Timer between rounds (after haste + quiver):', `${report.attackTimerMs} ms`));
    if (report.quiverHastePercent != null && report.quiverHastePercent > 0) {
      lines.push(padLine('  Quiver haste:', `${report.quiverHastePercent.toFixed(1)}%  (applied after standard, not subject to 125% cap)`));
    }
    lines.push('');

    // 3. Weapon Overview (Ranged)
    lines.push('=== Weapon Overview ===', '');
    lines.push('  Ranged');
    {
      const bowBase   = report.bowBaseDamage != null ? report.bowBaseDamage : 0;
      const arrowBase = report.arrowBaseDamage != null ? report.arrowBaseDamage : 0;
      const rawSum    = bowBase + arrowBase;
      const mPct      = report.masteryPct != null ? report.masteryPct : 0;
      const afterMastery = mPct > 0 ? rawSum + Math.floor(rawSum * mPct / 100) : rawSum;
      const afterHalve   = afterMastery > 1 ? Math.floor(afterMastery / 2) : afterMastery;
      lines.push(padLine('    Bow base damage:', String(bowBase)));
      lines.push(padLine('    Arrow base damage:', String(arrowBase)));
      lines.push(padLine('    Bow + arrow (raw):', String(rawSum)));
      if (mPct > 0) {
        lines.push(padLine('    After Archery Mastery (+' + mPct + '%):', String(afterMastery)));
      }
      lines.push(padLine('    Effective shot base:', String(afterHalve) + '  (after server archery ÷2; used for damage roll)'));
      if (report.rangerStationaryBonus) {
        lines.push(padLine('    Ranger stationary bonus:', '×2 applied after D20 roll'));
      }
      {
        const _tsNote = report.trueshotEnabled ? '' : '  (Disc not enabled)';
        const _rr = report.ranged;
        if (_rr.theoreticMaxHitStd      != null) lines.push(padLine('    Max possible hit:',                   String(_rr.theoreticMaxHitStd)));
        if (_rr.theoreticMaxHitCrit     != null) lines.push(padLine('    Max possible hit (crit):',            String(_rr.theoreticMaxHitCrit)));
        if (_rr.theoreticMaxHitDisc     != null) lines.push(padLine('    Max possible hit (Trueshot):',        String(_rr.theoreticMaxHitDisc) + _tsNote));
        if (_rr.theoreticMaxHitDiscCrit != null) lines.push(padLine('    Max possible hit (Trueshot + crit):', String(_rr.theoreticMaxHitDiscCrit) + _tsNote));
      }
    }
    lines.push(padLine('    Total damage:', String(r.totalDamage)));
    lines.push(padLine('    Weapon DPS:', (r.totalDamage / dur).toFixed(2)));
    {
      const rSwingT = r.swingThreat != null ? r.swingThreat : 0;
      const rProcT = r.procThreat != null ? r.procThreat : 0;
      const rThreatTot = rSwingT + rProcT;
      lines.push(padLine('    TPS (threat, approx):', dur ? (rThreatTot / dur).toFixed(2) : '—'));
      lines.push(padLine('    Swing threat (approx):', String(Math.round(rSwingT))));
      lines.push(padLine('    Swing TPS (threat, approx):', dur ? (rSwingT / dur).toFixed(2) : '—'));
    }
    lines.push('');

    // 4. Attack Distribution
    lines.push('=== Attack Distribution ===', '');
    lines.push(padLine('    Shots:', String(r.swings)));
    lines.push(padLine('    Hits:', String(r.hits)));
    if (r.swings > 0) lines.push(padLine('    Accuracy:', (r.hits / r.swings * 100).toFixed(1) + '%'));
    lines.push('');

    // 5. Hit Damage Statistics (match melee: max, min, mean, median, mode)
    lines.push('=== Hit Damage Statistics ===', '');
    const rStats = hitStatsFromList(r.hitList);
    lines.push(padLine('    Max hit:', fmt(rStats.max != null ? rStats.max : r.maxDamage)));
    lines.push(padLine('    Min hit:', fmt(rStats.min)));
    lines.push(padLine('    Mean hit:', fmt(rStats.mean)));
    lines.push(padLine('    Median hit:', fmt(rStats.median)));
    lines.push(padLine('    Mode hit:', fmt(rStats.mode)));
    lines.push('');

    // 6. Procs & Specials
    lines.push('=== Procs & Specials ===', '');
    if (r.anticipatedProcsPerMinute != null) lines.push(padLine('    Anticipated procs per minute:', r.anticipatedProcsPerMinute.toFixed(2)));
    if (r.anticipatedProcChancePerShot != null) lines.push(padLine('    Anticipated proc chance per shot:', (r.anticipatedProcChancePerShot * 100).toFixed(2) + '%'));
    if (r.procs != null) lines.push(padLine('    Procs:', String(r.procs)));
    lines.push(padLine('    Proc damage:', String(r.procDamageTotal != null ? r.procDamageTotal : 0)));
    lines.push(padLine('    Proc DPS:', (r.procDamageTotal != null && dur > 0) ? (r.procDamageTotal / dur).toFixed(2) : '0.00'));
    {
      const rProcT = r.procThreat != null ? r.procThreat : 0;
      lines.push(padLine('    Proc threat (approx):', String(Math.round(rProcT))));
      lines.push(padLine('    Proc TPS (threat, approx):', dur ? (rProcT / dur).toFixed(2) : '—'));
    }
    lines.push(padLine('    Proc full resists:', String(r.procFullResists != null ? r.procFullResists : 0)));
    lines.push(padLine('    Proc partial resists:', String(r.procPartialResists != null ? r.procPartialResists : 0)));
    if (r.procLevelBlocked) {
      lines.push(padLine('    Proc gated by level:', `yes (level ${r.procLevelCurrent != null ? r.procLevelCurrent : '-'} < required ${r.procLevelRequired != null ? r.procLevelRequired : '-'})`));
    }
    if (r.procResistDamageLost != null && r.procResistDamageLost > 0) {
      lines.push(padLine('    Proc damage lost (resists):', String(r.procResistDamageLost)));
    }
    if (r.spellProcCrits != null) lines.push(padLine('    Proc spell crits (SCF):', String(r.spellProcCrits)));
    if (r.maxSpellProcCritDmg != null && r.maxSpellProcCritDmg > 0) lines.push(padLine('    Max spell proc crit dmg:', String(r.maxSpellProcCritDmg)));
    lines.push('');

    // 7. Final Totals
    lines.push('=== Final Totals ===', '');
    lines.push(padLine('  Total damage:', String(report.totalDamage)));
    lines.push(padLine('  Total DPS:', totalDPS));
    if (report.totalThreat != null && report.totalThreat >= 0) {
      lines.push(padLine('  TPS (threat, approx):', dur ? (report.totalThreat / dur).toFixed(2) : '—'));
      const swT = report.swingThreat != null ? report.swingThreat : 0;
      const prT = report.procThreat != null ? report.procThreat : 0;
      lines.push(padLine('  Swing TPS (threat, approx):', dur ? (swT / dur).toFixed(2) : '—'));
      lines.push(padLine('  Proc TPS (threat, approx):', dur ? (prT / dur).toFixed(2) : '—'));
      lines.push(padLine('  Total threat (approx):', String(Math.round(report.totalThreat))));
    }
    return lines.join('\n');
  }

  // ----- Simulation state -----
  function createRng(seed) {
    if (seed == null) {
      return Math.random;
    }
    let s = seed;
    return function () {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return s / 0x7fffffff;
    };
  }

  /**
   * Run a single fight simulation.
   * @param {Object} options
   * @param {Object} [options.weapon1] - { damage, delay, procSpell?, procSpellDamage?, procBuffDurationTicks?, is2H?, type?, procSpellNonDamagingDetrimental? }. procBuffDurationTicks = DoT ticks (6s each); omit/0 = instant proc. type = weapon skill type (e.g. '1hp' for backstab requirement).
   * @param {string} [options.weapon1Type] - main hand weapon type (e.g. '1hp'); used for backstab (rogue requires 1HP in primary).
   * @param {Object} [options.weapon2] - optional offhand (required when weapon1 omitted)
   * @param {number} options.hastePercent - total haste (e.g. 40 for 40%)
   * @param {number} [options.wornAttack=0] - worn ATK (items)
   * @param {number} [options.spellAttack=0] - spell ATK (buffs)
   * @param {number} [options.offenseSkill=252] - offense SKILL (0–255); used in to-hit. Offense RATING (for damage) = offense skill + STR bonus + worn attack + spell attack.
   * @param {number} [options.toHitBonus=0] - e.g. class bonus (Warrior +24)
   * @param {number} [options.str=255] - STR stat; when STR >= 75 adds to offense RATING (the value used in the damage roll)
   * @param {number} options.doubleAttackSkill - double attack skill value
   * @param {number} options.dualWieldSkill - dual wield skill value
   * @param {number} [options.level=60] - level for DA/DW effective
   * Every swing: (1) AvoidanceCheck using toHit vs avoidance → hit/miss. (2) If hit, CalcMeleeDamage using RollD20(offense RATING, mitigation) → damage. Avoidance and mitigation are applied every time.
   * @param {number} options.targetAC - defender AC for mitigation (damage roll). When level-based mit would be 200 and AC>200, use this. Higher = more mitigated damage, fewer max hits.
   * @param {number} [options.avoidance] - defender avoidance for HIT CHANCE. If omitted, uses getAvoidanceNPC(mobLevel) = level*9+5 capped 400/460
   * @param {number} [options.mobLevel=60] - mob level for getMitigation() and default avoidance
   * @param {number} [options.targetMaxHp] - mob max HP (e.g. npc_types hp); if omitted, uses generic HP scaled from mobLevel (22105 at level 60)
   * @param {number} options.fightDurationSec - fight length in seconds
   * @param {number} [options.dex=255] - dexterity for proc
   * @param {boolean} [options.fromBehind] - if true, skip block/parry/dodge/riposte only
   * @param {boolean} [options.specialAttacks] - if true, fire class special on cooldown
   * @param {string} [options.specialAttackType] - 'flying_kick'|'backstab'|'kick'|'bash'; must be valid for class (Warrior: kick/bash; Pally/SK/Cleric: bash; Ranger/Beastlord: kick; Monk: flying_kick; Rogue: backstab)
   * @param {number} [options.backstabModPercent] - increase effective backstab skill by this % (e.g. 20 for 20%); effective skill capped at 252
   * @param {number} [options.backstabSkill] - backstab skill for base damage (skill*0.02+2)*weapon_damage; also enforces minHit by level
   * @param {number} [options.backstabReuseSec] - override backstab base reuse time in seconds (default: 10); haste is applied to this base
   * @param {number} [options.flyingKickReuseSec] - override flying kick base reuse time in seconds (default: 8); haste is applied to this base
   * @param {number} [options.backstabReuseEffectiveSec] - use this value directly as effective backstab reuse (no haste applied); used when UI passes user-typed effective time
   * @param {number} [options.flyingKickReuseEffectiveSec] - use this value directly as effective flying kick reuse (no haste applied); used when UI passes user-typed effective time
   * @param {number} [options.kickReuseEffectiveSec] - effective kick reuse (s), no haste applied
   * @param {number} [options.bashReuseEffectiveSec] - effective bash reuse (s), no haste applied
   * @param {number} [options.seed] - optional RNG seed for reproducibility
   * @param {number} [options.critChanceMult] - Combat Fury flat crit % (0, 2, 4, 6); stacks on warrior innate
   * @param {boolean} [options.duelist] - rogue only: SE_DamageModifier[185] (+100% base damage) for 12s at a random time in the fight
   * @param {boolean} [options.innerFlame] - monk only: SE_DamageModifier[185] (+100% base damage) for 12s at a random time in the fight
   * @param {boolean} [options.duelistPermanent] - with duelist: discipline effect for entire fight (unrealistic; UI shift+click)
   * @param {boolean} [options.innerFlamePermanent] - with innerFlame: same (UI shift+click)
   * @param {string} [options.fistweavingOffhandLabel] - when non-epic fistweaving or 2H weave uses equipped 1H offhand with 2H primary: display name for report
   * @param {boolean} [options.twoHandWeave] - warrior/ranger/beastlord: after each mainhand 2H swing, manually weave the equipped 1H offhand weapon (no auto offhand rounds; DA rules follow class: warrior/ranger normal DA, beastlord only via Bestial Frenzy AA)
   */
  function runFight(options) {
    _roundMultUp = !!options.roundMultUp;
    const fromBehind = !!options.fromBehind;
    const rng = createRng(options.seed);
    const procRng = createRng(options.seed != null ? options.seed + 12345 : undefined);
    const elemRng = createRng(options.seed != null ? options.seed + 54321 : undefined);
    const weaveRng = createRng(options.seed != null ? options.seed + 99999 : undefined);
    const specialRng = createRng(options.seed != null ? options.seed + 77777 : undefined);
    const specialType = options.specialAttackType || getDefaultSpecialTypeForClass(options.classId);
    const specialConfig = (options.specialAttacks && options.classId && specialType && canClassUseSpecialType(options.classId, specialType) && SPECIAL_ATTACKS_BY_TYPE[specialType])
      ? SPECIAL_ATTACKS_BY_TYPE[specialType]
      : (options.specialAttacks && options.classId && SPECIAL_ATTACKS[options.classId])
        ? SPECIAL_ATTACKS[options.classId]
        : null;
    let canFireSpecial = specialConfig && (!specialConfig.fromBehindOnly || fromBehind);
    const level = options.level != null ? options.level : 60;
    const effectiveHastePercent = getEffectiveHastePercent(options.hastePercent, level, options.hasteCap60Bonus);
    const targetAC = options.targetAC;
    const mobLevel = options.mobLevel != null ? options.mobLevel : 60;
    // ---- Avoidance and mitigation: applied on EVERY swing ----
    // Hit chance uses AVOIDANCE (GetAvoidance), not AC. Default = NPC formula (level*9+5, cap 400/460).
    // Tactical Mastery (warrior PoP AA): rank 1/2/3 reduces NPC effective avoidance by 10/20/30
    const tacticalMasteryRank = (options.tacticalMasteryRank | 0) || 0;
    const avoidance = Math.max(1, (options.avoidance != null ? options.avoidance : getAvoidanceNPC(mobLevel)) - ([0, 10, 20, 30][tacticalMasteryRank] || 0));
    // Front avoidance: 0 when attacking from behind (no block/parry/riposte/dodge);
    // otherwise computed from NPC class-based defense skills (block→parry→riposte→dodge).
    const mobClass = options.mobClass != null ? options.mobClass : null;
    const frontAvoidChance = fromBehind ? 0 : computeFrontAvoidChance(mobLevel, mobClass);
    // Damage roll uses MITIGATION (GetMitigation). Computed once and used every time we calc damage.
    const mitigation = getMitigation(mobLevel, targetAC, options.itemAcBonus ?? 0, options.spellAcBonus ?? 0);
    const str = options.str != null ? options.str : 255;
    const strBonus = str >= 75 ? Math.floor((2 * str - 150) / 3) : 0;
    const wornAttack = options.wornAttack != null ? options.wornAttack : 0;
    const spellAttack = options.spellAttack != null ? options.spellAttack : 0;
    const toHitBonus = options.toHitBonus != null ? options.toHitBonus : 0;
    // To Hit: 7 + offense SKILL + weapon skill. Weapon skill from skill caps (class/level/type) when options.weaponSkillForToHit provided, else 252.
    const OFFENSE_SKILL = options.offenseSkill != null ? Math.min(255, Math.max(0, options.offenseSkill)) : 252;
    const WEAPON_SKILL_FOR_TOHIT = (options.weaponSkillForToHit != null && typeof options.weaponSkillForToHit === 'number') ? options.weaponSkillForToHit : 252;
    const BASE_TO_HIT = 7 + OFFENSE_SKILL + WEAPON_SKILL_FOR_TOHIT;
    const toHit = (options.attackRating != null && options.wornAttack == null && options.spellAttack == null)
      ? options.attackRating + toHitBonus
      : BASE_TO_HIT + toHitBonus;
    // Offense RATING (for damage roll / RollD20): server GetOffense(weaponTypeSkill) uses the weapon type skill
    // (e.g. 1H Slash, 1H Pierce), NOT the Offense/Attack skill. WEAPON_SKILL_FOR_TOHIT is the weapon type skill.
    // OFFENSE_SKILL is still used only for to-hit (BASE_TO_HIT = 7 + OffenseSkill + WeaponSkill).
    const offenseRating = (options.attackRating != null && options.wornAttack == null && options.spellAttack == null)
      ? options.attackRating + strBonus
      : (WEAPON_SKILL_FOR_TOHIT + strBonus + wornAttack + spellAttack);
    const dualWieldEffective = getDualWieldEffective(level, options.dualWieldSkill, options.ambidexterity ?? 0);
    const dualWieldPct = (dualWieldEffective / 375) * 100;

    // ---- New AA mechanics (Luclin/PoP) ----
    const flurryRank = (options.flurryRank | 0) || 0;
    // Fury of the Ages: PoP AA for all melee classes, rank 1–3 = +5/10/15% crit damage bonus
    const furyRank = (options.furyOfTheAgesRank | 0) || 0;
    const furyDmgBonusPct = furyRank * 5;
    // Technique of Master Wu: monk PoP AA, rank 1–5 = +10% per rank chance of extra flying kick strikes (max 2 extra)
    const masterWuRank = (options.masterWuRank | 0) || 0;
    // Ferocity (warrior/ranger/monk/rogue): +2% per rank flat double-attack bonus
    const ferocityRank = (options.ferocityRank | 0) || 0;
    // Punishing Blade (warrior/ranger/monk): PoP AA — extra 2H primary attack after a double attack
    // Rank 1/2/3 = 2%/4%/8% chance (SE_ExtraAttackChance, peq_aa_tables aaid 599/600/601, base1 2/4/8)
    const PUNISHING_BLADE_CHANCE = [0, 2, 4, 8];
    const punishingBladeChance = PUNISHING_BLADE_CHANCE[(options.punishingBladeRank | 0) || 0] || 0;
    // Harmonious Attack (bard) / Bestial Frenzy (beastlord): flat DA chance for classes normally excluded from DA
    const harmoniousAttackRank = (options.harmoniousAttackRank | 0) || 0;
    const bestialFrenzyRank = (options.bestialFrenzyRank | 0) || 0;
    const aaFlatDaChance = options.classId === 'bard' ? harmoniousAttackRank * 0.02
      : options.classId === 'beastlord' ? bestialFrenzyRank * 0.02 : 0;

    // Knight's Advantage (paladin/shadowknight PoP AA): +2%/+4%/+6% DA (+10/+20/+30 to effective DA)
    const knightsAdvantageRank = (options.knightsAdvantageRank | 0) || 0;
    const knightsAdvantageDaBonus = knightsAdvantageRank * 10;
    // Speed of the Knight (paladin/shadowknight PoP AA): extra 2H primary attack after double attack
    const SPEED_OF_KNIGHT_CHANCE = [0, 2, 4, 8];
    const speedOfTheKnightChance = SPEED_OF_KNIGHT_CHANCE[(options.speedOfTheKnightRank | 0) || 0] || 0;
    // Raging Flurry (warrior PoP AA): extra flurry chance on successful triple attack
    const ragingFlurryRank = (options.ragingFlurryRank | 0) || 0;
    const RAGING_FLURRY_CHANCE = [0, 0.10, 0.20, 0.30];
    const ragingFlurryChance = ragingFlurryRank > 0 ? RAGING_FLURRY_CHANCE[Math.min(ragingFlurryRank, 3)] : 0;
    // Soul Abrasion (shadowknight Luclin AA): +10%/+20%/+30% bonus to proc spell damage
    const soulAbrasionRank = (options.soulAbrasionRank | 0) || 0;
    const soulAbrasionProcMult = (options.classId === 'shadowknight' && soulAbrasionRank > 0)
      ? (1 + soulAbrasionRank * 0.10) : 1.0;

    // Ferocity adds +10 to doubleAttackEffective per rank (= +2% chance in the 500-pt scale)
    const ferocityDaBonus = ferocityRank * 10 + knightsAdvantageDaBonus;
    const doubleAttackEffective = (options.doubleAttackSkill > 0 ? getDoubleAttackEffective(level, options.doubleAttackSkill) : 0) + ferocityDaBonus;

    const w1 = options.weapon1;
    const w2 = options.weapon2;
    // Treat a weapon as unequipped if missing or invalid (damage/delay); ignore swings for that slot
    const mainHandEquipped = w1 && ((w1.damage >= 1 && w1.delay >= 10) || (w1.noDamageVsTarget && w1.delay >= 10));
    const rawOffhandEquipped = !!(w2 && w2.damage >= 1 && w2.delay >= 10);
    if (mainHandEquipped && w1.is2H && rawOffhandEquipped && w2.is2H) {
      return { error: 'A two-handed weapon cannot be used in the offhand with a two-handed primary.' };
    }
    const fistweaveNonEpicOhMode = !!(options.classId === 'monk' && options.fistweaving && options.fistweavingNonEpic && mainHandEquipped && w1.is2H
      && rawOffhandEquipped && !w2.is2H && (options.dualWieldSkill | 0) > 0);
    const TWO_HAND_WEAVE_CLASSES = ['warrior', 'ranger', 'beastlord'];
    const twoHandWeaveMode = !!(options.twoHandWeave && TWO_HAND_WEAVE_CLASSES.indexOf((options.classId || '').toLowerCase()) >= 0
      && mainHandEquipped && w1.is2H && rawOffhandEquipped && !w2.is2H && (options.dualWieldSkill | 0) > 0);
    const offhandEquipped = rawOffhandEquipped && !fistweaveNonEpicOhMode && !twoHandWeaveMode;
    const hasMainHand = !!mainHandEquipped;
    if (specialType === 'backstab' && options.classId === 'rogue' && canFireSpecial && hasMainHand) {
      const mainHandType = (options.weapon1Type != null ? String(options.weapon1Type) : (w1.type != null ? String(w1.type) : '')).toLowerCase();
      // Only the primary weapon must be piercing for backstab; offhand type is irrelevant. If primary type is unknown, allow backstab.
      const mainHandTypeUnknown = mainHandType === '' || mainHandType === 'undefined';
      const hasBackstabMod = (options.backstabModPercent != null && !isNaN(Number(options.backstabModPercent)) && Number(options.backstabModPercent) > 0);
      const assumedPiercing = mainHandTypeUnknown || hasBackstabMod;
      if (mainHandType !== '1hp' && mainHandType !== '2hp' && !assumedPiercing) canFireSpecial = false;
    }
    // Two Hand Bash (PAL/SHD Luclin AA): bash requires this AA when wielding a 2H primary weapon
    const classId = (options.classId || '').toLowerCase();
    if (specialType === 'bash' && w1 && w1.is2H && (classId === 'paladin' || classId === 'shadowknight') && !options.twoHandBash) {
      canFireSpecial = false;
    }
    const baseDamageCap = getBaseDamageCap(level, options.classId);
    const cappedW1Damage = hasMainHand ? (baseDamageCap != null ? Math.min(w1.damage, baseDamageCap) : w1.damage) : 0;
    const cappedW2Damage = offhandEquipped ? (baseDamageCap != null ? Math.min(w2.damage, baseDamageCap) : w2.damage) : 0;
    const cappedFistweaveOhDamage = (fistweaveNonEpicOhMode || twoHandWeaveMode)
      ? (baseDamageCap != null ? Math.min(w2.damage, baseDamageCap) : w2.damage)
      : 0;
    const mainHandDamageBonus = hasMainHand ? getDamageBonusClient(level, options.classId, w1.delay, !!w1.is2H) : 0;
    const T = global.EQThreat;
    const procThreatCap = options.procThreatCap != null ? options.procThreatCap : 400;
    function resolveTargetMaxHp(opts) {
      if (opts.targetMaxHp != null && opts.targetMaxHp > 0) return opts.targetMaxHp | 0;
      if (T && typeof T.genericMobMaxHpForLevel === 'function') return T.genericMobMaxHpForLevel(opts.mobLevel != null ? opts.mobLevel : 60);
      const ml = opts.mobLevel != null ? opts.mobLevel : 60;
      return Math.floor(22105 * Math.min(70, Math.max(1, ml | 0)) / 60);
    }
    let totalThreatAcc = 0;
    let swingThreatAcc = 0;
    let procThreatAcc = 0;
    function addSwingThreatMH() {
      if (!T) return;
      const h = T.meleeSwingThreatPrimary(cappedW1Damage, mainHandDamageBonus);
      swingThreatAcc += h;
      totalThreatAcc += h;
      report.weapon1.swingThreat += h;
    }
    function addSwingThreatOH() {
      if (!T) return;
      const h = T.meleeSwingThreatOffhand(cappedW2Damage);
      swingThreatAcc += h;
      totalThreatAcc += h;
      report.weapon2.swingThreat += h;
    }
    function addSwingThreatFist(baseDmg) {
      if (!T) return;
      const h = T.meleeSwingThreatPrimary(baseDmg, 0);
      swingThreatAcc += h;
      totalThreatAcc += h;
      if (report.fistweaving) report.fistweaving.swingThreat += h;
    }
    /**
     * includeFlatHate: false for DoT ticks (flat hate applies once on instant proc, not each tick).
     * baseThreatDmg: spell base damage (before resists/crits). isNonDamagingDetrimental: detrimental CC/no-DD proc uses maxHP/15 hate.
     */
    function addProcThreatAmt(baseThreatDmg, weaponSlot, includeFlatHate, isNonDamagingDetrimental) {
      if (!T) return;
      const w = weaponSlot === 1 ? w1 : weaponSlot === 2 ? w2 : null;
      let h = 0;
      const effectiveProcCap = (w && w.procThreatCap != null) ? w.procThreatCap : procThreatCap;
      if (isNonDamagingDetrimental && w && w.procSpellNonDamagingDetrimental && T.detrimentalNonDamageSpellThreat) {
        let ndThreat = T.detrimentalNonDamageSpellThreat(resolveTargetMaxHp(options));
        if (w.procThreatCap != null) ndThreat = Math.min(ndThreat, w.procThreatCap);
        h += ndThreat;
      } else if (baseThreatDmg > 0) {
        h += T.procSpellThreatFromDamage(baseThreatDmg, effectiveProcCap);
      }
      if (!isNonDamagingDetrimental && w && w.procSpellCcAddsMobHpThreat && baseThreatDmg > 0 && T.detrimentalNonDamageSpellThreat) {
        h += T.detrimentalNonDamageSpellThreat(resolveTargetMaxHp(options));
      }
      const flat = (includeFlatHate !== false && w && w.procSpellBonusHate != null) ? (w.procSpellBonusHate | 0) : 0;
      if (flat !== 0) h += T.procFlatHate ? T.procFlatHate(flat) : flat;
      if (h === 0) return;
      procThreatAcc += h;
      totalThreatAcc += h;
      if (weaponSlot === 1) report.weapon1.procThreat += h;
      else if (weaponSlot === 2) report.weapon2.procThreat += h;
    }
    const dualWielding = offhandEquipped && (options.dualWieldSkill != null && options.dualWieldSkill > 0) &&
      options.classId !== 'paladin' && options.classId !== 'shadowknight';

    if (!hasMainHand && !dualWielding) {
      return { error: 'Equip at least one weapon (Weapon 1 or Weapon 2 with damage, delay, and dual wield skill).' };
    }

    const delay1 = hasMainHand ? effectiveDelayDecisec(w1.delay, effectiveHastePercent) : 0;
    const delay2 = offhandEquipped ? effectiveDelayDecisec(w2.delay, effectiveHastePercent) : 0;
    // Fistweave OH mode: no regular offhand swing timer, but weapon delay still used for proc rate
    const delay2ForProc = (offhandEquipped || fistweaveNonEpicOhMode || twoHandWeaveMode) && rawOffhandEquipped
      ? effectiveDelayDecisec(w2.delay, effectiveHastePercent) : 0;
    const delay1Ms = hasMainHand ? delay1 * DECISEC_TO_MS : Infinity;
    const delay2Ms = offhandEquipped ? delay2 * DECISEC_TO_MS : 0;

    const w2HasProc = rawOffhandEquipped && w2.procSpell != null && canTriggerProcAtLevel(w2, level);
    const baseProcChance1 = hasMainHand && w1.procSpell != null && canTriggerProcAtLevel(w1, level)
      ? getProcChancePerSwing(delay1, false, dualWieldPct, options.dex || 150)
      : 0;
    const baseProcChance2 = w2HasProc
      ? getProcChancePerSwing(delay2ForProc, true, dualWieldPct, options.dex || 150)
      : 0;
    const procRate1 = (hasMainHand && w1.procRate != null && !Number.isNaN(Number(w1.procRate))) ? Number(w1.procRate) : 0;
    const procRate2 = (rawOffhandEquipped && w2.procRate != null && !Number.isNaN(Number(w2.procRate))) ? Number(w2.procRate) : 0;
    const procChance1 = Math.min(1, Math.max(0, baseProcChance1 * (100 + procRate1) / 100));
    const procChance2 = Math.min(1, Math.max(0, baseProcChance2 * (100 + procRate2) / 100));

    const roundsPerMinW1 = (delay1Ms > 0 && hasMainHand) ? (60 * 1000 / delay1Ms) : 0;
    const roundsPerMinW2 = (delay2Ms > 0 && offhandEquipped) ? (60 * 1000 / delay2Ms) : 0;
    const report = {
      weapon1: { swings: 0, hits: 0, totalDamage: 0, maxDamage: 0, minDamage: Infinity, hitList: [], swingThreat: 0, procThreat: 0, procs: 0, procDamageTotal: 0, procResists: 0, procFullResists: 0, procPartialResists: 0, procResistDamageLost: 0, spellProcCrits: 0, maxSpellProcCritDmg: 0, slayUndeadHits: 0, slayUndeadDamageTotal: 0, maxSlayUndeadHit: 0, rounds: 0, single: 0, double: 0, triple: 0, flurry: 0, punishingBlade: 0, ragingFlurry: 0, speedOfTheKnight: 0 },
      weapon2: { swings: 0, hits: 0, totalDamage: 0, maxDamage: 0, minDamage: Infinity, hitList: [], swingThreat: 0, procThreat: 0, procs: 0, procDamageTotal: 0, procResists: 0, procFullResists: 0, procPartialResists: 0, procResistDamageLost: 0, spellProcCrits: 0, maxSpellProcCritDmg: 0, rounds: 0, single: 0, double: 0, triple: 0 },
      durationSec: options.fightDurationSec,
      rawHastePercent: !Number.isNaN(Number(options.hastePercent)) ? Number(options.hastePercent) : 0,
      effectiveHastePercent: effectiveHastePercent,
      totalDamage: 0,
      elementalDamageTotal: 0,
      damageBonus: mainHandDamageBonus,
      damageBonusTotal: 0,
      calculatedToHit: toHit,
      offenseSkill: OFFENSE_SKILL,
      weaponSkillKeyForToHit: options.weaponSkillKeyForToHit != null ? options.weaponSkillKeyForToHit : undefined,
      weaponSkillForToHit: WEAPON_SKILL_FOR_TOHIT,
      offenseRating: offenseRating,
      offenseRatingFromStr: strBonus,
      offenseRatingFromWornAttack: wornAttack,
      offenseRatingFromSpellAttack: spellAttack,
      dualWieldEffective: dualWieldEffective,
      dualWieldPct: dualWieldPct,
      displayedAttack: Math.floor((offenseRating + toHit) * 1000 / 744),
      baseDamageCap: (baseDamageCap != null && ((hasMainHand && w1.damage > baseDamageCap) || (offhandEquipped && w2.damage > baseDamageCap))) ? { cap: baseDamageCap } : null,
      critHits: 0,
      critDamageGain: 0,
      special: (canFireSpecial && hasMainHand) ? {
        name: specialConfig.name,
        count: 0,
        attempts: 0,
        hits: 0,
        totalDamage: 0,
        maxDamage: 0,
        hitList: [],
        doubleBackstabs: specialConfig.fromBehindOnly && options.classId === 'rogue' ? 0 : undefined,
        attemptedAttacks: specialConfig.fromBehindOnly && options.classId === 'rogue' ? 0 : undefined,
        backstabSkill: specialConfig.fromBehindOnly ? Math.min(255, options.backstabSkill != null ? options.backstabSkill : 225) : undefined,
        backstabModPercent: specialConfig.fromBehindOnly ? (options.backstabModPercent || 0) : undefined,
      } : null,
      masterWu: (specialType === 'flying_kick' && masterWuRank > 0) ? {
        rank: masterWuRank,
        mainRolls: 0,     // total flying kicks with Wu active
        triggered: 0,     // main wuChance roll successes
        extraAttempts: 0, // total extra strikes attempted (hit or miss)
        extraHits: 0,     // extra strikes that landed
        totalDamage: 0,
        fkHits: 0,        // base flying kick hits (for avg comparison)
        fkDamage: 0,      // base flying kick damage (for avg comparison)
        bySkill: {
          'Flying Kick':  { attempts: 0, hits: 0, damage: 0 },
          'Eagle Strike': { attempts: 0, hits: 0, damage: 0 },
          'Tiger Claw':   { attempts: 0, hits: 0, damage: 0 },
          'Round Kick':   { attempts: 0, hits: 0, damage: 0 },
        },
      } : null,
      fistweaving: ((options.classId === 'monk' && hasMainHand && w1.is2H && options.fistweaving) || twoHandWeaveMode) ? {
        weaveMode: twoHandWeaveMode ? 'twoHandWeave' : 'fistweave',
        baseDamage: (fistweaveNonEpicOhMode || twoHandWeaveMode) ? cappedFistweaveOhDamage : (options.fistweavingNonEpic ? 14 : 9),
        usesEquippedOffhandWeapon: fistweaveNonEpicOhMode || twoHandWeaveMode,
        nonEpicWeaponLabel: (fistweaveNonEpicOhMode || twoHandWeaveMode) ? (options.fistweavingOffhandLabel || null) : null,
        nonEpicWeaponDelayDecisec: (fistweaveNonEpicOhMode || twoHandWeaveMode) ? w2.delay : null,
        rounds: 0, attempts: 0, dwFailed: 0, swings: 0, hits: 0, totalDamage: 0, maxDamage: 0, single: 0, double: 0, swingThreat: 0,
      } : null,
      classId: options.classId || undefined,
    };
    report.weapon1.procLevelBlocked = false;
    report.weapon1.procLevelRequired = null;
    report.weapon1.procLevelCurrent = level;
    report.weapon2.procLevelBlocked = false;
    report.weapon2.procLevelRequired = null;
    report.weapon2.procLevelCurrent = level;
    if (options.captureCombatLog) report.combatLog = [];
    report.targetName = options.targetName || 'the mob';
    function getMeleeAttackVerb(type) {
      const t = (type || '').toLowerCase();
      if (t === '1hp' || t === '2hp') return 'pierce';
      if (t === '1hs' || t === '2hs') return 'slash';
      if (t === '1hb' || t === '2hb') return 'crush';
      if (t === 'h2h') return 'punch';
      return 'hit';
    }
    function getSpecialAttackVerb(st) {
      if (st === 'backstab') return 'backstab';
      if (st === 'flying_kick') return 'flying kick';
      if (st === 'kick') return 'kick';
      if (st === 'bash') return 'bash';
      return 'attack';
    }
    const w1Verb = options.captureCombatLog ? getMeleeAttackVerb(options.weapon1Type) : '';
    const w2Verb = options.captureCombatLog ? getMeleeAttackVerb(options.weapon2Type) : '';
    const specialVerb = options.captureCombatLog ? getSpecialAttackVerb(specialType) : '';
    function pushCombatLog(tMs, type, weapon, attackName, hit, damage, logTags) {
      if (!report.combatLog) return;
      var entry = { tMs: tMs, type: type, weapon: weapon, attackName: attackName, hit: hit, damage: damage };
      if (logTags && typeof logTags === 'object') {
        Object.keys(logTags).forEach(function (k) { entry[k] = logTags[k]; });
      }
      report.combatLog.push(entry);
    }
    const w1ProcLevelReq = getProcLevelRequirement(hasMainHand ? w1 : null);
    if (hasMainHand && w1.procSpell != null && w1ProcLevelReq != null && level < w1ProcLevelReq) {
      report.weapon1.procLevelBlocked = true;
      report.weapon1.procLevelRequired = w1ProcLevelReq;
    }
    const w2ProcLevelReq = getProcLevelRequirement(offhandEquipped ? w2 : null);
    if (offhandEquipped && w2.procSpell != null && w2ProcLevelReq != null && level < w2ProcLevelReq) {
      report.weapon2.procLevelBlocked = true;
      report.weapon2.procLevelRequired = w2ProcLevelReq;
    }
    if (hasMainHand && w1.procSpell) {
      report.weapon1.anticipatedProcChancePerRound = procChance1;
      report.weapon1.anticipatedProcsPerMinute = roundsPerMinW1 > 0 ? procChance1 * roundsPerMinW1 : null;
    }
    if (w2HasProc) {
      report.weapon2.anticipatedProcChancePerRound = procChance2;
      report.weapon2.anticipatedProcsPerMinute = roundsPerMinW2 > 0 ? procChance2 * roundsPerMinW2 : null;
    }

    const durationMs = Math.floor(options.fightDurationSec * 1000);
    const procBuffTicks1 = (hasMainHand && w1.procBuffDurationTicks != null && w1.procBuffDurationTicks > 0) ? w1.procBuffDurationTicks : 0;
    const procBuffTicks2 = (offhandEquipped && w2.procBuffDurationTicks != null && w2.procBuffDurationTicks > 0) ? w2.procBuffDurationTicks : 0;
    let lastProcMs1 = 0, dotEndMs1 = 0, perTick1 = 0;
    let lastProcMs2 = 0, dotEndMs2 = 0, perTick2 = 0;
    const duelist = !!(options.duelist && options.classId === 'rogue');
    const innerFlame = !!(options.innerFlame && options.classId === 'monk');
    const duelistPermanent = duelist && !!options.duelistPermanent;
    const innerFlamePermanent = innerFlame && !!options.innerFlamePermanent;
    report.duelistPermanentMode = duelistPermanent;
    report.innerFlamePermanentMode = innerFlamePermanent;
    report.permanentDisciplineMode = duelistPermanent || innerFlamePermanent;
    const BUFF_12S_MS = 12000;
    const duelistStartMs = duelist && !duelistPermanent ? Math.floor(rng() * Math.max(0, durationMs - BUFF_12S_MS)) : 0;
    const duelistEndMs = duelistStartMs + BUFF_12S_MS;
    const innerFlameStartMs = innerFlame && !innerFlamePermanent ? Math.floor(rng() * Math.max(0, durationMs - BUFF_12S_MS)) : 0;
    const innerFlameEndMs = innerFlameStartMs + BUFF_12S_MS;
    function disciplineDuelistActive(tMs) {
      if (!duelist) return false;
      if (duelistPermanent) return true;
      return tMs >= duelistStartMs && tMs < duelistEndMs;
    }
    function disciplineInnerFlameActive(tMs) {
      if (!innerFlame) return false;
      if (innerFlamePermanent) return true;
      return tMs >= innerFlameStartMs && tMs < innerFlameEndMs;
    }
    // SE_DamageModifier[185] for disciplines: Duelist, Inner Flame, etc. Applied to base damage before roll.
    const SE_MELEE_DAMAGE_MOD_DUELIST_INNERFLAME = 100;
    // SE_MinDamageModifier[186] for disciplines: Fellstrike, Innerflame, Duelist, Bestial Rage. Min hit = 4 x weapon damage + 1 x damage bonus.
    const SE_MELEE_MIN_DAMAGE_MOD_DUELIST_INNERFLAME = 400;
    function applyDisciplineDamageMod(baseDamage, disciplineActive) {
      if (!disciplineActive || baseDamage <= 0) return baseDamage;
      return baseDamage + Math.floor(baseDamage * SE_MELEE_DAMAGE_MOD_DUELIST_INNERFLAME / 100);
    }
    function getDisciplineMinHit(baseDamage, damageBonus, disciplineActive) {
      if (!disciplineActive || baseDamage <= 0) return null;
      return Math.floor(baseDamage * SE_MELEE_MIN_DAMAGE_MOD_DUELIST_INNERFLAME / 100) + (damageBonus || 0);
    }
    // Theoretical max hit per weapon — mirrors the exact sim pipeline:
    //   mhBase = cappedDmg + maxElemAdder  (elem adds to base BEFORE D20)
    //   D20=20 → floor((20 * mhBase + 5) / 10)
    //   rollDamageMultiplier max roll (maxExtra at this level)
    //   warrior +1 bonus if level >= 55
    //   + damageBonus
    //   optional crit via applyCritDamage
    const _multParams = getRollDamageMultiplierParams(level, options.classId);
    const _hasCrit = getCritChance(level, options.classId, options.dex || 150, 0, options.critChanceMult || 0, false) > 0;
    // Max possible elemental adder: full elemDamage when target resist ≤ 101 (roll 201-resist can exceed 99).
    function _maxElemAdder(weapon) {
      if (!weapon || !(weapon.elemDamage > 0)) return 0;
      const resist = getResistForElemType(options, weapon.elemType);
      if (resist > 200) return 0;
      const maxRoll = 201 - resist; // highest possible roll value from applyElementalResist
      if (maxRoll > 99) return weapon.elemDamage; // full damage possible
      return Math.floor(weapon.elemDamage * maxRoll / 100);
    }
    function _calcTheoMax(cappedDmg, maxElem, dmgBonus, withDisc, withCrit) {
      let base = cappedDmg + maxElem;
      if (withDisc) base = base + Math.floor(base * SE_MELEE_DAMAGE_MOD_DUELIST_INNERFLAME / 100);
      const d20 = Math.floor((20 * base + 5) / 10);
      let afterMult = _roundMultUp ? Math.ceil(d20 * _multParams.maxExtra / 100) : Math.floor(d20 * _multParams.maxExtra / 100);
      if (level >= 55 && afterMult > 1 && isWarriorClass(options.classId)) afterMult++;
      const dmg = afterMult + dmgBonus;
      return withCrit ? applyCritDamage(dmg, dmgBonus, 17, false, furyDmgBonusPct) : dmg;
    }
    if (hasMainHand) {
      const _e1 = _maxElemAdder(w1);
      report.weapon1.theoreticMaxHitStd      = _calcTheoMax(cappedW1Damage, _e1, mainHandDamageBonus, false, false);
      report.weapon1.theoreticMaxHitCrit     = _hasCrit ? _calcTheoMax(cappedW1Damage, _e1, mainHandDamageBonus, false, true) : null;
      report.weapon1.theoreticMaxHitDisc     = _calcTheoMax(cappedW1Damage, _e1, mainHandDamageBonus, true, false);
      report.weapon1.theoreticMaxHitDiscCrit = _hasCrit ? _calcTheoMax(cappedW1Damage, _e1, mainHandDamageBonus, true, true) : null;
    }
    if (offhandEquipped) {
      const _e2 = _maxElemAdder(w2);
      report.weapon2.theoreticMaxHitStd      = _calcTheoMax(cappedW2Damage, _e2, 0, false, false);
      report.weapon2.theoreticMaxHitCrit     = _hasCrit ? _calcTheoMax(cappedW2Damage, _e2, 0, false, true) : null;
      report.weapon2.theoreticMaxHitDisc     = _calcTheoMax(cappedW2Damage, _e2, 0, true, false);
      report.weapon2.theoreticMaxHitDiscCrit = _hasCrit ? _calcTheoMax(cappedW2Damage, _e2, 0, true, true) : null;
    }
    report.discLabel = duelist ? 'Duelist' : innerFlame ? 'Innerflame' : null;
    report.discEnabled = duelist || innerFlame;
    report.hasCrit = _hasCrit;
    report.furyDmgBonusPct = furyDmgBonusPct;
    // Special attack reuse: base reuse (or user base override) reduced by haste; or user effective override used as-is
    const hasteMod = 1 + (effectiveHastePercent || 0) / 100;
    let effectiveSpecialReuseSec = 0;
    if (specialConfig) {
      if (specialType === 'backstab' && options.backstabReuseEffectiveSec != null && options.backstabReuseEffectiveSec > 0) {
        effectiveSpecialReuseSec = options.backstabReuseEffectiveSec;
      } else if (specialType === 'flying_kick' && options.flyingKickReuseEffectiveSec != null && options.flyingKickReuseEffectiveSec > 0) {
        effectiveSpecialReuseSec = options.flyingKickReuseEffectiveSec;
      } else if (specialType === 'kick' && options.kickReuseEffectiveSec != null && options.kickReuseEffectiveSec > 0) {
        effectiveSpecialReuseSec = options.kickReuseEffectiveSec;
      } else if (specialType === 'bash' && options.bashReuseEffectiveSec != null && options.bashReuseEffectiveSec > 0) {
        effectiveSpecialReuseSec = options.bashReuseEffectiveSec;
      } else {
        const baseSpecialReuseSec = specialType === 'backstab' && options.backstabReuseSec != null && options.backstabReuseSec > 0 ? options.backstabReuseSec
          : (specialType === 'flying_kick' && options.flyingKickReuseSec != null && options.flyingKickReuseSec > 0 ? options.flyingKickReuseSec : null);
        const baseFromConfig = baseSpecialReuseSec != null ? baseSpecialReuseSec : specialConfig.reuseSec;
        effectiveSpecialReuseSec = baseFromConfig > 0 ? baseFromConfig / hasteMod : 0;
      }
    }
    const specialCooldownMs = effectiveSpecialReuseSec * 1000;
    if (report.special) report.special.effectiveReuseSec = effectiveSpecialReuseSec;
    if (report.special && specialConfig && specialConfig.fromBehindOnly && options.classId === 'rogue') {
      const bsSkill = options.backstabSkill != null ? options.backstabSkill : 225;
      const bsModPct = options.backstabModPercent || 0;
      const bsEffectiveSkill = Math.min(252, Math.floor(bsSkill * (100 + bsModPct) / 100));
      report.special.backstabToHit = 7 + OFFENSE_SKILL + bsEffectiveSkill;
      report.special.effectiveBackstabSkillReport = bsEffectiveSkill;
    }
    let nextSwing1Ms = hasMainHand ? 0 : Infinity;
    let nextSwing2Ms = dualWielding && offhandEquipped ? rng() * delay2Ms : Infinity;
    let nextSpecialAtMs = (canFireSpecial && report.special) ? 0 : Infinity;
    let mainHandRoundCounter = 0;
    let offhandRoundCounter = 0;
    // Monk fistweaving / 2H weave: every mainhand round, attempt a weave after reaction delay.
      // The weave is gated on: (1) offhand cooldown ready at weave time, (2) dual wield check.
      // Each DW check is one "weave attempt"; successes are "rounds".
    const fistweavingReactionDelayMs = (() => {
      const v = options.fistweavingReactionDelayMs != null ? parseInt(options.fistweavingReactionDelayMs, 10) : 200;
      if (isNaN(v)) return 200;
      return Math.max(0, Math.min(1000, v));
    })();
    const fistweavingOffhandDelayDecisec = (twoHandWeaveMode || fistweaveNonEpicOhMode) ? w2.delay
      : (options.fistweavingNonEpic ? 27 : 16); // equipped weapon: use weapon delay; bare fists: epic=16, non-epic=27
    const fistweavingOffhandDelayMs = report.fistweaving
      ? effectiveDelayMs(fistweavingOffhandDelayDecisec, effectiveHastePercent)
      : Infinity;
    let fistweavingOffhandReadyAtMs = 0; // offhand cooldown completion time
    let fistweavingClippedDueToOffhandNotReady = 0;
    if (report.fistweaving) {
      report.fistweaving.reactionDelayMs = fistweavingReactionDelayMs;
      report.fistweaving.offhandSwingDelayMs = fistweavingOffhandDelayMs;
      report.fistweaving.offhandSwingDelayDecisec = fistweavingOffhandDelayDecisec;
      report.fistweaving.mainhandSwingDelayMs = delay1Ms;
      report.fistweaving.clippedDueToOffhandNotReady = 0;
    }

    // Event-driven loop: timers in ms. Each swing: (1) AvoidanceCheck: rollHit(toHit, avoidance) → hit or miss. (2) If hit: CalcMeleeDamage uses RollD20(offense, mitigation) → damage.
    while (true) {
      const tMs = Math.min(
        nextSpecialAtMs,
        nextSwing1Ms,
        dualWielding ? nextSwing2Ms : Infinity,
        durationMs
      );
      if (tMs >= durationMs) break;

      // Special attack (Flying Kick / Backstab) on cooldown
      if (canFireSpecial && report.special && tMs >= nextSpecialAtMs) {
        report.special.attempts++;
        const isRogueBackstab = specialConfig.fromBehindOnly === true;
        const backstabSkill = options.backstabSkill != null ? options.backstabSkill : 225;
        const backstabModPct = options.backstabModPercent || 0;
        const backstabEffectiveSkill = Math.min(252, Math.floor(backstabSkill * (100 + backstabModPct) / 100));
        // GetToHit(skill): toHit = 7 + Offense SKILL + effective backstab skill (weapon mod applied, capped at 252).
        const backstabToHit = isRogueBackstab ? (7 + OFFENSE_SKILL + backstabEffectiveSkill) : toHit;

        // Backstab: do double attack check first. If it fails → single backstab (one to-hit roll). If it succeeds → double backstab (normal + bonus attempt, two to-hit rolls).
        const isDoubleBackstabRound = isRogueBackstab && options.classId === 'rogue' && level > 54 && report.special.doubleBackstabs !== undefined && checkDoubleAttack(doubleAttackEffective, specialRng, options.classId);
        const numBackstabRolls = isDoubleBackstabRound ? 2 : 1;
        if (isDoubleBackstabRound) report.special.doubleBackstabs++;

        function processOneBackstabHit(backstabAttemptNumber) {
          if (report.special.attemptedAttacks !== undefined) report.special.attemptedAttacks++;
          addSwingThreatMH();
          const specialHits = rollHit(backstabToHit, avoidance, specialRng, frontAvoidChance);
          if (!specialHits) {
            pushCombatLog(tMs, 'special', 'special', specialVerb, false, undefined, { bsDA: isDoubleBackstabRound && backstabAttemptNumber === 2 });
            return;
          }
          report.special.hits++;
          report.special.count++;
          let baseDmg;
          let backstabDisciplineMinHit = null;
          let duelistBackstabRound = false;
          const specElemAdder = (specialConfig.useWeaponDamage === false) ? 0 : getElementalBaseAdder(w1, options, elemRng);
          if (specElemAdder > 0) report.elementalDamageTotal += specElemAdder;
          // specialOffenseRating: for backstab, server GetOffense(SkillBackstab) uses backstab skill — not the normal offense/weapon skill.
          let specialOffenseRating = offenseRating;
          if (isRogueBackstab) {
            const backstabOffenseRating = backstabEffectiveSkill + strBonus + wornAttack + spellAttack;
            specialOffenseRating = backstabOffenseRating;
            const backstabBaseRaw = Math.floor(((backstabEffectiveSkill * 0.02) + 2) * cappedW1Damage) + specElemAdder;
            duelistBackstabRound = disciplineDuelistActive(tMs);
            backstabDisciplineMinHit = getDisciplineMinHit(backstabBaseRaw, 0, duelistBackstabRound);
            let backstabBase = applyDisciplineDamageMod(backstabBaseRaw, duelistBackstabRound);
            baseDmg = calcMeleeDamage(backstabBase, backstabOffenseRating, mitigation, specialRng, 0);
            baseDmg = Math.max(1, baseDmg);
          } else if (specialConfig.useWeaponDamage === false && specialConfig.skillBaseDamage != null) {
            const skillBase = specialConfig.skillBaseDamage;
            baseDmg = calcMeleeDamage(skillBase, offenseRating, mitigation, specialRng, 0);
            if (specialConfig.minDamageFormula === 'level*4/5') {
              const fkMin = Math.floor(level * 4 / 5);
              baseDmg = Math.max(1, Math.max(baseDmg, fkMin));
            } else {
              baseDmg = Math.max(1, baseDmg);
            }
          } else {
            baseDmg = calcMeleeDamage(cappedW1Damage + specElemAdder, offenseRating, mitigation, specialRng);
            baseDmg = Math.max(1, specialConfig.damageMultiplier ? Math.floor(baseDmg * specialConfig.damageMultiplier) : baseDmg);
          }
          const mult = rollDamageMultiplier(specialOffenseRating, baseDmg, level, options.classId, false, specialRng);
          let dmg = mult.damage;
          const beforeCrit = dmg;
          const critResult = rollMeleeCrit(dmg, 0, level, options.classId, options.dex, options.critChanceMult, false, false, 0, options.critDmgDebugDmgBonus, specialRng, furyDmgBonusPct);
          dmg = critResult.damage;
          if (critResult.isCrit) { report.critHits++; report.critDamageGain += (dmg - beforeCrit); }
          if (isRogueBackstab && level != null) {
            const minHit = level >= 60 ? level * 2 : level > 50 ? Math.floor(level * 3 / 2) : level;
            dmg = Math.max(dmg, minHit);
          }
          if (backstabDisciplineMinHit != null && dmg < backstabDisciplineMinHit) dmg = backstabDisciplineMinHit;
          if (FENCEPOSTBACKSTABDEBUG && duelistBackstabRound) dmg += 1;
          if (w1.noDamageVsTarget) { if (specElemAdder > 0) report.elementalDamageTotal -= specElemAdder; dmg = 0; }
          report.special.totalDamage += dmg;
          report.special.maxDamage = Math.max(report.special.maxDamage, dmg);
          report.special.hitList.push(dmg);
          report.weapon1.totalDamage += dmg;
          report.totalDamage += dmg;
          pushCombatLog(tMs, 'special', 'special', specialVerb, true, dmg, { bsDA: isDoubleBackstabRound && backstabAttemptNumber === 2, isCrit: critResult.isCrit });
        }

        if (report.masterWu) {
          // Snapshot special totals before the base FK fires so we can isolate FK-only damage
          const _fkHitsBefore = report.special.hits;
          const _fkDmgBefore  = report.special.totalDamage;
          for (let r = 0; r < numBackstabRolls; r++) processOneBackstabHit(r + 1);
          report.masterWu.fkHits   += report.special.hits         - _fkHitsBefore;
          report.masterWu.fkDamage += report.special.totalDamage  - _fkDmgBefore;
        } else {
          for (let r = 0; r < numBackstabRolls; r++) processOneBackstabHit(r + 1);
        }

        // Technique of Master Wu (EQMacEmu special_attacks.cpp):
        //   Roll wuChance% → if pass, fire 1 extra random monk strike (Flying Kick / Eagle Strike / Tiger Claw / Round Kick).
        //   Also roll wuChance/4% (independent) → if pass, fire 1 additional extra strike.
        //   fromWus=true on extra strikes prevents recursion.
        if (specialType === 'flying_kick' && masterWuRank > 0) {
          const wuChance = masterWuRank * 10; // integer percent: 10/20/30/40/50 at ranks 1-5

          function doMonkWuStrike(wuSkillCfg) {
            const skillEntry = report.masterWu.bySkill[wuSkillCfg.name];
            if (skillEntry) skillEntry.attempts++;
            report.masterWu.extraAttempts++;
            addSwingThreatMH();
            if (!rollHit(toHit, avoidance, specialRng, frontAvoidChance)) {
              pushCombatLog(tMs, 'special', 'special', wuSkillCfg.name, false, undefined, { wu: true });
              return;
            }
            let baseDmg = calcMeleeDamage(wuSkillCfg.skillBaseDamage, offenseRating, mitigation, specialRng, 0);
            if (wuSkillCfg.minDamageFormula === 'level*4/5') {
              baseDmg = Math.max(1, Math.max(baseDmg, Math.floor(level * 4 / 5)));
            } else {
              baseDmg = Math.max(1, baseDmg);
            }
            const mult = rollDamageMultiplier(offenseRating, baseDmg, level, options.classId, false, specialRng);
            let dmg = mult.damage;
            const beforeCrit = dmg;
            const critResult = rollMeleeCrit(dmg, 0, level, options.classId, options.dex, options.critChanceMult, false, false, 0, options.critDmgDebugDmgBonus, specialRng, furyDmgBonusPct);
            dmg = critResult.damage;
            if (critResult.isCrit) { report.critHits++; report.critDamageGain += (dmg - beforeCrit); }
            if (w1.noDamageVsTarget) { dmg = 0; }
            if (skillEntry) { skillEntry.hits++; skillEntry.damage += dmg; }
            report.masterWu.extraHits++;
            report.masterWu.totalDamage += dmg;
            report.special.hits++;
            report.special.count++;
            report.special.totalDamage += dmg;
            report.special.maxDamage = Math.max(report.special.maxDamage, dmg);
            report.special.hitList.push(dmg);
            report.weapon1.totalDamage += dmg;
            report.totalDamage += dmg;
            pushCombatLog(tMs, 'special', 'special', wuSkillCfg.name, true, dmg, { wu: true, isCrit: critResult.isCrit });
          }

          report.masterWu.mainRolls++;
          if (wuChance >= 100 || specialRng() * 100 < wuChance) {
            report.masterWu.triggered++;
            let extra = 1;
            if (specialRng() * 100 < wuChance / 4) extra++;
            while (extra > 0) {
              doMonkWuStrike(WU_MONK_SKILLS[Math.floor(specialRng() * 4)]);
              extra--;
            }
          }
        }

        nextSpecialAtMs = tMs + specialCooldownMs;
      }

      // Main hand (one round = one swing opportunity; 1, 2, or 3 attacks per round)
      if (tMs >= nextSwing1Ms) {
        const duelistThisRound = disciplineDuelistActive(tMs);
        const innerFlameThisRound = disciplineInnerFlameActive(tMs);
        const disciplineActiveMh = duelistThisRound || innerFlameThisRound;

        report.weapon1.rounds++;
        nextSwing1Ms = tMs + delay1Ms;
        mainHandRoundCounter++;
        const mhRoundLetter = (mainHandRoundCounter % 2 === 1) ? 'A' : 'B';
        let attacksThisRound = 1;

        // Crit is only rolled after a successful hit (we are inside the rollHit success block).
        if (rollHit(toHit, avoidance, rng, frontAvoidChance)) {
          const mhElemAdder = getElementalBaseAdder(w1, options, elemRng);
          report.elementalDamageTotal += mhElemAdder;
          let mhBase = cappedW1Damage + mhElemAdder;
          mhBase = applyDisciplineDamageMod(mhBase, disciplineActiveMh);
          let dmg = calcMeleeDamage(mhBase, offenseRating, mitigation, rng, 0);
          const mult = rollDamageMultiplier(offenseRating, dmg, level, options.classId, false, rng);
          dmg = mult.damage;
          dmg += mainHandDamageBonus;
          dmg = Math.max(dmg, 1 + mainHandDamageBonus);
          let _swingIsCrit1 = false;
          const slayResult1 = trySlayUndead(dmg, mainHandDamageBonus, 1, options, rng);
          if (slayResult1) {
            dmg = slayResult1.damage;
            report.weapon1.slayUndeadHits++;
            report.weapon1.slayUndeadDamageTotal += dmg;
            report.weapon1.maxSlayUndeadHit = Math.max(report.weapon1.maxSlayUndeadHit || 0, dmg);
          } else {
            const beforeCrit = dmg;
            const critResult = rollMeleeCrit(dmg, mainHandDamageBonus, level, options.classId, options.dex, options.critChanceMult, false, false, 0, options.critDmgDebugDmgBonus, rng, furyDmgBonusPct);
            dmg = critResult.damage;
            dmg = Math.max(dmg, 1 + mainHandDamageBonus);
            if (critResult.isCrit) { _swingIsCrit1 = true; report.critHits++; report.critDamageGain += (dmg - beforeCrit); }
          }
          const mhDisciplineMin = getDisciplineMinHit(cappedW1Damage, mainHandDamageBonus, disciplineActiveMh);
          if (mhDisciplineMin != null && dmg < mhDisciplineMin) dmg = mhDisciplineMin;
          if (w1.noDamageVsTarget) { report.elementalDamageTotal -= mhElemAdder; dmg = 0; }
          report.weapon1.swings++; addSwingThreatMH();
          report.weapon1.hits++;
          report.weapon1.totalDamage += dmg;
          report.weapon1.maxDamage = Math.max(report.weapon1.maxDamage, dmg);
          report.weapon1.minDamage = Math.min(report.weapon1.minDamage, dmg);
          report.weapon1.hitList.push(dmg);
          report.totalDamage += dmg;
          report.damageBonusTotal += mainHandDamageBonus;
          pushCombatLog(tMs, 'melee', 1, w1Verb, true, dmg, { roundLetter: mhRoundLetter, attemptNumber: 1, swingKind: 'BA', isCrit: _swingIsCrit1 });
        } else {
          report.weapon1.swings++; addSwingThreatMH();
          pushCombatLog(tMs, 'melee', 1, w1Verb, false, undefined, { roundLetter: mhRoundLetter, attemptNumber: 1, swingKind: 'BA' });
        }

        if (checkDoubleAttack(doubleAttackEffective, rng, options.classId) || (aaFlatDaChance > 0 && rng() < aaFlatDaChance)) {
          attacksThisRound = 2;
          if (rollHit(toHit, avoidance, rng, frontAvoidChance)) {
            const mhElemAdder2 = getElementalBaseAdder(w1, options, elemRng);
            report.elementalDamageTotal += mhElemAdder2;
            let mhBase2 = cappedW1Damage + mhElemAdder2;
            mhBase2 = applyDisciplineDamageMod(mhBase2, disciplineActiveMh);
            let dmg = calcMeleeDamage(mhBase2, offenseRating, mitigation, rng, 0);
            const mult = rollDamageMultiplier(offenseRating, dmg, level, options.classId, false, rng);
            dmg = mult.damage;
            dmg += mainHandDamageBonus;
            dmg = Math.max(dmg, 1 + mainHandDamageBonus);
            let _swingIsCrit2 = false;
            const slayResult2 = trySlayUndead(dmg, mainHandDamageBonus, 1, options, rng);
            if (slayResult2) {
              dmg = slayResult2.damage;
              report.weapon1.slayUndeadHits++;
              report.weapon1.slayUndeadDamageTotal += dmg;
              report.weapon1.maxSlayUndeadHit = Math.max(report.weapon1.maxSlayUndeadHit || 0, dmg);
            } else {
              const beforeCrit = dmg;
              const critResult = rollMeleeCrit(dmg, mainHandDamageBonus, level, options.classId, options.dex, options.critChanceMult, false, false, 0, options.critDmgDebugDmgBonus, rng, furyDmgBonusPct);
              dmg = critResult.damage;
              dmg = Math.max(dmg, 1 + mainHandDamageBonus);
              if (critResult.isCrit) { _swingIsCrit2 = true; report.critHits++; report.critDamageGain += (dmg - beforeCrit); }
            }
            const mhDisciplineMin2 = getDisciplineMinHit(cappedW1Damage, mainHandDamageBonus, disciplineActiveMh);
            if (mhDisciplineMin2 != null && dmg < mhDisciplineMin2) dmg = mhDisciplineMin2;
            if (w1.noDamageVsTarget) { report.elementalDamageTotal -= mhElemAdder2; dmg = 0; }
            report.weapon1.swings++; addSwingThreatMH();
            report.weapon1.hits++;
            report.weapon1.totalDamage += dmg;
            report.weapon1.maxDamage = Math.max(report.weapon1.maxDamage, dmg);
            report.weapon1.minDamage = Math.min(report.weapon1.minDamage, dmg);
            report.weapon1.hitList.push(dmg);
            report.totalDamage += dmg;
            report.damageBonusTotal += mainHandDamageBonus;
            pushCombatLog(tMs, 'melee', 1, w1Verb, true, dmg, { roundLetter: mhRoundLetter, attemptNumber: 2, swingKind: 'DA', isCrit: _swingIsCrit2 });
          } else {
            report.weapon1.swings++; addSwingThreatMH();
            pushCombatLog(tMs, 'melee', 1, w1Verb, false, undefined, { roundLetter: mhRoundLetter, attemptNumber: 2, swingKind: 'DA' });
          }
          if (checkTripleAttack(rng, level, options.classId)) {
            attacksThisRound = 3;
            if (rollHit(toHit, avoidance, rng, frontAvoidChance)) {
              const mhElemAdder3 = getElementalBaseAdder(w1, options, elemRng);
              report.elementalDamageTotal += mhElemAdder3;
              let mhBase3 = cappedW1Damage + mhElemAdder3;
              mhBase3 = applyDisciplineDamageMod(mhBase3, disciplineActiveMh);
              let dmg = calcMeleeDamage(mhBase3, offenseRating, mitigation, rng, 0);
              const mult = rollDamageMultiplier(offenseRating, dmg, level, options.classId, false, rng);
              dmg = mult.damage;
              dmg += mainHandDamageBonus;
              dmg = Math.max(dmg, 1 + mainHandDamageBonus);
              let _swingIsCrit3 = false;
              const slayResult3 = trySlayUndead(dmg, mainHandDamageBonus, 1, options, rng);
              if (slayResult3) {
                dmg = slayResult3.damage;
                report.weapon1.slayUndeadHits++;
                report.weapon1.slayUndeadDamageTotal += dmg;
                report.weapon1.maxSlayUndeadHit = Math.max(report.weapon1.maxSlayUndeadHit || 0, dmg);
              } else {
                const beforeCrit = dmg;
                const critResult = rollMeleeCrit(dmg, mainHandDamageBonus, level, options.classId, options.dex, options.critChanceMult, false, false, 0, options.critDmgDebugDmgBonus, rng, furyDmgBonusPct);
                dmg = critResult.damage;
                dmg = Math.max(dmg, 1 + mainHandDamageBonus);
                if (critResult.isCrit) { _swingIsCrit3 = true; report.critHits++; report.critDamageGain += (dmg - beforeCrit); }
              }
              const mhDisciplineMin3 = getDisciplineMinHit(cappedW1Damage, mainHandDamageBonus, disciplineActiveMh);
              if (mhDisciplineMin3 != null && dmg < mhDisciplineMin3) dmg = mhDisciplineMin3;
              if (w1.noDamageVsTarget) { report.elementalDamageTotal -= mhElemAdder3; dmg = 0; }
              report.weapon1.swings++; addSwingThreatMH();
              report.weapon1.hits++;
              report.weapon1.totalDamage += dmg;
              report.weapon1.maxDamage = Math.max(report.weapon1.maxDamage, dmg);
              report.weapon1.minDamage = Math.min(report.weapon1.minDamage, dmg);
              report.weapon1.hitList.push(dmg);
              report.totalDamage += dmg;
              report.damageBonusTotal += mainHandDamageBonus;
              pushCombatLog(tMs, 'melee', 1, w1Verb, true, dmg, { roundLetter: mhRoundLetter, attemptNumber: 3, swingKind: 'TA', isCrit: _swingIsCrit3 });
            } else {
              report.weapon1.swings++; addSwingThreatMH();
              pushCombatLog(tMs, 'melee', 1, w1Verb, false, undefined, { roundLetter: mhRoundLetter, attemptNumber: 3, swingKind: 'TA' });
            }
            // Flurry: extra swing after successful triple (warrior/monk Luclin AA)
            if (flurryRank > 0 && checkFlurry(flurryRank, level, (options.classId || '').toLowerCase(), rng)) {
              attacksThisRound = 4;
              if (report.weapon1.flurry != null) report.weapon1.flurry++;
              if (rollHit(toHit, avoidance, rng, frontAvoidChance)) {
                const mhElemAdder4 = getElementalBaseAdder(w1, options, elemRng);
                report.elementalDamageTotal += mhElemAdder4;
                let mhBase4 = cappedW1Damage + mhElemAdder4;
                mhBase4 = applyDisciplineDamageMod(mhBase4, disciplineActiveMh);
                let dmg = calcMeleeDamage(mhBase4, offenseRating, mitigation, rng, 0);
                const mult = rollDamageMultiplier(offenseRating, dmg, level, options.classId, false, rng);
                dmg = mult.damage;
                dmg += mainHandDamageBonus;
                dmg = Math.max(dmg, 1 + mainHandDamageBonus);
                let _swingIsCritF = false;
                const slayResultF = trySlayUndead(dmg, mainHandDamageBonus, 1, options, rng);
                if (slayResultF) {
                  dmg = slayResultF.damage;
                  report.weapon1.slayUndeadHits++;
                  report.weapon1.slayUndeadDamageTotal += dmg;
                  report.weapon1.maxSlayUndeadHit = Math.max(report.weapon1.maxSlayUndeadHit || 0, dmg);
                } else {
                  const beforeCrit = dmg;
                  const critResult = rollMeleeCrit(dmg, mainHandDamageBonus, level, options.classId, options.dex, options.critChanceMult, false, false, 0, options.critDmgDebugDmgBonus, rng, furyDmgBonusPct);
                  dmg = critResult.damage;
                  dmg = Math.max(dmg, 1 + mainHandDamageBonus);
                  if (critResult.isCrit) { _swingIsCritF = true; report.critHits++; report.critDamageGain += (dmg - beforeCrit); }
                }
                const mhDisciplineMinF = getDisciplineMinHit(cappedW1Damage, mainHandDamageBonus, disciplineActiveMh);
                if (mhDisciplineMinF != null && dmg < mhDisciplineMinF) dmg = mhDisciplineMinF;
                if (w1.noDamageVsTarget) { report.elementalDamageTotal -= mhElemAdder4; dmg = 0; }
                report.weapon1.swings++; addSwingThreatMH();
                report.weapon1.hits++;
                report.weapon1.totalDamage += dmg;
                report.weapon1.maxDamage = Math.max(report.weapon1.maxDamage, dmg);
                report.weapon1.minDamage = Math.min(report.weapon1.minDamage, dmg);
                report.weapon1.hitList.push(dmg);
                report.totalDamage += dmg;
                report.damageBonusTotal += mainHandDamageBonus;
                pushCombatLog(tMs, 'melee', 1, w1Verb, true, dmg, { roundLetter: mhRoundLetter, attemptNumber: 4, swingKind: 'FL', isCrit: _swingIsCritF });
              } else {
                report.weapon1.swings++; addSwingThreatMH();
                pushCombatLog(tMs, 'melee', 1, w1Verb, false, undefined, { roundLetter: mhRoundLetter, attemptNumber: 4, swingKind: 'FL' });
              }
            }
            // Raging Flurry (warrior PoP AA): additional flurry chance on successful triple attack
            if (ragingFlurryChance > 0 && (options.classId || '').toLowerCase() === 'warrior' && level >= 60 && rng() < ragingFlurryChance) {
              report.weapon1.ragingFlurry++;
              if (rollHit(toHit, avoidance, rng, frontAvoidChance)) {
                const mhElemAdderRF = getElementalBaseAdder(w1, options, elemRng);
                report.elementalDamageTotal += mhElemAdderRF;
                let mhBaseRF = cappedW1Damage + mhElemAdderRF;
                mhBaseRF = applyDisciplineDamageMod(mhBaseRF, disciplineActiveMh);
                let dmg = calcMeleeDamage(mhBaseRF, offenseRating, mitigation, rng, 0);
                const mult = rollDamageMultiplier(offenseRating, dmg, level, options.classId, false, rng);
                dmg = mult.damage;
                dmg += mainHandDamageBonus;
                dmg = Math.max(dmg, 1 + mainHandDamageBonus);
                let _swingIsCritRF = false;
                const slayResultRF = trySlayUndead(dmg, mainHandDamageBonus, 1, options, rng);
                if (slayResultRF) {
                  dmg = slayResultRF.damage;
                  report.weapon1.slayUndeadHits++;
                  report.weapon1.slayUndeadDamageTotal += dmg;
                  report.weapon1.maxSlayUndeadHit = Math.max(report.weapon1.maxSlayUndeadHit || 0, dmg);
                } else {
                  const beforeCrit = dmg;
                  const critResult = rollMeleeCrit(dmg, mainHandDamageBonus, level, options.classId, options.dex, options.critChanceMult, false, false, 0, options.critDmgDebugDmgBonus, rng, furyDmgBonusPct);
                  dmg = critResult.damage;
                  dmg = Math.max(dmg, 1 + mainHandDamageBonus);
                  if (critResult.isCrit) { _swingIsCritRF = true; report.critHits++; report.critDamageGain += (dmg - beforeCrit); }
                }
                const mhDisciplineMinRF = getDisciplineMinHit(cappedW1Damage, mainHandDamageBonus, disciplineActiveMh);
                if (mhDisciplineMinRF != null && dmg < mhDisciplineMinRF) dmg = mhDisciplineMinRF;
                if (w1.noDamageVsTarget) { report.elementalDamageTotal -= mhElemAdderRF; dmg = 0; }
                report.weapon1.swings++; addSwingThreatMH();
                report.weapon1.hits++;
                report.weapon1.totalDamage += dmg;
                report.weapon1.maxDamage = Math.max(report.weapon1.maxDamage, dmg);
                report.weapon1.minDamage = Math.min(report.weapon1.minDamage, dmg);
                report.weapon1.hitList.push(dmg);
                report.totalDamage += dmg;
                report.damageBonusTotal += mainHandDamageBonus;
                pushCombatLog(tMs, 'melee', 1, w1Verb, true, dmg, { roundLetter: mhRoundLetter, attemptNumber: 5, swingKind: 'RF', isCrit: _swingIsCritRF });
              } else {
                report.weapon1.swings++; addSwingThreatMH();
                pushCombatLog(tMs, 'melee', 1, w1Verb, false, undefined, { roundLetter: mhRoundLetter, attemptNumber: 5, swingKind: 'RF' });
              }
            }
          }

          // Punishing Blade AA (warrior/ranger/monk PoP): extra primary attack after double attack, 2H only
          // Mirrors EQMacEmu client_process.cpp: fires after triple/flurry, inside CheckDoubleAttack block
          if (punishingBladeChance > 0 && w1.is2H && rng() * 100 < punishingBladeChance) {
            if (report.weapon1.punishingBlade != null) report.weapon1.punishingBlade++;
            if (rollHit(toHit, avoidance, rng, frontAvoidChance)) {
              const mhElemAdderPB = getElementalBaseAdder(w1, options, elemRng);
              report.elementalDamageTotal += mhElemAdderPB;
              let mhBasePB = cappedW1Damage + mhElemAdderPB;
              mhBasePB = applyDisciplineDamageMod(mhBasePB, disciplineActiveMh);
              let dmg = calcMeleeDamage(mhBasePB, offenseRating, mitigation, rng, 0);
              const mult = rollDamageMultiplier(offenseRating, dmg, level, options.classId, false, rng);
              dmg = mult.damage;
              dmg += mainHandDamageBonus;
              dmg = Math.max(dmg, 1 + mainHandDamageBonus);
              let _swingIsCritPB = false;
              const slayResultPB = trySlayUndead(dmg, mainHandDamageBonus, 1, options, rng);
              if (slayResultPB) {
                dmg = slayResultPB.damage;
                report.weapon1.slayUndeadHits++;
                report.weapon1.slayUndeadDamageTotal += dmg;
                report.weapon1.maxSlayUndeadHit = Math.max(report.weapon1.maxSlayUndeadHit || 0, dmg);
              } else {
                const beforeCrit = dmg;
                const critResult = rollMeleeCrit(dmg, mainHandDamageBonus, level, options.classId, options.dex, options.critChanceMult, false, false, 0, options.critDmgDebugDmgBonus, rng, furyDmgBonusPct);
                dmg = critResult.damage;
                dmg = Math.max(dmg, 1 + mainHandDamageBonus);
                if (critResult.isCrit) { _swingIsCritPB = true; report.critHits++; report.critDamageGain += (dmg - beforeCrit); }
              }
              const mhDisciplineMinPB = getDisciplineMinHit(cappedW1Damage, mainHandDamageBonus, disciplineActiveMh);
              if (mhDisciplineMinPB != null && dmg < mhDisciplineMinPB) dmg = mhDisciplineMinPB;
              if (w1.noDamageVsTarget) { report.elementalDamageTotal -= mhElemAdderPB; dmg = 0; }
              report.weapon1.swings++; addSwingThreatMH();
              report.weapon1.hits++;
              report.weapon1.totalDamage += dmg;
              report.weapon1.maxDamage = Math.max(report.weapon1.maxDamage, dmg);
              report.weapon1.minDamage = Math.min(report.weapon1.minDamage, dmg);
              report.weapon1.hitList.push(dmg);
              report.totalDamage += dmg;
              report.damageBonusTotal += mainHandDamageBonus;
              pushCombatLog(tMs, 'melee', 1, w1Verb, true, dmg, { roundLetter: mhRoundLetter, attemptNumber: 5, swingKind: 'PB', isCrit: _swingIsCritPB });
            } else {
              report.weapon1.swings++; addSwingThreatMH();
              pushCombatLog(tMs, 'melee', 1, w1Verb, false, undefined, { roundLetter: mhRoundLetter, attemptNumber: 5, swingKind: 'PB' });
            }
          }
          // Speed of the Knight (paladin/shadowknight PoP AA): extra 2H primary attack after double attack
          if (speedOfTheKnightChance > 0 && w1.is2H && rng() * 100 < speedOfTheKnightChance) {
            report.weapon1.speedOfTheKnight++;
            if (rollHit(toHit, avoidance, rng, frontAvoidChance)) {
              const mhElemAdderSK = getElementalBaseAdder(w1, options, elemRng);
              report.elementalDamageTotal += mhElemAdderSK;
              let mhBaseSK = cappedW1Damage + mhElemAdderSK;
              mhBaseSK = applyDisciplineDamageMod(mhBaseSK, disciplineActiveMh);
              let dmg = calcMeleeDamage(mhBaseSK, offenseRating, mitigation, rng, 0);
              const mult = rollDamageMultiplier(offenseRating, dmg, level, options.classId, false, rng);
              dmg = mult.damage;
              dmg += mainHandDamageBonus;
              dmg = Math.max(dmg, 1 + mainHandDamageBonus);
              let _swingIsCritSK = false;
              const slayResultSK = trySlayUndead(dmg, mainHandDamageBonus, 1, options, rng);
              if (slayResultSK) {
                dmg = slayResultSK.damage;
                report.weapon1.slayUndeadHits++;
                report.weapon1.slayUndeadDamageTotal += dmg;
                report.weapon1.maxSlayUndeadHit = Math.max(report.weapon1.maxSlayUndeadHit || 0, dmg);
              } else {
                const beforeCrit = dmg;
                const critResult = rollMeleeCrit(dmg, mainHandDamageBonus, level, options.classId, options.dex, options.critChanceMult, false, false, 0, options.critDmgDebugDmgBonus, rng, furyDmgBonusPct);
                dmg = critResult.damage;
                dmg = Math.max(dmg, 1 + mainHandDamageBonus);
                if (critResult.isCrit) { _swingIsCritSK = true; report.critHits++; report.critDamageGain += (dmg - beforeCrit); }
              }
              const mhDisciplineMinSK = getDisciplineMinHit(cappedW1Damage, mainHandDamageBonus, disciplineActiveMh);
              if (mhDisciplineMinSK != null && dmg < mhDisciplineMinSK) dmg = mhDisciplineMinSK;
              if (w1.noDamageVsTarget) { report.elementalDamageTotal -= mhElemAdderSK; dmg = 0; }
              report.weapon1.swings++; addSwingThreatMH();
              report.weapon1.hits++;
              report.weapon1.totalDamage += dmg;
              report.weapon1.maxDamage = Math.max(report.weapon1.maxDamage, dmg);
              report.weapon1.minDamage = Math.min(report.weapon1.minDamage, dmg);
              report.weapon1.hitList.push(dmg);
              report.totalDamage += dmg;
              report.damageBonusTotal += mainHandDamageBonus;
              pushCombatLog(tMs, 'melee', 1, w1Verb, true, dmg, { roundLetter: mhRoundLetter, attemptNumber: 6, swingKind: 'SK', isCrit: _swingIsCritSK });
            } else {
              report.weapon1.swings++; addSwingThreatMH();
              pushCombatLog(tMs, 'melee', 1, w1Verb, false, undefined, { roundLetter: mhRoundLetter, attemptNumber: 6, swingKind: 'SK' });
            }
          }
        }

        // Proc once per round (only if at least one hit landed)
        if (procChance1 > 0 && checkProc(procChance1, procRng) && canProcLandOnTarget(w1, options)) {
          report.weapon1.procs++;
          const procDmg = w1.noDamageVsTarget ? 0 : Math.floor(((w1.procSpellDamage != null ? w1.procSpellDamage : 0) | 0) * soulAbrasionProcMult);
          const effectiveness = getProcSpellEffectiveness(w1, options, level, procRng);
          if (procBuffTicks1 > 0 && procDmg > 0) {
            perTick1 = (procDmg / procBuffTicks1) * effectiveness / 100;
            const basePerTickThreat1 = procBuffTicks1 > 0 ? procDmg / procBuffTicks1 : 0;
            if (dotEndMs1 > lastProcMs1) {
              const ticksRan = Math.floor((Math.min(dotEndMs1, tMs) - lastProcMs1) / PROC_TICK_INTERVAL_MS);
              const dotDmg = Math.floor(ticksRan * perTick1);
              const threatDot = Math.floor(ticksRan * basePerTickThreat1);
              if (dotDmg > 0) {
                report.weapon1.procDamageTotal += dotDmg;
                report.totalDamage += dotDmg;
                addProcThreatAmt(threatDot, 1, false, false);
              }
            }
            lastProcMs1 = tMs;
            dotEndMs1 = tMs + procBuffTicks1 * PROC_TICK_INTERVAL_MS;
            const totalDoTDamage = Math.floor(procDmg * effectiveness / 100);
            if (totalDoTDamage === 0) {
              report.weapon1.procFullResists++;
              report.weapon1.procResists++;
              report.weapon1.procResistDamageLost += procDmg;
            } else if (totalDoTDamage < procDmg) {
              report.weapon1.procPartialResists++;
              report.weapon1.procResists++;
              report.weapon1.procResistDamageLost += (procDmg - totalDoTDamage);
            }
          } else if (w1.procSpellNonDamagingDetrimental) {
            if (effectiveness === 0) {
              report.weapon1.procFullResists++;
              report.weapon1.procResists++;
            } else if (effectiveness < 100) {
              report.weapon1.procPartialResists++;
              report.weapon1.procResists++;
            }
            if (effectiveness > 0) addProcThreatAmt(0, 1, true, true);
          } else {
            let actualDmg = Math.floor(procDmg * effectiveness / 100);
            const scfResult1 = applySpellCastingFuryProc(actualDmg, options, procRng);
            actualDmg = scfResult1.damage;
            if (scfResult1.isCrit) {
              report.weapon1.spellProcCrits++;
              report.weapon1.maxSpellProcCritDmg = Math.max(report.weapon1.maxSpellProcCritDmg || 0, actualDmg);
            }
            report.weapon1.procDamageTotal += actualDmg;
            report.totalDamage += actualDmg;
            if (procDmg > 0) {
              addProcThreatAmt(procDmg, 1, true, false);
            } else if (effectiveness > 0) {
              addProcThreatAmt(0, 1, true, false);
            }
            if (procDmg > 0) {
              if (actualDmg === 0) {
                report.weapon1.procFullResists++;
                report.weapon1.procResists++;
                report.weapon1.procResistDamageLost += procDmg;
              } else if (actualDmg < procDmg) {
                report.weapon1.procPartialResists++;
                report.weapon1.procResists++;
                report.weapon1.procResistDamageLost += (procDmg - actualDmg);
              }
            } else {
              if (effectiveness === 0) {
                report.weapon1.procFullResists++;
                report.weapon1.procResists++;
              } else if (effectiveness < 100) {
                report.weapon1.procPartialResists++;
                report.weapon1.procResists++;
              }
            }
          }
        }

        if (attacksThisRound === 1) report.weapon1.single++;
        else if (attacksThisRound === 2) report.weapon1.double++;
        else report.weapon1.triple++;

        // Weave attempt: every mainhand round triggers one weave opportunity.
        // Gate (1): offhand cooldown must be up at weave time (tMs + reactionDelay).
        // Gate (2): dual wield check — every DW roll is one "weave attempt".
        // Only DW successes execute and count as "rounds".
        if (report.fistweaving) {
          const weaveCheckMs = tMs + fistweavingReactionDelayMs;
          if (weaveCheckMs >= fistweavingOffhandReadyAtMs) {
            // Offhand is ready; cooldown advances regardless of DW check outcome.
            fistweavingOffhandReadyAtMs = weaveCheckMs + fistweavingOffhandDelayMs;
            report.fistweaving.attempts++;
            if (!checkDualWield(dualWieldEffective, weaveRng)) {
              report.fistweaving.dwFailed++;
            } else {
              report.fistweaving.rounds++;
              let fwAttacks = 1;
              const fwUsesOhWeapon = fistweaveNonEpicOhMode || twoHandWeaveMode;
              // Proc fires when DW check passes, before the swing (can proc even on miss)
              if (fwUsesOhWeapon && procChance2 > 0 && checkProc(procChance2, procRng) && canProcLandOnTarget(w2, options)) {
                report.weapon2.procs++;
                const procDmg = w2.noDamageVsTarget ? 0 : Math.floor(((w2.procSpellDamage != null ? w2.procSpellDamage : 0) | 0) * soulAbrasionProcMult);
                const effectiveness = getProcSpellEffectiveness(w2, options, level, procRng);
                if (procBuffTicks2 > 0 && procDmg > 0) {
                  perTick2 = (procDmg / procBuffTicks2) * effectiveness / 100;
                  const basePerTickThreat2 = procBuffTicks2 > 0 ? procDmg / procBuffTicks2 : 0;
                  if (dotEndMs2 > lastProcMs2) {
                    const ticksRan = Math.floor((Math.min(dotEndMs2, tMs) - lastProcMs2) / PROC_TICK_INTERVAL_MS);
                    const dotDmg = Math.floor(ticksRan * perTick2);
                    const threatDot = Math.floor(ticksRan * basePerTickThreat2);
                    if (dotDmg > 0) {
                      report.weapon2.procDamageTotal += dotDmg;
                      report.totalDamage += dotDmg;
                      addProcThreatAmt(threatDot, 2, false, false);
                    }
                  }
                  lastProcMs2 = tMs;
                  dotEndMs2 = tMs + procBuffTicks2 * PROC_TICK_INTERVAL_MS;
                  const totalDoTDamage2 = Math.floor(procDmg * effectiveness / 100);
                  if (totalDoTDamage2 === 0) {
                    report.weapon2.procFullResists++;
                    report.weapon2.procResists++;
                    report.weapon2.procResistDamageLost += procDmg;
                  } else if (totalDoTDamage2 < procDmg) {
                    report.weapon2.procPartialResists++;
                    report.weapon2.procResists++;
                    report.weapon2.procResistDamageLost += (procDmg - totalDoTDamage2);
                  }
                } else if (w2.procSpellNonDamagingDetrimental) {
                  if (effectiveness === 0) {
                    report.weapon2.procFullResists++;
                    report.weapon2.procResists++;
                  } else if (effectiveness < 100) {
                    report.weapon2.procPartialResists++;
                    report.weapon2.procResists++;
                  }
                  if (effectiveness > 0) addProcThreatAmt(0, 2, true, true);
                } else {
                  let actualDmg = Math.floor(procDmg * effectiveness / 100);
                  const scfResult2 = applySpellCastingFuryProc(actualDmg, options, procRng);
                  actualDmg = scfResult2.damage;
                  if (scfResult2.isCrit) {
                    report.weapon2.spellProcCrits++;
                    report.weapon2.maxSpellProcCritDmg = Math.max(report.weapon2.maxSpellProcCritDmg || 0, actualDmg);
                  }
                  report.weapon2.procDamageTotal += actualDmg;
                  report.totalDamage += actualDmg;
                  if (procDmg > 0) {
                    addProcThreatAmt(procDmg, 2, true, false);
                  } else if (effectiveness > 0) {
                    addProcThreatAmt(0, 2, true, false);
                  }
                  if (procDmg > 0) {
                    if (actualDmg === 0) {
                      report.weapon2.procFullResists++;
                      report.weapon2.procResists++;
                      report.weapon2.procResistDamageLost += procDmg;
                    } else if (actualDmg < procDmg) {
                      report.weapon2.procPartialResists++;
                      report.weapon2.procResists++;
                      report.weapon2.procResistDamageLost += (procDmg - actualDmg);
                    }
                  } else {
                    if (effectiveness === 0) {
                      report.weapon2.procFullResists++;
                      report.weapon2.procResists++;
                    } else if (effectiveness < 100) {
                      report.weapon2.procPartialResists++;
                      report.weapon2.procResists++;
                    }
                  }
                }
              }
              const processFistweaveSwing = function () {
                const threatBase = fwUsesOhWeapon ? cappedFistweaveOhDamage : (options.fistweavingNonEpic ? 14 : 9);
                if (rollHit(toHit, avoidance, weaveRng, frontAvoidChance)) {
                  const ohElem = fwUsesOhWeapon ? getElementalBaseAdder(w2, options, elemRng) : 0;
                  if (ohElem > 0) report.elementalDamageTotal += ohElem;
                  const phys = fwUsesOhWeapon ? cappedFistweaveOhDamage : (options.fistweavingNonEpic ? 14 : 9);
                  const fistBase = phys + ohElem;
                  let dmg = calcMeleeDamage(fistBase, offenseRating, mitigation, weaveRng, 0);
                  const mult = rollDamageMultiplier(offenseRating, dmg, level, options.classId, false, weaveRng);
                  dmg = mult.damage;
                  const beforeCrit = dmg;
                  const critResult = rollMeleeCrit(dmg, 0, level, options.classId, options.dex, options.critChanceMult, false, false, 0, options.critDmgDebugDmgBonus, weaveRng, furyDmgBonusPct);
                  dmg = critResult.damage;
                  if (critResult.isCrit) { report.critHits++; report.critDamageGain += (dmg - beforeCrit); }
                  if (fwUsesOhWeapon && w2 && w2.noDamageVsTarget) {
                    if (ohElem > 0) report.elementalDamageTotal -= ohElem;
                    dmg = 0;
                  }
                  report.fistweaving.swings++;
                  addSwingThreatFist(threatBase);
                  report.fistweaving.hits++;
                  report.fistweaving.totalDamage += dmg;
                  report.fistweaving.maxDamage = Math.max(report.fistweaving.maxDamage, dmg);
                  report.totalDamage += dmg;
                  const fwSlot = twoHandWeaveMode ? '2hweave' : (fistweaveNonEpicOhMode ? 'fistweave-oh' : 'fist');
                  const fwVerb = fwUsesOhWeapon ? 'weave' : 'punch';
                  pushCombatLog(tMs, 'melee', fwSlot, fwVerb, true, dmg, { isCrit: critResult.isCrit });
                } else {
                  report.fistweaving.swings++;
                  addSwingThreatFist(threatBase);
                  const fwSlot = twoHandWeaveMode ? '2hweave' : (fistweaveNonEpicOhMode ? 'fistweave-oh' : 'fist');
                  const fwVerb = fwUsesOhWeapon ? 'weave' : 'punch';
                  pushCombatLog(tMs, 'melee', fwSlot, fwVerb, false);
                }
              };
              processFistweaveSwing();
              // Double attack: beastlord in 2H weave only gets DA via Bestial Frenzy AA
              const fwDoA = (twoHandWeaveMode && options.classId === 'beastlord')
                ? (aaFlatDaChance > 0 && weaveRng() < aaFlatDaChance)
                : checkDoubleAttack(doubleAttackEffective, weaveRng, options.classId);
              if (fwDoA) { fwAttacks = 2; processFistweaveSwing(); }
              if (fwAttacks === 1) report.fistweaving.single++;
              else report.fistweaving.double++;
            }
          } else {
            // Offhand cooldown not yet up — weave skipped this round.
            fistweavingClippedDueToOffhandNotReady++;
            report.fistweaving.clippedDueToOffhandNotReady = fistweavingClippedDueToOffhandNotReady;
          }
        }
      }

      // Offhand: one round per timer; 1 or 2 attacks (no triple)
      if (dualWielding && tMs >= nextSwing2Ms) {
        nextSwing2Ms = tMs + delay2Ms;
        offhandRoundCounter++;
        const ohRoundLetter = (offhandRoundCounter % 2 === 1) ? 'A' : 'B';
        const duelistOhRound = disciplineDuelistActive(tMs);
        const innerFlameOhRound = disciplineInnerFlameActive(tMs);
        const disciplineActiveOh = duelistOhRound || innerFlameOhRound;
        if (checkDualWield(dualWieldEffective, weaveRng)) {
          report.weapon2.rounds++;
          let attacksThisRound = 1;
          // Proc fires when DW check passes, before the swing (can proc even on miss)
          if (procChance2 > 0 && checkProc(procChance2, procRng) && canProcLandOnTarget(w2, options)) {
            report.weapon2.procs++;
            const procDmg = w2.noDamageVsTarget ? 0 : Math.floor(((w2.procSpellDamage != null ? w2.procSpellDamage : 0) | 0) * soulAbrasionProcMult);
            const effectiveness = getProcSpellEffectiveness(w2, options, level, procRng);
            if (procBuffTicks2 > 0 && procDmg > 0) {
              perTick2 = (procDmg / procBuffTicks2) * effectiveness / 100;
              const basePerTickThreat2 = procBuffTicks2 > 0 ? procDmg / procBuffTicks2 : 0;
              if (dotEndMs2 > lastProcMs2) {
                const ticksRan = Math.floor((Math.min(dotEndMs2, tMs) - lastProcMs2) / PROC_TICK_INTERVAL_MS);
                const dotDmg = Math.floor(ticksRan * perTick2);
                const threatDot = Math.floor(ticksRan * basePerTickThreat2);
                if (dotDmg > 0) {
                  report.weapon2.procDamageTotal += dotDmg;
                  report.totalDamage += dotDmg;
                  addProcThreatAmt(threatDot, 2, false, false);
                }
              }
              lastProcMs2 = tMs;
              dotEndMs2 = tMs + procBuffTicks2 * PROC_TICK_INTERVAL_MS;
              const totalDoTDamage2 = Math.floor(procDmg * effectiveness / 100);
              if (totalDoTDamage2 === 0) {
                report.weapon2.procFullResists++;
                report.weapon2.procResists++;
                report.weapon2.procResistDamageLost += procDmg;
              } else if (totalDoTDamage2 < procDmg) {
                report.weapon2.procPartialResists++;
                report.weapon2.procResists++;
                report.weapon2.procResistDamageLost += (procDmg - totalDoTDamage2);
              }
            } else if (w2.procSpellNonDamagingDetrimental) {
              if (effectiveness === 0) {
                report.weapon2.procFullResists++;
                report.weapon2.procResists++;
              } else if (effectiveness < 100) {
                report.weapon2.procPartialResists++;
                report.weapon2.procResists++;
              }
              if (effectiveness > 0) addProcThreatAmt(0, 2, true, true);
            } else {
              let actualDmg = Math.floor(procDmg * effectiveness / 100);
              const scfResult2 = applySpellCastingFuryProc(actualDmg, options, procRng);
              actualDmg = scfResult2.damage;
              if (scfResult2.isCrit) {
                report.weapon2.spellProcCrits++;
                report.weapon2.maxSpellProcCritDmg = Math.max(report.weapon2.maxSpellProcCritDmg || 0, actualDmg);
              }
              report.weapon2.procDamageTotal += actualDmg;
              report.totalDamage += actualDmg;
              if (procDmg > 0) {
                addProcThreatAmt(procDmg, 2, true, false);
              } else if (effectiveness > 0) {
                addProcThreatAmt(0, 2, true, false);
              }
              if (procDmg > 0) {
                if (actualDmg === 0) {
                  report.weapon2.procFullResists++;
                  report.weapon2.procResists++;
                  report.weapon2.procResistDamageLost += procDmg;
                } else if (actualDmg < procDmg) {
                  report.weapon2.procPartialResists++;
                  report.weapon2.procResists++;
                  report.weapon2.procResistDamageLost += (procDmg - actualDmg);
                }
              } else {
                if (effectiveness === 0) {
                  report.weapon2.procFullResists++;
                  report.weapon2.procResists++;
                } else if (effectiveness < 100) {
                  report.weapon2.procPartialResists++;
                  report.weapon2.procResists++;
                }
              }
            }
          }
          if (rollHit(toHit, avoidance, weaveRng, frontAvoidChance)) {
            const ohElemAdder = getElementalBaseAdder(w2, options, elemRng);
            report.elementalDamageTotal += ohElemAdder;
            let ohBase = cappedW2Damage + ohElemAdder;
            ohBase = applyDisciplineDamageMod(ohBase, disciplineActiveOh);
            let dmg = calcMeleeDamage(ohBase, offenseRating, mitigation, weaveRng, 0);
            const mult = rollDamageMultiplier(offenseRating, dmg, level, options.classId, false, weaveRng);
            dmg = mult.damage;
            const beforeCrit = dmg;
            const critResult = rollMeleeCrit(dmg, 0, level, options.classId, options.dex, options.critChanceMult, false, false, 0, options.critDmgDebugDmgBonus, weaveRng, furyDmgBonusPct);
            dmg = critResult.damage;
            if (critResult.isCrit) { report.critHits++; report.critDamageGain += (dmg - beforeCrit); }
            const ohDisciplineMin = getDisciplineMinHit(cappedW2Damage, 0, disciplineActiveOh);
            if (ohDisciplineMin != null && dmg < ohDisciplineMin) dmg = ohDisciplineMin;
            if (w2.noDamageVsTarget) { report.elementalDamageTotal -= ohElemAdder; dmg = 0; }
            report.weapon2.swings++; addSwingThreatOH();
            report.weapon2.hits++;
            report.weapon2.totalDamage += dmg;
            report.weapon2.maxDamage = Math.max(report.weapon2.maxDamage, dmg);
            report.weapon2.minDamage = Math.min(report.weapon2.minDamage, dmg);
            report.weapon2.hitList.push(dmg);
            report.totalDamage += dmg;
            pushCombatLog(tMs, 'melee', 2, w2Verb, true, dmg, { roundLetter: ohRoundLetter, attemptNumber: 1, swingKind: 'BA', dualWieldGate: true, isCrit: critResult.isCrit });
          } else {
            report.weapon2.swings++; addSwingThreatOH();
            pushCombatLog(tMs, 'melee', 2, w2Verb, false, undefined, { roundLetter: ohRoundLetter, attemptNumber: 1, swingKind: 'BA', dualWieldGate: true });
          }
          if (checkDoubleAttack(doubleAttackEffective, weaveRng, options.classId)) {
            attacksThisRound = 2;
            if (rollHit(toHit, avoidance, weaveRng, frontAvoidChance)) {
              const ohElemAdder2 = getElementalBaseAdder(w2, options, elemRng);
              report.elementalDamageTotal += ohElemAdder2;
              let ohBase2 = cappedW2Damage + ohElemAdder2;
              ohBase2 = applyDisciplineDamageMod(ohBase2, disciplineActiveOh);
              let dmg = calcMeleeDamage(ohBase2, offenseRating, mitigation, weaveRng, 0);
              const mult = rollDamageMultiplier(offenseRating, dmg, level, options.classId, false, weaveRng);
              dmg = mult.damage;
              const beforeCrit = dmg;
              const critResult = rollMeleeCrit(dmg, 0, level, options.classId, options.dex, options.critChanceMult, false, false, 0, options.critDmgDebugDmgBonus, weaveRng, furyDmgBonusPct);
              dmg = critResult.damage;
              if (critResult.isCrit) { report.critHits++; report.critDamageGain += (dmg - beforeCrit); }
              const ohDisciplineMin2 = getDisciplineMinHit(cappedW2Damage, 0, disciplineActiveOh);
              if (ohDisciplineMin2 != null && dmg < ohDisciplineMin2) dmg = ohDisciplineMin2;
              if (w2.noDamageVsTarget) { report.elementalDamageTotal -= ohElemAdder2; dmg = 0; }
              report.weapon2.swings++; addSwingThreatOH();
              report.weapon2.hits++;
              report.weapon2.totalDamage += dmg;
              report.weapon2.maxDamage = Math.max(report.weapon2.maxDamage, dmg);
              report.weapon2.minDamage = Math.min(report.weapon2.minDamage, dmg);
              report.weapon2.hitList.push(dmg);
              report.totalDamage += dmg;
              pushCombatLog(tMs, 'melee', 2, w2Verb, true, dmg, { roundLetter: ohRoundLetter, attemptNumber: 2, swingKind: 'DA', dualWieldGate: true, isCrit: critResult.isCrit });
            } else {
              report.weapon2.swings++; addSwingThreatOH();
              pushCombatLog(tMs, 'melee', 2, w2Verb, false, undefined, { roundLetter: ohRoundLetter, attemptNumber: 2, swingKind: 'DA', dualWieldGate: true });
            }
          }
          if (attacksThisRound === 1) report.weapon2.single++;
          else report.weapon2.double++;
        }
      }
    }

    // Flush remaining DoT proc damage (ticks that ran before fight end or duration expiry)
    if (procBuffTicks1 > 0 && dotEndMs1 > lastProcMs1 && perTick1 > 0) {
      const ticksRan = Math.floor((Math.min(dotEndMs1, durationMs) - lastProcMs1) / PROC_TICK_INTERVAL_MS);
      const dotDmg = Math.floor(ticksRan * perTick1);
      const w1pd = hasMainHand && w1 && !w1.noDamageVsTarget ? ((w1.procSpellDamage != null ? w1.procSpellDamage : 0) | 0) : 0;
      const threatDot = procBuffTicks1 > 0 && w1pd > 0 ? Math.floor(ticksRan * (w1pd / procBuffTicks1)) : 0;
      if (dotDmg > 0) {
        report.weapon1.procDamageTotal += dotDmg;
        report.totalDamage += dotDmg;
        addProcThreatAmt(threatDot, 1, false, false);
      }
    }
    if (procBuffTicks2 > 0 && dotEndMs2 > lastProcMs2 && perTick2 > 0) {
      const ticksRan = Math.floor((Math.min(dotEndMs2, durationMs) - lastProcMs2) / PROC_TICK_INTERVAL_MS);
      const dotDmg = Math.floor(ticksRan * perTick2);
      const w2pd = offhandEquipped && w2 && !w2.noDamageVsTarget ? ((w2.procSpellDamage != null ? w2.procSpellDamage : 0) | 0) : 0;
      const threatDot = procBuffTicks2 > 0 && w2pd > 0 ? Math.floor(ticksRan * (w2pd / procBuffTicks2)) : 0;
      if (dotDmg > 0) {
        report.weapon2.procDamageTotal += dotDmg;
        report.totalDamage += dotDmg;
        addProcThreatAmt(threatDot, 2, false, false);
      }
    }

    function hitStats(arr) {
      if (!arr || arr.length === 0) return { min: null, max: null, mean: null, median: null, mode: null };
      const min = Math.min.apply(null, arr);
      const max = Math.max.apply(null, arr);
      const sum = arr.reduce((a, b) => a + b, 0);
      const mean = sum / arr.length;
      const sorted = arr.slice().sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
      const counts = {};
      let mode = arr[0], maxCount = 0;
      for (let i = 0; i < arr.length; i++) {
        const v = arr[i];
        counts[v] = (counts[v] || 0) + 1;
        if (counts[v] > maxCount) { maxCount = counts[v]; mode = v; }
      }
      return { min, max, mean, median, mode };
    }

    report.weapon1.hitStats = hitStats(report.weapon1.hitList);
    report.weapon2.hitStats = hitStats(report.weapon2.hitList);
    if (report.weapon1.hits === 0) report.weapon1.minDamage = null;
    if (report.weapon2.hits === 0) report.weapon2.minDamage = null;

    report.totalThreat = totalThreatAcc;
    report.swingThreat = swingThreatAcc;
    report.procThreat = procThreatAcc;

    if (report.fistweaving && report.fistweaving.usesEquippedOffhandWeapon) {
      report.weapon2.fistweaveAttributedDamage = report.fistweaving.totalDamage != null ? report.fistweaving.totalDamage : 0;
      report.weapon2.fistweaveAttributedThreat = report.fistweaving.swingThreat != null ? report.fistweaving.swingThreat : 0;
    }

    return report;
  }

  function formatHitStat(v) {
    return v == null ? '—' : (Number.isInteger(v) ? String(v) : v.toFixed(2));
  }

  function formatReport(report, weapon1Label, weapon2Label, runsAveraged) {
    const w1 = report.weapon1;
    const w2 = report.weapon2;
    const s1 = w1.hitStats || {};
    const s2 = w2.hitStats || {};
    const dur = report.durationSec;
    const totalDPS = dur ? (report.totalDamage / dur).toFixed(2) : '—';
    const runs = runsAveraged != null ? runsAveraged : 1;
    const lines = [];
    const VALUE_COL = 48;
    function padLine(prefix, value) {
      return prefix + ' '.repeat(Math.max(0, VALUE_COL - prefix.length)) + value;
    }

    // 1. Executive Summary
    lines.push('=== Executive Summary ===', '');
    if (report.permanentDisciplineMode) {
      lines.push('');
      lines.push('>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>');
      lines.push('>>  PERMANENT DISCIPLINE MODE — THIS PARSE IS SKEWED AND UNREALISTIC  <<');
      lines.push('>>  Inner Flame and/or Duelist was modeled active for the ENTIRE fight   <<');
      lines.push('>>  (not a 12s random window). Use for theory only, not real comparison. <<');
      lines.push('>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>');
      const _parts = [];
      if (report.duelistPermanentMode) _parts.push('Duelist');
      if (report.innerFlamePermanentMode) _parts.push('Inner Flame');
      if (_parts.length) lines.push(padLine('  Permanent disc mode:', _parts.join(' + ')));
      lines.push('');
    }
    lines.push(padLine('  Duration:', `${dur} seconds`));
    lines.push(padLine('  Runs averaged:', String(runs)));
    lines.push(padLine('  Total DPS:', totalDPS));
    if (runs > 1 && report.dpsStdDev != null && report.dpsStdDev >= 0) {
      lines.push(padLine('  DPS std dev:', report.dpsStdDev.toFixed(2)));
    }
    lines.push(padLine('  Total damage:', String(report.totalDamage)));
    if (report.totalThreat != null && report.totalThreat >= 0) {
      const tps = dur ? (report.totalThreat / dur).toFixed(2) : '—';
      const swT = report.swingThreat != null ? report.swingThreat : 0;
      const prT = report.procThreat != null ? report.procThreat : 0;
      lines.push(padLine('  TPS (threat, approx):', tps));
      lines.push(padLine('  Total threat:', String(Math.round(report.totalThreat)) + '  (swing + proc; not equal to damage)'));
      lines.push(padLine('  Swing TPS (threat, approx):', dur ? (swT / dur).toFixed(2) : '—'));
      lines.push(padLine('  Proc TPS (threat, approx):', dur ? (prT / dur).toFixed(2) : '—'));
      lines.push(padLine('  Swing threat (approx):', String(Math.round(swT))));
      lines.push(padLine('  Proc threat (approx):', String(Math.round(prT))));
    }
    if (report.critHits != null && report.critHits >= 0) lines.push(padLine('  Critical hits:', String(report.critHits)));
    if (report.critDamageGain != null && report.critDamageGain >= 0) {
      lines.push(padLine('  Crit DPS gain:', `${(report.critDamageGain / dur).toFixed(2)} (vs non-crit baseline)`));
    }
    if (report.elementalDamageTotal != null && report.elementalDamageTotal > 0) {
      lines.push(padLine('  Elemental damage:', String(report.elementalDamageTotal)));
    }
    lines.push('');

    // 2. Offense & To-Hit Model
    lines.push('=== Offense & To-Hit Model ===', '');
    if (report.calculatedToHit != null) lines.push(padLine('  Calculated to-hit:', String(report.calculatedToHit)));
    if (report.offenseSkill != null) lines.push(padLine('  Offense skill:', `${report.offenseSkill}  (0–255, used for to-hit only)`));
    if (report.weaponSkillForToHit != null && report.weaponSkillKeyForToHit != null) {
      if (String(report.weaponSkillKeyForToHit) === '2hs') {
        lines.push(padLine('  Effective 2HS skill (for to-hit):', String(report.weaponSkillForToHit)));
      } else {
        lines.push(padLine('  Weapon skill (for to-hit):', String(report.weaponSkillForToHit)));
      }
    }
    if (report.offenseRating != null) lines.push(padLine('  Offense rating:', `${report.offenseRating}  (used for damage)`));
    if (report.offenseRatingFromStr != null) lines.push(padLine('    From STR:', String(report.offenseRatingFromStr)));
    if (report.offenseRatingFromWornAttack != null && report.offenseRatingFromWornAttack > 0) {
      lines.push(padLine('    From worn ATK:', String(report.offenseRatingFromWornAttack)));
    }
    if (report.offenseRatingFromSpellAttack != null && report.offenseRatingFromSpellAttack > 0) {
      lines.push(padLine('    From spell ATK:', String(report.offenseRatingFromSpellAttack)));
    }
    if (report.offenseRating != null && report.offenseRatingFromStr != null) {
      const wornAtkContrib = (report.offenseRatingFromWornAttack || 0);
      const spellAtkContrib = (report.offenseRatingFromSpellAttack || 0);
      const skillContrib = report.offenseRating - report.offenseRatingFromStr - wornAtkContrib - spellAtkContrib;
      lines.push(padLine('    From skill:', `${skillContrib}  (weapon + offense skill base)`));
    }
    if (report.displayedAttack != null) lines.push(padLine('  Displayed ATK:', String(report.displayedAttack)));
    lines.push(padLine('  ATK formula:', '(offense rating + toHit) * 1000 / 744'));
    if (report.rawHastePercent != null || report.effectiveHastePercent != null) {
      const raw = report.rawHastePercent != null ? Number(report.rawHastePercent).toFixed(1) : '—';
      const eff = report.effectiveHastePercent != null ? Number(report.effectiveHastePercent).toFixed(1) : '—';
      lines.push(padLine('  Haste (raw / effective):', `${raw}% / ${eff}%`));
    }
    if (report.dualWieldPct != null && report.dualWieldEffective != null) {
      const dwRate = Math.min(100, report.dualWieldPct).toFixed(1);
      lines.push(padLine('  Dual wield rate:', `${dwRate}%  (effective ${report.dualWieldEffective} / 375)`));
    }
    lines.push('');

    // 3. Weapon Overview
    lines.push('=== Weapon Overview ===', '');
    lines.push(`  ${weapon1Label || 'Weapon 1'}`);
    if (report.damageBonus != null) lines.push(padLine('    Damage bonus:', String(report.damageBonus)));
    if (report.damageBonusTotal != null && report.damageBonusTotal > 0) lines.push(padLine('    Damage from bonus:', String(report.damageBonusTotal)));
    lines.push(padLine('    Total damage:', String(w1.totalDamage)));
    lines.push(padLine('    Weapon DPS:', (w1.totalDamage / dur).toFixed(2)));
    {
      const _cls = (report.classId || '').toLowerCase();
      const _discLbl = report.discLabel || (_cls === 'rogue' ? 'Duelist' : _cls === 'monk' ? 'Innerflame' : 'Disc');
      const _discNote = report.discEnabled ? '' : '  (Disc not enabled)';
      const _furyNote = (report.furyDmgBonusPct || 0) > 0 ? ` + Fury +${report.furyDmgBonusPct}%` : '';
      if (w1.theoreticMaxHitStd  != null) lines.push(padLine('    Max possible hit:',                         String(w1.theoreticMaxHitStd)));
      if (w1.theoreticMaxHitCrit != null) lines.push(padLine(`    Max possible hit (crit${_furyNote}):`,       String(w1.theoreticMaxHitCrit)));
      if (w1.theoreticMaxHitDisc != null) lines.push(padLine(`    Max possible hit (${_discLbl}):`,            String(w1.theoreticMaxHitDisc) + _discNote));
      if (w1.theoreticMaxHitDiscCrit != null) lines.push(padLine(`    Max possible hit (${_discLbl} + crit${_furyNote}):`, String(w1.theoreticMaxHitDiscCrit) + _discNote));
    }
    if (report.totalThreat != null && report.totalThreat >= 0) {
      const w1Swing = w1.swingThreat != null ? w1.swingThreat : 0;
      const w1Proc = w1.procThreat != null ? w1.procThreat : 0;
      const w1ThreatTot = w1Swing + w1Proc;
      lines.push(padLine('    TPS (threat, approx):', dur ? (w1ThreatTot / dur).toFixed(2) : '—'));
      lines.push(padLine('    Swing threat (approx):', String(Math.round(w1Swing))));
      lines.push(padLine('    Swing TPS (threat, approx):', dur ? (w1Swing / dur).toFixed(2) : '—'));
    }
    lines.push('');
    if (w2.swings > 0) {
      lines.push(`  ${weapon2Label || 'Weapon 2'}`);
      lines.push(padLine('    Total damage:', String(w2.totalDamage)));
      lines.push(padLine('    Weapon DPS:', (w2.totalDamage / dur).toFixed(2)));
      {
        const _cls2 = (report.classId || '').toLowerCase();
        const _discLbl2 = report.discLabel || (_cls2 === 'rogue' ? 'Duelist' : _cls2 === 'monk' ? 'Innerflame' : 'Disc');
        const _discNote2 = report.discEnabled ? '' : '  (Disc not enabled)';
        const _furyNote2 = (report.furyDmgBonusPct || 0) > 0 ? ` + Fury +${report.furyDmgBonusPct}%` : '';
        if (w2.theoreticMaxHitStd  != null) lines.push(padLine('    Max possible hit:',                              String(w2.theoreticMaxHitStd)));
        if (w2.theoreticMaxHitCrit != null) lines.push(padLine(`    Max possible hit (crit${_furyNote2}):`,           String(w2.theoreticMaxHitCrit)));
        if (w2.theoreticMaxHitDisc != null) lines.push(padLine(`    Max possible hit (${_discLbl2}):`,                String(w2.theoreticMaxHitDisc) + _discNote2));
        if (w2.theoreticMaxHitDiscCrit != null) lines.push(padLine(`    Max possible hit (${_discLbl2} + crit${_furyNote2}):`, String(w2.theoreticMaxHitDiscCrit) + _discNote2));
      }
      if (report.totalThreat != null && report.totalThreat >= 0) {
        const w2Swing = w2.swingThreat != null ? w2.swingThreat : 0;
        const w2Proc = w2.procThreat != null ? w2.procThreat : 0;
        const w2ThreatTot = w2Swing + w2Proc;
        lines.push(padLine('    TPS (threat, approx):', dur ? (w2ThreatTot / dur).toFixed(2) : '—'));
        lines.push(padLine('    Swing threat (approx):', String(Math.round(w2Swing))));
        lines.push(padLine('    Swing TPS (threat, approx):', dur ? (w2Swing / dur).toFixed(2) : '—'));
      }
      lines.push('');
    }
    if (report.fistweaving && (report.fistweaving.swingThreat || 0) > 0) {
      const fwSt = report.fistweaving.swingThreat || 0;
      const fwThreatLabel = (report.fistweaving.weaveMode === 'twoHandWeave') ? '2H Weave (equipped secondary)' : 'Fistweaving (unarmed swings)';
      lines.push('  ' + fwThreatLabel);
      lines.push(padLine('    Swing threat (approx):', String(Math.round(fwSt))));
      lines.push(padLine('    Swing TPS (threat, approx):', dur ? (fwSt / dur).toFixed(2) : '—'));
      lines.push('');
    }

    // 4. Attack Distribution (Weapon 1)
    lines.push('=== Attack Distribution ===', '');
    lines.push(`  ${weapon1Label || 'Weapon 1'}`, '');
    const r1 = w1.rounds != null ? w1.rounds : w1.swings;
    lines.push(padLine('    Combat rounds:', String(r1)));
    if (r1 > 0) {
      const single1 = w1.single != null ? w1.single : 0;
      const double1 = w1.double != null ? w1.double : 0;
      const triple1 = w1.triple != null ? w1.triple : 0;
      lines.push(padLine('    Single / Double / Triple (%):', `${(single1 / r1 * 100).toFixed(1)}% / ${(double1 / r1 * 100).toFixed(1)}% / ${(triple1 / r1 * 100).toFixed(1)}%`));
    }
    lines.push(padLine('    Single attacks:', String(w1.single != null ? w1.single : '—')));
    lines.push(padLine('    Double attacks:', String(w1.double != null ? w1.double : '—')));
    lines.push(padLine('    Triple attacks:', String(w1.triple != null ? w1.triple : '—')));
    if (w1.flurry) lines.push(padLine('      Flurry procs:', String(w1.flurry)));
    if (w1.ragingFlurry) lines.push(padLine('      Raging Flurry procs:', String(w1.ragingFlurry)));
    if (w1.punishingBlade) lines.push(padLine('    Punishing Blade procs:', String(w1.punishingBlade)));
    if (w1.speedOfTheKnight) lines.push(padLine('    Speed of the Knight procs:', String(w1.speedOfTheKnight)));
    lines.push(padLine('    Swings:', String(w1.swings)));
    lines.push(padLine('    Hits:', String(w1.hits)));
    if (w1.swings > 0) lines.push(padLine('    Accuracy:', (w1.hits / w1.swings * 100).toFixed(1) + '%'));
    lines.push('');
    if (w2.swings > 0) {
      lines.push(`  ${weapon2Label || 'Weapon 2'}`, '');
      const r2 = w2.rounds != null ? w2.rounds : w2.swings;
      lines.push(padLine('    Combat rounds:', String(r2)));
      if (r2 > 0) {
        const single2 = w2.single != null ? w2.single : 0;
        const double2 = w2.double != null ? w2.double : 0;
        lines.push(padLine('    Single / Double (%):', `${(single2 / r2 * 100).toFixed(1)}% / ${(double2 / r2 * 100).toFixed(1)}%`));
      }
      lines.push(padLine('    Single attacks:', String(w2.single != null ? w2.single : '—')));
      lines.push(padLine('    Double attacks:', String(w2.double != null ? w2.double : '—')));
      lines.push(padLine('    Swings:', String(w2.swings)));
      lines.push(padLine('    Hits:', String(w2.hits)));
      if (w2.swings > 0) lines.push(padLine('    Accuracy:', (w2.hits / w2.swings * 100).toFixed(1) + '%'));
      lines.push('');
    }

    // 5. Hit Damage Statistics
    lines.push('=== Hit Damage Statistics ===', '');
    lines.push(`  ${weapon1Label || 'Weapon 1'}`);
    lines.push(padLine('    Max hit:', formatHitStat(s1.max != null ? s1.max : w1.maxDamage)));
    lines.push(padLine('    Min hit:', formatHitStat(s1.min)));
    lines.push(padLine('    Mean hit:', formatHitStat(s1.mean)));
    lines.push(padLine('    Median hit:', formatHitStat(s1.median)));
    lines.push(padLine('    Mode hit:', formatHitStat(s1.mode)));
    lines.push('');
    if (w2.swings > 0) {
      lines.push(`  ${weapon2Label || 'Weapon 2'}`);
      lines.push(padLine('    Max hit:', formatHitStat(s2.max != null ? s2.max : w2.maxDamage)));
      lines.push(padLine('    Min hit:', formatHitStat(s2.min)));
      lines.push(padLine('    Mean hit:', formatHitStat(s2.mean)));
      lines.push(padLine('    Median hit:', formatHitStat(s2.median)));
      lines.push(padLine('    Mode hit:', formatHitStat(s2.mode)));
      lines.push('');
    }

    // 6. Procs & Specials
    lines.push('=== Procs & Specials ===', '');
    lines.push(`  ${weapon1Label || 'Weapon 1'}`);
    if (w1.anticipatedProcsPerMinute != null) lines.push(padLine('    Anticipated procs per minute:', w1.anticipatedProcsPerMinute.toFixed(2)));
    if (w1.anticipatedProcChancePerRound != null) lines.push(padLine('    Anticipated proc chance per round:', (w1.anticipatedProcChancePerRound * 100).toFixed(2) + '%'));
    if (w1.procs != null) lines.push(padLine('    Procs:', String(w1.procs)));
    lines.push(padLine('    Proc damage:', String(w1.procDamageTotal != null ? w1.procDamageTotal : 0)));
    lines.push(padLine('    Proc DPS:', (w1.procDamageTotal != null && dur > 0) ? (w1.procDamageTotal / dur).toFixed(2) : '0.00'));
    {
      const w1p = w1.procThreat != null ? w1.procThreat : 0;
      lines.push(padLine('    Proc threat (approx):', String(Math.round(w1p))));
      lines.push(padLine('    Proc TPS (threat, approx):', dur ? (w1p / dur).toFixed(2) : '—'));
    }
    lines.push(padLine('    Proc full resists:', String(w1.procFullResists != null ? w1.procFullResists : 0)));
    lines.push(padLine('    Proc partial resists:', String(w1.procPartialResists != null ? w1.procPartialResists : 0)));
    if (w1.procLevelBlocked) {
      lines.push(padLine('    Proc gated by level:', `yes (level ${w1.procLevelCurrent != null ? w1.procLevelCurrent : '-'} < required ${w1.procLevelRequired != null ? w1.procLevelRequired : '-'})`));
    }
    if (w1.procResistDamageLost != null && w1.procResistDamageLost > 0) {
      lines.push(padLine('    Proc damage lost (resists):', String(w1.procResistDamageLost)));
    }
    if (w1.spellProcCrits != null) lines.push(padLine('    Proc spell crits (SCF):', String(w1.spellProcCrits)));
    if (w1.maxSpellProcCritDmg != null && w1.maxSpellProcCritDmg > 0) lines.push(padLine('    Max spell proc crit dmg:', String(w1.maxSpellProcCritDmg)));
    if (w2.swings > 0) {
      lines.push('');
      lines.push(`  ${weapon2Label || 'Weapon 2'}`);
      if (w2.anticipatedProcsPerMinute != null) lines.push(padLine('    Anticipated procs per minute:', w2.anticipatedProcsPerMinute.toFixed(2)));
      if (w2.anticipatedProcChancePerRound != null) lines.push(padLine('    Anticipated proc chance per round:', (w2.anticipatedProcChancePerRound * 100).toFixed(2) + '%'));
      if (w2.procs != null) lines.push(padLine('    Procs:', String(w2.procs)));
      lines.push(padLine('    Proc damage:', String(w2.procDamageTotal != null ? w2.procDamageTotal : 0)));
      lines.push(padLine('    Proc DPS:', (w2.procDamageTotal != null && dur > 0) ? (w2.procDamageTotal / dur).toFixed(2) : '0.00'));
      {
        const w2p = w2.procThreat != null ? w2.procThreat : 0;
        lines.push(padLine('    Proc threat (approx):', String(Math.round(w2p))));
        lines.push(padLine('    Proc TPS (threat, approx):', dur ? (w2p / dur).toFixed(2) : '—'));
      }
      lines.push(padLine('    Proc full resists:', String(w2.procFullResists != null ? w2.procFullResists : 0)));
      lines.push(padLine('    Proc partial resists:', String(w2.procPartialResists != null ? w2.procPartialResists : 0)));
      if (w2.procLevelBlocked) {
        lines.push(padLine('    Proc gated by level:', `yes (level ${w2.procLevelCurrent != null ? w2.procLevelCurrent : '-'} < required ${w2.procLevelRequired != null ? w2.procLevelRequired : '-'})`));
      }
      if (w2.procResistDamageLost != null && w2.procResistDamageLost > 0) {
        lines.push(padLine('    Proc damage lost (resists):', String(w2.procResistDamageLost)));
      }
      if (w2.spellProcCrits != null) lines.push(padLine('    Proc spell crits (SCF):', String(w2.spellProcCrits)));
      if (w2.maxSpellProcCritDmg != null && w2.maxSpellProcCritDmg > 0) lines.push(padLine('    Max spell proc crit dmg:', String(w2.maxSpellProcCritDmg)));
    }
    if (report.special) {
      lines.push('');
      const sp = report.special;
      const a = sp.attempts != null ? sp.attempts : 0;
      const h = sp.hits != null ? sp.hits : sp.count;
      const D = sp.doubleBackstabs != null ? sp.doubleBackstabs : 0;
      const singleBackstabRounds = Math.max(0, a - D);
      const totalBackstabAttempts = sp.doubleBackstabs !== undefined ? (singleBackstabRounds + 2 * D) : a;
      const acc = totalBackstabAttempts > 0 ? (h / totalBackstabAttempts * 100).toFixed(1) : '0';
      const dpsLabel = sp.name === 'Backstab' ? 'DPS from backstab' : 'DPS';
      lines.push(`  ${sp.name}`);
      if (sp.name === 'Backstab') {
        if (sp.backstabToHit != null) lines.push(padLine('    To-hit (backstab):', String(sp.backstabToHit)));
        if (sp.effectiveBackstabSkillReport != null) lines.push(padLine('    Effective backstab skill:', String(sp.effectiveBackstabSkillReport)));
        if (sp.backstabSkill != null && (sp.backstabModPercent || 0) > 0) {
          lines.push(padLine('    Backstab weapon modifier applied:', '+' + sp.backstabModPercent + '%'));
        }
        lines.push(padLine('    Number of backstab rounds:', String(a)));
        if (sp.doubleBackstabs !== undefined) lines.push(padLine('    Backstab swings:', String(totalBackstabAttempts)));
      } else {
        lines.push(padLine('    Attempts:', String(a)));
      }
      if (sp.doubleBackstabs !== undefined) {
        lines.push(padLine('    Single backstab rounds:', String(singleBackstabRounds)));
        lines.push(padLine('    Double backstab rounds:', String(D)));
      }
      lines.push(padLine(`    ${sp.name === 'Backstab' ? 'Backstab hits landed' : 'Hits landed'}:`, String(h)));
      lines.push(padLine('    Accuracy (chance to hit):', acc + '%'));
      if (sp.effectiveReuseSec != null && sp.effectiveReuseSec > 0) {
        lines.push(padLine('    Effective special attack delay:', sp.effectiveReuseSec.toFixed(2) + 's'));
      }
      lines.push(padLine('    Total damage:', String(sp.totalDamage)));
      lines.push(padLine('    Max hit:', String(sp.maxDamage)));
      lines.push(padLine(`    ${dpsLabel}:`, (sp.totalDamage / dur).toFixed(2)));
      if (sp.name !== 'Backstab' && sp.backstabSkill != null) {
        const effectiveSkill = Math.min(252, Math.floor(sp.backstabSkill * (100 + (sp.backstabModPercent || 0)) / 100));
        lines.push(padLine('    Effective backstab skill:', String(effectiveSkill)));
        if ((sp.backstabModPercent || 0) > 0) {
          lines.push(padLine('    Backstab weapon modifier applied:', '+' + sp.backstabModPercent + '%'));
        }
      }
    }
    if (report.masterWu) {
      const wu = report.masterWu;
      const triggerRate = wu.mainRolls > 0 ? (wu.triggered / wu.mainRolls * 100).toFixed(1) : '0';
      const wuAcc = wu.extraAttempts > 0 ? (wu.extraHits / wu.extraAttempts * 100).toFixed(1) : '0';
      const avgFKHit = wu.fkHits > 0 ? (wu.fkDamage / wu.fkHits).toFixed(1) : '—';
      const avgWuPerFK = wu.mainRolls > 0 ? (wu.totalDamage / wu.mainRolls).toFixed(1) : '—';
      lines.push('');
      lines.push('  Technique of Master Wu (rank ' + wu.rank + ')');
      lines.push(padLine('    Flying kicks with Wu active:', String(wu.mainRolls)));
      lines.push(padLine('    Wu triggered (main roll):', String(wu.triggered) + '  (' + triggerRate + '%)'));
      lines.push(padLine('    Extra strikes (att / hit):', wu.extraAttempts + ' / ' + wu.extraHits + '  (' + wuAcc + '% acc)'));
      lines.push('');
      lines.push('    Extra strike breakdown:');
      var skillOrder = ['Flying Kick', 'Eagle Strike', 'Tiger Claw', 'Round Kick'];
      skillOrder.forEach(function (sName) {
        var s = wu.bySkill[sName];
        if (!s) return;
        var sAvg = s.hits > 0 ? (s.damage / s.hits).toFixed(1) : '—';
        lines.push(padLine('      ' + sName + ':', s.attempts + ' att / ' + s.hits + ' hit   ' + s.damage + ' dmg  (avg ' + sAvg + ')'));
      });
      lines.push('');
      lines.push(padLine('    Total Wu damage:', String(wu.totalDamage)));
      lines.push(padLine('    Wu DPS:', (wu.totalDamage / dur).toFixed(2)));
      lines.push(padLine('    Avg Wu dmg per FK use:', avgWuPerFK + '  (vs avg FK hit: ' + avgFKHit + ')'));
    }
    if (report.fistweaving && report.fistweaving.usesEquippedOffhandWeapon) {
      const fw = report.fistweaving;
      const wlabel = fw.nonEpicWeaponLabel || 'Offhand weapon';
      const wdly = fw.nonEpicWeaponDelayDecisec != null ? fw.nonEpicWeaponDelayDecisec : '—';
      const wphys = fw.baseDamage != null ? fw.baseDamage : '—';
      const ohSectionTitle = (fw.weaveMode === 'twoHandWeave')
        ? '  *** 2H Weave (equipped secondary) ***'
        : '  *** Non-Epic Fistweaving (equipped secondary) ***';
      lines.push('');
      lines.push(ohSectionTitle);
      lines.push('    Weaved attacks use the offhand item\'s damage and delay (no automatic offhand round swings; proc fires on DW check pass).');
      lines.push(padLine('    Secondary weapon:', `${wlabel} — ${wphys} damage / ${wdly} delay (decisec)`));
    }
    if ((report.classId || '').toLowerCase() === 'paladin') {
      lines.push('');
      const suHits = report.weapon1 && report.weapon1.slayUndeadHits != null ? report.weapon1.slayUndeadHits : 0;
      const suDamage = report.weapon1 && report.weapon1.slayUndeadDamageTotal != null ? report.weapon1.slayUndeadDamageTotal : 0;
      const suMaxHit = report.weapon1 && report.weapon1.maxSlayUndeadHit != null ? report.weapon1.maxSlayUndeadHit : 0;
      lines.push('  Slay Undead (AA)');
      lines.push(padLine('    Slay Undead hits:', String(suHits)));
      lines.push(padLine('    Slay Undead damage:', String(suDamage)));
      lines.push(padLine('    Max Slay Undead hit:', String(suMaxHit)));
      lines.push(padLine('    DPS from Slay Undead:', dur > 0 ? (suDamage / dur).toFixed(2) : '0.00'));
    }
    if (report.fistweaving) {
      const fw = report.fistweaving;
      const fwAcc = fw.swings > 0 ? (fw.hits / fw.swings * 100).toFixed(1) : '0';
      const fwDmg = fw.baseDamage != null ? fw.baseDamage : 9;
      const is2HWeave = fw.weaveMode === 'twoHandWeave';
      const fwWeaponHasProc = fw.usesEquippedOffhandWeapon && report.weapon2 && report.weapon2.anticipatedProcChancePerRound > 0;
      const fwTitle = fw.usesEquippedOffhandWeapon
        ? ((is2HWeave ? '2H Weave' : 'Fistweaving') + ' — secondary weapon base ' + fwDmg + ' / delay ' + (fw.nonEpicWeaponDelayDecisec != null ? fw.nonEpicWeaponDelayDecisec : '—') + (fwWeaponHasProc ? '' : ' (no proc)'))
        : ('Fistweaving (' + fwDmg + ' dmg, no proc)');
      lines.push('  ' + fwTitle);
      const reactionLabel = is2HWeave ? '    2H Weave reaction delay:' : '    Fistweave reaction delay:';
      if (fw.reactionDelayMs != null) lines.push(padLine(reactionLabel, String(fw.reactionDelayMs) + 'ms'));
      if (fw.mainhandSwingDelayMs != null) lines.push(padLine('    Mainhand swing timer:', String(Number(fw.mainhandSwingDelayMs).toFixed(0)) + 'ms'));
      if (fw.offhandSwingDelayMs != null) {
        const msStr = (Number.isFinite(Number(fw.offhandSwingDelayMs)) ? Number(fw.offhandSwingDelayMs).toFixed(0) : String(fw.offhandSwingDelayMs));
        if (fw.offhandSwingDelayDecisec != null) {
          lines.push(padLine('    Weaved offhand swing timer:', msStr + 'ms (decisec ' + fw.offhandSwingDelayDecisec + ')'));
        } else {
          lines.push(padLine('    Weaved offhand swing timer:', msStr + 'ms'));
        }
      }
      lines.push(padLine('    Weave attempts:', String(fw.attempts != null ? fw.attempts : 0)));
      lines.push(padLine('    Blocked by dual wield check:', String(fw.dwFailed != null ? fw.dwFailed : 0)));
      lines.push(padLine('    Rounds (DW check passed):', String(fw.rounds)));
      lines.push(padLine('    Single / Double:', `${fw.single ?? '—'} / ${fw.double ?? '—'}`));
      lines.push(padLine('    Swings:', String(fw.swings)));
      lines.push(padLine('    Hits:', String(fw.hits)));
      lines.push(padLine('    Accuracy:', fwAcc + '%'));
      lines.push(padLine('    Total damage:', String(fw.totalDamage)));
      lines.push(padLine('    DPS:', (fw.totalDamage / dur).toFixed(2)));
      if (fwWeaponHasProc) {
        const w2r = report.weapon2;
        lines.push(padLine('    Proc attempts:', String(w2r.procs || 0)));
        if (w2r.procDamageTotal > 0) lines.push(padLine('    Proc damage:', String(w2r.procDamageTotal)));
        if (w2r.procResists > 0) lines.push(padLine('    Proc resists:', String(w2r.procResists)));
      }
    }
    lines.push('');

    // 7. Final Totals
    lines.push('=== Final Totals ===', '');
    lines.push(padLine('  Total damage:', String(report.totalDamage)));
    lines.push(padLine('  Total DPS:', totalDPS));
    if (report.totalThreat != null && report.totalThreat >= 0) {
      lines.push(padLine('  TPS (threat, approx):', dur ? (report.totalThreat / dur).toFixed(2) : '—'));
      const swT = report.swingThreat != null ? report.swingThreat : 0;
      const prT = report.procThreat != null ? report.procThreat : 0;
      lines.push(padLine('  Swing TPS (threat, approx):', dur ? (swT / dur).toFixed(2) : '—'));
      lines.push(padLine('  Proc TPS (threat, approx):', dur ? (prT / dur).toFixed(2) : '—'));
      lines.push(padLine('  Total threat (approx):', String(Math.round(report.totalThreat))));
    }
    return lines.join('\n');
  }

  global.EQCombat = {
    getHitChance,
    rollHit,
    getAvoidanceNPC,
    rollD20,
    calcMeleeDamage,
    getMitigation,
    getDoubleAttackEffective,
    checkDoubleAttack,
    canTripleAttack,
    checkTripleAttack,
    getDamageBonusClient,
    isWarriorClass,
    getCritChance,
    applyCritDamage,
    rollMeleeCrit,
    getDamageBonusNPC,
    getDualWieldEffective,
    checkDualWield,
    effectiveDelayDecisec,
    getEffectiveHastePercent,
    getProcChancePerSwing,
    runFight,
    formatReport,
    runRangedFight,
    formatRangedReport,
    getDefaultSpecialTypeForClass,
    canClassUseSpecialType,
    SPECIAL_ATTACKS_BY_TYPE,
    createRng,
  };
})(typeof window !== 'undefined' ? window : typeof self !== 'undefined' ? self : this);
