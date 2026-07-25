/**
 * Mob spell casting for the tanking simulation.
 *
 * Roughly a third of the NPCs in the database carry a spell list, and until now
 * none of it reached the sim — so DTPS for any casting mob was understated by
 * however much it nukes and DoTs you for.
 *
 * Data: resources/npc_spells-data.js (built by tools/extract-npc-spells.js from
 * the Quarm DB) joined against the existing client spell file.
 *
 * Sources:
 *   mob_ai.cpp   AI_EngagedCastCheck (2657), AI spell var defaults (3305)
 *   spells.cpp   Mob::CheckResistSpell (3971), CalcBuffDuration_formula (2608)
 *   spell_effects.cpp  CalcSpellEffectValue_formula
 */
(function (global) {
  'use strict';

  // Server rule defaults when the DB leaves the column at 0.
  var DEFAULT_RECAST_MIN_MS = 750;    // AI_EngagedNoSpellMinRecast
  var DEFAULT_RECAST_MAX_MS = 2000;   // AI_EngagedNoSpellMaxRecast
  var DEFAULT_DETRIMENTAL_CHANCE = 25;      // AI_EngagedDetrimentalChance
  var DEFAULT_DETRIMENTAL_CHANCE_HYBRID = 3;
  var TICK_MS = 6000;

  var RESIST = { NONE: 0, MAGIC: 1, FIRE: 2, COLD: 3, POISON: 4, DISEASE: 5 };

  // SPA ids we care about on an incoming spell
  var SPA_CURRENT_HP = 0;
  var SPA_STUN = 21;

  var SPELL_TYPE = {
    Nuke: 1, Root: 4, Lifetap: 64, Snare: 128, DOT: 256,
    Dispel: 512, Mez: 2048, Charm: 4096, Slow: 8192, Debuff: 16384
  };

  // Hybrid classes cast far less often (3% versus 25%).
  var HYBRID_CLASSES = { 3: 1, 4: 1, 5: 1, 8: 1, 15: 1 };  // pal, rng, sk, bard, bst
  var HEALER_CLASSES = { 2: 1, 6: 1, 10: 1 };              // cleric, druid, shaman

  function spellData() {
    return global.__DPS_SPELLS_EN__ || null;
  }
  function npcSpellData() {
    return global.__DPS_NPC_SPELLS__ || null;
  }

  // ---- Spell interpretation --------------------------------------------------

  /** CalcSpellEffectValue_formula — the level-scaling table. */
  function calcEffectValue(formula, base, casterLevel) {
    var mag = Math.abs(base);
    var sign = base < 0 ? -1 : 1;
    var f = Number(formula) || 0;
    var result;

    if (f === 0 || f === 100) result = mag;
    else if (f >= 1 && f <= 99) result = mag + casterLevel * f;
    else if (f === 101) result = mag + Math.floor(casterLevel / 2);
    else if (f === 102) result = mag + casterLevel;
    else if (f === 103) result = mag + casterLevel * 2;
    else if (f === 104) result = mag + casterLevel * 3;
    else if (f === 105) result = mag + casterLevel * 4;
    else if (f === 106) result = mag + casterLevel * 5;
    else if (f === 107) result = mag + Math.floor(casterLevel / 2);
    else if (f === 108) result = mag + Math.floor(casterLevel / 3);
    else if (f === 109) result = mag + Math.floor(casterLevel / 4);
    else if (f === 110) result = mag + Math.floor(casterLevel / 5);
    else result = mag;

    return sign * result;
  }

  /** CalcBuffDuration_formula — duration in 6-second ticks. */
  function calcBuffDuration(level, formula, duration) {
    var f = Number(formula) || 0;
    var d = Number(duration) || 0;
    if (f >= 200) return f;

    var i;
    switch (f) {
      case 0: return 0;
      case 1:  i = Math.floor(level / 2); return i < d ? Math.max(1, i) : d;
      case 2:  i = level <= 1 ? 6 : Math.floor(level / 2) + 5; return i < d ? Math.max(1, i) : d;
      case 3:  i = level * 30; return i < d ? Math.max(1, i) : d;
      case 4:  i = 50; return d ? Math.min(i, d) : i;
      case 5:  i = 2; return d ? Math.min(i, d) : i;
      case 6:  i = Math.floor(level / 2) + 2; return d ? Math.min(i, d) : i;
      case 7:  i = level; return d ? Math.min(i, d) : i;
      case 8:  i = level + 10; return i < d ? Math.max(1, i) : d;
      case 9:  i = level * 2 + 10; return i < d ? Math.max(1, i) : d;
      case 10: i = level * 3 + 10; return i < d ? Math.max(1, i) : d;
      case 11: i = level * 30 + 90; return i < d ? Math.max(1, i) : d;
      case 12: i = Math.max(1, Math.floor(level / 4)); return d ? Math.min(i, d) : i;
      case 50: return 65534;
      default: return 0;
    }
  }

  /**
   * Reduce a raw client-spell record to what the tanking sim needs: how much it
   * hits for, whether it ticks, and what resist applies.
   */
  function describeSpell(spellId, casterLevel) {
    var all = spellData();
    var sp = all && all[spellId];
    if (!sp) return null;

    var directDamage = 0;
    var dotPerTick = 0;
    var stunMs = 0;

    var durationTicks = calcBuffDuration(
      casterLevel, sp.buffdurationformula, Number(sp.buffduration) || 0);
    var isBuffed = durationTicks > 0;

    for (var i = 1; i <= 12; i++) {
      var spa = Number(sp['effectid' + i]);
      if (!isFinite(spa) || spa === 254) continue;
      var base = Number(sp['effect_base_value' + i]) || 0;
      var formula = sp['formula' + i];

      if (spa === SPA_CURRENT_HP) {
        var val = calcEffectValue(formula, base, casterLevel);
        if (val < 0) {
          if (isBuffed) dotPerTick += -val;
          else directDamage += -val;
        }
      } else if (spa === SPA_STUN) {
        stunMs = Math.max(stunMs, Math.abs(base));
      }
    }

    if (!directDamage && !dotPerTick && !stunMs) return null;

    return {
      id: spellId,
      name: sp.name || ('Spell ' + spellId),
      directDamage: directDamage,
      dotPerTick: dotPerTick,
      durationTicks: dotPerTick > 0 ? durationTicks : 0,
      stunMs: stunMs,
      resistType: Number(sp.resisttype) || 0,
      resistDiff: Number(sp.ResistDiff) || 0,
      castTimeMs: Number(sp.cast_time) || 0,
      recastMs: Number(sp.recast_time) || 0,
      recoveryMs: Number(sp.recovery_time) || 0,
      isDirectDamage: directDamage > 0
    };
  }

  // ---- Spell list resolution -------------------------------------------------

  /**
   * The mob's usable spells: its list, filtered to its own level band, resolved
   * against the client spell file, keeping only ones that actually hurt.
   */
  function resolveSpellList(npcSpellsId, mobLevel, mobClassId) {
    var lists = npcSpellData();
    var list = lists && lists[npcSpellsId];
    if (!list) return null;

    var spells = [];
    for (var i = 0; i < list.spells.length; i++) {
      var e = list.spells[i];
      if (mobLevel < e.minlevel || mobLevel > e.maxlevel) continue;
      var info = describeSpell(e.spellid, mobLevel);
      if (!info) continue;
      spells.push({
        spellId: e.spellid,
        type: e.type,
        priority: e.priority || 0,
        // Per-entry resist_adjust overrides the spell's own ResistDiff.
        resistAdjust: e.resist_adjust != null ? e.resist_adjust : info.resistDiff,
        recast: getRecast(e.recast_delay, info.recastMs),
        info: info
      });
    }

    if (!spells.length && !list.attack_proc) return null;

    var dChance = list.engaged_d_chance;
    if (!dChance) {
      dChance = HYBRID_CLASSES[mobClassId] ? DEFAULT_DETRIMENTAL_CHANCE_HYBRID
              : DEFAULT_DETRIMENTAL_CHANCE;
    }

    return {
      name: list.name,
      spells: spells,
      detrimentalChance: dChance / 100,
      recastMinMs: list.recast_min || DEFAULT_RECAST_MIN_MS,
      recastMaxMs: list.recast_max || DEFAULT_RECAST_MAX_MS,
      attackProcSpellId: list.attack_proc || 0,
      attackProcChance: (list.proc_chance != null ? list.proc_chance : 3) / 100,
      attackProc: list.attack_proc ? describeSpell(list.attack_proc, mobLevel) : null
    };
  }

  /**
   * How long before the mob may cast this spell again (mob_ai.cpp:2619).
   *
   * npc_spells_entries.recast_delay carries sentinel values, and getting these
   * wrong is the difference between a dragon breathing every 30 seconds and
   * chain-breathing every 5:
   *   > 0   seconds, plus a 0-4s variance
   *   -1    the spell's own recast time, plus variance
   *   -2    no recast at all (chain casting)
   *    0    the spell's own recast time, no variance
   */
  function getRecast(recastDelay, spellRecastMs) {
    var d = Number(recastDelay);
    if (d > 0 && d < 10000) return { ms: d * 1000, variance: true };
    if (d === -2) return { ms: 0, variance: false };
    if (d === -1) return { ms: spellRecastMs || 0, variance: true };
    return { ms: spellRecastMs || 0, variance: false };
  }

  // ---- Resists ---------------------------------------------------------------

  /**
   * Mob::CheckResistSpell, client-target path. Returns the percentage of the
   * spell that lands: 100 is a full hit, 0 a full resist, in between a partial.
   *
   * Simplifications, all irrelevant to a tank taking damage: no PvP branch, no
   * zone-specific overrides, no charm/mez/root tick saves.
   */
  function checkResist(spell, playerResists, playerLevel, mobLevel, rng) {
    var info = spell.info;
    var resistType = info.resistType;
    if (resistType === RESIST.NONE) return 100;

    var targetResist = 0;
    switch (resistType) {
      case RESIST.MAGIC:   targetResist = playerResists.mr || 0; break;
      case RESIST.FIRE:    targetResist = playerResists.fr || 0; break;
      case RESIST.COLD:    targetResist = playerResists.cr || 0; break;
      case RESIST.POISON:  targetResist = playerResists.pr || 0; break;
      case RESIST.DISEASE: targetResist = playerResists.dr || 0; break;
      default: return 100;
    }

    var resistModifier = spell.resistAdjust || 0;

    // level_mod: a client target caps the difference at 15 from level 21 up.
    var levelDiff = playerLevel - mobLevel;
    var tempDiff = levelDiff;
    if (playerLevel >= 21 && tempDiff > 15) tempDiff = 15;
    var levelMod = Math.floor(tempDiff * tempDiff / 2);
    if (tempDiff < 0) levelMod = -levelMod;

    var resistChance = targetResist + levelMod + resistModifier;

    // Classic resist floors/ceiling for player targets.
    if (resistChance < 4 && resistModifier === 0) resistChance = 4;
    else if (resistChance > 198) resistChance = 198;

    var roll = Math.floor(rng() * 201);   // Int(0, 200)
    if (roll > resistChance) return 100;

    if (resistChance === 0) return 0;

    // Partial. Classic client uses the simpler linear form.
    var partial = Math.floor((resistChance * 100 - roll * 100) / resistChance);
    if (levelDiff >= 20) partial += Math.floor(levelDiff * 1.5);

    if (partial <= 0) return 100;
    if (partial >= 100) return 0;
    return 100 - partial;
  }

  // ---- Casting AI ------------------------------------------------------------

  /**
   * AI_EngagedCastCheck. On each autocast tick the mob rolls its detrimental
   * chance; a success casts, a failure reschedules for a short random delay.
   *
   * @returns {{cast:boolean, spell:Object|null, nextCheckMs:number}}
   */
  function rollCast(list, rng, recastState, nowMs) {
    var nextCheckMs = list.recastMinMs +
      Math.floor(rng() * Math.max(1, list.recastMaxMs - list.recastMinMs + 1));

    if (!list.spells.length) return { cast: false, spell: null, nextCheckMs: nextCheckMs };
    if (rng() >= list.detrimentalChance) return { cast: false, spell: null, nextCheckMs: nextCheckMs };

    // Highest priority first, skipping anything still on its own recast.
    var candidates = [];
    for (var i = 0; i < list.spells.length; i++) {
      var s = list.spells[i];
      var readyAt = recastState[s.spellId] || 0;
      if (readyAt > nowMs) continue;
      candidates.push(s);
    }
    if (!candidates.length) return { cast: false, spell: null, nextCheckMs: nextCheckMs };

    var topPriority = candidates[0].priority;
    var tier = candidates.filter(function (s) { return s.priority === topPriority; });
    var chosen = tier[Math.floor(rng() * tier.length)];

    if (chosen.recast.ms > 0) {
      var variance = chosen.recast.variance ? Math.floor(rng() * 5) * 1000 : 0;
      recastState[chosen.spellId] = nowMs + chosen.recast.ms + variance;
    }

    // After a successful cast the autocast timer restarts on the spell's
    // recovery time when that is longer than the normal recheck window.
    var recovery = chosen.info.recoveryMs || 0;
    if (recovery > nextCheckMs) nextCheckMs = recovery;

    return { cast: true, spell: chosen, nextCheckMs: nextCheckMs };
  }

  global.NpcSpells = {
    RESIST: RESIST,
    SPELL_TYPE: SPELL_TYPE,
    TICK_MS: TICK_MS,

    describeSpell: describeSpell,
    resolveSpellList: resolveSpellList,
    checkResist: checkResist,
    rollCast: rollCast,
    calcEffectValue: calcEffectValue,
    calcBuffDuration: calcBuffDuration,

    isHybrid: function (classId) { return !!HYBRID_CLASSES[classId]; },
    isHealer: function (classId) { return !!HEALER_CLASSES[classId]; }
  };

})(typeof window !== 'undefined' ? window : globalThis);
