#!/usr/bin/env node
/**
 * Regenerate resources/npc_types.json and resources/spells_en.json from a Project Quarm
 * database dump, so the sim's shipped data matches the live server.
 *
 * Usage:
 *   node tools/extract-dump-tables.js <dump.sql>
 *   node tools/extract-dump-tables.js C:\Projects\quarmdb\quarm_2026-10-25-22_33.sql
 *
 * Writes (then run `npm run build-file-bundles` to rebuild the *-data.js bundles):
 *   resources/npc_types.json   array of npc_types rows (same column names as the old file)
 *   resources/spells_en.json   object keyed by spell id, one entry per spells_en row
 *
 * Column names come from the dump's own CREATE TABLE statements, so a schema change in the
 * server DB flows through without editing this script.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const REPO = path.resolve(__dirname, '..');
const WANT_ITEMS = process.argv.includes('--items');
const WANTED = new Set(['npc_types', 'spells_en'].concat(WANT_ITEMS ? ['items'] : []));

function coerce(raw) {
  const s = raw.trim();
  if (s === 'NULL') return null;
  if (s === '') return '';
  const n = Number(s);
  return Number.isNaN(n) ? s : n;
}

/** Parse one `(a,'b',NULL,...)` tuple. Strings: single-quoted, backslash escapes and doubled quotes. */
function parseTuple(line) {
  const open = line.indexOf('(');
  if (open === -1) return null;
  const out = [];
  let i = open + 1;
  let cur = '';
  let inStr = false;
  let wasQuoted = false;
  const BS = String.fromCharCode(92);
  while (i < line.length) {
    const ch = line[i];
    if (inStr) {
      if (ch === BS) {
        const nx = line[i + 1];
        if (nx === 'n') cur += '\n';
        else if (nx === 'r') cur += '\r';
        else if (nx === 't') cur += '\t';
        else if (nx === '0') cur += String.fromCharCode(0);
        else if (nx !== undefined) cur += nx;
        i += 2;
        continue;
      }
      if (ch === "'") {
        if (line[i + 1] === "'") { cur += "'"; i += 2; continue; }
        inStr = false; i++; continue;
      }
      cur += ch; i++; continue;
    }
    if (ch === "'") { inStr = true; wasQuoted = true; i++; continue; }
    if (ch === ',') { out.push(wasQuoted ? cur : coerce(cur)); cur = ''; wasQuoted = false; i++; continue; }
    if (ch === ')') { out.push(wasQuoted ? cur : coerce(cur)); return out; }
    cur += ch; i++;
  }
  return null;
}

function splitTuples(text) {
  const BS = String.fromCharCode(92);
  const tuples = [];
  let depth = 0, inStr = false, start = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (ch === BS) { i++; continue; }
      if (ch === "'") { if (text[i + 1] === "'") i++; else inStr = false; }
      continue;
    }
    if (ch === "'") { inStr = true; continue; }
    if (ch === '(') { if (depth++ === 0) start = i; continue; }
    if (ch === ')') {
      if (--depth === 0 && start >= 0) {
        const tup = parseTuple(text.slice(start, i + 1));
        if (tup) tuples.push(tup);
        start = -1;
      }
    }
  }
  return tuples;
}

