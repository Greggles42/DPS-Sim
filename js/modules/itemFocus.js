/**
 * Item focus-effect resolution for the rotation planner.
 *
 * A focus effect is a passive, spell-only bonus granted by an equipped item
 * (as opposed to a worn effect, which is a permanent buff, or a proc). The
 * item references a spell id (items.json's `focuseffect` field) whose own
 * effect list carries the bonus (SE_ImprovedDamage, SE_ReduceManaCost,
 * SE_IncreaseSpellHaste) plus a set of SE_Limit* sub-effects that restrict
 * which spells it actually applies to. Source: zone/spell_effects.cpp's
 * focus-effect resolution (the function handling SE_LimitResist/
 * SE_LimitSpellType/SE_LimitEffect/SE_LimitInstant/SE_LimitMinDur/
 * SE_LimitMinLevel/SE_LimitMaxLevel/SE_LimitCastTimeMin/Max), cross-checked
 * against real item data (e.g. "Fury of Ro": +30% fire damage, instant-only,
 * detrimental-only, spell level <= 65 — exactly what SE_LimitResist=2,
 * SE_LimitInstant=1, SE_LimitSpellType=0, SE_LimitMaxLevel=65 encode).
 *
 * Not modeled: SE_LimitTarget (our pool is already hostile-targeted only, so
 * it can never exclude anything relevant), SE_LimitSpell/SE_LimitSpellGroup
 * (rare, specific-spell-id foci), and the SE_LimitMaxLevel over-cap damage
 * falloff (treated as a hard cutoff instead of a graduated reduction).
 */
