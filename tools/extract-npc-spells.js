#!/usr/bin/env node
/**
 * Extract NPC spell lists from a Project Quarm database dump.
 *
 * The tanking sim needs to know what a mob casts at you. That lives in two tables
 * of the server DB: `npc_spells` (the AI casting parameters + weapon proc) and
 * `npc_spells_entries` (the actual spells in each list). `npc_types.npc_spells_id`
 * points at a list; lists can inherit from a `parent_list`.
 *
 * Source dump ships with the server source, e.g.
 *   C:\Projects\EQMacEmu-src\utils\sql\database_full\quarm_2026-03-20-09_37.tar.gz
 *
 * Usage:
 *   node tools/extract-npc-spells.js <dump.tar.gz | dump.sql> [--all]
 *
 * By default only lists reachable from resources/npc_types.json are kept (plus their
 * ancestors). --all keeps every list.
 *
 * Writes resources/npc_spells.json and resources/npc_spells-data.js.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

const REPO = path.resolve(__dirname, '..');

// spdat.h — npc_spells_entries.type is a bitmask of these.
const SPELL_TYPE = {
  Nuke: 1, Heal: 2, Root: 4, Buff: 8, Escape: 16, Pet: 32, Lifetap: 64,
  Snare: 128, DOT: 256, Dispel: 512, InCombatBuff: 1024, Mez: 2048,
  Charm: 4096, Slow: 8192, Debuff: 16384, Cure: 32768, Resurrect: 65536
};
const DETRIMENTAL =
  SPELL_TYPE.Nuke | SPELL_TYPE.Root | SPELL_TYPE.Lifetap | SPELL_TYPE.Snare |
  SPELL_TYPE.DOT | SPELL_TYPE.Dispel | SPELL_TYPE.Mez | SPELL_TYPE.Charm |
  SPELL_TYPE.Debuff | SPELL_TYPE.Slow;

// Column order as declared in the dump's CREATE TABLE statements.
const NPC_SPELLS_COLS = [
  'id', 'name', 'parent_list', 'attack_proc', 'proc_chance', 'range_proc',
  'rproc_chance', 'defensive_proc', 'dproc_chance', 'fail_recast',
  'engaged_no_sp_recast_min', 'engaged_no_sp_recast_max',
  'engaged_b_self_chance', 'engaged_b_other_chance', 'engaged_d_chance',
  'pursue_no_sp_recast_min', 'pursue_no_sp_recast_max', 'pursue_d_chance',
  'idle_no_sp_recast_min', 'idle_no_sp_recast_max', 'idle_b_chance'
];

const NPC_SPELLS_ENTRIES_COLS = [
  'id', 'npc_spells_id', 'spellid', 'type', 'minlevel', 'maxlevel', 'manacost',
  'recast_delay', 'priority', 'resist_adjust', 'min_expansion', 'max_expansion',
  'content_flags', 'content_flags_disabled'
];

// ---------------------------------------------------------------------------
// SQL value-tuple parsing
// ---------------------------------------------------------------------------

/**
 * Parse one `(a,'b',NULL,...)` tuple into an array of JS values.
 * Handles single-quoted strings with backslash escapes and doubled quotes.
 */
function parseTuple(line) {
  const open = line.indexOf('(');
  if (open === -1) return null;

  const out = [];
  let i = open + 1;
  let cur = '';
  let inStr = false;

  while (i < line.length) {
    const ch = line[i];

    if (inStr) {
      if (ch === '\\') { cur += line[i + 1] === undefined ? '' : line[i + 1]; i += 2; continue; }
      if (ch === "'") {
        if (line[i + 1] === "'") { cur += "'"; i += 2; continue; }  // doubled quote
        inStr = false; i++; continue;
      }
      cur += ch; i++; continue;
    }

    if (ch === "'") { inStr = true; i++; continue; }
    if (ch === ',') { out.push(coerce(cur)); cur = ''; i++; continue; }
    if (ch === ')') { out.push(coerce(cur)); return out; }
    cur += ch; i++;
  }
  return null;  // unterminated
}

