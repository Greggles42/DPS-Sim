/**
 * Era configuration for gSim.
 * Defines expansion eras, their feature gates, and item/ability availability.
 * Each era is additive — later eras include all earlier features.
 */
(function (global) {
  'use strict';

  const ERAS = [
    {
      id: 'classic',
      label: 'Classic',
      order: 0,
      hasAA: false,
      hasLuclinItems: false,
      hasPopItems: false,
      description: 'Original EverQuest (1999). No Alternate Advancement abilities.'
    },
    {
      id: 'kunark',
      label: 'Kunark',
      order: 1,
      hasAA: false,
      hasLuclinItems: false,
      hasPopItems: false,
      description: 'Ruins of Kunark (2000). No Alternate Advancement abilities.'
    },
    {
      id: 'velious',
      label: 'Velious',
      order: 2,
      hasAA: false,
      hasLuclinItems: false,
      hasPopItems: false,
      description: 'Scars of Velious (2001). No Alternate Advancement abilities.'
    },
    {
      id: 'luclin',
      label: 'Luclin',
      order: 3,
      hasAA: true,
      hasLuclinItems: true,
      hasPopItems: false,
      description: 'Shadows of Luclin (2001). Alternate Advancement system introduced. Beastlord class added.'
    },
    {
      id: 'pop',
      label: 'Planes of Power',
      order: 4,
      hasAA: true,
      hasLuclinItems: true,
      hasPopItems: true,
      description: 'Planes of Power (2002). Additional AAs including Trueshot Discipline for Rangers.'
    }
  ];

  /**
   * Get era definition by id.
   * @param {string} eraId
   * @returns {Object|null}
   */
  function getEra(eraId) {
    return ERAS.find(function (e) { return e.id === eraId; }) || null;
  }

  /**
   * Check if a given expansion tag is available in the selected era.
   * expansion: 'classic' | 'kunark' | 'velious' | 'luclin' | 'pop'
   * @param {string} itemExpansion - the item/feature expansion tag
   * @param {string} selectedEraId - the currently selected era
   * @returns {boolean}
   */
  function isAvailableInEra(itemExpansion, selectedEraId) {
    const item = getEra(itemExpansion);
    const selected = getEra(selectedEraId);
    if (!item || !selected) return true; // unknown = allow
    return item.order <= selected.order;
  }

  /**
   * Whether AAs are available in the given era.
   * @param {string} eraId
   * @returns {boolean}
   */
  function erasHasAA(eraId) {
    const era = getEra(eraId);
    return era ? era.hasAA : false;
  }

  /**
   * Whether the Beastlord class is available in the given era.
   * @param {string} eraId
   * @returns {boolean}
   */
  function eraHasBeastlord(eraId) {
    const era = getEra(eraId);
    return era ? era.order >= 3 : false; // Luclin+
  }

  /**
   * Character level cap for the given era. 60 through Luclin, 65 from Planes of Power on.
   * @param {string} eraId
   * @returns {number}
   */
  function getMaxLevel(eraId) {
    const era = getEra(eraId);
    return (era && era.id === 'pop') ? 65 : 60;
  }

  /**
   * Approximate EQEmu item ID ranges by expansion.
   * Used to determine era availability when an item lacks an explicit `expansion` field.
   */
  const ITEM_ID_ERA_RANGES = [
    { era: 'classic', min: 1,     max: 9999  },
    { era: 'kunark',  min: 10000, max: 19999 },
    { era: 'velious', min: 20000, max: 29999 },
    { era: 'luclin',  min: 30000, max: 65534 },
    { era: 'pop',     min: 65535, max: Infinity }
  ];

  /**
   * Return the era string for a numeric item ID based on ID ranges.
   * @param {number|string} itemId
   * @returns {string} era id ('classic' | 'kunark' | 'velious' | 'luclin' | 'pop')
   */
  function getItemEraById(itemId) {
    var id = parseInt(itemId, 10);
    if (isNaN(id)) return 'classic';
    for (var i = ITEM_ID_ERA_RANGES.length - 1; i >= 0; i--) {
      var r = ITEM_ID_ERA_RANGES[i];
      if (id >= r.min && id <= r.max) return r.era;
    }
    return 'classic';
  }

  /**
   * Check if an item (identified by its numeric ID) is available in the selected era.
   * Uses ITEM_ID_ERA_RANGES for era detection.
   * @param {number|string} itemId
   * @param {string} selectedEraId
   * @returns {boolean}
   */
  function isItemIdAvailableInEra(itemId, selectedEraId) {
    var itemEra = getItemEraById(itemId);
    return isAvailableInEra(itemEra, selectedEraId);
  }

  global.EraConfig = {
    ERAS: ERAS,
    ITEM_ID_ERA_RANGES: ITEM_ID_ERA_RANGES,
    getEra: getEra,
    getItemEraById: getItemEraById,
    isAvailableInEra: isAvailableInEra,
    isItemIdAvailableInEra: isItemIdAvailableInEra,
    erasHasAA: erasHasAA,
    eraHasBeastlord: eraHasBeastlord,
    getMaxLevel: getMaxLevel
  };
})(typeof self !== 'undefined' ? self : this);
