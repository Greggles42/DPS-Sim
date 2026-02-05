/**
 * Vercel serverless function: usage-log collector for DPS-Sim.
 * Persists each run to Vercel Blob (dps-sim/usage-log.jsonl).
 * Set USAGE_LOG_URL in index.html to https://dps-sim.vercel.app/api/log
 *
 * Requires: Blob store in Vercel project + BLOB_READ_WRITE_TOKEN (auto when store is in same project).
 */
import { list, put } from '@vercel/blob';

const BLOB_PATH = 'dps-sim/usage-log.jsonl';

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
    if (!payload || typeof payload !== 'object') return;
  } catch (e) {
    setCors(res);
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json({});
  }

  const line = JSON.stringify(payload) + '\n';

  try {
    const { blobs } = await list({ prefix: 'dps-sim/' });
    const existing = blobs.find((b) => b.pathname === BLOB_PATH);
    let body = line;
    if (existing && existing.url) {
      const r = await fetch(existing.url);
      const text = await r.text();
      body = text + line;
    }
    await put(BLOB_PATH, body, {
      access: 'public',
      addRandomSuffix: false,
      allowOverwrite: true,
    });
  } catch (e) {
    // Blob store not configured or write failed; still return 200
  }

  setCors(res);
  res.setHeader('Content-Type', 'application/json');
  return res.status(200).json({});
}
