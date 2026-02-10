/**
 * Vercel serverless proxy for item search. Keeps the API key server-side.
 * Set env var ITEM_SEARCH_API_KEY in Vercel (Settings → Environment Variables).
 * Optional: ITEM_SEARCH_BASE_URL (default: https://dndquarm.com/api/QuarmData/items/search)
 */
const DEFAULT_BASE_URL = 'https://dndquarm.com/api/QuarmData/items/search';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    setCors(res);
    return res.status(204).end();
  }

  if (req.method !== 'GET') {
    setCors(res);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.ITEM_SEARCH_API_KEY ? String(process.env.ITEM_SEARCH_API_KEY).trim() : '';
  if (!apiKey) {
    setCors(res);
    res.setHeader('Content-Type', 'application/json');
    return res.status(503).json({
      error: 'Item search not configured. Set ITEM_SEARCH_API_KEY in Vercel → Project → Settings → Environment Variables, then redeploy.',
    });
  }

  const nameFilter = typeof req.query.nameFilter === 'string' ? req.query.nameFilter.trim() : '';
  const baseUrl = process.env.ITEM_SEARCH_BASE_URL || DEFAULT_BASE_URL;
  const base = baseUrl.replace(/\?.*$/, '');
  // Some APIs expect key in query string; try both Bearer and query param for compatibility
  const url = base + '?nameFilter=' + encodeURIComponent(nameFilter) + '&apiKey=' + encodeURIComponent(apiKey);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: 'Bearer ' + apiKey,
        'User-Agent': 'DPS-Sim-ItemSearch/1',
      },
    });

    const text = await response.text();
    if (!response.ok) {
      setCors(res);
      res.setHeader('Content-Type', 'application/json');
      return res.status(response.status).json({
        error: 'Upstream search failed',
        upstream: 'dndquarm.com',
        status: response.status,
      });
    }

    let data;
    try {
      data = text ? JSON.parse(text) : [];
    } catch (_) {
      const contentType = response.headers.get('content-type') || '';
      const snippet = (text || '').slice(0, 200).replace(/\s+/g, ' ');
      console.error('[item-search] upstream non-JSON response. Content-Type:', contentType, 'Body start:', snippet);
      setCors(res);
      res.setHeader('Content-Type', 'application/json');
      return res.status(502).json({
        error: 'Upstream returned invalid JSON',
        upstream: 'dndquarm.com',
        detail: 'dndquarm may have returned HTML (wrong auth or endpoint). Check Vercel function logs for response snippet.',
      });
    }

    setCors(res);
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json(data);
  } catch (err) {
    console.error('[item-search] proxy error:', err.message || err);
    setCors(res);
    res.setHeader('Content-Type', 'application/json');
    return res.status(502).json({
      error: 'Proxy request to dndquarm.com failed',
      detail: err.message || String(err),
    });
  }
}
