/**
 * Player defence model for the tanking simulation.
 *
 * Two hidden stats decide how much damage you take, and the "AC" number the
 * client shows you is neither of them (Client::CalcAC is cosmetic — it is just
 * (Avoidance + Mitigation) * 1000 / 847):
 *
 *   Avoidance  — feeds the attacker's hit roll (Mob::AvoidanceCheck)
 *   Mitigation — feeds the damage roll (RollD20 inside Mob::CalcMeleeDamage)
 *
 * Sources:
 *   attack.cpp  Client::GetMitigation (4916-5274), Client::GetAvoidance (5317),
 *               Mob::AvoidDamage (233), Mob::AvoidanceCheck (171)
 *   effects.cpp discipline reuse/duration; spells_new 4499/4503 for magnitudes
 */
(function (global) {
  'use strict';

  function getEQCombat() { return global.EQCombat || null; }

  var CASTER_CLASSES = { wizard: 1, magician: 1, necromancer: 1, enchanter: 1 };

  // AvoidDamage divisors (attack.cpp:233). Parry/riposte read low versus modern
  // EQ on purpose — the comments there note old logs parsed lower.
  var DIVISOR = { block: 25, parry: 50, riposte: 55, dodge: 45 };

  /**
   * Warrior disciplines, straight from the server.
   *   Defensive (spell 4499): SE_MeleeMitigation -50, SE_DamageModifier -55
   *   Evasive   (spell 4503): SE_AvoidMeleeChance +50, accuracy -33
   * Both run 180 s on a 900 s reuse (effects.cpp:723-736).
   */
  var DISCIPLINES = {
    defensive: {
      name: 'Defensive Discipline',
      classes: ['warrior'],
      minLevel: 55,
      durationMs: 180000,
      reuseMs: 900000,
      meleeMitigationPct: -50,
      damageModifierPct: -55
    },
    evasive: {
      name: 'Evasive Discipline',
      classes: ['warrior'],
      minLevel: 52,
      durationMs: 180000,
      reuseMs: 900000,
      avoidMeleePct: 50,
      accuracyPct: -33
    }
  };

  function isCaster(classId) {
    return !!CASTER_CLASSES[(classId || '').toLowerCase()];
  }

  // ---- Avoidance (Client::GetAvoidance, attack.cpp:5317) --------------------

  /**
   * Combat Agility (and Lightning Reflexes) multiply avoidance here — they are
   * NOT a flat subtraction from the attacker's hit chance.
   */
  function getAvoidance(level, defenseSkill, agi, combatAgilityPct, avoidMeleePct) {
    var L = level != null ? level : 60;
    var def = defenseSkill != null ? defenseSkill : 0;
    var agiVal = agi != null ? agi : 100;

    var defenseAvoidance = def > 0 ? Math.floor(def * 400 / 225) : 0;

    var agiAvoidance = 0;
    if (agiVal < 40) {
      agiAvoidance = Math.floor(25 * (agiVal - 40) / 40);
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

    var computed = defenseAvoidance + agiAvoidance;

    // Combat Agility / Lightning Reflexes
    if (combatAgilityPct) computed += Math.floor(computed * combatAgilityPct / 100);

    // SE_AvoidMeleeChance from Evasive Discipline and buffs is applied by
    // AvoidanceCheck itself, after the AA multiplier.
    if (avoidMeleePct) computed = Math.floor(computed * (100 + avoidMeleePct) / 100);

    return Math.max(1, computed);
  }

  // ---- Mitigation (Client::GetMitigation, attack.cpp:4916) -----------------

  /**
   * Full AC pipeline with every component exposed, so the report can show how
   * the final number was built.
   *
   * Two things the previous implementation had wrong, both verified against the
   * server: Combat Stability raises the *softcap* rather than scaling the final
   * mitigation, and shield AC is added to the softcap uncapped from Luclin on.
   */
  function getMitigationBreakdown(o) {
    var L = o.level != null ? o.level : 60;
    var cls = (o.classId || '').toLowerCase();
    var caster = isCaster(cls);

    var itemACRaw = o.itemAC || 0;
    var acSum = itemACRaw;

    // +33% item AC for everyone but the pure casters
    var itemACScaled = caster ? acSum : Math.floor(4 * acSum / 3);
    acSum = itemACScaled;

    // Anti-twink cap
    var antiTwinkCap = null;
    if (L < 50 && acSum > L * 6 + 25) {
      antiTwinkCap = L * 6 + 25;
      acSum = antiTwinkCap;
    }

    // Class AC curves
    var classBonus = 0;
    if (cls === 'monk') {
      classBonus = getMonkACBonus(L, o.carriedWeight || 0);
    } else if (cls === 'rogue') {
      classBonus = getRogueACBonus(L, o.agi || 0);
    } else if (cls === 'beastlord') {
      classBonus = getBeastlordACBonus(L, o.agi || 0);
    }
    acSum += classBonus;

    // Iksar natural armour
    var racialBonus = 0;
    if ((o.baseRace || '').toLowerCase() === 'iksar') {
      racialBonus = L < 10 ? 10 : (L > 35 ? 35 : L);
      acSum += racialBonus;
    }

    if (acSum < 0) acSum = 0;

    // Defence skill
    var defSkill = o.defenseSkill || 0;
    var defenseContrib = defSkill > 0
      ? (caster ? Math.floor(defSkill / 2) : Math.floor(defSkill / 3))
      : 0;
    acSum += defenseContrib;

    // Spell / buff AC — a much smaller divisor than worn AC, which is why
    // routing buff AC through the item bucket badly overstates it.
    var spellContrib = Math.floor((o.spellAC || 0) / (caster ? 3 : 4));
    acSum += spellContrib;

    // AGI
    var agiContrib = (o.agi || 0) > 70 ? Math.floor(o.agi / 20) : 0;
    acSum += agiContrib;

    if (acSum < 0) acSum = 0;
    var preCap = acSum;

    // ---- Softcap ----
    var era = o.era || 'pop';
    var isKunark = era === 'kunark' || era === 'velious' || era === 'luclin' || era === 'pop';
    var isVelious = era === 'velious' || era === 'luclin' || era === 'pop';
    var isLuclin = era === 'luclin' || era === 'pop';
    var isPop = era === 'pop';

    var softcapBase = 350;
    if (L > 50) {
      if (isVelious) {
        if (cls === 'warrior') softcapBase = 430;
        else if (cls === 'paladin' || cls === 'shadowknight' ||
                 cls === 'cleric' || cls === 'bard') softcapBase = 403;
        else if (cls === 'ranger' || cls === 'shaman') softcapBase = 375;
        else softcapBase = 350;
      } else if (cls === 'warrior' && isKunark) {
        // Warriors got 405 in Kunark, before the Velious cap tables landed.
        softcapBase = 405;
      }
    }

    // Combat Stability + Innate Defense raise the cap; they do not add mitigation.
    var stabilityPct = (o.combatStabilityPct || 0) + (o.innateDefensePct || 0);
    var softcapAfterAA = softcapBase + Math.floor(stabilityPct * softcapBase / 100);

    // Shield AC is uncapped from Luclin on — it is added straight to the cap.
    var shieldAC = o.shieldAC || 0;
    var softcap = softcapAfterAA + (isLuclin ? shieldAC : 0);

    var final = acSum;
    var overcap = 0;
    var returns = 0;

    if (acSum > softcap) {
      if (L <= 50 || !isLuclin) {
        final = softcap;                     // hard cap before Luclin
      } else {
        overcap = acSum - softcap;
        returns = 20;
        if (!isPop) {
          returns = 12;
          if (caster || cls === 'cleric' || cls === 'druid' || cls === 'shaman') {
            overcap = 0;                     // melee only until PoP
          }
        } else if (cls === 'warrior') {
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
        final = softcap + Math.floor(overcap / returns);
      }
    }

    return {
      itemACRaw: itemACRaw,
      itemACScaled: itemACScaled,
      antiTwinkCap: antiTwinkCap,
      classBonus: classBonus,
      racialBonus: racialBonus,
      defenseContrib: defenseContrib,
      spellContrib: spellContrib,
      agiContrib: agiContrib,
      shieldAC: shieldAC,
      preCap: preCap,
      softcapBase: softcapBase,
      softcapAfterAA: softcapAfterAA,
      softcap: softcap,
      overcap: overcap,
      returns: returns,
      final: final
    };
  }

  function getMitigation(o) {
    return getMitigationBreakdown(o).final;
  }

  /** Monk AC scales off carried weight against a per-level soft/hard cap pair. */
  function getMonkACBonus(level, weight) {
    var hardcap, softcap;
    if (level < 15)      { hardcap = 30; softcap = 14; }
    else if (level <= 29) { hardcap = 32; softcap = 15; }
    else if (level <= 44) { hardcap = 34; softcap = 16; }
    else if (level <= 50) { hardcap = 36; softcap = 17; }
    else if (level <= 54) { hardcap = 38; softcap = 18; }
    else if (level <= 59) { hardcap = 40; softcap = 20; }
    else if (level <= 61) { hardcap = 45; softcap = 24; }
    else if (level <= 63) { hardcap = 47; softcap = 24; }
    else if (level <= 64) { hardcap = 50; softcap = 24; }
    else                  { hardcap = 53; softcap = 24; }

    var acBonus = level + 5.0;

    if (weight <= softcap) {
      return Math.floor(acBonus * 4.0 / 3.0);
    }
    if (weight > hardcap + 1) {
      var penalty = level + 5.0;
      var multiplier = (weight - (hardcap - 10)) / 100.0;
      if (multiplier > 1.0) multiplier = 1.0;
      penalty = 4.0 * penalty / 3.0;
      return -Math.floor(multiplier * penalty);
    }
    var reduction = (weight - softcap) * 6.66667;
    if (reduction > 100.0) reduction = 100.0;
    reduction = (100.0 - reduction) / 100.0;
    acBonus *= reduction;
    if (acBonus < 0.0) acBonus = 0.0;
    return Math.floor(4.0 * acBonus / 3.0);
  }

  function getRogueACBonus(level, agi) {
    if (level < 30 || agi <= 75) return 0;
    var s = level - 26;
    var bonus = agi < 80 ? Math.floor(s / 4)
              : agi < 85 ? Math.floor(s * 2 / 4)
              : agi < 90 ? Math.floor(s * 3 / 4)
              : agi < 100 ? s
              : Math.floor(s * 5 / 4);
    return Math.min(12, bonus);
  }

  function getBeastlordACBonus(level, agi) {
    if (level <= 10 || agi <= 75) return 0;
    var s = level - 6;
    var bonus = agi < 80 ? Math.floor(s / 5)
              : agi < 85 ? Math.floor(s * 2 / 5)
              : agi < 90 ? Math.floor(s * 3 / 5)
              : agi < 100 ? Math.floor(s * 4 / 5)
              : s;
    return Math.min(16, bonus);
  }

  // ---- Skill-based avoidance (Mob::AvoidDamage) ----------------------------

  /**
   * chance = (skill + 100), scaled by any %-bonus effects, then integer-divided
   * by the per-skill divisor. Roll(chance) is `Int(0,99) < chance`, so the
   * result is a straight percentage.
   *
   * The %-bonus step was missing before; AA and buff dodge/parry/riposte/block
   * bonuses apply *before* the divisor, which makes them worth more than a naive
   * post-division bonus would suggest.
   */
  function getAvoidanceRates(o) {
    function rate(skill, divisor, bonusPct) {
      if (!skill || skill <= 0) return 0;
      var chance = skill + 100;
      if (bonusPct) chance += Math.floor(chance * bonusPct / 100);
      chance = Math.floor(chance / divisor);
      return Math.min(1, Math.max(0, chance) / 100);
    }
    return {
      block:   rate(o.blockSkill,   DIVISOR.block,   o.blockBonusPct),
      parry:   rate(o.parrySkill,   DIVISOR.parry,   o.parryBonusPct),
      riposte: rate(o.riposteSkill, DIVISOR.riposte, o.riposteBonusPct),
      dodge:   rate(o.dodgeSkill,   DIVISOR.dodge,   o.dodgeBonusPct)
    };
  }

  /** Probability that at least one skill check negates a swing. */
  function getCombinedAvoidanceChance(rates) {
    return 1 - (1 - rates.block) * (1 - rates.parry) * (1 - rates.riposte) * (1 - rates.dodge);
  }

  // ---- Assembled defence object ---------------------------------------------

  /**
   * Build the defender. The returned object is mutable: the engine flips
   * discipline/buff state and calls refresh() to recompute the derived rates.
   */
  function build(o) {
    var d = {
      level: o.level != null ? o.level : 60,
      classId: o.classId || 'warrior',
      baseRace: o.baseRace || '',

      hpTotal: o.hpTotal != null ? o.hpTotal : 4000,
      hpRegenPerTick: o.hpRegenPerTick || 0,

      // Raw inputs kept so refresh() can rebuild after a discipline toggles.
      _in: o,

      // Effects that change during the fight
      meleeMitigationPct: o.meleeMitigationPct || 0,
      avoidMeleePct: o.avoidMeleePct || 0,
      runePool: o.runePool || 0,
      runeRemaining: o.runePool || 0,
      damageShield: o.damageShield || 0,

      stunImmune: !!o.stunImmune,
      frontalStunImmune: (o.baseRace || '').toLowerCase() === 'ogre',
      stunResistPct: o.stunResistPct || 0,

      hasWeapon: o.hasWeapon !== false,
      hasShield: !!o.hasShield
    };

    d.refresh = function (mobToHit) {
      var inp = d._in;

      d.acBreakdown = getMitigationBreakdown({
        level: d.level,
        classId: d.classId,
        baseRace: d.baseRace,
        itemAC: inp.itemAC,
        shieldAC: inp.shieldAC,
        spellAC: inp.spellAC,
        defenseSkill: inp.defenseSkill,
        agi: inp.agi,
        carriedWeight: inp.carriedWeight,
        era: inp.era,
        combatStabilityPct: inp.combatStabilityPct,
        innateDefensePct: inp.innateDefensePct
      });
      d.mitigation = d.acBreakdown.final;

      d.avoidance = getAvoidance(
        d.level, inp.defenseSkill, inp.agi,
        (inp.combatAgilityPct || 0) + (inp.lightningReflexesPct || 0),
        d.avoidMeleePct
      );

      d.rates = getAvoidanceRates({
        blockSkill: inp.blockSkill,
        parrySkill: inp.parrySkill,
        // Riposte needs a weapon in hand.
        riposteSkill: d.hasWeapon ? inp.riposteSkill : 0,
        dodgeSkill: inp.dodgeSkill,
        blockBonusPct: inp.blockBonusPct,
        parryBonusPct: inp.parryBonusPct,
        riposteBonusPct: inp.riposteBonusPct,
        dodgeBonusPct: inp.dodgeBonusPct
      });
      d.skillAvoidanceRate = getCombinedAvoidanceChance(d.rates);

      if (mobToHit != null) d.mobToHit = mobToHit;
      var eq = getEQCombat();
      d.hitChance = (eq && eq.getHitChance)
        ? eq.getHitChance(d.mobToHit, d.avoidance)
        : fallbackHitChance(d.mobToHit, d.avoidance);

      return d;
    };

    return d.refresh(o.mobToHit);
  }

  function fallbackHitChance(toHit, avoidance) {
    var a = (toHit || 400) + 10;
    var b = (avoidance || 460) + 10;
    return a * 1.21 > b ? 1.0 - b / (a * 1.21 * 2.0) : (a * 1.21) / (b * 2.0);
  }

  /**
   * Apply the currently active disciplines/buffs onto the defence object and
   * recompute. Pass the set of active discipline keys.
   */
  function applyActiveEffects(defense, activeDiscKeys, baseEffects) {
    var base = baseEffects || {};
    var mitPct = base.meleeMitigationPct || 0;
    var avoidPct = base.avoidMeleePct || 0;
    var damageModPct = 0;

    (activeDiscKeys || []).forEach(function (key) {
      var disc = DISCIPLINES[key];
      if (!disc) return;
      if (disc.meleeMitigationPct) mitPct += disc.meleeMitigationPct;
      if (disc.avoidMeleePct) avoidPct += disc.avoidMeleePct;
      if (disc.damageModifierPct) damageModPct += disc.damageModifierPct;
    });

    defense.meleeMitigationPct = mitPct;
    defense.avoidMeleePct = avoidPct;
    defense.damageModifierPct = damageModPct;
    return defense.refresh();
  }

  /**
   * SE_Rune — a flat absorb pool consumed 1:1 (Mob::ReduceDamage). A hit fully
   * eaten by the rune is a DMG_RUNE, not a hit.
   */
  function applyRune(defense, damage) {
    if (defense.runeRemaining <= 0) return { damage: damage, absorbed: 0, fullyAbsorbed: false };
    var absorbed = Math.min(defense.runeRemaining, damage);
    defense.runeRemaining -= absorbed;
    var remaining = damage - absorbed;
    return { damage: remaining, absorbed: absorbed, fullyAbsorbed: remaining <= 0 };
  }

  /** Which disciplines this character can actually use. */
  function availableDisciplines(classId, level) {
    var cls = (classId || '').toLowerCase();
    var out = [];
    for (var key in DISCIPLINES) {
      if (!Object.prototype.hasOwnProperty.call(DISCIPLINES, key)) continue;
      var d = DISCIPLINES[key];
      if (d.classes.indexOf(cls) === -1) continue;
      if (level < d.minLevel) continue;
      out.push(Object.assign({ key: key }, d));
    }
    return out;
  }

  global.PlayerDefense = {
    DISCIPLINES: DISCIPLINES,
    DIVISOR: DIVISOR,

    build: build,
    getAvoidance: getAvoidance,
    getMitigation: getMitigation,
    getMitigationBreakdown: getMitigationBreakdown,
    getAvoidanceRates: getAvoidanceRates,
    getCombinedAvoidanceChance: getCombinedAvoidanceChance,
    getMonkACBonus: getMonkACBonus,
    getRogueACBonus: getRogueACBonus,
    getBeastlordACBonus: getBeastlordACBonus,

    applyActiveEffects: applyActiveEffects,
    applyRune: applyRune,
    availableDisciplines: availableDisciplines
  };

})(typeof window !== 'undefined' ? window : globalThis);
