/**
 * Item/weapon search via third-party API (QuarmData) for DPS-Sim.
 * Use to search for weapons and autopopulate: damage, delay, elemental damage,
 * bane damage, 1h vs 2h, and proc information.
 *
 * API: GET https://dndquarm.com/api/QuarmData/items/search?nameFilter=<search>
 *
 * The API key is not stored here. It must be provided by itemSearchConfig.js:
 * load itemSearchConfig.js after this script; it calls ItemSearch.setConfig({ apiKey: '...' }).
 * All authenticated requests use config.apiKey set from that file.
 */

(function (global) {
  'use strict';

  var config = {
    baseUrl: 'https://dndquarm.com/api/QuarmData/items/search',
    apiKey: null,  // Set by itemSearchConfig.js (local) or kept server-side when using proxyUrl
    proxyUrl: null, // When set (e.g. '/api/item-search' on Vercel), client calls proxy; key stays on server
    spellBaseUrl: 'https://dndquarm.com/api/QuarmData/spells/search', // Optional: e.g. 'https://dndquarm.com/api/QuarmData/spells' or proxy '/api/spell'
    configApplied: false
  };

  /** Local spell data (e.g. from resources/spells_en.json). When set, used for proc spell name/damage instead of dndquarm/PQDI. */
  var spellData = null;

  /**
   * Configure the item search API. Call from itemSearchConfig.js (local) or index.html (deployed with proxy).
   * @param {Object} opts
   * @param {string} [opts.baseUrl] - Base URL for search (used only when not using proxyUrl).
   * @param {string} [opts.apiKey] - API key (local only; not used when proxyUrl is set).
   * @param {string} [opts.proxyUrl] - Proxy endpoint (e.g. '/api/item-search'); key is set in Vercel env.
   */
  /** When true, search uses local JSON only; no API key or proxy required. */
  var localSearchOnly = false;

  function setItemSearchConfig(opts) {
    if (!opts) return;
    if (opts.localSearchOnly === true) localSearchOnly = true;
    if (opts.localSearchOnly === false) localSearchOnly = false;
    if (typeof opts.baseUrl === 'string') config.baseUrl = opts.baseUrl;
    if (typeof opts.apiKey === 'string') config.apiKey = opts.apiKey;
    if (typeof opts.proxyUrl === 'string') config.proxyUrl = opts.proxyUrl;
    var spellUrl = opts.spellBaseUrl || opts.spellbaseUrl;
    if (typeof spellUrl === 'string') config.spellBaseUrl = spellUrl;
    config.configApplied = true;
  }

  /** Mark config as applied without any remote ItemSearch API (offline / static hosting). */
  function setLocalSearchOnlyMode() {
    localSearchOnly = true;
    config.configApplied = true;
    config.proxyUrl = null;
    config.apiKey = null;
  }

  /**
   * Set local spell data (object keyed by spell ID, e.g. from resources/spells_en.json).
   * When set, fetchSpellById uses this for proc spell name and damage instead of dndquarm/PQDI.
   * @param {Object} data - e.g. { "1790": { name: "Feast of Blood", effect_base_value5: -30, buffduration: "3" }, ... }
   */
  function setSpellData(data) {
    spellData = data && typeof data === 'object' ? data : null;
  }

  /** EQEmu: Spell Effect 0 = SE_CurrentHP (hit points, per-tick or instant); negative base value = damage. */
  var SE_CURRENT_HP = 0;
  /** EQEmu: Spell Effect 79 = SE_CurrentHPOnce (one-time HP change); negative base value = damage per application. */
  var SE_CURRENT_HP_ONCE = 79;
  /** EQEmu: buffdurationformula 0 = instant (not a buff). */
  var BUFF_DURATION_FORMULA_INSTANT = 0;
  /** EQEmu: formula 110 = Base + Level/5 (used for DoT per-tick when spell has formula 110 on effect). Default level for proc scaling when not in fight context. */
  var FORMULA_110 = 110;
  var DEFAULT_PROC_LEVEL_FOR_FORMULA = 55;

  /**
   * Get spell name and damage from local spell data (spells_en.json / EQEmu spells_new format).
   * Uses EQEmu semantics: slots with effectid 0 (SE_CurrentHP) or 79 (SE_CurrentHPOnce) count as HP damage;
   * negative base value = damage. Effect 0: per-tick for DoT or sum for instant. Effect 79: one-shot damage
   * added to total. If maxN (or effect_limit_valueN) is greater than |effect_base_valueN|, that limit is used.
   * For DoT spells, buffdurationTicks is the number of 6-second ticks (used by sim to cap damage until duration ends or refresh).
   * @param {number|string} spellId - Spell ID.
   * @returns {{ name: string, damage?: number, buffdurationTicks?: number, nonDamagingDetrimental?: boolean, bonusHate?: number, ccAddsMobHpThreat?: boolean }|null}
   */
  function getSpellFromLocalData(spellId) {
    if (!spellData || spellData === null) return null;
    var id = typeof spellId === 'number' ? String(spellId) : (spellId != null ? String(spellId).trim() : '');
    if (id === '' || isNaN(parseInt(id, 10))) return null;
    var spell = spellData[id];
    if (!spell || typeof spell !== 'object') return null;
    var name = (spell.name != null ? String(spell.name) : '').trim();
    if (!name) return null;
    var bufFormula = spell.buffdurationformula != null
      ? (typeof spell.buffdurationformula === 'number' ? spell.buffdurationformula : parseInt(String(spell.buffdurationformula), 10))
      : -1;
    var isInstant = !isNaN(bufFormula) && bufFormula === BUFF_DURATION_FORMULA_INSTANT;
    var ticks = 1;
    if (!isInstant && spell.buffduration != null) {
      var t = typeof spell.buffduration === 'number' ? spell.buffduration : parseInt(String(spell.buffduration), 10);
      if (!isNaN(t) && t > 0) ticks = t;
    }
    var totalDirect = 0;
    var perTickDamage = 0;
    var totalOnce = 0;
    for (var i = 1; i <= 12; i++) {
      var eid = spell['effectid' + i];
      if (eid === undefined || eid === null) continue;
      var effectId = typeof eid === 'number' ? eid : parseInt(String(eid), 10);
      var v = spell['effect_base_value' + i];
      if (v === undefined || v === null) continue;
      var n = typeof v === 'number' ? v : parseInt(v, 10);
      if (isNaN(n) || n >= 0) continue;
      var absVal = -n;
      var baseVal = absVal;  // keep base for DoT per-tick (limit is a cap, not replacement)
      var maxNum = null;
      var maxV = spell['max' + i];
      if (maxV === undefined || maxV === null) maxV = spell['effect_limit_value' + i];
      if (maxV !== undefined && maxV !== null) {
        maxNum = typeof maxV === 'number' ? maxV : parseInt(String(maxV), 10);
        if (!isNaN(maxNum) && maxNum > absVal) absVal = maxNum;
      }
      if (effectId === SE_CURRENT_HP_ONCE) {
        totalOnce += absVal;
      } else if (effectId === SE_CURRENT_HP) {
        if (isInstant)
          totalDirect += absVal;
        else {
          // DoT: per-tick damage is base value (with formula 110 = Base + Level/5 if applicable), capped by effect limit
          var formulaVal = spell['formula' + i];
          var formulaNum = formulaVal != null ? (typeof formulaVal === 'number' ? formulaVal : parseInt(String(formulaVal), 10)) : 100;
          var effectiveBase = baseVal;
          if (formulaNum === FORMULA_110) {
            effectiveBase = baseVal + Math.floor(DEFAULT_PROC_LEVEL_FOR_FORMULA / 5);
          }
          // effect_limit_value 0 means no cap in EQ; only apply limit when it is positive
          var perTick = (maxNum != null && !isNaN(maxNum) && maxNum > 0) ? Math.min(effectiveBase, maxNum) : effectiveBase;
          if (perTick > perTickDamage)
            perTickDamage = perTick;
        }
      }
    }
    var damage;
    var fromDirect = isInstant ? totalDirect : (perTickDamage > 0 ? perTickDamage * ticks : 0);
    var total = fromDirect + totalOnce;
    damage = total > 0 ? total : undefined;
    var buffdurationTicks = (!isInstant && ticks > 0) ? ticks : undefined;
    /** spells_en.json: goodEffect 0 = detrimental, 1 = beneficial (EQEmu export). */
    var goodEffectRaw = spell.goodEffect != null ? spell.goodEffect : spell.GoodEffect;
    var goodEffect = goodEffectRaw != null ? (typeof goodEffectRaw === 'number' ? goodEffectRaw : parseInt(String(goodEffectRaw), 10)) : 0;
    if (isNaN(goodEffect)) goodEffect = 0;
    var isDetrimentalSpell = goodEffect === 0;
    var resisttype = spell.resisttype != null ? (typeof spell.resisttype === 'number' ? spell.resisttype : parseInt(String(spell.resisttype), 10)) : 0;
    if (isNaN(resisttype)) resisttype = 0;
    var resistModifier = 0;
    if (spell.ResistDiff != null) {
      var rd = typeof spell.ResistDiff === 'number' ? spell.ResistDiff : parseInt(String(spell.ResistDiff), 10);
      if (!isNaN(rd)) resistModifier = rd;
    }
    var noPartialResist = !!(spell.no_partial_resist != null && spell.no_partial_resist !== 0 && String(spell.no_partial_resist) !== '0');
    var targettype = spell.targettype != null ? (typeof spell.targettype === 'number' ? spell.targettype : parseInt(String(spell.targettype), 10)) : undefined;
    if (targettype != null && isNaN(targettype)) targettype = undefined;
    var SE_Root = 27;
    var SE_MovementSpeed = 54;
    /** EQEmu SE 92: direct hate adjustment (signed; negative reduces threat). */
    var SE_HATE = 92;
    /** EQEmu placeholder / unused slot. */
    var EQ_UNUSED_EFFECT = 254;
    /** Stun — DD + stun procs also generate max-HP/15 style detrimental hate (e.g. Thunder Strike). */
    var SE_STUN = 21;
    var movementEffect = false;
    var bonusHate = 0;
    for (var j = 1; j <= 12; j++) {
      var eid2 = spell['effectid' + j];
      if (eid2 === undefined || eid2 === null) continue;
      var effId = typeof eid2 === 'number' ? eid2 : parseInt(String(eid2), 10);
      if (effId === SE_Root || effId === SE_MovementSpeed) { movementEffect = true; }
      if (effId === SE_HATE) {
        var hv = spell['effect_base_value' + j];
        if (hv !== undefined && hv !== null) {
          var hn = typeof hv === 'number' ? hv : parseInt(String(hv), 10);
          if (!isNaN(hn)) bonusHate += hn;
        }
      }
    }
    var realEffectIds = [];
    for (var r = 1; r <= 12; r++) {
      var eidR = spell['effectid' + r];
      if (eidR === undefined || eidR === null) continue;
      var effR = typeof eidR === 'number' ? eidR : parseInt(String(eidR), 10);
      if (isNaN(effR) || effR === EQ_UNUSED_EFFECT) continue;
      realEffectIds.push(effR);
    }
    var isSe92OnlyHateSpell = !!(isDetrimentalSpell && (damage == null || damage <= 0) &&
      realEffectIds.length === 1 && realEffectIds[0] === SE_HATE);
    var hasStun = false;
    for (var si = 0; si < realEffectIds.length; si++) {
      if (realEffectIds[si] === SE_STUN) { hasStun = true; break; }
    }
    var hasHpDamage = damage != null && damage > 0;
    var out = {
      name: name,
      damage: damage,
      buffdurationTicks: buffdurationTicks,
      resisttype: resisttype,
      resistModifier: resistModifier,
      noPartialResist: noPartialResist,
      movementEffect: movementEffect
    };
    if (bonusHate !== 0) out.bonusHate = bonusHate;
    if (targettype != null) out.targettype = targettype;
    if (isDetrimentalSpell && (damage == null || damage <= 0) && !isSe92OnlyHateSpell) out.nonDamagingDetrimental = true;
    if (isDetrimentalSpell && hasHpDamage && hasStun) out.ccAddsMobHpThreat = true;
    return out;
  }

  /**
   * Build request for spell-by-ID lookup. Uses spellBaseUrl if set, else derives from baseUrl (e.g. .../QuarmData/spells).
   * @param {number|string} spellId - Spell ID.
   * @returns {{ url: string, headers: Object }|null} Request info or null if not configured.
   */
  function getSpellRequest(spellId) {
    var id = typeof spellId === 'number' ? spellId : parseInt(String(spellId), 10);
    if (isNaN(id)) return null;
    var base = config.spellBaseUrl;
    if (!base) {
      var itemsBase = (config.baseUrl || '').replace(/\/items\/search.*$/, '');
      base = itemsBase ? itemsBase + '/spells' : '';
    }
    if (!base) return null;
    var url = base.replace(/\/$/, '') + '/' + id;
    var headers = { 'Accept': 'application/json' };
    if (!config.proxyUrl && config.apiKey) headers['Authorization'] = config.apiKey;
    return { url: url, headers: headers };
  }

  /** PQDI spell page base URL (https://www.pqdi.cc/spell). Used when dndquarm spell API is unavailable or returns no damage. */
  var PQDI_SPELL_BASE = 'https://www.pqdi.cc/spell';

  /**
   * Parse PQDI spell page HTML for name and damage. Handles "Decrease Hitpoints by X per tick" + tick count for total damage.
   * @param {string} html - Raw HTML of pqdi.cc/spell/{id}.
   * @returns {{ name: string, damage?: number }|null}
   */
  function parsePqdiSpellHtml(html) {
    if (!html || typeof html !== 'string') return null;
    var name = '';
    var m = html.match(/<title>\s*([^:]+)\s*::/i);
    if (m) name = m[1].trim();
    if (!name) {
      m = html.match(/\*\*name:\*\*\s*([^\n*]+)/);
      if (m) name = m[1].trim();
    }
    if (!name) return null;
    var damage;
    var perTick = html.match(/Decrease\s+Hitpoints\s+by\s+(\d+)(?:\s+per\s+tick)?/i);
    if (perTick) {
      var perTickVal = parseInt(perTick[1], 10);
      var ticks = html.match(/(\d+)\s+ticks?/i);
      if (ticks && /per\s+tick/i.test(html)) {
        var numTicks = parseInt(ticks[1], 10);
        damage = perTickVal * (numTicks > 0 ? numTicks : 1);
      } else {
        damage = perTickVal;
      }
    }
    return { name: name, damage: damage };
  }

  /**
   * Fetch spell name and damage from PQDI (https://www.pqdi.cc/spell/{id}). May be blocked by CORS; use a proxy if needed.
   * @param {number|string} spellId - Spell ID.
   * @returns {Promise<{ name: string, damage?: number }|null>}
   */
  function fetchSpellFromPqdi(spellId) {
    var id = typeof spellId === 'number' ? spellId : parseInt(String(spellId), 10);
    if (isNaN(id)) return Promise.resolve(null);
    var url = PQDI_SPELL_BASE + '/' + id;
    return fetch(url, { method: 'GET', headers: { 'Accept': 'text/html' }, mode: 'cors' })
      .then(function (res) { return res.ok ? res.text() : null; })
      .then(function (text) { return text ? parsePqdiSpellHtml(text) : null; })
      .catch(function () { return null; });
  }

  /**
   * Fetch spell by ID. Uses local spell data (spells_en.json) when set; otherwise tries dndquarm then PQDI.
   * @param {number|string} spellId - Spell ID.
   * @returns {Promise<{ name: string, damage?: number }|null>} Spell info or null on error.
   */
  function fetchSpellById(spellId) {
    var local = getSpellFromLocalData(spellId);
    if (local && local.name) return Promise.resolve(local);

    var tryPqdi = function () { return fetchSpellFromPqdi(spellId); };
    var mergePqdiDamage = function (result) {
      if (result && result.name && result.damage != null) return Promise.resolve(result);
      return tryPqdi().then(function (pqdi) {
        if (!pqdi || !pqdi.name) return result;
        return {
          name: (result && result.name) ? result.name : pqdi.name,
          damage: (pqdi.damage != null ? pqdi.damage : (result && result.damage != null ? result.damage : undefined))
        };
      });
    };
    var req = getSpellRequest(spellId);
    if (!req) return tryPqdi();
    return fetch(req.url, { method: 'GET', headers: req.headers })
      .then(function (res) {
        if (!res.ok) return null;
        return res.json();
      })
      .then(function (data) {
        if (!data || typeof data !== 'object') return null;
        var get = function (obj, keys, def) {
          for (var i = 0; i < keys.length; i++) {
            var v = obj[keys[i]];
            if (v !== undefined && v !== null) return v;
          }
          return def;
        };
        var name = String(get(data, ['name', 'Name', 'spell_name', 'spellName', 'title']) || '').trim();
        var dmg = get(data, ['damage', 'Damage', 'base_damage', 'baseDamage', 'procDamage', 'proc_damage']);
        var damage = dmg != null ? (typeof dmg === 'number' ? dmg : parseInt(dmg, 10)) : undefined;
        if (damage != null && isNaN(damage)) damage = undefined;
        if (name) return { name: name, damage: damage };
        return null;
      })
      .catch(function () { return null; })
      .then(function (result) {
        if (!result || !result.name) return tryPqdi();
        if (result.damage != null) return result;
        return mergePqdiDamage(result);
      });
  }

  /**
   * Build search URL and headers. Uses proxyUrl when set (no key on client); otherwise baseUrl + apiKey.
   * @param {string} nameFilter - Search string (e.g. weapon name).
   * @returns {{ url: string, headers: Object }}
   */
  function getSearchRequest(nameFilter) {
    var encoded = encodeURIComponent(nameFilter || '');
    var url;
    var headers = { 'Accept': 'application/json' };
    if (config.proxyUrl) {
      var base = config.proxyUrl.replace(/\?.*$/, '');
      url = base + (base.indexOf('?') >= 0 ? '&' : '?') + 'nameFilter=' + encoded;
    } else {
      url = config.baseUrl.replace(/\?.*$/, '') + '?nameFilter=' + encoded;
      if (config.apiKey) headers['Authorization'] = config.apiKey;
    }
    return { url: url, headers: headers };
  }

  function parseItemsResponse(data) {
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.items)) return data.items;
    if (data && Array.isArray(data.results)) return data.results;
    if (data && typeof data === 'object') return [data];
    return [];
  }

  /**
   * Perform a GET search and return raw JSON.
   * No request is made until itemSearchConfig.js has run and called setConfig().
   * @param {string} nameFilter - Search string.
   * @returns {Promise<Array>} Resolves to array of items from API (or [] on error / if config not applied).
   */
  function searchItems(nameFilter) {
    if (localSearchOnly) {
      return Promise.resolve([]);
    }
    if (!config.configApplied) {
      console.warn('ItemSearch: Set config before searching (itemSearchConfig.js locally or proxy on Vercel).');
      return Promise.resolve([]);
    }
    var query = (nameFilter != null ? String(nameFilter) : '').trim();
    var req = getSearchRequest(query);
    return fetch(req.url, { method: 'GET', headers: req.headers })
      .then(function (res) {
        if (!res.ok) {
          return res.json().catch(function () { return {}; }).then(function (body) {
            var msg = (body && body.error) ? body.error : ('Item search failed: ' + res.status);
            if (body && body.detail) msg += ' — ' + body.detail;
            if (body && body.status) msg += ' (upstream status ' + body.status + ')';
            throw new Error(msg);
          });
        }
        return res.json();
      })
      .then(parseItemsResponse)
      .catch(function (err) {
        console.error('Item search error:', err.message || err);
        return [];
      });
  }

  /**
   * Item slot bitmasks (EQ slots) for filtering search results.
   * Weapon 1 = Primary, Weapon 2 = Secondary, Ranged weapon = Ranged, Arrow = Ammo.
   */
  var SLOT_PRIMARY = 8192;
  var SLOT_SECONDARY = 16384;
  var SLOT_RANGED = 2048;
  var SLOT_AMMO = 2097152;

  /**
   * Class bitmasks for item usability (EQ item classes field).
   * If (itemClasses & CLASS_BITMASK[classId]) !== 0, the item is usable by that class.
   */
  var CLASS_BITMASK = {
    warrior: 1,
    cleric: 2,
    paladin: 4,
    ranger: 8,
    shadowknight: 16,
    druid: 32,
    monk: 64,
    bard: 128,
    rogue: 256,
    shaman: 512,
    necromancer: 1024,
    wizard: 2048,
    magician: 4096,
    enchanter: 8192,
    beastlord: 16384
  };

  function getItemClasses(item) {
    if (!item || typeof item !== 'object') return null;
    var get = function (obj, keys, def) {
      for (var i = 0; i < keys.length; i++) {
        var v = obj[keys[i]];
        if (v !== undefined && v !== null) return v;
      }
      return def;
    };
    var raw = get(item, ['classes', 'Classes', 'class', 'Class', 'item_classes', 'itemClasses']);
    if (raw === undefined || raw === null) return null;
    var n = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
    return isNaN(n) ? null : n;
  }

  /**
   * Two-hand weapon types (EQ slot/type strings). Matches 2H entries in ITEM_TYPE_NUM_TO_TYPE.
   */
  var TWO_HAND_TYPES = { '2hb': true, '2hs': true, '2hp': true, 'bow': true, 'archery': true };

  /**
   * API itemType number -> weapon skill type (EQ Emulator schema).
   * Read from API same as damage/delay; used to set type (1HB/1HP/1HS/2HB/2HS/2HP/bow/h2h/throwing).
   * 0=1HS, 1=2HS, 2=1HP, 3=1HB, 4=2HB, 5=bow, 6=throwing, 7=h2h, 35=2HP, 45=h2h
   */
  var ITEM_TYPE_NUM_TO_TYPE = {
    0: '1hs', 1: '2hs', 2: '1hp', 3: '1hb', 4: '2hb', 5: 'bow', 6: 'throwing', 7: 'h2h', 35: '2hp', 45: 'h2h'
  };

  /**
   * dndquarm API: eleDmgType number -> element string (0 = none). 1=magic, 2=fire, 3=cold, 4=poison, 5=disease.
   */
  var ELE_DMG_TYPE_NUM = { 1: 'magic', 2: 'fire', 3: 'cold', 4: 'poison', 5: 'disease' };

  /** Item types that cannot be used in offhand (2HS, 2HB, bow, throwing, 2HP). */
  var OFFHAND_BLOCKED_ITEM_TYPES = { 1: true, 4: true, 5: true, 6: true, 35: true };

  /** When itemtype number is missing, infer offhand block from normalized type string (must match ITEM_TYPE_NUM_TO_TYPE values). */
  var OFFHAND_BLOCKED_TYPE_STRINGS = { '2hs': true, '2hb': true, '2hp': true, 'bow': true, 'throwing': true, 'archery': true };

  /**
   * Map API item to the weapon shape used by DPS-Sim presets and getWeapon().
   * Reads: id, name, damage, delay, itemtype, proceffect, slots, icon, etc.
   * proceffect is the spell ID used to look up spell name and damage from spells_en.json.
   *
   * @param {Object} item - Raw item from the API (e.g. id, Name, damage, delay, itemtype, proceffect, slots, icon).
   * @returns {Object} Normalized weapon: { name, damage, delay, proc?, procDamage?, procSpellId?, elemType?, elemDamage?, baneDamage?, is2H, type }.
   */
  function normalizeItemForWeapon(item) {
    if (!item || typeof item !== 'object') return null;

    var get = function (obj, keys, def) {
      for (var i = 0; i < keys.length; i++) {
        var v = obj[keys[i]];
        if (v !== undefined && v !== null) return v;
      }
      return def;
    };

    var num = function (v) {
      if (v === undefined || v === null) return 0;
      var n = parseInt(v, 10);
      return isNaN(n) ? 0 : n;
    };

    var str = function (v) {
      if (v === undefined || v === null) return '';
      return String(v).trim();
    };

    var name = str(get(item, ['name', 'Name', 'item_name', 'itemName']));
    var damage = num(get(item, ['damage', 'Damage', 'dmg', 'Dmg']));
    var delay = num(get(item, ['delay', 'Delay', 'delay_sec', 'delaySec']));
    /* itemtype / itemType from API -> maps to 1HB/1HP/1HS/2HB/2HS/2HP/bow/h2h/throwing */
    var itemTypeNumRaw = get(item, ['itemtype', 'itemType', 'item_type', 'ItemType']);
    var itemTypeNum = (typeof itemTypeNumRaw === 'number') ? itemTypeNumRaw : (parseInt(itemTypeNumRaw, 10));
    var itemType;
    var is2H;
    if (!isNaN(itemTypeNum) && ITEM_TYPE_NUM_TO_TYPE[itemTypeNum] !== undefined) {
      itemType = ITEM_TYPE_NUM_TO_TYPE[itemTypeNum];
      is2H = !!TWO_HAND_TYPES[itemType];
    } else {
      /* Never use slot/Slot here — in EQ item data those are often slot *bitmasks*, not weapon type strings. */
      itemType = str(get(item, ['type', 'Type', 'weaponType', 'weapon_type', 'WeaponType'])).toLowerCase();
      is2H = itemType ? !!TWO_HAND_TYPES[itemType] : !!get(item, ['is2H', 'isTwoHand', 'twoHanded']);
    }

    /* procEffect / proceffect = spell ID invoked by the proc; we use it to get spell name and damage from spells_en.json. */
    var procSpellId = null;
    var procEffectRaw = get(item, ['procEffect', 'proceffect', 'proc_effect', 'ProcEffect', 'Proceffect', 'procSpellId', 'proc_spell_id', 'procSpellId']);
    if (procEffectRaw === undefined || procEffectRaw === null) {
      for (var key in item) {
        if (Object.prototype.hasOwnProperty.call(item, key) && /^proc.*effect|proceffect$/i.test(String(key).replace(/_/g, ''))) {
          var val = item[key];
          if (val !== undefined && val !== null && (typeof val === 'number' ? !isNaN(val) : !isNaN(parseInt(val, 10)))) {
            procEffectRaw = val;
            break;
          }
        }
      }
    }
    if (typeof procEffectRaw === 'number' && !isNaN(procEffectRaw) && procEffectRaw > 0) procSpellId = procEffectRaw;
    else if (procEffectRaw != null) { var n = parseInt(procEffectRaw, 10); if (!isNaN(n) && n > 0) procSpellId = n; }
    if (item.procSpellData && typeof item.procSpellData === 'object' && item.procSpellData.id != null) {
      var sid = parseInt(item.procSpellData.id, 10);
      if (!isNaN(sid) && sid > 0) procSpellId = sid;
    }
    var procName = '';
    if (item.procSpellData && typeof item.procSpellData === 'object' && item.procSpellData.name != null) {
      procName = str(item.procSpellData.name);
    } else if (item.procEffectData && typeof item.procEffectData === 'object' && item.procEffectData.name != null) {
      procName = str(item.procEffectData.name);
    }
    var procDamage = num(get(item, ['procDamage', 'proc_damage', 'ProcDamage', 'procdamage', 'procDamageAmt', 'proc_damage_amt']));
    if (item.procSpellData && typeof item.procSpellData === 'object' && item.procSpellData.damage != null) {
      procDamage = num(item.procSpellData.damage);
    }
    if (item.procEffectData && typeof item.procEffectData === 'object' && item.procEffectData.damage != null) {
      procDamage = num(item.procEffectData.damage);
    }
    var procRate = num(get(item, ['procrate', 'procRate', 'proc_rate', 'ProcRate', 'proc_rate_mod']));
    if (procRate == null || (typeof procRate === 'number' && isNaN(procRate))) {
      for (var prKey in item) {
        if (Object.prototype.hasOwnProperty.call(item, prKey) && /^proc.*rate|procrate$/i.test(String(prKey).replace(/_/g, ''))) {
          var prVal = num(item[prKey]);
          if (prVal != null && !isNaN(prVal)) { procRate = prVal; break; }
        }
      }
    }
    if (item.procSpellData && typeof item.procSpellData === 'object' && item.procSpellData.procRate != null) {
      var pr = num(item.procSpellData.procRate);
      if (!isNaN(pr)) procRate = pr;
    }
    if (item.procEffectData && typeof item.procEffectData === 'object' && item.procEffectData.procRate != null) {
      var pr2 = num(item.procEffectData.procRate);
      if (!isNaN(pr2)) procRate = pr2;
    }

    var eleDmgTypeNum = num(get(item, ['eleDmgType', 'elemType', 'elem_type', 'elemdmgtype']));
    var elemType;
    if (typeof eleDmgTypeNum === 'number' && ELE_DMG_TYPE_NUM[eleDmgTypeNum]) {
      elemType = ELE_DMG_TYPE_NUM[eleDmgTypeNum];
    } else {
      elemType = str(get(item, ['eleDmgType', 'elemType', 'elem_type', 'elemdmgtype', 'element', 'Element', 'magic', 'Magic'])).toLowerCase();
      if (elemType && !['fire', 'cold', 'poison', 'disease', 'magic'].includes(elemType)) {
        var elemMap = { 'fr': 'fire', 'cr': 'cold', 'pr': 'poison', 'dr': 'disease', 'mr': 'magic' };
        elemType = elemMap[elemType] || elemType;
      }
    }
    var elemDamage = num(get(item, ['eleDmgAmt', 'elemDamage', 'elem_damage', 'elemdmgamt', 'elementalDamage', 'ElementalDamage', 'elemental_damage']));

    var baneDamage = num(get(item, ['banedmgamt', 'baneDmgAmt', 'baneDamage', 'bane_damage', 'BaneDamage', 'bane']));
    var baneDamageRaceRaw = get(item, ['baneDamageRace', 'banedamagerace', 'banedmgrace', 'baneDmgRace', 'bane_damage_race', 'BaneDamageRace']);
    var baneDamageRace = (baneDamageRaceRaw != null && baneDamageRaceRaw !== '') ? parseInt(baneDamageRaceRaw, 10) : null;
    if (isNaN(baneDamageRace)) baneDamageRace = null;
    var baneDamageBodyRaw = get(item, ['baneDamageBody', 'banedmgbody', 'bane_damage_body', 'BaneDamageBody']);
    var baneDamageBody = (baneDamageBodyRaw != null && baneDamageBodyRaw !== '') ? parseInt(baneDamageBodyRaw, 10) : null;
    if (isNaN(baneDamageBody)) baneDamageBody = null;

    /* Skillmod type 7 = archery; skillmodvalue is the archery skill % modifier. Type 8 = backstab. */
    var backstabModPercent = null;
    var archeryModPercent = null;
    var skillmodTypeRaw = get(item, ['skillmodType', 'skillmod_type', 'SkillmodType', 'skillmodtype']);
    var skillmodType = (typeof skillmodTypeRaw === 'number') ? skillmodTypeRaw : parseInt(skillmodTypeRaw, 10);
    var skillmodValRaw = get(item, ['skillmodValue', 'skillmod_value', 'SkillmodValue', 'skillmodvalue']);
    var skillmodVal = (typeof skillmodValRaw === 'number') ? skillmodValRaw : parseInt(skillmodValRaw, 10);
    if (!isNaN(skillmodVal)) {
      if (skillmodType === 7) archeryModPercent = skillmodVal;
      else if (skillmodType === 8) backstabModPercent = skillmodVal;
    }
    var skillmodArr = get(item, ['skillmod', 'skillmods', 'SkillMod']);
    if (Array.isArray(skillmodArr)) {
      for (var i = 0; i < skillmodArr.length; i++) {
        var mod = skillmodArr[i];
        if (!mod || typeof mod !== 'object') continue;
        var modType = (typeof mod.type === 'number') ? mod.type : parseInt(mod.type, 10);
        var modVal = (typeof mod.value === 'number') ? mod.value : parseInt(mod.value, 10);
        if (!isNaN(modVal)) {
          if (modType === 7 && archeryModPercent == null) archeryModPercent = modVal;
          else if (modType === 8 && backstabModPercent == null) backstabModPercent = modVal;
        }
        modType = (typeof mod.skillmodType === 'number') ? mod.skillmodType : parseInt(mod.skillmodType, 10);
        modVal = (typeof mod.skillmodValue === 'number') ? mod.skillmodValue : parseInt(mod.skillmodValue, 10);
        if (!isNaN(modVal)) {
          if (modType === 7 && archeryModPercent == null) archeryModPercent = modVal;
          else if (modType === 8 && backstabModPercent == null) backstabModPercent = modVal;
        }
      }
    }

    var icon = num(get(item, ['icon', 'Icon', 'iconId', 'icon_id']));

    var slotsRaw = get(item, ['slots', 'Slots', 'slot', 'Slot']);
    var slots = (typeof slotsRaw === 'number' && !isNaN(slotsRaw)) ? slotsRaw : parseInt(slotsRaw, 10);
    if (isNaN(slots)) slots = null;

    var itemId = num(get(item, ['id', 'Id', 'item_id', 'itemId']));
    var finalType = itemType || 'undefined';

    var procSpellBonusHate;
    var procSpellNonDamagingDetrimental;
    var procSpellCcAddsMobHpThreat;
    if (procSpellId != null) {
      var spellForHate = getSpellFromLocalData(procSpellId);
      if (spellForHate && spellForHate.bonusHate != null && spellForHate.bonusHate !== 0) procSpellBonusHate = spellForHate.bonusHate;
      if (spellForHate && spellForHate.nonDamagingDetrimental) procSpellNonDamagingDetrimental = true;
      if (spellForHate && spellForHate.ccAddsMobHpThreat) procSpellCcAddsMobHpThreat = true;
    }

    var itemTypeNumVal = !isNaN(itemTypeNum) ? itemTypeNum : null;
    var itemClasses = getItemClasses(item);
    var itemIdVal = (typeof itemId === 'number' && !isNaN(itemId) && itemId > 0) ? itemId : null;
    var offhandBlocked = !!(itemTypeNumVal != null && OFFHAND_BLOCKED_ITEM_TYPES[itemTypeNumVal]);
    if (!offhandBlocked && finalType && finalType !== 'undefined' && OFFHAND_BLOCKED_TYPE_STRINGS[finalType]) {
      offhandBlocked = true;
    }
    var out = {
      name: name || 'Unknown',
      damage: damage,
      delay: delay,
      is2H: is2H,
      type: finalType,
      itemTypeNum: itemTypeNumVal,
      offhandBlocked: offhandBlocked,
      proc: procName || '',
      procDamage: procDamage,
      procRate: procRate,
      procSpellId: procSpellId != null ? procSpellId : undefined,
      elemType: elemType || '',
      elemDamage: elemDamage,
      baneDamage: baneDamage,
      baneDamageRace: baneDamageRace,
      baneDamageBody: baneDamageBody,
      icon: icon > 0 ? icon : null,
      slots: slots,
      classes: itemClasses,
      backstabModPercent: backstabModPercent,
      archeryModPercent: archeryModPercent != null ? archeryModPercent : undefined,
      itemId: itemIdVal
    };
    if (procSpellBonusHate != null) out.procSpellBonusHate = procSpellBonusHate;
    if (procSpellNonDamagingDetrimental) out.procSpellNonDamagingDetrimental = true;
    if (procSpellCcAddsMobHpThreat) out.procSpellCcAddsMobHpThreat = true;

    return out;
  }

  /**
   * Search for items and return normalized weapon objects (for dropdown/autopopulate).
   * When classId is provided, only items usable by that class (per classes bitmask) are returned.
   * @param {string} nameFilter - Search string.
   * @param {string} [classId] - Selected class (e.g. 'warrior', 'cleric'); filters by item classes bitmask.
   * @returns {Promise<Array<Object>>} Resolves to array of normalized weapons.
   */
  function getItemName(item) {
    if (!item || typeof item !== 'object') return '';
    var v = item.name || item.Name || item.item_name || item.itemName;
    return (v != null ? String(v) : '').trim();
  }

  function searchWeapons(nameFilter, classId) {
    if (localSearchOnly) {
      return Promise.resolve([]);
    }
    var q = (nameFilter != null ? String(nameFilter) : '').trim().toLowerCase();
    return searchItems(nameFilter).then(function (items) {
      if (q) {
        items = items.filter(function (item) {
          var name = getItemName(item).toLowerCase();
          return name.indexOf(q) >= 0;
        });
      }
      var mask = classId ? CLASS_BITMASK[classId] : 0;
      if (mask) {
        items = items.filter(function (item) {
          var c = getItemClasses(item);
          return c == null || (c & mask) !== 0;
        });
      }
      return items.map(normalizeItemForWeapon).filter(Boolean);
    });
  }

  /**
   * Return true if normalized weapon is usable by the given class (or if weapon has no classes bitmask).
   * @param {Object} weapon - Normalized weapon (with optional .classes number).
   * @param {string} classId - e.g. 'warrior', 'cleric'.
   * @returns {boolean}
   */
  function itemMatchesClass(weapon, classId) {
    if (!weapon) return false;
    if (weapon.classes == null || weapon.classes === undefined) return true;
    if (!classId) return true;
    var mask = CLASS_BITMASK[classId];
    return mask != null && (weapon.classes & mask) !== 0;
  }

  /**
   * Return true if normalized weapon has the given slot bit set (or if slots is unknown).
   * @param {Object} weapon - Normalized weapon (with optional .slots number).
   * @param {number} slotMask - One of SLOT_PRIMARY, SLOT_SECONDARY, SLOT_RANGED, SLOT_AMMO.
   * @returns {boolean}
   */
  function itemMatchesSlot(weapon, slotMask) {
    if (!weapon) return false;
    if (weapon.slots == null || weapon.slots === undefined) return true;
    return (weapon.slots & slotMask) !== 0;
  }

  global.ItemSearch = {
    setConfig: setItemSearchConfig,
    setLocalSearchOnlyMode: setLocalSearchOnlyMode,
    setSpellData: setSpellData,
    getSpellFromLocalData: getSpellFromLocalData,
    searchItems: searchItems,
    searchWeapons: searchWeapons,
    normalizeItemForWeapon: normalizeItemForWeapon,
    getSearchRequest: getSearchRequest,
    fetchSpellById: fetchSpellById,
    fetchSpellFromPqdi: fetchSpellFromPqdi,
    itemMatchesSlot: itemMatchesSlot,
    itemMatchesClass: itemMatchesClass,
    CLASS_BITMASK: CLASS_BITMASK,
    SLOT_PRIMARY: SLOT_PRIMARY,
    SLOT_SECONDARY: SLOT_SECONDARY,
    SLOT_RANGED: SLOT_RANGED,
    SLOT_AMMO: SLOT_AMMO
  };
})(typeof self !== 'undefined' ? self : this);
