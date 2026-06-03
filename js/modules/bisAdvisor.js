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

  // Priority order for Melee DPS (monk example):
  //   1. 41% haste (capped — only highest worn item counts)
  //   2. Worn ATK up to 250 (capped at 250 in getStatCaps)
  //   3. STR / STA / DEX / AGI — all equal; once capped marginal = 0
  //   4. HP
  //   5. Resists (total of all five)
  //   6. HP regen
  // Weights express relative priority within each tier.
  // Cap-aware scoring naturally zeroes out overcapped stats, so
  // a +20 STR item on a fully-capped character scores 0 for STR.
  var ROLE_PRESETS = {
    meleeDPS: {
      label: 'Melee DPS',
      // Tier 1: haste (capped at 41% — only highest worn item counts)
      // Tier 2: worn ATK (capped at 250 — each point directly raises offense rating)
      // Tier 3: primary stats (capped at 255 — contribute via formula, marginal value zeroes at cap)
      // Tier 4+: HP, AC, resists, regen
      // ATK weight is set well above stats so that e.g. 15 worn ATK (225) beats 20 mixed stats (120).
      weights: { haste: 10, atk: 15, str: 6, sta: 6, dex: 6, agi: 6, hp: 3, ac: 1, resist: 1, regen: 1, wis: 0, int: 0, mana: 0 }
    },
    tank: {
      label: 'Tank',
      weights: { ac: 10, hp: 8, agi: 5, sta: 5, str: 2, haste: 2, atk: 1, dex: 1, resist: 2, regen: 1, wis: 0, int: 0, mana: 0 }
    },
    casterMana: {
      label: 'Caster / Mana',
      // Mana-focused classes (bard, cleric, druid, shaman, wizards, etc.)
      // Tier 1: FT (Flowing Thought — stacks additively, capped at FT15; sustains mana indefinitely)
      // Tier 2: mana pool (direct resource)
      // Tier 3: INT / WIS (mana pool scaling, capped at 255)
      // Tier 4: HP, AC (survivability)
      // Tier 5: resists, regen
      weights: { ft: 10, mana: 8, int: 6, wis: 6, hp: 4, ac: 3, sta: 2, resist: 2, regen: 2, haste: 0, atk: 0, str: 0, dex: 0, agi: 0 }
    },
    custom: {
      label: 'Custom',
      weights: { haste: 5, atk: 5, mana: 5, ft: 5, int: 3, wis: 3, str: 3, dex: 3, agi: 3, sta: 3, ac: 3, hp: 3, resist: 1, regen: 1 }
    }
  };

  var BASE_STAT_CAP = 255;

  // Only the highest worn haste item applies in EQ — additional haste items are wasted.
  // Score haste as "useful up to this threshold" so items at 41% and 55% score equally,
  // and once any other slot provides 41%+ haste the marginal value of more haste = 0.
  var HASTE_TARGET = 41;

  // Practical worn ATK cap. Additional worn ATK beyond this provides no meaningful benefit.
  var ATK_CAP = 250;

  // Flowing Thought cap. FT items stack additively up to a maximum of FT15.
  var FT_CAP = 15;

  // Items that are unobtainable by players — GM items or summoned items that cannot be equipped.
  // Summoned: prefix is filtered dynamically by name; GM items are listed here by name.
  var GM_ITEM_NAME_BLOCKLIST = {
    'The Ban Hammer': true,
    'The Prime Healers Bulwark': true,  // artifact — unobtainable by players
    'Bladesouls Spiritual Armguards': true  // GM event item — not obtainable by regular players
  };

  /**
   * Return true if this item should be excluded from BIS consideration.
   * Filters: summoned items (name prefix "Summoned:") and known GM/unobtainable items.
   */
  function isUnobtainableItem(item) {
    var name = item.Name || item.name || '';
    if (name.indexOf('Summoned:') === 0) return true;
    if (GM_ITEM_NAME_BLOCKLIST[name]) return true;
    // minstatus field is preserved by items-to-js.mjs (if present) — skip GM-status items
    if (parseInt(item.minstatus) > 0) return true;
    return false;
  }

  // ── Module state ───────────────────────────────────────────────────────────

  var _currentRole = 'meleeDPS';
  var _customWeights = Object.assign({}, ROLE_PRESETS.custom.weights);
  // Ensure any new stat keys added later don't produce undefined slider values
  Object.keys(ROLE_PRESETS.custom.weights).forEach(function (k) {
    if (_customWeights[k] === undefined) _customWeights[k] = 0;
  });
  var _activeTab = 'bisset';
  var _bisResult = null;       // { bisSet, upgrades } computed on open
  var _itemStatsCache = {};    // item id → combined stat object (memoized)
  var _eventsWired = false;    // static modal events wired once

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
   * Extends the existing decodeWornSpell() to cover STR/DEX/AGI/STA/INT/WIS/AC/HP.
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
      // Formula 101 = scales with caster/item level; limit value is max at level 60
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
            // bv=101: generic haste category — real % encoded in item's wornlevel field
            var h = bv > 101 ? (bv - 100) : ((itemWornLevel || 0) + 1);
            result.haste = Math.max(result.haste, h);
          }
          break;
        case 69: if (ev > 0) result.hp   = Math.max(result.hp,   ev); break;
        case 15: if (ev > 0) result.ft    = Math.max(result.ft,    ev); break; // SE_CurrentMana (Flowing Thought)
        case 0:  if (ev > 0) result.regen = Math.max(result.regen, ev); break; // SE_CurrentHP (HP regen)
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
      // Sum of all five resist types from raw item fields
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
    var cap = BASE_STAT_CAP + bonus;
    return {
      // Primary stats — hard capped; Planar Power raises cap by 5/rank
      str: cap, dex: cap, agi: cap, sta: cap, int: cap, wis: cap,
      // Haste: only the highest worn item applies; capped at HASTE_TARGET
      // sumStatsExcludingSlot tracks max (not sum), so a covered slot scores 0 for haste
      haste: HASTE_TARGET,
      // Worn ATK: practical cap beyond which additional ATK has no benefit
      atk: ATK_CAP,
      // Flowing Thought: stacks additively across items up to FT15
      ft: FT_CAP,
      // Truly uncapped — scored on raw value only
      ac: 99999, hp: 99999, mana: 99999, resist: 99999, regen: 99999
    };
  }

  // ── Scoring ────────────────────────────────────────────────────────────────

  /**
   * Score an item's stats given current stats in other slots and per-stat weights.
   * Cap-aware: only the marginal gain below the stat cap is counted.
   */
  function scoreItem(itemStats, weights, currentStats, statCaps) {
    var score = 0;
    var keys = Object.keys(weights);
    for (var i = 0; i < keys.length; i++) {
      var stat = keys[i];
      var w = weights[stat] || 0;
      if (!w) continue;
      var raw = itemStats[stat] || 0;
      if (!raw) continue;
      var cap = statCaps[stat];
      var cur = currentStats ? (currentStats[stat] || 0) : 0;
      var marginal;
      if (cap >= 9999) {
        marginal = raw; // uncapped stat
      } else {
        marginal = Math.min(raw, Math.max(0, cap - cur));
      }
      score += marginal * w;
    }
    return score;
  }

  // ── Stat accumulation ──────────────────────────────────────────────────────

  /**
   * Accumulate stats from all equipped slots except the given one.
   * Most stats are additive. Haste uses MAX because only the highest worn
   * haste item applies in EQ — summing haste would produce incorrect scoring.
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
      totals.ft     += s.ft     || 0;  // FT stacks additively across items
      totals.resist += s.resist || 0;
      totals.regen  += s.regen  || 0;
      // Haste: only the highest item applies — track max, not sum
      if ((s.haste || 0) > totals.haste) totals.haste = s.haste;
    }
    return totals;
  }

  // ── Corpus building ────────────────────────────────────────────────────────

  /**
   * Pre-filter items by class, race, level, and era into a flat array.
   * Items are annotated with _slots (parsed int) for fast per-slot filtering.
   * Called once per recompute(); results NOT cached (era/class may change).
   */
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

      // Filter GM/summoned/unobtainable items
      if (isUnobtainableItem(item)) return;

      // Class filter. classes=0 means literally no class can equip (e.g. Sword of Truth).
      // Treat missing/NaN classes as all-class (32767) to avoid dropping valid items.
      var icRaw = parseInt(item.classes);
      var ic = isNaN(icRaw) ? 32767 : icRaw;
      if (ic === 0) return;
      if (classMask && (ic & classMask) === 0) return;
      // Race filter
      if (raceMask) {
        var ir = parseInt(item.races) || 0;
        if (ir !== 0 && (ir & raceMask) === 0) return;
      }
      // Level requirement
      var req = parseInt(item.reqlevel) || 0;
      if (req > level) return;
      // Era filter — prefer min_expansion numeric field (0=Classic…4=PoP);
      // fall back to ID-range heuristic only when field is absent.
      if (ec) {
        var selectedEraOrder = ec.getEra(selectedEraId) ? ec.getEra(selectedEraId).order : 99;
        if (item.min_expansion !== undefined && item.min_expansion !== null) {
          if (parseInt(item.min_expansion) > selectedEraOrder) return;
        } else {
          if (!ec.isItemIdAvailableInEra(id, selectedEraId)) return;
        }
      }

      // Pre-parse slots int for fast bitmask checks later
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

  /** Filter a pre-built corpus to items valid for a specific slot. */
  function getItemsForSlot(corpus, slotKey) {
    var mask = SLOT_BITMASK_MAP[slotKey] || 0;
    if (!mask) return [];
    var isSecondary = slotKey === 'Secondary';
    var out = [];
    for (var i = 0; i < corpus.length; i++) {
      var item = corpus[i];
      if ((item._slots & mask) === 0) continue;
      // Secondary slot: only weapons (damage>0 && delay>0) or shields (itemtype 7).
      // Misc/book items that technically fit the slot (e.g. Book of Contemplation)
      // are excluded because players use a weapon or shield there in practice.
      if (isSecondary) {
        var dmg  = parseInt(item.damage) || 0;
        var dly  = parseInt(item.delay)  || 0;
        var itype = parseInt(item.itemtype) || 0;
        if (!(( dmg > 0 && dly > 0) || itype === 7)) continue;
      }
      out.push(item);
    }
    return out;
  }

  // ── BIS computation ────────────────────────────────────────────────────────

  /** Return the lore key for an item if it is equippable lore (*), else null. */
  function getLoreKey(item) {
    var lore = item.lore || item.Lore || '';
    return (typeof lore === 'string' && lore.charAt(0) === '*') ? lore : null;
  }

  /** Score all items in a slot and return top N, sorted by score descending.
   *  usedLore: Set-like object of lore strings already committed elsewhere — skip those items. */
  function scoreSlot(corpus, slotKey, currentStats, weights, statCaps, n, usedLore) {
    var items = getItemsForSlot(corpus, slotKey);
    var scored = [];
    for (var i = 0; i < items.length; i++) {
      // Skip lore items already committed to another slot
      if (usedLore) {
        var lk = getLoreKey(items[i]);
        if (lk && usedLore[lk]) continue;
      }
      var s = getItemCombinedStats(items[i]);
      var score = scoreItem(s, weights, currentStats, statCaps);
      scored.push({ item: items[i], stats: s, score: score });
    }
    scored.sort(function (a, b) { return b.score - a.score; });
    return scored.slice(0, n || 5);
  }

  /**
   * Greedy BIS set: pick best item per slot in priority order,
   * accumulating stats as we go for cap-aware scoring.
   * Tracks used lore items so each equippable-lore item appears in at most one slot.
   */
  function computeBISSet(corpus, charInfo, weights) {
    var caps        = getStatCaps(charInfo.planarPowerRank);
    var accumulated = {}; // slotKey → { item }
    var result      = {}; // slotKey → { item, stats, score }
    var usedLore    = {}; // lore string → true, for items already picked

    for (var i = 0; i < BIS_SLOT_PRIORITY.length; i++) {
      var slotKey = BIS_SLOT_PRIORITY[i];
      var currentStats = sumStatsExcludingSlot(accumulated, slotKey);
      var top = scoreSlot(corpus, slotKey, currentStats, weights, caps, 1, usedLore);
      if (top.length > 0) {
        result[slotKey] = top[0];
        accumulated[slotKey] = { item: top[0].item };
        var lk = getLoreKey(top[0].item);
        if (lk) usedLore[lk] = true;
      }
    }
    return result;
  }

  /**
   * Upgrade advisor: for each slot, score all items against the current equipped set
   * and return top N candidates.
   * Lore items equipped in other slots are excluded from each slot's candidate list.
   */
  function computeUpgrades(corpus, equippedItems, charInfo, weights) {
    var caps   = getStatCaps(charInfo.planarPowerRank);
    var result = {};

    // Build a map of lore strings already equipped, keyed by slot
    // so we can exclude a lore item from all slots except where it's currently worn.
    var equippedLoreBySlot = {};
    SLOT_KEYS.forEach(function (k) {
      var entry = equippedItems[k];
      if (entry && entry.item) {
        var lk = getLoreKey(entry.item);
        if (lk) equippedLoreBySlot[k] = lk;
      }
    });

    for (var k = 0; k < SLOT_KEYS.length; k++) {
      var slotKey = SLOT_KEYS[k];
      var currentStats = sumStatsExcludingSlot(equippedItems, slotKey);

      // Build usedLore for this slot: all lore items equipped in OTHER slots
      var usedLore = {};
      SLOT_KEYS.forEach(function (other) {
        if (other !== slotKey && equippedLoreBySlot[other]) {
          usedLore[equippedLoreBySlot[other]] = true;
        }
      });

      var candidates   = scoreSlot(corpus, slotKey, currentStats, weights, caps, 5, usedLore);

      var currentEntry = equippedItems[slotKey];
      var currentItem  = currentEntry && currentEntry.item ? currentEntry.item : null;
      var currentScore = currentItem
        ? scoreItem(getItemCombinedStats(currentItem), weights, currentStats, caps)
        : 0;

      result[slotKey] = {
        current:    currentItem ? { item: currentItem, score: currentScore } : null,
        candidates: candidates
      };
    }
    return result;
  }

  // ── Character info ─────────────────────────────────────────────────────────

  function getCharInfoFromUI() {
    var classEl = document.getElementById('class');
    var raceEl  = document.getElementById('char-race');
    var levelEl = document.getElementById('level');
    var classId = classEl ? classEl.value : 'warrior';
    var raceId  = raceEl  ? raceEl.value  : 'human';
    var level   = levelEl ? (parseInt(levelEl.value) || 60) : 60;

    // Read Planar Power rank from the AA button that is active
    var ppBtn   = document.querySelector('.aa-seg-btn.active[data-aa-id="planarPower"]');
    var ppRank  = ppBtn ? (parseInt(ppBtn.dataset.aaRank) || 0) : 0;

    return {
      classId:        classId,
      raceId:         raceId,
      level:          level,
      classMask:      CLASS_BITMASK_MAP[classId] || 0,
      raceMask:       RACE_BITMASK_MAP[raceId]   || 0,
      planarPowerRank: ppRank
    };
  }

  function getCurrentEraId() {
    var eraEl = $('bis-era-select');
    if (eraEl && eraEl.value) return eraEl.value;
    if (window.getSelectedEra) return window.getSelectedEra();
    return 'velious';
  }

  function getCurrentWeights() {
    if (_currentRole === 'custom') return _customWeights;
    return (ROLE_PRESETS[_currentRole] || ROLE_PRESETS.meleeDPS).weights;
  }

  // ── Persistence ────────────────────────────────────────────────────────────

  function savePrefs() {
    try {
      localStorage.setItem('bis_prefs', JSON.stringify({
        role:          _currentRole,
        customWeights: _customWeights
      }));
    } catch (e) {}
  }

  function loadPrefs() {
    try {
      var raw = localStorage.getItem('bis_prefs');
      if (!raw) return;
      var prefs = JSON.parse(raw);
      if (prefs.role && ROLE_PRESETS[prefs.role]) _currentRole = prefs.role;
      if (prefs.customWeights) _customWeights = Object.assign({}, ROLE_PRESETS.custom.weights, prefs.customWeights);
    } catch (e) {}
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  /**
   * Return a haste badge string if the item has a worn haste effect, else ''.
   * Shown inline next to item names in both the BIS Set table and Upgrade Advisor.
   */
  function renderHasteTag(stats) {
    var h = stats && stats.haste;
    if (!h) return '';
    return '<span class="bis-haste-tag" title="Worn haste">&#9889;&nbsp;' + h + '%</span>';
  }

  /** Render top 4 non-zero stats for display. */
  function renderKeyStats(stats) {
    var ORDER = ['haste', 'atk', 'ft', 'mana', 'int', 'wis', 'str', 'dex', 'agi', 'sta', 'ac', 'hp', 'resist', 'regen'];
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

  function renderBISSetTab(bisSet) {
    var rows = SLOT_KEYS.map(function (slotKey) {
      var entry = bisSet[slotKey];
      var label = SLOT_DISPLAY_LABELS[slotKey] || slotKey;
      if (!entry) {
        return '<tr><td class="bis-td-slot">' + esc(label) + '</td>' +
          '<td colspan="3" style="color:var(--muted);font-size:0.82rem;">No items found</td></tr>';
      }
      var name     = entry.item.Name || entry.item.name || '?';
      var score    = Math.round(entry.score);
      var statsStr = renderKeyStats(entry.stats);
      var hastePart = renderHasteTag(entry.stats);
      return '<tr>' +
        '<td class="bis-td-slot">'  + esc(label)    + '</td>' +
        '<td class="bis-td-name">'  + esc(name)     + '</td>' +
        '<td class="bis-td-haste">' + hastePart     + '</td>' +
        '<td class="bis-td-stats">' + esc(statsStr) + '</td>' +
        '<td class="bis-td-score">' + score         + '</td>' +
        '</tr>';
    });
    return '<div class="bis-table-wrap"><table class="bis-table">' +
      '<thead><tr>' +
      '<th>Slot</th><th>Best Item</th><th></th><th>Key Stats</th><th>Score</th>' +
      '</tr></thead>' +
      '<tbody>' + rows.join('') + '</tbody>' +
      '</table></div>';
  }

  /**
   * Render the summary diff bar at the top of the Upgrade Advisor.
   * Shows total current gear stats vs BIS stats, and the delta for each.
   * Only shown when at least one item is equipped (inventory was imported).
   */
  function renderUpgradeSummary(upgrades, bisSet) {
    // Show only stats with non-zero weight in the current role — keeps the bar concise
    // and automatically highlights the right stats for caster vs melee vs tank roles.
    var weights = getCurrentWeights();
    var ALL_STATS = ['haste', 'atk', 'ft', 'mana', 'int', 'wis', 'str', 'dex', 'agi', 'sta', 'ac', 'hp', 'resist', 'regen'];
    var SUMMARY_STATS = ALL_STATS.filter(function (s) { return (weights[s] || 0) > 0; });
    var cur = {}; var bis = {};
    SUMMARY_STATS.forEach(function (s) { cur[s] = 0; bis[s] = 0; });

    var anyEquipped = false;
    SLOT_KEYS.forEach(function (slotKey) {
      var upg  = upgrades[slotKey];
      var bisE = bisSet && bisSet[slotKey];

      // Current gear — additive except haste (max)
      if (upg && upg.current) {
        anyEquipped = true;
        var cs = getItemCombinedStats(upg.current.item);
        SUMMARY_STATS.forEach(function (s) {
          if (s === 'haste') { if ((cs.haste || 0) > cur.haste) cur.haste = cs.haste; }
          else cur[s] += cs[s] || 0;
        });
      }
      // BIS gear — additive except haste (max)
      if (bisE) {
        var bs = bisE.stats;
        SUMMARY_STATS.forEach(function (s) {
          if (s === 'haste') { if ((bs.haste || 0) > bis.haste) bis.haste = bs.haste; }
          else bis[s] += bs[s] || 0;
        });
      }
    });

    if (!anyEquipped) return ''; // No inventory loaded — skip summary

    var cells = SUMMARY_STATS.map(function (s) {
      var label = STAT_LABELS[s] || s.toUpperCase();
      var curV  = cur[s];
      var bisV  = bis[s];
      var diff  = bisV - curV;
      var diffHtml;
      if (diff > 0)      diffHtml = '<span class="bis-sum-delta-up">+' + diff + (s === 'haste' ? '%' : '') + '</span>';
      else if (diff < 0) diffHtml = '<span class="bis-sum-delta-down">' + diff + (s === 'haste' ? '%' : '') + '</span>';
      else               diffHtml = '<span class="bis-sum-delta-eq">&#10003;</span>';
      return '<div class="bis-sum-cell">' +
        '<div class="bis-sum-label">' + esc(label) + '</div>' +
        '<div class="bis-sum-vals">' +
          '<span class="bis-sum-cur">' + curV + (s === 'haste' ? '%' : '') + '</span>' +
          '<span class="bis-sum-arrow">&#8594;</span>' +
          '<span class="bis-sum-bis">' + bisV + (s === 'haste' ? '%' : '') + '</span>' +
        '</div>' +
        '<div class="bis-sum-diff">' + diffHtml + '</div>' +
        '</div>';
    });

    return '<div class="bis-summary-bar">' +
      '<div class="bis-summary-title">Current gear vs. full BIS</div>' +
      '<div class="bis-summary-cells">' + cells.join('') + '</div>' +
      '</div>';
  }

  function renderUpgradeAdvisorTab(upgrades) {
    var html = '';
    SLOT_KEYS.forEach(function (slotKey) {
      var data  = upgrades[slotKey];
      if (!data) return;
      var label = SLOT_DISPLAY_LABELS[slotKey] || slotKey;
      var currentItem  = data.current ? data.current.item : null;
      var currentName  = currentItem ? (currentItem.Name || currentItem.name || '?') : '(empty)';
      var currentScore = data.current ? Math.round(data.current.score) : 0;
      var currentId    = currentItem ? String(currentItem.id || currentItem.Id || '') : '';

      // Detect if currently equipped item IS the top-ranked candidate
      var topCandidate   = data.candidates.length > 0 ? data.candidates[0] : null;
      var topId          = topCandidate ? String(topCandidate.item.id || topCandidate.item.Id || '') : '';
      var isOptimal      = currentItem && topCandidate && currentId === topId;

      html += '<div class="bis-upgrade-slot' + (isOptimal ? ' is-optimal' : '') + '">';

      // Slot header — with checkmark badge when optimal
      html += '<div class="bis-upgrade-header">';
      if (isOptimal) {
        html += '<span class="bis-optimal-check" title="You have the best item for this slot">&#10003;</span> ';
      }
      html += esc(label) + '</div>';

      if (isOptimal) {
        // Clear "slot done" banner
        html += '<div class="bis-optimal-banner">';
        html += '<span class="bis-optimal-icon">&#10003;</span>';
        html += '<span class="bis-optimal-text">Best in slot equipped — <strong>' + esc(currentName) + '</strong></span>';
        html += '</div>';
        // Still show remaining candidates (starting from #2) so the player can see what's close
        var alternates = data.candidates.slice(1);
        if (alternates.length) {
          html += '<div class="bis-alternates-label">Alternatives:</div>';
          html += '<ol class="bis-candidates bis-candidates-alt" start="2">';
          alternates.forEach(function (c) {
            var score = Math.round(c.score);
            var name  = c.item.Name || c.item.name || '?';
            var pct   = currentScore > 0 ? Math.round(((score - currentScore) / currentScore) * 100) : 0;
            var delta = pct < 0 ? '<span class="bis-delta-down">(' + pct + '%)</span>' : '';
            html += '<li class="bis-candidate">';
            html += '<span class="bis-name-inline">' + esc(name) + '</span>';
            html += renderHasteTag(c.stats);
            html += ' <span class="bis-score-pill">' + score + '</span>';
            if (delta) html += ' ' + delta;
            html += '</li>';
          });
          html += '</ol>';
        }
      } else {
        // Normal (not optimal) — show current item and ranked candidates
        html += '<div class="bis-upgrade-current">Currently: <span class="bis-name-inline">' + esc(currentName) + '</span>';
        if (currentItem) html += ' <span class="bis-score-pill">' + currentScore + '</span>';
        html += '</div>';

        if (!data.candidates.length) {
          html += '<div class="bis-no-results">No candidates found.</div>';
        } else {
          html += '<ol class="bis-candidates">';
          data.candidates.forEach(function (c, idx) {
            var score = Math.round(c.score);
            var name  = c.item.Name || c.item.name || '?';
            var delta = '';
            if (currentItem && currentScore > 0) {
              var pct = Math.round(((score - currentScore) / currentScore) * 100);
              if (pct > 0) delta = '<span class="bis-delta-up">(+' + pct + '%)</span>';
              else if (pct < 0) delta = '<span class="bis-delta-down">(' + pct + '%)</span>';
            } else if (!currentItem && score > 0) {
              delta = '<span class="bis-delta-up">(new)</span>';
            }
            var isBIS = idx === 0;
            html += '<li class="bis-candidate' + (isBIS ? ' is-bis' : '') + '">';
            html += '<span class="bis-name-inline">' + esc(name) + '</span>';
            html += renderHasteTag(c.stats);
            html += ' <span class="bis-score-pill">' + score + '</span>';
            if (delta) html += ' ' + delta;
            if (isBIS) html += ' <span class="bis-bis-tag">BIS</span>';
            html += '</li>';
          });
          html += '</ol>';
        }
      }

      html += '</div>';
    });
    return html || '<div class="bis-no-results">No data available.</div>';
  }

  function renderWeightSliders() {
    var ORDER = ['haste', 'atk', 'ft', 'mana', 'int', 'wis', 'str', 'dex', 'agi', 'sta', 'ac', 'hp', 'resist', 'regen'];
    var rows  = ORDER.map(function (stat) {
      var label = STAT_LABELS[stat] || stat.toUpperCase();
      var val   = _customWeights[stat] !== undefined ? _customWeights[stat] : 0;
      return '<div class="bis-slider-row">' +
        '<span class="bis-slider-label">' + esc(label) + '</span>' +
        '<input type="range" class="bis-weight-slider" data-stat="' + stat + '" ' +
               'min="0" max="10" step="1" value="' + val + '">' +
        '<span class="bis-slider-val" id="bis-w-' + stat + '">' + val + '</span>' +
        '</div>';
    });
    return '<div class="bis-slider-grid">' + rows.join('') + '</div>';
  }

  function renderControls() {
    var ec     = window.EraConfig;
    var eras   = (ec && ec.ERAS) ? ec.ERAS : [];
    var eraId  = window.getSelectedEra ? window.getSelectedEra() : 'velious';
    var eraOpts = eras.map(function (e) {
      return '<option value="' + e.id + '"' + (e.id === eraId ? ' selected' : '') + '>' + esc(e.label) + '</option>';
    }).join('');

    var roleBtns = Object.keys(ROLE_PRESETS).map(function (key) {
      var label = ROLE_PRESETS[key].label;
      var active = _currentRole === key ? ' active' : '';
      return '<button type="button" class="bis-role-btn' + active + '" data-role="' + key + '">' + esc(label) + '</button>';
    }).join('');

    return '<div class="bis-controls-row">' +
        '<div class="bis-control-group">' +
          '<span class="bis-ctrl-label">Role:</span>' +
          '<div class="bis-role-btns">' + roleBtns + '</div>' +
        '</div>' +
        '<div class="bis-control-group">' +
          '<label for="bis-era-select" class="bis-ctrl-label">Era:</label>' +
          '<select id="bis-era-select" class="bis-era-select">' + eraOpts + '</select>' +
        '</div>' +
      '</div>' +
      '<div id="bis-custom-weights"' + (_currentRole === 'custom' ? '' : ' style="display:none"') + '>' +
        '<div class="bis-weights-title">Stat Weights (0 = ignore, 10 = max priority)</div>' +
        renderWeightSliders() +
      '</div>';
  }

  // ── Recompute ──────────────────────────────────────────────────────────────

  function recompute() {
    var content = $('bis-content');
    if (content) {
      content.innerHTML = '<div class="bis-loading">Computing&#x2026;</div>';
    }
    // Defer so the loading state renders before we block the thread
    setTimeout(function () {
      try {
        var charInfo      = getCharInfoFromUI();
        var selectedEraId = getCurrentEraId();
        var weights       = getCurrentWeights();
        var equippedItems = window.__invManagerState || {};

        var corpus   = buildFilteredCorpus(charInfo, selectedEraId);
        var bisSet   = computeBISSet(corpus, charInfo, weights);
        var upgrades = computeUpgrades(corpus, equippedItems, charInfo, weights);
        _bisResult   = { bisSet: bisSet, upgrades: upgrades };
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
      content.innerHTML = renderBISSetTab(_bisResult.bisSet);
    } else {
      content.innerHTML =
        renderUpgradeSummary(_bisResult.upgrades, _bisResult.bisSet) +
        renderUpgradeAdvisorTab(_bisResult.upgrades);
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

  /** Wire dynamic control events after controls HTML is re-rendered. */
  function wireControlEvents() {
    // Role preset buttons
    var roleBtns = document.querySelectorAll('#bis-controls-inner .bis-role-btn');
    roleBtns.forEach(function (btn) {
      btn.addEventListener('click', function () {
        _currentRole = this.dataset.role;
        roleBtns.forEach(function (b) {
          b.classList.toggle('active', b.dataset.role === _currentRole);
        });
        var weightsEl = $('bis-custom-weights');
        if (weightsEl) weightsEl.style.display = _currentRole === 'custom' ? '' : 'none';
        savePrefs();
        recompute();
      });
    });

    // Era selector
    var eraEl = $('bis-era-select');
    if (eraEl) eraEl.addEventListener('change', recompute);

    // Weight sliders
    var sliders = document.querySelectorAll('#bis-controls-inner .bis-weight-slider');
    sliders.forEach(function (slider) {
      slider.addEventListener('input', function () {
        var stat = this.dataset.stat;
        var val  = parseInt(this.value);
        _customWeights[stat] = val;
        var display = $('bis-w-' + stat);
        if (display) display.textContent = val;
        savePrefs();
        if (_currentRole === 'custom') recompute();
      });
    });
  }

  // ── Modal open / close ─────────────────────────────────────────────────────

  function openBISModal() {
    var overlay = $('bis-overlay');
    if (!overlay) return;
    loadPrefs();
    _itemStatsCache = {}; // clear cache so resist/regen fields are freshly computed

    // Render controls HTML (era select + role buttons + sliders)
    var controlsInner = $('bis-controls-inner');
    if (controlsInner) controlsInner.innerHTML = renderControls();

    // Restore active tab indicator
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

    // Open button
    var openBtn = $('bis-open');
    if (openBtn) openBtn.addEventListener('click', openBISModal);

    // Close button (static in HTML)
    var closeBtn = $('bis-close');
    if (closeBtn) closeBtn.addEventListener('click', closeBISModal);

    // Click outside overlay
    var overlay = $('bis-overlay');
    if (overlay) {
      overlay.addEventListener('click', function (e) {
        if (e.target === overlay) closeBISModal();
      });
    }

    // Tab buttons (static in HTML)
    var bissetBtn  = $('bis-tab-bisset');
    var upgradeBtn = $('bis-tab-upgrade');
    if (bissetBtn)  bissetBtn.addEventListener('click',  function () { switchBISTab('bisset'); });
    if (upgradeBtn) upgradeBtn.addEventListener('click', function () { switchBISTab('upgrade'); });
  });

  // ── Public API ─────────────────────────────────────────────────────────────

  window.BISAdvisor = { open: openBISModal, close: closeBISModal };
})();
