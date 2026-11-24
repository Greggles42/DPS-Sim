/**
 * Resist math for the rotation planner: how much of a nuke's listed damage
 * actually lands.
 *
 * Two modes:
 *  - Flat: the user supplies full/partial resist percentages directly and
 *    every cast uses the same expected-value multiplier (spec baseline).
 *  - Stat-based: derive the expected-value multiplier per spell from the
 *    real Mob::CheckResistSpell formula (spells.cpp) rolled against a
 *    selected mob's actual MR/FR/CR/PR/DR — player-casts-at-NPC direction.
 *
 * The rotation sim is deterministic (see rotationEngine.js), so rather than
 * rolling one random number per cast, expectedLandFraction() analytically
 * averages the formula's outcome over every possible roll (0-200, all
 * equally likely) to get the same expected-value multiplier a very large
 * number of stochastic rolls would converge to.
 *
 * Live Quarm rule values (rule_values dump 2026-10-25): Quarm:UseClassicResists
 * is FALSE, so the classic floors (4/10), the 198 ceiling, the x3/2 and the
 * 100-scale partial formula are all skipped; Spells:ResistFalloff is 67 and
 * Spells:RainWizardResistChance is 0.
 */
(function (global) {
  'use strict';

  var RESIST = { NONE: 0, MAGIC: 1, FIRE: 2, COLD: 3, POISON: 4, DISEASE: 5 };
  var RESIST_FIELD = { 1: 'mr', 2: 'fr', 3: 'cr', 4: 'pr', 5: 'dr' };

  var RESIST_FALLOFF = 67;            // RuleI(Spells, ResistFalloff)
  var RAIN_INNATE_RESIST_PCT = 20;    // non-wizard casters vs NPC targets (spells.cpp rain block)

  /** resistFactor(fullPct, partialPct) — spec's flat expected-value multiplier. */
  function resistFactor(fullPct, partialPct) {
    var f = Math.min(1, Math.max(0, (Number(fullPct) || 0) / 100));
    var p = Math.min(1, Math.max(0, (Number(partialPct) || 0) / 100));
    var land = Math.max(0, 1 - f - p);
    return land * 1 + p * 0.25 + f * 0;
  }

  /**
   * Mob::CheckResistSpell, player-casts-at-NPC-target direction. The target
   * is an NPC, so the NPC-only level modifiers apply (spells.cpp:4121-4200).
   * With UseClassicResists=false there is NO floor or ceiling on resist_chance.
   */
  function resistChance(spell, mobResists, casterLevel, mobLevel) {
    var resistType = spell.resistTypeId;
    if (!resistType || resistType === RESIST.NONE) return null;

    var field = RESIST_FIELD[resistType];
    var targetResist = (field && mobResists[field]) || 0;
    var resistModifier = spell.resistDiff || 0;

    var levelDiff = mobLevel - casterLevel;
    var tempDiff = levelDiff;
    if (mobLevel >= RESIST_FALLOFF) {
      var a = (RESIST_FALLOFF - 1) - casterLevel;
      tempDiff = a > 0 ? a : 0;
    }
    if (tempDiff < -9) tempDiff = -9;                       // NPC target floor
    var levelMod = Math.trunc(tempDiff * tempDiff / 2);
    if (tempDiff < 0) levelMod = -levelMod;

    // Crude approximation of Sony's function for NPCs well above the caster.
    if (casterLevel < 50) {
      var bump = casterLevel + 4 + Math.trunc(casterLevel / 6);
      if (mobLevel >= bump) levelMod += 70 + casterLevel * 6;
    } else if (casterLevel < 64) {
      if (levelDiff >= 13) levelMod = casterLevel * 5;
    } else if (levelDiff >= 16) {
      levelMod = casterLevel * 5;
    }

    // Direct-damage spells: extra level term against NPCs level 17+.
    if (!spell.isDot) {
      var dd = mobLevel >= RESIST_FALLOFF
        ? Math.max(0, (RESIST_FALLOFF - 1) - casterLevel)
        : mobLevel - casterLevel;
      if (dd > 0 && mobLevel >= 17) levelMod += 2 * dd;
    }

    var chance = targetResist + levelMod + resistModifier;
    return { chance: chance, mobLevel: mobLevel, casterLevel: casterLevel };
  }

  /**
   * landPct (0-100) for one roll (0-200). Mirrors the server tail of
   * CheckResistSpell: roll > chance lands; otherwise partial-capable spells get
   * 150*(chance-roll)/chance plus NPC-target adjustments, others fully resist.
   * The caster is the player, so the "+1.5x level diff" bonus (NPC casters
   * only) never applies here.
   */
  function landPctForRoll(roll, r, partialCapable) {
    if (roll > r.chance) return 100;
    if (!partialCapable || r.chance === 0) return 0;
    var pm = Math.trunc(150 * (r.chance - roll) / r.chance);
    if (r.mobLevel > r.casterLevel && r.mobLevel >= 17 && r.casterLevel <= 50) pm += 5;
    if (r.mobLevel >= 30 && r.casterLevel <= 50) pm += (r.mobLevel - 25);
    if (r.mobLevel < 15) pm -= 5;
    if (pm <= 0) return 100;
    if (pm >= 100) return 0;
    return 100 - pm;
  }

  // IsPartialCapableSpell: first effect is HP damage (always true for the
  // damage pool) and the spell's no_partial_resist flag is clear.
  function isPartialCapable(spell) { return !spell.noPartialResist; }

  /** Stochastic single roll — kept for a future Monte Carlo mode. */
  function checkResistVsMob(spell, mobResists, casterLevel, mobLevel, rng) {
    var r = resistChance(spell, mobResists, casterLevel, mobLevel);
    if (!r) return 100;
    var roll = Math.floor(rng() * 201);
    return landPctForRoll(roll, r, isPartialCapable(spell));
  }

  /**
   * Expected fraction (0-1) of a spell's damage that lands, averaged over
   * every possible resist roll (each of the 201 values 0-200 is equally
   * likely) — the deterministic-sim equivalent of checkResistVsMob.
   *  - DoTs: the application check is all-or-nothing for the buff (a partial
   *    still applies the full DoT; tick damage is never scaled by partial),
   *    so only a full resist costs damage.
   *  - Rain: a 20% innate full-resist roll precedes the normal check
   *    (0% for Wizards, Spells:RainWizardResistChance).
   */
  function expectedLandFraction(spell, mobResists, casterLevel, mobLevel, casterClass) {
    var r = resistChance(spell, mobResists, casterLevel, mobLevel);
    var innate = 1;
    if (spell.isRain) {
      var pct = (String(casterClass || '').toLowerCase() === 'wizard') ? 0 : RAIN_INNATE_RESIST_PCT;
      innate = 1 - pct / 100;
    }
    if (!r) return innate;
    var total = 0;
    var capable = isPartialCapable(spell);
    for (var roll = 0; roll <= 200; roll++) {
      var p = landPctForRoll(roll, r, capable);
      total += spell.isDot ? (p > 0 ? 100 : 0) : p;
    }
    return innate * (total / 201) / 100;
  }

  global.RotationResist = {
    RESIST: RESIST,
    resistFactor: resistFactor,
    checkResistVsMob: checkResistVsMob,
    expectedLandFraction: expectedLandFraction
  };

})(typeof window !== 'undefined' ? window : globalThis);