(function (global) {
  'use strict';

  var SPA = {
    IMPROVED_DAMAGE: 124,
    REDUCE_MANA_COST: 132,
    INCREASE_SPELL_HASTE: 127,
    LIMIT_MAX_LEVEL: 134,
    LIMIT_RESIST: 135,
    LIMIT_EFFECT: 137,
    LIMIT_SPELL_TYPE: 138,
    LIMIT_MIN_DUR: 140,
    LIMIT_INSTANT: 141,
    LIMIT_MIN_LEVEL: 142,
    LIMIT_CAST_TIME_MIN: 143,
    LIMIT_CAST_TIME_MAX: 144
  };
  var SE_CURRENT_HP = 0;

  function spellData() {
    return global.__DPS_SPELLS_EN__ || null;
  }

  /**
   * Parse a focus item's linked spell into a structured descriptor, or null
   * if it doesn't carry any bonus this planner models.
   */
  function resolveFocusSpell(spellId) {
    var all = spellData();
    var sp = all && all[spellId];
    if (!sp) return null;

    var improvedDamagePct = 0, reduceManaPct = 0, spellHastePct = 0;
    var limitResist = [];      // [{exclude, resistType}]
    var limitEffect = [];      // [{exclude, effectId}]
    var spellTypeRequired = null;
    var maxLevel = null, minLevel = null;
    var instantOnly = false, durationOnly = false, minDurTicks = null;
    var castTimeMinMs = null, castTimeMaxMs = null;
    var found = false;

    for (var i = 1; i <= 12; i++) {
      var eid = Number(sp['effectid' + i]);
      if (!isFinite(eid) || eid === 254) continue;
      var base = Number(sp['effect_base_value' + i]) || 0;

      switch (eid) {
        case SPA.IMPROVED_DAMAGE: improvedDamagePct = base; found = true; break;
        case SPA.REDUCE_MANA_COST: reduceManaPct = base; found = true; break;
        case SPA.INCREASE_SPELL_HASTE: spellHastePct = base; found = true; break;
        case SPA.LIMIT_RESIST:
          if (base < 0) limitResist.push({ exclude: true, resistType: -base });
          else if (base > 0) limitResist.push({ exclude: false, resistType: base });
          break;
        case SPA.LIMIT_EFFECT:
          if (base < 0) limitEffect.push({ exclude: true, effectId: -base });
          else limitEffect.push({ exclude: false, effectId: base });
          break;
        case SPA.LIMIT_SPELL_TYPE: spellTypeRequired = base; break;
        case SPA.LIMIT_MAX_LEVEL: maxLevel = base; break;
        case SPA.LIMIT_MIN_LEVEL: minLevel = base; break;
        case SPA.LIMIT_INSTANT: if (base === 1) instantOnly = true; else if (base === 0) durationOnly = true; break;
        case SPA.LIMIT_MIN_DUR: minDurTicks = base; break;
        case SPA.LIMIT_CAST_TIME_MIN: castTimeMinMs = base; break;
        case SPA.LIMIT_CAST_TIME_MAX: castTimeMaxMs = base; break;
        default: break;
      }
    }

    if (!found) return null;

    return {
      spellId: String(spellId),
      name: sp.name || ('Spell ' + spellId),
      improvedDamagePct: improvedDamagePct,
      reduceManaPct: reduceManaPct,
      spellHastePct: spellHastePct,
      limitResist: limitResist,
      limitEffect: limitEffect,
      spellTypeRequired: spellTypeRequired,
      maxLevel: maxLevel,
      minLevel: minLevel,
      instantOnly: instantOnly,
      durationOnly: durationOnly,
      minDurTicks: minDurTicks,
      castTimeMinMs: castTimeMinMs,
      castTimeMaxMs: castTimeMaxMs
    };
  }

  /**
   * OR across same-type include entries, AND (immediate fail) for any
   * exclude entry — matches the server's LimitInclude[] semantics (a focus
   * with two SE_LimitResist entries, e.g. "fire OR ice", needs only one to
   * match; an exclude entry always vetoes regardless of any include match).
   */
  function passesResistLimit(entries, resistTypeId) {
    if (!entries.length) return true;
    var sawInclude = false, includeMatched = false;
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (e.exclude) {
        if (e.resistType === resistTypeId) return false;
      } else {
        sawInclude = true;
        if (e.resistType === resistTypeId) includeMatched = true;
      }
    }
    return !sawInclude || includeMatched;
  }

  function passesEffectLimit(entries) {
    // Every RotationSpells pool entry is a SE_CurrentHP (id 0) effect —
    // nukes, rains and DoTs are all modeled through that one SPA.
    if (!entries.length) return true;
    var sawInclude = false, includeMatched = false;
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (e.exclude) {
        if (e.effectId === SE_CURRENT_HP) return false;
      } else {
        sawInclude = true;
        if (e.effectId === SE_CURRENT_HP) includeMatched = true;
      }
    }
    return !sawInclude || includeMatched;
  }

  /**
   * Does this focus effect apply to the given RotationSpells pool entry?
   * @param {Object} focus - resolveFocusSpell() result
   * @param {Object} spell - a RotationSpells pool entry
   */
  function appliesToSpell(focus, spell) {
    if (!focus || !spell) return false;

    if (!passesResistLimit(focus.limitResist, spell.resistTypeId)) return false;
    if (!passesEffectLimit(focus.limitEffect)) return false;

    // Every pool spell is detrimental (goodEffect === 0) by construction —
    // a focus requiring beneficial (1) can never match anything here.
    if (focus.spellTypeRequired != null && focus.spellTypeRequired !== 0) return false;

    if (focus.maxLevel != null && spell.level > focus.maxLevel) return false;
    if (focus.minLevel != null && spell.level < focus.minLevel) return false;

    var isInstant = !spell.isDot;   // rains are AE-duration, not buffduration — instant for this purpose
    if (focus.instantOnly && !isInstant) return false;
    if (focus.durationOnly && isInstant) return false;
    if (focus.minDurTicks != null && focus.minDurTicks > 0) {
      var ticks = spell.isDot ? spell.waves : 0;
      if (focus.minDurTicks > ticks) return false;
    }

    if (focus.castTimeMinMs != null && spell.castTime * 1000 < focus.castTimeMinMs) return false;
    if (focus.castTimeMaxMs != null && spell.castTime * 1000 > focus.castTimeMaxMs) return false;

    return true;
  }

  /**
   * Resolve every equipped item's focus effect, filtered to items available
   * in the given era (min_expansion <= era order, same rule the BIS advisor
   * uses). Expects a list of item records already looked up from
   * items-data.js (whatever shape lookupItem() in index.html returns).
   */
  function getEquippedFocusEffects(items, eraId) {
    var EC = global.EraConfig;
    var era = EC ? EC.getEra(eraId) : null;
    var out = [];
    var seenSpellIds = {};

    (items || []).forEach(function (item) {
      if (!item || !item.focuseffect) return;
      var focusSpellId = Number(item.focuseffect);
      if (!focusSpellId) return;

      if (era && item.min_expansion != null) {
        if (Number(item.min_expansion) > era.order) return;
      }

      if (seenSpellIds[focusSpellId]) return;   // same focus spell from two slots — dedupe
      seenSpellIds[focusSpellId] = true;

      var resolved = resolveFocusSpell(focusSpellId);
      if (resolved) {
        resolved.itemName = item.Name || item.name || null;
        out.push(resolved);
      }
    });

    return out;
  }

  global.ItemFocus = {
    resolveFocusSpell: resolveFocusSpell,
    appliesToSpell: appliesToSpell,
    getEquippedFocusEffects: getEquippedFocusEffects
  };

})(typeof window !== 'undefined' ? window : globalThis);
