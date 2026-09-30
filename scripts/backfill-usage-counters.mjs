/**
 * One-time backfill: populates the dps_sim_stats aggregate hash (introduced
 * alongside the pipelined api/log.js writes) from the existing raw dps_sim_log
 * list, so lifetime analytics on /api/summary include history logged before
 * this change shipped.
 *
 * Run once, ideally right after deploying the new api/log.js:
 *   node --env-file=.env.local scripts/backfill-usage-counters.mjs
 * (or export KV_REST_API_URL / KV_REST_API_TOKEN — from `vercel env pull .env.local` —
 * into the shell before running without --env-file)
 *
 * Safe to re-run: it re-derives every counter from the raw log via hincrby and
 * OVERWRITES existing dps_sim_stats fields with the freshly recomputed totals
 * from the raw log entries seen (up to PAGE_SIZE * pages), so running it twice
 * does not double-count. It does NOT merge with unrelated writes that happened
 * after backfill started — run it once, promptly, before/soon after deploy.
 */
import { kv } from '@vercel/kv';
import { applyStatsToPipeline } from '../api/log.js';

const LOG_KEY = 'dps_sim_log';
const STATS_KEY = 'dps_sim_stats';
const PAGE_SIZE = 500;

async function main() {
  const total = await kv.llen(LOG_KEY);
  console.log(`Raw log has ${total} entries. Reading in pages of ${PAGE_SIZE}...`);

  const aggregate = {}; // field -> numeric total (recomputed from scratch)
  let seen = 0;

  for (let start = 0; start < total; start += PAGE_SIZE) {
    const end = Math.min(start + PAGE_SIZE, total) - 1;
    const raw = await kv.lrange(LOG_KEY, start, end);
    for (const item of raw) {
      let payload;
      try {
        payload = typeof item === 'string' ? JSON.parse(item) : item;
      } catch (_e) {
        continue;
      }
      if (!payload || payload.event !== 'sim_run') continue;

      // Reuse the same field-derivation logic as the live write path, but
      // capture into a plain object instead of issuing real KV commands.
      const fakePipe = {
        hincrby(_key, field, by) {
          aggregate[field] = (aggregate[field] || 0) + by;
        },
        hincrbyfloat(_key, field, by) {
          aggregate[field] = (aggregate[field] || 0) + by;
        },
      };
      applyStatsToPipeline(fakePipe, payload);
      seen++;
    }
    console.log(`  processed ${Math.min(end + 1, total)}/${total}`);
  }

  console.log(`Derived ${Object.keys(aggregate).length} aggregate fields from ${seen} sim_run entries.`);

  // Reset STATS_KEY, then write the recomputed totals via hset (one command
  // per chunk, not one round trip per field) so this is idempotent.
  await kv.del(STATS_KEY);
  const fields = Object.entries(aggregate);
  const CHUNK = 200;
  for (let i = 0; i < fields.length; i += CHUNK) {
    const chunk = fields.slice(i, i + CHUNK);
    const obj = {};
    for (const [f, v] of chunk) obj[f] = v;
    await kv.hset(STATS_KEY, obj);
    console.log(`  wrote fields ${i + 1}-${Math.min(i + CHUNK, fields.length)}/${fields.length}`);
  }

  console.log('Backfill complete.');
}

main().catch((e) => {
  console.error('Backfill failed:', e);
  process.exit(1);
});
