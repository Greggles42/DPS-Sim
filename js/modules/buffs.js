/**
 * buffs.js — Buff definitions and stacking resolver for gSim
 *
 * SPA IDs confirmed from EQMacEmu docs (docs.eqemu.io/server/spells) and
 * cross-referenced against resources/spells_en.json (Project Quarm spell data).
 *
 * Key confirmed SPAs:
 *   SPA  1 = SE_ArmorClass  (AC bonus)
 *   SPA  2 = SE_ATK         (attack bonus → offense rating)
 *   SPA  4 = SE_STR         (strength   → offense rating via STR/2)
 *   SPA  5 = SE_DEX         (dexterity  → proc rate)
 *   SPA  6 = SE_AGI         (agility    → avoidance)
 *   SPA  7 = SE_STA         (stamina    → HP)
 *   SPA  8 = SE_INT         (intelligence)
 *   SPA  9 = SE_WIS         (wisdom)
 *   SPA 11 = SE_AttackSpeed (haste v1; stored as 100 + haste%, so base 158 = 58%)
 *   SPA 69 = SE_TotalHP     (max HP increase)
 *   SPA119 = bard haste v3  (stacks with haste v1)
 *
 * Stacking model (SpellAffectIndex = SAI):
 *   - SPA 11 (haste v1): global max across all active buffs regardless of SAI
 *   - SPA 119 (bard haste v3): global max; stacks with v1
 *   - All other SPAs: group by SAI, take max within each SAI group, then sum across groups
 */

