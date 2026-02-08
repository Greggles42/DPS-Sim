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
    apiKey: null,  // Set only by itemSearchConfig.js via setConfig()
    configApplied: false  // Set true when setConfig() has been called (itemSearchConfig.js must load before search)
  };

  /**
   * Configure the item search API. Must be called by itemSearchConfig.js (before any search) to set baseUrl and apiKey.
   * @param {Object} opts
   * @param {string} [opts.baseUrl] - Base URL for search (default: QuarmData search endpoint).
   * @param {string} [opts.apiKey] - API key from itemSearchConfig.js (sent as Bearer token on each request).
   */
  function setItemSearchConfig(opts) {
    if (opts && typeof opts.baseUrl === 'string') config.baseUrl = opts.baseUrl;
    if (opts && typeof opts.apiKey === 'string') config.apiKey = opts.apiKey;
    config.configApplied = true;
  }

  /**
   * Build search URL and headers. API key from itemSearchConfig.js is sent as Bearer token when set.
   * @param {string} nameFilter - Search string (e.g. weapon name).
   * @returns {{ url: string, headers: Object }}
   */
  function getSearchRequest(nameFilter) {
    var encoded = encodeURIComponent(nameFilter || '');
    var url = config.baseUrl.replace(/\?.*$/, '') + '?nameFilter=' + encoded;
    var headers = { 'Accept': 'application/json' };
    if (config.apiKey) headers['Authorization'] = 'Bearer ' + config.apiKey;
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
      console.warn('ItemSearch: Load itemSearchConfig.js and call ItemSearch.setConfig() before searching.');
      return Promise.resolve([]);
    }
    var req = getSearchRequest(nameFilter);
    return fetch(req.url, { method: 'GET', headers: req.headers })
      .then(function (res) {
        if (!res.ok) throw new Error('Item search failed: ' + res.status + ' ' + res.statusText);
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
        console.error('Item search error:', err);
        return [];
      });
  }

  /**
   * Two-hand weapon types (EQ slot/type strings). Adjust if your API uses different values.
   */
  var TWO_HAND_TYPES = { '2hb': true, '2hs': true, '2hp': true, 'bow': true };

  /**
   * Map API item to the weapon shape used by DPS-Sim presets and getWeapon().
   * API fields: name, damage, delay, baneDmgAmt, eleDmgType, eleDmgAmt (plus type/slot for 1h vs 2h, proc if present).
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
    var itemType = str(get(item, ['type', 'Type', 'item_type', 'itemType', 'slot', 'Slot'])).toLowerCase();
    var is2H = itemType ? !!TWO_HAND_TYPES[itemType] : !!get(item, ['is2H', 'isTwoHand', 'twoHanded']);

    var procName = str(get(item, ['proc', 'Proc', 'proc_name', 'procName', 'proceffect', 'ProcEffect']));
    var procDamage = num(get(item, ['procDamage', 'proc_damage', 'ProcDamage', 'procdamage']));

    // API: eleDmgType, eleDmgAmt
    var elemType = str(get(item, ['eleDmgType', 'elemType', 'elem_type', 'element', 'Element', 'magic', 'Magic'])).toLowerCase();
    if (elemType && !['fire', 'cold', 'poison', 'disease', 'magic'].includes(elemType)) {
      var elemMap = { 'fr': 'fire', 'cr': 'cold', 'pr': 'poison', 'dr': 'disease', 'mr': 'magic' };
      elemType = elemMap[elemType] || elemType;
    }
    var elemDamage = num(get(item, ['eleDmgAmt', 'elemDamage', 'elem_damage', 'elementalDamage', 'ElementalDamage', 'elemental_damage']));

    // API: baneDmgAmt
    var baneDamage = num(get(item, ['baneDmgAmt', 'baneDamage', 'bane_damage', 'BaneDamage', 'bane']));

    var out = {
      name: name || 'Unknown',
      damage: damage,
      delay: delay,
      is2H: is2H,
      type: itemType || (is2H ? '2hb' : '1hb'),
      proc: procName || '',
      procDamage: procDamage,
      elemType: elemType || '',
      elemDamage: elemDamage,
      baneDamage: baneDamage
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
