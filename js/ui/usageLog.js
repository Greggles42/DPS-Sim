/**
 * Usage logging for gSim.
 * Sends enhanced simulation telemetry to the logging endpoint.
 * Captures all inputs used for a simulation run, not just outputs.
 */
(function (global) {
  'use strict';

  var LOG_VERSION = '1.08';

  /**
   * Generate or retrieve a persistent anonymous user ID.
   * @returns {string}
   */
  function getOrCreateUID() {
    try {
      var key = 'gsim_uid';
      var uid = localStorage.getItem(key);
      if (!uid) {
        uid = 'u_' + Math.random().toString(36).slice(2) + '_' + Date.now().toString(36);
        localStorage.setItem(key, uid);
      }
      return uid;
    } catch (e) {
      return 'anonymous';
    }
  }

  /**
   * Build an enhanced log payload capturing all simulation inputs and outputs.
   *
   * @param {Object} p
   * @param {string} p.simMode - 'dps' | 'ranged' | 'tanking'
   * @param {string} p.eraId - selected era id
   * @param {string} p.classId
   * @param {number} p.level
   * @param {number} p.str
   * @param {number} p.dex
   * @param {number} p.offenseSkill
   * @param {number} p.defenseSkill
   * @param {number} p.doubleAttackSkill
   * @param {number} p.dualWieldSkill
   * @param {number} p.wornHaste
   * @param {number} p.spellHaste
   * @param {number} p.wornAttack
   * @param {number} p.spellAttack
   * @param {string} p.targetLabel
   * @param {number} p.mobLevel
   * @param {number} p.targetAC
   * @param {number} p.targetHP
   * @param {number} p.targetBodyType
   * @param {Object} p.targetResists - { fr, cr, pr, dr, mr }
   * @param {Object} p.w1 - { name, damage, delay, is2H, expansion }
   * @param {Object} [p.w2]
   * @param {Array}  p.aaEnabled - array of AA id strings that are active
   * @param {Object} p.disciplines - { duelist, innerFlame }
   * @param {boolean} p.specialAttacks
   * @param {boolean} p.fistweaving
   * @param {number} p.durationSec
   * @param {number} p.runs
   * @param {number} p.totalDamage
   * @param {number} p.dps
   * @param {number} [p.tps]
   * @param {number} [p.dtps] - populated for tanking mode
   * @param {string} [p.logUrl] - endpoint URL; if empty, logging is disabled
   */
  function buildPayload(p) {
    return {
      event: 'sim_run',
      v: LOG_VERSION,
      uid: getOrCreateUID(),
      ts: Date.now(),

      // Mode
      simMode: p.simMode || 'dps',
      era: p.eraId || 'classic',

      // Character
      classId: p.classId || '',
      level: p.level || 60,
      str: p.str || 0,
      dex: p.dex || 0,

      // Skills
      offenseSkill: p.offenseSkill || 0,
      defenseSkill: p.defenseSkill || 0,
      doubleAttackSkill: p.doubleAttackSkill || 0,
      dualWieldSkill: p.dualWieldSkill || 0,

      // Attack / Haste
      wornHaste: p.wornHaste || 0,
      spellHaste: p.spellHaste || 0,
      wornAttack: p.wornAttack || 0,
      spellAttack: p.spellAttack || 0,

      // Target
      targetLabel: p.targetLabel || '',
      mobLevel: p.mobLevel || 60,
      targetAC: p.targetAC || 0,
      targetHP: p.targetHP || 0,
      targetBodyType: p.targetBodyType || 0,
      targetResists: p.targetResists || {},

      // Weapons
      w1: p.w1 || null,
      w2: p.w2 || null,

      // Active AAs
      aaEnabled: p.aaEnabled || [],

      // Disciplines
      disciplines: p.disciplines || {},

      // Features used
      specialAttacks: !!p.specialAttacks,
      fistweaving: !!p.fistweaving,

      // Run config
      durationSec: p.durationSec || 60,
      runs: p.runs || 1,

      // Outputs
      totalDamage: p.totalDamage || 0,
      dps: p.dps || 0,
      tps: p.tps || null,
      dtps: p.dtps || null
    };
  }

  /**
   * Send a simulation log event.
   * @param {Object} payload - from buildPayload()
   * @param {string} logUrl - endpoint URL (empty to skip)
   */
  function sendLog(payload, logUrl) {
    if (!logUrl) return;
    try {
      fetch(logUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true
      }).catch(function () {}); // Ignore errors silently
    } catch (e) {}
  }

  global.UsageLog = {
    buildPayload: buildPayload,
    sendLog: sendLog,
    getOrCreateUID: getOrCreateUID,
    LOG_VERSION: LOG_VERSION
  };
})(typeof self !== 'undefined' ? self : this);