function coerce(raw) {
  const s = raw.trim();
  if (s === 'NULL') return null;
  if (s === '') return '';
  const n = Number(s);
  return Number.isNaN(n) ? s : n;
}

/**
 * Stream a SQL dump line by line, invoking onRow(table, valuesArray) for every
 * row of the tables we care about. Multi-row INSERTs put one tuple per line.
 */
function streamDump(input, wanted, onRow) {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input, crlfDelay: Infinity });
    let current = null;

    rl.on('line', (line) => {
      if (line.startsWith('INSERT INTO ')) {
        const m = /^INSERT INTO `([a-z_0-9]+)` VALUES/.exec(line);
        current = m && wanted.has(m[1]) ? m[1] : null;
        // Single-line INSERT: values follow on the same line.
        const rest = line.slice(line.indexOf('VALUES') + 6).trim();
        if (current && rest && rest !== '') {
          for (const tup of splitTuples(rest)) onRow(current, tup);
          if (rest.endsWith(';')) current = null;
        }
        return;
      }
      if (!current) return;
      if (line.startsWith('(')) {
        const tup = parseTuple(line);
        if (tup) onRow(current, tup);
      }
      if (line.trimEnd().endsWith(';')) current = null;
    });

    rl.on('close', resolve);
    rl.on('error', reject);
  });
}

