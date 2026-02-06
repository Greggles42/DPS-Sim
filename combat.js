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

  // Elemental damage vs target resistance: if resist > 200 return 0; roll = random(1,201) - resist; if roll < 1 return 0; if roll <= 99 return weaponDamage * roll / 100; else return weaponDamage
  function applyElementalResist(weaponDamage, resistValue, rng) {
    if (resistValue > 200) return 0;
    const roll = Math.floor(rng() * 201) + 1 - resistValue;
    if (roll < 1) return 0;
    if (roll <= 99) return Math.floor(weaponDamage * roll / 100);
    return weaponDamage;
  }

  function getResistForElemType(options, elemType) {
    const key = elemType === 'fire' ? 'targetFR' : elemType === 'cold' ? 'targetCR' : elemType === 'poison' ? 'targetPR' : elemType === 'disease' ? 'targetDR' : elemType === 'magic' ? 'targetMR' : null;
    return key != null && options[key] != null ? options[key] : 35;
  }

  function addElementalToDamage(dmg, weapon, options, rng) {
    if (!weapon || !weapon.elemType || !(weapon.elemDamage > 0)) return { dmg, elementalAdded: 0 };
    const resist = getResistForElemType(options, weapon.elemType);
    const added = applyElementalResist(weapon.elemDamage, resist, rng);
    return { dmg: dmg + added, elementalAdded: added };
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
      if (level >= 55 && damage > 1 && !isArchery && classId === 'warrior') damage++;
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
  function effectiveDelayDecisec(delay, hastePercent) {
    const hasteMod = 1 + (hastePercent || 0) / 100;
    return Math.max(10, delay / hasteMod); // min delay often 10 (1 sec)
  }

  // ----- Proc chance (server formula) -----
  // chance = (0.0004166667 + 1.1437908496732e-5 * dex) * weapon_speed; offhand: chance *= 50 / GetDualWieldChance().
  // weapon_speed = effective delay (deciseconds). dualWieldChance = 0..100 (same scale as GetDualWieldChance).
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

  // ----- Special attacks (Flying Kick, Backstab, etc.) -----
  // Flying Kick uses skill/level-based base only (EQMacEmu: GetSkillBaseDamage + min level*4/5), not primary weapon. Flying Kick Base damage is 29
  const SPECIAL_ATTACKS = {
    monk: { name: 'Flying Kick', cooldownDecisec: 80, useWeaponDamage: false },
    rogue: { name: 'Backstab', cooldownDecisec: 120, fromBehindOnly: true },
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

    const delayDecisec = effectiveDelayDecisec(bow.delay, options.hastePercent);
    const procChance = (bow.procSpell != null && bow.procSpell !== '')
      ? getProcChancePerSwing(delayDecisec, false, 0, options.dex || 150)
      : 0;
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
      },
      durationSec: options.fightDurationSec,
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

    const durationDecisec = Math.floor(options.fightDurationSec * 10);
    let nextRangedAt = 0;

    while (nextRangedAt < durationDecisec) {
      report.ranged.swings++;
      const hit = rollHit(toHit, avoidance, rng, true);
      if (!hit) {
        nextRangedAt += delayDecisec;
        continue;
      }
      report.ranged.hits++;
      let baseDmg = calcMeleeDamage(baseDamagePerShot, offenseRating, mitigation, rng, 0);
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
      if (procChance > 0 && checkProc(procChance, procRng)) {
        report.ranged.procs++;
        const procDmg = (bow.procSpellDamage != null ? bow.procSpellDamage : 0) || 0;
        report.ranged.procDamageTotal += procDmg;
        dmg += procDmg;
      }
      let er = addElementalToDamage(dmg, bow, options, rng);
      dmg = er.dmg;
      report.elementalDamageTotal += er.elementalAdded;
      er = addElementalToDamage(dmg, arrow, options, rng);
      dmg = er.dmg;
      report.elementalDamageTotal += er.elementalAdded;
      report.ranged.totalDamage += dmg;
      report.totalDamage += dmg;
      report.ranged.maxDamage = Math.max(report.ranged.maxDamage, dmg);
      if (dmg < report.ranged.minDamage) report.ranged.minDamage = dmg;
      report.ranged.hitList.push(dmg);
      nextRangedAt += delayDecisec;
    }

    if (report.ranged.minDamage === Infinity) report.ranged.minDamage = null;
    return report;
  }

  function formatRangedReport(report) {
    if (report.error) return report.error;
    const r = report.ranged;
    const lines = [
      '--- Ranged Combat Report ---',
      `Duration: ${report.durationSec} seconds`,
      report.calculatedToHit != null ? `Calculated To Hit: ${report.calculatedToHit}` : '',
      report.offenseRating != null ? `Offense rating (for damage): ${report.offenseRating}` : '',
      report.displayedAttack != null ? `Displayed Attack: ${report.displayedAttack}  ( (offense rating + toHit) * 1000 / 744 )` : '',
      '',
      'Ranged',
      `  Shots: ${r.swings}`,
      `  Hits: ${r.hits}`,
      r.swings > 0 ? `  Accuracy: ${(r.hits / r.swings * 100).toFixed(1)}%` : '',
      `  Total damage: ${r.totalDamage}`,
      `  Max hit: ${r.maxDamage != null ? r.maxDamage : '—'}`,
      `  Min hit: ${r.minDamage != null ? r.minDamage : '—'}`,
      r.procs != null ? `  Procs: ${r.procs}` : '',
      (r.procDamageTotal != null && r.procDamageTotal > 0) ? `  Proc spell damage: ${r.procDamageTotal}` : '',
      '',
      `Total damage: ${report.totalDamage}`,
      `DPS: ${(report.totalDamage / report.durationSec).toFixed(2)}`,
    ];
    if (report.critHits != null && report.critHits >= 0) {
      lines.splice(lines.length - 2, 0, `Critical hits: ${report.critHits}`);
      if (report.critDamageGain != null) {
        lines.splice(lines.length - 2, 0, `Net DPS from criticals: ${(report.critDamageGain / report.durationSec).toFixed(2)}`);
      }
    }
    if (report.wallPenaltyDamageLost != null && report.wallPenaltyDamageLost >= 0) {
      lines.splice(lines.length - 2, 0, `Damage lost to wall penalty: ${report.wallPenaltyDamageLost}`);
    }
    if (report.elementalDamageTotal != null && report.elementalDamageTotal > 0) {
      lines.splice(lines.length - 2, 0, `Elemental damage: ${report.elementalDamageTotal}`);
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
   * @param {Object} options.weapon1 - { damage, delay, procSpell?, procSpellDamage?, is2H? }
   * @param {Object} [options.weapon2] - optional offhand
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
   * @param {number} [options.backstabModPercent] - rogue only: increase effective backstab skill by this % (e.g. 20 for 20%), capped at 255
   * @param {number} [options.backstabSkill] - rogue only: backstab skill for base damage (skill*0.02+2)*weapon_damage; also enforces minHit by level
   * @param {number} [options.seed] - optional RNG seed for reproducibility
   * @param {number} [options.critChanceMult] - AA Critical Hit Chance bonus (percent)
   */
  function runFight(options) {
    const fromBehind = !!options.fromBehind;
    const rng = createRng(options.seed);
    const procRng = createRng(options.seed != null ? options.seed + 12345 : undefined);
    const specialConfig = (options.specialAttacks && options.classId && SPECIAL_ATTACKS[options.classId])
      ? SPECIAL_ATTACKS[options.classId]
      : null;
    const canFireSpecial = specialConfig && (!specialConfig.fromBehindOnly || fromBehind);
    const level = options.level != null ? options.level : 60;
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
    // To Hit: 7 + offense SKILL + weapon skill (252). Offense RATING (for damage roll) = offense skill + STR bonus + worn attack + spell attack.
    const OFFENSE_SKILL = options.offenseSkill != null ? Math.min(255, Math.max(0, options.offenseSkill)) : 252;
    const WEAPON_SKILL_FOR_TOHIT = 252;
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
    const mainHandDamageBonus = getDamageBonusClient(level, options.classId, w1.delay, !!w1.is2H);
    const dualWielding = !!w2 && (options.dualWieldSkill != null && options.dualWieldSkill > 0) &&
      options.classId !== 'paladin' && options.classId !== 'shadowknight';

    const delay1 = effectiveDelayDecisec(w1.delay, options.hastePercent);
    const delay2 = w2 ? effectiveDelayDecisec(w2.delay, options.hastePercent) : 0;

    const procChance1 = w1.procSpell != null
      ? getProcChancePerSwing(delay1, false, dualWieldPct, options.dex || 150)
      : 0;
    const procChance2 = w2 && w2.procSpell != null
      ? getProcChancePerSwing(delay2, true, dualWieldPct, options.dex || 150)
      : 0;

    const report = {
      weapon1: { swings: 0, hits: 0, totalDamage: 0, maxDamage: 0, minDamage: Infinity, hitList: [], procs: 0, procDamageTotal: 0, rounds: 0, single: 0, double: 0, triple: 0 },
      weapon2: { swings: 0, hits: 0, totalDamage: 0, maxDamage: 0, minDamage: Infinity, hitList: [], procs: 0, procDamageTotal: 0, rounds: 0, single: 0, double: 0, triple: 0 },
      durationSec: options.fightDurationSec,
      totalDamage: 0,
      elementalDamageTotal: 0,
      damageBonus: mainHandDamageBonus,
      damageBonusTotal: 0,
      calculatedToHit: toHit,
      offenseSkill: OFFENSE_SKILL,
      offenseRating: offenseRating,
      offenseRatingFromStr: strBonus,
      displayedAttack: Math.floor((offenseRating + toHit) * 1000 / 744),
      critHits: 0,
      critDamageGain: 0,
      special: canFireSpecial ? {
        name: specialConfig.name,
        count: 0,
        attempts: 0,
        hits: 0,
        totalDamage: 0,
        maxDamage: 0,
        hitList: [],
        doubleBackstabs: options.classId === 'rogue' ? 0 : undefined,
        backstabSkill: options.classId === 'rogue' ? Math.min(255, options.backstabSkill != null ? options.backstabSkill : 225) : undefined,
        backstabModPercent: options.classId === 'rogue' ? (options.backstabModPercent || 0) : undefined,
      } : null,
      fistweaving: (options.classId === 'monk' && w1.is2H && options.fistweaving) ? { rounds: 0, swings: 0, hits: 0, totalDamage: 0, maxDamage: 0, single: 0, double: 0 } : null,
    };

    const durationDecisec = Math.floor(options.fightDurationSec * 10);
    let nextSwing1 = 0;
    let nextSwing2 = dualWielding ? Math.floor(rng() * delay2) : Infinity;
    let nextSpecialAt = 0;

    // Each swing: (1) AvoidanceCheck: rollHit(toHit, avoidance) → hit or miss. (2) If hit: CalcMeleeDamage uses RollD20(offense, mitigation) → damage. Avoidance and mitigation are checked every time.
    for (let t = 0; t < durationDecisec; t++) {
      // Special attack (Flying Kick / Backstab) on cooldown
      if (canFireSpecial && report.special && t >= nextSpecialAt) {
        report.special.attempts++;
        const isRogueBackstab = options.classId === 'rogue' && specialConfig.fromBehindOnly;
        const specialHits = rollHit(toHit, avoidance, rng, fromBehind);
        if (specialHits) {
          report.special.hits++;
          report.special.count++;
          let baseDmg;
          if (isRogueBackstab) {
            const backstabSkill = options.backstabSkill != null ? options.backstabSkill : 225;
            const backstabModPct = options.backstabModPercent || 0;
            const effectiveSkill = Math.min(255, Math.floor(backstabSkill * (100 + backstabModPct) / 100));
            const backstabBase = Math.floor(((effectiveSkill * 0.02) + 2) * w1.damage);
            baseDmg = calcMeleeDamage(backstabBase, offenseRating, mitigation, rng, 0);
            baseDmg = Math.max(1, baseDmg);
          } else if (options.classId === 'monk' && specialConfig.useWeaponDamage === false) {
            // Flying Kick: level-based base only (EQMacEmu base 29, min_dmg = level*4/5)
            const fkBase = 29;
            baseDmg = calcMeleeDamage(fkBase, offenseRating, mitigation, rng, 0);
            const fkMin = Math.floor(level * 4 / 5);
            baseDmg = Math.max(1, Math.max(baseDmg, fkMin));
          } else {
            baseDmg = calcMeleeDamage(w1.damage, offenseRating, mitigation, rng);
            baseDmg = Math.max(1, specialConfig.damageMultiplier ? Math.floor(baseDmg * specialConfig.damageMultiplier) : baseDmg);
          }
          const mult = rollDamageMultiplier(offenseRating, baseDmg, level, options.classId, false, rng);
          let dmg = mult.damage;
          const beforeCrit = dmg;
          // Crit is only rolled after a successful hit (we are inside specialHits here).
          const critResult = rollMeleeCrit(dmg, 0, level, options.classId, options.dex, options.critChanceMult, false, false, 0, rng);
          dmg = critResult.damage;
          if (critResult.isCrit) { report.critHits++; report.critDamageGain += (dmg - beforeCrit); }
          if (isRogueBackstab && level != null) {
            const minHit = level >= 60 ? level * 2 : level > 50 ? Math.floor(level * 3 / 2) : level;
            dmg = Math.max(dmg, minHit);
          }
          const er = addElementalToDamage(dmg, w1, options, rng);
          dmg = er.dmg;
          report.elementalDamageTotal += er.elementalAdded;
          report.special.totalDamage += dmg;
          report.special.maxDamage = Math.max(report.special.maxDamage, dmg);
          report.special.hitList.push(dmg);
          report.weapon1.totalDamage += dmg;
          report.totalDamage += dmg;

          // Rogues 55+ can double backstab: same double attack skill chance for a second backstab
          if (isRogueBackstab && level > 54 && report.special.doubleBackstabs !== undefined && checkDoubleAttack(doubleAttackEffective, rng, options.classId)) {
            const secondHit = rollHit(toHit, avoidance, rng, fromBehind);
            if (secondHit) {
              report.special.doubleBackstabs++;
              report.special.hits++;
              report.special.count++;
              const backstabSkill2 = options.backstabSkill != null ? options.backstabSkill : 225;
              const backstabModPct2 = options.backstabModPercent || 0;
              const effectiveSkill2 = Math.min(255, Math.floor(backstabSkill2 * (100 + backstabModPct2) / 100));
              const backstabBase2 = Math.floor(((effectiveSkill2 * 0.02) + 2) * w1.damage);
              let baseDmg2 = calcMeleeDamage(backstabBase2, offenseRating, mitigation, rng, 0);
              baseDmg2 = Math.max(1, baseDmg2);
              const mult2 = rollDamageMultiplier(offenseRating, baseDmg2, level, options.classId, false, rng);
              let dmg2 = mult2.damage;
              const beforeCrit2 = dmg2;
              const critResult2 = rollMeleeCrit(dmg2, 0, level, options.classId, options.dex, options.critChanceMult, false, false, 0, rng);
              dmg2 = critResult2.damage;
              if (critResult2.isCrit) { report.critHits++; report.critDamageGain += (dmg2 - beforeCrit2); }
              if (level != null) {
                const minHit = level >= 60 ? level * 2 : level > 50 ? Math.floor(level * 3 / 2) : level;
                dmg2 = Math.max(dmg2, minHit);
              }
              const er2 = addElementalToDamage(dmg2, w1, options, rng);
              dmg2 = er2.dmg;
              report.elementalDamageTotal += er2.elementalAdded;
              report.special.totalDamage += dmg2;
              report.special.maxDamage = Math.max(report.special.maxDamage, dmg2);
              report.special.hitList.push(dmg2);
              report.weapon1.totalDamage += dmg2;
              report.totalDamage += dmg2;
            }
          }
        }
        nextSpecialAt = t + specialConfig.cooldownDecisec;
      }

      // Main hand (one round = one swing opportunity; 1, 2, or 3 attacks per round)
      if (t >= nextSwing1) {
        report.weapon1.rounds++;
        nextSwing1 = t + delay1;
        let attacksThisRound = 1;

        // Crit is only rolled after a successful hit (we are inside the rollHit success block).
        if (rollHit(toHit, avoidance, rng, fromBehind)) {
          let dmg = calcMeleeDamage(w1.damage, offenseRating, mitigation, rng, 0);
          const mult = rollDamageMultiplier(offenseRating, dmg, level, options.classId, false, rng);
          dmg = mult.damage;
          dmg += mainHandDamageBonus;
          dmg = Math.max(dmg, 1 + mainHandDamageBonus);
          const beforeCrit = dmg;
          const critResult = rollMeleeCrit(dmg, mainHandDamageBonus, level, options.classId, options.dex, options.critChanceMult, false, false, 0, rng);
          dmg = critResult.damage;
          dmg = Math.max(dmg, 1 + mainHandDamageBonus);
          if (critResult.isCrit) { report.critHits++; report.critDamageGain += (dmg - beforeCrit); }
          const er = addElementalToDamage(dmg, w1, options, rng);
          dmg = er.dmg;
          report.elementalDamageTotal += er.elementalAdded;
          report.weapon1.swings++;
          report.weapon1.hits++;
          report.weapon1.totalDamage += dmg;
          report.weapon1.maxDamage = Math.max(report.weapon1.maxDamage, dmg);
          report.weapon1.minDamage = Math.min(report.weapon1.minDamage, dmg);
          report.weapon1.hitList.push(dmg);
          report.totalDamage += dmg;
          report.damageBonusTotal += mainHandDamageBonus;
          if (checkProc(procChance1, procRng)) {
            report.weapon1.procs++;
            const procDmg = (w1.procSpellDamage != null ? w1.procSpellDamage : 0) | 0;
            report.weapon1.procDamageTotal += procDmg;
            report.totalDamage += procDmg;
          }
        } else {
          report.weapon1.swings++;
        }

        if (checkDoubleAttack(doubleAttackEffective, rng, options.classId)) {
          attacksThisRound = 2;
          if (rollHit(toHit, avoidance, rng, fromBehind)) {
            let dmg = calcMeleeDamage(w1.damage, offenseRating, mitigation, rng, 0);
            const mult = rollDamageMultiplier(offenseRating, dmg, level, options.classId, false, rng);
            dmg = mult.damage;
            dmg += mainHandDamageBonus;
            dmg = Math.max(dmg, 1 + mainHandDamageBonus);
            const beforeCrit = dmg;
            const critResult = rollMeleeCrit(dmg, mainHandDamageBonus, level, options.classId, options.dex, options.critChanceMult, false, false, 0, rng);
            dmg = critResult.damage;
            dmg = Math.max(dmg, 1 + mainHandDamageBonus);
            if (critResult.isCrit) { report.critHits++; report.critDamageGain += (dmg - beforeCrit); }
            const er = addElementalToDamage(dmg, w1, options, rng);
            dmg = er.dmg;
            report.elementalDamageTotal += er.elementalAdded;
            report.weapon1.swings++;
            report.weapon1.hits++;
            report.weapon1.totalDamage += dmg;
            report.weapon1.maxDamage = Math.max(report.weapon1.maxDamage, dmg);
            report.weapon1.minDamage = Math.min(report.weapon1.minDamage, dmg);
            report.weapon1.hitList.push(dmg);
            report.totalDamage += dmg;
            report.damageBonusTotal += mainHandDamageBonus;
            if (checkProc(procChance1, procRng)) {
              report.weapon1.procs++;
              const procDmg = (w1.procSpellDamage != null ? w1.procSpellDamage : 0) | 0;
              report.weapon1.procDamageTotal += procDmg;
              report.totalDamage += procDmg;
            }
          } else {
            report.weapon1.swings++;
          }
          if (checkTripleAttack(rng, level, options.classId)) {
            attacksThisRound = 3;
            if (rollHit(toHit, avoidance, rng, fromBehind)) {
              let dmg = calcMeleeDamage(w1.damage, offenseRating, mitigation, rng, 0);
              const mult = rollDamageMultiplier(offenseRating, dmg, level, options.classId, false, rng);
              dmg = mult.damage;
              dmg += mainHandDamageBonus;
              dmg = Math.max(dmg, 1 + mainHandDamageBonus);
              const beforeCrit = dmg;
              const critResult = rollMeleeCrit(dmg, mainHandDamageBonus, level, options.classId, options.dex, options.critChanceMult, false, false, 0, rng);
              dmg = critResult.damage;
              dmg = Math.max(dmg, 1 + mainHandDamageBonus);
              if (critResult.isCrit) { report.critHits++; report.critDamageGain += (dmg - beforeCrit); }
              const er = addElementalToDamage(dmg, w1, options, rng);
              dmg = er.dmg;
              report.elementalDamageTotal += er.elementalAdded;
              report.weapon1.swings++;
              report.weapon1.hits++;
              report.weapon1.totalDamage += dmg;
              report.weapon1.maxDamage = Math.max(report.weapon1.maxDamage, dmg);
              report.weapon1.minDamage = Math.min(report.weapon1.minDamage, dmg);
              report.weapon1.hitList.push(dmg);
              report.totalDamage += dmg;
              report.damageBonusTotal += mainHandDamageBonus;
              if (checkProc(procChance1, procRng)) {
                report.weapon1.procs++;
                const procDmg = (w1.procSpellDamage != null ? w1.procSpellDamage : 0) | 0;
                report.weapon1.procDamageTotal += procDmg;
                report.totalDamage += procDmg;
              }
            } else {
              report.weapon1.swings++;
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
      if (dualWielding && t >= nextSwing2) {
        nextSwing2 = t + delay2;
        if (checkDualWield(dualWieldEffective, rng)) {
          report.weapon2.rounds++;
          let attacksThisRound = 1;
          if (rollHit(toHit, avoidance, rng, fromBehind)) {
            let dmg = calcMeleeDamage(w2.damage, offenseRating, mitigation, rng, 0);
            const mult = rollDamageMultiplier(offenseRating, dmg, level, options.classId, false, rng);
            dmg = mult.damage;
            const beforeCrit = dmg;
            const critResult = rollMeleeCrit(dmg, 0, level, options.classId, options.dex, options.critChanceMult, false, false, 0, rng);
            dmg = critResult.damage;
            if (critResult.isCrit) { report.critHits++; report.critDamageGain += (dmg - beforeCrit); }
            const er = addElementalToDamage(dmg, w2, options, rng);
            dmg = er.dmg;
            report.elementalDamageTotal += er.elementalAdded;
            report.weapon2.swings++;
            report.weapon2.hits++;
            report.weapon2.totalDamage += dmg;
            report.weapon2.maxDamage = Math.max(report.weapon2.maxDamage, dmg);
            report.weapon2.minDamage = Math.min(report.weapon2.minDamage, dmg);
            report.weapon2.hitList.push(dmg);
            report.totalDamage += dmg;
            if (checkProc(procChance2, procRng)) {
              report.weapon2.procs++;
              const procDmg = (w2.procSpellDamage != null ? w2.procSpellDamage : 0) | 0;
              report.weapon2.procDamageTotal += procDmg;
              report.totalDamage += procDmg;
            }
          } else {
            report.weapon2.swings++;
          }
          if (checkDoubleAttack(doubleAttackEffective, rng, options.classId)) {
            attacksThisRound = 2;
            if (rollHit(toHit, avoidance, rng, fromBehind)) {
              let dmg = calcMeleeDamage(w2.damage, offenseRating, mitigation, rng, 0);
              const mult = rollDamageMultiplier(offenseRating, dmg, level, options.classId, false, rng);
              dmg = mult.damage;
              const beforeCrit = dmg;
              const critResult = rollMeleeCrit(dmg, 0, level, options.classId, options.dex, options.critChanceMult, false, false, 0, rng);
              dmg = critResult.damage;
              if (critResult.isCrit) { report.critHits++; report.critDamageGain += (dmg - beforeCrit); }
              const er = addElementalToDamage(dmg, w2, options, rng);
              dmg = er.dmg;
              report.elementalDamageTotal += er.elementalAdded;
              report.weapon2.swings++;
              report.weapon2.hits++;
              report.weapon2.totalDamage += dmg;
              report.weapon2.maxDamage = Math.max(report.weapon2.maxDamage, dmg);
              report.weapon2.minDamage = Math.min(report.weapon2.minDamage, dmg);
              report.weapon2.hitList.push(dmg);
              report.totalDamage += dmg;
              if (checkProc(procChance2, procRng)) {
                report.weapon2.procs++;
                const procDmg = (w2.procSpellDamage != null ? w2.procSpellDamage : 0) | 0;
                report.weapon2.procDamageTotal += procDmg;
                report.totalDamage += procDmg;
              }
            } else {
              report.weapon2.swings++;
            }
          }
          if (attacksThisRound === 1) report.weapon2.single++;
          else report.weapon2.double++;
        }
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

  function formatReport(report, weapon1Label, weapon2Label) {
    const w1 = report.weapon1;
    const w2 = report.weapon2;
    const s1 = w1.hitStats || {};
    const s2 = w2.hitStats || {};
    const lines = [
      '--- Combat Report ---',
      `Duration: ${report.durationSec} seconds`,
      report.calculatedToHit != null ? `Calculated To Hit: ${report.calculatedToHit}` : '',
      report.offenseSkill != null ? `Offense skill (0–255, used in to-hit): ${report.offenseSkill}` : '',
      report.offenseRating != null ? `Offense rating (for damage): ${report.offenseRating}  (skill + STR + worn + spell)` : '',
      report.offenseRatingFromStr != null ? `Offense rating from stats (STR): ${report.offenseRatingFromStr}` : '',
      report.displayedAttack != null ? `Displayed Attack: ${report.displayedAttack}  ( (offense rating + toHit) * 1000 / 744 )` : '',
      report.damageBonus != null ? `Main hand damage bonus: ${report.damageBonus}` : '',
      report.damageBonusTotal != null && report.damageBonusTotal > 0 ? `Damage from bonus: ${report.damageBonusTotal}` : '',
      (report.critHits != null && report.critHits >= 0) ? `Critical hits: ${report.critHits}` : '',
      (report.critDamageGain != null && report.critDamageGain >= 0) ? `Net DPS from criticals (vs normal): ${(report.critDamageGain / report.durationSec).toFixed(2)}` : '',
      '',
      weapon1Label || 'Weapon 1',
      `  Combat rounds: ${w1.rounds != null ? w1.rounds : w1.swings}`,
      (function () {
        const rounds = w1.rounds != null ? w1.rounds : w1.swings;
        if (rounds <= 0) return '';
        const single = w1.single != null ? w1.single : 0;
        const double = w1.double != null ? w1.double : 0;
        const triple = w1.triple != null ? w1.triple : 0;
        return `  Single / Double / Triple (% of rounds): ${(single / rounds * 100).toFixed(1)}% / ${(double / rounds * 100).toFixed(1)}% / ${(triple / rounds * 100).toFixed(1)}%`;
      })(),
      `  Single attacks: ${w1.single != null ? w1.single : '—'}`,
      `  Double attacks: ${w1.double != null ? w1.double : '—'}`,
      `  Triple attacks: ${w1.triple != null ? w1.triple : '—'}`,
      `  Swings: ${w1.swings}`,
      `  Hits: ${w1.hits}`,
      w1.swings > 0 ? `  Overall accuracy: ${(w1.hits / w1.swings * 100).toFixed(1)}%` : '',
      `  Total damage: ${w1.totalDamage}`,
      `  Max hit: ${formatHitStat(s1.max != null ? s1.max : w1.maxDamage)}`,
      `  Min hit: ${formatHitStat(s1.min)}`,
      `  Mean hit: ${formatHitStat(s1.mean)}`,
      `  Median hit: ${formatHitStat(s1.median)}`,
      `  Mode hit: ${formatHitStat(s1.mode)}`,
      w1.procs != null ? `  Procs: ${w1.procs}` : '',
      (w1.procDamageTotal != null && w1.procDamageTotal > 0) ? `  Proc spell damage: ${w1.procDamageTotal}` : '',
    ].filter(Boolean);
    if (w2.swings > 0) {
      const w2RoundPct = (function () {
        const rounds = w2.rounds != null ? w2.rounds : w2.swings;
        if (rounds <= 0) return '';
        const single = w2.single != null ? w2.single : 0;
        const double = w2.double != null ? w2.double : 0;
        return `  Single / Double (% of rounds): ${(single / rounds * 100).toFixed(1)}% / ${(double / rounds * 100).toFixed(1)}%`;
      })();
      lines.push('', weapon2Label || 'Weapon 2', `  Combat rounds: ${w2.rounds != null ? w2.rounds : w2.swings}`, w2RoundPct, `  Single attacks: ${w2.single != null ? w2.single : '—'}`, `  Double attacks: ${w2.double != null ? w2.double : '—'}`, `  Swings: ${w2.swings}`, `  Hits: ${w2.hits}`, w2.swings > 0 ? `  Overall accuracy: ${(w2.hits / w2.swings * 100).toFixed(1)}%` : '', `  Total damage: ${w2.totalDamage}`, `  Max hit: ${formatHitStat(s2.max != null ? s2.max : w2.maxDamage)}`, `  Min hit: ${formatHitStat(s2.min)}`, `  Mean hit: ${formatHitStat(s2.mean)}`, `  Median hit: ${formatHitStat(s2.median)}`, `  Mode hit: ${formatHitStat(s2.mode)}`);
      if (w2.procs != null) lines.push(`  Procs: ${w2.procs}`);
      if (w2.procDamageTotal != null && w2.procDamageTotal > 0) lines.push(`  Proc spell damage: ${w2.procDamageTotal}`);
    }
    if (report.special && (report.special.count > 0 || (report.special.attempts != null && report.special.attempts > 0))) {
      lines.push('', report.special.name, `  Count: ${report.special.count}`);
      if (report.special.attempts != null) {
        const a = report.special.attempts;
        const h = report.special.hits != null ? report.special.hits : report.special.count;
        lines.push(`  Attempts: ${a}`, `  Accuracy: ${a > 0 ? (h / a * 100).toFixed(1) : 0}%`);
      }
      lines.push(`  Total damage: ${report.special.totalDamage}`, `  Max hit: ${report.special.maxDamage}`, `  DPS: ${(report.special.totalDamage / report.durationSec).toFixed(2)}`);
      if (report.special.doubleBackstabs !== undefined) {
        lines.push(`  Double backstabs: ${report.special.doubleBackstabs}`);
        const modPct = report.special.backstabModPercent != null ? report.special.backstabModPercent : 0;
        if (modPct !== 0 && report.special.backstabSkill != null) {
          const skill = report.special.backstabSkill;
          const effectiveSkill = Math.min(255, Math.floor(skill * (100 + modPct) / 100));
          lines.push(`  Effective backstab skill: ${effectiveSkill} (skill + ${modPct}% mod, cap 255)`);
        }
      }
    }
    if (report.fistweaving && report.fistweaving.rounds > 0) {
      const fw = report.fistweaving;
      const fwAcc = fw.swings > 0 ? (fw.hits / fw.swings * 100).toFixed(1) : '0';
      lines.push('', 'Fistweaving (9 dmg, no proc)', `  Rounds: ${fw.rounds}`, `  Single / Double: ${fw.single ?? '—'} / ${fw.double ?? '—'}`, `  Swings: ${fw.swings}`, `  Hits: ${fw.hits}`, `  Accuracy: ${fwAcc}%`, `  Total damage: ${fw.totalDamage}`, `  Max hit: ${fw.maxDamage}`, `  DPS: ${(fw.totalDamage / report.durationSec).toFixed(2)}`);
    }
    if (report.elementalDamageTotal != null && report.elementalDamageTotal > 0) {
      lines.push('', `Elemental damage: ${report.elementalDamageTotal}`);
    }
    lines.push('', `Total damage: ${report.totalDamage}`, `DPS: ${(report.totalDamage / report.durationSec).toFixed(2)}`);
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
    getProcChancePerSwing,
    runFight,
    formatReport,
    runRangedFight,
    formatRangedReport,
  };
})(typeof window !== 'undefined' ? window : typeof self !== 'undefined' ? self : this);
