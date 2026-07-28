/**
 * Tanking simulation engine for gSim.
 *
 * Simulates a mob attacking a player defender and reports how much damage per
 * second you take, plus how tight a Complete Heal chain has to be to keep you
 * alive.
 *
 * The mob does not run on a single fixed cadence. EQMacEmu drives combat from
 * several independent timers — main hand, off hand, class attacks, spell casting
 * — and modelling that properly is what lets flurry, rampage, dual wield, kicks,
 * nukes and DoTs contribute at all. So this is an event scheduler, not a loop
 * over attack rounds.
 *
 * Responsibilities are split:
 *   npcCombat.js     what the mob does (rounds, specials, class attacks, procs)
 *   playerDefense.js what you mitigate and avoid (AC, avoidance, discs, runes)
 *   npcSpells.js     what the mob casts at you
 *   healChain.js     the CH chain risk analysis
 *   combat.js        shared primitives (rollD20, getHitChance, calcMeleeDamage)
 */
(function (global) {
  'use strict';

  var CH_CAST_TIME_SEC = 10;
  var REGEN_TICK_MS = 6000;

  function getEQCombat()   { return global.EQCombat || null; }
  function getNpcCombat()  { return global.NpcCombat || null; }
  function getDefense()    { return global.PlayerDefense || null; }
  function getNpcSpells()  { return global.NpcSpells || null; }
  function getHealChain()  { return global.HealChain || null; }

  // ---------------------------------------------------------------------------
  // Riposte counter-attack
  // ---------------------------------------------------------------------------

  /** Player offense rating for the counter-attack, matching combat.js. */
  function getPlayerOffenseRating(offenseSkill, str, wornAttack, spellAttack) {
    var skill = offenseSkill != null ? Math.min(255, Math.max(0, offenseSkill)) : 200;
    var s = str != null ? str : 100;
    var strBonus = s >= 75 ? Math.floor((2 * s - 150) / 3) : 0;
    return Math.max(1, skill + strBonus + (wornAttack || 0) + (spellAttack || 0));
  }

  function getMobMitigation(mobLevel, mobAC) {
    var eq = getEQCombat();
    if (eq && eq.getMitigation) return eq.getMitigation(mobLevel, mobAC || 0, 0, 0);
    var L = mobLevel != null ? mobLevel : 60;
    var mit = L < 15 ? (L * 3 + (L < 3 ? 2 : 0)) : Math.floor(L * 41 / 10) - 15;
    if (mit > 200) mit = 200;
    if (mit === 200 && (mobAC || 0) > 200) mit = mobAC;
    return Math.max(1, mit);
  }

  /**
   * One riposte counter-attack. Unlike before, this goes through the mob's own
   * defences — DoRiposte calls defender->Attack(), which is a full attack and can
   * be blocked, parried, riposted, dodged or missed like any other swing.
   */
  function rollRiposteHit(ctx, rng, isReturnKick) {
    var o = ctx.options;
    var eq = getEQCombat();
    var mobDef = ctx.mobDefense;

    // The mob's avoidance chain.
    if (mobDef.skillAvoid > 0 && rng() < mobDef.skillAvoid) return { hit: false, damage: 0 };
    if (rng() >= mobDef.hitChance) return { hit: false, damage: 0 };

    if (!eq || !eq.calcMeleeDamage) {
      return { hit: true, damage: 1 + Math.floor(rng() * Math.max(1, o.playerWeaponDamage || 10)) };
    }

    var level = o.playerLevel != null ? o.playerLevel : 60;
    var classId = o.playerClassId || 'warrior';
    var offenseRating = getPlayerOffenseRating(
      o.playerOffenseSkill, o.playerStr, o.playerWornAttack, o.playerSpellAttack);

    var base, damageBonus;
    if (isReturnKick) {
      base = 29;               // flying kick skill base at capped skill
      damageBonus = 0;
    } else {
      base = o.playerWeaponDamage != null ? o.playerWeaponDamage : 10;
      damageBonus = eq.getDamageBonusClient
        ? eq.getDamageBonusClient(level, classId,
            o.playerWeaponDelay != null ? o.playerWeaponDelay : 30,
            !!o.playerWeaponIs2H)
        : 0;
    }

    // Defensive Discipline cuts your own melee output while it is up.
    var dmgMod = ctx.defense.damageModifierPct || 0;
    if (dmgMod) base = Math.max(1, base + Math.floor(base * dmgMod / 100));

    var dmg = eq.calcMeleeDamage(base, offenseRating, ctx.mobMitigation, rng, damageBonus);

    if (isReturnKick) dmg = Math.max(dmg, Math.floor(level * 4 / 5));

    if (eq.rollMeleeCrit) {
      var crit = eq.rollMeleeCrit(dmg, damageBonus, level, classId,
        o.playerDex != null ? o.playerDex : 150,
        o.playerCritChanceMult || 0, false, false, 0, false, rng);
      dmg = crit.damage;
    }

    return { hit: true, damage: Math.max(1, dmg) };
  }

  // ---------------------------------------------------------------------------
  // Main simulation
  // ---------------------------------------------------------------------------

  /**
   * @param {Object} options  see the tanking tab handler in index.html
   * @returns {Object} report, including a per-event damage timeline
   */
  function runTankingFight(options) {
    var NC = getNpcCombat();
    var PD = getDefense();
    var NS = getNpcSpells();
    var eq = getEQCombat();

    if (!NC || !PD) {
      return { error: 'Tanking modules failed to load (npcCombat.js / playerDefense.js).' };
    }

    var rng = (eq && eq.createRng)
      ? eq.createRng(options.seed)
      : (function () {
          var seed = options.seed != null ? options.seed : Date.now();
          return function () {
            seed = (seed * 1664525 + 1013904223) & 0xffffffff;
            return (seed >>> 0) / 0x100000000;
          };
        })();

    var era = options.era || 'pop';
    var durationMs = (options.fightDurationSec != null ? options.fightDurationSec : 60) * 1000;

    // ---- Mob ----
    var mob = NC.buildMobProfile({
      name: options.mobName,
      level: options.mobLevel,
      classId: options.mobClassId,
      minDamage: options.mobMinDamage,
      maxDamage: options.mobMaxDamage,
      attackDelay: options.mobAttackDelay,
      attackCount: options.mobAttackCount,
      ac: options.mobAC,
      atk: options.mobATK,
      accuracy: options.mobAccuracy,
      hp: options.mobHP,
      specialAbilities: options.mobSpecialAbilities,
      hastePct: options.mobHastePct,
      slowMitigation: options.mobSlowMitigation,
      disableDualWield: options.mobDisableDualWield,
      era: era
    });

    // ---- Player ----
    var hpTotal = options.playerHPTotal != null ? options.playerHPTotal : 4000;
    var ndRank = (options.naturalDurabilityRank | 0) || 0;
    var pdRank = (options.planarDurabilityRank | 0) || 0;
    var ND = [0, 0.02, 0.05, 0.10][Math.min(ndRank, 3)];
    var PDur = [0, 0.015, 0.030, 0.045][Math.min(pdRank, 3)];
    if (ND > 0) hpTotal = Math.floor(hpTotal * (1 + ND));
    if (PDur > 0) hpTotal = Math.floor(hpTotal * (1 + PDur));

    var AA_PCT = [0, 2, 5, 10];
    var combatStabilityPct = AA_PCT[Math.min((options.combatStabilityRank | 0) || 0, 3)];
    var combatAgilityPct   = AA_PCT[Math.min((options.combatAgilityRank   | 0) || 0, 3)];
    var innateDefensePct   = Math.min((options.innateDefenseRank    | 0) || 0, 5) * 2;
    var lightningReflexPct = Math.min((options.lightningReflexesRank | 0) || 0, 5) * 2;

    var defense = PD.build({
      level: options.playerLevel != null ? options.playerLevel : 60,
      classId: options.playerClassId || 'warrior',
      baseRace: options.playerRace,
      itemAC: options.playerAC,
      shieldAC: options.playerShieldAC,
      spellAC: options.playerSpellAC,
      defenseSkill: options.playerDefenseSkill,
      dodgeSkill: options.playerDodgeSkill,
      parrySkill: options.playerParrySkill,
      riposteSkill: options.playerRiposteSkill,
      blockSkill: options.playerBlockSkill,
      agi: options.playerAGI,
      carriedWeight: options.playerCarriedWeight,
      era: era,
      combatStabilityPct: combatStabilityPct,
      combatAgilityPct: combatAgilityPct,
      innateDefensePct: innateDefensePct,
      lightningReflexesPct: lightningReflexPct,
      meleeMitigationPct: options.buffMeleeMitigationPct,
      avoidMeleePct: options.buffAvoidMeleePct,
      runePool: options.runePool,
      damageShield: options.playerDamageShield,
      hpTotal: hpTotal,
      hasWeapon: options.playerWeaponDamage != null && options.playerWeaponDamage > 0,
      hasShield: !!options.playerShieldAC,
      mobToHit: mob.toHit
    });

    // ---- Mob's own defences, for the riposte counter-attack ----
    var mobSkills = NC.getNpcDefenseSkills(mob.classId, mob.level);
    var mobRates = PD.getAvoidanceRates({
      blockSkill: mobSkills.block, parrySkill: mobSkills.parry,
      riposteSkill: mobSkills.riposte, dodgeSkill: mobSkills.dodge
    });
    var mobAvoidance = (eq && eq.getAvoidanceNPC) ? eq.getAvoidanceNPC(mob.level) : mob.level * 9 + 5;
    mobAvoidance += mob.avoidance || 0;
    var playerToHit = 7 + (options.playerOffenseSkill || 200) + (options.playerWeaponSkill || 250);
    var mobDefense = {
      skillAvoid: PD.getCombinedAvoidanceChance(mobRates),
      hitChance: (eq && eq.getHitChance) ? eq.getHitChance(playerToHit, mobAvoidance) : 0.7
    };

    // ---- Mob spells ----
    var spellList = null;
    if (NS && options.mobSpellsId > 0 && options.enableMobSpells !== false) {
      spellList = NS.resolveSpellList(options.mobSpellsId, mob.level, mob.classId);
    }
    var playerResists = {
      mr: options.playerMR || 0, fr: options.playerFR || 0, cr: options.playerCR || 0,
      dr: options.playerDR || 0, pr: options.playerPR || 0
    };
    // Slow only ever lands on melee classes server-side (SpellType_Slow: IsWarriorClass()).
    var WARRIOR_CLASSES = {
      warrior: 1, rogue: 1, monk: 1, paladin: 1, shadowknight: 1, ranger: 1, beastlord: 1, bard: 1
    };
    var targetIsWarriorClass = !!WARRIOR_CLASSES[options.playerClassId];

    // ---- Report skeleton ----
    var report = createReport(mob, defense, options, hpTotal, era);
    report.spellListName = spellList ? spellList.name : null;
    report.attackProcName = spellList && spellList.attackProc ? spellList.attackProc.name : null;

    // ---- Fight state ----
    var ctx = {
      options: options,
      defense: defense,
      mobDefense: mobDefense,
      mobMitigation: getMobMitigation(mob.level, mob.ac),
      stunnedUntilMs: 0,
      mobEnraged: false,
      stunned: false
    };

    var doubleRiposteChance =
      [0, 0.15, 0.35, 0.50][Math.min((options.doubleRiposteRank | 0) || 0, 3)] +
      [0, 0.10, 0.20, 0.30][Math.min((options.flashOfSteelRank | 0) || 0, 3)];
    var returnKickChance = [0, 0.25, 0.35, 0.50][Math.min((options.returnKickRank | 0) || 0, 3)];

    var hp = hpTotal;
    var survivalMs = null;
    var timeline = [];               // {t, damage, source} — drives the CH analysis
    var now = 0;

    // Mob HP is only tracked when the caller supplies the group's DPS; without
    // it we have no idea when the mob would reach its enrage threshold.
    var groupDps = options.groupDps || 0;
    var mobHP = mob.hp || 0;
    var trackMobHP = groupDps > 0 && mobHP > 0;
    var enrageUsedUntilMs = -1;
    var enrageCooldownUntilMs = 0;

    // Active DoTs on the player: { damagePerTick, ticksLeft, nextTickMs, name }
    var activeDots = [];
    var spellRecast = {};

    // ---- Disciplines ----
    var discs = [];
    if (options.useDisciplines !== false) {
      var avail = PD.availableDisciplines(defense.classId, defense.level);
      var enabled = options.enabledDisciplines || avail.map(function (d) { return d.key; });
      avail.forEach(function (d) {
        if (enabled.indexOf(d.key) === -1) return;
        discs.push({ key: d.key, def: d, activeUntilMs: -1, readyAtMs: 0, uptimeMs: 0 });
      });
    }
    var activeDiscKeys = [];

    function refreshDiscEffects() {
      var keys = discs
        .filter(function (d) { return d.activeUntilMs > now; })
        .map(function (d) { return d.key; });
      if (keys.join(',') === activeDiscKeys.join(',')) return;
      activeDiscKeys = keys;
      PD.applyActiveEffects(defense, keys, {
        meleeMitigationPct: options.buffMeleeMitigationPct || 0,
        avoidMeleePct: options.buffAvoidMeleePct || 0
      });
    }

    // ---- Damage application ------------------------------------------------

    function takeDamage(amount, source) {
      if (amount <= 0) return;

      // Runes absorb before HP is touched (Mob::ReduceDamage inside CommonDamage).
      var after = amount;
      if (defense.runeRemaining > 0) {
        var r = PD.applyRune(defense, amount);
        after = r.damage;
        report.runeAbsorbed += r.absorbed;
        if (r.fullyAbsorbed) {
          report.runedSwings++;
          return;
        }
      }

      report.totalDamageTaken += after;
      report.damageBySource[source] = (report.damageBySource[source] || 0) + after;
      timeline.push({ t: now, damage: after, source: source });

      if (after > report.maxHitTaken) report.maxHitTaken = after;
      if (after < report.minHitTaken) report.minHitTaken = after;

      if (survivalMs === null) {
        hp -= after;
        if (hp <= 0) survivalMs = now;
      }
    }

    /** Player's damage shield fires back at the mob on every melee hit taken. */
    function applyDamageShield() {
      if (!defense.damageShield) return;
      report.damageShieldDamage += defense.damageShield;
      if (trackMobHP) mobHP -= defense.damageShield;
    }

    // ---- Swing emission ----------------------------------------------------

    /**
     * Resolve and account one swing. Every damage source — main hand, off hand,
     * flurry, rampage, class attacks — funnels through here so the breakdown and
     * the timeline stay consistent.
     */
    function emitSwing(opts) {
      opts = opts || {};

      // TryProcs rolls on the round regardless of whether the swing connects.
      if (opts.proc) {
        tryWeaponProc();
        return;
      }

      var source = opts.source || 'mainhand';
      report.swingAttempts++;
      report.swingsBySource[source] = (report.swingsBySource[source] || 0) + 1;

      ctx.stunned = now < ctx.stunnedUntilMs;

      var res = NC.resolveSwing(mob, defense, ctx, rng, {
        source: source,
        damagePct: opts.damagePct,
        baseDamage: opts.baseDamage,
        skill: opts.skill
      });

      switch (res.outcome) {
        case 'block':   report.blockedSwings++;  return;
        case 'parry':   report.parriedSwings++;  return;
        case 'dodge':   report.dodgedSwings++;   return;
        case 'miss':    report.missedSwings++;   return;
        case 'riposte':
          report.ripostedSwings++;
          doRiposteCounter();
          return;
      }

      report.landedSwings++;
      takeDamage(res.damage, source);
      applyDamageShield();

      if (res.stun) {
        report.stuns++;
        report.stunMsApplied += NC.STUN_DURATION_MS;
        ctx.stunnedUntilMs = now + NC.STUN_DURATION_MS;
      }
    }

    function doRiposteCounter() {
      if (!defense.hasWeapon) return;

      var r = rollRiposteHit(ctx, rng, false);
      report.riposteAttempts++;
      if (r.hit) {
        report.riposteDamageTotal += r.damage;
        report.riposteHits++;
        if (r.damage > report.riposteMaxHit) report.riposteMaxHit = r.damage;
        if (trackMobHP) mobHP -= r.damage;
      }

      if (doubleRiposteChance > 0 && rng() < doubleRiposteChance) {
        report.doubleRiposteHits++;
        var r2 = rollRiposteHit(ctx, rng, false);
        if (r2.hit) {
          report.riposteDamageTotal += r2.damage;
          if (r2.damage > report.riposteMaxHit) report.riposteMaxHit = r2.damage;
          if (trackMobHP) mobHP -= r2.damage;
        }
      }

      if (returnKickChance > 0 && rng() < returnKickChance) {
        report.returnKickHits++;
        var rk = rollRiposteHit(ctx, rng, true);
        if (rk.hit) {
          report.returnKickDamage += rk.damage;
          report.riposteDamageTotal += rk.damage;
          if (rk.damage > report.riposteMaxHit) report.riposteMaxHit = rk.damage;
          if (trackMobHP) mobHP -= rk.damage;
        }
      }
    }

    /** NPC weapon proc from npc_spells.attack_proc, rolled per round. */
    function tryWeaponProc() {
      if (!spellList || !spellList.attackProc) return;
      if (rng() >= spellList.attackProcChance) return;

      report.procCasts++;
      applySpellDamage({
        info: spellList.attackProc,
        resistAdjust: spellList.attackProc.resistDiff
      }, 'proc');
    }

    // ---- Spells ------------------------------------------------------------

    function applySpellDamage(spell, source) {
      var info = spell.info;
      var pct = 100;
      if (NS) {
        pct = NS.checkResist(spell, playerResists, defense.level, mob.level, rng);
      }
      if (pct <= 0) {
        report.spellsResisted++;
        return;
      }
      if (pct < 100) report.spellsPartial++;

      if (info.directDamage > 0) {
        takeDamage(Math.max(1, Math.floor(info.directDamage * pct / 100)), source || 'spell');
      }

      if (info.dotPerTick > 0 && info.durationTicks > 0) {
        activeDots.push({
          name: info.name,
          damagePerTick: Math.max(1, Math.floor(info.dotPerTick * pct / 100)),
          ticksLeft: info.durationTicks,
          nextTickMs: now + NS.TICK_MS
        });
      }

      if (info.stunMs > 0 && !defense.stunImmune) {
        report.stuns++;
        report.stunMsApplied += info.stunMs;
        ctx.stunnedUntilMs = Math.max(ctx.stunnedUntilMs, now + info.stunMs);
      }

      if (info.fearMs > 0) {
        report.fears++;
      }
    }

    // ---- Timers ------------------------------------------------------------

    var timers = {
      attack: 0,
      attackDW: mob.dualWield ? 0 : Infinity,
      classAttack: mob.classAttack ? 0 : Infinity,
      autocast: spellList ? 0 : Infinity,
      regen: REGEN_TICK_MS,
      dot: Infinity
    };
    var classAttackReadyMs = 0;

    function nextDotMs() {
      var min = Infinity;
      for (var i = 0; i < activeDots.length; i++) {
        if (activeDots[i].nextTickMs < min) min = activeDots[i].nextTickMs;
      }
      return min;
    }

    var netRegenPerSec = (options.playerHPRegen || 0) + (options.healerHPS || 0);

    // ---- Event loop --------------------------------------------------------

    var guard = 0;
    while (guard++ < 2000000) {
      timers.dot = nextDotMs();

      var nextKey = null;
      var nextT = Infinity;
      for (var key in timers) {
        if (timers[key] < nextT) { nextT = timers[key]; nextKey = key; }
      }
      if (nextKey === null || nextT >= durationMs) break;

      now = nextT;

      // Discipline management: fire Defensive/Evasive as soon as they are up.
      var discChanged = false;
      for (var di = 0; di < discs.length; di++) {
        var d = discs[di];
        if (d.activeUntilMs > now) continue;
        if (d.activeUntilMs > 0 && d.activeUntilMs <= now) discChanged = true;
        if (now >= d.readyAtMs) {
          d.activeUntilMs = now + d.def.durationMs;
          d.readyAtMs = now + d.def.reuseMs;
          d.uptimeMs += d.def.durationMs;
          report.disciplineUses[d.key] = (report.disciplineUses[d.key] || 0) + 1;
          discChanged = true;
        }
      }
      if (discChanged) refreshDiscEffects();

      // Enrage: below the HP threshold the mob cannot be riposted.
      if (trackMobHP) {
        mobHP -= groupDps * ((now - (report._lastDpsMs || 0)) / 1000);
        report._lastDpsMs = now;
        var hpPct = mob.hp > 0 ? (mobHP / mob.hp) * 100 : 100;
        if (mob.canEnrage && hpPct <= NC.ENRAGE_HP_PCT &&
            now >= enrageCooldownUntilMs && enrageUsedUntilMs < now) {
          enrageUsedUntilMs = now + NC.ENRAGE_DURATION_MS;
          enrageCooldownUntilMs = now + NC.ENRAGE_COOLDOWN_MS;
          report.enrageWindows++;
        }
        ctx.mobEnraged = now < enrageUsedUntilMs;
      }

      switch (nextKey) {
        case 'attack': {
          report.rounds++;
          var specialed = false;

          NC.doMainHandRound(mob, rng, emitSwing, 100);

          if (mob.flurryChance > 0 && rng() < mob.flurryChance) {
            report.flurries++;
            NC.doFlurry(mob, rng, emitSwing, function () { doClassAttack(true); });
            specialed = true;
          }
          if (!specialed && mob.rampageChance > 0 && rng() < mob.rampageChance) {
            report.rampages++;
            NC.doRampage(mob, rng, emitSwing, mob.rampageDamagePct);
            specialed = true;
          }
          if (!specialed && mob.areaRampageChance > 0 && rng() < mob.areaRampageChance) {
            report.rampages++;
            NC.doRampage(mob, rng, emitSwing, mob.areaRampageDamagePct);
          }

          timers.attack = now + mob.attackDelayMs;
          break;
        }

        case 'attackDW':
          // CheckDualWield rolls per tick — having the ability doesn't mean
          // the off hand swings every time the timer fires.
          if (rng() < mob.dualWieldChance) {
            NC.doOffHandRound(mob, rng, emitSwing, 100);
          }
          timers.attackDW = now + mob.attackDelayMs;
          break;

        case 'classAttack':
          doClassAttack(false);
          break;

        case 'autocast': {
          var roll = NS ? NS.rollCast(spellList, rng, spellRecast, now, targetIsWarriorClass) : null;
          if (roll && roll.cast) {
            report.spellCasts++;
            var castName = roll.spell.info.name;
            report.spellCastsByName[castName] = (report.spellCastsByName[castName] || 0) + 1;
            applySpellDamage(roll.spell, 'spell');
          }
          timers.autocast = now + (roll ? roll.nextCheckMs : 2000);
          break;
        }

        case 'regen':
          if (netRegenPerSec > 0 && survivalMs === null) {
            hp = Math.min(hpTotal, hp + netRegenPerSec * (REGEN_TICK_MS / 1000));
          }
          timers.regen = now + REGEN_TICK_MS;
          break;

        case 'dot': {
          for (var k = activeDots.length - 1; k >= 0; k--) {
            var dot = activeDots[k];
            if (dot.nextTickMs > now) continue;
            takeDamage(dot.damagePerTick, 'dot');
            dot.ticksLeft--;
            dot.nextTickMs = now + NS.TICK_MS;
            if (dot.ticksLeft <= 0) activeDots.splice(k, 1);
          }
          break;
        }
      }
    }

    function doClassAttack(fromFlurry) {
      var pick = NC.pickClassAttack(mob, rng);
      if (!pick) { timers.classAttack = Infinity; return; }

      report.classAttacks++;
      emitSwing({
        source: 'classattack',
        baseDamage: pick.baseDamage,
        skill: pick.skill
      });

      if (!fromFlurry) {
        classAttackReadyMs = now + pick.reuseMs;
        timers.classAttack = classAttackReadyMs;
      }
    }

    // ---- Summary -----------------------------------------------------------

    var durationSec = durationMs / 1000;
    if (report.minHitTaken === Infinity) report.minHitTaken = null;

    report.timeline = timeline;
    report.durationSec = durationSec;
    report.dtps = durationSec > 0 ? report.totalDamageTaken / durationSec : 0;
    report.effectiveDtps = Math.max(0, report.dtps - netRegenPerSec);
    report.riposteDps = durationSec > 0 ? report.riposteDamageTotal / durationSec : 0;
    report.damageShieldDps = durationSec > 0 ? report.damageShieldDamage / durationSec : 0;
    report.survivalTimeSec = survivalMs !== null ? survivalMs / 1000 : null;
    report.died = survivalMs !== null;

    var avoided = report.missedSwings + report.dodgedSwings + report.parriedSwings +
                  report.ripostedSwings + report.blockedSwings;
    report.avoidanceRate = report.swingAttempts > 0 ? avoided / report.swingAttempts : 0;

    // Mitigation is a melee statistic — folding spell and DoT damage into it
    // produces nonsense (readings above 100% or below 0%).
    var meleeDamage = 0;
    ['mainhand', 'offhand', 'offhandDouble', 'double', 'triple', 'classattack'].forEach(function (s) {
      meleeDamage += report.damageBySource[s] || 0;
    });
    report.meleeDamageTaken = meleeDamage;
    report.spellDamageTaken = report.totalDamageTaken - meleeDamage;

    var theoreticalMax = mob.maxDamage * report.landedSwings;
    report.mitigationPercent = theoreticalMax > 0
      ? (1 - meleeDamage / theoreticalMax) * 100 : 0;

    if (netRegenPerSec > 0 && report.effectiveDtps > 0) {
      report.survivalTimeWithHealsSec = hpTotal / report.effectiveDtps;
    } else if (report.effectiveDtps <= 0) {
      report.survivalTimeWithHealsSec = Infinity;
    } else {
      report.survivalTimeWithHealsSec = hpTotal / report.dtps;
    }

    discs.forEach(function (d) {
      report.disciplineUptime[d.key] = durationMs > 0
        ? Math.min(1, d.uptimeMs / durationMs) : 0;
    });

    return report;
  }

  function createReport(mob, defense, options, hpTotal, era) {
    return {
      mobName: mob.name,
      mobLevel: mob.level,
      mobClassId: mob.classId,
      mobMinDamage: mob.minDamage,
      mobMaxDamage: mob.maxDamage,
      mobDamageBonus: mob.damageBonus,
      mobBaseDamage: mob.baseDamage,
      mobAttackDelayMs: mob.attackDelayMs,
      mobAttackCount: mob.attackCount,
      mobDoubleAttackChance: mob.doubleAttackChance,
      mobHasTripleAttack: mob.hasTripleAttack,
      mobDualWield: mob.dualWield,
      mobDualWieldChance: mob.dualWieldChance,
      mobFlurryChance: mob.flurryChance,
      mobRampageChance: mob.rampageChance,
      mobToHit: mob.toHit,
      mobOffenseRating: mob.offense,
      mobAC: mob.ac,
      mobSpecialAbilityNames: mob.specialAbilityNames,
      mobClassAttack: mob.classAttack ? mob.classAttack.skill : null,
      mobHastePct: mob.hastePctTotal - 100,

      playerLevel: defense.level,
      playerClassId: defense.classId,
      playerAC: options.playerAC,
      playerShieldAC: options.playerShieldAC || 0,
      playerSpellAC: options.playerSpellAC,
      acBreakdown: defense.acBreakdown,
      playerAvoidance: defense.avoidance,
      playerMitigation: defense.mitigation,
      playerHPTotal: hpTotal,
      playerHPRegen: options.playerHPRegen || 0,
      healerHPS: options.healerHPS || 0,
      era: era,

      hitChance: defense.hitChance,
      missChance: Math.max(0, 1 - defense.hitChance),
      dodgeRate: defense.rates.dodge,
      parryRate: defense.rates.parry,
      riposteRate: defense.rates.riposte,
      blockRate: defense.rates.block,
      skillAvoidanceRate: defense.skillAvoidanceRate,

      rounds: 0,
      swingAttempts: 0,
      missedSwings: 0,
      dodgedSwings: 0,
      parriedSwings: 0,
      ripostedSwings: 0,
      blockedSwings: 0,
      landedSwings: 0,
      runedSwings: 0,
      stuns: 0,
      stunMsApplied: 0,
      fears: 0,
      flurries: 0,
      rampages: 0,
      classAttacks: 0,
      spellCasts: 0,
      spellCastsByName: {},
      procCasts: 0,
      spellsResisted: 0,
      spellsPartial: 0,
      enrageWindows: 0,

      totalDamageTaken: 0,
      maxHitTaken: 0,
      minHitTaken: Infinity,
      runeAbsorbed: 0,
      damageBySource: {},
      swingsBySource: {},

      riposteAttempts: 0,
      riposteHits: 0,
      riposteDamageTotal: 0,
      riposteMaxHit: 0,
      doubleRiposteHits: 0,
      returnKickHits: 0,
      returnKickDamage: 0,
      damageShieldDamage: 0,

      disciplineUses: {},
      disciplineUptime: {},

      dtps: 0,
      effectiveDtps: 0,
      survivalTimeSec: null,
      avoidanceRate: 0,
      mitigationPercent: 0,
      riposteDps: 0,
      timeline: []
    };
  }

  // ---------------------------------------------------------------------------
  // Multi-run driver
  // ---------------------------------------------------------------------------

  /**
   * Run the fight N times and aggregate. Survival is reported as a death *rate*
   * plus a distribution — averaging "time of death" over only the runs that died
   * (as this used to) makes a character who dies once in twenty runs look as
   * fragile as one who dies every time.
   */
  function runTankingAnalysis(options, runs) {
    var n = Math.max(1, runs || 1);
    var reports = [];
    for (var i = 0; i < n; i++) {
      var r = runTankingFight(Object.assign({}, options, { seed: (options.seed || 1) + i * 7919 }));
      if (r.error) return r;
      reports.push(r);
    }

    var agg = averageReports(reports);
    agg.runs = n;
    // Averaging smooths spikes away by design (that's the whole point of an
    // average), so a "how spikey can this get" chart needs one real run's
    // actual hit-by-hit timeline, not the aggregate. The first run (fixed
    // seed = options.seed) is picked for reproducibility — re-running the
    // same inputs shows the same chart.
    agg.sampleTimeline = reports[0].timeline;

    var HC = getHealChain();
    if (HC) {
      agg.chChain = HC.analyze(
        reports.map(function (r) { return r.timeline; }),
        {
          hpTotal: agg.playerHPTotal,
          castTimeSec: options.chCastTimeSec != null ? options.chCastTimeSec : CH_CAST_TIME_SEC,
          regenPerSec: (options.playerHPRegen || 0) + (options.healerHPS || 0),
          durationMs: agg.durationSec * 1000
        }
      );
      agg.chRiskTable = HC.riskTable(agg.chChain);
    }

    return agg;
  }

  var SUM_KEYS = [
    'rounds', 'swingAttempts', 'missedSwings', 'dodgedSwings', 'parriedSwings',
    'ripostedSwings', 'blockedSwings', 'landedSwings', 'runedSwings', 'stuns', 'stunMsApplied', 'fears',
    'flurries', 'rampages', 'classAttacks', 'spellCasts', 'procCasts',
    'spellsResisted', 'spellsPartial', 'enrageWindows', 'totalDamageTaken',
    'runeAbsorbed', 'riposteAttempts', 'riposteHits', 'riposteDamageTotal',
    'doubleRiposteHits', 'returnKickHits', 'returnKickDamage',
    'damageShieldDamage', 'dtps', 'effectiveDtps', 'riposteDps',
    'damageShieldDps', 'avoidanceRate', 'mitigationPercent',
    'meleeDamageTaken', 'spellDamageTaken'
  ];

  function averageReports(reports) {
    var n = reports.length;
    var out = Object.assign({}, reports[0]);

    SUM_KEYS.forEach(function (k) {
      var total = 0;
      for (var i = 0; i < n; i++) total += (reports[i][k] || 0);
      out[k] = total / n;
    });

    out.maxHitTaken = Math.max.apply(null, reports.map(function (r) { return r.maxHitTaken; }));
    out.minHitTaken = Math.min.apply(null, reports
      .map(function (r) { return r.minHitTaken; })
      .filter(function (v) { return v != null; }));
    if (!isFinite(out.minHitTaken)) out.minHitTaken = null;
    out.riposteMaxHit = Math.max.apply(null, reports.map(function (r) { return r.riposteMaxHit; }));

    // Per-source totals
    out.damageBySource = {};
    out.swingsBySource = {};
    out.spellCastsByName = {};
    reports.forEach(function (r) {
      for (var s in r.damageBySource) {
        out.damageBySource[s] = (out.damageBySource[s] || 0) + r.damageBySource[s] / n;
      }
      for (var s2 in r.swingsBySource) {
        out.swingsBySource[s2] = (out.swingsBySource[s2] || 0) + r.swingsBySource[s2] / n;
      }
      for (var s3 in r.spellCastsByName) {
        out.spellCastsByName[s3] = (out.spellCastsByName[s3] || 0) + r.spellCastsByName[s3] / n;
      }
    });

    var deaths = reports.filter(function (r) { return r.died; });
    out.deathRate = deaths.length / n;
    out.deaths = deaths.length;
    if (deaths.length) {
      var times = deaths.map(function (r) { return r.survivalTimeSec; }).sort(function (a, b) { return a - b; });
      out.survivalTimeSec = times[Math.floor(times.length / 2)];   // median
      out.survivalTimeMinSec = times[0];
      out.survivalTimeMaxSec = times[times.length - 1];
    } else {
      out.survivalTimeSec = null;
      out.survivalTimeMinSec = null;
      out.survivalTimeMaxSec = null;
    }

    out.timeline = null;   // per-run timelines are not meaningful once averaged
    return out;
  }

  // ---------------------------------------------------------------------------
  // Report formatting
  // ---------------------------------------------------------------------------

  var SOURCE_LABEL = {
    mainhand: 'Main hand', offhand: 'Off hand', offhandDouble: 'Off-hand double attack',
    double: 'Double attack', triple: 'Triple attack', classattack: 'Kick / Bash',
    spell: 'Spells', dot: 'Damage over time', proc: 'Weapon procs'
  };

  function formatTankingReport(report, runsAveraged) {
    if (report.error) return report.error;
    var runs = runsAveraged != null ? runsAveraged : (report.runs || 1);
    var C = 50;
    function pad(label, value) {
      return label + ' '.repeat(Math.max(1, C - label.length)) + value;
    }
    function fmt(v, d) {
      if (v == null || v === Infinity) return '—';
      return d != null ? Number(v).toFixed(d) : (Number.isInteger(v) ? String(v) : Number(v).toFixed(2));
    }
    function pct(v, d) {
      return v == null ? '—' : fmt(v * 100, d != null ? d : 1) + '%';
    }

    var lines = [];

    // ---- Mob ----
    lines.push('=== Mob (Attacker) ===', '');
    lines.push(pad('  Mob:', report.mobName));
    lines.push(pad('  Level:', String(report.mobLevel)));
    lines.push(pad('  Damage range:', report.mobMinDamage + ' – ' + report.mobMaxDamage +
      '  (DI ' + report.mobBaseDamage + ', DB +' + report.mobDamageBonus + ')'));
    lines.push(pad('  Attack speed:', fmt(report.mobAttackDelayMs / 1000, 2) + ' sec' +
      (report.mobHastePct ? '  (' + (report.mobHastePct > 0 ? '+' : '') + fmt(report.mobHastePct, 0) + '% haste)' : '')));
    lines.push(pad('  Attacks per round:', String(report.mobAttackCount)));
    lines.push(pad('  Double attack chance:', pct(report.mobDoubleAttackChance, 1) +
      (report.mobHasTripleAttack ? '  (+13.5% triple on a double)' : '')));
    if (report.mobDualWield) {
      lines.push(pad('  Dual wield:', 'Yes — separate off-hand round, ' +
        fmt(report.mobDualWieldChance * 100, 1) + '% chance per tick'));
    }
    if (report.mobFlurryChance > 0) lines.push(pad('  Flurry chance:', pct(report.mobFlurryChance, 0) + '  (full extra round)'));
    if (report.mobRampageChance > 0) lines.push(pad('  Rampage chance:', pct(report.mobRampageChance, 0)));
    if (report.mobClassAttack) lines.push(pad('  Class attack:', report.mobClassAttack));
    if (report.spellListName) lines.push(pad('  Spell list:', report.spellListName));
    if (report.mobSpecialAbilityNames && report.mobSpecialAbilityNames.length) {
      lines.push(pad('  Special abilities:', report.mobSpecialAbilityNames.join(', ')));
    }
    lines.push(pad('  Calculated to-hit:', String(report.mobToHit)));
    lines.push(pad('  Offense rating:', String(report.mobOffenseRating)));
    if (runs > 1) lines.push(pad('  Runs averaged:', String(runs)));
    lines.push('');

    // ---- Player Defense ----
    lines.push('=== Player Defense ===', '');
    lines.push(pad('  Level / class:', report.playerLevel + ' ' + report.playerClassId));
    var bd = report.acBreakdown;
    if (bd) {
      lines.push(pad('  Worn AC (raw):', String(bd.itemACRaw)));
      lines.push(pad('  Item AC after \xd74/3:', String(bd.itemACScaled) +
        (bd.antiTwinkCap != null ? '  ← anti-twink cap ' + bd.antiTwinkCap : '')));
      if (bd.classBonus) lines.push(pad('  Class AC bonus:', String(bd.classBonus)));
      if (bd.racialBonus) lines.push(pad('  Iksar natural armour:', String(bd.racialBonus)));
      lines.push(pad('  Defense skill contribution:', String(bd.defenseContrib)));
      lines.push(pad('  Spell/buff AC contribution:', String(bd.spellContrib)));
      lines.push(pad('  AGI contribution:', String(bd.agiContrib)));
      lines.push(pad('  Pre-cap total:', String(bd.preCap)));
      lines.push(pad('  Softcap:', String(bd.softcap) +
        (bd.softcapAfterAA !== bd.softcapBase ? '  (base ' + bd.softcapBase + ' + Combat Stability)' : '') +
        (bd.shieldAC ? '  + ' + bd.shieldAC + ' shield AC' : '')));
      if (bd.overcap > 0) {
        lines.push(pad('  Over softcap:', bd.overcap + ' at 1:' + bd.returns + ' returns'));
      }
      lines.push(pad('  Final mitigation value:', String(bd.final)));
    }
    lines.push(pad('  Avoidance value:', String(report.playerAvoidance)));
    lines.push(pad('  Max HP:', String(report.playerHPTotal)));
    if (report.playerHPRegen) lines.push(pad('  HP regen/sec:', fmt(report.playerHPRegen, 1)));
    if (report.healerHPS) lines.push(pad('  Healer HPS:', fmt(report.healerHPS, 1)));
    if (report.disciplineUptime && Object.keys(report.disciplineUptime).length) {
      var PDmod = getDefense();
      for (var dk in report.disciplineUptime) {
        var discDef = PDmod && PDmod.DISCIPLINES[dk];
        lines.push(pad('  ' + (discDef ? discDef.name : dk) + ' uptime:',
          pct(report.disciplineUptime[dk], 0)));
      }
    }
    lines.push('');

    // ---- Avoidance ----
    lines.push('=== Avoidance ===', '');
    lines.push(pad('  Miss chance:', pct(report.missChance, 1)));
    lines.push(pad('  Block / Parry / Riposte / Dodge:',
      pct(report.blockRate, 1) + ' / ' + pct(report.parryRate, 1) + ' / ' +
      pct(report.riposteRate, 1) + ' / ' + pct(report.dodgeRate, 1)));
    lines.push(pad('  Combined skill avoidance:', pct(report.skillAvoidanceRate, 1)));
    lines.push('');
    lines.push('  -- Simulated --');
    lines.push(pad('  Total swings taken:', fmt(report.swingAttempts, 0)));
    function row(label, v) {
      return pad('  ' + label + ':', fmt(v, 0) + '  (' +
        pct(report.swingAttempts ? v / report.swingAttempts : 0, 1) + ')');
    }
    lines.push(row('Missed', report.missedSwings));
    lines.push(row('Dodged', report.dodgedSwings));
    lines.push(row('Parried', report.parriedSwings));
    lines.push(row('Riposted', report.ripostedSwings));
    lines.push(row('Blocked', report.blockedSwings));
    if (report.runedSwings > 0) lines.push(row('Fully absorbed by rune', report.runedSwings));
    lines.push(row('Landed', report.landedSwings));
    lines.push(pad('  Overall avoidance rate:', pct(report.avoidanceRate, 1)));
    lines.push('');

    // ---- Damage taken ----
    lines.push('=== Damage Taken ===', '');
    lines.push(pad('  DTPS:', fmt(report.dtps, 2)));
    if (report.healerHPS || report.playerHPRegen) {
      lines.push(pad('  Effective DTPS (after regen/heals):', fmt(report.effectiveDtps, 2)));
    }
    lines.push(pad('  Total damage taken:', fmt(report.totalDamageTaken, 0)));
    lines.push(pad('  Max hit taken:', fmt(report.maxHitTaken, 0)));
    lines.push(pad('  Min hit taken:', report.minHitTaken != null ? fmt(report.minHitTaken, 0) : '—'));
    lines.push(pad('  Melee mitigation vs mob max hit:', fmt(report.mitigationPercent, 1) + '%'));
    if (report.runeAbsorbed > 0) lines.push(pad('  Absorbed by runes:', fmt(report.runeAbsorbed, 0)));
    lines.push('');

    var sources = Object.keys(report.damageBySource || {});
    if (sources.length) {
      lines.push('  -- Where the damage came from --');
      sources.sort(function (a, b) { return report.damageBySource[b] - report.damageBySource[a]; });
      sources.forEach(function (s) {
        var amt = report.damageBySource[s];
        var label = SOURCE_LABEL[s] || s;
        if (s === 'proc' && report.attackProcName) label += ' (' + report.attackProcName + ')';
        lines.push(pad('  ' + label + ':', fmt(amt, 0) +
          '  (' + pct(report.totalDamageTaken ? amt / report.totalDamageTaken : 0, 1) + ')'));
      });
      lines.push('');
    }

    if (report.spellCasts > 0 || report.procCasts > 0) {
      lines.push('  -- Mob casting --');
      lines.push(pad('  Spells cast:', fmt(report.spellCasts, 0)));
      if (report.procCasts > 0) {
        var procLabel = report.attackProcName
          ? '  Weapon procs (' + report.attackProcName + '):'
          : '  Weapon procs:';
        lines.push(pad(procLabel, fmt(report.procCasts, 0)));
      }
      lines.push(pad('  Fully resisted:', fmt(report.spellsResisted, 0)));
      lines.push(pad('  Partially resisted:', fmt(report.spellsPartial, 0)));

      var castNames = Object.keys(report.spellCastsByName || {});
      if (castNames.length) {
        lines.push('');
        lines.push(pad('  Spells cast by name:', ''));
        castNames.sort(function (a, b) { return report.spellCastsByName[b] - report.spellCastsByName[a]; });
        castNames.forEach(function (name) {
          lines.push(pad('    ' + name + ':', fmt(report.spellCastsByName[name], 0)));
        });
      }
      lines.push('');
    }

    if (report.flurries > 0 || report.rampages > 0 || report.classAttacks > 0 || report.stuns > 0 || report.fears > 0) {
      lines.push('  -- Special attacks --');
      if (report.flurries > 0) lines.push(pad('  Flurries:', fmt(report.flurries, 0)));
      if (report.rampages > 0) lines.push(pad('  Rampages:', fmt(report.rampages, 0)));
      if (report.classAttacks > 0) lines.push(pad('  Kicks / bashes:', fmt(report.classAttacks, 0)));
      if (report.stuns > 0) {
        lines.push(pad('  Times stunned:', fmt(report.stuns, 0) +
          '  (' + fmt(report.stunMsApplied / 1000, 1) + 's total)'));
      }
      if (report.fears > 0) lines.push(pad('  Times feared:', fmt(report.fears, 0)));
      if (report.enrageWindows > 0) lines.push(pad('  Enrage windows:', fmt(report.enrageWindows, 0)));
      lines.push('');
    }

    // ---- Riposte ----
    lines.push('=== Riposte Counter-Damage ===', '');
    if (report.ripostedSwings < 1) {
      lines.push('  No ripostes landed.');
    } else {
      lines.push(pad('  Ripostes triggered:', fmt(report.ripostedSwings, 0)));
      lines.push(pad('  Counter-attacks that connected:', fmt(report.riposteHits, 0) + ' of ' +
        fmt(report.riposteAttempts, 0) + '  (the mob can avoid these too)'));
      if (report.doubleRiposteHits > 0) lines.push(pad('  Double Riposte extra hits:', fmt(report.doubleRiposteHits, 0)));
      if (report.returnKickHits > 0) lines.push(pad('  Return Kick hits:', fmt(report.returnKickHits, 0)));
      lines.push(pad('  Total riposte damage:', fmt(report.riposteDamageTotal, 0)));
      lines.push(pad('  Riposte DPS:', fmt(report.riposteDps, 2)));
      lines.push(pad('  Max riposte hit:', fmt(report.riposteMaxHit, 0)));
    }
    if (report.damageShieldDamage > 0) {
      lines.push(pad('  Damage shield damage:', fmt(report.damageShieldDamage, 0) +
        '  (' + fmt(report.damageShieldDps, 2) + ' DPS)'));
    }
    lines.push('');

    // ---- Survivability ----
    lines.push('=== Survivability (no Complete Heals) ===', '');
    if (report.deathRate != null) {
      lines.push(pad('  Death rate across runs:', pct(report.deathRate, 0) +
        '  (' + report.deaths + ' of ' + runs + ')'));
    }
    if (report.survivalTimeSec != null) {
      lines.push(pad('  Median time to death:', fmt(report.survivalTimeSec, 1) + ' sec'));
      if (report.survivalTimeMinSec != null && report.survivalTimeMaxSec != null) {
        lines.push(pad('  Range:', fmt(report.survivalTimeMinSec, 1) + ' – ' +
          fmt(report.survivalTimeMaxSec, 1) + ' sec'));
      }
    } else {
      lines.push(pad('  Survived every run:', fmt(report.durationSec, 0) + ' sec, unhealed'));
    }
    lines.push('');

    // ---- CH chain ----
    lines.push(formatCHChain(report, fmt, pct, pad));

    return lines.join('\n');
  }

  function formatCHChain(report, fmt, pct, pad) {
    var ch = report.chChain;
    var lines = ['=== Complete Heal Chain ===', ''];

    if (!ch || ch.noDamage) {
      lines.push('  No damage taken — no chain needed.');
      return lines.join('\n');
    }

    lines.push(pad('  CH cast time:', fmt(ch.castTimeSec, 0) + ' sec'));
    lines.push(pad('  Tank max HP:', fmt(ch.hpTotal, 0)));
    lines.push(pad('  Mean DTPS:', fmt(ch.meanDtps, 2)));
    lines.push('');

    if (ch.maxSafeIntervalSec > 0) {
      lines.push(pad('  Max safe CH interval:', fmt(ch.maxSafeIntervalSec, 2) + ' sec' +
        '  ← under ' + pct(ch.riskThreshold, 0) + ' chance of death'));
      lines.push(pad('  Clerics needed:', String(ch.clericsNeeded) +
        '  (' + fmt(ch.castTimeSec, 0) + 's cast ÷ ' + fmt(ch.maxSafeIntervalSec, 2) + 's interval)'));
    } else {
      lines.push('  No CH interval tested was safe — this mob out-damages a CH chain');
      lines.push('  on this character. More mitigation, a slow, or fewer swings taken is needed.');
    }
    lines.push(pad('  CH call threshold:', fmt(ch.callThresholdHP, 0) + ' HP' +
      '  ← start casting at this HP'));
    lines.push('  └ Sized from the 99th-percentile damage over one cast, not the average.');
    lines.push('');

    var b = ch.burstAtCastTime;
    lines.push('  -- Burst damage within one ' + fmt(ch.castTimeSec, 0) + '-second cast --');
    lines.push(pad('  Median:', fmt(b.p50, 0)));
    lines.push(pad('  95th percentile:', fmt(b.p95, 0)));
    lines.push(pad('  99th percentile:', fmt(b.p99, 0)));
    lines.push(pad('  Worst seen:', fmt(b.max, 0) +
      (b.max >= ch.hpTotal ? '  ← exceeds your max HP' : '')));
    lines.push('');

    if (report.chRiskTable && report.chRiskTable.length) {
      lines.push('  -- Death risk by chain interval --');
      report.chRiskTable.forEach(function (r) {
        lines.push(pad('  ' + pct(r.deathRate, 0) + ' risk:', 'CH every ' + fmt(r.intervalSec, 2) + ' sec or faster'));
      });
      lines.push('');
    }

    if (isFinite(ch.naiveIntervalSec)) {
      lines.push(pad('  For comparison, HP ÷ mean DTPS:', fmt(ch.naiveIntervalSec, 2) + ' sec'));
      if (ch.maxSafeIntervalSec > 0 && ch.naiveIntervalSec > ch.maxSafeIntervalSec * 1.15) {
        lines.push('  └ The averaged figure is optimistic here: burst damage kills sooner.');
      }
    }

    return lines.join('\n');
  }

  // ---------------------------------------------------------------------------
  // DTPS-over-time line chart
  // ---------------------------------------------------------------------------
  // Same bucketed-line-plus-rolling-average approach as rotationEngine.js's
  // buildRotationDpsOverTimeHtml, duplicated rather than shared since the two
  // modules have no other coupling and the inputs differ (a single damage-
  // taken timeline here vs. a cast log there).

  var DTPS_LINE_COLOR = '#3987e5';      // categorical slot 1 — bucketed (instantaneous) DTPS
  var DTPS_ROLLING_COLOR = '#d95926';   // categorical slot 2 — rolling window average
  var DTPS_SPIKE_COLOR = '#fab219';     // status palette: marks the single largest hit
  var DTPS_MUTED_INK = '#898781';
  var DTPS_GRID_COLOR = '#2c2c2a';
  var DTPS_ROLL_WINDOW_SEC = 15;

  function dtpsEscapeXml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /** Trailing N-second average DTPS at each of a sorted list of times, from a sorted-by-time timeline. */
  function dtpsRollingAverageSeries(events, times, windowSec) {
    var qStart = 0, qEnd = 0, windowSum = 0;
    return times.map(function (t) {
      while (qEnd < events.length && events[qEnd].t <= t) { windowSum += events[qEnd].damage; qEnd++; }
      var windowStart = t - windowSec;
      while (qStart < qEnd && events[qStart].t <= windowStart) { windowSum -= events[qStart].damage; qStart++; }
      var elapsed = Math.min(windowSec, t) || 1;
      return windowSum / elapsed;
    });
  }

  /**
   * Bucketed damage-taken-per-second across one representative simulated run
   * (report.sampleTimeline — see runTankingAnalysis), so burst/spike shape is
   * visible instead of buried in the averaged headline DTPS figure. The
   * averaged DTPS across all N runs is drawn as a dashed reference line for
   * comparison against this one run's actual shape.
   */
  function buildDtpsOverTimeHtml(report) {
    if (!report || !report.sampleTimeline || !report.sampleTimeline.length || !(report.durationSec > 0)) {
      return '<p class="hint" style="margin:0;">No damage timeline to chart.</p>';
    }

    // timeline entries carry `t` in milliseconds (the engine's internal event
    // clock — see runTankingFight's `now`); convert to seconds up front so
    // the rest of this function can work in the same units as durationSec.
    var events = report.sampleTimeline
      .map(function (e) { return { t: e.t / 1000, damage: e.damage, source: e.source }; })
      .sort(function (a, b) { return a.t - b.t; });
    var durationSec = report.durationSec;

    var TARGET_BUCKETS = 120;
    var bucketWidth = Math.max(0.25, durationSec / TARGET_BUCKETS);
    var bucketCount = Math.ceil(durationSec / bucketWidth);

    var buckets = new Array(bucketCount).fill(0);
    events.forEach(function (e) {
      var idx = Math.min(bucketCount - 1, Math.max(0, Math.floor(e.t / bucketWidth)));
      buckets[idx] += e.damage;
    });

    var points = buckets.map(function (dmg, i) {
      var start = i * bucketWidth;
      var end = Math.min(durationSec, start + bucketWidth);
      var w = Math.max(0.001, end - start);
      return { t: start + w / 2, dtps: dmg / w, start: start, end: end };
    });

    var rollingDtps = dtpsRollingAverageSeries(events, points.map(function (p) { return p.t; }), DTPS_ROLL_WINDOW_SEC);

    var maxDtps = 0;
    points.forEach(function (p) { if (p.dtps > maxDtps) maxDtps = p.dtps; });
    rollingDtps.forEach(function (v) { if (v > maxDtps) maxDtps = v; });
    maxDtps = maxDtps > 0 ? maxDtps * 1.15 : 1;

    var W = 780, H = 200;
    var marginLeft = 48, marginRight = 12, marginTop = 12, marginBottom = 22;
    var plotW = W - marginLeft - marginRight;
    var plotH = H - marginTop - marginBottom;

    function xFor(t) { return marginLeft + (t / durationSec) * plotW; }
    function yFor(dtps) { return marginTop + plotH - (dtps / maxDtps) * plotH; }

    var svg = [];

    var yTicks = 4;
    for (var gi = 0; gi <= yTicks; gi++) {
      var val = (maxDtps / yTicks) * gi;
      var gy = yFor(val);
      svg.push('<line x1="' + marginLeft + '" y1="' + gy.toFixed(1) + '" x2="' + (W - marginRight) +
        '" y2="' + gy.toFixed(1) + '" stroke="' + DTPS_GRID_COLOR + '" stroke-width="1"/>');
      svg.push('<text x="' + (marginLeft - 6) + '" y="' + (gy + 3).toFixed(1) +
        '" font-size="10" fill="' + DTPS_MUTED_INK + '" text-anchor="end">' + Math.round(val) + '</text>');
    }

    var xTickCount = 6;
    for (var xi = 0; xi <= xTickCount; xi++) {
      var xt = (durationSec / xTickCount) * xi;
      svg.push('<text x="' + xFor(xt).toFixed(1) + '" y="' + (H - 6) +
        '" font-size="10" fill="' + DTPS_MUTED_INK + '" text-anchor="middle">' + Math.round(xt) + 's</text>');
    }

    var areaPath = 'M' + xFor(0).toFixed(1) + ',' + yFor(0).toFixed(1) + ' ';
    points.forEach(function (p) { areaPath += 'L' + xFor(p.t).toFixed(1) + ',' + yFor(p.dtps).toFixed(1) + ' '; });
    areaPath += 'L' + xFor(durationSec).toFixed(1) + ',' + yFor(0).toFixed(1) + ' Z';
    svg.push('<path d="' + areaPath + '" fill="' + DTPS_LINE_COLOR + '" fill-opacity="0.12" stroke="none"/>');

    var linePoints = points.map(function (p) { return xFor(p.t).toFixed(1) + ',' + yFor(p.dtps).toFixed(1); }).join(' ');
    svg.push('<polyline points="' + linePoints + '" fill="none" stroke="' + DTPS_LINE_COLOR +
      '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>');

    points.forEach(function (p) {
      var tip = 't=' + Math.round(p.start) + '–' + Math.round(p.end) + 's: ' + p.dtps.toFixed(1) + ' dtps';
      svg.push('<circle cx="' + xFor(p.t).toFixed(1) + '" cy="' + yFor(p.dtps).toFixed(1) +
        '" r="7" fill="transparent"><title>' + dtpsEscapeXml(tip) + '</title></circle>');
    });

    var rollingLinePoints = points.map(function (p, i) {
      return xFor(p.t).toFixed(1) + ',' + yFor(rollingDtps[i]).toFixed(1);
    }).join(' ');
    svg.push('<polyline points="' + rollingLinePoints + '" fill="none" stroke="' + DTPS_ROLLING_COLOR +
      '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>');
    points.forEach(function (p, i) {
      var tip = 't=' + p.t.toFixed(1) + 's, trailing ' + DTPS_ROLL_WINDOW_SEC + 's avg: ' + rollingDtps[i].toFixed(1) + ' dtps';
      svg.push('<circle cx="' + xFor(p.t).toFixed(1) + '" cy="' + yFor(rollingDtps[i]).toFixed(1) +
        '" r="7" fill="transparent"><title>' + dtpsEscapeXml(tip) + '</title></circle>');
    });

    // Dashed reference line at the averaged DTPS across all N runs — shows
    // how much this one run's peaks overshoot the headline average figure.
    if (report.dtps > 0) {
      var avgY = yFor(report.dtps);
      svg.push('<line x1="' + marginLeft + '" y1="' + avgY.toFixed(1) + '" x2="' + (W - marginRight) +
        '" y2="' + avgY.toFixed(1) + '" stroke="' + DTPS_MUTED_INK + '" stroke-width="1" stroke-dasharray="3,3"/>');
      svg.push('<text x="' + (W - marginRight) + '" y="' + (avgY - 4).toFixed(1) +
        '" font-size="10" fill="' + DTPS_MUTED_INK + '" text-anchor="end">avg ' + report.dtps.toFixed(1) + '</text>');
    }

    // Mark the single largest hit in this run so it's visually tied to the
    // spike it caused, not just a number in the text report above.
    var spikeNote = '';
    if (report.maxHitTaken > 0) {
      var spikeEvent = null;
      events.forEach(function (e) {
        if (!spikeEvent || e.damage > spikeEvent.damage) spikeEvent = e;
      });
      if (spikeEvent) {
        var sx = xFor(spikeEvent.t);
        var sy = yFor(Math.min(maxDtps, spikeEvent.damage));
        svg.push('<circle cx="' + sx.toFixed(1) + '" cy="' + sy.toFixed(1) + '" r="5" fill="' + DTPS_SPIKE_COLOR +
          '" stroke="#121216" stroke-width="1.5"><title>' + dtpsEscapeXml('Largest single hit: ' +
          Math.round(spikeEvent.damage) + ' (' + (spikeEvent.source || 'unknown') + ') at ' + spikeEvent.t.toFixed(2) + 's') +
          '</title></circle>');
        spikeNote = ' The amber dot marks the largest single hit in this run (' + Math.round(spikeEvent.damage) +
          (spikeEvent.source ? ', ' + spikeEvent.source : '') + ').';
      }
    }

    var legend =
      '<span style="display:inline-flex;align-items:center;gap:0.35rem;margin:0 0.75rem 0.3rem 0;">' +
      '<span style="width:14px;height:2px;flex:none;background:' + DTPS_LINE_COLOR + ';"></span>' +
      '<span style="font-size:0.8rem;color:var(--text);">DTPS per ' + bucketWidth.toFixed(1) + 's window</span></span>' +
      '<span style="display:inline-flex;align-items:center;gap:0.35rem;">' +
      '<span style="width:14px;height:2px;flex:none;background:' + DTPS_ROLLING_COLOR + ';"></span>' +
      '<span style="font-size:0.8rem;color:var(--text);">Trailing ' + DTPS_ROLL_WINDOW_SEC + 's average</span></span>';

    var runNote = report.runs > 1
      ? ' One of ' + report.runs + ' simulated runs (the report above averages all of them) — spikes here show what a single unlucky stretch can look like, not the mean.'
      : '';

    return (
      '<p class="hint" style="margin:0 0 0.4rem;">Damage taken per second over time.' + runNote + spikeNote + '</p>' +
      '<div style="overflow-x:auto;border:1px solid var(--border);border-radius:4px;background:var(--input-bg);padding:0.5rem;">' +
      '<svg width="' + W + '" height="' + H + '" style="display:block;">' + svg.join('') + '</svg>' +
      '</div>' +
      '<div style="margin-top:0.5rem;">' + legend + '</div>'
    );
  }

  // ---------------------------------------------------------------------------
  // Public API (compatible with the previous module surface)
  // ---------------------------------------------------------------------------

  global.TankingEngine = {
    runTankingFight: runTankingFight,
    runTankingAnalysis: runTankingAnalysis,
    formatTankingReport: formatTankingReport,
    buildDtpsOverTimeHtml: buildDtpsOverTimeHtml,

    // Kept so existing callers keep working; the maths now lives in the
    // dedicated modules.
    getPlayerAvoidance: function (level, defenseSkill, agi) {
      var PD = getDefense();
      return PD ? PD.getAvoidance(level, defenseSkill, agi, 0, 0) : 0;
    },
    getPlayerMitigation: function (level, itemAC, spellAC, classId, defSkill, agi, era) {
      var PD = getDefense();
      return PD ? PD.getMitigation({
        level: level, itemAC: itemAC, spellAC: spellAC, classId: classId,
        defenseSkill: defSkill, agi: agi, era: era
      }) : 0;
    },
    getMobToHit: function (mobLevel, mobAccuracy, isPoP) {
      var NC = getNpcCombat();
      return NC ? NC.getToHit(mobLevel, isPoP, mobAccuracy) : 0;
    },
    getMobOffenseRating: function (mobLevel, isPoP, mobATK) {
      var NC = getNpcCombat();
      return NC ? NC.getOffense(mobLevel, isPoP, mobATK, false) : 0;
    },
    getAvoidanceRates: function (opts) {
      var PD = getDefense();
      return PD ? PD.getAvoidanceRates({
        blockSkill: opts.playerBlockSkill,
        parrySkill: opts.playerParrySkill,
        riposteSkill: opts.playerRiposteSkill,
        dodgeSkill: opts.playerDodgeSkill
      }) : { block: 0, parry: 0, riposte: 0, dodge: 0 };
    }
  };

})(typeof self !== 'undefined' ? self : this);
