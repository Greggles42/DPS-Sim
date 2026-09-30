/**
 * GET /api/summary — DPS-Sim usage summary page.
 * Shows total simulations run, unique users, and a log of recent runs with parameters.
 * Uses Vercel KV. Reads are batched into ONE pipeline() round trip: the precomputed
 * dps_sim_stats hash (written incrementally by api/log.js), unique-user count, and a
 * capped slice of the raw log for the "recent runs" table. No re-scanning of the full
 * raw log on every view — that's what dps_sim_stats exists to avoid.
 * Response is edge-cached for 60s (stale-while-revalidate 300s) so repeat views don't
 * hit KV at all within that window.
 * Visit: https://dps-sim.vercel.app/api/summary
 */
import { kv } from '@vercel/kv';

const LOG_KEY = 'dps_sim_log';
const UIDS_KEY = 'dps_sim_uids';
const STATS_KEY = 'dps_sim_stats';
const RECENT_ENTRIES = 50;
const MIN_BUILD_SAMPLE = 5;
const D = '~~';

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

/** Parses the flat dps_sim_stats hash into structured aggregates. */
function parseStats(stats) {
  const total = Number(stats.total) || 0;
  const modeCounts = { dps: 0, ranged: 0, tanking: 0, other: 0 };
  const eraCounts = {};
  const classCounts = {};
  const classDps = {}; // classId -> { sum, count }
  const comboCounts = {};
  const builds = {}; // "classId~~comboLabel~~era" -> { sum, count }

  for (const [field, rawVal] of Object.entries(stats)) {
    if (field === 'total') continue;
    const val = Number(rawVal) || 0;
    const parts = field.split(D);
    const kind = parts[0];

    if (kind === 'mode' && parts.length === 2) {
      const m = parts[1];
      if (modeCounts[m] != null) modeCounts[m] += val;
      else modeCounts.other += val;
    } else if (kind === 'era' && parts.length === 2) {
      eraCounts[parts[1]] = (eraCounts[parts[1]] || 0) + val;
    } else if (kind === 'class' && parts.length === 3) {
      const [, classId, metric] = parts;
      if (metric === 'count') classCounts[classId] = (classCounts[classId] || 0) + val;
      else if (metric === 'dpsSum' || metric === 'dpsCount') {
        classDps[classId] = classDps[classId] || { sum: 0, count: 0 };
        if (metric === 'dpsSum') classDps[classId].sum += val;
        else classDps[classId].count += val;
      }
    } else if (kind === 'combo' && parts.length === 2) {
      comboCounts[parts[1]] = (comboCounts[parts[1]] || 0) + val;
    } else if (kind === 'build' && parts.length === 5) {
      const [, classId, comboLabel, era, metric] = parts;
      const key = `${classId}${D}${comboLabel}${D}${era}`;
      builds[key] = builds[key] || { classId, comboLabel, era, sum: 0, count: 0 };
      if (metric === 'dpsSum') builds[key].sum += val;
      else if (metric === 'count') builds[key].count += val;
    }
  }

  return { total, modeCounts, eraCounts, classCounts, classDps, comboCounts, builds };
}

function topN(countsObj, n) {
  return Object.entries(countsObj)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n);
}

