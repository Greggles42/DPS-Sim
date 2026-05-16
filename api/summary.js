/**
 * GET /api/summary — DPS-Sim usage summary page.
 * Shows total simulations run, unique users, and a log of recent runs with parameters.
 * Uses Vercel KV (no Blob list()).
 * Visit: https://dps-sim.vercel.app/api/summary
 */
import { kv } from '@vercel/kv';

const LOG_KEY = 'dps_sim_log';
const UIDS_KEY = 'dps_sim_uids';
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
  return d.toLocaleString('sv', { timeZone: 'America/Los_Angeles' }).slice(0, 16) + ' PT';
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(404).end();
  }

  let totalRuns = 0;
  let uniqueUsers = 0;
  const entries = [];

  try {
    totalRuns = (await kv.llen(LOG_KEY)) || 0;
    uniqueUsers = (await kv.scard(UIDS_KEY)) || 0;
    // Last MAX_LOG_ENTRIES (Redis: -N to -1 is last N)
    const raw = await kv.lrange(LOG_KEY, -MAX_LOG_ENTRIES, -1);
    if (Array.isArray(raw)) {
      for (let i = 0; i < raw.length; i++) {
        try {
          const row = typeof raw[i] === 'string' ? JSON.parse(raw[i]) : raw[i];
          if (row && typeof row === 'object') entries.push(row);
        } catch (_e) {
          /* skip bad entry */
        }
      }
    }
  } catch (_e) {
    /* KV not configured or read failed */
  }

  // Most recent first (KV lrange returns oldest-to-newest for -N..-1)
  const recent = entries.slice().reverse();

  // --- Analytics aggregations ---

  // Mode breakdown
  const modeCounts = { dps: 0, ranged: 0, tanking: 0, other: 0 };
  for (const e of entries) {
    const mode = e.simMode || (e.ranged ? 'ranged' : 'dps');
    if (mode === 'dps') modeCounts.dps++;
    else if (mode === 'ranged') modeCounts.ranged++;
    else if (mode === 'tanking') modeCounts.tanking++;
    else modeCounts.other++;
  }

  // Era distribution
  const eraCounts = {};
  for (const e of entries) {
    const era = e.era || 'unknown';
    eraCounts[era] = (eraCounts[era] || 0) + 1;
  }
  const eraOrder = ['classic', 'kunark', 'velious', 'luclin', 'pop', 'unknown'];
  const eraRows = eraOrder
    .filter(k => eraCounts[k] > 0)
    .map(k => `<tr><td>${escapeHtml(k)}</td><td>${eraCounts[k]}</td></tr>`)
    .join('');

  // Average DPS by class (dps mode only, exclude 0 dps)
  const classDpsMap = {};
  for (const e of entries) {
    if ((e.simMode === 'dps' || (!e.simMode && !e.ranged)) && e.classId && e.dps > 0) {
      if (!classDpsMap[e.classId]) classDpsMap[e.classId] = { sum: 0, count: 0 };
      classDpsMap[e.classId].sum += e.dps;
      classDpsMap[e.classId].count++;
    }
  }
  const classDpsRows = Object.keys(classDpsMap)
    .sort()
    .map(c => {
      const avg = (classDpsMap[c].sum / classDpsMap[c].count).toFixed(1);
      return `<tr><td>${escapeHtml(c)}</td><td>${classDpsMap[c].count}</td><td>${avg}</td></tr>`;
    })
    .join('');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>DPS-Sim Usage Summary</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 1000px; margin: 0 auto; padding: 1.5rem; background: #1a1d23; color: #e6e8ec; }
    h1 { color: #7eb8da; font-size: 1.5rem; }
    .stats { display: flex; flex-wrap: wrap; gap: 2rem; margin: 1rem 0; font-size: 1.1rem; }
    .stat { background: #252830; padding: 0.75rem 1.25rem; border-radius: 8px; border: 1px solid #3d4452; }
    .stat strong { display: block; color: #8b909a; font-size: 0.8rem; text-transform: uppercase; }
    .stat span { font-size: 1.5rem; }
    h2 { color: #8b909a; font-size: 0.95rem; margin: 1.5rem 0 0.5rem; }
    .analytics-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1.5rem; margin: 1rem 0; }
    .analytics-card { background: #252830; border: 1px solid #3d4452; border-radius: 8px; padding: 1rem; }
    .analytics-card h3 { color: #7eb8da; font-size: 0.85rem; margin: 0 0 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; }
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
      <span>${uniqueUsers}</span>
    </div>
    <div class="stat">
      <strong>Melee DPS runs</strong>
      <span>${modeCounts.dps}</span>
    </div>
    <div class="stat">
      <strong>Ranged runs</strong>
      <span>${modeCounts.ranged}</span>
    </div>
    <div class="stat">
      <strong>Tanking runs</strong>
      <span>${modeCounts.tanking}</span>
    </div>
  </div>

  <h2>Analytics (from logged runs)</h2>
  <div class="analytics-grid">
    <div class="analytics-card">
      <h3>Era Distribution</h3>
      <table>
        <thead><tr><th>Era</th><th>Runs</th></tr></thead>
        <tbody>${eraRows || '<tr><td colspan="2" class="muted">No era data yet.</td></tr>'}</tbody>
      </table>
    </div>
    <div class="analytics-card">
      <h3>Avg DPS by Class</h3>
      <table>
        <thead><tr><th>Class</th><th>Runs</th><th>Avg DPS</th></tr></thead>
        <tbody>${classDpsRows || '<tr><td colspan="3" class="muted">No DPS data yet.</td></tr>'}</tbody>
      </table>
    </div>
  </div>

  <h2>Recent runs (timestamp and parameters)</h2>
  <table>
    <thead>
      <tr>
        <th>Time (PT)</th>
        <th>UI Mode</th>
        <th>Sim Mode</th>
        <th>Era</th>
        <th>Class</th>
        <th>W1</th>
        <th>W2</th>
        <th>Duration</th>
        <th>Runs</th>
        <th>Target AC</th>
        <th>Total dmg</th>
        <th>Special / Notes</th>
      </tr>
    </thead>
    <tbody>
      ${recent.length === 0
        ? '<tr><td colspan="12" class="muted">No runs logged yet.</td></tr>'
        : recent
            .map(
              (e) => {
                const simMode = e.simMode || (e.ranged ? 'ranged' : 'dps');
                const isRankWeapons = e.event === 'rank_weapons';
                const uiMode = e.mode ? (e.mode === 'advanced' ? 'Advanced' : 'Easy') : '—';
                const uiModeStyle = e.mode === 'advanced' ? 'color:#d4af37' : (e.mode === 'easy' ? 'color:#7eb8da' : '');
                let specialCell;
                if (isRankWeapons) {
                  specialCell = '<em class="muted">Rank Weapons</em>';
                } else if (simMode === 'ranged') {
                  specialCell = '—';
                } else {
                  specialCell = escapeHtml((e.specialAttacks ? 'Special ' : '') + (e.fistweaving ? 'FW' : '') || '—');
                }
                return `<tr>
        <td class="mono">${escapeHtml(formatTs(e.ts))}</td>
        <td style="${uiModeStyle}">${uiMode}</td>
        <td>${escapeHtml(simMode)}</td>
        <td>${escapeHtml(e.era || '—')}</td>
        <td>${escapeHtml(simMode === 'ranged' ? 'Ranged' : (e.classId || '—'))}</td>
        <td class="mono">${e.w1 ? escapeHtml(e.w1.name || [e.w1.preset || e.w1.damage, e.w1.delay].filter(Boolean).join(' / ')) : '—'}</td>
        <td class="mono">${e.w2 ? escapeHtml(e.w2.name || [e.w2.preset || e.w2.damage, e.w2.delay].filter(Boolean).join(' / ')) : '—'}</td>
        <td>${escapeHtml(e.durationSec ?? '—')}</td>
        <td>${escapeHtml(e.runs ?? '—')}</td>
        <td>${escapeHtml(e.targetAC ?? '—')}</td>
        <td>${escapeHtml(e.totalDamage ?? '—')}</td>
        <td>${specialCell}</td>
      </tr>`;
              }
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
