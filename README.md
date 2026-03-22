# gSim Project Quarm DPS Simulator

## Weapon data maintenance

- Canonical merged file: `resources/weapons.json` (generated).
- **`resources/weapons-data.js`** (generated) — same merged DB assigned to `window` so item search works when you open **`index.html` as a `file://` URL**. Browsers block `fetch()` to local JSON (CORS); the script tag is allowed.
- Exclusions / era filters: `resources/weapon_exclusions.json` (also embedded in `weapons-data.js` when you run merge).
- Source JSON: `resources/weaponlist.json`, `luclinweapons.json`, `popweapons.json`.

After editing any source file, regenerate the merged list:

```bash
npm run merge-weapons
# or: node scripts/merge-weapons.mjs
```

Item search uses the bundled script when present, otherwise **`weapons.json`** over HTTP (offline; no remote ItemSearch API).

### Target NPC search & proc rates (`file://`)

- **`resources/npc_types-data.js`** (generated from `npc_types.json`) — large (~tens of MB); enables target NPC search without `fetch`.
- **`resources/procrates-data.js`** (generated from `procrates.json`) — proc rate overrides when opening as `file://`.
- **`resources/spells-data.js`** (generated from `spells_en.json`) — spell DB for proc damage / resist logic when `fetch` is blocked.
- **`resources/weapon_shortlist-data.js`** (generated from `weapon_shortlist.json`) — legacy shortlist lookup without `fetch`.

Generate all JS bundles used for offline `file://` in one step:

```bash
npm run build-file-bundles
```

This runs `merge-weapons`, `procrates`, `npc-types`, `spells-en`, and `weapon-shortlist` generators (NPC and spells steps can take a minute). Individual scripts: `npm run build-npc-types-js`, `npm run build-procrates-js`, `npm run build-spells-js`, `npm run build-weapon-shortlist-js`.

**After every `npm install`,** the same step runs automatically via the `postinstall` script so `*-data.js` files stay in sync with the JSON sources when present.

### Local preview (optional)

If you skip generating the `*-data.js` bundles, use a static server so `fetch` works:

```bash
npm run serve
```

Then open the URL shown (e.g. `http://localhost:3000`).

## Lint (optional)

ESLint is configured for the main JS sources (`combat.js`, `threat.js`, `weaponSkillCaps.js`, `itemSearch.js`), `api/`, `usage-log-*.js`, and `scripts/*.mjs`. Generated `resources/*-data.js` is ignored.

```bash
npm run lint
```

## Threat (TPS)

Approximate threat per second is shown in reports. See `threat.js` and the Mechanics Guide (`mechanics-guide.html`).
