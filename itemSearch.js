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
  function setItemSearchConfig(opts) {
    if (!opts) return;
    if (typeof opts.baseUrl === 'string') config.baseUrl = opts.baseUrl;
    if (typeof opts.apiKey === 'string') config.apiKey = opts.apiKey;
    if (typeof opts.proxyUrl === 'string') config.proxyUrl = opts.proxyUrl;
    var spellUrl = opts.spellBaseUrl || opts.spellbaseUrl;
    if (typeof spellUrl === 'string') config.spellBaseUrl = spellUrl;
    config.configApplied = true;
  }

  /**
   * Set local spell data (object keyed by spell ID, e.g. from resources/spells_en.json).
   * When set, fetchSpellById uses this for proc spell name and damage instead of dndquarm/PQDI.
   * @param {Object} data - e.g. { "1790": { name: "Feast of Blood", effect_base_value5: -30, buffduration: "3" }, ... }
   */
  function setSpellData(data) {
    spellData = data && typeof data === 'object' ? data : null;
  }

  /** EQEmu: Spell Effect 0 = SE_CurrentHP (hit points); negative base value = damage. */
  var SE_CURRENT_HP = 0;
  /** EQEmu: buffdurationformula 0 = instant (not a buff). */
  var BUFF_DURATION_FORMULA_INSTANT = 0;

  /**
   * Get spell name and damage from local spell data (spells_en.json / EQEmu spells_new format).
   * Uses EQEmu semantics: only slots with effectid 0 (SE_CurrentHP) count as HP damage; negative
   * base value = damage. If maxN (or effect_limit_valueN when maxN is absent) is greater than
   * |effect_base_valueN|, that limit is used as the damage (or per-tick) value. Instant spells (buffdurationformula 0) use base value once;
   * DoTs use per-tick * buffduration (ticks).
   * @param {number|string} spellId - Spell ID.
   * @returns {{ name: string, damage?: number }|null}
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
    for (var i = 1; i <= 12; i++) {
      var eid = spell['effectid' + i];
      if (eid === undefined || eid === null) continue;
      var effectId = typeof eid === 'number' ? eid : parseInt(String(eid), 10);
      if (effectId !== SE_CURRENT_HP) continue;
      var v = spell['effect_base_value' + i];
      if (v === undefined || v === null) continue;
      var n = typeof v === 'number' ? v : parseInt(v, 10);
      if (isNaN(n) || n >= 0) continue;
      var absVal = -n;
      var maxV = spell['max' + i];
      if (maxV === undefined || maxV === null) maxV = spell['effect_limit_value' + i];
      if (maxV !== undefined && maxV !== null) {
        var maxNum = typeof maxV === 'number' ? maxV : parseInt(String(maxV), 10);
        if (!isNaN(maxNum) && maxNum > absVal) absVal = maxNum;
      }
      if (isInstant)
        totalDirect += absVal;
      else if (absVal > perTickDamage)
        perTickDamage = absVal;
    }
    var damage;
    if (isInstant)
      damage = totalDirect > 0 ? totalDirect : undefined;
    else
      damage = perTickDamage > 0 ? perTickDamage * ticks : undefined;
    return { name: name, damage: damage };
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

  /**
   * Perform a GET search and return raw JSON.
   * No request is made until itemSearchConfig.js has run and called setConfig().
   * @param {string} nameFilter - Search string.
   * @returns {Promise<Array>} Resolves to array of items from API (or [] on error / if config not applied).
   */
  function searchItems(nameFilter) {
    if (!config.configApplied) {
      console.warn('ItemSearch: Set config before searching (itemSearchConfig.js locally or proxy on Vercel).');
      return Promise.resolve([]);
    }
    var req = getSearchRequest(nameFilter);
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
      .then(function (data) {
        if (Array.isArray(data)) return data;
        if (data && Array.isArray(data.items)) return data.items;
        if (data && Array.isArray(data.results)) return data.results;
        if (data && typeof data === 'object') return [data];
        return [];
      })
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

  /** Item IDs that are h2h but API may return as 1hb (e.g. Gharn's Rock, Mithril Ulak). Override type to h2h. Empty if not used. */
  var H2H_OVERRIDE_IDS = {};

  /** Item types that cannot be used in offhand (2HS, 2HB, bow, throwing, 2HP). */
  var OFFHAND_BLOCKED_ITEM_TYPES = { 1: true, 4: true, 5: true, 6: true, 35: true };

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
    var itemType = '';
    var is2H = false;
    if (!isNaN(itemTypeNum) && ITEM_TYPE_NUM_TO_TYPE[itemTypeNum] !== undefined) {
      itemType = ITEM_TYPE_NUM_TO_TYPE[itemTypeNum];
      is2H = !!TWO_HAND_TYPES[itemType];
    } else {
      itemType = str(get(item, ['type', 'Type', 'slot', 'Slot'])).toLowerCase();
      is2H = itemType ? !!TWO_HAND_TYPES[itemType] : !!get(item, ['is2H', 'isTwoHand', 'twoHanded']);
    }

    /* procEffect / proceffect = spell ID invoked by the proc; we use it to get spell name and damage from spells_en.json. */
    var procSpellId = null;
    var procEffectRaw = get(item, ['procEffect', 'proceffect', 'proc_effect', 'ProcEffect', 'Proceffect', 'procSpellId', 'proc_spell_id', 'procSpellId']);
    if (procEffectRaw === undefined || procEffectRaw === null) {
      for (var key in item) {
        if (item.hasOwnProperty(key) && /^proc.*effect|proceffect$/i.test(String(key).replace(/_/g, ''))) {
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

    var eleDmgTypeNum = num(get(item, ['eleDmgType', 'elemType', 'elem_type']));
    var elemType = '';
    if (typeof eleDmgTypeNum === 'number' && ELE_DMG_TYPE_NUM[eleDmgTypeNum]) {
      elemType = ELE_DMG_TYPE_NUM[eleDmgTypeNum];
    } else {
      elemType = str(get(item, ['eleDmgType', 'elemType', 'elem_type', 'element', 'Element', 'magic', 'Magic'])).toLowerCase();
      if (elemType && !['fire', 'cold', 'poison', 'disease', 'magic'].includes(elemType)) {
        var elemMap = { 'fr': 'fire', 'cr': 'cold', 'pr': 'poison', 'dr': 'disease', 'mr': 'magic' };
        elemType = elemMap[elemType] || elemType;
      }
    }
    var elemDamage = num(get(item, ['eleDmgAmt', 'elemDamage', 'elem_damage', 'elementalDamage', 'ElementalDamage', 'elemental_damage']));

    var baneDamage = num(get(item, ['baneDmgAmt', 'baneDamage', 'bane_damage', 'BaneDamage', 'bane']));

    /* Skillmod type 8 = backstab; skillmodvalue is the backstab skill % modifier */
    var backstabModPercent = null;
    var skillmodTypeRaw = get(item, ['skillmodType', 'skillmod_type', 'SkillmodType']);
    var skillmodType = (typeof skillmodTypeRaw === 'number') ? skillmodTypeRaw : parseInt(skillmodTypeRaw, 10);
    if (skillmodType === 8) {
      var skillmodValRaw = get(item, ['skillmodValue', 'skillmod_value', 'SkillmodValue']);
      var skillmodVal = (typeof skillmodValRaw === 'number') ? skillmodValRaw : parseInt(skillmodValRaw, 10);
      if (!isNaN(skillmodVal)) backstabModPercent = skillmodVal;
    }
    var skillmodArr = get(item, ['skillmod', 'skillmods', 'SkillMod']);
    if (backstabModPercent == null && Array.isArray(skillmodArr)) {
      for (var i = 0; i < skillmodArr.length; i++) {
        var mod = skillmodArr[i];
        if (!mod || typeof mod !== 'object') continue;
        var modType = (typeof mod.type === 'number') ? mod.type : parseInt(mod.type, 10);
        if (modType === 8) {
          var modVal = (typeof mod.value === 'number') ? mod.value : parseInt(mod.value, 10);
          if (!isNaN(modVal)) { backstabModPercent = modVal; break; }
        }
        modType = (typeof mod.skillmodType === 'number') ? mod.skillmodType : parseInt(mod.skillmodType, 10);
        if (modType === 8) {
          modVal = (typeof mod.skillmodValue === 'number') ? mod.skillmodValue : parseInt(mod.skillmodValue, 10);
          if (!isNaN(modVal)) { backstabModPercent = modVal; break; }
        }
      }
    }

    var icon = num(get(item, ['icon', 'Icon', 'iconId', 'icon_id']));

    var slotsRaw = get(item, ['slots', 'Slots', 'slot', 'Slot']);
    var slots = (typeof slotsRaw === 'number' && !isNaN(slotsRaw)) ? slotsRaw : parseInt(slotsRaw, 10);
    if (isNaN(slots)) slots = null;

    var itemId = num(get(item, ['id', 'Id', 'item_id', 'itemId']));
    var finalType = itemType || 'undefined';
    // H2H override disabled for now: if (itemId && H2H_OVERRIDE_IDS[itemId]) finalType = 'h2h';

    var itemTypeNumVal = !isNaN(itemTypeNum) ? itemTypeNum : null;
    var out = {
      name: name || 'Unknown',
      damage: damage,
      delay: delay,
      is2H: is2H,
      type: finalType,
      itemTypeNum: itemTypeNumVal,
      offhandBlocked: !!(itemTypeNumVal != null && OFFHAND_BLOCKED_ITEM_TYPES[itemTypeNumVal]),
      proc: procName || '',
      procDamage: procDamage,
      procSpellId: procSpellId != null ? procSpellId : undefined,
      elemType: elemType || '',
      elemDamage: elemDamage,
      baneDamage: baneDamage,
      icon: icon > 0 ? icon : null,
      slots: slots,
      backstabModPercent: backstabModPercent
    };

    return out;
  }

  /**
   * Search for items and return normalized weapon objects (for dropdown/autopopulate).
   * @param {string} nameFilter - Search string.
   * @returns {Promise<Array<Object>>} Resolves to array of normalized weapons.
   */
  function searchWeapons(nameFilter) {
    return searchItems(nameFilter).then(function (items) {
      return items.map(normalizeItemForWeapon).filter(Boolean);
    });
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
    setSpellData: setSpellData,
    getSpellFromLocalData: getSpellFromLocalData,
    searchItems: searchItems,
    searchWeapons: searchWeapons,
    normalizeItemForWeapon: normalizeItemForWeapon,
    getSearchRequest: getSearchRequest,
    fetchSpellById: fetchSpellById,
    fetchSpellFromPqdi: fetchSpellFromPqdi,
    itemMatchesSlot: itemMatchesSlot,
    SLOT_PRIMARY: SLOT_PRIMARY,
    SLOT_SECONDARY: SLOT_SECONDARY,
    SLOT_RANGED: SLOT_RANGED,
    SLOT_AMMO: SLOT_AMMO
  };
})(typeof self !== 'undefined' ? self : this);
