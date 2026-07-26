/**
 * Caster nuke-pool resolution for the rotation planner.
 *
 * There is no "is this a nuke" flag anywhere in the raw client spell file
 * (resources/spells-data.js) — it's the full ~30k-record dump of every
 * spell in the game, buffs and heals included. So the pool is built live:
 * filter every spell whose classesN field (N = the EQ class id, 1-15) says
 * the selected class can use it by the selected level, then keep only the
 * ones that resolve to positive direct damage via NpcSpells.describeSpell
 * (the same SPA-walking helper npcSpells.js already uses to interpret mob
 * spells — reused here rather than re-deriving cast/recast/damage parsing).
 */
(function (global) {
  'use strict';

  // EQ class ids, matching classesN on every spells-data.js record and the
  // ordering already used by weaponSkillCaps.js's SIM_CLASS_TO_INDEX.
  var CLASS_NAME_TO_ID = {
    warrior: 1, cleric: 2, paladin: 3, ranger: 4, shadowknight: 5,
    druid: 6, monk: 7, bard: 8, rogue: 9, shaman: 10,
    necromancer: 11, wizard: 12, magician: 13, enchanter: 14, beastlord: 15
  };

  var RESIST_NAME = { 0: 'None', 1: 'Magic', 2: 'Fire', 3: 'Cold', 4: 'Poison', 5: 'Disease' };

  var UNUSABLE_LEVEL = 255;

  // Some nukes only affect specific NPC body types — e.g. Expulse Undead
  // (undead only), Hsagra's Wrath (raid giants only), Porlos' Fury (Velious
  // dragons only). The client enforces this via the spell's targettype
  // field (SpellTargetType in spdat.h) against the target's bodytype;
  // Mob::CastSpell's targettype switch (zone/spells.cpp) is the source for
  // both tables below. This is fully data-driven off spells-data.js and
  // npc_types-data.js — no per-spell name list needed.
  var TARGET_TYPE = {
    ANIMAL: 9, UNDEAD: 10, SUMMONED: 11, PLANT: 16,
    UBER_GIANT: 17, UBER_DRAGON: 18, UNDEAD_AE: 24, SUMMONED_AE: 25
  };
  var BODY_TYPE = {
    UNDEAD: 3, SUMMONED_UNDEAD: 8, RAID_GIANT: 9, VAMPIRE: 12,
    ANIMAL: 21, SUMMONED: 24, PLANT: 25, SUMMONED2: 27, SUMMONED3: 28,
    VELIOUS_DRAGON: 30
  };
  // targettype -> { bodyTypes: [...], label: 'what the target must be' }
  var TARGET_RESTRICTION = {};
  TARGET_RESTRICTION[TARGET_TYPE.ANIMAL] = { bodyTypes: [BODY_TYPE.ANIMAL], label: 'Animal' };
  TARGET_RESTRICTION[TARGET_TYPE.UNDEAD] = { bodyTypes: [BODY_TYPE.UNDEAD, BODY_TYPE.SUMMONED_UNDEAD, BODY_TYPE.VAMPIRE], label: 'Undead' };
  TARGET_RESTRICTION[TARGET_TYPE.UNDEAD_AE] = TARGET_RESTRICTION[TARGET_TYPE.UNDEAD];
  TARGET_RESTRICTION[TARGET_TYPE.SUMMONED] = { bodyTypes: [BODY_TYPE.SUMMONED, BODY_TYPE.SUMMONED2, BODY_TYPE.SUMMONED3], label: 'Summoned' };
  TARGET_RESTRICTION[TARGET_TYPE.SUMMONED_AE] = TARGET_RESTRICTION[TARGET_TYPE.SUMMONED];
  TARGET_RESTRICTION[TARGET_TYPE.PLANT] = { bodyTypes: [BODY_TYPE.PLANT], label: 'Plant' };
  TARGET_RESTRICTION[TARGET_TYPE.UBER_GIANT] = { bodyTypes: [BODY_TYPE.RAID_GIANT], label: 'Giant (raid)' };
  TARGET_RESTRICTION[TARGET_TYPE.UBER_DRAGON] = { bodyTypes: [BODY_TYPE.VELIOUS_DRAGON], label: 'Dragon (Velious)' };

  // Rain spells (Tears of Prexus, Pogonip, ...): IsRainSpell (spdat.cpp) is
  // targettype == ST_AETarget (8) with an AEDuration outside the couple of
  // sentinel values used by unrelated AE-duration effects. The server turns
  // that into a beacon that re-triggers the spell's own damage effect every
  // 2500ms for AEDuration ms (zone/spells.cpp, IsAEDurationSpell handling) —
  // each trigger is a full independent cast against the target, resist roll
  // included. So effect_base_valueN on the spell record is the PER-WAVE
  // magnitude, not the total; NpcSpells.describeSpell has no notion of this
  // and returns just that one wave's damage; getCasterNukePool multiplies it
  // out by the wave count below.
  var RAIN_TARGET_TYPE = 8;
  var RAIN_TICK_INTERVAL_SEC = 2.5;
  var RAIN_MIN_AE_DURATION_MS = 2000;
  var RAIN_MAX_AE_DURATION_MS = 360000;

  function rainWaveCount(aeDurationMs) {
    return Math.max(1, Math.ceil(aeDurationMs / (RAIN_TICK_INTERVAL_SEC * 1000)));
  }

  function isRainSpellRecord(sp) {
    var aeDuration = Number(sp.AEDuration) || 0;
    return Number(sp.targettype) === RAIN_TARGET_TYPE &&
      aeDuration > RAIN_MIN_AE_DURATION_MS && aeDuration < RAIN_MAX_AE_DURATION_MS;
  }

  // DoTs tick every 6 seconds (NpcSpells.TICK_MS) for a duration NpcSpells
  // already resolves via calcBuffDuration (spells.cpp:CalcBuffDuration_formula)
  // into whole ticks. Recasting a DoT that's still active overwrites it —
  // the old application (and whatever ticks it had left) is simply gone,
  // replaced by a fresh full-duration one. That's a straight loss, so the
  // right time to recast is once the current application would have expired
  // anyway, never before — modeled by gating its own next-availability on
  // its duration rather than only its (usually short/irrelevant) recast
  // timer. See the `isDot` branch in RotationEngine.simulateRotation.
  var DOT_TICK_INTERVAL_SEC = 6;

  function classIdFor(classId) {
    if (typeof classId === 'number') return classId;
    return CLASS_NAME_TO_ID[String(classId).toLowerCase()] || 0;
  }

  function spellData() {
    return global.__DPS_SPELLS_EN__ || null;
  }

  function getNpcSpells() {
    return global.NpcSpells || null;
  }

  function resistLabel(resistType, resistDiff) {
    var name = RESIST_NAME[resistType] || 'Unknown';
    if (resistType === 0) return name;
    var diff = Number(resistDiff) || 0;
    return diff !== 0 ? (name + ' (' + (diff > 0 ? '+' : '') + diff + ')') : name;
  }

  /**
   * Every spell the given class can cast by the given level that resolves
   * to positive damage — direct-damage nukes (including rains) and pure
   * damage-over-time spells. Stuns and anything that resolves to no damage
   * at all (buffs, heals, ...) are excluded.
   *
   * @returns {Array<Spell>} the pool, per the RotationEngine Spell shape.
   */
  function getCasterNukePool(classId, level) {
    var all = spellData();
    var NS = getNpcSpells();
    var id = classIdFor(classId);
    var lvl = Number(level) || 1;
    if (!all || !NS || !id) return [];

    var field = 'classes' + id;
    var pool = [];

    for (var spellId in all) {
      if (!Object.prototype.hasOwnProperty.call(all, spellId)) continue;
      var sp = all[spellId];
      var minLevel = Number(sp[field]);
      if (!isFinite(minLevel) || minLevel <= 0 || minLevel >= UNUSABLE_LEVEL || minLevel > lvl) continue;

      var info = NS.describeSpell(spellId, lvl);
      if (!info || info.stunMs > 0) continue;
      // Some self-buffs (e.g. the Necromancer Lich line) drain the caster's
      // own HP as their cost and so resolve a nonzero "dotPerTick" out of
      // describeSpell's generic SPA walk despite being entirely beneficial
      // and self-targeted — goodEffect is the server's own detrimental/
      // beneficial flag (IsDetrimentalSpell), the correct filter here.
      if (Number(sp.goodEffect) !== 0) continue;

      var restriction = TARGET_RESTRICTION[Number(sp.targettype)] || null;
      var isDirect = info.directDamage > 0;
      var isDot = !isDirect && info.dotPerTick > 0 && info.durationTicks > 0;
      if (!isDirect && !isDot) continue;

      var isRain = isDirect && isRainSpellRecord(sp);
      var waveCount = isRain ? rainWaveCount(Number(sp.AEDuration)) : (isDot ? info.durationTicks : 1);
      var perHitDamage = isDirect ? info.directDamage : info.dotPerTick;
      var interval = isRain ? RAIN_TICK_INTERVAL_SEC : (isDot ? DOT_TICK_INTERVAL_SEC : 0);

      pool.push({
        id: String(spellId),
        name: info.name,
        level: minLevel,
        type: isRain ? 'Rain' : (isDot ? 'DoT' : 'Nuke'),
        // Total across all waves/ticks — each rolls its own independent
        // resist (rains) or all ride on one application roll (DoTs), but
        // either way the resist-check formula is identical every time
        // (same caster/target/spell), so summing here and applying one
        // expected-value factor to the total is exact, not an approximation.
        damage: perHitDamage * waveCount,
        resistType: resistLabel(info.resistType, info.resistDiff),
        resistTypeId: info.resistType,
        resistDiff: info.resistDiff,
        mana: Number(sp.mana) || 0,
        castTime: info.castTimeMs / 1000,
        recastTime: info.recastMs / 1000,
        waves: waveCount,
        isRain: isRain,
        isDot: isDot,
        perWaveDamage: perHitDamage,
        // First wave/tick lands the instant the cast completes, then every
        // `waveIntervalSec` after — used to spread damage across time for
        // the DPS-over-time chart and to mark hit points on the cast-order
        // chart. For DoTs this is also the real gate on recasting: see
        // RotationEngine.simulateRotation's isDot branch.
        waveIntervalSec: interval,
        // Non-null only for spells that only affect a specific NPC body
        // type (undead, giants, dragons, ...) — see filterPoolForTarget.
        targetRestriction: restriction
      });
    }

    // Highest level first (ties broken by damage) — level is the more
    // useful sort for scanning the pool, since it roughly tracks spell rank
    // within a line and groups upgrades together.
    pool.sort(function (a, b) { return b.level - a.level || b.damage - a.damage; });
    return pool;
  }

  /** Does this spell's target-body-type restriction (if any) allow the given target? */
  function isViableForTarget(spell, targetBodyType) {
    if (!spell.targetRestriction) return true;
    if (targetBodyType == null) return false;
    return spell.targetRestriction.bodyTypes.indexOf(Number(targetBodyType)) !== -1;
  }

  /**
   * Drop nukes that require a target body type the current target doesn't
   * have (e.g. Porlos' Fury against anything but a Velious dragon). Pass
   * targetBodyType == null for "no specific target selected" — restricted
   * spells are hidden rather than assumed valid.
   */
  function filterPoolForTarget(pool, targetBodyType) {
    return pool.filter(function (s) { return isViableForTarget(s, targetBodyType); });
  }

  global.RotationSpells = {
    CLASS_NAME_TO_ID: CLASS_NAME_TO_ID,
    classIdFor: classIdFor,
    getCasterNukePool: getCasterNukePool,
    isViableForTarget: isViableForTarget,
    filterPoolForTarget: filterPoolForTarget
  };

})(typeof window !== 'undefined' ? window : globalThis);
