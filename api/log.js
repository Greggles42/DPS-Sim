/**
 * Vercel serverless function: usage-log collector for DPS-Sim.
 * Persists each run to Vercel KV (Redis) — no Blob put(), list(), or copy().
 * Set USAGE_LOG_URL in index.html to https://dps-sim.vercel.app/api/log
 *
 * Writes are batched into a single kv.pipeline() call (one network round trip)
 * that appends the raw entry (trimmed to the last MAX_RAW_LOG) AND updates
 * incremental aggregate counters in STATS_KEY, so /api/summary can read
 * lifetime stats in O(1) instead of re-scanning the raw log on every view.
 *
 * Requires: Vercel KV store (or Redis integration) in the project.
 */
import { kv } from '@vercel/kv';

const LOG_KEY = 'dps_sim_log';
const UIDS_KEY = 'dps_sim_uids';
const STATS_KEY = 'dps_sim_stats';
const MAX_RAW_LOG = 500;

// Field-name delimiter for aggregate keys in STATS_KEY. Stripped out of any
// user-controlled label (via clean()) so summary.js can safely split on it.
const D = '~~';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function clean(s, maxLen) {
  return String(s).split(D).join('').slice(0, maxLen);
}

function weaponLabel(w) {
  if (!w || typeof w !== 'object') return null;
  if (w.name) return clean(w.name, 40);
  const parts = [w.preset || w.damage, w.delay].filter(Boolean);
  return parts.length ? clean(parts.join('/'), 40) : null;
}

/**
 * Applies the incremental aggregate updates for one sim_run payload onto a pipeline.
 *
 * Real payloads observed in production:
 *  - Melee runs: no `simMode`, no `ranged` flag, and NO `dps` field — only
 *    `totalDamage` + `durationSec`. Most runs are this shape.
 *  - Caster runs: `simMode: "rotation"`, WITH a precomputed `dps` field.
 *  - Ranged runs: `ranged: true`, `classId: "ranged"` (a placeholder, not a
 *    real EQ class — excluded from per-class breakdowns).
 *  - Tanking runs: `simMode: "tanking"`.
 * "dps mode" (for per-class DPS averages) means: not ranged, not tanking.
 */
export function applyStatsToPipeline(pipe, payload) {
  const isRanged = payload.ranged === true || payload.simMode === 'ranged';
  const isTanking = payload.simMode === 'tanking';
  const modeKey = isRanged ? 'ranged' : isTanking ? 'tanking' : 'dps';
  pipe.hincrby(STATS_KEY, 'total', 1);
  pipe.hincrby(STATS_KEY, `mode${D}${modeKey}`, 1);

  const era = clean(payload.era || 'unknown', 20);
  pipe.hincrby(STATS_KEY, `era${D}${era}`, 1);

  const rawClassId = payload.classId ? clean(payload.classId, 20) : null;
  // "ranged" is a placeholder classId for ranged-mode runs, not a real class.
  const classId = rawClassId && rawClassId !== 'ranged' ? rawClassId : null;

  let dps = typeof payload.dps === 'number' && payload.dps > 0 ? payload.dps : null;
  if (
    dps == null &&
    typeof payload.totalDamage === 'number' && payload.totalDamage > 0 &&
    typeof payload.durationSec === 'number' && payload.durationSec > 0
  ) {
    dps = payload.totalDamage / payload.durationSec;
  }

  if (classId) {
    pipe.hincrby(STATS_KEY, `class${D}${classId}${D}count`, 1);
    if (modeKey === 'dps' && dps) {
      pipe.hincrbyfloat(STATS_KEY, `class${D}${classId}${D}dpsSum`, dps);
      pipe.hincrby(STATS_KEY, `class${D}${classId}${D}dpsCount`, 1);
    }
  }

  const w1Label = weaponLabel(payload.w1) || 'none';
  const w2Label = weaponLabel(payload.w2) || 'none';
  const comboLabel = `${w1Label} + ${w2Label}`;
  pipe.hincrby(STATS_KEY, `combo${D}${comboLabel}`, 1);

  if (classId && modeKey === 'dps' && dps) {
    const buildField = `build${D}${classId}${D}${comboLabel}${D}${era}`;
    pipe.hincrbyfloat(STATS_KEY, `${buildField}${D}dpsSum`, dps);
    pipe.hincrby(STATS_KEY, `${buildField}${D}count`, 1);
  }
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    setCors(res);
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(404).end();
  }

  let payload;
  try {
    payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    if (!payload || typeof payload !== 'object') {
      setCors(res);
      res.setHeader('Content-Type', 'application/json');
      return res.status(200).json({});
    }
  } catch (_e) {
    setCors(res);
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json({});
  }

  const line = JSON.stringify(payload);

  try {
    const pipe = kv.pipeline();
    pipe.rpush(LOG_KEY, line);
    pipe.ltrim(LOG_KEY, -MAX_RAW_LOG, -1);

    const uid = payload.uid;
    if (uid && typeof uid === 'string') {
      pipe.sadd(UIDS_KEY, uid);
    }

    if (payload.event === 'sim_run') {
      applyStatsToPipeline(pipe, payload);
    }

    await pipe.exec();
  } catch (_e) {
    // KV not configured or write failed; still return 200
  }

  setCors(res);
  res.setHeader('Content-Type', 'application/json');
  return res.status(200).json({});
}
