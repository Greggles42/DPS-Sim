/**
 * Ability Registry for gSim.
 * Defines AAs and disciplines with era gates and UI metadata.
 * Used to show/hide/disable ability controls based on selected era.
 */
(function (global) {
  'use strict';

  /**
   * Alternate Advancement ability definitions.
   * era: earliest era in which this AA is available.
   * section: 'luclin_archetype'|'luclin_class'|'pop_advance'|'pop_ability'
   * ranks: number of ranks.
   * classes: array of classId strings that can take this AA (empty = all applicable).
   * simOption: the key used in runFight/runRangedFight/runTankingFight options.
   * category: 'combat'|'tanking'|'stat'|'archery' for grouping in the AA configurator UI.
   */
  var AA_DEFINITIONS = [
    // ============================================================
    // Luclin — Archetype AAs
    // ============================================================
    {
      id: 'combatFury',
      label: 'Combat Fury',
      era: 'luclin',
      section: 'luclin_archetype',
      ranks: 3,
      classes: ['warrior', 'paladin', 'ranger', 'shadowknight', 'monk', 'bard', 'rogue', 'beastlord'],
      simOption: 'critChanceMult',
      category: 'combat',
      description: 'Rank 1/2/3: +2%/+4%/+6% melee crit chance.',
      rankLabels: ['Off', '1 (+2% crit)', '2 (+4% crit)', '3 (+6% crit)']
    },
    {
      id: 'combatStability',
      label: 'Combat Stability',
      era: 'luclin',
      section: 'luclin_archetype',
      ranks: 3,
      classes: [],
      simOption: 'combatStabilityRank',
      category: 'tanking',
      description: 'Rank 1/2/3: +2%/+5%/+10% melee damage mitigation.',
      rankLabels: ['Off', '1 (+2% mitigation)', '2 (+5% mitigation)', '3 (+10% mitigation)']
    },
    {
      id: 'combatAgility',
      label: 'Combat Agility',
      era: 'luclin',
      section: 'luclin_archetype',
      ranks: 3,
      classes: [],
      simOption: 'combatAgilityRank',
      category: 'tanking',
      description: 'Rank 1/2/3: +2%/+5%/+10% melee avoidance.',
      rankLabels: ['Off', '1 (+2% avoidance)', '2 (+5% avoidance)', '3 (+10% avoidance)']
    },
    {
      id: 'naturalDurability',
      label: 'Natural Durability',
      era: 'luclin',
      section: 'luclin_archetype',
      ranks: 3,
      classes: [],
      simOption: 'naturalDurabilityRank',
      category: 'tanking',
      description: 'Rank 1/2/3: +2%/+5%/+10% max HP (tanking sim: scales entered HP).',
      rankLabels: ['Off', '1 (+2% HP)', '2 (+5% HP)', '3 (+10% HP)']
    },
    {
      id: 'spellCastingFury',
      label: 'Spell Casting Fury',
      era: 'luclin',
      section: 'luclin_archetype',
      ranks: 3,
      classes: ['paladin', 'shadowknight', 'ranger', 'bard', 'beastlord'],
      simOption: 'spellCastingFury',
      category: 'combat',
      description: 'Gives proc spells a chance to critically hit for bonus damage.',
      rankLabels: ['Off', '1 (2% spell crit, +33% dmg)', '2 (4% spell crit, +66% dmg)', '3 (7% spell crit, +100% dmg)']
    },
    // ============================================================
    // Luclin — Class AAs
    // ============================================================
    {
      id: 'ambidexterity',
      label: 'Ambidexterity',
      era: 'luclin',
      section: 'luclin_class',
      ranks: 1,
      classes: ['warrior', 'ranger', 'monk', 'bard', 'rogue', 'beastlord'],
      simOption: 'ambidexterity',
      category: 'combat',
      description: '1 rank: +32 effective dual wield skill.',
      rankLabels: ['Off', '1 (+32 DW)']
    },
    {
      id: 'flurry',
      label: 'Flurry',
      era: 'luclin',
      section: 'luclin_class',
      ranks: 3,
      classes: ['warrior'],
      simOption: 'flurryRank',
      category: 'combat',
      description: 'Rank 1/2/3: chance of up to 2 extra primary-hand attacks.',
      rankLabels: ['Off', '1', '2', '3']
    },
    {
      id: 'slayUndead',
      label: 'Slay Undead',
      era: 'luclin',
      section: 'luclin_class',
      ranks: 3,
      classes: ['paladin'],
      simOption: 'slayUndead',
      category: 'combat',
      description: 'Chance to deal massive bonus damage vs undead targets.',
      rankLabels: ['Off', '1 (2.25%, 15×)', '2 (2.35%, 16×)', '3 (2.4%, 17×)']
    },
    {
      id: 'archeryMastery',
      label: 'Archery Mastery',
      era: 'luclin',
      section: 'luclin_class',
      ranks: 3,
      classes: ['ranger'],
      simOption: 'archeryMastery',
      category: 'archery',
      description: 'Rank 1/2/3: ×1.30 / ×1.60 / ×2.00 archery damage.',
      rankLabels: ['Off', '1 (×1.30)', '2 (×1.60)', '3 (×2.00)']
    },
    {
      id: 'doubleRiposte',
      label: 'Double Riposte',
      era: 'luclin',
      section: 'luclin_class',
      ranks: 3,
      classes: ['warrior', 'paladin', 'ranger', 'shadowknight', 'monk', 'rogue', 'beastlord'],
      simOption: 'doubleRiposteRank',
      category: 'tanking',
      description: 'Rank 1/2/3: 15%/35%/50% chance to execute a second riposte counter-attack on each riposte.',
      rankLabels: ['Off', '1 (15%)', '2 (35%)', '3 (50%)']
    },
    {
      id: 'returnKick',
      label: 'Return Kick',
      era: 'luclin',
      section: 'luclin_class',
      ranks: 3,
      classes: ['monk'],
      simOption: 'returnKickRank',
      category: 'tanking',
      description: 'Rank 1/2/3: 25%/35%/50% chance to perform a bonus flying kick on each riposte.',
      rankLabels: ['Off', '1 (25%)', '2 (35%)', '3 (50%)']
    },
    {
      id: 'twoHandBash',
      label: 'Two Hand Bash',
      era: 'luclin',
      section: 'luclin_class',
      ranks: 1,
      classes: ['paladin', 'shadowknight'],
      simOption: 'twoHandBash',
      category: 'combat',
      description: '1 rank: Enables Bash while wielding a 2-handed weapon.',
      rankLabels: ['Off', '1 (enabled)']
    },
    {
      id: 'soulAbrasion',
      label: 'Soul Abrasion',
      era: 'luclin',
      section: 'luclin_class',
      ranks: 3,
      classes: ['shadowknight'],
      simOption: 'soulAbrasionRank',
      category: 'combat',
      description: 'Rank 1/2/3: +10%/+20%/+30% bonus to lifetap proc spell damage.',
      rankLabels: ['Off', '1 (+10%)', '2 (+20%)', '3 (+30%)']
    },
    // ============================================================
    // PoP Advance — Available to All
    // ============================================================
    {
      id: 'planarPower',
      label: 'Planar Power',
      era: 'pop',
      section: 'pop_advance',
      ranks: 5,
      classes: [],
      simOption: 'planarPowerRank',
      category: 'stat',
      description: 'Rank 1–5: +5 to stat cap per rank.',
      rankLabels: ['Off', '1 (+5 cap)', '2 (+10 cap)', '3 (+15 cap)', '4 (+20 cap)', '5 (+25 cap)']
    },
    {
      id: 'planarDurability',
      label: 'Planar Durability',
      era: 'pop',
      section: 'pop_advance',
      ranks: 3,
      classes: ['warrior', 'paladin', 'shadowknight'],
      simOption: 'planarDurabilityRank',
      category: 'tanking',
      description: 'Rank 1–3: +1.5% max HP per rank (tanking sim; WAR/PAL/SHD only).',
      rankLabels: ['Off', '1 (+1.5% HP)', '2 (+3% HP)', '3 (+4.5% HP)']
    },
    // ============================================================
    // PoP Ability — Class/Archetype AAs
    // ============================================================
    {
      id: 'masterWu',
      label: 'Technique of Master Wu',
      era: 'pop',
      section: 'pop_ability',
      ranks: 5,
      classes: ['monk'],
      simOption: 'masterWuRank',
      category: 'combat',
      description: 'Rank 1–5: After flying kick, roll rank×10% — if pass, fire 1 extra random monk strike (Flying Kick/Eagle Strike/Tiger Claw/Round Kick); also roll rank×2.5% for a 2nd extra.',
      rankLabels: ['Off', '1 (10%/2.5%)', '2 (20%/5%)', '3 (30%/7.5%)', '4 (40%/10%)', '5 (50%/12.5%)']
    },
    {
      id: 'furyOfTheAges',
      label: 'Fury of the Ages',
      era: 'pop',
      section: 'pop_ability',
      ranks: 3,
      classes: ['warrior', 'paladin', 'ranger', 'shadowknight', 'monk', 'bard', 'rogue', 'beastlord'],
      simOption: 'furyOfTheAgesRank',
      category: 'combat',
      description: 'Rank 1/2/3: +5%/+10%/+15% melee crit damage bonus.',
      rankLabels: ['Off', '1 (+5% crit dmg)', '2 (+10% crit dmg)', '3 (+15% crit dmg)']
    },
    {
      id: 'ferocity',
      label: 'Ferocity',
      era: 'pop',
      section: 'pop_ability',
      ranks: 3,
      classes: ['warrior', 'ranger', 'monk', 'rogue'],
      simOption: 'ferocityRank',
      category: 'combat',
      description: 'Rank 1/2/3: +2%/+4%/+6% additional chance to double attack per round.',
      rankLabels: ['Off', '1 (+2% DA)', '2 (+4% DA)', '3 (+6% DA)']
    },
    {
      id: 'bestialFrenzy',
      label: 'Bestial Frenzy',
      era: 'pop',
      section: 'pop_ability',
      ranks: 5,
      classes: ['beastlord'],
      simOption: 'bestialFrenzyRank',
      category: 'combat',
      description: 'Rank 1–5: +2% per rank chance to double attack per round.',
      rankLabels: ['Off', '1 (+2%)', '2 (+4%)', '3 (+6%)', '4 (+8%)', '5 (+10%)']
    },
    {
      id: 'harmoniousAttack',
      label: 'Harmonious Attack',
      era: 'pop',
      section: 'pop_ability',
      ranks: 5,
      classes: ['bard'],
      simOption: 'harmoniousAttackRank',
      category: 'combat',
      description: 'Rank 1–5: +2% per rank chance to double attack per round.',
      rankLabels: ['Off', '1 (+2%)', '2 (+4%)', '3 (+6%)', '4 (+8%)', '5 (+10%)']
    },
    {
      id: 'punishingBlade',
      label: 'Punishing Blade',
      era: 'pop',
      section: 'pop_ability',
      ranks: 3,
      classes: ['warrior', 'ranger', 'monk'],
      simOption: 'punishingBladeRank',
      category: 'combat',
      description: 'Rank 1/2/3: 2%/4%/8% chance to score an extra attack with a 2H primary weapon after a double attack.',
      rankLabels: ['Off', '1 (2%)', '2 (4%)', '3 (8%)']
    },
    {
      id: 'flashOfSteel',
      label: 'Flash of Steel',
      era: 'pop',
      section: 'pop_ability',
      ranks: 3,
      classes: ['warrior', 'paladin', 'ranger', 'shadowknight', 'monk', 'rogue', 'beastlord'],
      simOption: 'flashOfSteelRank',
      category: 'tanking',
      description: 'Rank 1/2/3: +10%/+20%/+30% additional double riposte chance (stacks with Double Riposte).',
      rankLabels: ['Off', '1 (+10%)', '2 (+20%)', '3 (+30%)']
    },
    {
      id: 'knightsAdvantage',
      label: "Knight's Advantage",
      era: 'pop',
      section: 'pop_ability',
      ranks: 3,
      classes: ['paladin', 'shadowknight'],
      simOption: 'knightsAdvantageRank',
      category: 'combat',
      description: 'Rank 1/2/3: +2%/+4%/+6% additional double attack chance.',
      rankLabels: ['Off', '1 (+2% DA)', '2 (+4% DA)', '3 (+6% DA)']
    },
    {
      id: 'speedOfTheKnight',
      label: 'Speed of the Knight',
      era: 'pop',
      section: 'pop_ability',
      ranks: 3,
      classes: ['paladin', 'shadowknight'],
      simOption: 'speedOfTheKnightRank',
      category: 'combat',
      description: 'Rank 1/2/3: 2%/4%/8% chance for an extra 2H primary attack after a double attack.',
      rankLabels: ['Off', '1 (2%)', '2 (4%)', '3 (8%)']
    },
    {
      id: 'ragingFlurry',
      label: 'Raging Flurry',
      era: 'pop',
      section: 'pop_ability',
      ranks: 3,
      classes: ['warrior'],
      simOption: 'ragingFlurryRank',
      category: 'combat',
      description: 'Rank 1/2/3: 10%/20%/30% extra flurry chance that fires on successful triple attack.',
      rankLabels: ['Off', '1 (10%)', '2 (20%)', '3 (30%)']
    },
    {
      id: 'tacticalMastery',
      label: 'Tactical Mastery',
      era: 'pop',
      section: 'pop_ability',
      ranks: 3,
      classes: ['warrior'],
      simOption: 'tacticalMasteryRank',
      category: 'combat',
      description: 'Rank 1/2/3: Bypasses NPC avoidance defenses (-10/-20/-30 to NPC effective avoidance).',
      rankLabels: ['Off', '1 (-10 avoidance)', '2 (-20 avoidance)', '3 (-30 avoidance)']
    },
    {
      id: 'innateDefense',
      label: 'Innate Defense',
      era: 'pop',
      section: 'pop_ability',
      ranks: 5,
      classes: [],
      simOption: 'innateDefenseRank',
      category: 'tanking',
      description: 'Rank 1–5: +2% per rank additional melee damage mitigation (stacks with Combat Stability).',
      rankLabels: ['Off', '1 (+2%)', '2 (+4%)', '3 (+6%)', '4 (+8%)', '5 (+10%)']
    },
    {
      id: 'lightningReflexes',
      label: 'Lightning Reflexes',
      era: 'pop',
      section: 'pop_ability',
      ranks: 5,
      classes: [],
      simOption: 'lightningReflexesRank',
      category: 'tanking',
      description: 'Rank 1–5: +2% per rank additional melee avoidance (stacks with Combat Agility).',
      rankLabels: ['Off', '1 (+2%)', '2 (+4%)', '3 (+6%)', '4 (+8%)', '5 (+10%)']
    },
  ];

  /**
   * Discipline definitions.
   * Disciplines are available in all eras (Classic+) for applicable classes.
   */
  var DISCIPLINE_DEFINITIONS = [
    {
      id: 'duelist',
      label: 'Duelist',
      era: 'classic',
      classes: ['rogue'],
      inputId: 'duelist',
      permanentInputId: 'duelist-permanent',
      description: 'Rogue discipline: +100% backstab damage, min hit = 4x weapon + 1x damage bonus.'
    },
    {
      id: 'innerFlame',
      label: 'Inner Flame',
      era: 'classic',
      classes: ['monk'],
      inputId: 'inner-flame',
      permanentInputId: 'inner-flame-permanent',
      description: 'Monk discipline: increases melee damage.'
    },
    {
      id: 'trueshot',
      label: 'Trueshot',
      era: 'classic',
      classes: ['ranger'],
      inputId: 'trueshot',
      permanentInputId: 'trueshot-permanent',
      description: 'Ranger discipline: 2-minute window with +105% archery damage and +12% effective skill.'
    }
  ];

  /**
   * Get all AAs available in the given era (and optionally filtered by class).
   * @param {string} eraId
   * @param {string} [classId]
   * @returns {Array}
   */
  function getAvailableAAs(eraId, classId) {
    var eraOrder = 0;
    if (global.EraConfig) {
      var era = global.EraConfig.getEra(eraId);
      if (era) eraOrder = era.order;
    }
    return AA_DEFINITIONS.filter(function (aa) {
      var aaEra = global.EraConfig ? global.EraConfig.getEra(aa.era) : null;
      var aaOrder = aaEra ? aaEra.order : 0;
      if (aaOrder > eraOrder) return false;
      if (classId && aa.classes.length > 0 && aa.classes.indexOf(classId.toLowerCase()) < 0) return false;
      return true;
    });
  }

  /**
   * Check whether a specific AA is available in the given era.
   * @param {string} aaId
   * @param {string} eraId
   * @returns {boolean}
   */
  function isAAAvailable(aaId, eraId) {
    var aa = AA_DEFINITIONS.find(function (a) { return a.id === aaId; });
    if (!aa) return false;
    if (!global.EraConfig) return true;
    return global.EraConfig.isAvailableInEra(aa.era, eraId);
  }

  global.AbilityRegistry = {
    AA_DEFINITIONS: AA_DEFINITIONS,
    DISCIPLINE_DEFINITIONS: DISCIPLINE_DEFINITIONS,
    getAvailableAAs: getAvailableAAs,
    isAAAvailable: isAAAvailable
  };
})(typeof self !== 'undefined' ? self : this);
