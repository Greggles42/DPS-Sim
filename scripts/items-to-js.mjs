/**
 * Emit resources/items-data.js from resources/items.json.
 * Strips unneeded fields to reduce file size (items.json is ~64MB; items-data.js is ~4MB).
 * Run: node scripts/items-to-js.mjs
 *
 * NOTE: items.json is NOT committed to git due to its large size (~64MB).
 *       items-data.js IS committed so Vercel can serve it without a build step.
 *       Regenerate items-data.js only when items.json has been updated.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const res = path.join(__dirname, '..', 'resources');
const jsonPath = path.join(res, 'items.json');
const outPath = path.join(res, 'items-data.js');

if (!fs.existsSync(jsonPath)) {
  console.error('ERROR: items.json not found at', jsonPath);
  console.error('This file is not in git due to its large size (~64MB).');
  console.error('Obtain it from the EQEmu database export and place it at resources/items.json.');
  process.exit(1);
}

const KEEP_FIELDS = new Set([
  'id', 'Name', 'ac', 'astr', 'adex', 'aagi', 'awis', 'asta', 'aint', 'acha',
  'hp', 'mana', 'damage', 'delay', 'itemtype', 'worneffect', 'wornlevel',
  'classes', 'slots', 'icon', 'skillmodtype', 'skillmodvalue'
]);

console.log('Reading', jsonPath);
const raw = fs.readFileSync(jsonPath, 'utf8');
console.log('Parsing JSON (large file, may take a moment)...');
const data = JSON.parse(raw);
const count = Object.keys(data).length;
console.log('Filtering', count, 'items to', KEEP_FIELDS.size, 'fields...');

const out = {};
for (const [id, item] of Object.entries(data)) {
  const filtered = {};
  for (const key of KEEP_FIELDS) {
    if (key in item) filtered[key] = item[key];
  }
  out[id] = filtered;
}

const js =
  '/* Generated items-data.js — wearable items from items.json, ' + count + ' items */\n' +
  'window.__DPS_ITEMS__=' + JSON.stringify(out) + ';\n';

fs.writeFileSync(outPath, js);
console.log('Wrote', outPath, '(' + Math.round(fs.statSync(outPath).size / 1024) + ' KB)');
