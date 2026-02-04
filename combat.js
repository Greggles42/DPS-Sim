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
  // Server: toHit = GetToHit(skill) = 7 + Offense + Weapon skill + accuracy (typically 400–550).
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
  // roll = RollD20(offense, defender->GetMitigation()); damage = (roll * baseDamage + 5) / 10, min 1
  // RollD20: atkRoll = Roll0(offense+5), defRoll = Roll0(mitigation+5)
  // avg = (offense+mitigation+10)/2, index = max(0, (atkRoll-defRoll)+avg/2), index = (index*20)/avg, clamp 0..19, return index+1
  // Mitigation lowers the effective roll (1–20), so higher AC = more low/mid rolls, fewer max hits.
  function rollD20(offense, mitigation, rng) {
    const atkRoll = Math.floor(rng() * (offense + 5));
    const defRoll = Math.floor(rng() * (mitigation + 5));
    const avg = Math.floor((offense + mitigation + 10) / 2);
    if (avg <= 0) return 1;
    let index = Math.max(0, (atkRoll - defRoll) + Math.floor(avg / 2));
    index = Math.floor((index * 20) / avg);
    index = Math.max(0, Math.min(19, index));
    return index + 1;
  }

  function calcMeleeDamage(baseDamage, offense, mitigation, rng, damageBonus) {
    const roll = rollD20(offense, mitigation, rng);
    let damage = Math.floor((roll * baseDamage + 5) / 10);
    if (damage < 1) damage = 1;
    if (damageBonus) damage += damageBonus;
    return damage;
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

  function rollDamageMultiplier(offense, damage, level, classId, isArchery, rng) {
    const params = getRollDamageMultiplierParams(level || 60, classId || '');
    let baseBonus = Math.floor((offense - params.minusFactor) / 2);
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

  function checkDoubleAttack(doubleAttackEffective, rng) {
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

  // ----- Proc chance (PPM-based) -----
  // Live-style: PPM = (DEX/170) + 0.5 (main hand), offhand half that. Chance per swing = PPM / swings_per_minute = PPM * effectiveDelaySec / 60.
  // effectiveDelayDecisec is haste-adjusted so PPM stays constant regardless of haste.
  function getProcChancePerSwing(effectiveDelayDecisec, isOffhand, dualWieldPct, dex) {
    if (effectiveDelayDecisec <= 0) return 0;
    let ppm = (dex != null ? dex : 150) / 170 + 0.5;
    ppm = Math.min(2, Math.max(0.5, ppm)); // ~0.5–2 PPM by DEX
    if (isOffhand) ppm *= 0.5;
    const swingsPerMin = 600 / effectiveDelayDecisec;
    const chance = ppm / swingsPerMin;
    return Math.min(1, Math.max(0, chance));
  }

  function checkProc(procChance, rng) {
    return procChance > 0 && rng() < procChance;
  }

  // ----- Special attacks (Flying Kick, Backstab, etc.) -----
  const SPECIAL_ATTACKS = {
    monk: { name: 'Flying Kick', cooldownDecisec: 80, damageMultiplier: 2 },
    rogue: { name: 'Backstab', cooldownDecisec: 120, damageMultiplier: 3, fromBehindOnly: true },
  };

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
   * @param {number} [options.toHitBonus=0] - e.g. class bonus (Warrior +24)
   * @param {number} [options.str=255] - STR stat (affects offense for damage roll when STR >= 75)
   * @param {number} options.doubleAttackSkill - double attack skill value
   * @param {number} options.dualWieldSkill - dual wield skill value
   * @param {number} [options.level=60] - level for DA/DW effective
   * Every swing: (1) AvoidanceCheck using toHit vs avoidance → hit/miss. (2) If hit, CalcMeleeDamage using RollD20(offense, mitigation) → damage. Avoidance and mitigation are applied every time.
   * @param {number} options.targetAC - defender AC for mitigation (damage roll). When level-based mit would be 200 and AC>200, use this. Higher = more mitigated damage, fewer max hits.
   * @param {number} [options.avoidance] - defender avoidance for HIT CHANCE. If omitted, uses getAvoidanceNPC(mobLevel) = level*9+5 capped 400/460
   * @param {number} [options.mobLevel=60] - mob level for getMitigation() and default avoidance
   * @param {number} options.fightDurationSec - fight length in seconds
   * @param {number} [options.dex=255] - dexterity for proc
   * @param {boolean} [options.fromBehind] - if true, skip block/parry/dodge/riposte only
   * @param {boolean} [options.specialAttacks] - if true, fire class special on cooldown
   * @param {number} [options.backstabModPercent] - rogue only: increase backstab damage by this % (e.g. 20 for 20%)
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
    // To Hit: offense skill always 252, weapon skill 252 → 7 + 252 + 252 = 511. Base offense = weapon skill + STR.
    const OFFENSE_SKILL_FOR_TOHIT = 252;
    const WEAPON_SKILL_FOR_TOHIT = 252;
    const BASE_TO_HIT = 7 + OFFENSE_SKILL_FOR_TOHIT + WEAPON_SKILL_FOR_TOHIT;
    const BASE_OFFENSE_SKILL = 252;
    const toHit = (options.attackRating != null && options.wornAttack == null && options.spellAttack == null)
      ? options.attackRating + toHitBonus
      : BASE_TO_HIT + toHitBonus;
    const offenseForDamage = (options.attackRating != null && options.wornAttack == null && options.spellAttack == null)
      ? options.attackRating + strBonus
      : (BASE_OFFENSE_SKILL + strBonus + wornAttack + spellAttack);
    const dualWieldEffective = getDualWieldEffective(level, options.dualWieldSkill, options.ambidexterity ?? 0);
    const dualWieldPct = (dualWieldEffective / 375) * 100;
    const doubleAttackEffective = getDoubleAttackEffective(level, options.doubleAttackSkill || 0);

    const w1 = options.weapon1;
    const w2 = options.weapon2;
    const mainHandDamageBonus = getDamageBonusClient(level, options.classId, w1.delay, !!w1.is2H);
    const dualWielding = !!w2 && (options.dualWieldSkill != null && options.dualWieldSkill > 0);

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
      damageBonus: mainHandDamageBonus,
      damageBonusTotal: 0,
      calculatedToHit: toHit,
      calculatedOffense: offenseForDamage,
      offenseStatContribution: strBonus,
      displayedAttack: Math.floor((offenseForDamage + toHit) * 1000 / 744),
      critHits: 0,
      critDamageGain: 0,
      special: canFireSpecial ? {
        name: specialConfig.name,
        count: 0,
        attempts: 0,
        hits: 0,
        totalDamage: 0,
        maxDamage: 0,
        doubleBackstabs: options.classId === 'rogue' ? 0 : undefined,
        backstabSkill: options.classId === 'rogue' ? (options.backstabSkill != null ? options.backstabSkill : 225) : undefined,
        backstabModPercent: options.classId === 'rogue' ? (options.backstabModPercent || 0) : undefined,
      } : null,
      fistweaving: (options.classId === 'monk' && w1.is2H && options.fistweaving) ? { rounds: 0, swings: 0, hits: 0, totalDamage: 0, maxDamage: 0, single: 0, double: 0 } : null,
    };

    const durationDecisec = Math.floor(options.fightDurationSec * 10);
    let nextSwing1 = 0;
    let nextSwing2 = dualWielding ? Math.floor(rng() * delay2) : Infinity;
    let nextSpecialAt = 0;
    let backstabHitThisTick = false;

    // Each swing: (1) AvoidanceCheck: rollHit(toHit, avoidance) → hit or miss. (2) If hit: CalcMeleeDamage uses RollD20(offense, mitigation) → damage. Avoidance and mitigation are checked every time.
    for (let t = 0; t < durationDecisec; t++) {
      backstabHitThisTick = false;
      // Special attack (Flying Kick / Backstab) on cooldown
      if (canFireSpecial && report.special && t >= nextSpecialAt) {
        report.special.attempts++;
        const isRogueBackstab = options.classId === 'rogue' && specialConfig.fromBehindOnly;
        const specialHits = !isRogueBackstab || rollHit(toHit, avoidance, rng, fromBehind);
        if (specialHits) {
          report.special.hits++;
          report.special.count++;
          let baseDmg;
          if (isRogueBackstab) {
            const backstabSkill = options.backstabSkill != null ? options.backstabSkill : 225;
            const backstabBase = Math.floor(((backstabSkill * 0.02) + 2.0) * w1.damage);
            baseDmg = calcMeleeDamage(backstabBase, offenseForDamage, mitigation, rng, 0);
            baseDmg = Math.max(1, Math.floor(baseDmg * specialConfig.damageMultiplier));
          } else {
            baseDmg = calcMeleeDamage(w1.damage, offenseForDamage, mitigation, rng);
            baseDmg = Math.max(1, Math.floor(baseDmg * specialConfig.damageMultiplier));
          }
          const mult = rollDamageMultiplier(offenseForDamage, baseDmg, level, options.classId, false, rng);
          let dmg = mult.damage;
          if (isRogueBackstab && (options.backstabModPercent || 0) > 0) {
            dmg = Math.floor(dmg * (100 + (options.backstabModPercent || 0)) / 100);
          }
          const beforeCrit = dmg;
          const critResult = rollMeleeCrit(dmg, 0, level, options.classId, options.dex, options.critChanceMult, false, false, 0, rng);
          dmg = critResult.damage;
          if (critResult.isCrit) { report.critHits++; report.critDamageGain += (dmg - beforeCrit); }
          if (isRogueBackstab && level != null) {
            const minHit = level >= 60 ? level * 2 : level > 50 ? Math.floor(level * 3 / 2) : level;
            dmg = Math.max(dmg, minHit);
          }
          report.special.totalDamage += dmg;
          report.special.maxDamage = Math.max(report.special.maxDamage, dmg);
          report.weapon1.totalDamage += dmg;
          report.totalDamage += dmg;
          if (isRogueBackstab) backstabHitThisTick = true;
        }
        nextSpecialAt = t + specialConfig.cooldownDecisec;
      }

      // Main hand (one round = one swing opportunity; 1, 2, or 3 attacks per round)
      if (t >= nextSwing1) {
        report.weapon1.rounds++;
        nextSwing1 = t + delay1;
        let attacksThisRound = 1;

        if (rollHit(toHit, avoidance, rng, fromBehind)) {
          let dmg = calcMeleeDamage(w1.damage, offenseForDamage, mitigation, rng, 0);
          const mult = rollDamageMultiplier(offenseForDamage, dmg, level, options.classId, false, rng);
          dmg = mult.damage;
          dmg += mainHandDamageBonus;
          dmg = Math.max(dmg, 1 + mainHandDamageBonus);
          const beforeCrit = dmg;
          const critResult = rollMeleeCrit(dmg, mainHandDamageBonus, level, options.classId, options.dex, options.critChanceMult, false, false, 0, rng);
          dmg = critResult.damage;
          dmg = Math.max(dmg, 1 + mainHandDamageBonus);
          if (critResult.isCrit) { report.critHits++; report.critDamageGain += (dmg - beforeCrit); }
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

        if (checkDoubleAttack(doubleAttackEffective, rng)) {
          attacksThisRound = 2;
          if (rollHit(toHit, avoidance, rng, fromBehind)) {
            let dmg = calcMeleeDamage(w1.damage, offenseForDamage, mitigation, rng, 0);
            const mult = rollDamageMultiplier(offenseForDamage, dmg, level, options.classId, false, rng);
            dmg = mult.damage;
            dmg += mainHandDamageBonus;
            dmg = Math.max(dmg, 1 + mainHandDamageBonus);
            const beforeCrit = dmg;
            const critResult = rollMeleeCrit(dmg, mainHandDamageBonus, level, options.classId, options.dex, options.critChanceMult, false, false, 0, rng);
            dmg = critResult.damage;
            dmg = Math.max(dmg, 1 + mainHandDamageBonus);
            if (critResult.isCrit) { report.critHits++; report.critDamageGain += (dmg - beforeCrit); }
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
              let dmg = calcMeleeDamage(w1.damage, offenseForDamage, mitigation, rng, 0);
              const mult = rollDamageMultiplier(offenseForDamage, dmg, level, options.classId, false, rng);
              dmg = mult.damage;
              dmg += mainHandDamageBonus;
              dmg = Math.max(dmg, 1 + mainHandDamageBonus);
              const beforeCrit = dmg;
              const critResult = rollMeleeCrit(dmg, mainHandDamageBonus, level, options.classId, options.dex, options.critChanceMult, false, false, 0, rng);
              dmg = critResult.damage;
              dmg = Math.max(dmg, 1 + mainHandDamageBonus);
              if (critResult.isCrit) { report.critHits++; report.critDamageGain += (dmg - beforeCrit); }
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

        if (report.special && report.special.doubleBackstabs !== undefined && backstabHitThisTick && attacksThisRound >= 2) {
          report.special.doubleBackstabs++;
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
            let dmg = calcMeleeDamage(FIST_DAMAGE, offenseForDamage, mitigation, rng, 0);
            const mult = rollDamageMultiplier(offenseForDamage, dmg, level, options.classId, false, rng);
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
          if (checkDoubleAttack(doubleAttackEffective, rng)) {
            fwAttacks = 2;
            if (rollHit(toHit, avoidance, rng, fromBehind)) {
              let dmg = calcMeleeDamage(FIST_DAMAGE, offenseForDamage, mitigation, rng, 0);
              const mult = rollDamageMultiplier(offenseForDamage, dmg, level, options.classId, false, rng);
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
            let dmg = calcMeleeDamage(w2.damage, offenseForDamage, mitigation, rng, 0);
            const mult = rollDamageMultiplier(offenseForDamage, dmg, level, options.classId, false, rng);
            dmg = mult.damage;
            const beforeCrit = dmg;
            const critResult = rollMeleeCrit(dmg, 0, level, options.classId, options.dex, options.critChanceMult, false, false, 0, rng);
            dmg = critResult.damage;
            if (critResult.isCrit) { report.critHits++; report.critDamageGain += (dmg - beforeCrit); }
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
          if (checkDoubleAttack(doubleAttackEffective, rng)) {
            attacksThisRound = 2;
            if (rollHit(toHit, avoidance, rng, fromBehind)) {
              let dmg = calcMeleeDamage(w2.damage, offenseForDamage, mitigation, rng, 0);
              const mult = rollDamageMultiplier(offenseForDamage, dmg, level, options.classId, false, rng);
              dmg = mult.damage;
              const beforeCrit = dmg;
              const critResult = rollMeleeCrit(dmg, 0, level, options.classId, options.dex, options.critChanceMult, false, false, 0, rng);
              dmg = critResult.damage;
              if (critResult.isCrit) { report.critHits++; report.critDamageGain += (dmg - beforeCrit); }
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
      report.calculatedOffense != null ? `Calculated Offense: ${report.calculatedOffense}` : '',
      report.offenseStatContribution != null ? `Offense contribution from stats (STR): ${report.offenseStatContribution}` : '',
      report.displayedAttack != null ? `Displayed Attack: ${report.displayedAttack}  ( (offense + toHit) * 1000 / 744 )` : '',
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
    if (report.special && report.special.count > 0) {
      lines.push('', report.special.name, `  Count: ${report.special.count}`, `  Total damage: ${report.special.totalDamage}`, `  Max hit: ${report.special.maxDamage}`);
      if (report.special.attempts != null && report.special.doubleBackstabs !== undefined) {
        const a = report.special.attempts;
        const h = report.special.hits;
        lines.push(`  Total backstab attempts: ${a}`, `  Backstab hits: ${h}`, `  Backstab damage: ${report.special.totalDamage}`, `  Backstab accuracy: ${a > 0 ? (h / a * 100).toFixed(1) : 0}%`, `  Backstab max hit: ${report.special.maxDamage}`, `  Double backstabs: ${report.special.doubleBackstabs}`);
        const modPct = report.special.backstabModPercent != null ? report.special.backstabModPercent : 0;
        if (modPct !== 0 && report.special.backstabSkill != null) {
          const skill = report.special.backstabSkill;
          const baseMult = (skill * 0.02) + 2.0;
          const effectiveMult = baseMult * (100 + modPct) / 100;
          const effectiveSkill = Math.round((effectiveMult - 2) / 0.02);
          lines.push(`  Effective backstab skill: ${effectiveSkill} (used in damage calculation with ${modPct}% mod)`);
        }
      }
    }
    if (report.fistweaving && report.fistweaving.rounds > 0) {
      const fw = report.fistweaving;
      const fwAcc = fw.swings > 0 ? (fw.hits / fw.swings * 100).toFixed(1) : '0';
      lines.push('', 'Fistweaving (9 dmg, no proc)', `  Rounds: ${fw.rounds}`, `  Single / Double: ${fw.single ?? '—'} / ${fw.double ?? '—'}`, `  Swings: ${fw.swings}`, `  Hits: ${fw.hits}`, `  Accuracy: ${fwAcc}%`, `  Total damage: ${fw.totalDamage}`, `  Max hit: ${fw.maxDamage}`, `  DPS: ${(fw.totalDamage / report.durationSec).toFixed(2)}`);
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
  };
})(typeof window !== 'undefined' ? window : typeof self !== 'undefined' ? self : this);
