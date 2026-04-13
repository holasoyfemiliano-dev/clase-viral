/**
 * /api/ghl-contact.js — Proxy seguro para crear contactos en GoHighLevel
 * Recibe { nombre, email, phone } desde la landing y los envía a GHL.
 */
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { nombre, email, phone } = req.body || {};
  if (!email) return res.status(400).json({ error: 'email required' });

  const GHL_KEY = process.env.GHL_API_KEY;
  const LOC_ID  = process.env.GHL_LOCATION_ID;
  if (!GHL_KEY || !LOC_ID) return res.status(500).json({ error: 'GHL not configured' });

  // Split nombre into first/last
  const parts = (nombre || '').trim().split(/\s+/);
  const firstName = parts[0] || '';
  const lastName  = parts.slice(1).join(' ') || '';

  const body = {
    locationId: LOC_ID,
    email,
    phone: phone || undefined,
    firstName,
    lastName,
    tags: ['clase-viral'],
    source: 'landing-page',
  };

  try {
    const r = await fetch('https://services.leadconnectorhq.com/contacts/', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + GHL_KEY,
        'Content-Type': 'application/json',
        'Version': '2021-07-28',
      },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    return res.status(r.ok ? 200 : r.status).json(data);
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
};
