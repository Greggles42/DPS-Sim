/**
 * Character-card "mod2" item stat inputs (Quarm Nov 2026 patch).
 * Inventory import fills the inputs from equipped gear (capped totals); once the user edits a field it is
 * left alone until they press "Reset to equipped". window.gearMod2 always mirrors the (clamped) inputs and is
 * what the melee/ranged/tanking sims read.
 */
(function (global) {
  'use strict';
  var KEYS = ['strikethrough', 'accuracy', 'combateffects', 'avoidance', 'spellshield', 'shielding', 'stunresist', 'damageshield'];
  var CAPS = { strikethrough: 35, stunresist: 35, combateffects: 100, accuracy: 150, avoidance: 100, spellshield: 35, shielding: 35, damageshield: 30 };
  var LABELS = { strikethrough: 'Strikethrough', stunresist: 'Stun Resist', combateffects: 'Combat Effects', accuracy: 'Accuracy', avoidance: 'Avoidance', spellshield: 'Spell Shield', shielding: 'Shielding', damageshield: 'Damage Shield' };

  var userSet = {};   // key -> true once the user typed a value
  var equipped = {};  // key -> capped total from the last inventory import

  function el(key) { return document.getElementById('mod2-' + key); }

  function readInputs() {
    var out = {};
    KEYS.forEach(function (k) {
      var e = el(k);
      var v = e ? parseInt(e.value, 10) : 0;
      if (isNaN(v) || v < 0) v = 0;
      out[k] = Math.min(v, CAPS[k]);
    });
    return out;
  }

  /** Values as typed (non-negative), before clamping. */
  function readRaw() {
    var out = {};
    KEYS.forEach(function (k) {
      var e = el(k);
      var v = e ? parseInt(e.value, 10) : 0;
      out[k] = (isNaN(v) || v < 0) ? 0 : v;
    });
    return out;
  }

  /** [{key,label,value,cap}] for every input typed above its cap. */
  function getOvercap() {
    var raw = readRaw();
    return KEYS.filter(function (k) { return raw[k] > CAPS[k]; })
      .map(function (k) { return { key: k, label: LABELS[k], value: raw[k], cap: CAPS[k] }; });
  }

  function sync() {
    global.gearMod2 = readInputs();
    var btn = document.getElementById('mod2-reset');
    if (btn) {
      var raw = readRaw();
      var differs = KEYS.some(function (k) { return userSet[k] && (raw[k] !== (equipped[k] || 0)); });
      btn.style.display = differs ? '' : 'none';
    }
  }

  /** Called by Import Inventory with the capped equipped totals. Fields the user overrode are kept. */
  function setFromGear(capped) {
    equipped = {};
    KEYS.forEach(function (k) {
      equipped[k] = (capped && capped[k]) || 0;
      var e = el(k);
      if (e && !userSet[k]) e.value = equipped[k];
    });
    sync();
  }

  function reset() {
    userSet = {};
    KEYS.forEach(function (k) { var e = el(k); if (e) e.value = equipped[k] || 0; });
    sync();
  }

  function init() {
    KEYS.forEach(function (k) {
      var e = el(k);
      if (!e) return;
      e.addEventListener('input', function () { userSet[k] = true; sync(); });
      // Overcap entries are kept as typed (so the sim alert can report them) and clamped only when used.
      e.addEventListener('change', function () {
        userSet[k] = true;
        var v = parseInt(e.value, 10);
        if (isNaN(v) || v < 0) v = 0;
        e.value = v;
        sync();
      });
    });
    var btn = document.getElementById('mod2-reset');
    if (btn) btn.addEventListener('click', reset);
    sync();
  }

  global.Mod2Inputs = { KEYS: KEYS, CAPS: CAPS, LABELS: LABELS, read: readInputs, readRaw: readRaw, getOvercap: getOvercap, setFromGear: setFromGear, reset: reset, sync: sync };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})(typeof self !== 'undefined' ? self : this);
