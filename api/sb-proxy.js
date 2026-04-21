/**
 * /api/sb-proxy.js — Supabase reverse proxy
 *
 * Keeps the service_role key server-side. The browser only sends
 * DASH_UI_SECRET (set in Vercel env vars). Even if someone reads the
 * dashboard source code they cannot directly call Supabase.
 *
 * CORS: only requests originating from the app's own domains are allowed.
 * Same-origin requests (dashboard.html → /api/sb-proxy on same host) skip
 * CORS entirely since the browser won't send an Origin header.
 */

// Domains allowed to call this proxy from the browser
const ALLOWED_ORIGINS = new Set([
  'https://clase.creceyvendecontumarca.com',
  'https://clase-viral.vercel.app',
  'https://clase-viral-holasoyfemiliano-devs-projects.vercel.app',
  'https://clase-viral-holasoyfemiliano-dev-holasoyfemiliano-devs-projects.vercel.app',
]);

const ALLOWED_TABLES = new Set([
  'clase_viral_registros',
  'lead_estados',
  'clase_analisis',
  'proximity_creators_interesados',
  'vendedores',
  'vendedor_actividad',
  'ventas',
  'miembros',
  'asistencias',
  'page_behavior',
  'ab_optimizations',
  'landing_config',
  'comprobantes',
]);

module.exports = async function handler(req, res) {
  // ── CORS ─────────────────────────────────────────────────────────────────
  // Same-origin requests (dashboard on the same domain) have no Origin header
  // and bypass CORS checks entirely. For cross-origin requests, only allow
  // the whitelisted domains. Reject everything else immediately.
  const origin = req.headers.origin;
  if (origin) {
    if (!ALLOWED_ORIGINS.has(origin)) {
      return res.status(403).json({ error: 'CORS: origin not allowed' });
    }
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Prefer');
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── Auth ──────────────────────────────────────────────────────────────────
  // DASH_UI_SECRET must match DASH_PASS in dashboard.html
  const secret = (process.env.DASH_UI_SECRET || '').trim();
  if (!secret) {
    return res.status(500).json({ error: 'DASH_UI_SECRET not configured' });
  }
  const authHeader = (req.headers['authorization'] || '').trim();
  if (authHeader !== 'Bearer ' + secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // ── Path ──────────────────────────────────────────────────────────────────
  const { _path, ...queryParams } = req.query;
  if (!_path) return res.status(400).json({ error: 'Missing _path parameter' });

  // Basic path validation — must start with /rest/v1/
  if (!_path.startsWith('/rest/v1/')) {
    return res.status(400).json({ error: 'Invalid path' });
  }

  // Extract table name and verify it's in the allow-list
  const tableName = _path.replace('/rest/v1/', '').split('?')[0];
  if (!ALLOWED_TABLES.has(tableName)) {
    return res.status(403).json({ error: 'Table not allowed: ' + tableName });
  }

  // ── Forward ───────────────────────────────────────────────────────────────
  const SB_URL = process.env.SB_URL || 'https://xpsvkhoeedinuvwrumvu.supabase.co';
  const SB_KEY = process.env.SB_SERVICE;
  if (!SB_KEY) {
    return res.status(500).json({ error: 'SB_SERVICE not configured' });
  }

  const queryString = new URLSearchParams(queryParams).toString();
  const targetUrl = SB_URL + _path + (queryString ? '?' + queryString : '');

  const forwardHeaders = {
    'apikey': SB_KEY,
    'Authorization': 'Bearer ' + SB_KEY,
    'Content-Type': 'application/json',
  };
  if (req.headers['prefer']) forwardHeaders['Prefer'] = req.headers['prefer'];

  const fetchOptions = { method: req.method, headers: forwardHeaders };
  if (req.method !== 'GET' && req.method !== 'DELETE') {
    fetchOptions.body = JSON.stringify(req.body);
  }

  try {
    const sbRes = await fetch(targetUrl, fetchOptions);
    const text = await sbRes.text();
    const contentRange = sbRes.headers.get('content-range');

    // When count=exact is requested, inject the total count into the JSON response
    // so the browser doesn't need to read headers (Vercel may strip them)
    if (forwardHeaders['Prefer'] && forwardHeaders['Prefer'].includes('count=exact') && contentRange) {
      const total = parseInt((contentRange.split('/')[1] || '').replace('*', '').trim());
      if (!isNaN(total)) {
        return res.status(200).json({ _count: total });
      }
    }

    res.status(sbRes.status);
    res.setHeader('Content-Type', sbRes.headers.get('content-type') || 'application/json');
    if (contentRange) res.setHeader('Content-Range', contentRange);
    return res.send(text);
  } catch (err) {
    return res.status(502).json({ error: 'Supabase unreachable', detail: err.message });
  }
}