/** Best avg-DPS build per class, filtered to a minimum sample size. */
function bestBuildsByClass(builds) {
  const best = {};
  for (const b of Object.values(builds)) {
    if (b.count < MIN_BUILD_SAMPLE) continue;
    const avg = b.sum / b.count;
    if (!best[b.classId] || avg > best[b.classId].avg) {
      best[b.classId] = { comboLabel: b.comboLabel, era: b.era, avg, count: b.count };
    }
  }
  return best;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(404).end();
  }

  let stats = {};
  let uniqueUsers = 0;
  const entries = [];

  try {
    const pipe = kv.pipeline();
    pipe.hgetall(STATS_KEY);
    pipe.scard(UIDS_KEY);
    pipe.lrange(LOG_KEY, -RECENT_ENTRIES, -1);
    const [statsRaw, uniqueUsersRaw, raw] = await pipe.exec();

    stats = statsRaw && typeof statsRaw === 'object' ? statsRaw : {};
    uniqueUsers = Number(uniqueUsersRaw) || 0;
    if (Array.isArray(raw)) {
      for (const item of raw) {
        try {
          const row = typeof item === 'string' ? JSON.parse(item) : item;
          if (row && typeof row === 'object') entries.push(row);
        } catch (_e) {
          /* skip bad entry */
        }
      }
    }
  } catch (_e) {
    /* KV not configured or read failed */
  }

  const { total, modeCounts, eraCounts, classCounts, classDps, comboCounts, builds } = parseStats(stats);

  // Most recent first
  const recent = entries.slice().reverse();

  const eraOrder = ['classic', 'kunark', 'velious', 'luclin', 'pop', 'unknown'];
  const eraRows = eraOrder
    .filter(k => eraCounts[k] > 0)
    .map(k => `<tr><td>${escapeHtml(k)}</td><td>${eraCounts[k]}</td></tr>`)
    .join('');

  const classDpsRows = Object.keys(classDps)
    .filter(c => classDps[c].count > 0)
    .sort()
    .map(c => {
      const avg = (classDps[c].sum / classDps[c].count).toFixed(1);
      return `<tr><td>${escapeHtml(c)}</td><td>${classDps[c].count}</td><td>${avg}</td></tr>`;
    })
    .join('');

  const topClasses = topN(classCounts, 8);
  const topClassRows = topClasses
    .map(([c, n]) => `<tr><td>${escapeHtml(c)}</td><td>${n}</td></tr>`)
    .join('');

  const topCombos = topN(comboCounts, 8);
  const topComboRows = topCombos
    .map(([c, n]) => `<tr><td class="mono">${escapeHtml(c)}</td><td>${n}</td></tr>`)
    .join('');

  const best = bestBuildsByClass(builds);
  const bestBuildRows = Object.keys(best)
    .sort()
    .map(c => {
      const b = best[c];
      return `<tr><td>${escapeHtml(c)}</td><td class="mono">${escapeHtml(b.comboLabel)}</td><td>${escapeHtml(b.era)}</td><td>${b.avg.toFixed(1)}</td><td>${b.count}</td></tr>`;
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
  <p class="muted">Log of simulation runs when <code>USAGE_LOG_URL</code> is set in the app. Aggregates below are lifetime counters, not limited to the recent-runs table.</p>
  <div class="stats">
    <div class="stat">
      <strong>Total simulations run</strong>
      <span>${total}</span>
    </div>
    <div class="stat">
      <strong>Unique users</strong>
      <span>${uniqueUsers}</span>
    </div>
    <div class="stat">
      <strong>DPS runs (melee &amp; caster)</strong>
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

  <h2>Analytics (lifetime, from precomputed counters)</h2>
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
    <div class="analytics-card">
      <h3>Most-Simulated Classes</h3>
      <table>
        <thead><tr><th>Class</th><th>Runs</th></tr></thead>
        <tbody>${topClassRows || '<tr><td colspan="2" class="muted">No data yet.</td></tr>'}</tbody>
      </table>
    </div>
    <div class="analytics-card">
      <h3>Most-Simulated Weapon Combos</h3>
      <table>
        <thead><tr><th>Combo</th><th>Runs</th></tr></thead>
        <tbody>${topComboRows || '<tr><td colspan="2" class="muted">No data yet.</td></tr>'}</tbody>
      </table>
    </div>
  </div>

  <h2>Best avg-DPS build per class <span class="muted">(min ${MIN_BUILD_SAMPLE} runs)</span></h2>
  <table>
    <thead><tr><th>Class</th><th>Weapon combo</th><th>Era</th><th>Avg DPS</th><th>Sample</th></tr></thead>
    <tbody>${bestBuildRows || '<tr><td colspan="5" class="muted">Not enough data yet for any class/build to reach the minimum sample size.</td></tr>'}</tbody>
  </table>

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
  <p class="muted" style="margin-top: 1rem;">Showing up to ${RECENT_ENTRIES} most recent. <a href="/">Back to DPS-Sim</a></p>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
  return res.status(200).end(html);
}
