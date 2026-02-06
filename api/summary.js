/**
 * GET /api/summary — DPS-Sim usage summary page.
 * Shows total simulations run, unique users, and a log of recent runs with parameters.
 * Visit: https://dps-sim.vercel.app/api/summary
 */
import { list } from '@vercel/blob';

const BLOB_PATH = 'dps-sim/usage-log.jsonl';
const MAX_LOG_ENTRIES = 200;

function escapeHtml(s) {
  if (s == null) return '';
  const t = String(s);
  return t
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatTs(ts) {
  if (ts == null) return '—';
  const d = new Date(ts);
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(404).end();
  }

  let totalRuns = 0;
  const uids = new Set();
  const entries = [];

  try {
    const { blobs } = await list({ prefix: 'dps-sim/' });
    const blob = blobs.find((b) => b.pathname === BLOB_PATH || (b.pathname && b.pathname.endsWith('usage-log.jsonl')));
    if (blob && blob.url) {
      const r = await fetch(blob.url, { cache: 'no-store' });
      const text = await r.text();
      const lines = text.split('\n').filter((line) => line.trim());
      totalRuns = lines.length;
      for (let i = 0; i < lines.length; i++) {
        try {
          const row = JSON.parse(lines[i]);
          if (row.uid) uids.add(row.uid);
          entries.push(row);
        } catch (e) {
          /* skip bad line */
        }
      }
    }
  } catch (e) {
    /* no blob or fetch failed */
  }

  // Most recent first, cap for display
  const recent = entries.slice(-MAX_LOG_ENTRIES).reverse();

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>DPS-Sim Usage Summary</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 900px; margin: 0 auto; padding: 1.5rem; background: #1a1d23; color: #e6e8ec; }
    h1 { color: #7eb8da; font-size: 1.5rem; }
    .stats { display: flex; gap: 2rem; margin: 1rem 0; font-size: 1.1rem; }
    .stat { background: #252830; padding: 0.75rem 1.25rem; border-radius: 8px; border: 1px solid #3d4452; }
    .stat strong { display: block; color: #8b909a; font-size: 0.8rem; text-transform: uppercase; }
    .stat span { font-size: 1.5rem; }
    h2 { color: #8b909a; font-size: 0.95rem; margin: 1.5rem 0 0.5rem; }
    table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
    th, td { text-align: left; padding: 0.5rem 0.75rem; border-bottom: 1px solid #3d4452; }
    th { color: #8b909a; font-weight: 600; }
    tr:hover { background: #252830; }
    .mono { font-family: ui-monospace, monospace; }
    .muted { color: #8b909a; }
    a { color: #7eb8da; }
  </style>
</head>
<body>
  <h1>DPS-Sim Usage Summary</h1>
  <p class="muted">Log of simulation runs when <code>USAGE_LOG_URL</code> is set in the app.</p>
  <div class="stats">
    <div class="stat">
      <strong>Total simulations run</strong>
      <span>${totalRuns}</span>
    </div>
    <div class="stat">
      <strong>Unique users</strong>
      <span>${uids.size}</span>
    </div>
  </div>
  <h2>Recent runs (timestamp and parameters)</h2>
  <table>
    <thead>
      <tr>
        <th>Time (UTC)</th>
        <th>Class</th>
        <th>W1</th>
        <th>W2</th>
        <th>Duration</th>
        <th>Runs</th>
        <th>Total dmg</th>
        <th>Special / Fistweaving</th>
      </tr>
    </thead>
    <tbody>
      ${recent.length === 0
        ? '<tr><td colspan="8" class="muted">No runs logged yet.</td></tr>'
        : recent
            .map(
              (e) => `<tr>
        <td class="mono">${escapeHtml(formatTs(e.ts))}</td>
        <td>${escapeHtml(e.ranged ? 'Ranged' : (e.classId || '—'))}</td>
        <td class="mono">${e.w1 ? escapeHtml(e.w1.name || [e.w1.preset || e.w1.damage, e.w1.delay].filter(Boolean).join(' / ')) : '—'}</td>
        <td class="mono">${e.w2 ? escapeHtml(e.w2.name || [e.w2.preset || e.w2.damage, e.w2.delay].filter(Boolean).join(' / ')) : '—'}</td>
        <td>${escapeHtml(e.durationSec ?? '—')}</td>
        <td>${escapeHtml(e.runs ?? '—')}</td>
        <td>${escapeHtml(e.totalDamage ?? '—')}</td>
        <td>${e.ranged ? '—' : ((e.specialAttacks ? 'Special ' : '') + (e.fistweaving ? 'FW' : '') || '—')}</td>
      </tr>`
            )
            .join('')}
    </tbody>
  </table>
  <p class="muted" style="margin-top: 1rem;">Showing up to ${MAX_LOG_ENTRIES} most recent. <a href="/">Back to DPS-Sim</a></p>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(200).end(html);
}
