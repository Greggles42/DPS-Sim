/**
 * Caster spell-rotation planner for gSim.
 *
 * Given a caster's pool of nukes, greedily picks the highest-scoring
 * castable spell at each decision point and simulates the actual
 * cast-by-cast timeline against the GCD, per-spell recast timers, and
 * (optionally) one off-global filler spell, reporting DPS and mana sustain.
 *
 * Two independent clocks drive the timeline, same idea as
 * tankingEngine.js's event scheduler:
 *   busyUntil  serial cast-bar timeline — one cast at a time, everyone
 *              respects this (normal or off-global)
 *   gcdFree    earliest a *normal* spell may start; the off-global spell
 *              ignores it and doesn't extend it
 *
 * Source: resources/rotation-module-spec.md — this is a direct port of the
 * spec's simulateRotation() pseudocode.
 */
(function (global) {
  'use strict';

  var GCD = 2.25;
  var ITERATION_CEILING = 250000;
  var DOT_TICK_SEC = 6;   // fallback if a DoT pool entry somehow lacks waveIntervalSec
  // A character can only have this many spells memorized at once — the
  // rotation can never actually draw from more than this many distinct
  // spells in a single encounter, regardless of how large the pool is.
  var MAX_MEMORIZED_SPELLS = 8;
  // EQMacEmu's proc/click hate cap (mob.h CanClassCastSpell gate) only clamps
  // hate for spells NOT on the caster's own class list — item clicks, weapon
  // procs, innate NPC procs. Every spell in this rotation sim is drawn from
  // the caster's own class spell pool, so CanClassCastSpell is always true
  // here and the 400 cap never applies; direct-damage hate is simply the
  // damage dealt, uncapped (see threat.js / mechanics-guide.html §2 for the
  // cap as it actually applies to weapon procs).

  function getResist() {
    return global.RotationResist || null;
  }

  function getItemFocus() {
    return global.ItemFocus || null;
  }

  function isOffGlobal(spell, offGlobalSpellId) {
    return offGlobalSpellId != null && spell.id === offGlobalSpellId;
  }

  // Average bonus of the wizard innate crit's random 1-50% multiplier
  // (zone->random.Int(1,50)/100 in effects.cpp) — used for EV scoring only.
  var WIZARD_INNATE_CRIT_AVG_BONUS = 0.255;
  var WIZARD_INNATE_CRIT_MIN_LEVEL = 12;   // RuleI(Spells, WizCritLevel) default

  /**
   * Expected-value crit multiplier — used for spell selection/ranking
   * (comparing spells by their average output), never for the damage
   * actually credited to a specific cast (that's a real roll, see below).
   * Combines both crit sources with the server's real precedence: Spell
   * Casting Fury is rolled first; the wizard's innate crit only gets a
   * chance to trigger on casts where SCF's roll didn't land (Client::
   * GetActSpellDamage in effects.cpp — an `else if` on the SCF crit check,
   * not an independent/additive roll).
   */
  function critEvMultiplier(spell) {
    var pScf = spell._critChance || 0, bScf = spell._critBonus || 0;
    var pWiz = spell._innateCritChance || 0;
    var pNoScf = 1 - pScf;
    return pScf * (1 + bScf) +
      pNoScf * pWiz * (1 + WIZARD_INNATE_CRIT_AVG_BONUS) +
      pNoScf * (1 - pWiz);
  }

  // Spell Casting Fury (Luclin archetype AA): rank -> {chance, bonus} on a
  // direct-cast nuke/DoT/rain critically hitting. Rolled per cast (see
  // simulateRotation's isCrit roll) rather than blended into an expected-
  // value multiplier — a real crit/no-crit outcome is what lets the sim
  // report an actual max hit and crit count, not just an averaged rate.
  // score()'s spell-selection math still uses the EV rate (maxDpsScore/
  // maxManaScore etc. below) since which spell to cast next shouldn't
  // depend on the last cast's crit roll.
  var SPELL_CRIT_RANKS = [
    { chance: 0, bonus: 0 },
    { chance: 0.02, bonus: 0.33 },
    { chance: 0.04, bonus: 0.66 },
    { chance: 0.07, bonus: 1.00 }
  ];

  // Spell Casting Fury Mastery (Luclin archetype AA, requires Spell Casting
  // Fury rank 3 as a prereq): adds MORE crit chance on top of SCF's, at the
  // same 2%/4%/7% per-rank tiers — Client::GetActSpellDamage (effects.cpp)
  // sums aabonuses.CriticalSpellChance additively across every AA that
  // grants it, so this stacks with SCF rather than replacing it. Chance
  // only — the crit damage multiplier (33/66/100%) is hardcoded off SCF's
  // own rank alone and Mastery has no effect on it.
  var SPELL_CRIT_MASTERY_CHANCE = [0, 0.02, 0.04, 0.07];

  // Quick Damage (Luclin archetype AA, requires Spell Casting Fury rank 3 as
  // a prereq): reduces cast time on direct-damage nukes/rains by a flat %.
  // Client::GetActSpellCastingTime (effects.cpp) gates it on: detrimental
  // spell (goodEffect == 0), cast time > 4s, buffduration == 0 (excludes
  // DoTs, which tick rather than hit once), and an SE_CurrentHP effect
  // (direct damage). Applied after gear/other haste, same as the server's
  // modifier chain.
  var QUICK_DAMAGE_CAST_MOD = [1, 0.98, 0.95, 0.90];
  var QUICK_DAMAGE_MIN_CAST_TIME = 4;

  /**
   * Spell specialization mana discount — Client::GetActSpellCost (effects.cpp):
   *   PercentManaReduction = 1 + SpecializeSkill/20
   *   + (2.5 / 5 / 10 for Spell Casting Mastery AA rank 1/2/3)
   *   cost -= cost * (PercentManaReduction / 100)
   * Only applies to spells whose school (spell.specCategory, from the
   * spell's "skill" field) matches the caster's specialized school — the
   * server only ever discounts the one school the specialize skill was
   * trained in (GetSpecializeSkillValue switches on spells[id].skill).
   * `specialization.skill` is the caster's raw Specialize skill value
   * (0-200); the UI derives it from level (5*level+5, capped at 200),
   * matching this server's rule that only one specialization school can be
   * trained past 50.
   */
  var SPELL_CASTING_MASTERY_BONUS_PCT = [0, 2.5, 5, 10];

  function specializeManaReductionPct(spell, specialization) {
    if (!specialization || !specialization.school || !spell.specCategory) return 0;
    if (specialization.school !== spell.specCategory) return 0;
    var skill = Number(specialization.skill) || 0;
    if (skill <= 0) return 0;
    var pct = 1 + skill / 20;
    pct += SPELL_CASTING_MASTERY_BONUS_PCT[specialization.masteryRank || 0] || 0;
    return Math.min(100, pct);
  }

  /**
   * Base (non-item/AA/spell) mana regen per 6-second server tick —
   * Client::CalcManaRegen (client_mods.cpp): not famished, standing = 1;
   * sitting = 2; sitting with Meditate skill = 3 (skill <= 1) or
   * 4 + floor(skill/20)... actually floor(skill/15) per source; +1 at
   * level 62, +1 more at level 64 (both apply regardless of sit state).
   * There's no separate "casting" penalty in this server's source — sit-
   * casting is unrestricted (no Stand() is ever forced by casting), so a
   * caster who sits once at the start of a fight stays seated, and
   * medding, through every subsequent cast. "Sit for Med Ticks" therefore
   * doesn't cost any cast time/DPS in this sim; it only changes which of
   * these two base rates applies for the whole fight. Meditate skill is
   * assumed trained to the class/level cap (5*level+5, capped at 200),
   * same "assume skills are trained to cap" convention as elsewhere.
   */
  var MEDITATE_SKILL_CAP = 200;

  function computeBaseManaRegenPerTick(level, sitForMedTicks) {
    var lvl = Number(level) || 1;
    var regen = sitForMedTicks ? 2 : 1;
    if (sitForMedTicks) {
      var skill = Math.min(MEDITATE_SKILL_CAP, lvl * 5 + 5);
      regen = skill > 1 ? 4 + Math.floor(skill / 15) : 3;
    }
    if (lvl > 61) regen += 1;
    if (lvl > 63) regen += 1;
    return regen;
  }

  /**
   * Wizards have a separate, innate direct-damage crit chance that exists
   * with zero AA points spent — Client::TryWizardInnateCrit in effects.cpp:
   *   chance = ((min(INT,255) + min(DEX,255)) / 2 + 32) / 10000
   * gated on class == Wizard and level >= WizCritLevel (12). On a hit, the
   * bonus is a random 1-50% (not a fixed step like the AA), applied to the
   * same base damage. This exists independently of Spell Casting Fury —
   * it's the class's own trait, not something the AA grants — so it's
   * computed here unconditionally for wizards, before any AA rank is
   * factored in (see critEvMultiplier / the per-cast roll in
   * simulateRotation for how the two combine).
   */
  function wizardInnateCritChance(casterClass, casterLevel, intStat, dexStat) {
    if (String(casterClass || '').toLowerCase() !== 'wizard') return 0;
    if ((Number(casterLevel) || 0) < WIZARD_INNATE_CRIT_MIN_LEVEL) return 0;
    var i = Math.min(Number(intStat) || 0, 255);
    var d = Math.min(Number(dexStat) || 0, 255);
    return ((i + d) / 2 + 32) / 10000;
  }

  /**
   * Applies equipped item focus effects (deterministic — always-on
   * percentages, not chance-based) and attaches the caster's crit
   * chance/bonus (both Spell Casting Fury and the wizard's innate crit) for
   * simulateRotation to roll per cast. Returns a new pool (originals
   * untouched). Doing the focus-effect math once up front — rather than
   * threading multipliers through every place simulateRotation reads
   * spell.damage/mana/castTime — keeps the rest of the engine unchanged.
   *
   * Same-category focus effects don't stack in EQ (e.g. two different fire-
   * damage-% items on the same nuke) — only the single best applicable
   * value per category (damage/mana/haste) is used, matching the real
   * "highest value wins" focus stacking rule.
   */
  function applyGearAndAABonuses(pool, focusEffects, spellCritRank, caster, spellCritMasteryRank, quickDamageRank, specialization) {
    var crit = SPELL_CRIT_RANKS[spellCritRank] || SPELL_CRIT_RANKS[0];
    // Both Mastery and Quick Damage require Spell Casting Fury rank 3 as a
    // hard AA prereq server-side (Client::GetAA(aaSpellCastingFury) == 3) —
    // enforced here too in case a config sets one without the other.
    var scfMaxed = spellCritRank === 3;
    var masteryChance = scfMaxed ? (SPELL_CRIT_MASTERY_CHANCE[spellCritMasteryRank] || 0) : 0;
    var quickDamageMod = scfMaxed ? (QUICK_DAMAGE_CAST_MOD[quickDamageRank] || 1) : 1;
    caster = caster || {};
    var innateCritChance = wizardInnateCritChance(caster.classId, caster.level, caster.int, caster.dex);
    var IF = getItemFocus();
    var effects = (IF && focusEffects) ? focusEffects : [];

    return pool.map(function (spell) {
      var dmgPct = 0, manaPct = 0, hastePct = 0, durPct = 0;
      var applied = [];
      effects.forEach(function (f) {
        if (!IF.appliesToSpell(f, spell)) return;
        if (f.improvedDamagePct > dmgPct) dmgPct = f.improvedDamagePct;
        if (f.reduceManaPct > manaPct) manaPct = f.reduceManaPct;
        if (f.spellHastePct > hastePct) hastePct = f.spellHastePct;
        // DoT-duration-extending foci ("Extended Affliction"-type — Timeburn/
        // Chronoburn/Chrononostrum in this era's item set) only ever pass
        // appliesToSpell for isDot entries with enough ticks to begin with
        // (its own SE_LimitSpellType=detrimental + SE_LimitMinDur gate that),
        // but guard isDot here too since it's meaningless on an instant nuke/rain.
        if (spell.isDot && f.increaseDurationPct > durPct) durPct = f.increaseDurationPct;
        if (f.improvedDamagePct > 0 || f.reduceManaPct > 0 || f.spellHastePct > 0 ||
          (spell.isDot && f.increaseDurationPct > 0)) applied.push(f.name);
      });

      var clone = Object.assign({}, spell);
      // Extends tick count, not per-tick damage: Client::ApplyDurationFocus
      // (spell_effects.cpp) floors ticksRemaining * (100+pct)/100 onto the
      // buff. `waves` is our tick count, so growing it here also correctly
      // extends the DoT's recast-availability gate in simulateRotation
      // (dotDuration = waves * waveIntervalSec) — a longer-lasting DoT
      // should take longer before recasting it is worthwhile.
      var durationMult = 1;
      if (spell.isDot && durPct > 0) {
        var newWaves = Math.max(1, Math.floor(spell.waves * (100 + durPct) / 100));
        durationMult = newWaves / spell.waves;
        clone.waves = newWaves;
      }
      clone.damage = spell.damage * (1 + dmgPct / 100) * durationMult;
      var gearReducedMana = spell.mana * (1 - Math.min(100, manaPct) / 100);
      var specPct = specializeManaReductionPct(spell, specialization);
      clone.mana = Math.max(0, gearReducedMana * (1 - specPct / 100));
      clone._specManaPct = specPct;
      var castTime = Math.max(0.25, spell.castTime * (1 - Math.min(90, hastePct) / 100));
      // Quick Damage only touches detrimental direct-damage casts (not DoTs,
      // which the server excludes via buffduration == 0) that are still over
      // 4s after other haste is applied — see QUICK_DAMAGE_CAST_MOD above.
      var quickDamageApplies = quickDamageMod < 1 && !spell.isDot && castTime > QUICK_DAMAGE_MIN_CAST_TIME;
      if (quickDamageApplies) castTime = Math.max(0.25, castTime * quickDamageMod);
      clone.castTime = castTime;
      clone._critChance = crit.chance + masteryChance;
      clone._critBonus = crit.bonus;
      clone._innateCritChance = innateCritChance;
      clone._gearDmgPct = dmgPct;
      clone._gearManaPct = manaPct;
      clone._gearHastePct = hastePct;
      clone._gearDurationPct = durPct;
      clone._quickDamageApplied = quickDamageApplies;
      clone._appliedFocusNames = applied;
      // How much of THIS spell's eventual per-cast numbers are attributable
      // to focus, so simulateRotation can isolate it per cast rather than
      // just reporting the pool's already-boosted totals. Damage is a
      // fraction (1 - 1/totalMult) of the total (dmg% and duration% both
      // multiply the same total, so they're combined into one multiplier)
      // rather than a flat amount because resist and crit still apply
      // multiplicatively on top — the fraction stays correct however a
      // specific cast's damage actually lands; mana is a flat per-cast
      // amount since mana isn't resist/crit-rolled.
      var totalDamageMult = (1 + dmgPct / 100) * durationMult;
      clone._focusDamageGainFraction = totalDamageMult > 1 ? (1 - 1 / totalDamageMult) : 0;
      clone._focusManaSaved = spell.mana - clone.mana;
      return clone;
    });
  }

  /** Tiny seeded LCG — deterministic by default so re-running the same
   * config reproduces the same crit rolls (and therefore the same max hit/
   * crit count), same reasoning as tankingEngine.js's fallback RNG. */
  function createRng(seed) {
    var s = (seed != null ? seed : 1) >>> 0;
    return function () {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 0x100000000;
    };
  }

  /** One 0-1 multiplier per spell, from either resist mode. */
  function computeFactors(pool, resistConfig) {
    var factors = {};
    var RR = getResist();
    var mode = resistConfig && resistConfig.mode;

    if (mode === 'statBased' && RR) {
      pool.forEach(function (spell) {
        factors[spell.id] = RR.expectedLandFraction(
          spell, resistConfig.mobResists || {},
          resistConfig.casterLevel, resistConfig.mobLevel);
      });
    } else {
      var flat = RR
        ? RR.resistFactor(resistConfig && resistConfig.fullResistPct, resistConfig && resistConfig.partialResistPct)
        : 1;
      pool.forEach(function (spell) { factors[spell.id] = flat; });
    }
    return factors;
  }

  function score(spell, mode, offGlobal, edmg, maxDpsScore, maxManaScore) {
    var dpsScore = edmg / (spell.castTime + (offGlobal ? 0 : GCD));
    var manaScore = spell.mana > 0 ? edmg / spell.mana : edmg;
    if (mode === 'dps') return dpsScore;
    if (mode === 'sustain') return manaScore;
    var dpsNorm = maxDpsScore > 0 ? dpsScore / maxDpsScore : 0;
    var manaNorm = maxManaScore > 0 ? manaScore / maxManaScore : 0;
    return 0.5 * dpsNorm + 0.5 * manaNorm;
  }

  /**
   * Ranks a spell pool by standalone score under the given resist config and
   * priority mode — the same score() the simulator's greedy pick uses, just
   * evaluated once per spell rather than as part of a timeline. This is what
   * "recommend the top N" is: no scheduling, no synergy analysis, just each
   * spell's own damage-per-time or damage-per-mana rate. The event-driven
   * simulator already interleaves whatever ends up selected on its own
   * merits (e.g. a rain's low GCD-chain "cost" after its cast completes is
   * exactly what makes it independently score well without any special-
   * casing here).
   *
   * @returns {Array<{spell:Object, score:number, effectiveDamage:number}>}
   *   sorted best first.
   */
  function rankSpellPool(pool, resistConfig, priorityMode, focusEffects, spellCritRank, caster, spellCritMasteryRank, quickDamageRank, specialization) {
    pool = pool || [];
    if (!pool.length) return [];
    pool = applyGearAndAABonuses(pool, focusEffects, spellCritRank, caster, spellCritMasteryRank, quickDamageRank, specialization);

    var factors = computeFactors(pool, resistConfig || {});
    function edmg(spell) { return spell.damage * factors[spell.id] * critEvMultiplier(spell); }

    var maxDpsScore = 0, maxManaScore = 0;
    pool.forEach(function (spell) {
      var e = edmg(spell);
      var dpsScore = e / (spell.castTime + GCD);
      var manaScore = spell.mana > 0 ? e / spell.mana : e;
      if (dpsScore > maxDpsScore) maxDpsScore = dpsScore;
      if (manaScore > maxManaScore) maxManaScore = manaScore;
    });

    var mode = priorityMode || 'dps';
    var ranked = pool.map(function (spell) {
      var e = edmg(spell);
      return { spell: spell, effectiveDamage: e, score: score(spell, mode, false, e, maxDpsScore, maxManaScore) };
    });
    ranked.sort(function (a, b) { return b.score - a.score; });
    return ranked;
  }

  /**
   * @param {Object} config - RotationConfig, see rotation-module-spec.md
   * @returns {Object} RotationResult
   */
  function simulateRotation(config) {
    var pool = (config && config.pool) || [];
    // Hard cap regardless of what the caller passed in — a character only
    // has MAX_MEMORIZED_SPELLS spell gems, so the sim never considers more.
    var truncatedPool = pool.length > MAX_MEMORIZED_SPELLS;
    if (truncatedPool) pool = pool.slice(0, MAX_MEMORIZED_SPELLS);
    pool = applyGearAndAABonuses(pool, config.focusEffects, config.spellCritRank, config.caster,
      config.spellCritMasteryRank, config.quickDamageRank, config.specialization);

    var appliedFocusNames = {};
    pool.forEach(function (s) { (s._appliedFocusNames || []).forEach(function (n) { appliedFocusNames[n] = true; }); });
    var scfMaxed = (config.spellCritRank || 0) === 3;
    var gearSummary = {
      spellCritRank: config.spellCritRank || 0,
      spellCritMasteryRank: scfMaxed ? (config.spellCritMasteryRank || 0) : 0,
      quickDamageRank: scfMaxed ? (config.quickDamageRank || 0) : 0,
      focusNames: Object.keys(appliedFocusNames),
      // Same for every pool entry — only depends on caster class/level/stats.
      innateCritChance: pool.length ? (pool[0]._innateCritChance || 0) : 0
    };

    var fightDurationSec = config.fightDurationSec != null ? config.fightDurationSec : 0;
    var offGlobalSpellId = config.offGlobalSpellId || null;
    var priorityMode = config.priorityMode || 'dps';
    // Manual mode: an explicit, user-ordered priority list of spell ids
    // (from the checked pool) instead of the greedy score. At every decision
    // point the sim casts the first spell in this order that's currently a
    // candidate (off recast, affordable, off the GCD as applicable) — it
    // isn't "consumed" and re-evaluated from the top every time, so it
    // naturally forms a repeating priority-list rotation, same as a real
    // player working down a fixed cast list and skipping whatever's on
    // cooldown.
    var manualOrder = (config.manualOrder && config.manualOrder.length) ? config.manualOrder : null;
    var maxMana = config.maxMana != null ? config.maxMana : 0;
    var unlimited = maxMana <= 0;
    // "Sit for Med Ticks": this server never lets you cast while sitting
    // (must stand to cast), so catching the 6s regen tick's sitting/
    // meditate rate means deliberately not being mid-cast when it lands.
    // With this on, the sim guarantees every tick is caught by holding off
    // (sitting idle) on any cast that would still be running when the next
    // tick fires, then casting right after — trading some idle/GCD time for
    // the full per-tick amount landing exactly on schedule, discretely,
    // rather than the smoothed continuous approximation used otherwise.
    // Meaningless with unlimited mana (nothing to conserve), so it's a
    // no-op there.
    var sitForMedTicks = !!config.sitForMedTicks && !unlimited;
    var manaPerTick = config.manaRegenPerTick || 0;
    var nextManaTickAt = 6;
    var regenPerSec = sitForMedTicks ? 0 : manaPerTick / 6;

    if (!pool.length || fightDurationSec <= 0) {
      return {
        totalDamage: 0, totalMana: 0, totalThreat: 0, castCount: 0,
        durationSec: fightDurationSec, dps: 0, manaPerSec: 0, tps: 0,
        manaRemaining: unlimited ? null : maxMana,
        ranOutOfManaAt: null, log: [], truncatedPool: truncatedPool, gearSummary: gearSummary,
        maxHit: 0, critCount: 0, critRate: 0, critDamageBonus: 0, critDps: 0,
        scfCritCount: 0, innateCritCount: 0, quickDamageCastCount: 0, manualMode: !!manualOrder,
        focusDamageGain: 0, focusDamageGainDps: 0, focusManaSaved: 0, focusManaSavedPerSec: 0
      };
    }

    var factors = computeFactors(pool, config.resist || {});
    // Post-resist, post-focus damage — NOT including crit. Used to resolve
    // the actual damage a specific cast deals, after rolling for crit below.
    function baseEffectiveDamage(spell) { return spell.damage * factors[spell.id]; }
    // Includes the crit EV multiplier — used only for deciding which spell
    // to cast next (an average-output comparison), never for a real cast's
    // credited damage.
    function evEffectiveDamage(spell) { return baseEffectiveDamage(spell) * critEvMultiplier(spell); }

    var maxDpsScore = 0, maxManaScore = 0;
    pool.forEach(function (spell) {
      var edmg = evEffectiveDamage(spell);
      var offGlobal = isOffGlobal(spell, offGlobalSpellId);
      var dpsScore = edmg / (spell.castTime + (offGlobal ? 0 : GCD));
      var manaScore = spell.mana > 0 ? edmg / spell.mana : edmg;
      if (dpsScore > maxDpsScore) maxDpsScore = dpsScore;
      if (manaScore > maxManaScore) maxManaScore = manaScore;
    });

    var rng = createRng(config.seed);

    var t = 0;
    var busyUntil = 0;
    var gcdFree = 0;
    var mana = maxMana;
    var lastManaUpdateT = 0;
    var availAt = {};
    pool.forEach(function (spell) { availAt[spell.id] = 0; });

    var log = [];
    var totalDamage = 0, totalMana = 0, totalThreat = 0, castCount = 0;
    var focusDamageGain = 0, focusManaSaved = 0;
    var maxHit = 0, critCount = 0, critDamageBonus = 0;
    var scfCritCount = 0, innateCritCount = 0;
    // Expected crit count — the analytic average across infinitely many runs
    // (sum of each cast's real crit probability), as opposed to critCount
    // above, which is this one seeded run's actual roll outcomes. Reported
    // side by side so a single run's number isn't mistaken for the average.
    var expectedCritCount = 0;
    var quickDamageCastCount = 0;
    var ranOutOfManaAt = null;

    function manaAt(time) {
      if (unlimited) return Infinity;
      return Math.min(maxMana, mana + (time - lastManaUpdateT) * regenPerSec);
    }

    // Applies every 6s tick that has landed by `time` — only meaningful
    // when sitForMedTicks, since the scheduling below guarantees each one
    // is caught (never mid-cast when it lands).
    function applyPendingManaTicks(time) {
      if (!sitForMedTicks) return;
      while (nextManaTickAt <= time) {
        mana = Math.min(maxMana, mana + manaPerTick);
        lastManaUpdateT = nextManaTickAt;
        nextManaTickAt += 6;
      }
    }

    var guard = 0;
    while (t < fightDurationSec && guard++ < ITERATION_CEILING) {
      t = Math.max(t, busyUntil);
      // Applied against the clamped time even on the exiting iteration, so
      // a tick that lands in-fight but after the last real decision point
      // (e.g. nothing left castable before the fight ends) still counts
      // toward the reported mana remaining.
      applyPendingManaTicks(Math.min(t, fightDurationSec));
      if (t >= fightDurationSec) break;

      var m = manaAt(t);
      var candidates = pool.filter(function (spell) {
        var offGlobal = isOffGlobal(spell, offGlobalSpellId);
        return availAt[spell.id] <= t &&
          (unlimited || m >= spell.mana) &&
          (offGlobal || gcdFree <= t);
      });

      if (candidates.length) {
        // Explicit reset (not just `var best;`) — `var` is hoisted to the
        // top of simulateRotation, so a bare declaration here is a no-op on
        // every iteration after the first; without the `= null` a stale
        // `best` from a previous cast survives into an iteration where the
        // manual-order loop below fails to find any of its entries among
        // the current candidates, silently re-casting last cast's spell
        // instead of correctly falling through to `candidates[0]`.
        var best = null;
        if (manualOrder) {
          // First candidate that appears in the user's order, in their
          // order — not the highest scorer. Falls back to the first
          // candidate if none of them happen to be in the list (shouldn't
          // normally happen since the UI seeds the order from the checked
          // pool, but a spell removed from the order after being checked
          // would otherwise stall the sim).
          for (var oi = 0; oi < manualOrder.length && !best; oi++) {
            best = candidates.filter(function (c) { return c.id === manualOrder[oi]; })[0];
          }
          if (!best) best = candidates[0];
        } else {
          // Once the caster has hit the mana wall at least once, further
          // decisions switch to pure damage-per-mana — burning the last of
          // the pool on the priority mode's ideal spell just runs it dry
          // faster; efficiency is what stretches the remaining fight.
          var effectiveMode = ranOutOfManaAt !== null ? 'sustain' : priorityMode;
          var bestScore = -Infinity;
          candidates.forEach(function (c) {
            var offGlobal = isOffGlobal(c, offGlobalSpellId);
            var edmg = evEffectiveDamage(c);
            var s = score(c, effectiveMode, offGlobal, edmg, maxDpsScore, maxManaScore);
            if (s > bestScore) { bestScore = s; best = c; }
          });
        }

        var offGlobalBest = isOffGlobal(best, offGlobalSpellId);
        var castEnd = t + best.castTime;

        // Would this cast still be running when the next tick lands? Since
        // you can't cast while sitting, that tick would land while standing
        // (mid-cast) and only grant the standing rate — so instead, sit and
        // wait for the tick, then reconsider once it's landed.
        if (sitForMedTicks && nextManaTickAt < fightDurationSec && nextManaTickAt < castEnd - 1e-9) {
          t = nextManaTickAt;
          continue;
        }

        if (!unlimited) { mana = m - best.mana; lastManaUpdateT = t; }

        // Real crit roll for this specific cast (one roll per cast, even for
        // a multi-wave rain/DoT — real per-wave/per-tick crit independence
        // isn't modeled, consistent with the rest of this sim crediting a
        // rain/DoT's full damage to a single cast event). Precedence matches
        // Client::GetActSpellDamage (effects.cpp): Spell Casting Fury is
        // rolled first; the wizard's innate crit only gets a chance to fire
        // on casts where the SCF roll didn't land, not as an independent/
        // additive roll — so it can only add crits on top of what SCF alone
        // would produce, never double up on the same cast.
        var baseDmg = baseEffectiveDamage(best);
        var scfCrit = rng() < (best._critChance || 0);
        var innateCrit = false, innateBonus = 0;
        if (!scfCrit && best._innateCritChance > 0) {
          innateCrit = rng() < best._innateCritChance;
          if (innateCrit) innateBonus = (Math.floor(rng() * 50) + 1) / 100;   // Int(1,50)/100, per effects.cpp
        }
        var isCrit = scfCrit || innateCrit;
        // P(crit) = P(SCF crits) + P(SCF doesn't) * P(innate crits) — same
        // precedence as the real roll above, just summed instead of rolled.
        expectedCritCount += (best._critChance || 0) +
          (1 - (best._critChance || 0)) * (best._innateCritChance || 0);
        var critSource = scfCrit ? 'scf' : (innateCrit ? 'innate' : null);
        var bonus = scfCrit ? (best._critBonus || 0) : innateBonus;
        var castDamage = isCrit ? baseDmg * (1 + bonus) : baseDmg;
        if (best._quickDamageApplied) quickDamageCastCount += 1;

        // Direct-damage hate from the caster's own class spell is uncapped
        // (CanClassCastSpell is true) — hate equals the damage dealt.
        var castThreat = castDamage;

        totalDamage += castDamage;
        totalMana += best.mana;
        totalThreat += castThreat;
        castCount += 1;
        focusDamageGain += castDamage * (best._focusDamageGainFraction || 0);
        focusManaSaved += best._focusManaSaved || 0;
        if (castDamage > maxHit) maxHit = castDamage;
        if (isCrit) {
          critCount += 1;
          critDamageBonus += castDamage - baseDmg;
          if (critSource === 'scf') scfCritCount += 1; else innateCritCount += 1;
        }
        log.push({
          time: t, spellId: best.id, spellName: best.name,
          effectiveDamage: castDamage, manaCost: best.mana, threat: castThreat,
          isCrit: isCrit, critSource: critSource,
          kind: offGlobalBest ? 'offGlobal' : 'gcd',
          // Not part of the spec's CastLogEntry shape — kept for the
          // timeline visualization (buildRotationTimelineHtml) so it can
          // draw each cast's actual width without recomputing it.
          duration: best.castTime,
          // Rain/DoT metadata: the cast itself is still one event (one GCD,
          // one mana cost, one recast timer, same as any other spell) —
          // this only matters for how its damage is *displayed* over time,
          // since a rain or DoT actually lands in waves(count) hits spaced
          // waveIntervalSec apart starting when the cast completes, not as
          // a lump at cast time. See expandToDamageEvents / buildRotationTimelineHtml.
          waves: best.waves || 1,
          waveIntervalSec: best.waveIntervalSec || 0,
          isRain: !!best.isRain,
          isDot: !!best.isDot
        });
        if (best.isDot) {
          // A DoT that's recast while still active is simply overwritten —
          // the remaining ticks of the old application are lost, not
          // stacked or extended. So it never makes sense to recast one
          // before the current application would have finished ticking;
          // gate its next availability on that (or its own recast timer,
          // if that's somehow longer) rather than the recast timer alone.
          // This is what makes the greedy pick "cycle" DoTs instead of
          // spamming the same one and overwriting itself every cast.
          var dotDuration = (best.waves || 1) * (best.waveIntervalSec || DOT_TICK_SEC);
          availAt[best.id] = Math.max(castEnd + best.recastTime, castEnd + dotDuration);
        } else {
          availAt[best.id] = castEnd + best.recastTime;
        }
        busyUntil = castEnd;
        if (!offGlobalBest) gcdFree = castEnd + GCD;
        t = castEnd;
        continue;
      }

      if (!unlimited && ranOutOfManaAt === null) {
        var wouldBeReadyIgnoringMana = pool.some(function (spell) {
          var offGlobal = isOffGlobal(spell, offGlobalSpellId);
          return availAt[spell.id] <= t && (offGlobal || gcdFree <= t);
        });
        if (wouldBeReadyIgnoringMana) ranOutOfManaAt = t;
      }

      var nextTimes = [];
      if (gcdFree > t) nextTimes.push(gcdFree);
      pool.forEach(function (spell) { if (availAt[spell.id] > t) nextTimes.push(availAt[spell.id]); });
      var nextT = nextTimes.length ? Math.min.apply(null, nextTimes) : t + 0.25;
      if (nextT <= t) nextT = t + 0.1;
      t = Math.min(nextT, fightDurationSec);
    }

    return {
      totalDamage: totalDamage,
      totalMana: totalMana,
      totalThreat: totalThreat,
      castCount: castCount,
      durationSec: fightDurationSec,
      dps: totalDamage / fightDurationSec,
      manaPerSec: totalMana / fightDurationSec,
      tps: totalThreat / fightDurationSec,
      manaRemaining: unlimited ? null : manaAt(t),
      ranOutOfManaAt: ranOutOfManaAt,
      log: log,
      truncatedPool: truncatedPool,
      gearSummary: gearSummary,
      // Crit stats — real per-cast rolls (see the isCrit roll above), not an
      // expected-value estimate. maxHit is the single largest cast; critDps
      // is the incremental damage attributable to critting (castDamage minus
      // what that same cast would have done without the crit), not the full
      // damage of crit casts, so it isolates what the crit chance itself is
      // worth rather than double-counting the base damage under it.
      maxHit: maxHit,
      critCount: critCount,
      critRate: castCount > 0 ? critCount / castCount : 0,
      // Analytic average crits per run (sum of each cast's real crit
      // probability) — stable across re-runs/seeds, unlike critCount above.
      expectedCritCount: expectedCritCount,
      expectedCritRate: castCount > 0 ? expectedCritCount / castCount : 0,
      critDamageBonus: critDamageBonus,
      critDps: critDamageBonus / fightDurationSec,
      // Split by source: Spell Casting Fury crits vs. the wizard's own
      // innate crit (only rolled on casts SCF didn't already crit).
      scfCritCount: scfCritCount,
      innateCritCount: innateCritCount,
      quickDamageCastCount: quickDamageCastCount,
      manualMode: !!manualOrder,
      // Item focus effects' isolated contribution — same "marginal value"
      // treatment as critDamageBonus above: how much MORE damage landed (or
      // mana was spent) than would have without the focus effects, not the
      // full totals of whatever spells happened to have one applied.
      focusDamageGain: focusDamageGain,
      focusDamageGainDps: focusDamageGain / fightDurationSec,
      focusManaSaved: focusManaSaved,
      focusManaSavedPerSec: focusManaSaved / fightDurationSec
    };
  }

  // ---------------------------------------------------------------------------
  // Rotation cycle detection
  // ---------------------------------------------------------------------------

  /**
   * Smallest period p such that the LAST p*minReps entries of ids are
   * minReps exact repeats of a p-long pattern. Search order is smallest
   * period first, so a real steady-state cycle is found before a longer
   * coincidental match. Capped well above MAX_MEMORIZED_SPELLS since a
   * cycle can revisit a spell before every gem has been used once.
   */
  function detectCyclePeriod(ids, minReps) {
    var n = ids.length;
    var maxPeriod = Math.min(24, Math.floor(n / minReps));
    for (var p = 1; p <= maxPeriod; p++) {
      var need = p * minReps;
      if (need > n) break;
      var start = n - need;
      var ok = true;
      for (var i = start; i < n - p; i++) {
        if (ids[i] !== ids[i + p]) { ok = false; break; }
      }
      if (ok) return p;
    }
    return null;
  }

  function cycleForSegment(segment) {
    if (segment.length < 2) return null;
    var ids = segment.map(function (e) { return e.spellId; });
    var period = detectCyclePeriod(ids, 3) || detectCyclePeriod(ids, 2);
    if (!period) return null;
    var names = segment.slice(segment.length - period).map(function (e) { return e.spellName; });
    return { period: period, names: names };
  }

  /**
   * The greedy pick settles into a repeating cycle once recast timers (and,
   * post-mana-wall, the switch to sustain scoring) reach steady state. This
   * finds that cycle in the burn phase and, separately, in the mana-starved
   * tail (its scoring differs, so it's typically a different — often
   * shorter — cycle), so the report can show the rotation explicitly rather
   * than making the reader infer it from a long cast log.
   */
  function summarizeRotationCycle(result) {
    var log = result.log;
    if (!log.length) return null;

    var starvedAt = result.ranOutOfManaAt;
    var splitIdx = log.length;
    if (starvedAt != null) {
      for (var i = 0; i < log.length; i++) {
        if (log[i].time >= starvedAt) { splitIdx = i; break; }
      }
    }

    var burn = cycleForSegment(log.slice(0, splitIdx));
    var starved = starvedAt != null ? cycleForSegment(log.slice(splitIdx)) : null;
    if (!burn && !starved) return null;
    return { burn: burn, starved: starved, starvedAt: starvedAt };
  }

  // ---------------------------------------------------------------------------
  // Report formatting
  // ---------------------------------------------------------------------------

  function formatRotationReport(result) {
    var C = 50;
    function pad(label, value) {
      return label + ' '.repeat(Math.max(1, C - label.length)) + value;
    }
    function fmt(v, d) {
      if (v == null || v === Infinity) return '—';
      return d != null ? Number(v).toFixed(d) : (Number.isInteger(v) ? String(v) : Number(v).toFixed(2));
    }

    var lines = [];
    lines.push(result.manualMode ? '=== Rotation Result (custom order) ===' : '=== Rotation Result ===', '');
    if (result.manualMode) {
      lines.push('  Using your custom cast order, not the auto-optimizer — see the Rotation line below for how it played out.');
    }
    lines.push(pad('  Fight duration:', fmt(result.durationSec, 0) + ' sec'));
    lines.push(pad('  Total casts:', fmt(result.castCount, 0)));
    lines.push(pad('  Total damage:', fmt(result.totalDamage, 0)));
    lines.push(pad('  DPS:', fmt(result.dps, 2)));
    lines.push(pad('  Max hit:', fmt(result.maxHit, 0)));
    lines.push(pad('  Total threat:', fmt(result.totalThreat, 0)));
    lines.push(pad('  TPS:', fmt(result.tps, 2) +
      '  (direct-damage hate from your own class spells, uncapped)'));
    lines.push(pad('  Total mana spent:', fmt(result.totalMana, 0)));
    lines.push(pad('  Mana/sec:', fmt(result.manaPerSec, 2)));
    if (result.manaRemaining != null) {
      lines.push(pad('  Mana remaining at end:', fmt(result.manaRemaining, 0)));
    }
    if (result.ranOutOfManaAt != null) {
      lines.push(pad('  Ran out of mana at:', fmt(result.ranOutOfManaAt, 1) + ' sec'));
    }
    if (result.truncatedPool) {
      lines.push('  Note: pool trimmed to the first ' + MAX_MEMORIZED_SPELLS +
        ' spells — only that many can be memorized at once.');
    }
    var gs = result.gearSummary;
    var hasCritSource = gs && (gs.spellCritRank > 0 || gs.innateCritChance > 0);
    if (gs && (hasCritSource || gs.focusNames.length)) {
      lines.push('');
      lines.push('  -- AA & gear applied --');
      if (gs.spellCritRank > 0) {
        var cr = SPELL_CRIT_RANKS[gs.spellCritRank];
        lines.push('  Spell Casting Fury rank ' + gs.spellCritRank + ': ' +
          (cr.chance * 100).toFixed(0) + '% chance to crit for +' + (cr.bonus * 100).toFixed(0) + '% damage.');
      }
      if (gs.spellCritMasteryRank > 0) {
        lines.push('  Spell Casting Fury Mastery rank ' + gs.spellCritMasteryRank + ': +' +
          (SPELL_CRIT_MASTERY_CHANCE[gs.spellCritMasteryRank] * 100).toFixed(0) +
          '% additional crit chance (chance only, stacks with Spell Casting Fury above; no extra damage bonus).');
      }
      if (gs.quickDamageRank > 0) {
        lines.push('  Quick Damage rank ' + gs.quickDamageRank + ': -' +
          ((1 - QUICK_DAMAGE_CAST_MOD[gs.quickDamageRank]) * 100).toFixed(0) +
          '% cast time on direct-damage nukes/rains over 4s (DoTs unaffected)' +
          (result.quickDamageCastCount ? ' — applied to ' + fmt(result.quickDamageCastCount, 0) + ' casts.' : '.'));
      }
      if (gs.innateCritChance > 0) {
        lines.push('  Wizard innate crit: ' + (gs.innateCritChance * 100).toFixed(2) +
          '% chance (from INT/DEX), +1-50% damage on hit — only rolls on casts Spell Casting Fury didn\'t already crit.');
      }
      if (hasCritSource) {
        lines.push(pad('  Crits landed:', fmt(result.critCount, 0) + ' of ' + fmt(result.castCount, 0) +
          ' casts (' + (result.critRate * 100).toFixed(1) + '%)' +
          (gs.spellCritRank > 0 && gs.innateCritChance > 0
            ? '  — ' + fmt(result.scfCritCount, 0) + ' AA, ' + fmt(result.innateCritCount, 0) + ' innate'
            : '')));
        lines.push(pad('  Avg crits per run:', fmt(result.expectedCritCount, 1) + ' of ' + fmt(result.castCount, 0) +
          ' casts (' + (result.expectedCritRate * 100).toFixed(1) + '%)' +
          '  — analytic average across runs; this run rolled ' + fmt(result.critCount, 0) + '.'));
        lines.push(pad('  DPS from crits:', fmt(result.critDps, 2) +
          '  (extra damage the crit chance itself contributed, not the full damage of crit hits)'));
      }
      if (gs.focusNames.length) {
        lines.push('  Focus effects in use: ' + gs.focusNames.join(', ') + '.');
        if (result.focusDamageGain > 0) {
          lines.push(pad('  Extra damage from focus:', fmt(result.focusDamageGain, 0) +
            ' (' + fmt(result.focusDamageGainDps, 2) + ' dps)'));
          lines.push('    Isolated to the casts that actually got a damage focus in this run, not a with/without');
          lines.push('    comparison — removing the item could also change which spells the optimizer prefers.');
        }
        if (result.focusManaSaved > 0) {
          lines.push(pad('  Mana saved (focus + specialization):', fmt(result.focusManaSaved, 0) +
            ' (' + fmt(result.focusManaSavedPerSec, 2) + '/sec)'));
        }
      }
    }
    lines.push('');

    var cycle = summarizeRotationCycle(result);
    if (cycle) {
      lines.push('  -- Rotation --');
      if (cycle.burn) {
        lines.push('  ' + cycle.burn.names.join(' → ') +
          (cycle.burn.names.length > 1 ? ' → ' + cycle.burn.names[0] + ' ...' : ' (repeat)'));
      } else {
        lines.push('  No steady repeating cycle found yet — see the cast-order chart below.');
      }
      if (cycle.starved) {
        lines.push('  Once mana runs low (~' + fmt(cycle.starvedAt, 0) + 's): ' +
          cycle.starved.names.join(' → ') +
          (cycle.starved.names.length > 1 ? ' → ' + cycle.starved.names[0] + ' ...' : ' on repeat'));
      }
      lines.push('');
    }

    if (result.log.length) {
      var bySpell = {};
      var anyRain = false, anyDot = false;
      result.log.forEach(function (e) {
        var s = bySpell[e.spellId] || (bySpell[e.spellId] = {
          name: e.spellName, casts: 0, damage: 0, mana: 0, kind: e.kind,
          isRain: e.isRain, isDot: e.isDot, waves: e.waves
        });
        s.casts++; s.damage += e.effectiveDamage; s.mana += e.manaCost;
        if (e.isRain) anyRain = true;
        if (e.isDot) anyDot = true;
      });
      lines.push('  -- Casts by spell --');
      Object.keys(bySpell)
        .sort(function (a, b) { return bySpell[b].damage - bySpell[a].damage; })
        .forEach(function (id) {
          var s = bySpell[id];
          var tag = (s.kind === 'offGlobal' ? ' (off-global)' : '') +
            (s.isRain ? ' [rain ×' + s.waves + ']' : '') +
            (s.isDot ? ' [DoT ×' + s.waves + ' ticks]' : '');
          lines.push(pad('  ' + s.name + tag + ':',
            fmt(s.casts, 0) + ' casts, ' + fmt(s.damage, 0) + ' dmg, ' + fmt(s.mana, 0) + ' mana'));
        });
      if (anyRain) {
        lines.push('  Rain damage lands in independently-resisted waves 2.5s apart, starting the instant the' +
          ' cast completes — the caster is free to cast something else while those waves land (see the charts below).');
      }
      if (anyDot) {
        lines.push('  DoTs tick for their listed damage every 6s; recasting one early overwrites it and loses' +
          ' the remaining ticks, so the sim only ever recasts a DoT once its current application has run out —' +
          ' cycling between DoTs (and nukes) rather than refreshing the same one early.');
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  // ---------------------------------------------------------------------------
  // Cast-order timeline (Gantt-style)
  // ---------------------------------------------------------------------------

  // Fixed categorical order, dark-surface steps (gSim is dark-only) — see
  // the dataviz skill's reference palette. Never cycled; the 9th distinct
  // spell and beyond fold into "Other" rather than generating a new hue.
  var SERIES_COLORS = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];
  var OTHER_COLOR = '#7a7a76';
  var SURFACE_COLOR = '#121216';  // matches gSim's --input-bg — the marker ring

  function escapeXml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /** White or dark ink, whichever clears contrast against a given fill. */
  function textColorForFill(hex) {
    var r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
    var luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return luminance > 0.55 ? '#0b0b0b' : '#ffffff';
  }

  /** Assign a stable color per spell, ranked by total damage over the full log. */
  function assignSeriesColors(log) {
    var totals = {};
    log.forEach(function (e) {
      var t = totals[e.spellId] || (totals[e.spellId] = { name: e.spellName, damage: 0, casts: 0 });
      t.damage += e.effectiveDamage;
      t.casts += 1;
    });
    var order = Object.keys(totals).sort(function (a, b) { return totals[b].damage - totals[a].damage; });
    var colorMap = {};
    order.forEach(function (id, i) { colorMap[id] = i < SERIES_COLORS.length ? SERIES_COLORS[i] : OTHER_COLOR; });
    return { totals: totals, order: order, colorMap: colorMap };
  }

  /**
   * Expands the cast log into individual damage events for time-series
   * display: a normal cast is one event at its cast time, but a rain or DoT's
   * damage actually lands as `waves` separate hits, `waveIntervalSec` apart,
   * starting the moment the cast completes — so a chart bucketing by time
   * (buildRotationDpsOverTimeHtml) should see it that way rather than as one
   * lump at cast start. Doesn't change any totals, only when they land.
   */
  function expandToDamageEvents(log) {
    var events = [];
    log.forEach(function (e) {
      if (e.waves > 1 && e.waveIntervalSec > 0) {
        var perWave = e.effectiveDamage / e.waves;
        var landAt = e.time + (e.duration || 0);
        for (var i = 0; i < e.waves; i++) {
          events.push({
            time: landAt + i * e.waveIntervalSec,
            spellId: e.spellId, spellName: e.spellName, effectiveDamage: perWave, threat: perWave
          });
        }
      } else {
        events.push({
          time: e.time, spellId: e.spellId, spellName: e.spellName,
          effectiveDamage: e.effectiveDamage, threat: e.effectiveDamage
        });
      }
    });
    return events;
  }

  /**
   * A Gantt-style timeline of the greedy rotation's cast order: one lane for
   * GCD-chain casts, a second for the off-global filler (if used), colored
   * by spell with a legend. Returns an HTML string for direct insertion —
   * no DOM access here, matching the rest of this module.
   */
  function buildRotationTimelineHtml(result) {
    if (!result || !result.log || !result.log.length) {
      return '<p class="hint" style="margin:0;">No casts to display.</p>';
    }

    var PX_PER_SEC = 28;
    // Wide enough that the lane label ("Off-GCD" is the longest) never sits
    // under/against the first bar's own label.
    var LEAD_IN = 46;
    var LANE_H = 24;
    var LANE_GAP = 8;
    var AXIS_H = 20;
    var GRID_STEP = 5;
    var FONT_SIZE = 10;
    // Rough average glyph width for the system sans at FONT_SIZE — used only
    // to decide whether a label fits; skip it rather than let it clip.
    var CHAR_WIDTH = 5.8;

    var hasOffGlobal = result.log.some(function (e) { return e.kind === 'offGlobal'; });
    var laneY = { gcd: 0, offGlobal: hasOffGlobal ? (LANE_H + LANE_GAP) : 0 };
    var plotH = hasOffGlobal ? (2 * LANE_H + LANE_GAP) : LANE_H;

    var windowSec = Math.min(result.durationSec, 300);
    var visible = result.log.filter(function (e) { return e.time < windowSec; });
    var colors = assignSeriesColors(result.log);

    var width = Math.max(200, LEAD_IN + Math.ceil(windowSec * PX_PER_SEC) + 10);
    var height = plotH + AXIS_H;

    var svg = [];
    for (var s = 0; s <= windowSec; s += GRID_STEP) {
      var gx = LEAD_IN + s * PX_PER_SEC;
      svg.push('<line x1="' + gx + '" y1="0" x2="' + gx + '" y2="' + plotH + '" stroke="#2c2c2a" stroke-width="1"/>');
      svg.push('<text x="' + gx + '" y="' + (height - 5) + '" font-size="10" fill="#898781" text-anchor="middle">' + s + 's</text>');
    }

    visible.forEach(function (e) {
      var y = e.kind === 'offGlobal' ? laneY.offGlobal : laneY.gcd;
      var dur = Math.max(0.05, e.duration || 0.1);
      var clippedDur = Math.min(dur, windowSec - e.time);
      var x = LEAD_IN + e.time * PX_PER_SEC;
      var w = Math.max(2, clippedDur * PX_PER_SEC - 2);
      var color = colors.colorMap[e.spellId] || OTHER_COLOR;
      var tip = e.spellName + ' — ' + e.time.toFixed(2) + 's, ' +
        Math.round(e.effectiveDamage) + ' dmg, ' + e.manaCost + ' mana' + (e.isCrit ? ' — CRIT!' : '');
      svg.push(
        '<rect x="' + x.toFixed(1) + '" y="' + y + '" width="' + w.toFixed(1) + '" height="' + LANE_H +
        '" rx="4" fill="' + color + '"' + (e.isCrit ? ' stroke="' + WARNING_COLOR + '" stroke-width="2"' : '') +
        '><title>' + escapeXml(tip) + '</title></rect>'
      );
      // Only label the bar if the name actually fits — a clipped name is
      // worse than no name; the hover tooltip and legend carry it either way.
      if (e.spellName.length * CHAR_WIDTH <= w - 6) {
        svg.push(
          '<text x="' + (x + w / 2).toFixed(1) + '" y="' + (y + LANE_H / 2 + 3.5) +
          '" font-size="' + FONT_SIZE + '" fill="' + textColorForFill(color) +
          '" text-anchor="middle" pointer-events="none">' + escapeXml(e.spellName) + '</text>'
        );
      }

      // Rain waves / DoT ticks land after the cast bar ends, one every
      // waveIntervalSec — mark each hit so it's visually obvious the
      // damage trickles in rather than landing all at once with the cast.
      if (e.waves > 1 && e.waveIntervalSec > 0) {
        var perWaveDmg = e.effectiveDamage / e.waves;
        var landStart = e.time + dur;
        var unitLabel = e.isRain ? 'wave' : 'tick';
        var mechanicNote = e.isRain ? ' (independent resist roll)' : ' (DoT tick)';
        for (var wi = 0; wi < e.waves; wi++) {
          var wt = landStart + wi * e.waveIntervalSec;
          if (wt >= windowSec) break;
          var wx = LEAD_IN + wt * PX_PER_SEC;
          var wy = y + LANE_H / 2;
          var wTip = e.spellName + ' ' + unitLabel + ' ' + (wi + 1) + '/' + e.waves + ' — ' +
            wt.toFixed(2) + 's, ' + Math.round(perWaveDmg) + ' dmg' + mechanicNote;
          svg.push(
            '<circle cx="' + wx.toFixed(1) + '" cy="' + wy.toFixed(1) + '" r="4" fill="' + color +
            '" stroke="' + SURFACE_COLOR + '" stroke-width="2"><title>' + escapeXml(wTip) + '</title></circle>'
          );
        }
      }
    });

    // Drawn last (on top of every bar) with an opaque background chip behind
    // the text, so the lane label is always legible regardless of what's
    // sitting in that lane at x=0 — it used to render underneath the first
    // bar and could be partly covered by it.
    function laneLabel(label, y) {
      var textW = label.length * CHAR_WIDTH + 6;
      return '<rect x="0" y="' + y + '" width="' + textW.toFixed(1) + '" height="' + LANE_H +
        '" fill="' + SURFACE_COLOR + '" fill-opacity="0.85"/>' +
        '<text x="3" y="' + (y + LANE_H / 2 + 3.5) + '" font-size="10" fill="#c3c2b7">' + label + '</text>';
    }
    var laneLabels = laneLabel('GCD', laneY.gcd) + (hasOffGlobal ? laneLabel('Off-GCD', laneY.offGlobal) : '');

    var legend = colors.order.map(function (id) {
      var t = colors.totals[id];
      var pct = result.totalDamage > 0 ? (100 * t.damage / result.totalDamage) : 0;
      return '<span style="display:inline-flex;align-items:center;gap:0.35rem;margin:0 0.75rem 0.3rem 0;">' +
        '<span style="width:10px;height:10px;border-radius:2px;flex:none;background:' + colors.colorMap[id] + ';"></span>' +
        '<span style="font-size:0.8rem;color:var(--text);">' + escapeXml(t.name) + ' — ' + t.casts +
        ' casts, ' + pct.toFixed(0) + '% dmg</span></span>';
    }).join('');

    var windowNote = windowSec < result.durationSec
      ? ' Showing the first ' + windowSec + 's of ' + Math.round(result.durationSec) + 's simulated — the pattern repeats once recast timers settle into their cycle.'
      : '';
    var hasVisibleWaves = visible.some(function (e) { return e.waves > 1 && e.waveIntervalSec > 0; });
    var waveNote = hasVisibleWaves
      ? ' The small dots after a bar are its rain waves or DoT ticks landing over time.'
      : '';

    return (
      '<p class="hint" style="margin:0 0 0.4rem;">Cast order, earliest to latest.' + windowNote + waveNote + ' Hover a block for details.</p>' +
      '<div style="overflow-x:auto;border:1px solid var(--border);border-radius:4px;background:var(--input-bg);padding:0.5rem 0.5rem 0.25rem;">' +
      '<svg width="' + width + '" height="' + height + '" style="display:block;">' + svg.join('') + laneLabels + '</svg>' +
      '</div>' +
      '<div style="margin-top:0.5rem;">' + legend + '</div>'
    );
  }

  // ---------------------------------------------------------------------------
  // DPS-over-time line chart
  // ---------------------------------------------------------------------------

  var DPS_LINE_COLOR = '#3987e5';       // categorical slot 1 — bucketed (instantaneous) DPS
  var ROLLING_LINE_COLOR = '#d95926';   // categorical slot 2 — rolling 30s average
  var TPS_LINE_COLOR = '#199e70';       // categorical slot 3 — bucketed threat/sec
  var WARNING_COLOR = '#fab219';    // status palette: reserved, never a series color
  var MUTED_INK = '#898781';
  var GRID_COLOR = '#2c2c2a';
  var ROLL_WINDOW_SEC = 30;

  /**
   * Trailing N-second average DPS at each of a sorted list of times, from a
   * sorted-by-time damage-event list. Smooths out per-bucket jitter (a
   * bucket that happens to catch a big rain/DoT tick vs. one that doesn't)
   * so the underlying trend — and the mana-wall step down — reads clearly.
   */
  function rollingAverageSeries(events, times, windowSec) {
    var qStart = 0, qEnd = 0, windowSum = 0;
    return times.map(function (t) {
      while (qEnd < events.length && events[qEnd].time <= t) { windowSum += events[qEnd].effectiveDamage; qEnd++; }
      var windowStart = t - windowSec;
      while (qStart < qEnd && events[qStart].time <= windowStart) { windowSum -= events[qStart].effectiveDamage; qStart++; }
      var elapsed = Math.min(windowSec, t) || 1;
      return windowSum / elapsed;
    });
  }

  /**
   * Bucketed DPS across the whole fight, so the drop when mana runs out (and
   * the new, lower steady state after the sim switches to damage-per-mana
   * scoring) is visible at a glance rather than buried in the averaged
   * headline DPS figure.
   */
  function buildRotationDpsOverTimeHtml(result) {
    if (!result || !result.log || !result.log.length || result.durationSec <= 0) {
      return '<p class="hint" style="margin:0;">No data to chart.</p>';
    }

    var TARGET_BUCKETS = 120;
    var bucketWidth = Math.max(1, Math.ceil(result.durationSec / TARGET_BUCKETS));
    var bucketCount = Math.ceil(result.durationSec / bucketWidth);

    var events = expandToDamageEvents(result.log).sort(function (a, b) { return a.time - b.time; });

    var buckets = new Array(bucketCount).fill(0);
    var threatBuckets = new Array(bucketCount).fill(0);
    // Bucket by when damage actually lands, not when the cast started — a
    // rain's damage is spread across its waves, so this is what makes it
    // show up as a short-lived bump instead of one instantaneous spike.
    events.forEach(function (e) {
      var idx = Math.min(bucketCount - 1, Math.max(0, Math.floor(e.time / bucketWidth)));
      buckets[idx] += e.effectiveDamage;
      threatBuckets[idx] += e.threat;
    });

    var points = buckets.map(function (dmg, i) {
      var start = i * bucketWidth;
      var end = Math.min(result.durationSec, start + bucketWidth);
      var width = Math.max(0.001, end - start);
      return { t: start + width / 2, dps: dmg / width, tps: threatBuckets[i] / width, start: start, end: end };
    });

    var rollingDps = rollingAverageSeries(events, points.map(function (p) { return p.t; }), ROLL_WINDOW_SEC);

    var maxDps = 0;
    points.forEach(function (p) { if (p.dps > maxDps) maxDps = p.dps; if (p.tps > maxDps) maxDps = p.tps; });
    rollingDps.forEach(function (v) { if (v > maxDps) maxDps = v; });
    maxDps = maxDps > 0 ? maxDps * 1.15 : 1;

    var W = 780, H = 200;
    var marginLeft = 44, marginRight = 12, marginTop = 12, marginBottom = 22;
    var plotW = W - marginLeft - marginRight;
    var plotH = H - marginTop - marginBottom;

    function xFor(t) { return marginLeft + (t / result.durationSec) * plotW; }
    function yFor(dps) { return marginTop + plotH - (dps / maxDps) * plotH; }

    var svg = [];

    var yTicks = 4;
    for (var gi = 0; gi <= yTicks; gi++) {
      var val = (maxDps / yTicks) * gi;
      var gy = yFor(val);
      svg.push('<line x1="' + marginLeft + '" y1="' + gy.toFixed(1) + '" x2="' + (W - marginRight) +
        '" y2="' + gy.toFixed(1) + '" stroke="' + GRID_COLOR + '" stroke-width="1"/>');
      svg.push('<text x="' + (marginLeft - 6) + '" y="' + (gy + 3).toFixed(1) +
        '" font-size="10" fill="' + MUTED_INK + '" text-anchor="end">' + Math.round(val) + '</text>');
    }

    var xTickCount = 6;
    for (var xi = 0; xi <= xTickCount; xi++) {
      var xt = (result.durationSec / xTickCount) * xi;
      svg.push('<text x="' + xFor(xt).toFixed(1) + '" y="' + (H - 6) +
        '" font-size="10" fill="' + MUTED_INK + '" text-anchor="middle">' + Math.round(xt) + 's</text>');
    }

    var areaPath = 'M' + xFor(0).toFixed(1) + ',' + yFor(0).toFixed(1) + ' ';
    points.forEach(function (p) { areaPath += 'L' + xFor(p.t).toFixed(1) + ',' + yFor(p.dps).toFixed(1) + ' '; });
    areaPath += 'L' + xFor(result.durationSec).toFixed(1) + ',' + yFor(0).toFixed(1) + ' Z';
    svg.push('<path d="' + areaPath + '" fill="' + DPS_LINE_COLOR + '" fill-opacity="0.12" stroke="none"/>');

    var linePoints = points.map(function (p) {
      return xFor(p.t).toFixed(1) + ',' + yFor(p.dps).toFixed(1);
    }).join(' ');
    svg.push('<polyline points="' + linePoints + '" fill="none" stroke="' + DPS_LINE_COLOR +
      '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>');

    // Invisible larger hit targets carry the hover tooltip per bucket.
    points.forEach(function (p) {
      var tip = 't=' + Math.round(p.start) + '–' + Math.round(p.end) + 's: ' + p.dps.toFixed(1) + ' dps';
      svg.push('<circle cx="' + xFor(p.t).toFixed(1) + '" cy="' + yFor(p.dps).toFixed(1) +
        '" r="7" fill="transparent"><title>' + escapeXml(tip) + '</title></circle>');
    });

    var rollingLinePoints = points.map(function (p, i) {
      return xFor(p.t).toFixed(1) + ',' + yFor(rollingDps[i]).toFixed(1);
    }).join(' ');
    svg.push('<polyline points="' + rollingLinePoints + '" fill="none" stroke="' + ROLLING_LINE_COLOR +
      '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>');
    points.forEach(function (p, i) {
      var tip = 't=' + p.t.toFixed(1) + 's, trailing ' + ROLL_WINDOW_SEC + 's avg: ' + rollingDps[i].toFixed(1) + ' dps';
      svg.push('<circle cx="' + xFor(p.t).toFixed(1) + '" cy="' + yFor(rollingDps[i]).toFixed(1) +
        '" r="7" fill="transparent"><title>' + escapeXml(tip) + '</title></circle>');
    });

    var tpsLinePoints = points.map(function (p) {
      return xFor(p.t).toFixed(1) + ',' + yFor(p.tps).toFixed(1);
    }).join(' ');
    svg.push('<polyline points="' + tpsLinePoints + '" fill="none" stroke="' + TPS_LINE_COLOR +
      '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>');
    points.forEach(function (p) {
      var tip = 't=' + Math.round(p.start) + '–' + Math.round(p.end) + 's: ' + p.tps.toFixed(1) + ' tps';
      svg.push('<circle cx="' + xFor(p.t).toFixed(1) + '" cy="' + yFor(p.tps).toFixed(1) +
        '" r="7" fill="transparent"><title>' + escapeXml(tip) + '</title></circle>');
    });

    var avgY = yFor(result.dps);
    svg.push('<line x1="' + marginLeft + '" y1="' + avgY.toFixed(1) + '" x2="' + (W - marginRight) +
      '" y2="' + avgY.toFixed(1) + '" stroke="' + MUTED_INK + '" stroke-width="1" stroke-dasharray="3,3"/>');
    svg.push('<text x="' + (W - marginRight) + '" y="' + (avgY - 4).toFixed(1) +
      '" font-size="10" fill="' + MUTED_INK + '" text-anchor="end">avg ' + result.dps.toFixed(1) + '</text>');

    var manaNote = '';
    if (result.ranOutOfManaAt != null && result.ranOutOfManaAt <= result.durationSec) {
      var mx = xFor(result.ranOutOfManaAt);
      svg.push('<line x1="' + mx.toFixed(1) + '" y1="' + marginTop + '" x2="' + mx.toFixed(1) +
        '" y2="' + (marginTop + plotH) + '" stroke="' + WARNING_COLOR + '" stroke-width="1.5" stroke-dasharray="4,3"/>');
      svg.push('<text x="' + (mx + 4).toFixed(1) + '" y="' + (marginTop + 10) +
        '" font-size="10" fill="' + WARNING_COLOR + '">Mana low</text>');
      manaNote = ' The dashed amber line marks ' + result.ranOutOfManaAt.toFixed(0) +
        's, when mana first ran out and casting switched to damage-per-mana priority.';
    }

    var legend =
      '<span style="display:inline-flex;align-items:center;gap:0.35rem;margin:0 0.75rem 0.3rem 0;">' +
      '<span style="width:14px;height:2px;flex:none;background:' + DPS_LINE_COLOR + ';"></span>' +
      '<span style="font-size:0.8rem;color:var(--text);">DPS per ' + bucketWidth + 's window</span></span>' +
      '<span style="display:inline-flex;align-items:center;gap:0.35rem;margin:0 0.75rem 0.3rem 0;">' +
      '<span style="width:14px;height:2px;flex:none;background:' + ROLLING_LINE_COLOR + ';"></span>' +
      '<span style="font-size:0.8rem;color:var(--text);">Trailing ' + ROLL_WINDOW_SEC + 's average</span></span>' +
      '<span style="display:inline-flex;align-items:center;gap:0.35rem;">' +
      '<span style="width:14px;height:2px;flex:none;background:' + TPS_LINE_COLOR + ';"></span>' +
      '<span style="font-size:0.8rem;color:var(--text);">TPS per ' + bucketWidth + 's window</span></span>';

    return (
      '<p class="hint" style="margin:0 0 0.4rem;">DPS and TPS over time.' + manaNote + '</p>' +
      '<div style="overflow-x:auto;border:1px solid var(--border);border-radius:4px;background:var(--input-bg);padding:0.5rem;">' +
      '<svg width="' + W + '" height="' + H + '" style="display:block;">' + svg.join('') + '</svg>' +
      '</div>' +
      '<div style="margin-top:0.5rem;">' + legend + '</div>'
    );
  }

  global.RotationEngine = {
    GCD: GCD,
    MAX_MEMORIZED_SPELLS: MAX_MEMORIZED_SPELLS,
    simulateRotation: simulateRotation,
    rankSpellPool: rankSpellPool,
    formatRotationReport: formatRotationReport,
    buildRotationTimelineHtml: buildRotationTimelineHtml,
    buildRotationDpsOverTimeHtml: buildRotationDpsOverTimeHtml,
    summarizeRotationCycle: summarizeRotationCycle,
    wizardInnateCritChance: wizardInnateCritChance,
    computeBaseManaRegenPerTick: computeBaseManaRegenPerTick,
    SPELL_CRIT_RANKS: SPELL_CRIT_RANKS,
    SPELL_CRIT_MASTERY_CHANCE: SPELL_CRIT_MASTERY_CHANCE,
    QUICK_DAMAGE_CAST_MOD: QUICK_DAMAGE_CAST_MOD
  };

})(typeof window !== 'undefined' ? window : globalThis);
