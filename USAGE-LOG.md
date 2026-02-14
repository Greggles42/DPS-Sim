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

## How to add KV / Redis in Vercel

The DPS log needs a Redis-backed store so `/api/log` and `/api/summary` can persist and read data. Do one of the following.

### Option A: From the project’s Storage tab

1. Open [Vercel Dashboard](https://vercel.com/dashboard) and select your project (e.g. **dps-sim**).
2. Go to the **Storage** tab.
3. Click **Create Database** or **Add Storage**.
4. If you see **KV** (or **Vercel KV**), choose it and create the store.  
   If you only see **Blob**, **Postgres**, etc., use **Option B** instead.
5. When asked, connect the new store to this project.  
   Vercel will add the KV-related env vars (e.g. `KV_REST_API_URL`, `KV_REST_API_TOKEN`) to the project.
6. Redeploy the project (e.g. **Deployments** → latest → **Redeploy**) so the new env vars are picked up.

### Option B: From the Marketplace (Redis)

Vercel KV has been retired; new Redis is added via the Marketplace (e.g. Upstash Redis).

1. Open [Vercel Marketplace → Redis](https://vercel.com/marketplace?category=storage&search=redis).
2. Pick a provider (e.g. **Upstash Redis**) and click **Add Integration** / **Install**.
3. Choose the plan (free tier is usually enough for the usage log).
4. When prompted, **select your DPS-Sim Vercel project** so the integration is linked to it.
5. Finish the flow. The integration will create a Redis database and inject the connection env vars into your project (often the same names: `KV_REST_API_URL`, `KV_REST_API_TOKEN`, or similar).
6. In the project’s **Settings → Environment Variables**, confirm that the new variables exist for **Production** (and Preview if you use it).
7. **Redeploy** the project so the new env vars are used.

After this, `@vercel/kv` in `/api/log` and `/api/summary` will use that store. New runs will be logged and the summary page will show data.

---

## Hosting on Vercel (dps-sim.vercel.app)

The DPS log uses **Vercel KV** (Redis), not Blob — no `put()`, `list()`, or `copy()`.

1. **Create a KV store** in the Vercel project using the steps in **How to add KV / Redis in Vercel** above.
2. Deploy this repo to Vercel (e.g. connect the GitHub repo). Ensure `package.json` is present so `@vercel/kv` is installed.
3. **Log endpoint:** `https://dps-sim.vercel.app/api/log` — each simulation run POSTs here; the payload is appended via `kv.rpush()`.
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

1. **Create a Vercel KV store** (required for logging to work):
   - Vercel dashboard → your project → **Storage** → **Create** → **KV** (or add a Redis integration from the Marketplace).
   - This provides the KV env vars to the project. Without them, `/api/log` returns 200 but does not persist data, and the summary has nothing to read.

2. **Run a simulation on the deployed app** (not only locally):
   - Open **https://dps-sim.vercel.app**, click "Run simulation". Each run sends one POST to `/api/log`; the summary page only shows runs that were logged after the KV store was connected.

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
