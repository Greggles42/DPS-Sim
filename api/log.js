/**
 * Vercel serverless function: usage-log collector for DPS-Sim.
 * Deploy with your app; then set USAGE_LOG_URL in index.html to:
 *   https://dps-sim.vercel.app/api/log
 * (or your custom Vercel domain).
 *
 * Accepts POST with JSON body, returns 200. No persistent storage by default
 * (Vercel serverless has no writable filesystem). For persistence, add
 * Vercel Blob or another store and append the payload there.
 */
export default function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
    return res.status(204).end();
  }

  if (req.method === 'POST') {
    try {
      const payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      // Optional: persist payload (e.g. Vercel Blob, KV, or external API)
      // console.log(JSON.stringify(payload));
    } catch (e) {
      // ignore
    }
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json({});
  }

  return res.status(404).end();
}
