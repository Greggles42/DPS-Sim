/**
 * weaponSkillCaps.js
 * Single source of truth: max caps + how to scale by level.
 * Project Quarm / TAKP-like ruleset.
 * Verified against https://www.pqdi.cc/skills (level 60).
 * Load as script; exposes global WeaponSkillCaps.
 */
(function (global) {
  'use strict';

  const SkillCapsSpec = {
    meta: {
      ruleset: 'Project Quarm / TAKP-like',
      levelMin: 1,
      levelMax: 60,
      perLevel: { mul: 5, add: 5 }
    },
    classes: [
      'WAR', 'CLR', 'PAL', 'RNG', 'SHD', 'DRU', 'MNK', 'BRD', 'ROG', 'SHM', 'NEC', 'WIZ', 'MAG', 'ENC', 'BST'
    ],
    skills: [
      '1hb', '1hs', '1hp', '2hb', '2hs', 'h2h', 'archery', 'throwing'
    ],
    maxCaps: {
      // 1H Blunt: WAR  CLR  PAL  RNG  SHD  DRU  MNK  BRD  ROG  SHM  NEC  WIZ  MAG  ENC  BST
      '1hb':      [250, 175, 225, 250, 225, 175, 252, 250, 250, 200, 110, 110, 110, 110, 225],
      // 1H Slashing
      '1hs':      [250,   0, 225, 250, 225, 175,  0,   0, 250,    0,   0,   0,   0,   0,   0],
      // 1H Piercing (Piercing skill)
      '1hp':      [240,   0, 225, 240, 225,   0,  0, 110, 250, 200, 110, 225,   0,   0, 225],
      // 2H Blunt
      '2hb':      [250, 175, 225, 250, 225, 175, 252, 200,   0, 200, 110, 110, 225,   0, 225],
      // 2H Slashing
      '2hs':      [250,   0, 225, 250, 225,   0,   0,   0,   0,   0,   0,   0,   0,   0,   0],
      // Hand to Hand
      'h2h':      [100,  75, 100, 100, 100,  75, 252, 100, 100,  75,  75,  75,  75,  75, 250],
      // Archery
      'archery':  [240,   0, 240,  75, 240,   0,   0,   0, 240,   0,   0,   0,   0,   0,   0],
      // Throwing
      'throwing': [200,   0, 200, 113, 250,   0, 200,  75, 250,   0,   0,   0,   0,   0,   0]
    }
  };

  /** Sim classId (e.g. "warrior", "monk") -> spec class index 0..14 */
  const SIM_CLASS_TO_INDEX = {
    warrior: 0,      cleric: 1,    paladin: 2,    ranger: 3,    shadowknight: 4,
    druid: 5,        monk: 6,      bard: 7,        rogue: 8,     shaman: 9,
    necromancer: 10, wizard: 11,   magician: 12,   enchanter: 13, beastlord: 14
  };

  /**
   * Resolve classId to spec class index.
   * @param {Object} spec - SkillCapsSpec
   * @param {number|string} classId - 0..14, "WAR", or "warrior"
   * @returns {number} 0..14 or -1 if unknown
   */
  function resolveClassIndex(spec, classId) {
    if (typeof classId === 'number') {
      return classId >= 0 && classId < spec.classes.length ? classId : -1;
    }
    const s = String(classId).toLowerCase();
    if (SIM_CLASS_TO_INDEX[s] !== undefined) return SIM_CLASS_TO_INDEX[s];
    const idx = spec.classes.indexOf(String(classId).toUpperCase());
    return idx >= 0 ? idx : -1;
  }

  /**
   * Get weapon skill cap for a class/skill/level.
   * @param {Object} spec - SkillCapsSpec (default: SkillCapsSpec)
   * @param {number|string} classId - class index 0..14, "WAR", or "warrior"
   * @param {string} skillKey - e.g. "1hb", "h2h", "archery"
   * @param {number} level - 1..60
   * @returns {number} Effective cap (min of max cap and level-based progression)
   */
  function getWeaponSkillCap(spec, classId, skillKey, level) {
    spec = spec || SkillCapsSpec;
    const { classes, meta, maxCaps } = spec;

    const clsIndex = resolveClassIndex(spec, classId);
    if (clsIndex < 0) return 0;

    const maxArr = maxCaps[skillKey];
    if (!maxArr) return 0;

    const max = maxArr[clsIndex] != null ? maxArr[clsIndex] : 0;
    if (max <= 0) return 0;

    const lvl = Math.max(meta.levelMin, Math.min(meta.levelMax, level));
    const perLevel = lvl * meta.perLevel.mul + meta.perLevel.add;

    return Math.min(max, perLevel);
  }

  /**
   * Prebuild table: table[skillKey][classIndex][level] => cap.
   * @param {Object} [spec] - defaults to SkillCapsSpec
   * @returns {Object}
   */
  function buildWeaponSkillCapTable(spec) {
    spec = spec || SkillCapsSpec;
    const { meta, classes, skills } = spec;
    const out = {};

    for (let s = 0; s < skills.length; s++) {
      const skillKey = skills[s];
      out[skillKey] = Array.from({ length: classes.length }, function () {
        return new Array(meta.levelMax + 1).fill(0);
      });

      for (let c = 0; c < classes.length; c++) {
        for (let lvl = meta.levelMin; lvl <= meta.levelMax; lvl++) {
          out[skillKey][c][lvl] = getWeaponSkillCap(spec, c, skillKey, lvl);
        }
      }
    }

    return out;
  }

  /**
   * Convenience: get cap using sim classId string and optional weapon type.
   * @param {string} classId - e.g. "monk", "warrior"
   * @param {string} skillKey - e.g. "1hb", "h2h", "archery"
   * @param {number} level - 1..60
   * @param {Object} [spec] - defaults to SkillCapsSpec
   * @returns {number}
   */
  function getCapForSimClass(classId, skillKey, level, spec) {
    return getWeaponSkillCap(spec || SkillCapsSpec, classId, skillKey, level);
  }

  global.WeaponSkillCaps = {
    SkillCapsSpec: SkillCapsSpec,
    getWeaponSkillCap: getWeaponSkillCap,
    buildWeaponSkillCapTable: buildWeaponSkillCapTable,
    getCapForSimClass: getCapForSimClass,
    resolveClassIndex: resolveClassIndex,
    SIM_CLASS_TO_INDEX: SIM_CLASS_TO_INDEX
  };
})(typeof self !== 'undefined' ? self : this);
