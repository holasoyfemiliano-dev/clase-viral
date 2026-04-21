// Vercel Serverless Function — List recent Zoom meetings
// GET /api/zoom-list

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const authHeader = (req.headers['authorization'] || '').trim();
  const secret = (process.env.DASHBOARD_SECRET || 'proximity-dash-2026').trim();
  if (authHeader !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const ZOOM_ACCOUNT_ID   = process.env.ZOOM_ACCOUNT_ID;
  const ZOOM_CLIENT_ID    = process.env.ZOOM_CLIENT_ID;
  const ZOOM_CLIENT_SECRET = process.env.ZOOM_CLIENT_SECRET;

  try {
    // 1. Get Zoom access token
    const tokenRes = await fetch(
      `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${ZOOM_ACCOUNT_ID}`,
      {
        method: 'POST',
        headers: {
          'Authorization': 'Basic ' + Buffer.from(`${ZOOM_CLIENT_ID}:${ZOOM_CLIENT_SECRET}`).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      return res.status(500).json({ error: 'Error al autenticar con Zoom', detail: tokenData });
    }
    const accessToken = tokenData.access_token;

    // 2. Get user ID (me)
    const meRes = await fetch('https://api.zoom.us/v2/users/me', {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    const meData = await meRes.json();
    const userId = meData.id;
    if (!userId) return res.status(500).json({ error: 'No se pudo obtener usuario Zoom' });

    // 3. List past meetings (last 30 days)
    const from = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const to   = new Date().toISOString().split('T')[0];
    const listRes = await fetch(
      `https://api.zoom.us/v2/report/users/${userId}/meetings?type=past&from=${from}&to=${to}&page_size=20`,
      { headers: { 'Authorization': `Bearer ${accessToken}` } }
    );
    const listData = await listRes.json();
    const meetings = (listData.meetings || []).map(m => ({
      id: m.id,
      uuid: m.uuid,
      topic: m.topic,
      start_time: m.start_time,
      duration: m.duration,
      participants: m.participants_count
    }));

    return res.status(200).json({ meetings });
  } catch (err) {
    return res.status(500).json({ error: 'Error interno', detail: err.message });
  }
};
