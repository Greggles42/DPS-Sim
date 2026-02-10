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

  const apiKey = process.env.ITEM_SEARCH_API_KEY;
  if (!apiKey) {
    setCors(res);
    res.setHeader('Content-Type', 'application/json');
    return res.status(503).json({ error: 'Item search not configured (missing ITEM_SEARCH_API_KEY)' });
  }

  const nameFilter = typeof req.query.nameFilter === 'string' ? req.query.nameFilter.trim() : '';
  const baseUrl = process.env.ITEM_SEARCH_BASE_URL || DEFAULT_BASE_URL;
  const url = baseUrl.replace(/\?.*$/, '') + '?nameFilter=' + encodeURIComponent(nameFilter);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: 'Bearer ' + apiKey,
      },
    });

    if (!response.ok) {
      setCors(res);
      res.setHeader('Content-Type', 'application/json');
      return res.status(response.status).json({ error: 'Upstream search failed' });
    }

    const data = await response.json();
    setCors(res);
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json(data);
  } catch (err) {
    setCors(res);
    res.setHeader('Content-Type', 'application/json');
    return res.status(502).json({ error: 'Item search proxy error' });
  }
}
