/**
 * BIS Advisor — Best-in-Slot item scoring and recommendation UI.
 *
 * Exposes window.BISAdvisor = { open, close }
 *
 * Depends on (must be loaded first):
 *   - js/modules/eraConfig.js  (window.EraConfig)
 *   - resources/items-data.js  (window.__DPS_ITEMS__)
 *   - resources/weapons-data.js (window.__DPS_WEAPONS_MERGED__)
 *   - resources/spells-data.js  (window.__DPS_SPELLS_EN__)
 *
 * State shared with inventory manager:
 *   - window.__invManagerState  — current equipped items {slotKey: {id, name, item}}
 *   - window.getSelectedEra()   — current era selection
 */
(function () {
  'use strict';

  // ── Constants ──────────────────────────────────────────────────────────────

  var SLOT_BITMASK_MAP = {
    Head: 4, Face: 8, Ear: 18, Ear2: 18,
    Neck: 32, Shoulders: 64, Arms: 128, Back: 256,
    Wrist: 1536, Wrist2: 1536,
    Range: 2048, Hands: 4096,
    Primary: 8192, Secondary: 16384,
    Fingers: 98304, Fingers2: 98304,
    Chest: 131072, Legs: 262144, Feet: 524288, Waist: 1048576, Ammo: 2097152
  };

  var SLOT_DISPLAY_LABELS = {
    Head: 'Head', Face: 'Face', Ear: 'Ear (1)', Ear2: 'Ear (2)',
    Neck: 'Neck', Shoulders: 'Shoulder', Arms: 'Arms', Back: 'Back',
    Wrist: 'Wrist (1)', Wrist2: 'Wrist (2)', Range: 'Range',
    Hands: 'Hands', Primary: 'Primary', Secondary: 'Secondary',
    Fingers: 'Ring (1)', Fingers2: 'Ring (2)', Chest: 'Chest',
    Legs: 'Legs', Feet: 'Feet', Waist: 'Waist', Ammo: 'Ammo'
  };

  var SLOT_KEYS = [
    'Head', 'Face', 'Ear', 'Ear2', 'Neck', 'Shoulders', 'Back', 'Arms',
    'Wrist', 'Wrist2', 'Hands', 'Fingers', 'Fingers2',
    'Chest', 'Legs', 'Feet', 'Waist',
    'Primary', 'Secondary', 'Range', 'Ammo'
  ];

  // Greedy BIS computation order — armor/weapons first, trinkets last
  var BIS_SLOT_PRIORITY = [
    'Primary', 'Secondary', 'Chest', 'Legs', 'Head', 'Arms', 'Hands', 'Feet',
    'Wrist', 'Wrist2', 'Back', 'Shoulders', 'Neck', 'Waist', 'Face',
    'Fingers', 'Fingers2', 'Ear', 'Ear2', 'Range', 'Ammo'
  ];

  var CLASS_BITMASK_MAP = {
    warrior: 1, cleric: 2, paladin: 4, ranger: 8, shadowknight: 16,
    druid: 32, monk: 64, bard: 128, rogue: 256, shaman: 512,
    necromancer: 1024, wizard: 2048, magician: 4096, enchanter: 8192, beastlord: 16384
  };

  var RACE_BITMASK_MAP = {
    human: 1, barbarian: 2, erudite: 4, wood_elf: 8, high_elf: 16, dark_elf: 32,
    half_elf: 64, dwarf: 128, troll: 256, ogre: 512, halfling: 1024, gnome: 2048,
    iksar: 4096, vah_shir: 8192
  };

  var STAT_KEYS = ['ac', 'hp', 'mana', 'str', 'dex', 'agi', 'sta', 'int', 'wis', 'atk', 'haste', 'ft', 'resist', 'regen'];

  var STAT_LABELS = {
    atk: 'ATK', haste: 'Haste%', str: 'STR', dex: 'DEX', agi: 'AGI',
    sta: 'STA', ac: 'AC', hp: 'HP', wis: 'WIS', int: 'INT', mana: 'Mana',
    ft: 'FT', resist: 'Resist', regen: 'Regen'
  };

  // Default targets for each stat (the cap value the optimizer tries to reach)
  var STAT_DEFAULT_TARGETS = {
    haste: 41, atk: 250, ft: 15,
    str: 255, dex: 255, agi: 255, sta: 255, int: 255, wis: 255,
    ac: 99999, hp: 99999, mana: 99999, resist: 99999, regen: 99999
  };

  // Role default priority orders — used to seed _priorityList from presets
  var ROLE_DEFAULT_ORDERS = {
    meleeDPS:   ['haste','atk','str','dex','agi','sta','hp','ac','resist','regen','ft','mana','int','wis'],
    tank:       ['ac','hp','agi','sta','str','haste','atk','dex','resist','regen','ft','mana','int','wis'],
    casterMana: ['ft','mana','int','wis','hp','ac','sta','resist','regen','haste','atk','str','dex','agi'],
    rangedDPS:  ['haste','atk','dex','str','agi','sta','hp','ac','resist','regen','ft','mana','int','wis']
  };

  var ROLE_PRESET_LABELS = {
    meleeDPS: 'Melee DPS', tank: 'Tank', casterMana: 'Caster', rangedDPS: 'Ranged'
  };

  // Stats enabled by default per role (others start disabled)
  var ROLE_DEFAULT_ENABLED = {
    meleeDPS:   { haste:1, atk:1, str:1, dex:1, agi:1, sta:1, hp:1, ac:1, resist:1, regen:1 },
    tank:       { ac:1, hp:1, agi:1, sta:1, str:1, haste:1, atk:1, dex:1, resist:1, regen:1 },
    casterMana: { ft:1, mana:1, int:1, wis:1, hp:1, ac:1, sta:1, resist:1, regen:1 },
    rangedDPS:  { haste:1, atk:1, dex:1, str:1, agi:1, sta:1, hp:1, ac:1, resist:1, regen:1 }
  };

  var BASE_STAT_CAP = 255;
  var HASTE_TARGET  = 41;
  var ATK_CAP       = 250;
  var FT_CAP        = 15;

  // Items that are unobtainable by players — GM items or summoned items that cannot be equipped.
  var GM_ITEM_NAME_BLOCKLIST = {
    'The Ban Hammer': true,
    'The Prime Healers Bulwark': true,       // artifact — unobtainable by players
    'Bladesouls Spiritual Armguards': true   // GM event item — not obtainable by regular players
  };

  /**
   * Return true if this item should be excluded from BIS consideration.
   * Filters: summoned items (name prefix "Summoned:") and known GM/unobtainable items.
   */
  function isUnobtainableItem(item) {
    var name = item.Name || item.name || '';
    if (name.indexOf('Summoned:') === 0) return true;
    if (GM_ITEM_NAME_BLOCKLIST[name]) return true;
    if (parseInt(item.minstatus) > 0) return true;
    return false;
  }

  // ── Module state ───────────────────────────────────────────────────────────

  var _priorityList        = buildDefaultPriorityList('meleeDPS');
  var _activeTab           = 'bisset';
  var _bisResult           = null;       // { bisSet, upgrades, gapData } computed on open
  var _itemStatsCache      = {};         // item id → combined stat object (memoized)
  var _eventsWired         = false;      // static modal events wired once
  var _excludeWeaponHaste  = false;      // when true, haste is ignored when scoring weapon/range slots
  var _charInfo            = null;       // set at recompute time; used by scoreSlot for class-aware weapon scoring

  // Slots where haste exclusion applies
  var WEAPON_RANGE_SLOTS = { Primary: true, Secondary: true, Range: true, Ammo: true };

  // ── Class weapon-scoring profiles ─────────────────────────────────────────
  //
  //   'melee'  — ratio scoring on Primary + Secondary (two-hand or dual-wield DPS)
  //   'knight' — ratio scoring on Primary; Secondary may be shield (scored by stats only)
  //   'caster' — skip weapon slots entirely (no meaningful auto-attack)
  //
  var CLASS_WEAPON_PROFILE = {
    warrior:     'melee',
    ranger:      'melee',
    rogue:       'melee',
    monk:        'melee',
    beastlord:   'melee',
    bard:        'melee',
    paladin:     'knight',
    shadowknight:'knight',
    cleric:      'caster',
    druid:       'caster',
    shaman:      'caster',
    necromancer: 'caster',
    wizard:      'caster',
    magician:    'caster',
    enchanter:   'caster'
  };

  // Weapon slots that use ratio-based scoring when the profile is melee/knight
  var WEAPON_SCORED_SLOTS = { Primary: true, Secondary: true };

  // ── Priority list ──────────────────────────────────────────────────────────

  /**
   * Build a default priority list for the given role key.
   * Each entry: { stat, target, enabled }
   */
  function buildDefaultPriorityList(roleKey) {
    var order   = ROLE_DEFAULT_ORDERS[roleKey] || ROLE_DEFAULT_ORDERS.meleeDPS;
    var enabled = ROLE_DEFAULT_ENABLED[roleKey] || ROLE_DEFAULT_ENABLED.meleeDPS;
    return order.map(function (stat) {
      return {
        stat:    stat,
        target:  STAT_DEFAULT_TARGETS[stat] !== undefined ? STAT_DEFAULT_TARGETS[stat] : 99999,
        enabled: !!enabled[stat]
      };
    });
  }

  /**
   * Compute dynamic weights from the ordered priority list.
   * Top-ranked enabled stat gets the highest weight (quadratic decay down the list).
   * Once currentStats already meets a stat's target, weight drops to POST_CAP_FACTOR of full.
   */
  function computeWeightsFromPriority(priorityList, currentStats, statCaps, baseStats) {
    var active = priorityList.filter(function (e) { return e.enabled; });
    var n      = active.length;
    var weights = {};
    STAT_KEYS.forEach(function (s) { weights[s] = 0; });

    // Identify the first and second uncapped priority stats in order.
    // "Uncapped" means (gear from other slots + race base + creation pts) < entry.target.
    var firstUncapped  = -1;
    var secondUncapped = -1;
    for (var i = 0; i < n; i++) {
      var cur = (currentStats ? (currentStats[active[i].stat] || 0) : 0) +
                (baseStats    ? (baseStats[active[i].stat]    || 0) : 0);
      var atTarget = active[i].target < 9999 && cur >= active[i].target;
      if (!atTarget) {
        if (firstUncapped === -1)            firstUncapped  = i;
        else if (secondUncapped === -1) { secondUncapped = i; break; }
      }
    }

    // Three-tier weight multipliers ensure strict priority ordering:
    //
    //   T1 (first uncapped):  1,000,000 × rank
    //     — guaranteed to beat any combination of T2+T3 stats on a single item,
    //       because T1×1 > T2×(max item marginal) + T3×(max item marginal)×n_lower.
    //       This means even +1 of the first uncapped stat beats any lower stats.
    //
    //   T2 (second uncapped): 10,000 × rank
    //     — dominates all T3 stats combined (10,000 >> n×max_marginal for EQ items).
    //
    //   T3 (capped + lower uncapped): 1 × rank
    //     — small tiebreaker by priority position only.
    var T1 = 1000000;
    var T2 = 10000;
    var T3 = 1;

    for (var i = 0; i < n; i++) {
      var entry = active[i];
      var rank  = n - i;  // n = highest priority, 1 = lowest
      var cv    = (currentStats ? (currentStats[entry.stat] || 0) : 0) +
                  (baseStats    ? (baseStats[entry.stat]    || 0) : 0);
      var atCap = entry.target < 9999 && cv >= entry.target;

      var mult = (atCap)               ? T3 :
                 (i === firstUncapped) ? T1 :
                 (i === secondUncapped)? T2 : T3;

      weights[entry.stat] = mult * rank;
    }
    return weights;
  }

  /**
   * Compute display-only weights using simple quadratic decay (rank²).
   * No tier jumps — these weights produce human-readable scores.
   * Capped stats get a 5% weight to still show minor value.
   */
  function computeDisplayWeights(priorityList, currentStats, statCaps, baseStats) {
    var active = priorityList.filter(function (e) { return e.enabled; });
    var n      = active.length;
    var weights = {};
    STAT_KEYS.forEach(function (s) { weights[s] = 0; });
    var POST_CAP = 0.05;
    for (var i = 0; i < n; i++) {
      var entry = active[i];
      var rank  = n - i;
      var cv    = (currentStats ? (currentStats[entry.stat] || 0) : 0) +
                  (baseStats    ? (baseStats[entry.stat]    || 0) : 0);
      var atCap = entry.target < 9999 && cv >= entry.target;
      weights[entry.stat] = atCap ? Math.round(rank * rank * POST_CAP) : rank * rank;
    }
    return weights;
  }

  /**
   * Return a sorted array of per-stat contributions for a display score.
   * Each entry: { label, marginal, weight, contribution }
   * Only stats that actually contribute (marginal > 0, weight > 0) are included.
   */
  function computeDisplayBreakdown(itemStats, dispWeights, currentStats, statCaps, baseStats) {
    var parts = [];
    var keys  = Object.keys(dispWeights);
    for (var i = 0; i < keys.length; i++) {
      var stat = keys[i];
      var w    = dispWeights[stat] || 0;
      if (!w) continue;
      var raw  = itemStats[stat] || 0;
      if (!raw) continue;
      var cap  = statCaps[stat];
      var cur  = (currentStats ? (currentStats[stat] || 0) : 0) +
                 (baseStats    ? (baseStats[stat]    || 0) : 0);
      var marginal = (cap >= 9999) ? raw : Math.min(raw, Math.max(0, cap - cur));
      if (!marginal) continue;
      parts.push({
        label:        STAT_LABELS[stat] || stat.toUpperCase(),
        marginal:     marginal,
        weight:       w,
        contribution: marginal * w
      });
    }
    parts.sort(function (a, b) { return b.contribution - a.contribution; });
    return parts;
  }

  /** Format a score breakdown array into a title-attribute string. */
  function formatBreakdownTitle(breakdown, total) {
    if (!breakdown || !breakdown.length) return '';
    var lines = breakdown.map(function (p) {
      return p.label + ': ' + p.marginal + ' \u00d7 ' + p.weight + ' = ' + p.contribution;
    });
    lines.push('\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');
    lines.push('Total: ' + Math.round(total));
    return lines.join('\n');
  }

  // ── HTML helpers ───────────────────────────────────────────────────────────

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function $(id) { return document.getElementById(id); }

  // ── Worn effect decoding ───────────────────────────────────────────────────

  /**
   * Decode a worn-effect spell ID into all scoring-relevant stat bonuses.
   *
   * SPA reference:
   *   1=AC, 2=ATK, 4=STR, 5=DEX, 6=AGI, 7=STA, 8=INT, 9=WIS,
   *   11=Haste (base_value - 100 when > 100), 69=Max HP
   */
  function decodeWornSpellFull(spellId, itemWornLevel) {
    var result = { ac: 0, atk: 0, str: 0, dex: 0, agi: 0, sta: 0, int: 0, wis: 0, haste: 0, hp: 0, ft: 0, regen: 0 };
    if (!spellId || spellId === '0') return result;
    var spells = window.__DPS_SPELLS_EN__;
    if (!spells) return result;
    var s = spells[spellId] || spells[String(spellId)];
    if (!s) return result;

    for (var i = 1; i <= 12; i++) {
      var eid = parseInt(s['effectid' + i]);
      var bv  = parseInt(s['effect_base_value' + i]);
      if (isNaN(eid) || eid === 254 || isNaN(bv)) continue;
      var fm = parseInt(s['formula' + i]);
      var lv = parseInt(s['effect_limit_value' + i]);
      var ev = (fm === 101 && !isNaN(lv) && lv > bv) ? lv : bv;

      switch (eid) {
        case 1:  if (ev > 0) result.ac  = Math.max(result.ac,  ev); break;
        case 2:  if (ev > 0) result.atk = Math.max(result.atk, ev); break;
        case 4:  if (ev > 0) result.str = Math.max(result.str, ev); break;
        case 5:  if (ev > 0) result.dex = Math.max(result.dex, ev); break;
        case 6:  if (ev > 0) result.agi = Math.max(result.agi, ev); break;
        case 7:  if (ev > 0) result.sta = Math.max(result.sta, ev); break;
        case 8:  if (ev > 0) result.int = Math.max(result.int, ev); break;
        case 9:  if (ev > 0) result.wis = Math.max(result.wis, ev); break;
        case 11:
          if (bv > 100) {
            var h = bv > 101 ? (bv - 100) : ((itemWornLevel || 0) + 1);
            result.haste = Math.max(result.haste, h);
          }
          break;
        case 69: if (ev > 0) result.hp   = Math.max(result.hp,   ev); break;
        case 15: if (ev > 0) result.ft   = Math.max(result.ft,   ev); break;
        case 0:  if (ev > 0) result.regen = Math.max(result.regen, ev); break;
      }
    }
    return result;
  }

  // ── Item stats ─────────────────────────────────────────────────────────────

  /**
   * Return a flat stat object for an item, combining raw item fields and worn effect.
   * Results are memoized by item ID.
   */
  function getItemCombinedStats(item) {
    var id = item.id || item.Id;
    if (id && _itemStatsCache[id]) return _itemStatsCache[id];

    var stats = {
      ac:     parseInt(item.ac)   || 0,
      hp:     parseInt(item.hp)   || 0,
      mana:   parseInt(item.mana) || 0,
      str:    parseInt(item.astr) || 0,
      dex:    parseInt(item.adex) || 0,
      agi:    parseInt(item.aagi) || 0,
      sta:    parseInt(item.asta) || 0,
      int:    parseInt(item.aint) || 0,
      wis:    parseInt(item.awis) || 0,
      atk:    0,
      haste:  0,
      ft:     0,
      resist: (parseInt(item.mr) || 0) + (parseInt(item.fr) || 0) +
              (parseInt(item.cr) || 0) + (parseInt(item.dr) || 0) +
              (parseInt(item.pr) || 0),
      regen:  0
    };

    var wornId = parseInt(item.worneffect) || 0;
    if (wornId > 0) {
      var worn = decodeWornSpellFull(wornId, parseInt(item.wornlevel) || 0);
      stats.ac    += worn.ac;
      stats.atk   += worn.atk;
      stats.str   += worn.str;
      stats.dex   += worn.dex;
      stats.agi   += worn.agi;
      stats.sta   += worn.sta;
      stats.int   += worn.int;
      stats.wis   += worn.wis;
      stats.haste += worn.haste;
      stats.hp    += worn.hp;
      stats.ft    += worn.ft;
      stats.regen += worn.regen;
    }

    if (id) _itemStatsCache[id] = stats;
    return stats;
  }

  // ── Stat caps ──────────────────────────────────────────────────────────────

  function getStatCaps(planarPowerRank) {
    var bonus = (planarPowerRank || 0) * 5;
    var cap   = BASE_STAT_CAP + bonus;
    return {
      str: cap, dex: cap, agi: cap, sta: cap, int: cap, wis: cap,
      haste: HASTE_TARGET,
      atk:   ATK_CAP,
      ft:    FT_CAP,
      ac: 99999, hp: 99999, mana: 99999, resist: 99999, regen: 99999
    };
  }

  // ── Scoring ────────────────────────────────────────────────────────────────

  /**
   * Score an item's stats given current stats in other slots and per-stat weights.
   * Cap-aware: only the marginal gain below the stat cap is counted.
   * baseStats (race base + creation pts) is included in the effective current value
   * so that a Barbarian's 103 base STR reduces the remaining gear cap room appropriately.
   */
  function scoreItem(itemStats, weights, currentStats, statCaps, baseStats) {
    var score = 0;
    var keys  = Object.keys(weights);
    for (var i = 0; i < keys.length; i++) {
      var stat = keys[i];
      var w    = weights[stat] || 0;
      if (!w) continue;
      var raw = itemStats[stat] || 0;
      if (!raw) continue;
      var cap = statCaps[stat];
      var cur = (currentStats ? (currentStats[stat] || 0) : 0) +
                (baseStats    ? (baseStats[stat]    || 0) : 0);
      var marginal;
      if (cap >= 9999) {
        marginal = raw;
      } else {
        marginal = Math.min(raw, Math.max(0, cap - cur));
      }
      score += marginal * w;
    }
    return score;
  }

  /**
   * Score a weapon item for Primary/Secondary slots using a ratio-based proxy.
   *
   * Formula:
   *   ratio_component  = (damage / delay) × RATIO_SCALE × ratioWeight
   *   stat_component   = scoreItem(wornStats, weights, currentStats, statCaps, baseStats)
   *
   * RATIO_SCALE converts damage/delay (typically 0.3–1.2) into a number comparable
   * to the stat score, so a fast/hard weapon beats a slow/weak one by roughly the
   * same margin that winning a meaningful stat would.
   *
   * For a shield (no damage/delay), ratio_component = 0 and only stat_component counts —
   * which is exactly right for knight secondaries.
   *
   * Returns { score, displayScore, scoreBreakdown, isWeaponScored: true }.
   */
  function scoreWeapon(item, itemStats, weights, dispWeights, currentStats, statCaps, baseStats) {
    var dmg   = parseInt(item.damage) || 0;
    var dly   = parseInt(item.delay)  || 0;
    var ratio = (dmg > 0 && dly > 0) ? dmg / dly : 0;

    // Ratio weight = average of ATK and haste weights (both amplify weapon DPS),
    // scaled so a ratio difference of ~0.1 ≈ gaining ~5 ATK. Empirically ~50× works well.
    var RATIO_SCALE  = 50;
    var ratioWeight  = ((weights.atk || 0) + (weights.haste || 0)) / 2;
    var ratioDisplay = ((dispWeights.atk || 0) + (dispWeights.haste || 0)) / 2;

    var ratioScore        = ratio * RATIO_SCALE * ratioWeight;
    var ratioDisplayScore = ratio * RATIO_SCALE * ratioDisplay;

    var statScore        = scoreItem(itemStats, weights,     currentStats, statCaps, baseStats);
    var statDisplayScore = scoreItem(itemStats, dispWeights, currentStats, statCaps, baseStats);

    var breakdown = computeDisplayBreakdown(itemStats, dispWeights, currentStats, statCaps, baseStats);
    if (ratio > 0 && ratioDisplay > 0) {
      breakdown.unshift({
        label:        'Dmg/Dly ratio',
        marginal:     Math.round(ratio * 100) / 100,
        weight:       Math.round(RATIO_SCALE * ratioDisplay),
        contribution: Math.round(ratioDisplayScore)
      });
      breakdown.sort(function (a, b) { return b.contribution - a.contribution; });
    }

    return {
      score:          ratioScore + statScore,
      displayScore:   ratioDisplayScore + statDisplayScore,
      scoreBreakdown: breakdown,
      isWeaponScored: true
    };
  }

  // ── Stat accumulation ──────────────────────────────────────────────────────

  /**
   * Accumulate stats from all equipped slots except the given one.
   * Most stats are additive. Haste uses MAX because only the highest worn
   * haste item applies in EQ.
   */
  function sumStatsExcludingSlot(equippedItems, excludeSlot) {
    var totals = { ac: 0, hp: 0, mana: 0, str: 0, dex: 0, agi: 0, sta: 0, int: 0, wis: 0, atk: 0, haste: 0, ft: 0, resist: 0, regen: 0 };
    for (var k in equippedItems) {
      if (k === excludeSlot) continue;
      var entry = equippedItems[k];
      if (!entry || !entry.item) continue;
      var s = getItemCombinedStats(entry.item);
      totals.ac     += s.ac     || 0;
      totals.hp     += s.hp     || 0;
      totals.mana   += s.mana   || 0;
      totals.str    += s.str    || 0;
      totals.dex    += s.dex    || 0;
      totals.agi    += s.agi    || 0;
      totals.sta    += s.sta    || 0;
      totals.int    += s.int    || 0;
      totals.wis    += s.wis    || 0;
      totals.atk    += s.atk    || 0;
      totals.ft     += s.ft     || 0;
      totals.resist += s.resist || 0;
      totals.regen  += s.regen  || 0;
      if ((s.haste || 0) > totals.haste) totals.haste = s.haste;
    }
    return totals;
  }

  // ── Corpus building ────────────────────────────────────────────────────────

  function buildFilteredCorpus(charInfo, selectedEraId) {
    var classMask = charInfo.classMask;
    var raceMask  = charInfo.raceMask;
    var level     = charInfo.level || 60;
    var ec        = window.EraConfig;
    var corpus    = [];
    var seen      = {};

    function tryAdd(item, rawId) {
      var id = String(item.id || item.Id || rawId);
      if (seen[id]) return;
      seen[id] = true;

      if (isUnobtainableItem(item)) return;

      var icRaw = parseInt(item.classes);
      var ic    = isNaN(icRaw) ? 32767 : icRaw;
      if (ic === 0) return;
      if (classMask && (ic & classMask) === 0) return;
      if (raceMask) {
        var ir = parseInt(item.races) || 0;
        if (ir !== 0 && (ir & raceMask) === 0) return;
      }
      var req = parseInt(item.reqlevel) || 0;
      if (req > level) return;
      if (ec) {
        var selectedEraOrder = ec.getEra(selectedEraId) ? ec.getEra(selectedEraId).order : 99;
        if (item.min_expansion !== undefined && item.min_expansion !== null) {
          if (parseInt(item.min_expansion) > selectedEraOrder) return;
        } else {
          if (!ec.isItemIdAvailableInEra(id, selectedEraId)) return;
        }
      }

      item._slots = parseInt(item.slots) || 0;
      corpus.push(item);
    }

    var db  = window.__DPS_ITEMS__;
    var wdb = window.__DPS_WEAPONS_MERGED__;

    if (db) {
      var ids = Object.keys(db);
      for (var i = 0; i < ids.length; i++) {
        var it = db[ids[i]];
        if (it && it.Name) tryAdd(it, ids[i]);
      }
    }
    if (wdb) {
      var wids = Object.keys(wdb);
      for (var j = 0; j < wids.length; j++) {
        var wi = wdb[wids[j]];
        if (wi && wi.Name) tryAdd(wi, wids[j]);
      }
    }

    return corpus;
  }

  function getItemsForSlot(corpus, slotKey) {
    var mask        = SLOT_BITMASK_MAP[slotKey] || 0;
    if (!mask) return [];
    var isSecondary = slotKey === 'Secondary';
    var out = [];
    for (var i = 0; i < corpus.length; i++) {
      var item = corpus[i];
      if ((item._slots & mask) === 0) continue;
      if (isSecondary) {
        var dmg   = parseInt(item.damage) || 0;
        var dly   = parseInt(item.delay)  || 0;
        var itype = parseInt(item.itemtype) || 0;
        if (!((dmg > 0 && dly > 0) || itype === 7)) continue;
      }
      out.push(item);
    }
    return out;
  }

  // ── BIS computation ────────────────────────────────────────────────────────

  function getLoreKey(item) {
    var lore = item.lore || item.Lore || '';
    return (typeof lore === 'string' && lore.charAt(0) === '*') ? lore : null;
  }

  function scoreSlot(corpus, slotKey, currentStats, weights, statCaps, n, usedLore, baseStats) {
    var items       = getItemsForSlot(corpus, slotKey);
    var dispWeights = computeDisplayWeights(_priorityList, currentStats, statCaps, baseStats);
    if (weights.haste === 0) dispWeights.haste = 0; // honour weapon-haste exclusion in display too

    // Determine whether to use weapon ratio scoring for this slot
    var profile       = _charInfo ? (CLASS_WEAPON_PROFILE[_charInfo.classId] || 'melee') : 'melee';
    var useWeaponScore = WEAPON_SCORED_SLOTS[slotKey] && profile !== 'caster';
    // For knights, Secondary may be a shield — scoreWeapon handles that gracefully (ratio=0)

    var scored = [];
    for (var i = 0; i < items.length; i++) {
      if (usedLore) {
        var lk = getLoreKey(items[i]);
        if (lk && usedLore[lk]) continue;
      }
      var s = getItemCombinedStats(items[i]);
      var score, displayScore, scoreBreakdown;
      if (useWeaponScore) {
        var ws     = scoreWeapon(items[i], s, weights, dispWeights, currentStats, statCaps, baseStats);
        score          = ws.score;
        displayScore   = ws.displayScore;
        scoreBreakdown = ws.scoreBreakdown;
      } else {
        score          = scoreItem(s, weights, currentStats, statCaps, baseStats);
        displayScore   = scoreItem(s, dispWeights, currentStats, statCaps, baseStats);
        scoreBreakdown = computeDisplayBreakdown(s, dispWeights, currentStats, statCaps, baseStats);
      }
      scored.push({ item: items[i], stats: s, score: score, displayScore: displayScore, scoreBreakdown: scoreBreakdown });
    }
    scored.sort(function (a, b) { return b.score - a.score; });
    return scored.slice(0, n || 5);
  }

  /** Build a usedLore map from a result set, optionally excluding one slot. */
  function buildUsedLore(resultSet, excludeSlot) {
    var usedLore = {};
    for (var k in resultSet) {
      if (k === excludeSlot) continue;
      var entry = resultSet[k];
      if (entry && entry.item) {
        var lk = getLoreKey(entry.item);
        if (lk) usedLore[lk] = true;
      }
    }
    return usedLore;
  }

  /**
   * Compute the BIS set using a greedy phase followed by iterative coordinate-descent
   * refinement. Weights are computed dynamically per-slot from the priority list so
   * the optimizer naturally hits higher-priority caps first.
   */
  function computeBISSet(corpus, charInfo) {
    var caps      = getStatCaps(charInfo.planarPowerRank);
    var base      = charInfo.baseStats || {};
    var accumulated = {};
    var result      = {};
    var usedLore    = {};

    // Phase 1: greedy pass (slot priority order)
    for (var i = 0; i < BIS_SLOT_PRIORITY.length; i++) {
      var slotKey      = BIS_SLOT_PRIORITY[i];
      var currentStats = sumStatsExcludingSlot(accumulated, slotKey);
      var weights      = computeWeightsFromPriority(_priorityList, currentStats, caps, base);
      if (_excludeWeaponHaste && WEAPON_RANGE_SLOTS[slotKey]) weights.haste = 0;
      var top          = scoreSlot(corpus, slotKey, currentStats, weights, caps, 1, usedLore, base);
      if (top.length > 0) {
        result[slotKey]      = top[0];
        accumulated[slotKey] = { item: top[0].item };
        var lk = getLoreKey(top[0].item);
        if (lk) usedLore[lk] = true;
      }
    }

    // Phase 2: iterative coordinate-descent refinement (up to 5 passes)
    var MAX_ITER = 5;
    for (var iter = 0; iter < MAX_ITER; iter++) {
      var improved = false;
      for (var si = 0; si < BIS_SLOT_PRIORITY.length; si++) {
        var sk        = BIS_SLOT_PRIORITY[si];
        var ctxStats  = sumStatsExcludingSlot(result, sk);
        var wts       = computeWeightsFromPriority(_priorityList, ctxStats, caps, base);
        if (_excludeWeaponHaste && WEAPON_RANGE_SLOTS[sk]) wts.haste = 0;
        var loreCtx   = buildUsedLore(result, sk);
        var topNew    = scoreSlot(corpus, sk, ctxStats, wts, caps, 1, loreCtx, base);
        if (!topNew.length) continue;

        // Re-score the currently assigned item under the same context for a fair comparison
        var curEntry  = result[sk];
        var curScore  = curEntry
          ? scoreItem(getItemCombinedStats(curEntry.item), wts, ctxStats, caps, base)
          : 0;

        if (topNew[0].score > curScore) {
          // Check lore conflict before committing
          var newLore = getLoreKey(topNew[0].item);
          if (newLore && loreCtx[newLore]) continue;
          result[sk] = topNew[0];
          improved   = true;
        }
      }
      if (!improved) break;
    }

    return result;
  }

  /**
   * Upgrade advisor: for each slot, score all items against the current equipped set
   * and return top N candidates. Lore items equipped in other slots are excluded.
   */
  function computeUpgrades(corpus, equippedItems, charInfo) {
    var caps = getStatCaps(charInfo.planarPowerRank);
    var base = charInfo.baseStats || {};
    var result = {};

    var equippedLoreBySlot = {};
    SLOT_KEYS.forEach(function (k) {
      var entry = equippedItems[k];
      if (entry && entry.item) {
        var lk = getLoreKey(entry.item);
        if (lk) equippedLoreBySlot[k] = lk;
      }
    });

    for (var k = 0; k < SLOT_KEYS.length; k++) {
      var slotKey      = SLOT_KEYS[k];
      var currentStats = sumStatsExcludingSlot(equippedItems, slotKey);
      var weights      = computeWeightsFromPriority(_priorityList, currentStats, caps, base);
      if (_excludeWeaponHaste && WEAPON_RANGE_SLOTS[slotKey]) weights.haste = 0;

      var usedLore = {};
      SLOT_KEYS.forEach(function (other) {
        if (other !== slotKey && equippedLoreBySlot[other]) {
          usedLore[equippedLoreBySlot[other]] = true;
        }
      });

      var dispWeights  = computeDisplayWeights(_priorityList, currentStats, caps, base);
      if (_excludeWeaponHaste && WEAPON_RANGE_SLOTS[slotKey]) dispWeights.haste = 0;

      var candidates   = scoreSlot(corpus, slotKey, currentStats, weights, caps, 5, usedLore, base);
      var currentEntry = equippedItems[slotKey];
      var currentItem  = currentEntry && currentEntry.item ? currentEntry.item : null;
      var currentItemStats = currentItem ? getItemCombinedStats(currentItem) : null;
      var currentScore = currentItem
        ? scoreItem(currentItemStats, weights, currentStats, caps, base)
        : 0;
      var currentDisplayScore = currentItem
        ? scoreItem(currentItemStats, dispWeights, currentStats, caps, base)
        : 0;
      var currentBreakdown = currentItem
        ? computeDisplayBreakdown(currentItemStats, dispWeights, currentStats, caps, base)
        : null;

      result[slotKey] = {
        current:    currentItem ? { item: currentItem, score: currentScore, displayScore: currentDisplayScore, scoreBreakdown: currentBreakdown, stats: currentItemStats } : null,
        candidates: candidates
      };
    }
    return result;
  }

  /**
   * Compute gap data: for each enabled priority stat, compare current gear totals
   * vs BIS set totals and report gap, cap info, and progress.
   */
  function computeGapData(bisSet, equippedItems) {
    var charInfo   = getCharInfoFromUI();
    var caps       = getStatCaps(charInfo.planarPowerRank);
    var baseStats  = charInfo.baseStats || {};
    var hasEquipped = false;
    var curTotals  = { ac: 0, hp: 0, mana: 0, str: 0, dex: 0, agi: 0, sta: 0, int: 0, wis: 0, atk: 0, haste: 0, ft: 0, resist: 0, regen: 0 };
    var bisTotals  = { ac: 0, hp: 0, mana: 0, str: 0, dex: 0, agi: 0, sta: 0, int: 0, wis: 0, atk: 0, haste: 0, ft: 0, resist: 0, regen: 0 };

    SLOT_KEYS.forEach(function (k) {
      var eEntry = equippedItems[k];
      if (eEntry && eEntry.item) {
        hasEquipped = true;
        var es = getItemCombinedStats(eEntry.item);
        STAT_KEYS.forEach(function (s) {
          if (s === 'haste') { if ((es.haste || 0) > curTotals.haste) curTotals.haste = es.haste; }
          else curTotals[s] += es[s] || 0;
        });
      }
      var bEntry = bisSet[k];
      if (bEntry && bEntry.stats) {
        var bs = bEntry.stats;
        STAT_KEYS.forEach(function (s) {
          if (s === 'haste') { if ((bs.haste || 0) > bisTotals.haste) bisTotals.haste = bs.haste; }
          else bisTotals[s] += bs[s] || 0;
        });
      }
    });

    // Add race base + creation pts to primary stats so the gap table shows
    // net stats comparable directly against the cap (e.g. Barbarian 103 base STR
    // means 103 already counts toward the 255 cap before any gear).
    ['str', 'dex', 'agi', 'sta'].forEach(function (s) {
      var b = baseStats[s] || 0;
      curTotals[s] += b;
      bisTotals[s] += b;
    });

    var rows = _priorityList
      .filter(function (e) { return e.enabled; })
      .map(function (e, idx) {
        var stat    = e.stat;
        var target  = e.target;
        var cap     = caps[stat];
        var curV    = curTotals[stat] || 0;
        var bisV    = bisTotals[stat] || 0;
        var dispCap = (cap < 9999) ? cap : null;
        return {
          stat:        stat,
          label:       STAT_LABELS[stat] || stat.toUpperCase(),
          rank:        idx + 1,
          target:      target,
          curTotal:    curV,
          bisTotal:    bisV,
          gap:         bisV - curV,
          atCap:       dispCap !== null && curV >= dispCap,
          bisCap:      dispCap !== null && bisV >= dispCap,
          displayCap:  dispCap,
          isHaste:     stat === 'haste'
        };
      });

    return { rows: rows, hasEquipped: hasEquipped };
  }

  // ── Character info ─────────────────────────────────────────────────────────

  function getCharInfoFromUI() {
    var classEl = document.getElementById('class');
    var raceEl  = document.getElementById('char-race');
    var levelEl = document.getElementById('level');
    var classId = classEl ? classEl.value : 'warrior';
    var raceId  = raceEl  ? raceEl.value  : 'human';
    var level   = levelEl ? (parseInt(levelEl.value) || 60) : 60;

    var ppBtn  = document.querySelector('.aa-seg-btn.active[data-aa-id="planarPower"]');
    var ppRank = ppBtn ? (parseInt(ppBtn.dataset.aaRank) || 0) : 0;

    // Base stats = race base + allocated creation pts; excludes gear.
    // Cap room for primary stats = stat_cap - baseStats[stat] - gearFromOtherSlots.
    var baseStats = (typeof window.getCharBaseStats === 'function')
      ? window.getCharBaseStats()
      : { str: 75, dex: 75, agi: 75, sta: 75 };

    return {
      classId:         classId,
      raceId:          raceId,
      level:           level,
      classMask:       CLASS_BITMASK_MAP[classId] || 0,
      raceMask:        RACE_BITMASK_MAP[raceId]   || 0,
      planarPowerRank: ppRank,
      baseStats:       baseStats
    };
  }

  function getCurrentEraId() {
    var eraEl = $('bis-era-select');
    if (eraEl && eraEl.value) return eraEl.value;
    if (window.getSelectedEra) return window.getSelectedEra();
    return 'velious';
  }

  // ── Persistence ────────────────────────────────────────────────────────────

  function savePrefs() {
    try {
      localStorage.setItem('bis_prefs', JSON.stringify({
        version:             2,
        priorityList:        _priorityList,
        excludeWeaponHaste:  _excludeWeaponHaste
      }));
    } catch (e) {}
  }

  function loadPrefs() {
    try {
      var raw = localStorage.getItem('bis_prefs');
      if (!raw) return;
      var prefs = JSON.parse(raw);

      if (prefs.version === 2 && Array.isArray(prefs.priorityList) && prefs.priorityList.length > 0) {
        // v2: restore priority list directly, filling any missing stats
        var loaded  = prefs.priorityList;
        var present = {};
        loaded.forEach(function (e) { if (e && e.stat) present[e.stat] = true; });
        // Append any stat keys missing from saved list (new stats added in later versions)
        STAT_KEYS.forEach(function (s) {
          if (!present[s]) {
            loaded.push({ stat: s, target: STAT_DEFAULT_TARGETS[s] || 99999, enabled: false });
          }
        });
        _priorityList = loaded;
        if (typeof prefs.excludeWeaponHaste === 'boolean') _excludeWeaponHaste = prefs.excludeWeaponHaste;
      } else if (prefs.role) {
        // v1 migration: convert old role to priority list
        var roleKey = prefs.role;
        if (!ROLE_DEFAULT_ORDERS[roleKey]) roleKey = 'meleeDPS';
        _priorityList = buildDefaultPriorityList(roleKey);
      }
    } catch (e) {}
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  var WEAPON_SCORE_TOOLTIP = 'Score uses a damage\u2215delay ratio proxy. Use the simulator for accurate DPS comparisons.';

  function renderSlotLabel(slotKey) {
    var label   = SLOT_DISPLAY_LABELS[slotKey] || slotKey;
    var profile = _charInfo ? (CLASS_WEAPON_PROFILE[_charInfo.classId] || 'melee') : 'melee';
    if (WEAPON_SCORED_SLOTS[slotKey] && profile !== 'caster') {
      return esc(label) + ' <span class="bis-slot-info" title="' + esc(WEAPON_SCORE_TOOLTIP) + '">&#9432;</span>';
    }
    return esc(label);
  }

  function renderHasteTag(stats) {
    var h = stats && stats.haste;
    if (!h) return '';
    return '<span class="bis-haste-tag" title="Worn haste">&#9889;&nbsp;' + h + '%</span>';
  }

  function renderKeyStats(stats, priorityOrder) {
    var ORDER = priorityOrder && priorityOrder.length
      ? priorityOrder.filter(function (e) { return e.enabled; }).map(function (e) { return e.stat; })
      : ['haste', 'atk', 'ft', 'mana', 'int', 'wis', 'str', 'dex', 'agi', 'sta', 'ac', 'hp', 'resist', 'regen'];
    var parts = [];
    for (var i = 0; i < ORDER.length && parts.length < 4; i++) {
      var s = ORDER[i];
      var v = stats[s] || 0;
      if (!v) continue;
      var label = STAT_LABELS[s] || s.toUpperCase();
      parts.push(s === 'haste' ? label + '\u00a0' + v + '%' : label + '\u00a0' + (v > 0 ? '+' : '') + v);
    }
    return parts.join('  ') || '—';
  }

  /**
   * Render stat delta between a candidate item and the current item in a slot.
   * Shows gains (green), losses (red), and cap-crossing events.
   */
  function renderStatDelta(candidateStats, currentStats, contextStats, statCaps) {
    var parts = [];
    var capEvents = [];
    var ORDER = _priorityList.filter(function (e) { return e.enabled; }).map(function (e) { return e.stat; });

    for (var i = 0; i < ORDER.length; i++) {
      var stat  = ORDER[i];
      var candV = candidateStats[stat] || 0;
      var curV  = currentStats ? (currentStats[stat] || 0) : 0;
      var delta = candV - curV;
      if (!delta) continue;

      var label = STAT_LABELS[stat] || stat.toUpperCase();
      var suffix = stat === 'haste' ? '%' : '';

      if (delta > 0) {
        // Check if this delta crosses the stat's cap target
        var ctxV   = contextStats ? (contextStats[stat] || 0) : 0;
        var cap    = statCaps[stat];
        var before = ctxV + curV;
        var after  = ctxV + candV;
        var target = cap < 9999 ? cap : 99999;
        if (before < target && after >= target) {
          capEvents.push(label);
        }
        parts.push('<span class="bis-sd-gain">+' + delta + suffix + ' ' + label + '</span>');
      } else {
        parts.push('<span class="bis-sd-loss">' + delta + suffix + ' ' + label + '</span>');
      }
    }

    if (!parts.length && !capEvents.length) return '';
    var html = '<div class="bis-stat-delta">' + parts.join('') ;
    if (capEvents.length) {
      html += '<span class="bis-sd-cap">&#9733; caps ' + capEvents.join(', ') + '</span>';
    }
    html += '</div>';
    return html;
  }

  /**
   * Render the priority stat gap summary.
   * Shows current gear vs BIS totals for each enabled priority stat
   * with progress bars toward caps.
   */
  function renderGapSummary(gapData) {
    if (!gapData || !gapData.rows || !gapData.rows.length) return '';

    var rows = gapData.rows.map(function (r) {
      var suffix    = r.isHaste ? '%' : '';
      var capLabel  = r.displayCap !== null ? r.displayCap + suffix : '—';

      // Progress bar widths
      var bisRef    = r.displayCap !== null ? r.displayCap : Math.max(r.bisTotal, 1);
      var curPct    = Math.min(100, Math.round((r.curTotal / bisRef) * 100));
      var bisPct    = Math.min(100, Math.round((r.bisTotal / bisRef) * 100));

      var curClass  = 'bis-gap-cur' + (r.atCap ? ' bis-gap-cur--capped' : '');
      var rowClass  = 'bis-gap-row' + (r.atCap ? ' bis-gap-row--capped' : '');
      var deltaClass = r.gap > 0 ? 'bis-gap-delta-up' : (r.gap < 0 ? 'bis-gap-delta-down' : 'bis-gap-delta-eq');
      var deltaHtml;
      if (r.gap > 0)      deltaHtml = '+' + r.gap + suffix;
      else if (r.gap < 0) deltaHtml = r.gap + suffix;
      else                deltaHtml = '&#10003;';

      // Only show equipped columns when inventory is loaded
      var curCellHtml = gapData.hasEquipped
        ? '<td class="' + curClass + '">' + r.curTotal + suffix + (r.atCap ? ' <span class="bis-cap-check">&#10003;</span>' : '') + '</td>'
        : '';
      var deltaCellHtml = gapData.hasEquipped
        ? '<td class="' + deltaClass + '">' + deltaHtml + '</td>'
        : '';

      return '<tr class="' + rowClass + '">' +
        '<td class="bis-gap-rank">' + r.rank + '</td>' +
        '<td class="bis-gap-stat">' + esc(r.label) + '</td>' +
        curCellHtml +
        '<td class="bis-gap-bis">' + r.bisTotal + suffix + (r.bisCap ? ' <span class="bis-cap-check">&#10003;</span>' : '') + '</td>' +
        deltaCellHtml +
        '<td class="bis-gap-cap">' + capLabel + '</td>' +
        '<td class="bis-gap-prog">' +
          '<div class="bis-prog-track">' +
            '<div class="bis-prog-bis" style="width:' + bisPct + '%"></div>' +
            '<div class="bis-prog-cur" style="width:' + curPct + '%"></div>' +
          '</div>' +
        '</td>' +
        '</tr>';
    }).join('');

    var headerCols = gapData.hasEquipped
      ? '<th>Your Gear</th><th>BIS Set</th><th>Gap</th>'
      : '<th>BIS Set</th>';

    return '<div class="bis-gap-bar">' +
      '<div class="bis-gap-title">Priority Stat Summary' + (gapData.hasEquipped ? ' — Current Gear vs BIS' : '') + '</div>' +
      '<table class="bis-gap-table">' +
        '<thead><tr><th>#</th><th>Stat</th>' + headerCols + '<th>Cap</th><th>Progress</th></tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
      '</table>' +
      '</div>';
  }

  function renderBISSetTab(bisSet, gapData) {
    var gap = gapData ? renderGapSummary(gapData) : '';
    var rows = SLOT_KEYS.map(function (slotKey) {
      var entry = bisSet[slotKey];
      var label = SLOT_DISPLAY_LABELS[slotKey] || slotKey;
      if (!entry) {
        return '<tr><td class="bis-td-slot">' + renderSlotLabel(slotKey) + '</td>' +
          '<td colspan="3" style="color:var(--muted);font-size:0.82rem;">No items found</td></tr>';
      }
      var name      = entry.item.Name || entry.item.name || '?';
      var score     = Math.round(entry.displayScore !== undefined ? entry.displayScore : entry.score);
      var statsStr  = renderKeyStats(entry.stats, _priorityList);
      var hastePart = renderHasteTag(entry.stats);
      var bkTitle   = entry.scoreBreakdown ? esc(formatBreakdownTitle(entry.scoreBreakdown, score)) : '';
      return '<tr>' +
        '<td class="bis-td-slot">'  + renderSlotLabel(slotKey) + '</td>' +
        '<td class="bis-td-name">'  + esc(name)     + '</td>' +
        '<td class="bis-td-haste">' + hastePart     + '</td>' +
        '<td class="bis-td-stats">' + esc(statsStr) + '</td>' +
        '<td class="bis-td-score"><span class="bis-score-pill bis-score-tip"' + (bkTitle ? ' title="' + bkTitle + '"' : '') + '>' + score + '</span></td>' +
        '</tr>';
    });
    return gap +
      '<div class="bis-table-wrap"><table class="bis-table">' +
      '<thead><tr>' +
      '<th>Slot</th><th>Best Item</th><th></th><th>Key Stats</th><th>Score</th>' +
      '</tr></thead>' +
      '<tbody>' + rows.join('') + '</tbody>' +
      '</table></div>';
  }

  function renderUpgradeAdvisorTab(upgrades, gapData) {
    var caps = getStatCaps(getCharInfoFromUI().planarPowerRank);
    var gap  = gapData && gapData.hasEquipped ? renderGapSummary(gapData) : '';
    var html = gap;

    SLOT_KEYS.forEach(function (slotKey) {
      var data  = upgrades[slotKey];
      if (!data) return;
      var label       = renderSlotLabel(slotKey);
      var currentItem = data.current ? data.current.item : null;
      var currentName = currentItem ? (currentItem.Name || currentItem.name || '?') : '(empty)';
      var currentScore = data.current ? Math.round(data.current.displayScore !== undefined ? data.current.displayScore : data.current.score) : 0;
      var currentStats = data.current ? data.current.stats : null;
      var currentId   = currentItem ? String(currentItem.id || currentItem.Id || '') : '';

      var topCandidate = data.candidates.length > 0 ? data.candidates[0] : null;
      var topId        = topCandidate ? String(topCandidate.item.id || topCandidate.item.Id || '') : '';
      var isOptimal    = currentItem && topCandidate && currentId === topId;

      // context stats = all other slots in equippedItems
      var ctxStats = sumStatsExcludingSlot(window.__invManagerState || {}, slotKey);

      html += '<div class="bis-upgrade-slot' + (isOptimal ? ' is-optimal' : '') + '">';
      html += '<div class="bis-upgrade-header">';
      if (isOptimal) html += '<span class="bis-optimal-check" title="You have the best item for this slot">&#10003;</span> ';
      html += label + '</div>';

      if (isOptimal) {
        html += '<div class="bis-optimal-banner">';
        html += '<span class="bis-optimal-icon">&#10003;</span>';
        html += '<span class="bis-optimal-text">Best in slot equipped — <strong>' + esc(currentName) + '</strong></span>';
        html += '</div>';
        var alternates = data.candidates.slice(1);
        if (alternates.length) {
          html += '<div class="bis-alternates-label">Alternatives:</div>';
          html += '<ol class="bis-candidates bis-candidates-alt" start="2">';
          alternates.forEach(function (c) {
            var score = Math.round(c.displayScore !== undefined ? c.displayScore : c.score);
            var name  = c.item.Name || c.item.name || '?';
            var pct   = currentScore > 0 ? Math.round(((score - currentScore) / currentScore) * 100) : 0;
            var delta = pct < 0 ? '<span class="bis-delta-down">(' + pct + '%)</span>' : '';
            html += '<li class="bis-candidate">';
            var altBkTitle = c.scoreBreakdown ? esc(formatBreakdownTitle(c.scoreBreakdown, score)) : '';
            html += '<span class="bis-name-inline">' + esc(name) + '</span>';
            html += renderHasteTag(c.stats);
            html += ' <span class="bis-score-pill bis-score-tip"' + (altBkTitle ? ' title="' + altBkTitle + '"' : '') + '>' + score + '</span>';
            if (delta) html += ' ' + delta;
            html += '</li>';
          });
          html += '</ol>';
        }
      } else {
        html += '<div class="bis-upgrade-current">Currently: <span class="bis-name-inline">' + esc(currentName) + '</span>';
        if (currentItem) {
          var curBkTitle = data.current && data.current.scoreBreakdown ? esc(formatBreakdownTitle(data.current.scoreBreakdown, currentScore)) : '';
          html += ' <span class="bis-score-pill bis-score-tip"' + (curBkTitle ? ' title="' + curBkTitle + '"' : '') + '>' + currentScore + '</span>';
        }
        html += '</div>';

        if (!data.candidates.length) {
          html += '<div class="bis-no-results">No candidates found.</div>';
        } else {
          html += '<ol class="bis-candidates">';
          data.candidates.forEach(function (c, idx) {
            var score  = Math.round(c.displayScore !== undefined ? c.displayScore : c.score);
            var name   = c.item.Name || c.item.name || '?';
            var delta  = '';
            if (currentItem && currentScore > 0) {
              var pct = Math.round(((score - currentScore) / currentScore) * 100);
              if (pct > 0) delta = '<span class="bis-delta-up">(+' + pct + '%)</span>';
              else if (pct < 0) delta = '<span class="bis-delta-down">(' + pct + '%)</span>';
            } else if (!currentItem && score > 0) {
              delta = '<span class="bis-delta-up">(new)</span>';
            }
            var isBIS    = idx === 0;
            var candBkTitle = c.scoreBreakdown ? esc(formatBreakdownTitle(c.scoreBreakdown, score)) : '';
            html += '<li class="bis-candidate' + (isBIS ? ' is-bis' : '') + '">';
            html += '<span class="bis-name-inline">' + esc(name) + '</span>';
            html += renderHasteTag(c.stats);
            html += ' <span class="bis-score-pill bis-score-tip"' + (candBkTitle ? ' title="' + candBkTitle + '"' : '') + '>' + score + '</span>';
            if (delta) html += ' ' + delta;
            if (isBIS) html += ' <span class="bis-bis-tag">BIS</span>';
            // Stats delta for top candidate only
            if (isBIS) {
              html += renderStatDelta(c.stats, currentStats, ctxStats, caps);
            }
            html += '</li>';
          });
          html += '</ol>';
        }
      }

      html += '</div>';
    });
    return html || '<div class="bis-no-results">No data available.</div>';
  }

  // ── Priority list UI ───────────────────────────────────────────────────────

  function renderPriorityList() {
    var rows = _priorityList.map(function (entry, idx) {
      var label    = STAT_LABELS[entry.stat] || entry.stat.toUpperCase();
      var isFirst  = idx === 0;
      var isLast   = idx === _priorityList.length - 1;
      var targetDisp = entry.target >= 9999 ? '' : String(entry.target);
      var targetPH   = entry.target >= 9999 ? 'Max' : '';
      var disabledCls = entry.enabled ? '' : ' bis-prio-row--disabled';
      return '<div class="bis-prio-row' + disabledCls + '" data-idx="' + idx + '">' +
        '<span class="bis-prio-rank">' + (entry.enabled ? (idx + 1) : '—') + '</span>' +
        '<div class="bis-prio-move">' +
          '<button type="button" class="bis-prio-up" data-idx="' + idx + '"' + (isFirst ? ' disabled' : '') + '>&#9650;</button>' +
          '<button type="button" class="bis-prio-down" data-idx="' + idx + '"' + (isLast ? ' disabled' : '') + '>&#9660;</button>' +
        '</div>' +
        '<span class="bis-prio-label">' + esc(label) + '</span>' +
        '<span class="bis-prio-target-wrap">' +
          '<input type="number" class="bis-prio-target-input" data-idx="' + idx + '" ' +
            'value="' + targetDisp + '" placeholder="' + targetPH + '" min="1" max="99999">' +
        '</span>' +
        '<label class="bis-prio-toggle">' +
          '<input type="checkbox" class="bis-prio-check" data-idx="' + idx + '"' + (entry.enabled ? ' checked' : '') + '>' +
          ' Active' +
        '</label>' +
        '</div>';
    }).join('');

    return '<div class="bis-prio-list">' + rows + '</div>';
  }

  function renderControls() {
    var ec     = window.EraConfig;
    var eras   = (ec && ec.ERAS) ? ec.ERAS : [];
    var eraId  = window.getSelectedEra ? window.getSelectedEra() : 'velious';
    var eraOpts = eras.map(function (e) {
      return '<option value="' + e.id + '"' + (e.id === eraId ? ' selected' : '') + '>' + esc(e.label) + '</option>';
    }).join('');

    var presetBtns = Object.keys(ROLE_DEFAULT_ORDERS).map(function (key) {
      return '<button type="button" class="bis-preset-btn" data-preset="' + key + '">' + esc(ROLE_PRESET_LABELS[key] || key) + '</button>';
    }).join('');

    return '<div class="bis-controls-row">' +
        '<div class="bis-control-group">' +
          '<label for="bis-era-select" class="bis-ctrl-label">Era:</label>' +
          '<select id="bis-era-select" class="bis-era-select">' + eraOpts + '</select>' +
        '</div>' +
        '<div class="bis-control-group">' +
          '<span class="bis-ctrl-label">Preset:</span>' +
          '<div class="bis-preset-btns">' + presetBtns + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="bis-controls-row bis-controls-options">' +
        '<label class="bis-option-toggle" title="Ignore haste bonuses on weapons and ranged slots — lets the optimizer pick the best weapon by damage/stats without being biased toward haste proc items">' +
          '<input type="checkbox" id="bis-exclude-weapon-haste"' + (_excludeWeaponHaste ? ' checked' : '') + '> ' +
          'Exclude haste from weapon &amp; ranged slots' +
        '</label>' +
      '</div>' +
      '<div class="bis-prio-header">' +
        '<span class="bis-prio-title">Priority Order</span>' +
        '<span class="bis-prio-hint">Optimizer targets each stat\'s cap in order before moving to the next.</span>' +
      '</div>' +
      '<div class="bis-prio-cols-header">' +
        '<span class="bis-prio-col-rank">#</span>' +
        '<span class="bis-prio-col-move"></span>' +
        '<span class="bis-prio-col-label">Stat</span>' +
        '<span class="bis-prio-col-target">Target</span>' +
        '<span class="bis-prio-col-active">Active</span>' +
      '</div>' +
      '<div id="bis-prio-list-wrap" class="bis-prio-list-wrap">' +
        renderPriorityList() +
      '</div>';
  }

  function refreshPriorityListUI() {
    var wrap = $('bis-prio-list-wrap');
    if (wrap) wrap.innerHTML = renderPriorityList();
    wirePriorityListEvents();
  }

  // ── Recompute ──────────────────────────────────────────────────────────────

  function recompute() {
    var content = $('bis-content');
    if (content) {
      content.innerHTML = '<div class="bis-loading">Optimizing&#x2026;</div>';
    }
    setTimeout(function () {
      try {
        var charInfo      = getCharInfoFromUI();
        _charInfo         = charInfo;   // make available to scoreSlot for class-aware weapon scoring
        var selectedEraId = getCurrentEraId();
        var equippedItems = window.__invManagerState || {};

        var corpus   = buildFilteredCorpus(charInfo, selectedEraId);
        var bisSet   = computeBISSet(corpus, charInfo);
        var upgrades = computeUpgrades(corpus, equippedItems, charInfo);
        var gapData  = computeGapData(bisSet, equippedItems);
        _bisResult   = { bisSet: bisSet, upgrades: upgrades, gapData: gapData };
        renderCurrentTab();
      } catch (e) {
        var c = $('bis-content');
        if (c) c.innerHTML = '<div style="color:#e88;padding:1rem;">Error: ' + esc(String(e.message || e)) + '</div>';
      }
    }, 16);
  }

  function renderCurrentTab() {
    var content = $('bis-content');
    if (!content || !_bisResult) return;
    if (_activeTab === 'bisset') {
      content.innerHTML = renderBISSetTab(_bisResult.bisSet, _bisResult.gapData);
    } else {
      content.innerHTML = renderUpgradeAdvisorTab(_bisResult.upgrades, _bisResult.gapData);
    }
  }

  // ── Tab switching ──────────────────────────────────────────────────────────

  function switchBISTab(tabId) {
    _activeTab = tabId;
    ['bisset', 'upgrade'].forEach(function (t) {
      var btn = $('bis-tab-' + t);
      if (btn) btn.classList.toggle('active', t === tabId);
    });
    renderCurrentTab();
  }

  // ── Event wiring ───────────────────────────────────────────────────────────

  function wirePriorityListEvents() {
    // ↑ / ↓ buttons
    var upBtns = document.querySelectorAll('#bis-prio-list-wrap .bis-prio-up');
    upBtns.forEach(function (btn) {
      btn.addEventListener('click', function () {
        var idx = parseInt(this.dataset.idx);
        if (idx <= 0) return;
        var tmp               = _priorityList[idx - 1];
        _priorityList[idx - 1] = _priorityList[idx];
        _priorityList[idx]    = tmp;
        savePrefs();
        refreshPriorityListUI();
        recompute();
      });
    });

    var downBtns = document.querySelectorAll('#bis-prio-list-wrap .bis-prio-down');
    downBtns.forEach(function (btn) {
      btn.addEventListener('click', function () {
        var idx = parseInt(this.dataset.idx);
        if (idx >= _priorityList.length - 1) return;
        var tmp               = _priorityList[idx + 1];
        _priorityList[idx + 1] = _priorityList[idx];
        _priorityList[idx]    = tmp;
        savePrefs();
        refreshPriorityListUI();
        recompute();
      });
    });

    // Target value inputs
    var targetInputs = document.querySelectorAll('#bis-prio-list-wrap .bis-prio-target-input');
    targetInputs.forEach(function (input) {
      input.addEventListener('change', function () {
        var idx = parseInt(this.dataset.idx);
        var val = parseInt(this.value);
        if (!isNaN(val) && val > 0) {
          _priorityList[idx].target = val;
        } else {
          _priorityList[idx].target = 99999;
          this.value = '';
        }
        savePrefs();
        recompute();
      });
    });

    // Active checkboxes
    var checks = document.querySelectorAll('#bis-prio-list-wrap .bis-prio-check');
    checks.forEach(function (cb) {
      cb.addEventListener('change', function () {
        var idx = parseInt(this.dataset.idx);
        _priorityList[idx].enabled = this.checked;
        savePrefs();
        refreshPriorityListUI();
        recompute();
      });
    });
  }

  function wireControlEvents() {
    // Era selector
    var eraEl = $('bis-era-select');
    if (eraEl) eraEl.addEventListener('change', recompute);

    // Exclude weapon haste toggle
    var exHasteEl = $('bis-exclude-weapon-haste');
    if (exHasteEl) {
      exHasteEl.addEventListener('change', function () {
        _excludeWeaponHaste = this.checked;
        savePrefs();
        recompute();
      });
    }

    // Preset buttons
    var presetBtns = document.querySelectorAll('#bis-controls-inner .bis-preset-btn');
    presetBtns.forEach(function (btn) {
      btn.addEventListener('click', function () {
        var roleKey = this.dataset.preset;
        _priorityList = buildDefaultPriorityList(roleKey);
        savePrefs();
        refreshPriorityListUI();
        recompute();
      });
    });

    wirePriorityListEvents();
  }

  // ── Modal open / close ─────────────────────────────────────────────────────

  function openBISModal() {
    var overlay = $('bis-overlay');
    if (!overlay) return;
    loadPrefs();
    _itemStatsCache = {};

    var controlsInner = $('bis-controls-inner');
    if (controlsInner) controlsInner.innerHTML = renderControls();

    ['bisset', 'upgrade'].forEach(function (t) {
      var btn = $('bis-tab-' + t);
      if (btn) btn.classList.toggle('active', t === _activeTab);
    });

    wireControlEvents();
    overlay.classList.add('is-open');
    overlay.setAttribute('aria-hidden', 'false');
    recompute();
  }

  function closeBISModal() {
    var overlay = $('bis-overlay');
    if (!overlay) return;
    overlay.classList.remove('is-open');
    overlay.setAttribute('aria-hidden', 'true');
  }

  // ── Init ───────────────────────────────────────────────────────────────────

  document.addEventListener('DOMContentLoaded', function () {
    if (_eventsWired) return;
    _eventsWired = true;

    var openBtn = $('bis-open');
    if (openBtn) openBtn.addEventListener('click', openBISModal);

    var closeBtn = $('bis-close');
    if (closeBtn) closeBtn.addEventListener('click', closeBISModal);

    var overlay = $('bis-overlay');
    if (overlay) {
      overlay.addEventListener('click', function (e) {
        if (e.target === overlay) closeBISModal();
      });
    }

    var bissetBtn  = $('bis-tab-bisset');
    var upgradeBtn = $('bis-tab-upgrade');
    if (bissetBtn)  bissetBtn.addEventListener('click',  function () { switchBISTab('bisset'); });
    if (upgradeBtn) upgradeBtn.addEventListener('click', function () { switchBISTab('upgrade'); });
  });

  // ── Public API ─────────────────────────────────────────────────────────────

  window.BISAdvisor = { open: openBISModal, close: closeBISModal };
})();
