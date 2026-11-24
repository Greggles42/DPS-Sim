/**
 * NPC offense model for the tanking simulation.
 *
 * Everything a mob does to you in a melee round, faithful to EQMacEmu/Quarm:
 *   mob_ai.cpp        AI_Process combat block, DoMainHandRound, DoOffHandRound, Flurry
 *   attack.cpp        NPC::Attack, AvoidDamage, AvoidanceCheck, CalcMeleeDamage, GetOffense
 *   special_attacks.cpp  DoClassAttacks, DoSpecialAttackDamage, DoBash/DoKick, TryBashKickStun
 *   npc.cpp           NPC skill initialisation by class and level
 *   emu_constants.h   SpecialAbility ids
 *
 * The player-defence side lives in playerDefense.js; the shared damage/hit
 * primitives (rollD20, getHitChance, calcMeleeDamage) come from combat.js and are
 * used unchanged.
 */
(function (global) {
  'use strict';

  function getEQCombat() { return global.EQCombat || null; }

  // ---- SpecialAbility ids (common/emu_constants.h) ----
  var SA = {
    Summon: 1, Enrage: 2, Rampage: 3, AreaRampage: 4, Flurry: 5,
    TripleAttack: 6, DualWield: 7, DisallowEquip: 8, BaneAttack: 9,
    MagicalAttack: 10, RangedAttack: 11, SlowImmunity: 12,
    MesmerizeImmunity: 13, CharmImmunity: 14, StunImmunity: 15,
    SnareImmunity: 16, FearImmunity: 17, DispellImmunity: 18,
    MeleeImmunity: 19, MagicImmunity: 20, FleeingImmunity: 21,
    MeleeImmunityExceptBane: 22, MeleeImmunityExceptMagical: 23,
    AggroImmunity: 24, BeingAggroImmunity: 25, CastingFromRangeImmunity: 26,
    FeignDeathImmunity: 27, TauntImmunity: 28, TunnelVision: 29,
    NoBuffHealFriends: 30, PacifyImmunity: 31, Leash: 32, Tether: 33,
    PermarootFlee: 34, HarmFromClientImmunity: 35, AlwaysFlee: 36,
    FleePercent: 37, AllowBeneficial: 38, DisableMelee: 39,
    NPCChaseDistance: 40, AllowedToTank: 41, ProximityAggro: 42,
    AlwaysCallHelp: 43, UseWarriorSkills: 44, AlwaysFleeLowCon: 45,
    NoLoitering: 46, BadFactionBlockHandin: 47, PCDeathblowCorpse: 48,
    CorpseCamper: 49, ReverseSlow: 50, HasteImmunity: 51,
    DisarmImmunity: 52, RiposteImmunity: 53, ProximityAggro2: 54
  };

  // Names for the ones a tank actually cares about, for UI display.
  var SA_DISPLAY = {
    1: 'Summon', 2: 'Enrage', 3: 'Rampage', 4: 'Area Rampage', 5: 'Flurry',
    7: 'Dual Wield', 12: 'Slow Immune', 15: 'Stun Immune', 19: 'Melee Immune',
    22: 'Melee Immune (except bane)', 23: 'Melee Immune (except magical)',
    39: 'No Melee', 44: 'Warrior Skills', 50: 'Reverse Slow',
    51: 'Haste Immune', 53: 'Riposte Immune'
  };

  // EQ class ids as used by npc_types.class
  var CLASS = {
    Warrior: 1, Cleric: 2, Paladin: 3, Ranger: 4, ShadowKnight: 5, Druid: 6,
    Monk: 7, Bard: 8, Rogue: 9, Shaman: 10, Necromancer: 11, Wizard: 12,
    Magician: 13, Enchanter: 14, Beastlord: 15
  };

  // common/features.h reuse times, in seconds
  var REUSE = {
    bash: 8, kick: 8, backstab: 10, flyingkick: 8, roundkick: 8,
    tigerclaw: 7, eaglestrike: 6, dragonpunch: 6
  };

  // skills.cpp GetSkillBaseDamage base values, before the skill-level steps
  var SKILL_BASE = {
    bash: 2, kick: 3, dragonpunch: 12, flyingkick: 25,
    roundkick: 5, eaglestrike: 7, tigerclaw: 4
  };

  var MIN_HASTED_DELAY_MS = 400;   // RuleI(Combat, MinHastedDelay)
  var DEFAULT_FLURRY_CHANCE = 20;  // RuleI(Combat, NPCFlurryChance)
  var DEFAULT_RAMPAGE_CHANCE = 20;
  var ENRAGE_HP_PCT = 9;           // RuleI(NPC, StartEnrageValue) — live Quarm rule_values = 9 (compiled default 10)
  var ENRAGE_DURATION_MS = 10000;
  var ENRAGE_COOLDOWN_MS = 360000;
  var STUN_DURATION_MS = 2000;

  // ---- special_abilities parsing -------------------------------------------

  /**
   * npc_types.special_abilities is "id,param0,param1^id,param0^..." — parse it
   * into { id: [param0, param1, ...] }.
   */
  function parseSpecialAbilities(str) {
    var out = {};
    if (!str || typeof str !== 'string') return out;
    var groups = str.split('^');
    for (var i = 0; i < groups.length; i++) {
      var parts = groups[i].split(',');
      var id = parseInt(parts[0], 10);
      if (!isFinite(id) || id <= 0) continue;
      var params = [];
      for (var j = 1; j < parts.length; j++) {
        var v = parseInt(parts[j], 10);
        params.push(isFinite(v) ? v : 0);
      }
      out[id] = params;
    }
    return out;
  }

  /** Is the ability present and enabled? param0 of 0 means "off" for most flags. */
  function hasAbility(parsed, id) {
    var p = parsed && parsed[id];
    if (!p) return false;
    return p.length === 0 || p[0] !== 0;
  }

  /**
   * Read ability parameter `index` the way the server does (GetSpecialAbilityParam): the DB string is
   * "id,value,param0,param1,..." and parseSpecialAbilities keeps [value, param0, param1, ...], so parameter N
   * lives at slot N+1. Slot 0 is the on/off value, not a parameter. A missing or non-positive parameter means
   * "use the default" (every caller in mob_ai.cpp does `param > 0 ? param : default`).
   */
  function abilityParam(parsed, id, index, dflt) {
    var p = parsed && parsed[id];
    var v = p ? p[index + 1] : undefined;
    return (v !== undefined && v > 0) ? v : dflt;
  }

  /** Human-readable list for the mob card. */
  function describeSpecialAbilities(parsed) {
    var out = [];
    for (var id in parsed) {
      if (!Object.prototype.hasOwnProperty.call(parsed, id)) continue;
      if (!hasAbility(parsed, id)) continue;
      var name = SA_DISPLAY[id];
      if (!name) continue;
      if (Number(id) === SA.Flurry) {
        name += ' (' + abilityParam(parsed, SA.Flurry, 0, DEFAULT_FLURRY_CHANCE) + '%)';
      } else if (Number(id) === SA.Rampage || Number(id) === SA.AreaRampage) {
        name += ' (' + abilityParam(parsed, Number(id), 0, DEFAULT_RAMPAGE_CHANCE) + '%)';
      } else if (Number(id) === SA.Enrage) {
        name += ' (below ' + abilityParam(parsed, SA.Enrage, 0, ENRAGE_HP_PCT) + '% HP, ' +
          Math.round(abilityParam(parsed, SA.Enrage, 1, ENRAGE_DURATION_MS) / 1000) + 's, ' +
          Math.round(abilityParam(parsed, SA.Enrage, 2, ENRAGE_COOLDOWN_MS) / 1000) + 's cooldown)';
      }
      out.push(name);
    }
    return out;
  }

  // ---- NPC skills (npc.cpp:300-405) ----------------------------------------

  /**
   * NPCs ignore client class-skill availability and caps; they get a flat
   * level-derived value. Note the pre-PoP cap is 210, not 250.
   */
  function getNpcSkillLevel(level) {
    return level > 50 ? 250 : Math.min(level * 5, 210);
  }

  function getNpcWeaponSkill(level, isPoP) {
    if (isPoP) return level > 50 ? (250 + level) : Math.min(level * 6, 275);
    return getNpcSkillLevel(level);
  }

  /** EQ class ids 20-34 are the "GM" variants of classes 1-15; the server treats them the same in npc.cpp. */
  function normalizeClass(classId) {
    var c = Number(classId);
    if (!isFinite(c) || c <= 0) return CLASS.Warrior;
    return (c >= 20 && c <= 34) ? c - 19 : c;
  }

  /**
   * An NPC's starting skill value from the class skill_caps table (npc.cpp:298), before the explicit
   * overrides that follow it. Only Warrior/Ranger/Monk/Beastlord have Kick and Warrior/Cleric/Paladin/SK
   * have Bash in that table. Falls back to "has it" = the flat NPC skill level when the cap data isn't loaded.
   */
  function getBaselineSkill(skillKey, cls, level) {
    var wsc = global.WeaponSkillCaps;
    if (wsc && wsc.getSkillCap && cls >= 1 && cls <= 15) return wsc.getSkillCap(skillKey, cls - 1, level);
    if (skillKey === 'kick') {
      return (cls === CLASS.Warrior || cls === CLASS.Monk || ((cls === CLASS.Ranger || cls === CLASS.Beastlord) && level >= 5))
        ? getNpcSkillLevel(level) : 0;
    }
    return 0;
  }

  /**
   * Which class attack an NPC leads with, following NPC::DoClassAttacks' priority chain: backstab, then the
   * monk specials in descending order, then kick (with a 66% chance of bash instead if it also has bash), then
   * bash. Which skills the NPC has comes from npc.cpp: class skill_caps baseline, then explicit assignments
   * (npc.cpp:343-405). The UseWarriorSkills special ability grants bash and kick exactly like a Warrior
   * (and also parry/riposte, see getNpcDefenseSkills).
   * Returns null when the NPC has no class attack at this level.
   */
  function getNpcClassAttack(classId, level, useWarriorSkills) {
    var cls = normalizeClass(classId);
    var skill = getNpcSkillLevel(level);                              // bash/kick skill value (npc.cpp:304-332)
    var monkSkill = level > 50 ? 250 : Math.min(level * 5, 225);     // monk specials use the later skillLevel

    var kick = getBaselineSkill('kick', cls, level);
    var bash = getBaselineSkill('bash', cls, level);
    if (cls === CLASS.Warrior || useWarriorSkills) {
      bash = level > 5 ? skill : 0;
      kick = level > 15 ? skill : 0;
    }
    if (cls === CLASS.Paladin || cls === CLASS.ShadowKnight || cls === CLASS.Cleric) bash = level > 5 ? skill : 0;
    if (cls === CLASS.Ranger) kick = level > 15 ? skill : 0;

    if (cls === CLASS.Rogue && level > 9) {
      return { skill: 'backstab', reuseSec: REUSE.backstab, skillLevel: skill };
    }
    if (cls === CLASS.Monk) {
      if (level > 29) return { skill: 'flyingkick', reuseSec: REUSE.flyingkick, skillLevel: monkSkill };
      if (level > 24) return { skill: 'dragonpunch', reuseSec: REUSE.dragonpunch, skillLevel: monkSkill };
      if (level > 19) return { skill: 'eaglestrike', reuseSec: REUSE.eaglestrike, skillLevel: monkSkill };
      if (level > 9)  return { skill: 'tigerclaw', reuseSec: REUSE.tigerclaw, skillLevel: monkSkill };
      if (level > 4)  return { skill: 'roundkick', reuseSec: REUSE.roundkick, skillLevel: monkSkill };
    }

    if (kick > 0 && bash > 0) {
      // DoClassAttacks rolls 66% for bash when the NPC has both.
      return { skill: 'kick', altSkill: 'bash', altChance: 66,
               reuseSec: REUSE.kick, altReuseSec: REUSE.bash, skillLevel: kick, altSkillLevel: bash };
    }
    if (kick > 0) return { skill: 'kick', reuseSec: REUSE.kick, skillLevel: kick };
    if (bash > 0) return { skill: 'bash', reuseSec: REUSE.bash, skillLevel: bash };
    return null;
  }

  /**
   * The mob's own block/parry/riposte/dodge skills (used when the player counter-attacks on a riposte).
   * Delegates to combat.js so the tanking and DPS sims share one model of npc.cpp; useWarriorSkills is the
   * UseWarriorSkills special ability, which grants parry and riposte to any class.
   */
  function getNpcDefenseSkills(classId, level, useWarriorSkills) {
    var eq = getEQCombat();
    if (eq && eq.getNpcDefenseSkills) {
      var a = eq.getNpcDefenseSkills(level, classId, false, !!useWarriorSkills);
      return { block: a[0], parry: a[1], riposte: a[2], dodge: a[3] };
    }
    var L = level;
    var cls = normalizeClass(classId);
    var skillLevel = L > 50 ? 250 : Math.min(L * 5, 225);
    var hasParry = !!useWarriorSkills || cls === CLASS.Warrior || cls === CLASS.Paladin ||
                   cls === CLASS.ShadowKnight || cls === CLASS.Ranger ||
                   cls === CLASS.Rogue || cls === CLASS.Bard;
    var hasRiposte = hasParry || cls === CLASS.Monk;
    var isMonk = cls === CLASS.Monk;
    return {
      block:   isMonk && L > 11 ? skillLevel : 0,
      parry:   hasParry && L > 6 ? Math.min(L * 5, 230) : 0,
      riposte: hasRiposte && L > 11 ? Math.min(L * 5, 225) : 0,
      dodge:   L > 10 ? Math.min(L * 5, isMonk ? 230 : 190) : 0
    };
  }

  /** skills.cpp GetSkillBaseDamage — base plus one step at skill 25/75/125/175. */
  function getSkillBaseDamage(skillName, skillLevel) {
    var base = SKILL_BASE[skillName];
    if (!base) return 0;
    if (skillLevel >= 25)  base++;
    if (skillLevel >= 75)  base++;
    if (skillLevel >= 125) base++;
    if (skillLevel >= 175) base++;
    return base;
  }

  // ---- Damage / offense derivation ------------------------------------------

  /**
   * NPC::GetBaseDamage — the "DI" (damage interval) implied by min/max hit.
   * Pairs with getDamageBonus so roll 1 lands on min_dmg and roll 20 on max_dmg.
   */
  function getBaseDamage(minDmg, maxDmg) {
    // npc attack.cpp GetBaseDamage: baseDamage stays 1 unless max_dmg > min_dmg (the damage bonus then equals max).
    if (maxDmg <= minDmg) return 1;
    var di1k = Math.floor((maxDmg - minDmg) * 1000 / 19);
    di1k = Math.floor((di1k + 50) / 100) * 100;
    return Math.max(1, Math.floor(di1k / 100));
  }

  /** NPC::GetDamageBonus — the flat "DB" added on top of every swing. */
  function getDamageBonus(minDmg, maxDmg) {
    if (minDmg > maxDmg) return minDmg;
    var di1k = Math.floor((maxDmg - minDmg) * 1000 / 19);
    di1k = Math.floor((di1k + 50) / 100) * 100;
    return Math.floor((maxDmg * 1000 - di1k * 20) / 1000);
  }

  /**
   * Mob::GetOffense. Levels 46-50 are flattened to 45 for non-pets — a real
   * plateau in the server's offense curve.
   */
  /** Pet::Pet (pets.cpp:472): summoned pets' weapon/offense/defense skills are min(level*5, 225), +10 at level 60+. */
  function getPetSkillLevel(level) {
    var s = Math.min(level * 5, 225);
    return level >= 60 ? s + 10 : s;
  }

  function getOffense(level, isPoP, atk, isPet, petStrBonus) {
    var L = level != null ? level : 60;
    if (isPet) {
      // Mob::GetOffense for summoned pets: baseOffense = the pet's own skill, no level-based STR term, only the
      // buffed STR (x2/3) plus ATK (attack.cpp:4973-4991).
      var strO = Math.max(0, Math.trunc((petStrBonus || 0) * 2 / 3));
      return Math.max(1, getPetSkillLevel(L) + strO + (atk || 0));
    }
    if (!isPet && L > 45 && L < 51) L = 45;

    var baseOffense = Math.min(Math.floor(L * 55 / 10) - 4, 320);
    var strOffense;
    if (L < 6) {
      baseOffense = L * 4;
      strOffense = L;
    } else if (L < 30) {
      strOffense = Math.floor(L / 2) + 1;
    } else {
      strOffense = L * 2 - 40;
      if (isPoP) strOffense += 20;
    }

    return Math.max(1, baseOffense + strOffense + (atk || 0));
  }

  /** Mob::GetToHit = 7 + offense skill + weapon skill + accuracy rating. */
  function getToHit(level, isPoP, accuracyRating, isPet) {
    var ws = isPet ? getPetSkillLevel(level) : getNpcWeaponSkill(level, isPoP);
    var acc = accuracyRating || 0;
    if (level < 3) acc += 2;
    return 7 + ws + ws + acc;
  }

  /**
   * Effective swing delay after haste/slow.
   *   NPC::SetAttackTimer — delay < 401 is deciseconds, so scale by 100.
   *   Mob::GetHaste — a slowed mob returns 100 + spellbonuses.haste directly;
   *   NPCs never receive worn-item haste.
   * hastePct is the net spell haste/slow: -60 means a 60% slow.
   * slow_mitigation reduces how much of a slow actually lands (bonuses.cpp:1144).
   */
  function getAttackDelayMs(attackDelay, hastePct, slowMitigationPct) {
    var delay = attackDelay != null ? attackDelay : 30;
    if (delay < 401) delay *= 100;

    var hasteMod = getEffectiveHaste(hastePct, slowMitigationPct) / 100;
    if (hasteMod <= 0) hasteMod = 0.01;

    return Math.max(MIN_HASTED_DELAY_MS, Math.floor(delay / hasteMod));
  }

  /**
   * Mob::GetHaste as a percentage (100 = unhasted). A slow is negative spell
   * haste; slow_mitigation gives some of it back.
   */
  function getEffectiveHaste(hastePct, slowMitigationPct) {
    var pct = hastePct || 0;
    if (pct < 0 && slowMitigationPct > 0) {
      pct = pct - Math.floor(pct * slowMitigationPct / 100);
    }
    return Math.max(1, 100 + pct);
  }

  // ---- Mob profile -----------------------------------------------------------

  /**
   * Derive everything the simulation needs about the mob, once, up front.
   *
   * @param {Object} o
   *   level, classId, minDamage, maxDamage, attackDelay, attackCount, ac, atk,
   *   accuracy, hp, specialAbilities (raw string or parsed object),
   *   hastePct, slowMitigation, era, npcAvoidance, forceDualWield (used by
   *   the pet DPS sim's "Always Dual Wield" toggle — see petCombat.js),
   *   disableDualWield (tanking sim override that forces off-hand rounds off
   *   even when the NPC's own DualWield ability would grant them),
   *   isPet (skips the level 46-50 offense plateau real NPCs get; pets are
   *   exempt from it server-side, same as the existing getOffense param)
   */
  function buildMobProfile(o) {
    var level = o.level != null ? o.level : 60;
    var isPoP = o.era === 'pop';
    var parsed = typeof o.specialAbilities === 'string'
      ? parseSpecialAbilities(o.specialAbilities)
      : (o.specialAbilities || {});

    // npc.cpp:188 — a DB row with max < min is simply swapped.
    var minDmg = Math.max(1, o.minDamage != null ? o.minDamage : 10);
    var maxDmg = Math.max(1, o.maxDamage != null ? o.maxDamage : 50);
    if (maxDmg < minDmg) { var tmpDmg = minDmg; minDmg = maxDmg; maxDmg = tmpDmg; }

    // attack_count of -1 or 0 is the DB's "just one swing" sentinel.
    var attackCount = o.attackCount != null && o.attackCount > 1 ? o.attackCount : 1;

    // Every NPC above level 7 gets double attack, at the flat NPC skill value —
    // it is not gated by class the way client double attack is.
    // Summoned pets: DoubleAttack skill = min(level*5, 200) above level 9 (pets.cpp:535); NPCs: the flat NPC skill above 7.
    var daSkill = o.isPet ? (level > 9 ? Math.min(level * 5, 200) : 0) : (level > 7 ? getNpcSkillLevel(level) : 0);
    var daChance = daSkill > 0
      ? Math.min(1, (daSkill + (level > 35 ? level : 0)) / 500)
      : 0;

    var classId = o.classId != null ? o.classId : CLASS.Warrior;

    // Off-hand rounds need the DualWield ability (or an equipped secondary,
    // which the DB does not expose to us).
    var dualWield = !o.disableDualWield && (hasAbility(parsed, SA.DualWield) || !!o.forceDualWield);

    // Having the DualWield ability doesn't mean every off-hand tick actually
    // swings — Mob::CheckDualWield rolls dualWieldEffective > random(0,374)
    // each time, same shape as the double attack roll but against skill+level
    // over 375 instead of 500 (NPCs share the same skill value for both).
    var dualWieldChance = dualWield
      ? Math.min(1, (daSkill + (level > 35 ? level : 0)) / 375)
      : 0;

    var useWarriorSkills = hasAbility(parsed, SA.UseWarriorSkills);
    var classAttack = getNpcClassAttack(classId, level, useWarriorSkills);

    // Slow / haste special abilities (spells.cpp:3853, bonuses.cpp:1148). hastePct is the net spell haste the
    // caller entered: negative = a slow landed on the mob.
    //   SlowImmunity (without ReverseSlow): slow spells never land.
    //   ReverseSlow: a slow becomes a haste of (100 - slow)%, and slow_mitigation does not apply to it.
    //   HasteImmunity: haste spells never land.
    var effHastePct = o.hastePct || 0;
    var effSlowMitigation = o.slowMitigation;
    var slowIgnored = false, slowReversed = false, hasteIgnored = false;
    if (effHastePct < 0) {
      if (hasAbility(parsed, SA.ReverseSlow)) {
        effHastePct = 100 + effHastePct;
        effSlowMitigation = 0;
        slowReversed = true;
      } else if (hasAbility(parsed, SA.SlowImmunity)) {
        effHastePct = 0;
        slowIgnored = true;
      }
    } else if (effHastePct > 0 && hasAbility(parsed, SA.HasteImmunity)) {
      effHastePct = 0;
      hasteIgnored = true;
    }

    // Enrage (mob_ai.cpp:2710-2777): the HP threshold, duration and cooldown are the ability's parameters, with
    // the NPC:StartEnrageValue rule / EnragedDurationTimer / EnragedTimer as defaults. NPCs of level 53-55
    // never enrage (CheckEnrage returns early for them).
    var canEnrage = hasAbility(parsed, SA.Enrage) && !(level > 52 && level < 56);

    return {
      name: o.name || ('Level ' + level + ' NPC'),
      level: level,
      classId: classId,
      isPoP: isPoP,

      minDamage: minDmg,
      maxDamage: maxDmg,
      baseDamage: getBaseDamage(minDmg, maxDmg),
      damageBonus: getDamageBonus(minDmg, maxDmg),

      offense: getOffense(level, isPoP, o.atk || 0, !!o.isPet, o.petStrBonus || 0),
      toHit: getToHit(level, isPoP, o.accuracy, !!o.isPet),
      ac: o.ac || 0,
      hp: o.hp || 0,
      avoidance: o.npcAvoidance || 0,

      attackDelayMs: getAttackDelayMs(o.attackDelay, effHastePct, effSlowMitigation),
      // GetHaste() as a percentage — also scales class-attack reuse.
      hastePctTotal: getEffectiveHaste(effHastePct, effSlowMitigation),
      slowIgnored: slowIgnored,
      slowReversed: slowReversed,
      hasteIgnored: hasteIgnored,
      attackCount: attackCount,

      doubleAttackSkill: daSkill,
      doubleAttackChance: daChance,
      // TryBashKickStun: kicks only stun for raw Warrior / WarriorGM class NPCs at level 55+.
      canKickStun: (classId === CLASS.Warrior || Number(o.classId) === 20) && level >= 55,
      // Warriors and Monks at 60+ only, and only after a double connects (mob_ai.cpp:1208 compares the raw class,
      // so the GM variants do not get it).
      hasTripleAttack: (classId === CLASS.Warrior || classId === CLASS.Monk) && level >= 60,

      dualWield: dualWield,
      dualWieldChance: dualWieldChance,
      // The off-hand's own double attack needs 150+ double attack skill.
      offhandDoubleAttack: daSkill >= 150,

      flurryChance: hasAbility(parsed, SA.Flurry)
        ? abilityParam(parsed, SA.Flurry, 0, DEFAULT_FLURRY_CHANCE) / 100 : 0,
      rampageChance: hasAbility(parsed, SA.Rampage)
        ? abilityParam(parsed, SA.Rampage, 0, DEFAULT_RAMPAGE_CHANCE) / 100 : 0,
      rampageDamagePct: abilityParam(parsed, SA.Rampage, 2, 100),
      areaRampageChance: hasAbility(parsed, SA.AreaRampage)
        ? abilityParam(parsed, SA.AreaRampage, 0, DEFAULT_RAMPAGE_CHANCE) / 100 : 0,
      areaRampageDamagePct: abilityParam(parsed, SA.AreaRampage, 2, 100),

      canEnrage: canEnrage,
      enrageHpPct: abilityParam(parsed, SA.Enrage, 0, ENRAGE_HP_PCT),
      enrageDurationMs: abilityParam(parsed, SA.Enrage, 1, ENRAGE_DURATION_MS),
      enrageCooldownMs: abilityParam(parsed, SA.Enrage, 2, ENRAGE_COOLDOWN_MS),
      useWarriorSkills: useWarriorSkills,
      riposteImmune: hasAbility(parsed, SA.RiposteImmunity),
      meleeDisabled: hasAbility(parsed, SA.DisableMelee),
      stunImmune: hasAbility(parsed, SA.StunImmunity),
      slowImmune: hasAbility(parsed, SA.SlowImmunity),

      classAttack: classAttack,
      specialAbilities: parsed,
      specialAbilityNames: describeSpecialAbilities(parsed)
    };
  }

  // ---- Swing resolution -----------------------------------------------------

  /**
   * Resolve one incoming swing against the player.
   *
   * Order is the server's (NPC::Attack): AvoidDamage first — block, parry,
   * riposte, dodge, first success wins — then AvoidanceCheck for the hit roll,
   * then the damage roll. This is deliberately *not* hit-check-first.
   *
   * @param {Object} mob      profile from buildMobProfile
   * @param {Object} defense  from PlayerDefense.build
   * @param {Object} ctx      mutable fight state: { stunned, mobEnraged, runeRemaining }
   * @param {Function} rng
   * @param {Object} [opts]   { baseDamage, damagePct, source, skill }
   * @returns {{outcome:string, damage:number, source:string, stun:boolean}}
   */
  function resolveSwing(mob, defense, ctx, rng, opts) {
    opts = opts || {};
    var source = opts.source || 'mainhand';
    var result = { outcome: 'miss', damage: 0, source: source, stun: false };

    var rates = defense.rates;

    // AvoidDamage (attack.cpp:246) has no stun check: a stunned defender still blocks, parries,
    // ripostes and dodges (only the riposte COUNTERATTACK is suppressed while stunned — see
    // Mob::DoRiposte). Sitting is not modelled.
    {
      if (rates.block > 0 && rng() < rates.block) { result.outcome = 'block'; return result; }
      if (rates.parry > 0 && rng() < rates.parry) { result.outcome = 'parry'; return result; }

      // An enraged mob cannot be riposted. RiposteImmunity does NOT stop the swing being negated —
      // it only stops the counterattack (Mob::DoRiposte), handled by the engine.
      var riposteAllowed = !ctx.mobEnraged;
      if (riposteAllowed && rates.riposte > 0 && rng() < rates.riposte) {
        result.outcome = 'riposte';
        return result;
      }
      if (rates.dodge > 0 && rng() < rates.dodge) { result.outcome = 'dodge'; return result; }
    }

    // AvoidanceCheck — the pure hit roll.
    if (rng() >= defense.hitChance) { result.outcome = 'miss'; return result; }

    result.outcome = 'hit';
    result.damage = rollDamage(mob, defense, rng, opts);

    // Bash and (warrior-class, level 55+) kick roll a stun before damage is applied. An NPC dragon
    // punch never stuns (it needs a client with the instant disc).
    if (opts.skill === 'bash' || (opts.skill === 'kick' && mob.canKickStun)) {
      result.stun = rollStun(mob, defense, rng);
    }

    return result;
  }

  /**
   * Mob::CalcMeleeDamage.
   *   damage = damageBonus + floor((RollD20(offense, mitigation) * base + 5) / 10)
   *
   * SE_MeleeMitigation (Defensive Discipline and friends) scales `base` *before*
   * the roll, so it never touches the flat damage bonus — which is why Defensive
   * is worth appreciably less than its nominal 50% against high-DB mobs.
   */
  function rollDamage(mob, defense, rng, opts) {
    opts = opts || {};
    var eq = getEQCombat();
    var base = opts.baseDamage != null ? opts.baseDamage : mob.baseDamage;

    var mitPct = defense.meleeMitigationPct || 0;
    if (mitPct !== 0) base = base + Math.floor(base * mitPct / 100);
    if (base < 1) base = 1;

    var damage;
    if (eq && eq.rollD20) {
      var roll = eq.rollD20(mob.offense, defense.mitigation, rng);
      damage = Math.floor((roll * base + 5) / 10);
    } else {
      damage = Math.floor(base * (1 + rng() * 19) / 10);
    }
    if (damage < 1) damage = 1;

    // Item mod2 Shielding (2026-11-18 patch) trims only the flat damage bonus,
    // never the rolled portion (Mob::ApplyShieldingToDamageBonus).
    var bonus = mob.damageBonus || 0;
    var shieldPct = defense.shieldingPct || 0;
    if (bonus > 0 && shieldPct > 0) bonus = bonus - Math.floor(bonus * shieldPct / 100);
    damage += bonus;

    var pct = opts.damagePct != null ? opts.damagePct : 100;
    if (pct !== 100) damage = Math.floor(damage * pct / 100);

    return Math.max(1, damage);
  }

  /**
   * TryBashKickStun (special_attacks.cpp:100).
   *   chance = (level > 60 ? 40 : 45), then +/- levelDiff^2 / 2, floor of 2.
   */
  function rollStun(mob, defense, rng) {
    // Only the DEFENDER's StunImmunity matters (special_attacks.cpp:103) — a Stun Immune mob can still stun you.
    if (defense.stunImmune) return false;

    var chance = mob.level > 60 ? 40 : 45;
    var levelDiff = mob.level - defense.level;
    chance += levelDiff < 0
      ? -Math.floor(levelDiff * levelDiff / 2)
      : Math.floor(levelDiff * levelDiff / 2);
    if (chance < 2) chance = 2;

    if (rng() * 100 >= chance) return false;
    // Ogres cannot be stunned from the front.
    if (defense.frontalStunImmune) return false;
    if (defense.stunResistPct > 0 && rng() * 100 < defense.stunResistPct) return false;
    return true;
  }

  // ---- Rounds ---------------------------------------------------------------

  /**
   * Mob::DoMainHandRound — attack_count swings, then procs, then one double
   * attack check, and only on a successful double a 13.5% triple for
   * warriors/monks at 60+.
   *
   * `emit(swingOpts)` resolves and records a single swing; it is supplied by the
   * engine so every damage source flows through the same accounting.
   */
  function doMainHandRound(mob, rng, emit, damagePct) {
    var i;
    for (i = 0; i < mob.attackCount; i++) {
      emit({ source: 'mainhand', damagePct: damagePct });
    }

    emit({ source: 'proc', proc: true });

    if (mob.doubleAttackChance > 0 && rng() < mob.doubleAttackChance) {
      emit({ source: 'double', damagePct: damagePct });
      if (mob.hasTripleAttack && rng() * 1000 < 135) {
        emit({ source: 'triple', damagePct: damagePct });
      }
    }
  }

  /** Mob::DoOffHandRound — proc, one swing, plus a double at 150+ skill. */
  function doOffHandRound(mob, rng, emit, damagePct) {
    emit({ source: 'proc', proc: true, hand: 'offhand' });
    emit({ source: 'offhand', damagePct: damagePct });
    if (mob.offhandDoubleAttack && mob.doubleAttackChance > 0 && rng() < mob.doubleAttackChance) {
      emit({ source: 'offhandDouble', damagePct: damagePct });
    }
  }

  /**
   * Mob::Flurry — a full extra main-hand round plus an off-hand round, and it
   * fires the class attack twice on top.
   */
  function doFlurry(mob, rng, emit, emitClassAttack) {
    if (emitClassAttack) { emitClassAttack('flurry'); emitClassAttack('flurry'); }
    doMainHandRound(mob, rng, emit, 100);
    if (mob.dualWield) doOffHandRound(mob, rng, emit, 100);
  }

  /**
   * One rampage round against a single victim (a main-hand round plus an off-hand round if dual wielding),
   * scaled by the ability's damage percent. WHO it lands on is decided by the caller:
   *   Rampage (3)      — Mob::Rampage skips the mob's current target (mob_ai.cpp:2892), so it never hits the tank.
   *   AreaRampage (4)  — HateList::AreaRampage hits everyone in melee range except the main target, and hits the
   *                      main target only when the hate list has a single entry (hate_list.cpp:1861).
   * Either one also triggers the class-attack timer, so the NPC's kick/bash/backstab fires right away.
   */
  function doRampage(mob, rng, emit, damagePct) {
    doMainHandRound(mob, rng, emit, damagePct);
    if (mob.dualWield) doOffHandRound(mob, rng, emit, damagePct);
  }

  /**
   * NPC::DoClassAttacks — picks the attack and returns its reuse in ms so the
   * engine can reschedule. Returns null when the mob has no class attack.
   */
  function pickClassAttack(mob, rng) {
    var ca = mob.classAttack;
    if (!ca) return null;

    var skill = ca.skill;
    var reuseSec = ca.reuseSec;
    var skillLevel = ca.skillLevel;
    if (ca.altSkill && rng() * 100 < ca.altChance) {
      skill = ca.altSkill;
      reuseSec = ca.altReuseSec;
      skillLevel = ca.altSkillLevel != null ? ca.altSkillLevel : ca.skillLevel;
    }

    return {
      skill: skill,
      baseDamage: getSkillBaseDamage(skill, skillLevel),
      // Reuse is haste-scaled: reuse * 1000 / GetHaste() * 100.
      reuseMs: Math.max(1000, Math.floor(reuseSec * 1000 * 100 / mob.hastePctTotal))
    };
  }

  global.NpcCombat = {
    SpecialAbility: SA,
    CLASS: CLASS,
    STUN_DURATION_MS: STUN_DURATION_MS,
    ENRAGE_HP_PCT: ENRAGE_HP_PCT,
    ENRAGE_DURATION_MS: ENRAGE_DURATION_MS,
    ENRAGE_COOLDOWN_MS: ENRAGE_COOLDOWN_MS,

    parseSpecialAbilities: parseSpecialAbilities,
    hasAbility: hasAbility,
    abilityParam: abilityParam,
    describeSpecialAbilities: describeSpecialAbilities,

    getNpcSkillLevel: getNpcSkillLevel,
    getNpcWeaponSkill: getNpcWeaponSkill,
    getNpcClassAttack: getNpcClassAttack,
    getNpcDefenseSkills: getNpcDefenseSkills,
    getSkillBaseDamage: getSkillBaseDamage,

    getBaseDamage: getBaseDamage,
    getDamageBonus: getDamageBonus,
    getOffense: getOffense,
    getToHit: getToHit,
    getAttackDelayMs: getAttackDelayMs,
    getEffectiveHaste: getEffectiveHaste,

    buildMobProfile: buildMobProfile,
    resolveSwing: resolveSwing,
    rollDamage: rollDamage,
    rollStun: rollStun,

    doMainHandRound: doMainHandRound,
    doOffHandRound: doOffHandRound,
    doFlurry: doFlurry,
    doRampage: doRampage,
    pickClassAttack: pickClassAttack
  };

})(typeof window !== 'undefined' ? window : globalThis);
