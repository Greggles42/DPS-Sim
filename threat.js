/**
 * Threat / hate helpers aligned with EQMacEmu concepts (see zone/attack.cpp melee swing hate,
 * spell proc aggro caps). Used by combat.js for TPS; not the same as damage.
 */
(function (global) {
  'use strict';

  /** Primary-hand melee swing hate before damage roll: baseDamage + damageBonus (EQMacEmu Client::Attack). */
  function meleeSwingThreatPrimary(baseDamage, damageBonus) {
    const b = baseDamage != null ? baseDamage | 0 : 0;
    const d = damageBonus != null ? damageBonus | 0 : 0;
    return Math.max(0, b + d);
  }

  /** Offhand swing: weapon base only (no main-hand damage bonus on secondary slot in classic model). */
  function meleeSwingThreatOffhand(baseDamage) {
    const b = baseDamage != null ? baseDamage | 0 : 0;
    return Math.max(0, b);
  }

  /**
   * Direct-damage spell / proc hate from actual damage dealt (capped; see server spell aggro tuning).
   * @param {number} actualDamage - Damage after resists / SCF.
   * @param {number} [cap=400] - Max hate from this proc event.
   */
  function procSpellThreatFromDamage(actualDamage, cap) {
    const c = cap != null && cap > 0 ? cap : 400;
    const a = actualDamage != null ? actualDamage | 0 : 0;
    return Math.min(Math.max(0, a), c);
  }

  /** Bow shot: approximate swing hate from weapon + ammo displayed base damage. */
  function rangedSwingThreat(bowDamage, arrowDamage) {
    const b = bowDamage != null ? bowDamage | 0 : 0;
    const a = arrowDamage != null ? arrowDamage | 0 : 0;
    return Math.max(0, b + a);
  }

  global.EQThreat = {
    meleeSwingThreatPrimary: meleeSwingThreatPrimary,
    meleeSwingThreatOffhand: meleeSwingThreatOffhand,
    procSpellThreatFromDamage: procSpellThreatFromDamage,
    rangedSwingThreat: rangedSwingThreat
  };
})(typeof self !== 'undefined' ? self : this);
