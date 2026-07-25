/**
 * Complete Heal chain analysis.
 *
 * The question a tank actually needs answered is "how fast does the chain have
 * to be before I stop dying", and that is a question about *burst*, not about
 * average damage. Two mobs with identical DTPS can have wildly different CH
 * requirements if one of them flurries for 4x your average round.
 *
 * So rather than dividing HP by mean DTPS and multiplying by a made-up safety
 * factor, this replays the recorded damage timelines against a candidate heal
 * cadence and measures how often the tank actually dies.
 */
(function (global) {
  'use strict';

  var DEFAULT_CAST_TIME_SEC = 10;
  var DEFAULT_RISK_THRESHOLD = 0.01;   // 1% chance of death is "safe"

  /**
   * Replay one timeline with a Complete Heal landing every intervalMs.
   *
   * A CH restores to full, so the tank's survival depends entirely on whether
   * the damage between two landings can exceed max HP.
   *
   * @returns {{died:boolean, deathAtMs:number|null, lowestHP:number}}
   */
  function replay(timeline, hpTotal, intervalMs, regenPerSec) {
    var hp = hpTotal;
    var lowest = hpTotal;
    var nextHealMs = intervalMs;
    var lastMs = 0;

    for (var i = 0; i < timeline.length; i++) {
      var ev = timeline[i];

      // Land every heal due before this damage event.
      while (nextHealMs <= ev.t) {
        if (regenPerSec > 0) {
          hp = Math.min(hpTotal, hp + regenPerSec * (nextHealMs - lastMs) / 1000);
        }
        lastMs = nextHealMs;
        hp = hpTotal;
        nextHealMs += intervalMs;
      }

      if (regenPerSec > 0) {
        hp = Math.min(hpTotal, hp + regenPerSec * (ev.t - lastMs) / 1000);
      }
      lastMs = ev.t;

      hp -= ev.damage;
      if (hp < lowest) lowest = hp;
      if (hp <= 0) return { died: true, deathAtMs: ev.t, lowestHP: hp };
    }

    return { died: false, deathAtMs: null, lowestHP: lowest };
  }

  /**
   * Largest damage total landing inside any sliding window of windowMs.
   * This is the number that kills tanks.
   */
  function maxDamageInWindow(timeline, windowMs) {
    var max = 0;
    var sum = 0;
    var start = 0;

    for (var end = 0; end < timeline.length; end++) {
      sum += timeline[end].damage;
      while (timeline[end].t - timeline[start].t > windowMs) {
        sum -= timeline[start].damage;
        start++;
      }
      if (sum > max) max = sum;
    }
    return max;
  }

  function percentile(sorted, p) {
    if (!sorted.length) return 0;
    var idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
    return sorted[idx];
  }

  /**
   * Burst statistics across runs for a given window.
   *
   * Sampling every sliding window rather than only each run's worst one: a
   * handful of per-run maxima gives you five numbers that are all nearly
   * identical, which makes "p50" and "p99" meaningless. What we want is the
   * distribution of "how much damage arrives in a window like this", with the
   * observed worst case reported alongside it.
   */
  function burstStats(timelines, windowMs, sampleStepMs) {
    var step = sampleStepMs || Math.max(500, windowMs / 10);
    var samples = [];
    var worst = 0;

    timelines.forEach(function (t) {
      if (!t.length) return;
      var endMs = t[t.length - 1].t;
      var i = 0, j = 0, sum = 0;

      for (var start = 0; start + windowMs <= endMs; start += step) {
        var stop = start + windowMs;
        while (j < t.length && t[j].t < stop) { sum += t[j].damage; j++; }
        while (i < t.length && t[i].t < start) { sum -= t[i].damage; i++; }
        samples.push(sum);
        if (sum > worst) worst = sum;
      }

      // The stepped scan can straddle the true peak; take it exactly.
      var exact = maxDamageInWindow(t, windowMs);
      if (exact > worst) worst = exact;
    });

    var sorted = samples.sort(function (a, b) { return a - b; });
    return {
      windowSec: windowMs / 1000,
      samples: sorted.length,
      p50: percentile(sorted, 0.50),
      p95: percentile(sorted, 0.95),
      p99: percentile(sorted, 0.99),
      max: worst,
      mean: sorted.length ? sorted.reduce(function (a, b) { return a + b; }, 0) / sorted.length : 0
    };
  }

  /**
   * Sweep candidate CH intervals and measure death probability at each.
   *
   * @param {Array<Array<{t:number,damage:number}>>} timelines  one per run
   * @param {Object} opts  hpTotal, castTimeSec, regenPerSec, riskThreshold,
   *                       maxIntervalSec, stepSec
   */
  function analyze(timelines, opts) {
    opts = opts || {};
    var hpTotal = opts.hpTotal || 4000;
    var castTimeSec = opts.castTimeSec != null ? opts.castTimeSec : DEFAULT_CAST_TIME_SEC;
    var regenPerSec = opts.regenPerSec || 0;
    var riskThreshold = opts.riskThreshold != null ? opts.riskThreshold : DEFAULT_RISK_THRESHOLD;

    var runs = timelines.filter(function (t) { return t && t.length; });
    if (!runs.length) {
      return { noDamage: true, castTimeSec: castTimeSec, curve: [], maxSafeIntervalSec: Infinity };
    }

    // Total damage per second across all runs, for context and for bounding the sweep.
    var durationMs = opts.durationMs || runs[0][runs[0].length - 1].t;
    var totalDamage = runs.reduce(function (acc, t) {
      return acc + t.reduce(function (a, e) { return a + e.damage; }, 0);
    }, 0);
    var meanDtps = durationMs > 0 ? (totalDamage / runs.length) / (durationMs / 1000) : 0;

    // Sweep up to roughly twice the naive HP/DTPS estimate — beyond that, death
    // is certain and the extra points tell us nothing.
    var naiveMax = meanDtps > 0 ? hpTotal / meanDtps : 60;
    var maxIntervalSec = opts.maxIntervalSec || Math.max(6, Math.ceil(naiveMax * 2));
    var stepSec = opts.stepSec || Math.max(0.25, Math.round(maxIntervalSec / 60 * 4) / 4);

    var curve = [];
    var maxSafeIntervalSec = 0;

    for (var T = stepSec; T <= maxIntervalSec; T += stepSec) {
      var intervalMs = T * 1000;
      var deaths = 0;
      for (var i = 0; i < runs.length; i++) {
        if (replay(runs[i], hpTotal, intervalMs, regenPerSec).died) deaths++;
      }
      var risk = deaths / runs.length;
      curve.push({ intervalSec: T, deathRate: risk });
      if (risk <= riskThreshold) maxSafeIntervalSec = T;
      // Once we are dying every single run, nothing longer will help.
      if (risk >= 1) break;
    }

    var chosenIntervalSec = maxSafeIntervalSec > 0 ? maxSafeIntervalSec : stepSec;
    var burstAtInterval = burstStats(runs, chosenIntervalSec * 1000);
    var burstAtCastTime = burstStats(runs, castTimeSec * 1000);

    // A chain landing a heal every T seconds with a C-second cast needs
    // ceil(C / T) healers rotating.
    var clericsNeeded = maxSafeIntervalSec > 0
      ? Math.max(1, Math.ceil(castTimeSec / maxSafeIntervalSec))
      : null;

    // While a CH is in flight the tank has to absorb a full cast-time window.
    // Size that off the 99th percentile, not the mean.
    var callThresholdHP = Math.min(hpTotal, Math.ceil(burstAtCastTime.p99));

    return {
      noDamage: false,
      castTimeSec: castTimeSec,
      hpTotal: hpTotal,
      meanDtps: meanDtps,
      riskThreshold: riskThreshold,
      runs: runs.length,

      maxSafeIntervalSec: maxSafeIntervalSec,
      sustainable: maxSafeIntervalSec >= castTimeSec,
      clericsNeeded: clericsNeeded,
      callThresholdHP: callThresholdHP,

      burstAtInterval: burstAtInterval,
      burstAtCastTime: burstAtCastTime,
      curve: curve,

      // The old mean-based estimate, kept purely so the report can show how far
      // off it was on spiky mobs.
      naiveIntervalSec: meanDtps > 0 ? hpTotal / meanDtps : Infinity
    };
  }

  /** Selected points from the risk curve, for a compact report table. */
  function riskTable(result, points) {
    if (!result || !result.curve.length) return [];
    var wanted = points || [0.0, 0.01, 0.05, 0.10, 0.25, 0.50];
    var out = [];
    wanted.forEach(function (target) {
      var best = null;
      for (var i = 0; i < result.curve.length; i++) {
        if (result.curve[i].deathRate <= target) best = result.curve[i];
      }
      if (best) out.push({ deathRate: target, intervalSec: best.intervalSec });
    });
    return out;
  }

  global.HealChain = {
    analyze: analyze,
    replay: replay,
    burstStats: burstStats,
    maxDamageInWindow: maxDamageInWindow,
    riskTable: riskTable,
    DEFAULT_CAST_TIME_SEC: DEFAULT_CAST_TIME_SEC
  };

})(typeof window !== 'undefined' ? window : globalThis);
