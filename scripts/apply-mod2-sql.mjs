/**
 * Apply the Quarm "mod2" item stats SQL (utils/sql/git/required/2026_11_18_items_mod2_stats.sql)
 * to resources/items.json. Idempotent.
 * Run: node scripts/apply-mod2-sql.mjs [path-to-sql]
 * Then: node scripts/items-to-js.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const res = path.join(__dirname, '..', 'resources');
const jsonPath = path.join(res, 'items.json');
const sqlPath = process.argv[2] || path.join(res, 'sql', '2026_11_18_items_mod2_stats.sql');

const MOD2_FIELDS = ['strikethrough', 'stunresist', 'combateffects', 'accuracy', 'avoidance', 'spellshield', 'shielding', 'damageshield'];

const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
const sql = fs.readFileSync(sqlPath, 'utf8');

// ALTER TABLE: every item gets the new columns, default 0.
let added = 0;
for (const item of Object.values(data)) {
  for (const f of MOD2_FIELDS) {
    if (!(f in item)) { item[f] = '0'; added++; }
  }
}

let touched = 0, missing = [];
for (const rawLine of sql.split(/\r?\n/)) {
  const line = rawLine.replace(/--.*$/, '').trim();
  // Simple mod2 updates: UPDATE `items` SET `a` = 1, `b` = 2 WHERE `id` = N;
  let m = line.match(/^UPDATE `items` SET (.+?) WHERE `id` = (\d+);?$/i);
  if (m) {
    const item = data[m[2]];
    if (!item) { missing.push(m[2]); continue; }
    for (const pair of m[1].split(',')) {
      const [col, val] = pair.split('=').map(s => s.trim().replace(/`/g, ''));
      if (!MOD2_FIELDS.includes(col)) throw new Error('Unexpected column ' + col);
      item[col] = String(parseInt(val, 10));
    }
    touched++;
  }
}

// Shroud of Eternity worn-effect swap (multi-line statement, handled explicitly).
const shroud = data['15805'];
if (/`worneffect` = 144/.test(sql) && shroud) {
  if (shroud.worneffect === '771') {
    Object.assign(shroud, { worneffect: '144', worntype: '2', wornlevel: '0', wornlevel2: '0' });
    console.log('Shroud of Eternity: worneffect 771 -> 144');
  } else {
    console.log('Shroud of Eternity: worneffect already', shroud.worneffect, '(unchanged)');
  }
}

if (missing.length) console.warn('WARNING: ids not found in items.json:', missing.join(', '));
const nonzero = Object.values(data).filter(i => MOD2_FIELDS.some(f => i[f] !== '0')).length;
console.log(`Fields added: ${added}; UPDATE statements applied: ${touched}; items with any mod2 stat: ${nonzero}`);
fs.writeFileSync(jsonPath, JSON.stringify(data));
console.log('Wrote', jsonPath);
