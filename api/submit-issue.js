/**
 * Vercel serverless: submit bug/feature → create GitHub issue (repo not exposed to client).
 *
 * POST /api/submit-issue
 * Body: { type: 'bug'|'feature', title: string, body: string, email?: string }
 *
 * Set in Vercel → Settings → Environment Variables:
 *   GITHUB_TOKEN — Personal access token with repo scope (or fine-grained repo Issues: write).
 *   GITHUB_REPO  — "owner/repo" (e.g. "youruser/DPS-Sim").
 */
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    setCors(res);
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    setCors(res);
    res.setHeader('Content-Type', 'application/json');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const token = process.env.GITHUB_TOKEN ? String(process.env.GITHUB_TOKEN).trim() : '';
  const repo = process.env.GITHUB_REPO ? String(process.env.GITHUB_REPO).trim() : '';
  if (!token || !repo) {
    setCors(res);
    res.setHeader('Content-Type', 'application/json');
    return res.status(503).json({
      error: 'Bug/feature reporting is not configured. The site owner can set GITHUB_TOKEN and GITHUB_REPO in Vercel.',
    });
  }

  let payload;
  try {
    payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    if (!payload || typeof payload !== 'object') {
      setCors(res);
      res.setHeader('Content-Type', 'application/json');
      return res.status(400).json({ error: 'Invalid body: need type, title, and body.' });
    }
  } catch (e) {
    setCors(res);
    res.setHeader('Content-Type', 'application/json');
    return res.status(400).json({ error: 'Invalid JSON body.' });
  }

  const type = (payload.type === 'feature' || payload.type === 'bug') ? payload.type : 'bug';
  const title = typeof payload.title === 'string' ? payload.title.trim() : '';
  const bodyRaw = typeof payload.body === 'string' ? payload.body.trim() : '';
  const email = typeof payload.email === 'string' ? payload.email.trim() : '';

  if (!title) {
    setCors(res);
    res.setHeader('Content-Type', 'application/json');
    return res.status(400).json({ error: 'Title is required.' });
  }

  const label = type === 'feature' ? 'enhancement' : 'bug';
  const body =
    (bodyRaw ? bodyRaw + '\n\n' : '') +
    '---\n*Submitted via DPS-Sim Report bug / Request feature.*' +
    (email ? '\n*Contact (optional):* ' + email.replace(/\n/g, ' ') : '');

  const url = 'https://api.github.com/repos/' + repo + '/issues';
  try {
    const ghRes = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title: title, body: body, labels: [label] }),
    });

    const data = await ghRes.json().catch(() => ({}));
    if (!ghRes.ok) {
      setCors(res);
      res.setHeader('Content-Type', 'application/json');
      return res.status(ghRes.status >= 500 ? 502 : 400).json({
        error: data.message || 'GitHub returned an error. Please try again.',
      });
    }

    setCors(res);
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json({ ok: true, message: 'Thank you. Your report has been submitted.' });
  } catch (e) {
    setCors(res);
    res.setHeader('Content-Type', 'application/json');
    return res.status(502).json({ error: 'Could not submit. Please try again later.' });
  }
}
