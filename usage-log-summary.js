/**
 * Summarize usage-log.jsonl produced by usage-log-server.js.
 * Run: node usage-log-summary.js
 * Prints: total runs, unique users, top weapon combos, class breakdown, etc.
 */

const fs = require('fs');
const path = require('path');

const LOG_FILE = path.join(__dirname, 'usage-log.jsonl');

if (!fs.existsSync(LOG_FILE)) {
  console.log('No usage-log.jsonl found. Run usage-log-server.js and set USAGE_LOG_URL in index.html.');
  process.exit(0);
}

const lines = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').filter(Boolean);
const events = lines.map(function (line) {
  try {
    return JSON.parse(line);
  } catch (_e) {
    return null;
  }
}).filter(Boolean).filter(function (e) { return e.event === 'sim_run'; });

const totalRuns = events.length;
const uniqueUsers = new Set(events.map(function (e) { return e.uid; })).size;

const byClass = {};
const byW1Preset = {};
const byCombo = {};
let withSpecial = 0;
let withFistweaving = 0;

events.forEach(function (e) {
  const c = e.classId || 'none';
  byClass[c] = (byClass[c] || 0) + 1;
  const w1 = (e.w1 && e.w1.preset) ? e.w1.preset : 'custom';
  byW1Preset[w1] = (byW1Preset[w1] || 0) + 1;
  const w2 = (e.w2 && e.w2.preset) ? e.w2.preset : 'none';
  const combo = w1 + ' + ' + w2;
  byCombo[combo] = (byCombo[combo] || 0) + 1;
  if (e.specialAttacks) withSpecial++;
  if (e.fistweaving) withFistweaving++;
});

console.log('--- DPS-Sim usage summary ---');
console.log('Total sim runs:', totalRuns);
console.log('Unique users (by anonymous id):', uniqueUsers);
console.log('');
console.log('Runs by class:', byClass);
console.log('');
console.log('Runs by main-hand preset (top 10):', Object.entries(byW1Preset).sort(function (a, b) { return b[1] - a[1]; }).slice(0, 10));
console.log('');
console.log('Top weapon combinations (top 10):', Object.entries(byCombo).sort(function (a, b) { return b[1] - a[1]; }).slice(0, 10));
console.log('');
console.log('Runs with special attacks:', withSpecial);
console.log('Runs with fistweaving:', withFistweaving);
