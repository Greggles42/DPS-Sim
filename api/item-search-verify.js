/**
 * Verify item-search API key (Vercel env ITEM_SEARCH_API_KEY).
 * GET /api/item-search-verify — returns JSON; never exposes the key.
 */
const DEFAULT_BASE_URL = 'https://dndquarm.com/api/QuarmData/items/search';

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const apiKey = process.env.ITEM_SEARCH_API_KEY ? String(process.env.ITEM_SEARCH_API_KEY).trim() : '';

  if (!apiKey) {
    return res.status(200).json({
      configured: false,
      message: 'ITEM_SEARCH_API_KEY is not set. Add it in Vercel → Project → Settings → Environment Variables, then redeploy.',
    });
  }

  const baseUrl = process.env.ITEM_SEARCH_BASE_URL || DEFAULT_BASE_URL;
  const base = baseUrl.replace(/\?.*$/, '');
  const testUrl = base + '?nameFilter=test';

  try {
    const response = await fetch(testUrl, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
        'User-Agent': 'DPS-Sim-ItemSearch/1',
      },
    });

    const text = await response.text();
    const contentType = response.headers.get('content-type') || '';

    let authWorks = false;
    let hint = '';

    if (!response.ok) {
      hint = 'Upstream returned HTTP ' + response.status + '. Check key permissions or rate limits.';
    } else if (contentType.includes('application/json')) {
      try {
        JSON.parse(text);
        authWorks = true;
      } catch (_) {
        hint = 'Response said JSON but body did not parse.';
      }
    } else {
      authWorks = false;
      if (contentType.includes('text/html')) {
        hint = 'Upstream returned HTML (often means auth failed or wrong endpoint). Try the same key in a browser or Postman against ' + baseUrl;
      } else {
        hint = 'Upstream returned Content-Type: ' + (contentType || '(empty)');
      }
    }

    return res.status(200).json({
      configured: true,
      authWorks,
      upstreamStatus: response.status,
      upstreamContentType: contentType.split(';')[0].trim(),
      message: authWorks
        ? 'Key is set and dndquarm returned JSON. Item search should work.'
        : 'Key is set but dndquarm did not return JSON. ' + hint,
    });
  } catch (err) {
    return res.status(200).json({
      configured: true,
      authWorks: false,
      message: 'Key is set but request failed: ' + (err.message || String(err)),
    });
  }
}