(function () {
  'use strict';

  const SPA = {
    AC:        1,
    ATK:       2,
    STR:       4,
    DEX:       5,
    AGI:       6,
    STA:       7,
    INT:       8,
    WIS:       9,
    HASTE_V1: 11,
    TOTAL_HP: 69,
    HASTE_V3: 119,
  };

  const BARD_INSTRUMENT_MOD = 1.8; // Bard epic: Singing Sword of the Maestro

  /**
   * Compute a single bard song slot value at a given caster level and instrument mod.
   *
   * Level scaling uses the standard EQMacEmu formula table:
   *   formula 100 → flat base (no level component)
   *   formula 101 → base + ceil(level / 2)
   *   formula 102 → base + level
   *   formula 103 → base + level * 1.5  … etc. (each step adds 0.5× level)
   *
   * Instrument mod is applied to the effect percentage AFTER level scaling and
   * AFTER the limit cap, so the limit is always a hard ceiling even with mods.
   * For SPA 11 the raw spell value is stored as (100 + haste%); we work in
   * haste-% space internally.
   *
   * @returns the value to store in an effects entry (already in "effect%" space)
   */
  function calcBardSlot(spa, base, limit, formula, level, instrumentMod) {
    // --- Level scaling ---
    var scaled;
    if (formula === 100) {
      scaled = base;
    } else {
      // formula 101 = base + level * 0.5
      // formula 102 = base + level * 1.0
      // formula N   = base + level * (N - 100) * 0.5
      var levelMult = (formula - 100) * 0.5;
      scaled = base + Math.floor(level * levelMult);
    }

    // --- Limit cap ---
    if (limit !== 0) {
      if (base >= 0 && scaled > limit) scaled = limit;
      else if (base < 0 && scaled < limit) scaled = limit;
    }

    // --- Convert SPA 11 from raw (100 + %) to % ---
    var effectVal;
    if (spa === SPA.HASTE_V1) {
      effectVal = scaled - 100;
    } else {
      effectVal = scaled;
    }

    // --- Apply instrument modifier ---
    var result = Math.floor(effectVal * instrumentMod);

    // --- Re-apply limit cap after mod (hard ceiling for SPA 11) ---
    if (spa === SPA.HASTE_V1 && limit !== 0) {
      result = Math.min(result, limit - 100);
    }

    return result;
  }

  /**
   * Build the effects array for a bard song at the given player level.
   * @param {Array}  rawSlots    — array of { spa, base, limit, formula }
   * @param {number} level       — caster/player level
   * @param {number} [mod=1.8]   — instrument modifier (default: epic)
   * @returns {Array} effects array compatible with the rest of the buff system
   */
  function buildBardEffects(rawSlots, level, mod) {
    var instrumentMod = (mod != null) ? mod : BARD_INSTRUMENT_MOD;
    var result = [];
    for (var i = 0; i < rawSlots.length; i++) {
      var s = rawSlots[i];
      // Per-slot instrMod override: some effects (e.g. ATK on brass songs) use a
      // higher instrument modifier than the global singing-skill mod.
      var slotMod = (s.instrMod != null) ? s.instrMod : instrumentMod;
      var val = calcBardSlot(s.spa, s.base, s.limit, s.formula, level, slotMod);
      if (val !== 0) result.push({ spa: s.spa, value: val });
    }
    return result;
  }

  /**
   * Buff definitions.
   * Effects include only DPS- or display-relevant SPAs.
   * SPA 11 base values stored as (100 + haste%), so 158 → 58% haste.
   * Bard song buffs set bardSong:true and carry rawSlots instead of static effects.
   */
  const BUFFS = [
    // ── HASTE ──────────────────────────────────────────────────────────────
    {
      id: 'visions_of_grandeur',
      name: 'Visions of Grandeur',
      category: 'haste',
      source: 'ENC',
      spellId: 1710,
      sai: 16,
      effects: [
        { spa: SPA.HASTE_V1, value: 58 },
        { spa: SPA.AGI,      value: 40 },
        { spa: SPA.DEX,      value: 25 },
        { spa: SPA.ATK,      value: 20 },
      ],
    },
    {
      id: 'speed_of_shissar',
      name: 'Speed of the Shissar',
      category: 'haste',
      source: 'Click',
      spellId: 1939,
      sai: 7,
      effects: [
        { spa: SPA.HASTE_V1, value: 66 },
        { spa: SPA.AGI,      value: 40 },
        { spa: SPA.AC,       value: 40 },
      ],
    },
    {
      id: 'speed_of_brood',
      name: 'Speed of the Brood',
      category: 'haste',
      source: 'ENC',
      spellId: 2895,
      sai: 7,
      effects: [
        { spa: SPA.HASTE_V1, value: 66 },
        { spa: SPA.AGI,      value: 40 },
        { spa: SPA.AC,       value: 40 },
      ],
    },
    {
      id: 'natures_melody',
      name: "Nature's Melody",
      category: 'haste',
      source: 'Click',
      spellId: 2050,
      sai: 42,
      effects: [
        { spa: SPA.HASTE_V1, value: 60 },
        { spa: SPA.STR,      value: 30 },
        { spa: SPA.AGI,      value: 30 },
        { spa: SPA.AC,       value: 50 },
      ],
    },

    // ── OFFENSIVE ──────────────────────────────────────────────────────────
    {
      id: 'koadic',
      name: "Koadic's Endless Intellect",
      category: 'offensive',
      source: 'ENC',
      spellId: 2570,
      sai: 6,
      effects: [],  // mana pool / mana regen / INT / WIS — no DPS stats
    },
    {
      id: 'call_of_predator',
      name: 'Call of the Predator',
      category: 'offensive',
      source: 'RNG',
      spellId: 1464,
      sai: 19,
      effects: [
        { spa: SPA.ATK, value: 40 },
      ],
    },
    {
      id: 'avatar',
      name: 'Avatar',
      category: 'offensive',
      source: 'SHM',
      spellId: 1598,
      sai: 7,
      effects: [
        { spa: SPA.ATK, value: 100 },
        { spa: SPA.STR, value: 100 },
        { spa: SPA.DEX, value: 100 },
        { spa: SPA.AGI, value: 100 },
      ],
    },
    {
      id: 'feral_avatar',
      name: 'Ancient: Feral Avatar',
      category: 'offensive',
      source: 'SHM',
      spellId: 2112,
      sai: 7,
      effects: [
        { spa: SPA.ATK, value: 120 },
        { spa: SPA.STR, value: 120 },
        { spa: SPA.DEX, value: 120 },
        { spa: SPA.AGI, value: 120 },
      ],
    },
    {
      id: 'savagery',
      name: 'Savagery',
      category: 'offensive',
      source: 'BST',
      spellId: 2941,
      sai: -2,
      effects: [
        { spa: SPA.ATK, value: 100 },
        { spa: SPA.STA, value: 25 },
      ],
    },
    {
      id: 'celestial_tranquility',
      name: 'Celestial Tranquility',
      category: 'offensive',
      source: 'Click',
      spellId: 1940,
      sai: 42,
      effects: [
        { spa: SPA.HASTE_V1, value: 40 },
        { spa: SPA.ATK,      value: 40 },
        { spa: SPA.AC,       value: 40 },
      ],
    },
    {
      id: 'frostreavers_blessing',
      name: "Frostreaver's Blessing",
      category: 'offensive',
      source: 'Click',
      spellId: 1350,
      sai: 32,
      effects: [
        { spa: SPA.ATK, value: 10 },
      ],
    },
    {
      id: 'khura_focusing',
      name: "Khura's Focusing",
      category: 'offensive',
      source: 'SHM',
      spellId: 2530,
      sai: 2,
      effects: [
        { spa: SPA.STR,      value: 67 },
        { spa: SPA.DEX,      value: 60 },
        { spa: SPA.TOTAL_HP, value: 250 },
      ],
    },
    {
      id: 'procced_avatar',
      name: 'Procced Avatar',
      category: 'offensive',
      source: 'Proc',
      wornType: true,   // ATK is worn (not spell); dominated by any spell buff in same SAI group
      sai: 7,
      effects: [
        { spa: SPA.ATK, value: 100 },
        { spa: SPA.STR, value: 100 },
        { spa: SPA.DEX, value: 100 },
        { spa: SPA.AGI, value: 100 },
      ],
    },
    {
      id: 'spirit_of_bihli',
      name: 'Spirit of Bih`Li',
      category: 'offensive',
      source: 'SHM',
      spellId: 2524,
      sai: -3,
      effects: [
        { spa: SPA.ATK, value: 15 },
        // SPA 3 (base 30) — identity uncertain in EQ Mac data; not tracked
      ],
    },
    {
      id: 'torrent_of_hate_recourse',
      name: 'Torrent of Hate Recourse',
      category: 'offensive',
      source: 'SK',
      spellId: 2485,
      sai: 35,
      effects: [
        { spa: SPA.ATK, value: 35 },
      ],
    },
    {
      id: 'warders_protection',
      name: "Warder's Protection",
      category: 'offensive',
      source: 'RNG',
      spellId: 2600,
      sai: 16,
      effects: [
        { spa: SPA.ATK,      value: 70 },
        { spa: SPA.AC,       value: 45 },   // base 35 + level(60) = 95, capped at limit 45
        { spa: SPA.TOTAL_HP, value: 75 },
      ],
    },
    {
      id: 'strength_of_nature',
      name: 'Strength of Nature',
      category: 'offensive',
      source: 'RNG',
      spellId: 1397,
      sai: 2,
      effects: [
        { spa: SPA.ATK,      value: 25 },
        { spa: SPA.TOTAL_HP, value: 75 },
      ],
    },
    {
      id: 'natures_precision',
      name: "Nature's Precision",
      category: 'offensive',
      source: 'RNG',
      spellId: 2594,
      sai: 94,  // different stacking group from Warder's Protection (sai 16); these spells stack
      effects: [
        { spa: SPA.ATK, value: 15 },
      ],
    },
    {
      id: 'force_of_nature',
      name: 'Force of Nature',
      category: 'offensive',
      source: 'RNG',
      spellId: 2595,
      sai: 1,
      effects: [
        { spa: SPA.ATK, value: 15 },
      ],
    },
    {
      id: 'spirit_of_predator',
      name: 'Spirit of the Predator',
      category: 'offensive',
      source: 'RNG',
      spellId: 3417,
      sai: 19,
      minEra: 'pop',
      effects: [
        { spa: SPA.ATK, value: 70 },
      ],
    },
    {
      id: 'protection_of_wild',
      name: 'Protection of the Wild',
      category: 'offensive',
      source: 'RNG',
      spellId: 3039,
      sai: 16,
      minEra: 'pop',
      effects: [
        { spa: SPA.ATK,      value: 130 },
        { spa: SPA.AC,       value: 115 },
        { spa: SPA.TOTAL_HP, value: 125 },
      ],
    },
    {
      id: 'ferine_avatar',
      name: 'Ferine Avatar',
      category: 'offensive',
      source: 'SHM',
      spellId: 3399,
      sai: 7,
      minEra: 'pop',
      effects: [
        { spa: SPA.ATK, value: 140 },
        { spa: SPA.STR, value: 140 },
        { spa: SPA.DEX, value: 140 },
        { spa: SPA.AGI, value: 140 },
      ],
    },
    {
      id: 'warsong_vah_shir',
      name: 'Warsong of the Vah Shir',
      category: 'haste',
      source: 'BRD',
      spellId: 2610,
      sai: -1,
      bardSong: true,
      effects: [],  // computed dynamically via rawSlots + buildBardEffects()
      rawSlots: [
        // eid=119 base=25 limit=0 formula=100 — flat v3 haste; scales with instrument mod
        { spa: SPA.HASTE_V3, base: 25, limit: 0, formula: 100 },
      ],
    },
    {
      id: 'mcvaxius_rondo',
      name: "McVaxius' Rousing Rondo",
      category: 'haste',
      source: 'BRD',
      spellId: 1760,
      sai: 42,
      bardSong: true,
      effects: [],  // computed dynamically via rawSlots + buildBardEffects()
      rawSlots: [
        // eid=11 base=110 limit=140 formula=110 — v1 haste; limit 40% is hard ceiling
        { spa: SPA.HASTE_V1, base: 110, limit: 140, formula: 110 },
        // eid=4  base=1   limit=0   formula=121 — STR (trivial)
        { spa: SPA.STR,      base: 1,   limit: 0,   formula: 100 },
        // eid=2  base=2   limit=0   formula=110 — ATK (trivial)
        { spa: SPA.ATK,      base: 2,   limit: 0,   formula: 100 },
      ],
    },
    {
      id: 'rizlona_call_flame',
      name: "Rizlona's Call of Flame",
      category: 'haste',
      source: 'BRD',
      spellId: 3362,
      sai: 42,
      minEra: 'pop',
      bardSong: true,
      effects: [],  // computed dynamically via rawSlots + buildBardEffects()
      rawSlots: [
        // eid=119 base=30 limit=30 formula=100 — v3 haste; limit 30% hard-capped at 25% by engine
        { spa: SPA.HASTE_V3, base: 30, limit: 30, formula: 100 },
      ],
    },
    {
      id: 'warsong_of_zek',
      name: 'Warsong of Zek',
      category: 'haste',
      source: 'BRD',
      spellId: 3374,
      sai: 42,
      minEra: 'pop',
      bardSong: true,
      effects: [],  // computed dynamically via rawSlots + buildBardEffects()
      rawSlots: [
        // eid=11 base=160 limit=0 formula=100 — 60% v1 haste base; engine caps at 100%
        { spa: SPA.HASTE_V1, base: 160, limit: 0, formula: 100 },
        // eid=4  base=5  limit=0  formula=101 — STR
        { spa: SPA.STR,      base: 5,   limit: 0, formula: 101 },
        // eid=2  base=18 limit=0  formula=100 — ATK
        // Raw spell base=2 formula=109, but formula=109 is a brass-instrument type indicator,
        // not a level-scaling formula; the correct pre-instrument ATK is 18.
        // instrMod=2.56 represents epic (Singing Sword) + max Instrument Mastery,
        // giving floor(18 * 2.56) = 46 — confirmed against TAKP.
        { spa: SPA.ATK,      base: 18,  limit: 0, formula: 100, instrMod: 2.56 },
      ],
    },
    {
      id: 'speed_of_vallon',
      name: 'Speed of Vallon',
      category: 'haste',
      source: 'ENC',
      spellId: 3240,
      sai: 16,
      minEra: 'pop',
      effects: [
        { spa: SPA.HASTE_V1, value: 68 },
        { spa: SPA.AGI,      value: 52 },
        { spa: SPA.DEX,      value: 33 },
        { spa: SPA.ATK,      value: 41 },
      ],
    },

    // ── DEFENSIVE ──────────────────────────────────────────────────────────
    {
      id: 'aegolism',
      name: 'Aegolism',
      category: 'defensive',
      source: 'CLR',
      spellId: 1447,
      sai: 2,
      effects: [
        { spa: SPA.AC,       value: 180 },
        { spa: SPA.TOTAL_HP, value: 1100 },
      ],
    },
    {
      id: 'blessing_of_aegolism',
      name: 'Blessing of Aegolism',
      category: 'defensive',
      source: 'CLR',
      spellId: 2510,
      sai: 2,
      effects: [
        { spa: SPA.AC,       value: 200 },
        { spa: SPA.TOTAL_HP, value: 1150 },
      ],
    },
    {
      id: 'brells_mountainous',
      name: "Brell's Mountainous Barrier",
      category: 'defensive',
      source: 'PAL',
      spellId: 2590,
      sai: 2,
      effects: [
        { spa: SPA.TOTAL_HP, value: 225 },
      ],
    },
    {
      id: 'ancient_gift_aegolism',
      name: 'Ancient: Gift of Aegolism',
      category: 'defensive',
      source: 'CLR',
      spellId: 2122,
      sai: 2,
      effects: [
        { spa: SPA.AC,       value: 230 },
        { spa: SPA.TOTAL_HP, value: 1300 },
      ],
    },
    {
      id: 'regrowth_dar_khura',
      name: 'Regrowth of Dar Khura',
      category: 'defensive',
      source: 'SHM',
      spellId: 2528,
      sai: 1,
      effects: [],  // HP regen only (SPA 0) — not modeled in sim
    },
    {
      id: 'protection_of_glades',
      name: 'Protection of the Glades',
      category: 'defensive',
      source: 'DRU',
      spellId: 1442,
      sai: 2,
      effects: [
        { spa: SPA.AC,       value: 25 },
        { spa: SPA.TOTAL_HP, value: 290 },
      ],
    },
    {
      id: 'protection_of_cabbage',
      name: 'Protection of the Cabbage',
      category: 'defensive',
      source: 'DRU',
      spellId: 2188,
      sai: 2,
      effects: [
        { spa: SPA.AC,       value: 25 },
        { spa: SPA.TOTAL_HP, value: 290 },
      ],
    },
    {
      id: 'hand_of_virtue',
      name: 'Hand of Virtue',
      category: 'defensive',
      source: 'CLR',
      spellId: 3479,
      sai: 2,
      minEra: 'pop',
      effects: [
        { spa: SPA.AC,       value: 240 },
        { spa: SPA.TOTAL_HP, value: 1405 },
      ],
    },
    {
      id: 'symbol_of_kazad',
      name: 'Symbol of Kazad',
      category: 'defensive',
      source: 'CLR',
      spellId: 3466,
      sai: 2,
      minEra: 'pop',
      effects: [
        { spa: SPA.TOTAL_HP, value: 910 },
      ],
    },
    {
      id: 'brells_stalwart_shield',
      name: "Brell's Stalwart Shield",
      category: 'defensive',
      source: 'PAL',
      spellId: 3432,
      sai: 2,
      minEra: 'pop',
      effects: [
        { spa: SPA.TOTAL_HP, value: 330 },
      ],
    },
    {
      id: 'protection_of_nine',
      name: 'Protection of the Nine',
      category: 'defensive',
      source: 'DRU',
      spellId: 3234,
      sai: 2,
      minEra: 'pop',
      effects: [
        { spa: SPA.AC,       value: 109 },
        { spa: SPA.TOTAL_HP, value: 618 },
      ],
    },
    {
      id: 'focus_of_seventh',
      name: 'Focus of the Seventh',
      category: 'defensive',
      source: 'SHM',
      spellId: 3397,
      sai: 2,
      minEra: 'pop',
      effects: [
        { spa: SPA.TOTAL_HP, value: 544 },
        { spa: SPA.STR,      value: 75 },
        { spa: SPA.DEX,      value: 70 },
      ],
    },
    {
      id: 'voice_of_quellious',
      name: 'Voice of Quellious',
      category: 'defensive',
      source: 'ENC',
      spellId: 3360,
      sai: 6,
      minEra: 'pop',
      effects: [],  // INT/WIS only — no DPS-relevant stats
    },
  ];

  /**
   * Resolve the combined stat contribution of a set of active buffs.
   *
   * Rules:
   *   1. SPA 11 (haste v1): global max across all active buffs.
   *   2. SPA 119 (bard haste v3): global max; stacks with v1.
   *   3. All other SPAs: group by SAI. Within each SAI group, take the highest
   *      value for that SPA. Sum the group winners across different SAI groups.
   *
   * @param {string[]} activeBuffIds
   * @param {number}   [playerLevel=60]  — used to scale bard song effects
   * @returns {{ atk, str, dex, agi, sta, ac, hp, hasteV1, hasteBard }}
   */
  function resolveBuffEffects(activeBuffIds, playerLevel) {
    var level = (playerLevel != null && playerLevel > 0) ? playerLevel : 60;
    var active = BUFFS.filter(function (b) {
      return activeBuffIds.indexOf(b.id) !== -1;
    });

    // For bard songs, replace the static (empty) effects with level-computed ones
    active = active.map(function (b) {
      if (!b.bardSong || !b.rawSlots) return b;
      var computed = buildBardEffects(b.rawSlots, level, BARD_INSTRUMENT_MOD);
      return Object.assign({}, b, { effects: computed });
    });

    var totals = { atk: 0, wornAtk: 0, str: 0, dex: 0, agi: 0, sta: 0, ac: 0, hp: 0, hasteV1: 0, hasteBard: 0 };

    // SPA 11: global max
    var bestHasteV1 = 0;
    for (var i = 0; i < active.length; i++) {
      for (var j = 0; j < active[i].effects.length; j++) {
        var e = active[i].effects[j];
        if (e.spa === SPA.HASTE_V1 && e.value > bestHasteV1) bestHasteV1 = e.value;
      }
    }
    totals.hasteV1 = bestHasteV1;

    // SPA 119: global max
    var bestHasteV3 = 0;
    for (var i = 0; i < active.length; i++) {
      for (var j = 0; j < active[i].effects.length; j++) {
        var e = active[i].effects[j];
        if (e.spa === SPA.HASTE_V3 && e.value > bestHasteV3) bestHasteV3 = e.value;
      }
    }
    totals.hasteBard = bestHasteV3;

    // Determine which SAI groups are occupied by spell (non-worn) buffs.
    // wornType buffs in those groups are fully overridden by the spell versions.
    var nonWornSAI = {};
    for (var i = 0; i < active.length; i++) {
      if (!active[i].wornType) nonWornSAI[active[i].sai] = true;
    }
    var spellActive = active.filter(function (b) { return !b.wornType; });
    var wornUndom   = active.filter(function (b) { return b.wornType && !nonWornSAI[b.sai]; });

    // Non-ATK SPAs: SAI-group max across (spellActive + wornUndom), sum across groups
    var SPA_TO_KEY = {};
    SPA_TO_KEY[SPA.STR]      = 'str';
    SPA_TO_KEY[SPA.DEX]      = 'dex';
    SPA_TO_KEY[SPA.AGI]      = 'agi';
    SPA_TO_KEY[SPA.STA]      = 'sta';
    SPA_TO_KEY[SPA.AC]       = 'ac';
    SPA_TO_KEY[SPA.TOTAL_HP] = 'hp';

    var combinedActive = spellActive.concat(wornUndom);
    var spaNums = Object.keys(SPA_TO_KEY).map(Number);
    for (var s = 0; s < spaNums.length; s++) {
      var spa = spaNums[s];
      var key = SPA_TO_KEY[spa];
      var byGroup = {};
      for (var i = 0; i < combinedActive.length; i++) {
        var buff = combinedActive[i];
        for (var j = 0; j < buff.effects.length; j++) {
          var eff = buff.effects[j];
          if (eff.spa !== spa) continue;
          if (byGroup[buff.sai] == null || eff.value > byGroup[buff.sai]) byGroup[buff.sai] = eff.value;
        }
      }
      var total = 0;
      var groupKeys = Object.keys(byGroup);
      for (var g = 0; g < groupKeys.length; g++) total += byGroup[groupKeys[g]];
      totals[key] = total;
    }

    // ATK (SPA 2): spell ATK → totals.atk; worn ATK (only from undominated wornType) → totals.wornAtk
    function resolveAtkForPool(pool) {
      var byGrp = {};
      for (var i = 0; i < pool.length; i++) {
        var b = pool[i];
        for (var j = 0; j < b.effects.length; j++) {
          var e2 = b.effects[j];
          if (e2.spa !== SPA.ATK) continue;
          if (byGrp[b.sai] == null || e2.value > byGrp[b.sai]) byGrp[b.sai] = e2.value;
        }
      }
      var sum = 0;
      Object.keys(byGrp).forEach(function (k) { sum += byGrp[k]; });
      return sum;
    }
    totals.atk    = resolveAtkForPool(spellActive);
    totals.wornAtk = resolveAtkForPool(wornUndom);

    return totals;
  }

  /**
   * Same as resolveBuffEffects but also returns a Set of buff IDs whose
   * contributions are fully dominated (overridden) by another active buff.
   * Used to dim/strikethrough overridden buffs in the UI.
   */
  function resolveBuffsWithDominance(activeBuffIds, playerLevel) {
    var level = (playerLevel != null && playerLevel > 0) ? playerLevel : 60;
    var active = BUFFS.filter(function (b) {
      return activeBuffIds.indexOf(b.id) !== -1;
    });
    // Expand bard song effects for dominance checking
    active = active.map(function (b) {
      if (!b.bardSong || !b.rawSlots) return b;
      return Object.assign({}, b, { effects: buildBardEffects(b.rawSlots, level, BARD_INSTRUMENT_MOD) });
    });
    var totals = resolveBuffEffects(activeBuffIds, level);
    var dominated = new Set();

    // wornType buffs are fully dominated if any spell (non-worn) buff occupies the same SAI group
    var nonWornSAIDom = {};
    for (var i = 0; i < active.length; i++) {
      if (!active[i].wornType) nonWornSAIDom[active[i].sai] = true;
    }
    for (var i = 0; i < active.length; i++) {
      if (active[i].wornType && nonWornSAIDom[active[i].sai]) dominated.add(active[i].id);
    }

    var SPA_TO_KEY = {};
    SPA_TO_KEY[SPA.ATK]      = 'atk';
    SPA_TO_KEY[SPA.STR]      = 'str';
    SPA_TO_KEY[SPA.DEX]      = 'dex';
    SPA_TO_KEY[SPA.AGI]      = 'agi';
    SPA_TO_KEY[SPA.STA]      = 'sta';
    SPA_TO_KEY[SPA.AC]       = 'ac';
    SPA_TO_KEY[SPA.TOTAL_HP] = 'hp';
    var spaNums = Object.keys(SPA_TO_KEY).map(Number);

    // For SPA 11: buffs whose haste < global max are dominated on haste
    var bestH = totals.hasteV1;
    var dominatedByHaste = new Set();
    for (var i = 0; i < active.length; i++) {
      var hasHaste = false, lost = false;
      for (var j = 0; j < active[i].effects.length; j++) {
        if (active[i].effects[j].spa === SPA.HASTE_V1) {
          hasHaste = true;
          if (active[i].effects[j].value < bestH) lost = true;
        }
      }
      if (hasHaste && lost) dominatedByHaste.add(active[i].id);
    }

    // A buff is fully dominated only if ALL its non-trivial effects are overridden
    for (var i = 0; i < active.length; i++) {
      var buff = active[i];
      if (!buff.effects.length) continue;  // no effects → not dominated (just inert)

      var allOverridden = true;
      for (var j = 0; j < buff.effects.length; j++) {
        var eff = buff.effects[j];
        if (eff.spa === SPA.HASTE_V1) {
          if (!dominatedByHaste.has(buff.id)) { allOverridden = false; break; }
          continue;
        }
        if (eff.spa === SPA.HASTE_V3) { allOverridden = false; break; }

        // For other SPAs, check if this buff's value is the winner in its SAI group
        var keyForSpa = SPA_TO_KEY[eff.spa];
        if (!keyForSpa) { allOverridden = false; break; }

        // Find the max value for this SPA in this SAI group
        var groupBest = 0;
        for (var k = 0; k < active.length; k++) {
          if (active[k].sai !== buff.sai) continue;
          for (var m = 0; m < active[k].effects.length; m++) {
            if (active[k].effects[m].spa === eff.spa && active[k].effects[m].value > groupBest) {
              groupBest = active[k].effects[m].value;
            }
          }
        }
        if (eff.value >= groupBest) { allOverridden = false; break; }
      }
      if (allOverridden) dominated.add(buff.id);
    }

    return { totals: totals, dominated: dominated };
  }

  window.Buffs = {
    BUFFS: BUFFS,
    SPA: SPA,
    BARD_INSTRUMENT_MOD: BARD_INSTRUMENT_MOD,
    buildBardEffects: buildBardEffects,
    resolveBuffEffects: resolveBuffEffects,
    resolveBuffsWithDominance: resolveBuffsWithDominance,
  };
})();
