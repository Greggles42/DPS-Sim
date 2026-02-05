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

1. **Create a Blob store** in the Vercel project: Project → Storage → Create → Blob. This sets `BLOB_READ_WRITE_TOKEN` for the project.
2. Deploy this repo to Vercel (e.g. connect the GitHub repo). Ensure `package.json` is present so `@vercel/blob` is installed.
3. **Log endpoint:** `https://dps-sim.vercel.app/api/log` — each simulation run POSTs here; the payload is appended to Vercel Blob (`dps-sim/usage-log.jsonl`).
4. In `index.html`, set:
   ```js
   const USAGE_LOG_URL = 'https://dps-sim.vercel.app/api/log';
   ```
5. **Summary page:** open **https://dps-sim.vercel.app/api/summary** in a browser to see:
   - Total simulations run
   - Number of unique users (by anonymous uid)
   - A log of recent runs with timestamp and parameters (class, w1/w2, duration, runs, total damage, special/fistweaving)

## Collector (local, optional)

- **Start server:** `node usage-log-server.js`  
  Listens on port 8765, appends each POST to `usage-log.jsonl`.
- **Summarize:** `node usage-log-summary.js`  
  Reads `usage-log.jsonl` and prints total runs, unique users, weapon combos, class breakdown, etc.

## Troubleshooting: Summary shows 0 runs

If [https://dps-sim.vercel.app/api/summary](https://dps-sim.vercel.app/api/summary) shows "Total simulations run: 0":

1. **Create a Vercel Blob store** (required for logging to work):
   - Vercel dashboard → your project → **Storage** → **Create Database** / **Add Storage** → choose **Blob**.
   - This provides `BLOB_READ_WRITE_TOKEN` to the project. Without it, `/api/log` returns 200 but does not persist data, and the summary has nothing to read.

2. **Run a simulation on the deployed app** (not only locally):
   - Open **https://dps-sim.vercel.app**, click "Run simulation". Each run sends one POST to `/api/log`; the summary page only shows runs that were logged after the Blob store existed.

3. **Confirm the app is deployed with logging enabled**:
   - In the deployed repo, `index.html` should have `USAGE_LOG_URL = 'https://dps-sim.vercel.app/api/log'` (or your Vercel URL). If you set it to empty or a local URL for testing, the live site won’t log.

4. **Browser/network**: Ad blockers or strict privacy settings can block the POST to `/api/log`. Try from a normal browser profile and check DevTools → Network for a POST to `api/log` (status 200) after a run.

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
