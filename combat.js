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

  // ----- Hit chance (AvoidanceCheck) -----
  // Server: toHit = GetToHit(skill) = 7 + Offense SKILL + Weapon skill + accuracy (typically 400–550). Offense skill is the 0–255 value; offense RATING is what affects damage (skill + STR + worn/spell).
  // toHit += 10, avoidance += 10
  // if (toHit * 1.21 > avoidance) hitChance = 1.0 - avoidance / (toHit * 1.21 * 2.0)
  // else hitChance = toHit * 1.21 / (avoidance * 2.0)
  // Cap effective toHit so very high attack values don't overstate hit rate (avoidance causes misses).
  const TO_HIT_CAP_FOR_AVOIDANCE = 550;
  function getHitChance(toHit, avoidance) {
    const effectiveToHit = Math.min(toHit != null ? toHit : 400, TO_HIT_CAP_FOR_AVOIDANCE);
    const a = effectiveToHit + 10;
    const b = (avoidance != null ? avoidance : 460) + 10;
    if (a * 1.21 > b) {
      return 1.0 - b / (a * 1.21 * 2.0);
    }
    return (a * 1.21) / (b * 2.0);
  }

  // fromBehind: when true, no block/parry/riposte/dodge; hit roll still applies (misses still occur).
  // When false, after the hit roll we apply an avoid chance (block/parry/dodge/riposte).
  const AVOID_CHANCE_FROM_FRONT = 0.08;

  function rollHit(toHit, avoidance, rng, fromBehind) {
    const chance = getHitChance(toHit, avoidance);
    if (rng() >= chance) return false;
    if (fromBehind) return true;
    return rng() >= AVOID_CHANCE_FROM_FRONT;
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
      damage = Math.floor(damage * roll / 100);
      if (level >= 55 && damage > 1 && !isArchery && isWarriorClass(classId)) damage++;
      return { damage: damage < 1 ? 1 : damage, isCrit: roll > 100 };
    }
    return { damage: damage < 1 ? 1 : damage, isCrit: false };
  }

  // ----- Melee critical hit chance (client: DEX, class, AA, discipline) -----
  // critChance is in percent (0–100); divide by 100 for roll. RuleI(Combat, ClientBaseCritChance) default 0.
  function getCritChance(level, classId, dex, clientBaseCritChance, critChanceMult, isArchery) {
    let critChance = (clientBaseCritChance != null ? clientBaseCritChance : 0);
    const dexCap = Math.min(dex != null ? dex : 255, 255);
    const overCap = (dex != null && dex > 255) ? (dex - 255) / 400 : 0;

    if (classId === 'warrior' && level >= 12) {
      critChance += 0.5 + dexCap / 90 + overCap;
    } else if (isArchery && classId === 'ranger' && level > 16) {
      critChance += 1.35 + dexCap / 34 + overCap * 2;
    } else if (classId !== 'warrior' && critChanceMult) {
      critChance += 0.275 + dexCap / 150 + overCap;
    }

    if (critChanceMult) critChance += critChance * critChanceMult / 100;
    return Math.max(0, Math.min(100, critChance));
  }

  // ----- Melee critical hit damage: ((damage - damageBonus) * critMod + 5) / 10 + 8 + damageBonus -----
  // critMod 17 = normal crit, 29 = crippling blow / berserk. cripSuccess adds +2 damage.
  function applyCritDamage(damage, damageBonus, critMod, cripSuccess) {
    let dmg = Math.floor(((damage - (damageBonus || 0)) * critMod + 5) / 10) + 8 + (damageBonus || 0);
    if (cripSuccess) dmg += 2;
    return dmg < 1 ? 1 : dmg;
  }

  // Roll for crit, then apply crit damage if it lands. Returns { damage, isCrit }.
  // damageBonus = main-hand damage bonus (0 for offhand). isArchery, isBerserk, cripplingBlowChance optional.
  function rollMeleeCrit(damage, damageBonus, level, classId, dex, critChanceMult, isArchery, isBerserk, cripplingBlowChance, rng) {
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
    const newDamage = applyCritDamage(damage, damageBonus, critMod, cripSuccess);
    return { damage: newDamage, isCrit: true };
  }

  // ----- Double Attack (CheckDoubleAttack) -----
  // effective skill > random(0, 499). effective = skill + level (and AA). 1% per 5 skill.
  function getDoubleAttackEffective(toHitOrLevel, doubleAttackSkill) {
    return doubleAttackSkill + (toHitOrLevel || 0);
  }

  function checkDoubleAttack(doubleAttackEffective, rng, classId) {
    if (classId === 'bard' || classId === 'beastlord') return false;
    return doubleAttackEffective > Math.floor(rng() * 500);
  }

  // ----- Triple Attack (main hand only; offhand does not triple) -----
  // Triple happens on 13.5% of rounds that already had a successful double attack.
  // Only warrior and monk at level 60+ can triple attack.
  const TRIPLE_ATTACK_CHANCE_ON_DOUBLE = 0.135;

  function canTripleAttack(level, classId) {
    return (classId === 'warrior' || classId === 'monk') && (level != null ? level : 0) >= 60;
  }

  function checkTripleAttack(rng, level, classId) {
    if (!canTripleAttack(level, classId)) return false;
    return rng() < TRIPLE_ATTACK_CHANCE_ON_DOUBLE;
  }

  // ----- Client::GetDamageBonus – main hand damage bonus (level, 1h/2h, delay) -----
  // Applied after all other damage calculations. All classes, level >= 28.
  function isWarriorClass(classId) {
    return classId === 'warrior' || classId === 'ranger' || classId === 'paladin' ||
      classId === 'shadowknight' || classId === 'bard';
  }

  function getDamageBonusClient(level, classId, delay, is2H) {
    if (level < 28) return 0;
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
    return dualWieldEffective > Math.floor(rng() * 375);
  }

  // ----- Haste: effective delay (deciseconds, 10 = 1 sec) -----
  // haste_mod = 1 + hastePercent/100. Timer = delay / haste_mod (delay in decisec).
  // All inputs (delay, fightDurationSec, cooldownDecisec) stay in deciseconds; internal timers use milliseconds.
  const DECISEC_TO_MS = 100; // 1 decisec = 100 ms
  const MIN_DELAY_DECISEC = 4; // minimum effective delay after haste (0.4 sec)
  const DEFAULT_CHARACTER_HASTE_CAP_60_BONUS = 100; // RuleI(Character, HasteCap)
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
  function effectiveDelayDecisec(delay, hastePercent) {
    const hasteMod = 1 + (hastePercent || 0) / 100;
    return Math.max(MIN_DELAY_DECISEC, delay / hasteMod);
  }
  // Effective delay in ms for timer math (inputs still decisec).
  function effectiveDelayMs(delayDecisec, hastePercent) {
    return effectiveDelayDecisec(delayDecisec, hastePercent) * DECISEC_TO_MS;
  }

  // ----- Proc chance (server formula) -----
  // chance = (0.0004166667 + 1.1437908496732e-5 * dex) * weapon_speed; offhand: chance *= 50 / GetDualWieldChance().
  // weapon_speed = effective delay (deciseconds). dualWieldChance = 0..100 (same scale as GetDualWieldChance).
  const PROC_TICK_INTERVAL_MS = 6000; // DoT proc ticks every 6 seconds; buffduration = number of ticks
  function getProcChancePerSwing(effectiveDelayDecisec, isOffhand, dualWieldChance, dex) {
    if (effectiveDelayDecisec <= 0) return 0;
    const d = dex != null ? dex : 150;
    let chance = (0.0004166667 + 1.1437908496732e-5 * d) * effectiveDelayDecisec;
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
  const RESIST_TYPE_NONE = 0;
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
    // Run resist check on every proc: use spell resist type if set, otherwise default to magic (1) so procs are still resistible.
    const resistType = weapon.procSpellResistType != null && weapon.procSpellResistType !== RESIST_TYPE_NONE
      ? weapon.procSpellResistType
      : 1;
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

  // ----- Special attacks (Flying Kick, Backstab, Kick, Bash, etc.) -----
  // Per EQMacEmu special_attacks.cpp: Bash (Warrior/Paladin/SK/Cleric), Slam (Ogre/Troll/Barbarian = Bash without shield), Kick (Warrior/Ranger/Beastlord), Flying Kick (Monk), Backstab (Rogue).
  // Flying Kick uses skill/level-based base only; Kick/Bash use GetSkillBaseDamage (skill-based base, not weapon).
  // Base reuse times (seconds); player haste reduces effective reuse: effectiveReuseSec = baseReuseSec / (1 + hastePercent/100)
  const SPECIAL_ATTACK_REUSE_TIMES = {
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

  // ----- Ranged (archery) combat -----
  // Simulates Client::RangedAttack flow: one shot per ranged_timer (weapon delay + haste).
  // Requires ranged weapon (bow) and ammo (arrow). Damage = RollD20(baseDamage, mitigation) + multiplier + crit; proc on hit.
  /**
   * Run a single ranged (archery) fight simulation.
   * @param {Object} options
   * @param {Object} options.rangedWeapon - { damage, delay, procSpell?, procSpellDamage? }
   * @param {Object} options.arrow - { damage }
   * @param {number} options.hastePercent - total haste (%)
   * @param {number} [options.level=60]
   * @param {number} options.targetAC - mob AC for mitigation
   * @param {number} [options.mobLevel=60]
   * @param {number} options.fightDurationSec
   * @param {number} [options.offenseSkill=252] - archery to-hit
   * @param {number} [options.wornAttack=0]
   * @param {number} [options.spellAttack=0]
   * @param {number} [options.str=255] - for offense rating
   * @param {number} [options.dex=255] - proc rate, crit
   * @param {number} [options.critChanceMult=0] - AA crit %
   * @param {number} [options.archeryMastery=2] - 1, 2, or 3 (AA)
   * @param {boolean} [options.mobStationary=false]
   * @param {boolean} [options.useWalledMobPenalty=false] - track damage lost to wall penalty
   * @param {number} [options.seed]
   */
  function runRangedFight(options) {
    const rng = createRng(options.seed);
    const procRng = createRng(options.seed != null ? options.seed + 9999 : undefined);
    const level = options.level != null ? options.level : 60;
    const effectiveHastePercent = getEffectiveHastePercent(options.hastePercent, level, options.hasteCap60Bonus);
    const targetAC = options.targetAC != null ? options.targetAC : 300;
    const mobLevel = options.mobLevel != null ? options.mobLevel : 60;
    const avoidance = options.avoidance != null ? options.avoidance : getAvoidanceNPC(mobLevel);
    const mitigation = getMitigation(mobLevel, targetAC, 0, 0);
    const str = options.str != null ? options.str : 255;
    const strBonus = str >= 75 ? Math.floor((2 * str - 150) / 3) : 0;
    const wornAttack = options.wornAttack != null ? options.wornAttack : 0;
    const spellAttack = options.spellAttack != null ? options.spellAttack : 0;
    const OFFENSE_SKILL = options.offenseSkill != null ? Math.min(255, Math.max(0, options.offenseSkill)) : 252;
    const ARCHERY_SKILL = 252;
    const toHit = 7 + OFFENSE_SKILL + ARCHERY_SKILL;
    const offenseRating = OFFENSE_SKILL + strBonus + wornAttack + spellAttack;

    const bow = options.rangedWeapon;
    const arrow = options.arrow;
    if (!bow || bow.damage == null || bow.delay == null || !arrow || arrow.damage == null) {
      return { error: 'Missing rangedWeapon (damage, delay) or arrow (damage)' };
    }
    const mastery = options.archeryMastery != null ? Math.max(1, Math.min(3, Math.floor(options.archeryMastery))) : 2;
    const masteryMult = mastery === 1 ? 1.30 : mastery === 2 ? 1.60 : 2.00;
    let baseDamagePerShot = ((bow.damage || 0) + (arrow.damage || 0)) * masteryMult;
    if (baseDamagePerShot < 1) {
      return { error: 'Ranged weapon + arrow damage must be at least 1' };
    }
    const mobStationary = !!options.mobStationary;

    const delayDecisec = effectiveDelayDecisec(bow.delay, effectiveHastePercent);
    const delayMs = delayDecisec * DECISEC_TO_MS;
    // Ranged procs use same chance as primary (main hand): (base + dex factor) * weapon_speed; no offhand penalty. Apply proc rate modifier.
    const baseRangedProcChance = (bow.procSpell != null && bow.procSpell !== '' && canTriggerProcAtLevel(bow, level))
      ? getProcChancePerSwing(delayDecisec, false, 0, options.dex || 150)
      : 0;
    const rangedProcRate = (bow.procRate != null && !Number.isNaN(Number(bow.procRate))) ? Number(bow.procRate) : 0;
    const procChance = Math.min(1, Math.max(0, baseRangedProcChance * (100 + rangedProcRate) / 100));
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
      totalDamage: 0,
      elementalDamageTotal: 0,
      critHits: 0,
      critDamageGain: 0,
      wallPenaltyDamageLost: useWalledMobPenalty ? 0 : undefined,
      calculatedToHit: toHit,
      offenseSkill: OFFENSE_SKILL,
      offenseRating: offenseRating,
      displayedAttack: Math.floor((offenseRating + toHit) * 1000 / 744),
    };
    const rangedProcLevelReq = getProcLevelRequirement(bow);
    if (bow.procSpell != null && bow.procSpell !== '' && rangedProcLevelReq != null && level < rangedProcLevelReq) {
      report.ranged.procLevelBlocked = true;
      report.ranged.procLevelRequired = rangedProcLevelReq;
    }
    if (procChance > 0 && delayMs > 0) {
      report.ranged.anticipatedProcChancePerShot = procChance;
      report.ranged.anticipatedProcsPerMinute = procChance * (60 * 1000 / delayMs);
    }

    const durationMs = Math.floor(options.fightDurationSec * 1000);
    let nextRangedAtMs = 0;

    while (nextRangedAtMs < durationMs) {
      report.ranged.swings++;
      // Proc is attempted every swing (even on miss)
      let procDamageThisShot = 0;
      if (procChance > 0 && checkProc(procChance, procRng)) {
        report.ranged.procs++;
        const procDmg = (bow.procSpellDamage != null ? bow.procSpellDamage : 0) || 0;
        const effectiveness = getProcSpellEffectiveness(bow, options, level, procRng);
        let actualProcDmg = Math.floor(procDmg * effectiveness / 100);
        const scfResult = applySpellCastingFuryProc(actualProcDmg, options, procRng);
        actualProcDmg = scfResult.damage;
        if (scfResult.isCrit) {
          report.ranged.spellProcCrits++;
          report.ranged.maxSpellProcCritDmg = Math.max(report.ranged.maxSpellProcCritDmg || 0, actualProcDmg);
        }
        report.ranged.procDamageTotal += actualProcDmg;
        procDamageThisShot = actualProcDmg;
        if (actualProcDmg === 0) {
          report.ranged.procFullResists++;
          report.ranged.procResists++;
          report.ranged.procResistDamageLost += procDmg;
        } else if (actualProcDmg < procDmg) {
          report.ranged.procPartialResists++;
          report.ranged.procResists++;
          report.ranged.procResistDamageLost += (procDmg - actualProcDmg);
        }
      }
      const hit = rollHit(toHit, avoidance, rng, true);
      if (!hit) {
        nextRangedAtMs += delayMs;
        if (procDamageThisShot > 0) {
          report.ranged.totalDamage += procDamageThisShot;
          report.totalDamage += procDamageThisShot;
          report.ranged.maxDamage = Math.max(report.ranged.maxDamage, procDamageThisShot);
          if (procDamageThisShot < report.ranged.minDamage) report.ranged.minDamage = procDamageThisShot;
          report.ranged.hitList.push(procDamageThisShot);
        }
        continue;
      }
      report.ranged.hits++;
      const rangedElemAdder = getElementalBaseAdder(bow, options, rng) + getElementalBaseAdder(arrow, options, rng);
      report.elementalDamageTotal += rangedElemAdder;
      const rangedBaseWithElem = baseDamagePerShot + rangedElemAdder;
      let baseDmg = calcMeleeDamage(rangedBaseWithElem, offenseRating, mitigation, rng, 0);
      baseDmg = Math.max(1, baseDmg);
      const mult = rollDamageMultiplier(offenseRating, baseDmg, level, 'ranger', true, rng);
      let dmg = mult.damage;
      const beforeCrit = dmg;
      const critResult = rollMeleeCrit(dmg, 0, level, 'ranger', options.dex, options.critChanceMult || 0, true, false, 0, rng);
      dmg = critResult.damage;
      if (critResult.isCrit) {
        report.critHits++;
        report.critDamageGain += (dmg - beforeCrit);
      }
      if (mobStationary) dmg = Math.floor(dmg * 2);
      let standardDamage = dmg;
      if (useWalledMobPenalty && rng() < WALL_PENALTY_CHANCE) {
        const actualDamage = Math.max(1, Math.floor(dmg * WALL_PENALTY_FACTOR));
        report.wallPenaltyDamageLost += (dmg - actualDamage);
        dmg = actualDamage;
      }
      dmg += procDamageThisShot;
      report.ranged.totalDamage += dmg;
      report.totalDamage += dmg;
      report.ranged.maxDamage = Math.max(report.ranged.maxDamage, dmg);
      if (dmg < report.ranged.minDamage) report.ranged.minDamage = dmg;
      report.ranged.hitList.push(dmg);
      nextRangedAtMs += delayMs;
    }

    if (report.ranged.minDamage === Infinity) report.ranged.minDamage = null;
    return report;
  }

  function formatRangedReport(report, runsAveraged) {
    if (report.error) return report.error;
    const r = report.ranged;
    const dur = report.durationSec;
    const totalDPS = dur ? (report.totalDamage / dur).toFixed(2) : '—';
    const runs = runsAveraged != null ? runsAveraged : 1;
    function fmt(v) {
      return v == null ? '—' : (Number.isInteger(v) ? String(v) : v.toFixed(2));
    }
    const lines = [];

    // 1. Executive Summary
    lines.push('=== Executive Summary ===', '');
    if (report.baseDamageCap && report.baseDamageCap.cap != null) {
      lines.push(`  Base damage cap (anti-twink): ${report.baseDamageCap.cap} (level < 40, imposed on weapon base damage)`);
      lines.push('');
    }
    lines.push(`  Duration:              ${dur} seconds`);
    lines.push(`  Runs averaged:        ${runs}`);
    lines.push(`  Total DPS:            ${totalDPS}`);
    lines.push(`  Total damage:         ${report.totalDamage}`);
    if (report.critHits != null && report.critHits >= 0) lines.push(`  Critical hits:         ${report.critHits}`);
    if (report.critDamageGain != null) {
      lines.push(`  Crit DPS gain:         ${(report.critDamageGain / dur).toFixed(2)} (vs non-crit baseline)`);
    }
    if (report.wallPenaltyDamageLost != null && report.wallPenaltyDamageLost >= 0) {
      lines.push(`  Wall penalty lost:    ${report.wallPenaltyDamageLost}`);
    }
    if (report.elementalDamageTotal != null && report.elementalDamageTotal > 0) {
      lines.push(`  Elemental damage:     ${report.elementalDamageTotal}`);
    }
    lines.push('');

    // 2. Offense & To-Hit Model
    lines.push('=== Offense & To-Hit Model ===', '');
    if (report.calculatedToHit != null) lines.push(`  Calculated to-hit:     ${report.calculatedToHit}`);
    if (report.offenseRating != null) lines.push(`  Offense rating:        ${report.offenseRating}  (used for damage)`);
    if (report.displayedAttack != null) lines.push(`  Displayed ATK:         ${report.displayedAttack}`);
    lines.push('  ATK formula:           (offense rating + toHit) * 1000 / 744');
    if (report.rawHastePercent != null || report.effectiveHastePercent != null) {
      const raw = report.rawHastePercent != null ? Number(report.rawHastePercent).toFixed(1) : '—';
      const eff = report.effectiveHastePercent != null ? Number(report.effectiveHastePercent).toFixed(1) : '—';
      lines.push(`  Haste (raw / effective): ${raw}% / ${eff}%`);
    }
    lines.push('');

    // 3. Weapon Overview (Ranged)
    lines.push('=== Weapon Overview ===', '');
    lines.push('  Ranged');
    lines.push(`    Total damage:       ${r.totalDamage}`);
    lines.push(`    Weapon DPS:          ${(r.totalDamage / dur).toFixed(2)}`);
    lines.push('');

    // 4. Attack Distribution
    lines.push('=== Attack Distribution ===', '');
    lines.push(`    Shots:              ${r.swings}`);
    lines.push(`    Hits:               ${r.hits}`);
    if (r.swings > 0) lines.push(`    Accuracy:             ${(r.hits / r.swings * 100).toFixed(1)}%`);
    lines.push('');

    // 5. Hit Damage Statistics
    lines.push('=== Hit Damage Statistics ===', '');
    lines.push(`    Max hit:             ${fmt(r.maxDamage)}`);
    lines.push(`    Min hit:             ${fmt(r.minDamage)}`);
    lines.push('');

    // 6. Procs & Specials
    lines.push('=== Procs & Specials ===', '');
    if (r.anticipatedProcsPerMinute != null) lines.push(`    Anticipated procs per minute: ${r.anticipatedProcsPerMinute.toFixed(2)}`);
    if (r.anticipatedProcChancePerShot != null) lines.push(`    Anticipated proc chance per shot: ${(r.anticipatedProcChancePerShot * 100).toFixed(2)}%`);
    if (r.procs != null) lines.push(`    Procs:               ${r.procs}`);
    lines.push(`    Proc damage:         ${r.procDamageTotal != null ? r.procDamageTotal : 0}`);
    lines.push(`    Proc DPS:            ${(r.procDamageTotal != null && dur > 0) ? (r.procDamageTotal / dur).toFixed(2) : '0.00'}`);
    lines.push(`    Proc full resists:   ${r.procFullResists != null ? r.procFullResists : 0}`);
    lines.push(`    Proc partial resists: ${r.procPartialResists != null ? r.procPartialResists : 0}`);
    if (r.procLevelBlocked) {
      lines.push(`    Proc gated by level: yes (level ${r.procLevelCurrent != null ? r.procLevelCurrent : '-'} < required ${r.procLevelRequired != null ? r.procLevelRequired : '-'})`);
    }
    if (r.procResistDamageLost != null && r.procResistDamageLost > 0) {
      lines.push(`    Proc damage lost (resists): ${r.procResistDamageLost}`);
    }
    if (r.spellProcCrits != null) lines.push(`    Proc spell crits (SCF):  ${r.spellProcCrits}`);
    if (r.maxSpellProcCritDmg != null && r.maxSpellProcCritDmg > 0) lines.push(`    Max spell proc crit dmg:  ${r.maxSpellProcCritDmg}`);
    lines.push('');

    // 7. Final Totals
    lines.push('=== Final Totals ===', '');
    lines.push(`  Total damage:         ${report.totalDamage}`);
    lines.push(`  Total DPS:            ${totalDPS}`);
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
   * @param {Object} [options.weapon1] - { damage, delay, procSpell?, procSpellDamage?, procBuffDurationTicks?, is2H?, type? }. procBuffDurationTicks = DoT ticks (6s each); omit/0 = instant proc. type = weapon skill type (e.g. '1hp' for backstab requirement).
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
   * @param {number} options.fightDurationSec - fight length in seconds
   * @param {number} [options.dex=255] - dexterity for proc
   * @param {boolean} [options.fromBehind] - if true, skip block/parry/dodge/riposte only
   * @param {boolean} [options.specialAttacks] - if true, fire class special on cooldown
   * @param {string} [options.specialAttackType] - 'flying_kick'|'backstab'|'kick'|'bash'; must be valid for class (Warrior: kick/bash; Pally/SK/Cleric: bash; Ranger/Beastlord: kick; Monk: flying_kick; Rogue: backstab)
   * @param {number} [options.backstabModPercent] - increase effective backstab skill by this % (e.g. 20 for 20%), capped at 255
   * @param {number} [options.backstabSkill] - backstab skill for base damage (skill*0.02+2)*weapon_damage; also enforces minHit by level
   * @param {number} [options.backstabReuseSec] - override backstab base reuse time in seconds (default: 10); haste is applied to this base
   * @param {number} [options.flyingKickReuseSec] - override flying kick base reuse time in seconds (default: 8); haste is applied to this base
   * @param {number} [options.backstabReuseEffectiveSec] - use this value directly as effective backstab reuse (no haste applied); used when UI passes user-typed effective time
   * @param {number} [options.flyingKickReuseEffectiveSec] - use this value directly as effective flying kick reuse (no haste applied); used when UI passes user-typed effective time
   * @param {number} [options.kickReuseEffectiveSec] - effective kick reuse (s), no haste applied
   * @param {number} [options.bashReuseEffectiveSec] - effective bash reuse (s), no haste applied
   * @param {number} [options.seed] - optional RNG seed for reproducibility
   * @param {number} [options.critChanceMult] - AA Critical Hit Chance bonus (percent)
   * @param {boolean} [options.duelist] - rogue only: SE_DamageModifier[185] (+100% base damage) for 12s at a random time in the fight
   * @param {boolean} [options.innerFlame] - monk only: SE_DamageModifier[185] (+100% base damage) for 12s at a random time in the fight
   */
  function runFight(options) {
    const fromBehind = !!options.fromBehind;
    const rng = createRng(options.seed);
    const procRng = createRng(options.seed != null ? options.seed + 12345 : undefined);
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
    const avoidance = options.avoidance != null ? options.avoidance : getAvoidanceNPC(mobLevel);
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
    const offenseRating = (options.attackRating != null && options.wornAttack == null && options.spellAttack == null)
      ? options.attackRating + strBonus
      : (OFFENSE_SKILL + strBonus + wornAttack + spellAttack);
    const dualWieldEffective = getDualWieldEffective(level, options.dualWieldSkill, options.ambidexterity ?? 0);
    const dualWieldPct = (dualWieldEffective / 375) * 100;
    const doubleAttackEffective = getDoubleAttackEffective(level, options.doubleAttackSkill || 0);

    const w1 = options.weapon1;
    const w2 = options.weapon2;
    const hasMainHand = !!w1;
    if (specialType === 'backstab' && options.classId === 'rogue' && canFireSpecial && hasMainHand) {
      const mainHandType = (options.weapon1Type != null ? String(options.weapon1Type) : (w1.type != null ? String(w1.type) : '')).toLowerCase();
      if (mainHandType !== '1hp') canFireSpecial = false;
    }
    const baseDamageCap = getBaseDamageCap(level, options.classId);
    const cappedW1Damage = hasMainHand ? (baseDamageCap != null ? Math.min(w1.damage, baseDamageCap) : w1.damage) : 0;
    const cappedW2Damage = w2 ? (baseDamageCap != null ? Math.min(w2.damage, baseDamageCap) : w2.damage) : 0;
    const mainHandDamageBonus = hasMainHand ? getDamageBonusClient(level, options.classId, w1.delay, !!w1.is2H) : 0;
    const dualWielding = !!w2 && (options.dualWieldSkill != null && options.dualWieldSkill > 0) &&
      options.classId !== 'paladin' && options.classId !== 'shadowknight';

    if (!hasMainHand && !dualWielding) {
      return { error: 'Offhand-only mode requires Weapon 2 with damage, delay, and dual wield skill.' };
    }

    const delay1 = hasMainHand ? effectiveDelayDecisec(w1.delay, effectiveHastePercent) : 0;
    const delay2 = w2 ? effectiveDelayDecisec(w2.delay, effectiveHastePercent) : 0;
    const delay1Ms = hasMainHand ? effectiveDelayMs(w1.delay, effectiveHastePercent) : Infinity;
    const delay2Ms = w2 ? effectiveDelayMs(w2.delay, effectiveHastePercent) : 0;

    const baseProcChance1 = hasMainHand && w1.procSpell != null && canTriggerProcAtLevel(w1, level)
      ? getProcChancePerSwing(delay1, false, dualWieldPct, options.dex || 150)
      : 0;
    const baseProcChance2 = w2 && w2.procSpell != null && canTriggerProcAtLevel(w2, level)
      ? getProcChancePerSwing(delay2, true, dualWieldPct, options.dex || 150)
      : 0;
    const procRate1 = (w1.procRate != null && !Number.isNaN(Number(w1.procRate))) ? Number(w1.procRate) : 0;
    const procRate2 = (w2 && w2.procRate != null && !Number.isNaN(Number(w2.procRate))) ? Number(w2.procRate) : 0;
    const procChance1 = Math.min(1, Math.max(0, baseProcChance1 * (100 + procRate1) / 100));
    const procChance2 = Math.min(1, Math.max(0, baseProcChance2 * (100 + procRate2) / 100));

    const roundsPerMinW1 = (delay1Ms > 0 && hasMainHand) ? (60 * 1000 / delay1Ms) : 0;
    const roundsPerMinW2 = (delay2Ms > 0 && w2) ? (60 * 1000 / delay2Ms) : 0;
    const report = {
      weapon1: { swings: 0, hits: 0, totalDamage: 0, maxDamage: 0, minDamage: Infinity, hitList: [], procs: 0, procDamageTotal: 0, procResists: 0, procFullResists: 0, procPartialResists: 0, procResistDamageLost: 0, spellProcCrits: 0, maxSpellProcCritDmg: 0, rounds: 0, single: 0, double: 0, triple: 0 },
      weapon2: { swings: 0, hits: 0, totalDamage: 0, maxDamage: 0, minDamage: Infinity, hitList: [], procs: 0, procDamageTotal: 0, procResists: 0, procFullResists: 0, procPartialResists: 0, procResistDamageLost: 0, spellProcCrits: 0, maxSpellProcCritDmg: 0, rounds: 0, single: 0, double: 0, triple: 0 },
      durationSec: options.fightDurationSec,
      rawHastePercent: !Number.isNaN(Number(options.hastePercent)) ? Number(options.hastePercent) : 0,
      effectiveHastePercent: effectiveHastePercent,
      totalDamage: 0,
      elementalDamageTotal: 0,
      damageBonus: mainHandDamageBonus,
      damageBonusTotal: 0,
      calculatedToHit: toHit,
      offenseSkill: OFFENSE_SKILL,
      offenseRating: offenseRating,
      offenseRatingFromStr: strBonus,
      displayedAttack: Math.floor((offenseRating + toHit) * 1000 / 744),
      baseDamageCap: (baseDamageCap != null && ((w1 && w1.damage > baseDamageCap) || (w2 && w2.damage > baseDamageCap))) ? { cap: baseDamageCap } : null,
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
      fistweaving: (options.classId === 'monk' && hasMainHand && w1.is2H && options.fistweaving) ? { rounds: 0, swings: 0, hits: 0, totalDamage: 0, maxDamage: 0, single: 0, double: 0 } : null,
    };
    report.weapon1.procLevelBlocked = false;
    report.weapon1.procLevelRequired = null;
    report.weapon1.procLevelCurrent = level;
    report.weapon2.procLevelBlocked = false;
    report.weapon2.procLevelRequired = null;
    report.weapon2.procLevelCurrent = level;
    const w1ProcLevelReq = getProcLevelRequirement(w1);
    if (hasMainHand && w1.procSpell != null && w1ProcLevelReq != null && level < w1ProcLevelReq) {
      report.weapon1.procLevelBlocked = true;
      report.weapon1.procLevelRequired = w1ProcLevelReq;
    }
    const w2ProcLevelReq = getProcLevelRequirement(w2);
    if (w2 && w2.procSpell != null && w2ProcLevelReq != null && level < w2ProcLevelReq) {
      report.weapon2.procLevelBlocked = true;
      report.weapon2.procLevelRequired = w2ProcLevelReq;
    }
    if (hasMainHand && w1.procSpell) {
      report.weapon1.anticipatedProcChancePerRound = procChance1;
      report.weapon1.anticipatedProcsPerMinute = roundsPerMinW1 > 0 ? procChance1 * roundsPerMinW1 : null;
    }
    if (w2 && w2.procSpell) {
      report.weapon2.anticipatedProcChancePerRound = procChance2;
      report.weapon2.anticipatedProcsPerMinute = roundsPerMinW2 > 0 ? procChance2 * roundsPerMinW2 : null;
    }

    const durationMs = Math.floor(options.fightDurationSec * 1000);
    const procBuffTicks1 = (hasMainHand && w1.procBuffDurationTicks != null && w1.procBuffDurationTicks > 0) ? w1.procBuffDurationTicks : 0;
    const procBuffTicks2 = (w2 && w2.procBuffDurationTicks != null && w2.procBuffDurationTicks > 0) ? w2.procBuffDurationTicks : 0;
    let lastProcMs1 = 0, dotEndMs1 = 0, perTick1 = 0;
    let lastProcMs2 = 0, dotEndMs2 = 0, perTick2 = 0;
    const duelist = !!(options.duelist && options.classId === 'rogue');
    const innerFlame = !!(options.innerFlame && options.classId === 'monk');
    const BUFF_12S_MS = 12000;
    const duelistStartMs = duelist ? Math.floor(rng() * Math.max(0, durationMs - BUFF_12S_MS)) : 0;
    const duelistEndMs = duelistStartMs + BUFF_12S_MS;
    const innerFlameStartMs = innerFlame ? Math.floor(rng() * Math.max(0, durationMs - BUFF_12S_MS)) : 0;
    const innerFlameEndMs = innerFlameStartMs + BUFF_12S_MS;
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
    let nextSwing1Ms = hasMainHand ? 0 : Infinity;
    let nextSwing2Ms = dualWielding ? rng() * delay2Ms : Infinity;
    let nextSpecialAtMs = (canFireSpecial && report.special) ? 0 : Infinity;

    // Event-driven loop: timers in ms. Each swing: (1) AvoidanceCheck: rollHit(toHit, avoidance) → hit or miss. (2) If hit: CalcMeleeDamage uses RollD20(offense, mitigation) → damage.
    while (true) {
      const tMs = Math.min(nextSpecialAtMs, nextSwing1Ms, dualWielding ? nextSwing2Ms : Infinity, durationMs);
      if (tMs >= durationMs) break;

      // Special attack (Flying Kick / Backstab) on cooldown
      if (canFireSpecial && report.special && tMs >= nextSpecialAtMs) {
        report.special.attempts++;
        const isRogueBackstab = specialConfig.fromBehindOnly === true;
        const backstabSkill = options.backstabSkill != null ? options.backstabSkill : 225;
        const backstabModPct = options.backstabModPercent || 0;
        const effectiveBackstabSkill = Math.min(255, Math.floor(backstabSkill * (100 + backstabModPct) / 100));
        // EQMacEmu GetToHit(skill): toHit = 7 + Offense SKILL + skill (Backstab for backstab). Use raw backstab skill, not modded.
        const backstabToHit = isRogueBackstab ? (7 + OFFENSE_SKILL + backstabSkill) : toHit;

        // Backstab: do double attack check first. If it fails → single backstab (one to-hit roll). If it succeeds → double backstab (normal + bonus attempt, two to-hit rolls).
        const isDoubleBackstabRound = isRogueBackstab && options.classId === 'rogue' && level > 54 && report.special.doubleBackstabs !== undefined && checkDoubleAttack(doubleAttackEffective, rng, options.classId);
        const numBackstabRolls = isDoubleBackstabRound ? 2 : 1;
        if (isDoubleBackstabRound) report.special.doubleBackstabs++;

        function processOneBackstabHit() {
          if (report.special.attemptedAttacks !== undefined) report.special.attemptedAttacks++;
          const specialHits = rollHit(backstabToHit, avoidance, rng, fromBehind);
          if (!specialHits) return;
          report.special.hits++;
          report.special.count++;
          let baseDmg;
          let backstabDisciplineMinHit = null;
          const specElemAdder = (specialConfig.useWeaponDamage === false) ? 0 : getElementalBaseAdder(w1, options, rng);
          if (specElemAdder > 0) report.elementalDamageTotal += specElemAdder;
          if (isRogueBackstab) {
            const effectiveSkill = Math.min(255, Math.floor(backstabSkill * (100 + backstabModPct) / 100));
            const backstabOffenseRating = effectiveSkill + strBonus + wornAttack + spellAttack;
            const backstabBaseRaw = Math.floor(((effectiveSkill * 0.02) + 2) * cappedW1Damage) + specElemAdder;
            const duelistBackstabRound = duelist && tMs >= duelistStartMs && tMs < duelistEndMs;
            backstabDisciplineMinHit = getDisciplineMinHit(backstabBaseRaw, 0, duelistBackstabRound);
            let backstabBase = applyDisciplineDamageMod(backstabBaseRaw, duelistBackstabRound);
            baseDmg = calcMeleeDamage(backstabBase, backstabOffenseRating, mitigation, rng, 0);
            baseDmg = Math.max(1, baseDmg);
          } else if (specialConfig.useWeaponDamage === false && specialConfig.skillBaseDamage != null) {
            const skillBase = specialConfig.skillBaseDamage;
            baseDmg = calcMeleeDamage(skillBase, offenseRating, mitigation, rng, 0);
            if (specialConfig.minDamageFormula === 'level*4/5') {
              const fkMin = Math.floor(level * 4 / 5);
              baseDmg = Math.max(1, Math.max(baseDmg, fkMin));
            } else {
              baseDmg = Math.max(1, baseDmg);
            }
          } else {
            baseDmg = calcMeleeDamage(cappedW1Damage + specElemAdder, offenseRating, mitigation, rng);
            baseDmg = Math.max(1, specialConfig.damageMultiplier ? Math.floor(baseDmg * specialConfig.damageMultiplier) : baseDmg);
          }
          const mult = rollDamageMultiplier(offenseRating, baseDmg, level, options.classId, false, rng);
          let dmg = mult.damage;
          const beforeCrit = dmg;
          const critResult = rollMeleeCrit(dmg, 0, level, options.classId, options.dex, options.critChanceMult, false, false, 0, rng);
          dmg = critResult.damage;
          if (critResult.isCrit) { report.critHits++; report.critDamageGain += (dmg - beforeCrit); }
          if (isRogueBackstab && level != null) {
            const minHit = level >= 60 ? level * 2 : level > 50 ? Math.floor(level * 3 / 2) : level;
            dmg = Math.max(dmg, minHit);
          }
          if (backstabDisciplineMinHit != null && dmg < backstabDisciplineMinHit) dmg = backstabDisciplineMinHit;
          report.special.totalDamage += dmg;
          report.special.maxDamage = Math.max(report.special.maxDamage, dmg);
          report.special.hitList.push(dmg);
          report.weapon1.totalDamage += dmg;
          report.totalDamage += dmg;
        }

        for (let r = 0; r < numBackstabRolls; r++) processOneBackstabHit();
        nextSpecialAtMs = tMs + specialCooldownMs;
      }

      // Main hand (one round = one swing opportunity; 1, 2, or 3 attacks per round)
      if (tMs >= nextSwing1Ms) {
        const duelistThisRound = duelist && tMs >= duelistStartMs && tMs < duelistEndMs;
        const innerFlameThisRound = innerFlame && tMs >= innerFlameStartMs && tMs < innerFlameEndMs;
        const disciplineActiveMh = duelistThisRound || innerFlameThisRound;

        report.weapon1.rounds++;
        nextSwing1Ms = tMs + delay1Ms;
        let attacksThisRound = 1;
        let mainHandHitThisRound = false;

        // Crit is only rolled after a successful hit (we are inside the rollHit success block).
        if (rollHit(toHit, avoidance, rng, fromBehind)) {
          mainHandHitThisRound = true;
          const mhElemAdder = getElementalBaseAdder(w1, options, rng);
          report.elementalDamageTotal += mhElemAdder;
          let mhBase = cappedW1Damage + mhElemAdder;
          mhBase = applyDisciplineDamageMod(mhBase, disciplineActiveMh);
          let dmg = calcMeleeDamage(mhBase, offenseRating, mitigation, rng, 0);
          const mult = rollDamageMultiplier(offenseRating, dmg, level, options.classId, false, rng);
          dmg = mult.damage;
          dmg += mainHandDamageBonus;
          dmg = Math.max(dmg, 1 + mainHandDamageBonus);
          const beforeCrit = dmg;
          const critResult = rollMeleeCrit(dmg, mainHandDamageBonus, level, options.classId, options.dex, options.critChanceMult, false, false, 0, rng);
          dmg = critResult.damage;
          dmg = Math.max(dmg, 1 + mainHandDamageBonus);
          if (critResult.isCrit) { report.critHits++; report.critDamageGain += (dmg - beforeCrit); }
          const mhDisciplineMin = getDisciplineMinHit(cappedW1Damage, mainHandDamageBonus, disciplineActiveMh);
          if (mhDisciplineMin != null && dmg < mhDisciplineMin) dmg = mhDisciplineMin;
          report.weapon1.swings++;
          report.weapon1.hits++;
          report.weapon1.totalDamage += dmg;
          report.weapon1.maxDamage = Math.max(report.weapon1.maxDamage, dmg);
          report.weapon1.minDamage = Math.min(report.weapon1.minDamage, dmg);
          report.weapon1.hitList.push(dmg);
          report.totalDamage += dmg;
          report.damageBonusTotal += mainHandDamageBonus;
        } else {
          report.weapon1.swings++;
        }

        if (checkDoubleAttack(doubleAttackEffective, rng, options.classId)) {
          attacksThisRound = 2;
          if (rollHit(toHit, avoidance, rng, fromBehind)) {
            mainHandHitThisRound = true;
            const mhElemAdder2 = getElementalBaseAdder(w1, options, rng);
            report.elementalDamageTotal += mhElemAdder2;
            let mhBase2 = cappedW1Damage + mhElemAdder2;
            mhBase2 = applyDisciplineDamageMod(mhBase2, disciplineActiveMh);
            let dmg = calcMeleeDamage(mhBase2, offenseRating, mitigation, rng, 0);
            const mult = rollDamageMultiplier(offenseRating, dmg, level, options.classId, false, rng);
            dmg = mult.damage;
            dmg += mainHandDamageBonus;
            dmg = Math.max(dmg, 1 + mainHandDamageBonus);
            const beforeCrit = dmg;
            const critResult = rollMeleeCrit(dmg, mainHandDamageBonus, level, options.classId, options.dex, options.critChanceMult, false, false, 0, rng);
            dmg = critResult.damage;
            dmg = Math.max(dmg, 1 + mainHandDamageBonus);
            if (critResult.isCrit) { report.critHits++; report.critDamageGain += (dmg - beforeCrit); }
            const mhDisciplineMin2 = getDisciplineMinHit(cappedW1Damage, mainHandDamageBonus, disciplineActiveMh);
            if (mhDisciplineMin2 != null && dmg < mhDisciplineMin2) dmg = mhDisciplineMin2;
            report.weapon1.swings++;
            report.weapon1.hits++;
            report.weapon1.totalDamage += dmg;
            report.weapon1.maxDamage = Math.max(report.weapon1.maxDamage, dmg);
            report.weapon1.minDamage = Math.min(report.weapon1.minDamage, dmg);
            report.weapon1.hitList.push(dmg);
            report.totalDamage += dmg;
            report.damageBonusTotal += mainHandDamageBonus;
          } else {
            report.weapon1.swings++;
          }
          if (checkTripleAttack(rng, level, options.classId)) {
            attacksThisRound = 3;
            if (rollHit(toHit, avoidance, rng, fromBehind)) {
              mainHandHitThisRound = true;
              const mhElemAdder3 = getElementalBaseAdder(w1, options, rng);
              report.elementalDamageTotal += mhElemAdder3;
              let mhBase3 = cappedW1Damage + mhElemAdder3;
              mhBase3 = applyDisciplineDamageMod(mhBase3, disciplineActiveMh);
              let dmg = calcMeleeDamage(mhBase3, offenseRating, mitigation, rng, 0);
              const mult = rollDamageMultiplier(offenseRating, dmg, level, options.classId, false, rng);
              dmg = mult.damage;
              dmg += mainHandDamageBonus;
              dmg = Math.max(dmg, 1 + mainHandDamageBonus);
              const beforeCrit = dmg;
              const critResult = rollMeleeCrit(dmg, mainHandDamageBonus, level, options.classId, options.dex, options.critChanceMult, false, false, 0, rng);
              dmg = critResult.damage;
              dmg = Math.max(dmg, 1 + mainHandDamageBonus);
              if (critResult.isCrit) { report.critHits++; report.critDamageGain += (dmg - beforeCrit); }
              const mhDisciplineMin3 = getDisciplineMinHit(cappedW1Damage, mainHandDamageBonus, disciplineActiveMh);
              if (mhDisciplineMin3 != null && dmg < mhDisciplineMin3) dmg = mhDisciplineMin3;
              report.weapon1.swings++;
              report.weapon1.hits++;
              report.weapon1.totalDamage += dmg;
              report.weapon1.maxDamage = Math.max(report.weapon1.maxDamage, dmg);
              report.weapon1.minDamage = Math.min(report.weapon1.minDamage, dmg);
              report.weapon1.hitList.push(dmg);
              report.totalDamage += dmg;
              report.damageBonusTotal += mainHandDamageBonus;
            } else {
              report.weapon1.swings++;
            }
          }
        }

        // Proc once per round (only if at least one hit landed)
        if (procChance1 > 0 && checkProc(procChance1, procRng)) {
          report.weapon1.procs++;
          const procDmg = (w1.procSpellDamage != null ? w1.procSpellDamage : 0) | 0;
          const effectiveness = getProcSpellEffectiveness(w1, options, level, procRng);
          if (procBuffTicks1 > 0 && procDmg > 0) {
            perTick1 = (procDmg / procBuffTicks1) * effectiveness / 100;
            if (dotEndMs1 > lastProcMs1) {
              const ticksRan = Math.floor((Math.min(dotEndMs1, tMs) - lastProcMs1) / PROC_TICK_INTERVAL_MS);
              const dotDmg = Math.floor(ticksRan * perTick1);
              if (dotDmg > 0) {
                report.weapon1.procDamageTotal += dotDmg;
                report.totalDamage += dotDmg;
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
            if (actualDmg === 0) {
              report.weapon1.procFullResists++;
              report.weapon1.procResists++;
              report.weapon1.procResistDamageLost += procDmg;
            } else if (actualDmg < procDmg) {
              report.weapon1.procPartialResists++;
              report.weapon1.procResists++;
              report.weapon1.procResistDamageLost += (procDmg - actualDmg);
            }
          }
        }

        if (attacksThisRound === 1) report.weapon1.single++;
        else if (attacksThisRound === 2) report.weapon1.double++;
        else report.weapon1.triple++;

        // Fistweaving (monk 2H): after each primary hand round, one offhand round with 9 damage; can double attack, no proc
        if (report.fistweaving) {
          report.fistweaving.rounds++;
          let fwAttacks = 1;
          const FIST_DAMAGE = 9;
          if (rollHit(toHit, avoidance, rng, fromBehind)) {
            let dmg = calcMeleeDamage(FIST_DAMAGE, offenseRating, mitigation, rng, 0);
            const mult = rollDamageMultiplier(offenseRating, dmg, level, options.classId, false, rng);
            dmg = mult.damage;
            const beforeCrit = dmg;
            const critResult = rollMeleeCrit(dmg, 0, level, options.classId, options.dex, options.critChanceMult, false, false, 0, rng);
            dmg = critResult.damage;
            if (critResult.isCrit) { report.critHits++; report.critDamageGain += (dmg - beforeCrit); }
            report.fistweaving.swings++;
            report.fistweaving.hits++;
            report.fistweaving.totalDamage += dmg;
            report.fistweaving.maxDamage = Math.max(report.fistweaving.maxDamage, dmg);
            report.totalDamage += dmg;
          } else {
            report.fistweaving.swings++;
          }
          if (checkDoubleAttack(doubleAttackEffective, rng, options.classId)) {
            fwAttacks = 2;
            if (rollHit(toHit, avoidance, rng, fromBehind)) {
              let dmg = calcMeleeDamage(FIST_DAMAGE, offenseRating, mitigation, rng, 0);
              const mult = rollDamageMultiplier(offenseRating, dmg, level, options.classId, false, rng);
              dmg = mult.damage;
              const beforeCrit = dmg;
              const critResult = rollMeleeCrit(dmg, 0, level, options.classId, options.dex, options.critChanceMult, false, false, 0, rng);
              dmg = critResult.damage;
              if (critResult.isCrit) { report.critHits++; report.critDamageGain += (dmg - beforeCrit); }
              report.fistweaving.swings++;
              report.fistweaving.hits++;
              report.fistweaving.totalDamage += dmg;
              report.fistweaving.maxDamage = Math.max(report.fistweaving.maxDamage, dmg);
              report.totalDamage += dmg;
            } else {
              report.fistweaving.swings++;
            }
          }
          if (fwAttacks === 1) report.fistweaving.single++;
          else report.fistweaving.double++;
        }
      }

      // Offhand: one round per timer; 1 or 2 attacks (no triple)
      if (dualWielding && tMs >= nextSwing2Ms) {
        nextSwing2Ms = tMs + delay2Ms;
        const duelistOhRound = duelist && tMs >= duelistStartMs && tMs < duelistEndMs;
        const innerFlameOhRound = innerFlame && tMs >= innerFlameStartMs && tMs < innerFlameEndMs;
        const disciplineActiveOh = duelistOhRound || innerFlameOhRound;
        if (checkDualWield(dualWieldEffective, rng)) {
          report.weapon2.rounds++;
          let attacksThisRound = 1;
          let offhandHitThisRound = false;
          if (rollHit(toHit, avoidance, rng, fromBehind)) {
            offhandHitThisRound = true;
            const ohElemAdder = getElementalBaseAdder(w2, options, rng);
            report.elementalDamageTotal += ohElemAdder;
            let ohBase = cappedW2Damage + ohElemAdder;
            ohBase = applyDisciplineDamageMod(ohBase, disciplineActiveOh);
            let dmg = calcMeleeDamage(ohBase, offenseRating, mitigation, rng, 0);
            const mult = rollDamageMultiplier(offenseRating, dmg, level, options.classId, false, rng);
            dmg = mult.damage;
            const beforeCrit = dmg;
            const critResult = rollMeleeCrit(dmg, 0, level, options.classId, options.dex, options.critChanceMult, false, false, 0, rng);
            dmg = critResult.damage;
            if (critResult.isCrit) { report.critHits++; report.critDamageGain += (dmg - beforeCrit); }
            const ohDisciplineMin = getDisciplineMinHit(cappedW2Damage, 0, disciplineActiveOh);
            if (ohDisciplineMin != null && dmg < ohDisciplineMin) dmg = ohDisciplineMin;
            report.weapon2.swings++;
            report.weapon2.hits++;
            report.weapon2.totalDamage += dmg;
            report.weapon2.maxDamage = Math.max(report.weapon2.maxDamage, dmg);
            report.weapon2.minDamage = Math.min(report.weapon2.minDamage, dmg);
            report.weapon2.hitList.push(dmg);
            report.totalDamage += dmg;
          } else {
            report.weapon2.swings++;
          }
          if (checkDoubleAttack(doubleAttackEffective, rng, options.classId)) {
            attacksThisRound = 2;
            if (rollHit(toHit, avoidance, rng, fromBehind)) {
              offhandHitThisRound = true;
              const ohElemAdder2 = getElementalBaseAdder(w2, options, rng);
              report.elementalDamageTotal += ohElemAdder2;
              let ohBase2 = cappedW2Damage + ohElemAdder2;
              ohBase2 = applyDisciplineDamageMod(ohBase2, disciplineActiveOh);
              let dmg = calcMeleeDamage(ohBase2, offenseRating, mitigation, rng, 0);
              const mult = rollDamageMultiplier(offenseRating, dmg, level, options.classId, false, rng);
              dmg = mult.damage;
              const beforeCrit = dmg;
              const critResult = rollMeleeCrit(dmg, 0, level, options.classId, options.dex, options.critChanceMult, false, false, 0, rng);
              dmg = critResult.damage;
              if (critResult.isCrit) { report.critHits++; report.critDamageGain += (dmg - beforeCrit); }
              const ohDisciplineMin2 = getDisciplineMinHit(cappedW2Damage, 0, disciplineActiveOh);
              if (ohDisciplineMin2 != null && dmg < ohDisciplineMin2) dmg = ohDisciplineMin2;
              report.weapon2.swings++;
              report.weapon2.hits++;
              report.weapon2.totalDamage += dmg;
              report.weapon2.maxDamage = Math.max(report.weapon2.maxDamage, dmg);
              report.weapon2.minDamage = Math.min(report.weapon2.minDamage, dmg);
              report.weapon2.hitList.push(dmg);
              report.totalDamage += dmg;
            } else {
              report.weapon2.swings++;
            }
          }
          // Proc once per round (only if at least one hit landed)
          if ( procChance2 > 0 && checkProc(procChance2, procRng)) {
            report.weapon2.procs++;
            const procDmg = (w2.procSpellDamage != null ? w2.procSpellDamage : 0) | 0;
            const effectiveness = getProcSpellEffectiveness(w2, options, level, procRng);
            if (procBuffTicks2 > 0 && procDmg > 0) {
              perTick2 = (procDmg / procBuffTicks2) * effectiveness / 100;
              if (dotEndMs2 > lastProcMs2) {
                const ticksRan = Math.floor((Math.min(dotEndMs2, tMs) - lastProcMs2) / PROC_TICK_INTERVAL_MS);
                const dotDmg = Math.floor(ticksRan * perTick2);
                if (dotDmg > 0) {
                  report.weapon2.procDamageTotal += dotDmg;
                  report.totalDamage += dotDmg;
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
              if (actualDmg === 0) {
                report.weapon2.procFullResists++;
                report.weapon2.procResists++;
                report.weapon2.procResistDamageLost += procDmg;
              } else if (actualDmg < procDmg) {
                report.weapon2.procPartialResists++;
                report.weapon2.procResists++;
                report.weapon2.procResistDamageLost += (procDmg - actualDmg);
              }
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
      if (dotDmg > 0) {
        report.weapon1.procDamageTotal += dotDmg;
        report.totalDamage += dotDmg;
      }
    }
    if (procBuffTicks2 > 0 && dotEndMs2 > lastProcMs2 && perTick2 > 0) {
      const ticksRan = Math.floor((Math.min(dotEndMs2, durationMs) - lastProcMs2) / PROC_TICK_INTERVAL_MS);
      const dotDmg = Math.floor(ticksRan * perTick2);
      if (dotDmg > 0) {
        report.weapon2.procDamageTotal += dotDmg;
        report.totalDamage += dotDmg;
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

    // 1. Executive Summary
    lines.push('=== Executive Summary ===', '');
    lines.push(`  Duration:              ${dur} seconds`);
    lines.push(`  Runs averaged:        ${runs}`);
    lines.push(`  Total DPS:            ${totalDPS}`);
    lines.push(`  Total damage:         ${report.totalDamage}`);
    if (report.critHits != null && report.critHits >= 0) lines.push(`  Critical hits:         ${report.critHits}`);
    if (report.critDamageGain != null && report.critDamageGain >= 0) {
      lines.push(`  Crit DPS gain:         ${(report.critDamageGain / dur).toFixed(2)} (vs non-crit baseline)`);
    }
    if (report.elementalDamageTotal != null && report.elementalDamageTotal > 0) {
      lines.push(`  Elemental damage:     ${report.elementalDamageTotal}`);
    }
    lines.push('');

    // 2. Offense & To-Hit Model
    lines.push('=== Offense & To-Hit Model ===', '');
    if (report.calculatedToHit != null) lines.push(`  Calculated to-hit:     ${report.calculatedToHit}`);
    if (report.offenseSkill != null) lines.push(`  Offense skill:         ${report.offenseSkill}  (0–255, used for to-hit only)`);
    if (report.offenseRating != null) lines.push(`  Offense rating:        ${report.offenseRating}  (used for damage)`);
    if (report.offenseRatingFromStr != null) lines.push(`    From STR:            ${report.offenseRatingFromStr}`);
    if (report.offenseRating != null && report.offenseRatingFromStr != null) {
      const other = report.offenseRating - report.offenseRatingFromStr;
      lines.push(`    From other:          ${other}  (skill + worn + spell)`);
    }
    if (report.displayedAttack != null) lines.push(`  Displayed ATK:         ${report.displayedAttack}`);
    lines.push('  ATK formula:           (offense rating + toHit) * 1000 / 744');
    if (report.rawHastePercent != null || report.effectiveHastePercent != null) {
      const raw = report.rawHastePercent != null ? Number(report.rawHastePercent).toFixed(1) : '—';
      const eff = report.effectiveHastePercent != null ? Number(report.effectiveHastePercent).toFixed(1) : '—';
      lines.push(`  Haste (raw / effective): ${raw}% / ${eff}%`);
    }
    lines.push('');

    // 3. Weapon Overview
    lines.push('=== Weapon Overview ===', '');
    lines.push(`  ${weapon1Label || 'Weapon 1'}`);
    if (report.damageBonus != null) lines.push(`    Damage bonus:        ${report.damageBonus}`);
    if (report.damageBonusTotal != null && report.damageBonusTotal > 0) lines.push(`    Damage from bonus:   ${report.damageBonusTotal}`);
    lines.push(`    Total damage:       ${w1.totalDamage}`);
    lines.push(`    Weapon DPS:          ${(w1.totalDamage / dur).toFixed(2)}`);
    lines.push('');
    if (w2.swings > 0) {
      lines.push(`  ${weapon2Label || 'Weapon 2'}`);
      lines.push(`    Total damage:       ${w2.totalDamage}`);
      lines.push(`    Weapon DPS:          ${(w2.totalDamage / dur).toFixed(2)}`);
      lines.push('');
    }

    // 4. Attack Distribution (Weapon 1)
    lines.push('=== Attack Distribution ===', '');
    lines.push(`  ${weapon1Label || 'Weapon 1'}`, '');
    const r1 = w1.rounds != null ? w1.rounds : w1.swings;
    lines.push(`    Combat rounds:       ${r1}`);
    if (r1 > 0) {
      const single1 = w1.single != null ? w1.single : 0;
      const double1 = w1.double != null ? w1.double : 0;
      const triple1 = w1.triple != null ? w1.triple : 0;
      lines.push(`    Single / Double / Triple (%):  ${(single1 / r1 * 100).toFixed(1)}% / ${(double1 / r1 * 100).toFixed(1)}% / ${(triple1 / r1 * 100).toFixed(1)}%`);
    }
    lines.push(`    Single attacks:      ${w1.single != null ? w1.single : '—'}`);
    lines.push(`    Double attacks:      ${w1.double != null ? w1.double : '—'}`);
    lines.push(`    Triple attacks:      ${w1.triple != null ? w1.triple : '—'}`);
    lines.push(`    Swings:              ${w1.swings}`);
    lines.push(`    Hits:                ${w1.hits}`);
    if (w1.swings > 0) lines.push(`    Accuracy:             ${(w1.hits / w1.swings * 100).toFixed(1)}%`);
    lines.push('');
    if (w2.swings > 0) {
      lines.push(`  ${weapon2Label || 'Weapon 2'}`, '');
      const r2 = w2.rounds != null ? w2.rounds : w2.swings;
      lines.push(`    Combat rounds:       ${r2}`);
      if (r2 > 0) {
        const single2 = w2.single != null ? w2.single : 0;
        const double2 = w2.double != null ? w2.double : 0;
        lines.push(`    Single / Double (%):  ${(single2 / r2 * 100).toFixed(1)}% / ${(double2 / r2 * 100).toFixed(1)}%`);
      }
      lines.push(`    Single attacks:      ${w2.single != null ? w2.single : '—'}`);
      lines.push(`    Double attacks:      ${w2.double != null ? w2.double : '—'}`);
      lines.push(`    Swings:              ${w2.swings}`);
      lines.push(`    Hits:                ${w2.hits}`);
      if (w2.swings > 0) lines.push(`    Accuracy:             ${(w2.hits / w2.swings * 100).toFixed(1)}%`);
      lines.push('');
    }

    // 5. Hit Damage Statistics
    lines.push('=== Hit Damage Statistics ===', '');
    lines.push(`  ${weapon1Label || 'Weapon 1'}`);
    lines.push(`    Max hit:             ${formatHitStat(s1.max != null ? s1.max : w1.maxDamage)}`);
    lines.push(`    Min hit:             ${formatHitStat(s1.min)}`);
    lines.push(`    Mean hit:            ${formatHitStat(s1.mean)}`);
    lines.push(`    Median hit:          ${formatHitStat(s1.median)}`);
    lines.push(`    Mode hit:            ${formatHitStat(s1.mode)}`);
    lines.push('');
    if (w2.swings > 0) {
      lines.push(`  ${weapon2Label || 'Weapon 2'}`);
      lines.push(`    Max hit:             ${formatHitStat(s2.max != null ? s2.max : w2.maxDamage)}`);
      lines.push(`    Min hit:             ${formatHitStat(s2.min)}`);
      lines.push(`    Mean hit:            ${formatHitStat(s2.mean)}`);
      lines.push(`    Median hit:          ${formatHitStat(s2.median)}`);
      lines.push(`    Mode hit:            ${formatHitStat(s2.mode)}`);
      lines.push('');
    }

    // 6. Procs & Specials
    lines.push('=== Procs & Specials ===', '');
    lines.push(`  ${weapon1Label || 'Weapon 1'}`);
    if (w1.anticipatedProcsPerMinute != null) lines.push(`    Anticipated procs per minute: ${w1.anticipatedProcsPerMinute.toFixed(2)}`);
    if (w1.anticipatedProcChancePerRound != null) lines.push(`    Anticipated proc chance per round: ${(w1.anticipatedProcChancePerRound * 100).toFixed(2)}%`);
    if (w1.procs != null) lines.push(`    Procs:               ${w1.procs}`);
    lines.push(`    Proc damage:         ${w1.procDamageTotal != null ? w1.procDamageTotal : 0}`);
    lines.push(`    Proc DPS:            ${(w1.procDamageTotal != null && dur > 0) ? (w1.procDamageTotal / dur).toFixed(2) : '0.00'}`);
    lines.push(`    Proc full resists:   ${w1.procFullResists != null ? w1.procFullResists : 0}`);
    lines.push(`    Proc partial resists: ${w1.procPartialResists != null ? w1.procPartialResists : 0}`);
    if (w1.procLevelBlocked) {
      lines.push(`    Proc gated by level: yes (level ${w1.procLevelCurrent != null ? w1.procLevelCurrent : '-'} < required ${w1.procLevelRequired != null ? w1.procLevelRequired : '-'})`);
    }
    if (w1.procResistDamageLost != null && w1.procResistDamageLost > 0) {
      lines.push(`    Proc damage lost (resists): ${w1.procResistDamageLost}`);
    }
    if (w1.spellProcCrits != null) lines.push(`    Proc spell crits (SCF):  ${w1.spellProcCrits}`);
    if (w1.maxSpellProcCritDmg != null && w1.maxSpellProcCritDmg > 0) lines.push(`    Max spell proc crit dmg:  ${w1.maxSpellProcCritDmg}`);
    if (w2.swings > 0) {
      lines.push(`  ${weapon2Label || 'Weapon 2'}`);
      if (w2.anticipatedProcsPerMinute != null) lines.push(`    Anticipated procs per minute: ${w2.anticipatedProcsPerMinute.toFixed(2)}`);
      if (w2.anticipatedProcChancePerRound != null) lines.push(`    Anticipated proc chance per round: ${(w2.anticipatedProcChancePerRound * 100).toFixed(2)}%`);
      if (w2.procs != null) lines.push(`    Procs:               ${w2.procs}`);
      lines.push(`    Proc damage:         ${w2.procDamageTotal != null ? w2.procDamageTotal : 0}`);
      lines.push(`    Proc DPS:            ${(w2.procDamageTotal != null && dur > 0) ? (w2.procDamageTotal / dur).toFixed(2) : '0.00'}`);
      lines.push(`    Proc full resists:   ${w2.procFullResists != null ? w2.procFullResists : 0}`);
      lines.push(`    Proc partial resists: ${w2.procPartialResists != null ? w2.procPartialResists : 0}`);
      if (w2.procLevelBlocked) {
        lines.push(`    Proc gated by level: yes (level ${w2.procLevelCurrent != null ? w2.procLevelCurrent : '-'} < required ${w2.procLevelRequired != null ? w2.procLevelRequired : '-'})`);
      }
      if (w2.procResistDamageLost != null && w2.procResistDamageLost > 0) {
        lines.push(`    Proc damage lost (resists): ${w2.procResistDamageLost}`);
      }
      if (w2.spellProcCrits != null) lines.push(`    Proc spell crits (SCF):  ${w2.spellProcCrits}`);
      if (w2.maxSpellProcCritDmg != null && w2.maxSpellProcCritDmg > 0) lines.push(`    Max spell proc crit dmg:  ${w2.maxSpellProcCritDmg}`);
    }
    if (report.special && (report.special.count > 0 || (report.special.attempts != null && report.special.attempts > 0))) {
      const sp = report.special;
      const a = sp.attempts != null ? sp.attempts : 0;
      const h = sp.hits != null ? sp.hits : sp.count;
      const D = sp.doubleBackstabs != null ? sp.doubleBackstabs : 0;
      const singleBackstabRounds = Math.max(0, a - D);
      const totalBackstabAttempts = sp.doubleBackstabs !== undefined ? (singleBackstabRounds + 2 * D) : a;
      const attemptedAttacks = sp.attemptedAttacks != null ? sp.attemptedAttacks : totalBackstabAttempts;
      const acc = totalBackstabAttempts > 0 ? (h / totalBackstabAttempts * 100).toFixed(1) : '0';
      const dpsLabel = sp.name === 'Backstab' ? 'DPS from backstab' : 'DPS';
      lines.push(`  ${sp.name}`);
      if (sp.name === 'Backstab') {
        lines.push(`    Number of backstab rounds: ${a}`);
        if (sp.doubleBackstabs !== undefined) lines.push(`    Backstab swings: ${totalBackstabAttempts}`);
      } else {
        lines.push(`    Attempts:            ${a}`);
      }
      if (sp.doubleBackstabs !== undefined) {
        lines.push(`    Single backstab rounds:   ${singleBackstabRounds}`);
        lines.push(`    Double backstab rounds:   ${D}`);
      }
      lines.push(`    ${sp.name === 'Backstab' ? 'Backstab hits landed' : 'Hits landed'}:        ${h}`);
      lines.push(`    Accuracy:           ${acc}%`);
      if (sp.effectiveReuseSec != null && sp.effectiveReuseSec > 0) {
        lines.push(`    Effective special attack delay: ${sp.effectiveReuseSec.toFixed(2)}s`);
      }
      lines.push(`    Total damage:       ${sp.totalDamage}`);
      lines.push(`    Max hit:            ${sp.maxDamage}`);
      lines.push(`    ${dpsLabel}:          ${(sp.totalDamage / dur).toFixed(2)}`);
      if (sp.backstabSkill != null) {
        const effectiveSkill = Math.min(255, Math.floor(sp.backstabSkill * (100 + (sp.backstabModPercent || 0)) / 100));
        lines.push(`    Effective backstab skill: ${effectiveSkill}`);
        if ((sp.backstabModPercent || 0) > 0) {
          lines.push(`    Backstab weapon modifier applied: +${sp.backstabModPercent}%`);
        }
      }
    }
    if (report.fistweaving && report.fistweaving.rounds > 0) {
      const fw = report.fistweaving;
      const fwAcc = fw.swings > 0 ? (fw.hits / fw.swings * 100).toFixed(1) : '0';
      lines.push('  Fistweaving (9 dmg, no proc)');
      lines.push(`    Rounds:              ${fw.rounds}`);
      lines.push(`    Single / Double:     ${fw.single ?? '—'} / ${fw.double ?? '—'}`);
      lines.push(`    Swings:              ${fw.swings}`);
      lines.push(`    Hits:                ${fw.hits}`);
      lines.push(`    Accuracy:            ${fwAcc}%`);
      lines.push(`    Total damage:       ${fw.totalDamage}`);
      lines.push(`    DPS:                 ${(fw.totalDamage / dur).toFixed(2)}`);
    }
    lines.push('');

    // 7. Final Totals
    lines.push('=== Final Totals ===', '');
    lines.push(`  Total damage:         ${report.totalDamage}`);
    lines.push(`  Total DPS:            ${totalDPS}`);
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
  };
})(typeof window !== 'undefined' ? window : typeof self !== 'undefined' ? self : this);
