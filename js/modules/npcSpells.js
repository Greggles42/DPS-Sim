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
  var SPA_CURRENT_HP_ONCE = 79;   // instant damage component of a buff/DoT (partial applies, crits don't)
  var SPA_STUN = 21;
  var SPA_FEAR = 23;

  var SPELL_TYPE = {
    Nuke: 1, Root: 4, Lifetap: 64, Snare: 128, DOT: 256,
    Dispel: 512, Mez: 2048, Charm: 4096, Slow: 8192, Debuff: 16384
  };

  // Hybrid classes cast far less often (3% versus 25%). Mob::GetArchetype: warrior/monk/rogue are MELEE, the pure
  // casters are CASTER, and EVERYTHING ELSE — including class ids it does not know — is HYBRID. The GM variants
  // (class + 19) behave like their base class.
  var NON_HYBRID_CLASSES = { 1: 1, 7: 1, 9: 1, 2: 1, 6: 1, 10: 1, 11: 1, 12: 1, 13: 1, 14: 1 };
  function isHybridClass(classId) {
    var c = Number(classId);
    if (c >= 20 && c <= 34) c -= 19;
    return !NON_HYBRID_CLASSES[c];
  }
  var HEALER_CLASSES = { 2: 1, 6: 1, 10: 1 };              // cleric, druid, shaman

  function spellData() {
    return global.__DPS_SPELLS_EN__ || null;
  }
  function npcSpellData() {
    return global.__DPS_NPC_SPELLS__ || null;
  }

  // ---- Spell interpretation --------------------------------------------------

  /**
   * Mob::CalcSpellEffectValue_formula (spell_effects.cpp:2511-2810) — the
   * level-scaling table, including the spell's "max" cap (the spells table's
   * effect_limit_value column) and the sign handling. `ticdif` is how many
   * ticks into the buff we are, for the decaying formulas 107/108/120/122.
   * Formula 123 (random between base and |max|) returns its expected value.
   */
  function calcEffectValue(formula, base, casterLevel, max, ticdif) {
    var f = Number(formula) || 0;
    max = Number(max) || 0;
    ticdif = ticdif > 0 ? ticdif : 0;
    var L = casterLevel;
    var ubase = Math.abs(base);
    var updown = (max < base && max !== 0) ? -1 : 1;
    var result = 0;
    var t = function (x) { return x < 0 ? Math.ceil(x) : Math.floor(x); };   // C++ int division

    switch (f) {
      case 0: case 100: result = ubase; break;
      case 101: result = updown * (ubase + t(L / 2)); break;
      case 102: result = updown * (ubase + L); break;
      case 103: result = updown * (ubase + L * 2); break;
      case 104: result = updown * (ubase + L * 3); break;
      case 105: result = updown * (ubase + L * 4); break;
      case 107: result = updown * (ubase - ticdif); break;
      case 108: result = updown * (ubase - 2 * ticdif); break;
      case 109: result = updown * (ubase + t(L / 4)); break;
      case 110: result = updown * (ubase + t(L / 6)); break;
      case 111: result = updown * (ubase + 6 * (L - 16)); break;
      case 112: result = updown * (ubase + 8 * (L - 24)); break;
      case 113: result = updown * (ubase + 10 * (L - 34)); break;
      case 114: result = updown * (ubase + 15 * (L - 44)); break;
      case 115: result = ubase + (L > 15 ? 7 * (L - 15) : 0); break;
      case 116: result = ubase + (L > 24 ? 10 * (L - 24) : 0); break;
      case 117: result = ubase + (L > 34 ? 13 * (L - 34) : 0); break;
      case 118: result = ubase + (L > 44 ? 20 * (L - 44) : 0); break;
      case 119: result = ubase + t(L / 8); break;
      case 120: result = updown * (ubase - 5 * ticdif); break;
      case 121: result = ubase + t(L / 3); break;
      case 122: result = updown * (ubase - 12 * ticdif); break;
      case 123: result = Math.floor((ubase + Math.abs(max)) / 2); break;
      case 124: result = ubase + (L > 50 ? updown * (L - 50) : 0); break;
      case 125: result = ubase + (L > 50 ? updown * 2 * (L - 50) : 0); break;
      case 126: result = ubase + (L > 50 ? updown * 3 * (L - 50) : 0); break;
      case 127: result = ubase + (L > 50 ? updown * 4 * (L - 50) : 0); break;
      case 128: result = ubase + (L > 50 ? updown * 5 * (L - 50) : 0); break;
      case 129: result = ubase + (L > 50 ? updown * 10 * (L - 50) : 0); break;
      case 130: result = ubase + (L > 50 ? updown * 15 * (L - 50) : 0); break;
      case 131: result = ubase + (L > 50 ? updown * 20 * (L - 50) : 0); break;
      case 144: result = ubase + (L > 43 ? updown * 10 * (L - 43) : 0); break;
      case 150: result = L > 50 ? 10 : L > 45 ? 5 + L - 45 : L > 40 ? 5 : L > 34 ? 4 : 3; break;
      case 201: case 202: case 203: case 204: case 205: result = max; break;
      default:
        // formula < 100 (formulas 106 and other unknown >=100 values fall to "Unknown ... formula" => 0)
        result = f < 100 ? ubase + L * f : 0;
    }

    // Clamp against the allowed maximum.
    if (max !== 0) {
      if (updown === 1) { if (result > max) result = max; }
      else if (result < max) result = max;
    }
    // A negative base always yields a negative result.
    if (base < 0 && result > 0) result *= -1;
    return result;
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
    var isFear = false;
    // IsPartialCapableSpell: the first non-blank effect must be HP / HP-once damage (base < 0)
    // and the spell's no_partial_resist flag must be clear; otherwise a failed resist roll is a full resist.
    var firstEffectDamage = null;

    var durationTicks = calcBuffDuration(
      casterLevel, sp.buffdurationformula, Number(sp.buffduration) || 0);
    var isBuffed = durationTicks > 0;

    for (var i = 1; i <= 12; i++) {
      var spa = Number(sp['effectid' + i]);
      if (!isFinite(spa) || spa === 254) continue;
      var base = Number(sp['effect_base_value' + i]) || 0;
      var formula = sp['formula' + i];
      var max = Number(sp['effect_limit_value' + i]) || 0;
      if (firstEffectDamage === null && spa !== 254) {
        firstEffectDamage = ((spa === SPA_CURRENT_HP || spa === SPA_CURRENT_HP_ONCE) && base < 0);
      }

      if (spa === SPA_CURRENT_HP) {
        if (isBuffed) {
          // Per-tick value; the decaying formulas (107/108/120/122) lose value every tick, so average
          // the real per-tick values over the buff's duration.
          var sum = 0, n = Math.max(1, durationTicks);
          for (var td = 0; td < n; td++) sum += calcEffectValue(formula, base, casterLevel, max, td);
          var avg = sum / n;
          if (avg < 0) dotPerTick += -avg;
        } else {
          var val = calcEffectValue(formula, base, casterLevel, max, 0);
          if (val < 0) directDamage += -val;
        }
      } else if (spa === SPA_CURRENT_HP_ONCE) {
        var once = calcEffectValue(formula, base, casterLevel, max, 0);
        if (once < 0) directDamage += -once;
      } else if (spa === SPA_STUN) {
        stunMs = Math.max(stunMs, Math.abs(calcEffectValue(formula, base, casterLevel, max, 0)));
      } else if (spa === SPA_FEAR) {
        isFear = true;
      }
    }

    // Fear (e.g. dragon roars) does no damage of its own, but it's still a
    // real cast the mob makes — without this it silently disappears from
    // resolveSpellList and never shows up in the report at all.
    var fearMs = isFear ? durationTicks * TICK_MS : 0;

    if (!directDamage && !dotPerTick && !stunMs && !fearMs) return null;

    return {
      id: spellId,
      name: sp.name || ('Spell ' + spellId),
      directDamage: directDamage,
      dotPerTick: dotPerTick,
      durationTicks: dotPerTick > 0 ? durationTicks : 0,
      stunMs: stunMs,
      fearMs: fearMs,
      resistType: Number(sp.resisttype) || 0,
      resistDiff: Number(sp.ResistDiff) || 0,
      castTimeMs: Number(sp.cast_time) || 0,
      recastMs: Number(sp.recast_time) || 0,
      recoveryMs: Number(sp.recovery_time) || 0,
      isDirectDamage: directDamage > 0,
      partialCapable: !(Number(sp.no_partial_resist) > 0) && firstEffectDamage === true
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
    var levelEntryCount = 0;
    for (var i = 0; i < list.spells.length; i++) {
      var e = list.spells[i];
      if (mobLevel < e.minlevel || mobLevel > e.maxlevel) continue;
      levelEntryCount++;   // mob_ai.cpp roll_mod counts EVERY in-level entry (buffs, heals, pets...), not only damage
      var info = describeSpell(e.spellid, mobLevel);
      if (!info) continue;
      spells.push({
        spellId: e.spellid,
        type: e.type,
        priority: e.priority || 0,
        // Per-entry resist_adjust overrides the spell's own ResistDiff.
        resistAdjust: e.resist_adjust ? e.resist_adjust : info.resistDiff,   // a 0 / null entry value means "use the spell's ResistDiff"
        recast: getRecast(e.recast_delay, info.recastMs),
        info: info
      });
    }

    if (!spells.length && !list.attack_proc) return null;

    var dChance = list.engaged_d_chance;
    if (!dChance) {
      dChance = isHybridClass(mobClassId) ? DEFAULT_DETRIMENTAL_CHANCE_HYBRID
              : DEFAULT_DETRIMENTAL_CHANCE;
    }

    // The extractor records every in-level entry's band (level_bands) so the roll modifier counts heals/buffs too.
    if (list.level_bands) {
      levelEntryCount = 0;
      for (var li = 0; li < list.level_bands.length; li++) {
        if (mobLevel >= list.level_bands[li][0] && mobLevel <= list.level_bands[li][1]) levelEntryCount++;
      }
    }

    return {
      name: list.name,
      spells: spells,
      levelEntryCount: levelEntryCount,
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
    var levelMod = Math.trunc(tempDiff * tempDiff / 2);
    if (tempDiff < 0) levelMod = -levelMod;

    // Quarm:UseClassicResists is FALSE on live Quarm (rule_values 2026-10-25): no 4/198 floor and
    // ceiling, no x3/2, and the 150-scale partial formula (not the classic 100-scale one).
    var resistChance = targetResist + levelMod + resistModifier;

    var roll = Math.floor(rng() * 201);   // Int(0, 200)
    if (roll > resistChance) return 100;

    // Failed roll: a spell that is not partial-capable (first effect not HP damage, or
    // no_partial_resist set) is a full resist.
    if (info.partialCapable === false || resistChance === 0) return 0;

    var partial = Math.trunc(150 * (resistChance - roll) / resistChance);
    // caster (the mob) is an NPC: extra term for much lower-level targets
    if (levelDiff >= 20) partial += Math.trunc(levelDiff * 1.5);

    if (partial <= 0) return 100;
    if (partial >= 100) return 0;
    return 100 - partial;
  }

  // ---- Casting AI ------------------------------------------------------------

  // Per-spell-type success roll inside AICastSpell (mob_ai.cpp), rolled
  // *after* the list's overall detrimental-chance check already passed —
  // this is what stops a mob from nuking every single time it decides to
  // cast something. Types with no case in AICastSpell (or that never carry
  // damage, so never reach describeSpell/our spells array) aren't listed.
  var TYPE_CHANCE = {};
  TYPE_CHANCE[SPELL_TYPE.Nuke] = 40;
  TYPE_CHANCE[SPELL_TYPE.Root] = 40;
  TYPE_CHANCE[SPELL_TYPE.Lifetap] = 50;
  TYPE_CHANCE[SPELL_TYPE.Snare] = 30;
  TYPE_CHANCE[SPELL_TYPE.DOT] = 40;
  TYPE_CHANCE[SPELL_TYPE.Dispel] = 10;
  TYPE_CHANCE[SPELL_TYPE.Mez] = 30;
  TYPE_CHANCE[SPELL_TYPE.Charm] = 30;
  TYPE_CHANCE[SPELL_TYPE.Slow] = 70;
  TYPE_CHANCE[SPELL_TYPE.Debuff] = 50;

  /** The type roll shifts by how many spells the mob knows (mob_ai.cpp roll_mod). */
  function typeRollMod(spellCount) {
    if (spellCount < 4) return 10;
    if (spellCount > 9) return -10;
    if (spellCount > 6) return -5;
    return 0;
  }

  function finishCast(chosen, rng, recastState, nowMs, nextCheckMs) {
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

  /**
   * AI_EngagedCastCheck + AICastSpell. On each autocast tick the mob rolls
   * its detrimental chance, then tries its ready spells in turn, each with
   * its own type-specific success roll, until one lands or none do.
   *
   * Priority-0 ("raid boss") spells are a special case: they skip both the
   * detrimental-chance roll and their own type roll, casting the instant
   * they come off cooldown (mob_ai.cpp AI_EngagedCastCheck, hasZeroPrioritySpells).
   *
   * @param {boolean} targetIsWarriorClass - Slow only ever lands on melee
   *   classes server-side (mob_ai.cpp SpellType_Slow: debuffee->IsWarriorClass()).
   * @returns {{cast:boolean, spell:Object|null, nextCheckMs:number}}
   */
  function rollCast(list, rng, recastState, nowMs, targetIsWarriorClass) {
    var nextCheckMs = list.recastMinMs +
      Math.floor(rng() * Math.max(1, list.recastMaxMs - list.recastMinMs + 1));

    if (!list.spells.length) return { cast: false, spell: null, nextCheckMs: nextCheckMs };

    var zeroPriorityReady = [];
    for (var zi = 0; zi < list.spells.length; zi++) {
      var zs = list.spells[zi];
      if (zs.priority === 0 && (recastState[zs.spellId] || 0) <= nowMs) zeroPriorityReady.push(zs);
    }
    if (zeroPriorityReady.length) {
      var zChosen = zeroPriorityReady[0];   // priority 0 sorts to the end of the array, which is tried first
      return finishCast(zChosen, rng, recastState, nowMs, nextCheckMs);
    }

    if (rng() >= list.detrimentalChance) return { cast: false, spell: null, nextCheckMs: nextCheckMs };

    var candidates = [];
    for (var i = 0; i < list.spells.length; i++) {
      var s = list.spells[i];
      var readyAt = recastState[s.spellId] || 0;
      if (readyAt > nowMs) continue;
      candidates.push(s);
    }
    if (!candidates.length) return { cast: false, spell: null, nextCheckMs: nextCheckMs };

    // The server tries every ready spell in its AIspells array order, each
    // rolling its own type chance, stopping at the first success. We try
    // strongest (highest priority) first instead of the server's incidental
    // array order — within one level band there's rarely more than one
    // ready candidate of a given type anyway, so the order seldom matters.
    // AIspells is sorted descending by priority NUMBER and walked from the END (mob_ai.cpp:94, 3302), so the
    // lowest priority number is tried first.
    candidates.sort(function (a, b) { return a.priority - b.priority; });
    var mod = typeRollMod(list.levelEntryCount != null ? list.levelEntryCount : list.spells.length);

    for (var ci = 0; ci < candidates.length; ci++) {
      var cand = candidates[ci];
      if (cand.type === SPELL_TYPE.Slow && !targetIsWarriorClass) continue;
      var chance = TYPE_CHANCE[cand.type] != null ? TYPE_CHANCE[cand.type] : 100;
      chance = Math.max(0, Math.min(100, chance + mod));
      if (rng() * 100 >= chance) continue;
      return finishCast(cand, rng, recastState, nowMs, nextCheckMs);
    }

    return { cast: false, spell: null, nextCheckMs: nextCheckMs };
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

    isHybrid: isHybridClass,
    isHealer: function (classId) { return !!HEALER_CLASSES[classId]; }
  };

})(typeof window !== 'undefined' ? window : globalThis);
