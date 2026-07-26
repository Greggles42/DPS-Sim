/**
 * Resist math for the rotation planner: how much of a nuke's listed damage
 * actually lands.
 *
 * Two modes:
 *  - Flat: the user supplies full/partial resist percentages directly and
 *    every cast uses the same expected-value multiplier (spec baseline).
 *  - Stat-based: derive the expected-value multiplier per spell from the
 *    real Mob::CheckResistSpell formula (spells.cpp) rolled against a
 *    selected mob's actual MR/FR/CR/PR/DR — the same formula
 *    js/modules/npcSpells.js already uses for mob-casts-at-player, mirrored
 *    here for player-casts-at-mob (target and caster roles swapped).
 *
 * The rotation sim is deterministic (see rotationEngine.js), so rather than
 * rolling one random number per cast, expectedLandFraction() analytically
 * averages the formula's outcome over every possible roll (0-200, all
 * equally likely) to get the same expected-value multiplier a very large
 * number of stochastic rolls would converge to.
 */
(function (global) {
  'use strict';

  var RESIST = { NONE: 0, MAGIC: 1, FIRE: 2, COLD: 3, POISON: 4, DISEASE: 5 };
  var RESIST_FIELD = { 1: 'mr', 2: 'fr', 3: 'cr', 4: 'pr', 5: 'dr' };

  /** resistFactor(fullPct, partialPct) — spec's flat expected-value multiplier. */
  function resistFactor(fullPct, partialPct) {
    var f = Math.min(1, Math.max(0, (Number(fullPct) || 0) / 100));
    var p = Math.min(1, Math.max(0, (Number(partialPct) || 0) / 100));
    var land = Math.max(0, 1 - f - p);
    return land * 1 + p * 0.25 + f * 0;
  }

  /**
   * Mob::CheckResistSpell, player-casts-at-mob direction: the mob is the
   * target rolling its resist, the player is the caster. Mirrors
   * NpcSpells.checkResist (npcSpells.js:228), which resolves the same
   * formula for the opposite direction (mob casts, player resists).
   */
  function resistChance(spell, mobResists, casterLevel, mobLevel) {
    var resistType = spell.resistTypeId;
    if (!resistType || resistType === RESIST.NONE) return null;

    var field = RESIST_FIELD[resistType];
    var targetResist = (field && mobResists[field]) || 0;
    var resistModifier = spell.resistDiff || 0;

    var levelDiff = mobLevel - casterLevel;
    var tempDiff = levelDiff;
    if (mobLevel >= 21 && tempDiff > 15) tempDiff = 15;
    var levelMod = Math.floor(tempDiff * tempDiff / 2);
    if (tempDiff < 0) levelMod = -levelMod;

    var chance = targetResist + levelMod + resistModifier;
    if (chance < 4 && resistModifier === 0) chance = 4;
    else if (chance > 198) chance = 198;
    return { chance: chance, levelDiff: levelDiff };
  }

  /** landPct for one specific roll (0-200), given a resolved resist chance. */
  function landPctForRoll(roll, chance, levelDiff) {
    if (roll > chance) return 100;
    if (chance === 0) return 0;
    var partial = Math.floor((chance * 100 - roll * 100) / chance);
    if (levelDiff >= 20) partial += Math.floor(levelDiff * 1.5);
    if (partial <= 0) return 100;
    if (partial >= 100) return 0;
    return 100 - partial;
  }

  /** Stochastic single roll — kept for a future Monte Carlo mode. */
  function checkResistVsMob(spell, mobResists, casterLevel, mobLevel, rng) {
    var r = resistChance(spell, mobResists, casterLevel, mobLevel);
    if (!r) return 100;
    var roll = Math.floor(rng() * 201);
    return landPctForRoll(roll, r.chance, r.levelDiff);
  }

  /**
   * Expected fraction (0-1) of a spell's damage that lands, averaged over
   * every possible resist roll (each of the 201 values 0-200 is equally
   * likely) — the deterministic-sim equivalent of checkResistVsMob.
   */
  function expectedLandFraction(spell, mobResists, casterLevel, mobLevel) {
    var r = resistChance(spell, mobResists, casterLevel, mobLevel);
    if (!r) return 1;
    var total = 0;
    for (var roll = 0; roll <= 200; roll++) {
      total += landPctForRoll(roll, r.chance, r.levelDiff);
    }
    return (total / 201) / 100;
  }

  global.RotationResist = {
    RESIST: RESIST,
    resistFactor: resistFactor,
    checkResistVsMob: checkResistVsMob,
    expectedLandFraction: expectedLandFraction
  };

})(typeof window !== 'undefined' ? window : globalThis);
