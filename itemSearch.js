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
    configApplied: false
  };

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
    config.configApplied = true;
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
   * Two-hand weapon types (EQ slot/type strings).
   */
  var TWO_HAND_TYPES = { '2hb': true, '2hs': true, '2hp': true, 'bow': true, 'archery': true };

  /**
   * dndquarm API: itemType number -> weapon skill type string.
   * EQ item types: 0=1HS, 1=2HS, 2=1HP, 3=2HP, 4=1HB, 5=2HB, 6=Archery, 7=H2H, etc.
   */
  var ITEM_TYPE_NUM_TO_TYPE = {
    0: '1hs', 1: '2hs', 2: '1hp', 3: '2hp', 4: '1hb', 5: '2hb', 6: 'archery', 7: 'h2h', 45: 'h2h'
  };

  /**
   * dndquarm API: eleDmgType number -> element string (0 = none). 1=magic, 2=fire, 3=cold, 4=poison, 5=disease.
   */
  var ELE_DMG_TYPE_NUM = { 1: 'magic', 2: 'fire', 3: 'cold', 4: 'poison', 5: 'disease' };

  /** Item IDs that are h2h but API may return as 1hb (e.g. Gharn's Rock, Mithril Ulak). Override type to h2h. */
  var H2H_OVERRIDE_IDS = { 31241: true, 26809: true };

  /**
   * Map API item to the weapon shape used by DPS-Sim presets and getWeapon().
   * dndquarm JSON: id, name, damage, delay, baneDmgAmt, eleDmgType, eleDmgAmt, itemType, procEffect, procName (often null).
   *
   * @param {Object} item - Raw item from the API.
   * @returns {Object} Normalized weapon: { name, damage, delay, proc?, procDamage?, elemType?, elemDamage?, baneDamage?, is2H, type }.
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

    var itemTypeNum = get(item, ['itemType', 'item_type', 'ItemType']);
    var itemType = '';
    var is2H = false;
    if (typeof itemTypeNum === 'number' && ITEM_TYPE_NUM_TO_TYPE[itemTypeNum] !== undefined) {
      itemType = ITEM_TYPE_NUM_TO_TYPE[itemTypeNum];
      is2H = !!TWO_HAND_TYPES[itemType];
    } else {
      itemType = str(get(item, ['type', 'Type', 'slot', 'Slot'])).toLowerCase();
      is2H = itemType ? !!TWO_HAND_TYPES[itemType] : !!get(item, ['is2H', 'isTwoHand', 'twoHanded']);
    }

    var procName = str(get(item, ['procEffect', 'procName', 'proc', 'Proc', 'proc_name', 'ProcName', 'proc_effect']));
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

    var icon = num(get(item, ['icon', 'Icon', 'iconId', 'icon_id']));

    var itemId = num(get(item, ['id', 'Id', 'item_id', 'itemId']));
    var finalType = itemType || (is2H ? '2hb' : '1hb');
    if (itemId && H2H_OVERRIDE_IDS[itemId]) finalType = 'h2h';

    var out = {
      name: name || 'Unknown',
      damage: damage,
      delay: delay,
      is2H: is2H,
      type: finalType,
      proc: procName || '',
      procDamage: procDamage,
      elemType: elemType || '',
      elemDamage: elemDamage,
      baneDamage: baneDamage,
      icon: icon > 0 ? icon : null
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

  global.ItemSearch = {
    setConfig: setItemSearchConfig,
    searchItems: searchItems,
    searchWeapons: searchWeapons,
    normalizeItemForWeapon: normalizeItemForWeapon,
    getSearchRequest: getSearchRequest
  };
})(typeof self !== 'undefined' ? self : this);
