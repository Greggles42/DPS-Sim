/**
 * Vercel serverless function: usage-log collector for DPS-Sim.
 * Persists each run to Vercel KV (Redis list) — no Blob put(), list(), or copy().
 * Set USAGE_LOG_URL in index.html to https://dps-sim.vercel.app/api/log
 *
 * Requires: Vercel KV store (or Redis integration) in the project.
 */
import { kv } from '@vercel/kv';

const LOG_KEY = 'dps_sim_log';
const UIDS_KEY = 'dps_sim_uids';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
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
  } catch (e) {
    setCors(res);
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json({});
  }

  const line = JSON.stringify(payload);

  try {
    await kv.rpush(LOG_KEY, line);
    const uid = payload.uid;
    if (uid && typeof uid === 'string') {
      await kv.sadd(UIDS_KEY, uid);
    }
  } catch (e) {
    // KV not configured or write failed; still return 200
  }

  setCors(res);
  res.setHeader('Content-Type', 'application/json');
  return res.status(200).json({});
}
