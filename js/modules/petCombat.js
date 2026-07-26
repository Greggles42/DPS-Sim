/**
 * Pet-vs-mob melee sim for the pet DPS feature.
 *
 * A summoned pet is coded server-side as an NPC (flat min/max damage roll,
 * not the player weapon-rating formula in combat.js), so this reuses
 * npcCombat.js — the same engine tankingEngine.js already uses to simulate
 * the mob's side of a fight — with the pet as the attacker and the selected
 * target mob as the defender (the mirror image of the tanking sim).
 *
 * Deliberately one-directional and simplified vs. tankingEngine.js's full
 * event scheduler:
 *   - No incoming damage to the pet is modeled — the pet is assumed to
 *     survive the whole fight. This sim only measures its outgoing
 *     contribution to the group's DPS, not its survivability.
 *   - No flurry/rampage/class-attacks (real pets have no attack AI script —
 *     every pet's npc_types.npc_spells_id is 0), no swing-timer jitter
 *     between main-hand and off-hand rounds (fixed lockstep cadence instead
 *     of the server's actual per-timer scheduling) — all accepted
 *     simplifications for an expected-value DPS figure, not a full replay.
 *   - Pets carry no weapon item, so no item proc exists to model — but a
 *     Beastlord can buff its own pet with a proc via the "Spirit of X" line
 *     (see js/modules/petSpells.js's getPetProcBuffPool), which this DOES
 *     model: same EQCombat.getProcChancePerSwing formula (Mob::GetProcChance)
 *     used for player weapon procs elsewhere in this sim, scaled by the
 *     buff's own rate multiplier (Mob::AddProcToWeapon's iChance param).
 */
