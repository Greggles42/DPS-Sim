/**
 * "Above cap" alert shown between Target & Fight and the Report whenever a simulation runs with any input
 * that the sim has to clamp (or that exceeds a game cap): item mod2 stats, haste, worn ATK, worn skill-mod
 * skills pushed past the 252 hard cap, skills above the class/level cap, archery skill, runs, and AC above
 * the softcap. Base stat caps (STR/STA/AGI/DEX/...) are intentionally ignored.
 *
 * The checks read the same inputs the sims read (plus the sim's own result for things only it knows, such as
 * which weapon skill was used or the AC softcap). Wrapped sim entry points: EQCombat.runFight /
 * runRangedFight and TankingEngine.runTankingFight.
 */
(function (global) {
  'use strict';

  var HARD_SKILL_CAP = 252;       // Client::GetSkill hard cap after the worn skill-mod % is applied
  var WORN_ATK_CAP = 250;         // RuleI(Character, ItemATKCap)
  var COMBINED_HASTE_CAP = 100;   // worn + V1 spell haste
  var MAX_RUNS = 1000;

  var SKILL_LABELS = {
    '1hb': '1H Blunt', '1hs': '1H Slashing', '2hb': '2H Blunt', '2hs': '2H Slashing', '1hp': 'Piercing', 'h2h': 'Hand to Hand',
    offense: 'Offense', doubleattack: 'Double Attack', dualwield: 'Dual Wield',
    defense: 'Defense', dodge: 'Dodge', parry: 'Parry', riposte: 'Riposte', block: 'Block',
    archery: 'Archery', backstab: 'Backstab', kick: 'Kick', bash: 'Bash', flyingkick: 'Flying Kick',
    dragonpunch: 'Dragon Punch', eaglestrike: 'Eagle Strike', tigerclaw: 'Tiger Claw', roundkick: 'Round Kick'
  };
  var SPECIAL_KEY = { kick: 'kick', bash: 'bash', flying_kick: 'flyingkick', dragon_punch: 'dragonpunch', eagle_strike: 'eaglestrike', tiger_claw: 'tigerclaw', round_kick: 'roundkick' };

  function byId(id) { return document.getElementById(id); }
  function num(id, dflt) {
    var e = byId(id);
    var v = e ? parseInt(e.value, 10) : NaN;
    return isNaN(v) ? (dflt == null ? 0 : dflt) : v;
  }
  function otherMod(key) { return Number((global.gearOtherSkillMods || {})[key]) || 0; }
  function buffFx() { try { return typeof global.getBuffEffects === 'function' ? (global.getBuffEffects() || {}) : {}; } catch (e) { return {}; } }
  function label(k) { return SKILL_LABELS[k] || k; }

  /** Worn +% skill mod: skill * (100 + mod) / 100, hard-capped at 252. Returns a message or null. */
  function skillModEntry(key, base, mod) {
    if (!(mod > 0) || !(base > 0)) return null;
    var raw = Math.floor(base * (100 + mod) / 100);
    if (raw <= HARD_SKILL_CAP) return null;
    return '<strong>' + label(key) + ' skill</strong>: ' + base + ' with the worn +' + mod + '% skill mod would be ' + raw +
      ', above the ' + HARD_SKILL_CAP + ' hard cap (clamped to ' + HARD_SKILL_CAP + '; ' + (raw - HARD_SKILL_CAP) + ' wasted)';
  }

  /** Skill typed above the class/level cap. The sim keeps the typed value, so this is informational. */
  function classCapEntry(key, value, cap) {
    if (!(cap > 0) || !(value > cap)) return null;
    return '<strong>' + label(key) + ' skill</strong> is ' + value + ', above the class/level cap of ' + cap +
      ' (not clamped: the sim uses the ' + value + ' you entered)';
  }

  function hasteEntries(level) {
    var out = [];
    var worn = Math.max(0, num('worn-haste')), v1 = Math.max(0, num('spell-haste')), v3 = Math.max(0, num('v3-haste'));
    var wornCapped = worn;
    if (level <= 25 && worn > 10) {
      wornCapped = 10;
      out.push('<strong>Worn haste</strong> is ' + worn + '%, above the level-' + level + ' cap of 10% (clamped to 10%)');
    }
    if (wornCapped + v1 > COMBINED_HASTE_CAP) {
      out.push('<strong>Worn + V1 haste</strong> is ' + wornCapped + '% + ' + v1 + '% = ' + (wornCapped + v1) +
        '%, above the combined cap of ' + COMBINED_HASTE_CAP + '% (clamped to ' + COMBINED_HASTE_CAP + '%)');
    }
    var v3Cap = level > 50 ? 25 : 10;
    if (v3 > v3Cap) {
      out.push('<strong>V3 haste</strong> is ' + v3 + '%, above its cap of ' + v3Cap + '% (clamped to ' + v3Cap + '%)');
    }
    // Final net total, in case the engine's own overall cap bites even when no single piece exceeded its cap.
    if (!out.length && global.EQCombat && typeof global.EQCombat.getEffectiveHastePercent === 'function') {
      var net = Math.min(wornCapped + v1, COMBINED_HASTE_CAP) + Math.min(v3, v3Cap);
      var eff = global.EQCombat.getEffectiveHastePercent(net, level);
      if (net > eff) out.push('<strong>Net haste</strong> is ' + net + '%, above the maximum of ' + eff + '% (clamped to ' + eff + '%)');
    }
    return out;
  }

  function wornAtkEntry(includeWeapon) {
    var fx = buffFx();
    var base = num('worn-attack') + (Number(fx.wornAtk) || 0);
    var weapon = (includeWeapon && typeof global.getEquippedWornAttackBonus === 'function') ? (Number(global.getEquippedWornAttackBonus()) || 0) : 0;
    var total = base + weapon;
    if (total <= WORN_ATK_CAP) return null;
    return '<strong>Worn ATK</strong> is ' + total + (weapon ? ' (' + base + ' worn + ' + weapon + ' from weapons)' : '') +
      ', above the cap of ' + WORN_ATK_CAP + ' (clamped to ' + WORN_ATK_CAP + ')';
  }

  function collect(context, opts, res) {
    var out = [];
    var level = num('level', 60);
    var classId = ((byId('class') || {}).value || '').toLowerCase();
    var caps = global.WeaponSkillCaps;
    function push(m) { if (m) out.push(m); }

    // ---- Item mod2 stats (all tabs) ----
    if (global.Mod2Inputs) {
      global.Mod2Inputs.getOvercap().forEach(function (o) {
        out.push('<strong>' + o.label + '</strong> is ' + o.value + ', above its cap of ' + o.cap + ' (clamped to ' + o.cap + ')');
      });
    }

    if (context === 'melee' || context === 'ranged') {
      hasteEntries(level).forEach(push);
      push(wornAtkEntry(context === 'melee'));
    }

    if (context === 'melee') {
      var runs = num('runs', 20);
      if (runs > MAX_RUNS) out.push('<strong>Number of runs</strong> is ' + runs + ', above the maximum of ' + MAX_RUNS + ' (clamped to ' + MAX_RUNS + ')');

      // Weapon skill actually used for to-hit (main hand, then off hand), from the sim's own report.
      if (res && !res.error) {
        if (res.weaponSkillKeyForToHit && res.weaponSkillBase != null) {
          push(skillModEntry(res.weaponSkillKeyForToHit, Number(res.weaponSkillBase), Number(res.weaponSkillModPercent) || 0));
          if (caps && caps.getCapForSimClass) push(classCapEntry(res.weaponSkillKeyForToHit, Number(res.weaponSkillBase), caps.getCapForSimClass(classId, res.weaponSkillKeyForToHit, level)));
        }
        if (res.weaponSkillKeyForToHitOffhand && res.weaponSkillBaseOffhand != null &&
            (res.weaponSkillKeyForToHitOffhand !== res.weaponSkillKeyForToHit || res.weaponSkillModPercentOffhand !== res.weaponSkillModPercent)) {
          push(skillModEntry(res.weaponSkillKeyForToHitOffhand, Number(res.weaponSkillBaseOffhand), Number(res.weaponSkillModPercentOffhand) || 0));
        }
        var sp = res.special;
        if (sp && sp.backstabSkill != null) push(skillModEntry('backstab', Number(sp.backstabSkill), Number(sp.backstabModPercent) || 0));
      }
      [['offense', 'offense-skill'], ['doubleattack', 'double-attack'], ['dualwield', 'dual-wield']].forEach(function (p) {
        var base = num(p[1]);
        push(skillModEntry(p[0], base, otherMod(p[0])));
        if (caps && caps.getCombatSkillCap) {
          var ck = { offense: 'offense', doubleattack: 'doubleAttack', dualwield: 'dualWield' }[p[0]];
          push(classCapEntry(p[0], base, caps.getCombatSkillCap(ck, classId, level)));
        }
      });
      var st = (byId('special-attack-type') || {}).value;
      if (st && SPECIAL_KEY[st]) push(skillModEntry(SPECIAL_KEY[st], num('special-skill', 252), otherMod(SPECIAL_KEY[st])));
    }

    if (context === 'ranged') {
      var mod = res && res.archeryModPercent != null ? Number(res.archeryModPercent) : 0;
      var entered = num('ranged-archery-skill', 252);
      var rangerCap = Math.min(HARD_SKILL_CAP, 240, Math.floor(level * 4));
      var fixed = !!(opts && opts.archerySkillFixed);
      if (!fixed && entered > rangerCap) {
        out.push('<strong>Archery skill</strong> is ' + entered + ', above the level-' + level + ' cap of ' + rangerCap + ' (clamped to ' + rangerCap + ')');
      } else if (entered > HARD_SKILL_CAP) {
        out.push('<strong>Archery skill</strong> is ' + entered + ', above the ' + HARD_SKILL_CAP + ' hard cap (clamped to ' + HARD_SKILL_CAP + ')');
      }
      var archBase = res && res.archerySkill != null ? Number(res.archerySkill) : Math.min(entered, fixed ? HARD_SKILL_CAP : rangerCap);
      push(skillModEntry('archery', archBase, mod));
    }

    if (context === 'tanking') {
      ['defense', 'dodge', 'parry', 'riposte', 'block'].forEach(function (k) {
        push(skillModEntry(k, num(k + '-skill'), otherMod(k)));
      });
      push(skillModEntry('offense', num('offense-skill', 252), otherMod('offense')));
      var ac = res && res.acBreakdown;
      if (ac && ac.overcap > 0) {
        out.push('<strong>AC</strong> is ' + ac.preCap + ', above the softcap of ' + ac.softcap + ' by ' + ac.overcap +
          '; only 1 in every ' + ac.returns + ' points above the softcap counts (mitigation clamped to ' + ac.final + ')');
      } else if (ac && ac.preCap > ac.softcap && ac.final === ac.softcap) {
        out.push('<strong>AC</strong> is ' + ac.preCap + ', above the hard cap of ' + ac.softcap + ' (clamped to ' + ac.softcap + ')');
      }
    }
    return out;
  }

  var lastHtml = null;
  function render(entries) {
    var box = byId('overcap-warning');
    if (!box) return;
    if (!entries.length) {
      if (lastHtml !== '') { box.style.display = 'none'; lastHtml = ''; }
      return;
    }
    var html = entries.map(function (e) { return '<div style="margin-top:0.2rem;">&bull; ' + e + '</div>'; }).join('');
    if (html !== lastHtml) {
      var list = box.querySelector('[data-overcap-list]');
      if (list) list.innerHTML = html;
      lastHtml = html;
    }
    box.style.display = 'flex';
  }

  var lastEvalMs = 0;
  function update(context, opts, res) {
    // A single user action can call a sim hundreds of times (runs, Rank Weapons); evaluating once per burst is enough.
    var now = Date.now();
    if (now - lastEvalMs < 300) return;
    lastEvalMs = now;
    try { render(collect(context, opts, res)); } catch (e) { /* never let the alert break a simulation */ }
  }

  function hook(obj, name, context) {
    if (!obj || typeof obj[name] !== 'function' || obj[name].__capHooked) return;
    var orig = obj[name];
    var wrapped = function (opts) {
      var res = orig.apply(this, arguments);
      update(context, opts, res);
      return res;
    };
    wrapped.__capHooked = true;
    obj[name] = wrapped;
  }

  function init() {
    hook(global.EQCombat, 'runFight', 'melee');
    hook(global.EQCombat, 'runRangedFight', 'ranged');
    hook(global.TankingEngine, 'runTankingAnalysis', 'tanking');
  }

  global.CapAlerts = { collect: collect, update: update };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})(typeof self !== 'undefined' ? self : this);
