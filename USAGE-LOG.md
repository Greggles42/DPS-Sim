# Background usage log

Optional, off-by-default. No UI; the main tool does not show any tracking.

## Enable logging

1. In `index.html`, set `USAGE_LOG_URL` to your collector endpoint, e.g.:
   - **Local:** `http://localhost:8765/log`
   - **Vercel:** `https://dps-sim.vercel.app/api/log` (or your Vercel project URL)
   ```js
   const USAGE_LOG_URL = 'https://dps-sim.vercel.app/api/log';
   ```
2. Run the collector (see below), or deploy to Vercel so the `/api/log` route is live.

## Hosting on Vercel (dps-sim.vercel.app)

1. Deploy this repo to Vercel (e.g. connect the GitHub repo in the Vercel dashboard).
2. The `api/log.js` serverless function is invoked at `https://<your-project>.vercel.app/api/log`.  
   If your project is named `dps-sim`, the URL is `https://dps-sim.vercel.app/api/log`.
3. In `index.html`, set:
   ```js
   const USAGE_LOG_URL = 'https://dps-sim.vercel.app/api/log';
   ```
4. The Vercel function accepts POST with a JSON body and returns 200 (CORS allowed). It does not persist logs by default (serverless has no writable filesystem). To store logs, add [Vercel Blob](https://vercel.com/docs/storage/vercel-blob) or another store inside `api/log.js`.

## Collector (local, optional)

- **Start server:** `node usage-log-server.js`  
  Listens on port 8765, appends each POST to `usage-log.jsonl`.
- **Summarize:** `node usage-log-summary.js`  
  Reads `usage-log.jsonl` and prints total runs, unique users, weapon combos, class breakdown, etc.

## Payload (per run)

Each run sends one POST with a JSON object, e.g.:

- `event`: `"sim_run"`
- `v`: app version
- `uid`: anonymous persistent id (localStorage)
- `ts`: timestamp
- `w1`: `{ preset, damage, delay, is2H }`
- `w2`: same or `null`
- `classId`, `durationSec`, `runs`, `totalDamage`
- `specialAttacks`, `fistweaving` (booleans)

`usage-log.jsonl` is in `.gitignore`.
