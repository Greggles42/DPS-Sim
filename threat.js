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
   * Direct-damage spell / proc hate from the spell's base damage (uncapped pre-resist value; ignores resists, crits, foci).
   * @param {number} baseSpellDamage - Listed / rolled base proc damage before resists and SCF crit.
   * @param {number} [cap=400] - Max hate from this proc event.
   */
  function procSpellThreatFromDamage(baseSpellDamage, cap) {
    const c = cap != null && cap > 0 ? cap : 400;
    const a = baseSpellDamage != null ? baseSpellDamage | 0 : 0;
    return Math.min(Math.max(0, a), c);
  }

  /**
   * Detrimental spell with no HP damage component: standard hate = maxHP/15, capped 1200, minimum 25.
   * @param {number} maxHp - Target mob max hit points.
   */
  function detrimentalNonDamageSpellThreat(maxHp) {
    const hp = maxHp != null ? maxHp | 0 : 0;
    if (hp <= 0) return 0;
    const raw = Math.floor(hp / 15);
    return Math.min(1200, Math.max(25, raw));
  }

  /** Generic mob HP when no npc_types hp is selected: level 60 = 22105 (e.g. Shik`nar Warrior), scaled by mob level. */
  function genericMobMaxHpForLevel(mobLevel) {
    const L = mobLevel != null ? Math.min(70, Math.max(1, mobLevel | 0)) : 60;
    return Math.floor(22105 * L / 60);
  }

  /** Flat hate from spell effects (SE 92): effect_base_value adds or subtracts hate directly (e.g. +50 or -300). */
  function procFlatHate(amount) {
    return amount != null ? amount | 0 : 0;
  }

  /**
   * Self-cast rune proc hate (EQMacEmu: beneficial absorb proc generates hate = runeValue * 2).
   * Modified by hate mod focus effects/AAs (hateModPercent), then capped if player cannot natively cast the spell.
   * Witness check (50% chance NOT to register) is applied by the caller, not here.
   * @param {number} runeValue - Absorb amount from effect slot 0 (effectid1 base value).
   * @param {number} [hateModPercent=0] - Worn/spell/AA hate modifier percentage (e.g. 20 = +20%).
   * @param {number|null} [cap=null] - Max hate (400 if player cannot cast the spell; null = no cap).
   */
  function selfCastRuneHate(runeValue, hateModPercent, cap) {
    const rv = runeValue != null ? runeValue | 0 : 0;
    if (rv <= 0) return 0;
    const mod = (hateModPercent != null && !isNaN(hateModPercent)) ? hateModPercent : 0;
    let hate = Math.floor(rv * 2 * (100 + mod) / 100);
    if (cap != null && cap > 0 && hate > cap) hate = cap;
    return hate;
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
    procFlatHate: procFlatHate,
    rangedSwingThreat: rangedSwingThreat,
    detrimentalNonDamageSpellThreat: detrimentalNonDamageSpellThreat,
    genericMobMaxHpForLevel: genericMobMaxHpForLevel,
    selfCastRuneHate: selfCastRuneHate
  };
})(typeof self !== 'undefined' ? self : this);