(function (global) {
  'use strict';

  function getNC() { return global.NpcCombat || null; }
  function getPD() { return global.PlayerDefense || null; }
  function getEQ() { return global.EQCombat || null; }

  /** Tiny seeded LCG — same convention as rotationEngine.js's createRng. */
  function createRng(seed) {
    var s = (seed != null ? seed : 1) >>> 0;
    return function () {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 0x100000000;
    };
  }

  /**
   * The target mob's defense object, built from the same already-exported
   * primitives tankingEngine.js uses for the mob's own riposte defense
   * (tankingEngine.js ~line 204-215) — reused directly rather than
   * duplicated or re-derived, just pointed at the pet as the attacker.
   */
  function buildTargetDefense(o) {
    var NC = getNC(), PD = getPD(), eq = getEQ();
    var skills = NC.getNpcDefenseSkills(o.targetClassId || NC.CLASS.Warrior, o.targetLevel);
    var rates = PD.getAvoidanceRates({
      blockSkill: skills.block, parrySkill: skills.parry,
      riposteSkill: skills.riposte, dodgeSkill: skills.dodge
    });
    var avoidance = (eq.getAvoidanceNPC ? eq.getAvoidanceNPC(o.targetLevel) : o.targetLevel * 9 + 5) +
      (o.targetAvoidance || 0);
    return {
      rates: rates,
      hitChance: eq.getHitChance ? eq.getHitChance(o.petToHit, avoidance) : 0.7,
      mitigation: eq.getMitigation ? eq.getMitigation(o.targetLevel, o.targetAc || 0, 0, 0) : 1
    };
  }

  /**
   * @param {Object} o {
   *   petLevel, petClassId, petMinDamage, petMaxDamage, petAttackDelayMs,
   *   petAttackCount, petAc, petAtk, petAccuracy, petDex, petHastePct,
   *   forceDualWield,
   *   procDamage, procRatePct (see petSpells.js's getPetProcBuffPool —
   *     omit/0 for no pet proc buff selected),
   *   targetLevel, targetAc, targetAvoidance, targetClassId,
   *   fightDurationSec, seed
   * }
   * @returns {Object} { totalDamage, dps, durationSec, mainhandSwings,
   *   mainhandHits, offhandSwings, offhandHits, dualWieldActive,
   *   attackDelayMs, procDamageTotal, procCount, error }
   */
  function simulatePetFight(o) {
    var NC = getNC(), eq = getEQ();
    if (!NC || !eq || !getPD()) return { error: 'Combat engines not loaded.' };

    var durationSec = o.fightDurationSec || 0;
    if (durationSec <= 0) return { error: 'Fight duration must be greater than zero.' };

    // Note: specialAbilities is intentionally NOT forwarded here. Real
    // server code (Mob::IsDualWielding) explicitly excludes summoned client
    // pets from the ability-flag dual-wield path, so a pet template that
    // happens to carry a stray DualWield (or Flurry/Rampage) flag in its
    // npc_types.special_abilities string must not silently grant it in this
    // sim — dual wield here is forceDualWield-only, and pets get no
    // flurry/rampage/class-attacks at all (matches npc_spells_id: 0 on
    // every pet record — pets have no attack AI script to grant them).
    var pet = NC.buildMobProfile({
      level: o.petLevel,
      classId: o.petClassId,
      minDamage: o.petMinDamage,
      maxDamage: o.petMaxDamage,
      attackDelay: (o.petAttackDelayMs || 3000) / 100,   // buildMobProfile expects deciseconds
      attackCount: o.petAttackCount,
      ac: o.petAc,
      atk: o.petAtk,
      accuracy: o.petAccuracy,
      hastePct: o.petHastePct || 0,
      forceDualWield: !!o.forceDualWield,
      isPet: true
    });

    var defense = buildTargetDefense({
      targetLevel: o.targetLevel, targetAc: o.targetAc,
      targetAvoidance: o.targetAvoidance, targetClassId: o.targetClassId,
      petToHit: pet.toHit
    });

    var rng = createRng(o.seed);
    var ctx = { stunned: false, mobEnraged: false };

    // Buff-granted pet proc (Beastlord "Spirit of X" line), if selected.
    // Uses the pet's own attack delay/DEX in the same per-swing formula
    // player weapon procs use — the offhand multiplier assumes the pet's
    // offhand round fires every time it's eligible (dualWieldChance: 100),
    // since this sim's dual-wield model is a flat on/off flag, not a
    // per-round success roll like a player's.
    var hasProc = (o.procDamage || 0) > 0 && (o.procRatePct || 0) > 0;
    var procMult = hasProc ? (o.procRatePct / 100) : 0;
    var delayDecisec = pet.attackDelayMs / 100;
    var procChanceMain = hasProc ? eq.getProcChancePerSwing(delayDecisec, false, 100, o.petDex || 75) * procMult : 0;
    var procChanceOff = hasProc ? eq.getProcChancePerSwing(delayDecisec, true, 100, o.petDex || 75) * procMult : 0;

    var totalDamage = 0;
    var mainhandSwings = 0, mainhandHits = 0, offhandSwings = 0, offhandHits = 0;
    var procDamageTotal = 0, procCount = 0;

    function emit(opts) {
      if (opts.proc) return;   // pets carry no weapon item — no item proc to model
      var res = NC.resolveSwing(pet, defense, ctx, rng, opts);
      var isOffhand = opts.source === 'offhand';
      if (isOffhand) offhandSwings++; else mainhandSwings++;
      if (res.outcome === 'hit') {
        totalDamage += res.damage;
        if (isOffhand) offhandHits++; else mainhandHits++;
      }
      if (hasProc) {
        var chance = isOffhand ? procChanceOff : procChanceMain;
        if (rng() < chance) {
          totalDamage += o.procDamage;
          procDamageTotal += o.procDamage;
          procCount++;
        }
      }
    }

    var elapsedMs = 0;
    var durationMs = durationSec * 1000;
    var guard = 0, ITERATION_CEILING = 2000000;
    while (elapsedMs < durationMs && guard++ < ITERATION_CEILING) {
      NC.doMainHandRound(pet, rng, emit, 100);
      if (pet.dualWield) NC.doOffHandRound(pet, rng, emit, 100);
      elapsedMs += pet.attackDelayMs;
    }

    return {
      totalDamage: totalDamage,
      dps: totalDamage / durationSec,
      durationSec: durationSec,
      mainhandSwings: mainhandSwings,
      mainhandHits: mainhandHits,
      offhandSwings: offhandSwings,
      offhandHits: offhandHits,
      dualWieldActive: !!pet.dualWield,
      attackDelayMs: pet.attackDelayMs,
      procDamageTotal: procDamageTotal,
      procCount: procCount
    };
  }

  global.PetCombat = {
    simulatePetFight: simulatePetFight,
    buildTargetDefense: buildTargetDefense
  };

})(typeof window !== 'undefined' ? window : globalThis);