async function main() {
  const dumpPath = process.argv.slice(2).find((a) => !a.startsWith('--'));
  if (!dumpPath) {
    console.error('Usage: node tools/extract-dump-tables.js <dump.sql>');
    process.exit(1);
  }
  const cols = {};
  const rows = { npc_types: [], spells_en: [], items: [] };
  let creating = null;
  let current = null;

  const rl = readline.createInterface({ input: fs.createReadStream(dumpPath), crlfDelay: Infinity });
  for await (const line of rl) {
    const mc = /^CREATE TABLE `([a-z_0-9]+)` \(/.exec(line);
    if (mc) { creating = WANTED.has(mc[1]) ? mc[1] : null; if (creating) cols[creating] = []; continue; }
    if (creating) {
      const col = /^\s+`([A-Za-z_0-9]+)` /.exec(line);
      if (col) { cols[creating].push(col[1]); continue; }
      if (/^\)/.test(line)) { creating = null; continue; }
      continue;
    }
    if (line.startsWith('INSERT INTO ')) {
      const m = /^INSERT INTO `([a-z_0-9]+)` VALUES/.exec(line);
      current = m && WANTED.has(m[1]) ? m[1] : null;
      const rest = line.slice(line.indexOf('VALUES') + 6).trim();
      if (current && rest) {
        for (const tup of splitTuples(rest)) rows[current].push(tup);
        if (rest.endsWith(';')) current = null;
      }
      continue;
    }
    if (!current) continue;
    if (line.startsWith('(')) {
      const tup = parseTuple(line);
      if (tup) rows[current].push(tup);
    }
    if (line.trimEnd().endsWith(';')) current = null;
  }

  if (WANT_ITEMS) {
    // Refresh resources/items.json IN PLACE: the shipped file is a curated subset of the items table (23,257 of ~27,000 rows;
    // tokens, bags, books and quest junk are excluded), so keep that id set and only refresh the data columns. Values are kept as
    // strings like the old export, and columns the dump does not have (the mod2 stats) are carried over from the old record.
    const itemsPath = path.join(REPO, 'resources', 'items.json');
    const old = JSON.parse(fs.readFileSync(itemsPath, 'utf8'));
    const ic = cols.items;
    const idIdx = ic.indexOf('id');
    const fresh = {};
    let refreshed = 0;
    for (const r of rows.items) {
      const id = String(r[idIdx]);
      const prev = old[id];
      if (!prev) continue;
      const o = {};
      ic.forEach((c, i) => { o[c] = r[i] === null || r[i] === undefined ? null : String(r[i]); });
      for (const k of Object.keys(prev)) if (!(k in o)) o[k] = prev[k];
      // The server tags ~85% of items min_expansion = -1 ("always available"); the sim's era selector needs a real era for them,
      // so the era classification already stored in the shipped file is kept wherever the dump has no tag of its own.
      if (o.min_expansion === '-1' && prev.min_expansion !== undefined && prev.min_expansion !== null) o.min_expansion = prev.min_expansion;
      fresh[id] = o;
      refreshed++;
    }
    const missingFromDump = Object.keys(old).filter((id) => !fresh[id]);
    missingFromDump.forEach((id) => { fresh[id] = old[id]; });
    fs.writeFileSync(itemsPath, JSON.stringify(fresh));
    console.log('items: refreshed ' + refreshed + ' of ' + Object.keys(old).length + ' (kept ' + missingFromDump.length + ' not present in the dump)');
  }

  for (const t of ['npc_types', 'spells_en']) {
    if (!cols[t] || !cols[t].length) { console.error('No CREATE TABLE found for ' + t); process.exit(1); }
    console.log(t + ': ' + cols[t].length + ' columns, ' + rows[t].length + ' rows');
  }

  const npc = rows.npc_types.map((r) => {
    const o = {};
    cols.npc_types.forEach((c, i) => { o[c] = r[i] !== undefined ? r[i] : null; });
    return o;
  });
  fs.writeFileSync(path.join(REPO, 'resources', 'npc_types.json'), JSON.stringify(npc, null, 1));

  // The previously shipped spells_en.json carried most numeric columns as strings (it came from a CSV export) and the
  // sim reads them through Number(). Keep that column typing so downstream code sees the same shapes as before.
  const spellsPath = path.join(REPO, 'resources', 'spells_en.json');
  let stringCols = new Set();
  if (fs.existsSync(spellsPath)) {
    try {
      const old = JSON.parse(fs.readFileSync(spellsPath, 'utf8'));
      const sample = old['418'] || old[Object.keys(old)[1]];
      if (sample) Object.keys(sample).forEach((k) => { if (typeof sample[k] === 'string' && sample[k] !== '' && !Number.isNaN(Number(sample[k]))) stringCols.add(k); });
    } catch (e) { /* first run: keep native numbers */ }
  }
  const idCol = cols.spells_en.indexOf('id');
  const spells = {};
  for (const r of rows.spells_en) {
    const o = {};
    cols.spells_en.forEach((c, i) => {
      let v = r[i] !== undefined ? r[i] : null;
      if (typeof v === 'number' && stringCols.has(c)) v = String(v);
      o[c] = v;
    });
    spells[String(r[idCol])] = o;
  }
  fs.writeFileSync(path.join(REPO, 'resources', 'spells_en.json'), JSON.stringify(spells, null, 1));
  console.log('Wrote resources/npc_types.json (' + npc.length + ') and resources/spells_en.json (' + Object.keys(spells).length + ')');
}

main().catch((e) => { console.error(e); process.exit(1); });