/** Split a `(...),(...)` run into individual tuples. */
function splitTuples(text) {
  const tuples = [];
  let depth = 0, inStr = false, start = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (ch === '\\') { i++; continue; }
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

function toObject(cols, values) {
  const o = {};
  for (let i = 0; i < cols.length; i++) o[cols[i]] = values[i] !== undefined ? values[i] : null;
  return o;
}

// ---------------------------------------------------------------------------
// Input: accept either a .sql file or the shipped .tar.gz
// ---------------------------------------------------------------------------

function openDump(dumpPath) {
  if (/\.sql$/i.test(dumpPath)) {
    return { stream: fs.createReadStream(dumpPath), child: null };
  }
  // The archive holds several .sql members; the main one is named after the
  // archive itself and is the only one carrying npc_* tables. Its inner name
  // uses colons, which tar on Windows handles fine when writing to stdout.
  //
  // Run tar from the archive's own directory and pass only the basename: GNU tar
  // treats a leading `C:` in a path as a remote host and refuses to open it.
  const child = spawn('tar', ['-xzOf', path.basename(dumpPath)], {
    cwd: path.dirname(path.resolve(dumpPath)),
    stdio: ['ignore', 'pipe', 'inherit']
  });
  child.on('error', (e) => {
    console.error('Failed to run tar. Extract the .sql manually and pass it instead.');
    console.error(e.message);
    process.exit(1);
  });
  return { stream: child.stdout, child };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const keepAll = args.includes('--all');
  const dumpPath = args.find((a) => !a.startsWith('--'));

  if (!dumpPath) {
    console.error('Usage: node tools/extract-npc-spells.js <dump.tar.gz | dump.sql> [--all]');
    process.exit(1);
  }
  if (!fs.existsSync(dumpPath)) {
    console.error('Dump not found: ' + dumpPath);
    process.exit(1);
  }

  const lists = new Map();     // id -> npc_spells row
  const entries = new Map();   // npc_spells_id -> [entry, ...]

  const { stream } = openDump(dumpPath);
  const wanted = new Set(['npc_spells', 'npc_spells_entries']);

  console.log('Reading ' + path.basename(dumpPath) + ' ...');
  await streamDump(stream, wanted, (table, values) => {
    if (table === 'npc_spells') {
      const row = toObject(NPC_SPELLS_COLS, values);
      lists.set(row.id, row);
    } else {
      const row = toObject(NPC_SPELLS_ENTRIES_COLS, values);
      if (!entries.has(row.npc_spells_id)) entries.set(row.npc_spells_id, []);
      entries.get(row.npc_spells_id).push(row);
    }
  });

  console.log('  npc_spells rows:         ' + lists.size);
  console.log('  npc_spells_entries rows: ' +
    Array.from(entries.values()).reduce((n, a) => n + a.length, 0));

  // Which lists are actually referenced by a mob? Ancestors count too.
  let referenced = null;
  if (!keepAll) {
    const npcTypesPath = path.join(REPO, 'resources', 'npc_types.json');
    if (!fs.existsSync(npcTypesPath)) {
      console.error('resources/npc_types.json not found; re-run with --all to skip filtering.');
      process.exit(1);
    }
    const npcTypes = JSON.parse(fs.readFileSync(npcTypesPath, 'utf8'));
    referenced = new Set();
    for (const npc of npcTypes) {
      let id = npc.npc_spells_id;
      const guard = new Set();
      while (id > 0 && lists.has(id) && !guard.has(id)) {
        guard.add(id);
        referenced.add(id);
        id = lists.get(id).parent_list;
      }
    }
    console.log('  referenced by a mob:     ' + referenced.size);
  }

  // Flatten parent_list inheritance so the client never has to walk the chain.
  // A child list's own entry for a spell wins over an inherited one.
  function resolveEntries(id, seen) {
    seen = seen || new Set();
    if (seen.has(id)) return [];
    seen.add(id);

    const list = lists.get(id);
    const inherited = list && list.parent_list > 0 ? resolveEntries(list.parent_list, seen) : [];
    const own = entries.get(id) || [];

    const bySpell = new Map();
    for (const e of inherited) bySpell.set(e.spellid, e);
    for (const e of own) bySpell.set(e.spellid, e);
    return Array.from(bySpell.values());
  }

  const out = {};
  let keptLists = 0, keptEntries = 0;

  for (const [id, list] of lists) {
    if (referenced && !referenced.has(id)) continue;

    const resolved = resolveEntries(id)
      // The sim only cares about what a mob throws at the tank.
      .filter((e) => (e.type & DETRIMENTAL) !== 0)
      .sort((a, b) => (b.priority || 0) - (a.priority || 0))
      .map((e) => ({
        spellid: e.spellid,
        type: e.type,
        minlevel: e.minlevel,
        maxlevel: e.maxlevel,
        recast_delay: e.recast_delay,
        priority: e.priority,
        resist_adjust: e.resist_adjust
      }));

    const hasProc = list.attack_proc > 0;
    if (!resolved.length && !hasProc) continue;

    out[id] = {
      name: list.name,
      attack_proc: list.attack_proc > 0 ? list.attack_proc : 0,
      proc_chance: list.proc_chance,
      // AI_EngagedCastCheck inputs. 0 means "use the server rule default".
      engaged_d_chance: list.engaged_d_chance,
      engaged_b_self_chance: list.engaged_b_self_chance,
      recast_min: list.engaged_no_sp_recast_min,
      recast_max: list.engaged_no_sp_recast_max,
      fail_recast: list.fail_recast,
      spells: resolved
    };
    keptLists++;
    keptEntries += resolved.length;
  }

  console.log('  kept lists:              ' + keptLists);
  console.log('  kept detrimental spells: ' + keptEntries);

  const jsonPath = path.join(REPO, 'resources', 'npc_spells.json');
  const dataPath = path.join(REPO, 'resources', 'npc_spells-data.js');
  const json = JSON.stringify(out);

  fs.writeFileSync(jsonPath, json);
  fs.writeFileSync(dataPath, 'window.__DPS_NPC_SPELLS__ = ' + json + ';\n');

  const kb = (n) => (fs.statSync(n).size / 1024).toFixed(0) + ' KB';
  console.log('Wrote ' + path.relative(REPO, jsonPath) + ' (' + kb(jsonPath) + ')');
  console.log('Wrote ' + path.relative(REPO, dataPath) + ' (' + kb(dataPath) + ')');
}

main().catch((e) => { console.error(e); process.exit(1); });
