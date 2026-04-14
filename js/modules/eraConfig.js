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

  global.EraConfig = {
    ERAS: ERAS,
    getEra: getEra,
    isAvailableInEra: isAvailableInEra,
    erasHasAA: erasHasAA,
    eraHasBeastlord: eraHasBeastlord
  };
})(typeof self !== 'undefined' ? self : this);
