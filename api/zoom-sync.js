// Vercel Serverless Function — Zoom Attendance Sync + List
// GET  /api/zoom-sync          → list recent past meetings
// POST /api/zoom-sync  { meetingId: "123456789" }  → sync attendance

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Auth check
  const authHeader = (req.headers['authorization'] || '').trim();
  const secret = (process.env.DASHBOARD_SECRET || 'proximity-dash-2026').trim();
  if (authHeader !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const ZOOM_ACCOUNT_ID    = process.env.ZOOM_ACCOUNT_ID;
  const ZOOM_CLIENT_ID     = process.env.ZOOM_CLIENT_ID;
  const ZOOM_CLIENT_SECRET = process.env.ZOOM_CLIENT_SECRET;

  // Helper: get Zoom access token
  async function getZoomToken() {
    const r = await fetch(
      `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${ZOOM_ACCOUNT_ID}`,
      {
        method: 'POST',
        headers: {
          'Authorization': 'Basic ' + Buffer.from(`${ZOOM_CLIENT_ID}:${ZOOM_CLIENT_SECRET}`).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );
    const d = await r.json();
    if (!d.access_token) throw new Error('Zoom auth failed: ' + JSON.stringify(d));
    return d.access_token;
  }

  // ── GET: list recent past meetings ──
  if (req.method === 'GET') {
    try {
      const accessToken = await getZoomToken();

      // S2S OAuth: /users/me may not work — list users and pick first
      const usersRes = await fetch('https://api.zoom.us/v2/users?page_size=1', {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });
      const usersData = await usersRes.json();
      const userId = (usersData.users && usersData.users[0]) ? usersData.users[0].id : null;
      if (!userId) return res.status(500).json({ error: 'No se pudo obtener usuario Zoom', detail: usersData });

      const from = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      const to   = new Date().toISOString().split('T')[0];
      const listRes = await fetch(
        `https://api.zoom.us/v2/report/users/${userId}/meetings?type=past&from=${from}&to=${to}&page_size=20`,
        { headers: { 'Authorization': `Bearer ${accessToken}` } }
      );
      const listData = await listRes.json();
      const meetings = (listData.meetings || []).map(m => ({
        id: m.id, topic: m.topic, start_time: m.start_time,
        duration: m.duration, participants: m.participants_count
      }));
      return res.status(200).json({ meetings });
    } catch(err) {
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { meetingId } = req.body;
  if (!meetingId) return res.status(400).json({ error: 'meetingId requerido' });

  const SB_URL     = process.env.SB_URL;
  const SB_SERVICE = process.env.SB_SERVICE;

  try {
    const accessToken = await getZoomToken();

    // 2. Fetch participants from Zoom Reports API
    let allParticipants = [];
    let nextPageToken = '';
    do {
      const url = `https://api.zoom.us/v2/report/meetings/${meetingId}/participants?page_size=300${nextPageToken ? `&next_page_token=${nextPageToken}` : ''}`;
      const partRes = await fetch(url, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });
      const partData = await partRes.json();
      if (!partRes.ok) {
        return res.status(500).json({ error: 'Error al obtener participantes', detail: partData });
      }
      allParticipants = allParticipants.concat(partData.participants || []);
      nextPageToken = partData.next_page_token || '';
    } while (nextPageToken);

    if (allParticipants.length === 0) {
      return res.status(200).json({ synced: 0, message: 'Sin participantes en este meeting' });
    }

    const sbHeaders = {
      'apikey': SB_SERVICE,
      'Authorization': `Bearer ${SB_SERVICE}`,
      'Content-Type': 'application/json'
    };

    // 3. Delete previous records for this meeting (re-sync clean)
    await fetch(`${SB_URL}/rest/v1/asistencias?meeting_id=eq.${encodeURIComponent(meetingId)}`, {
      method: 'DELETE',
      headers: { ...sbHeaders, 'Prefer': 'return=minimal' }
    });

    // 4. Deduplicate — Zoom sometimes sends multiple entries per person (rejoin)
    const byEmail = {};
    for (const p of allParticipants) {
      const key = p.user_email || p.id || p.name;
      if (!byEmail[key]) {
        byEmail[key] = { ...p, totalDuration: p.duration };
      } else {
        byEmail[key].totalDuration += p.duration; // sum up duration across re-joins
      }
    }
    const unique = Object.values(byEmail);

    // 5. Insert into asistencias
    const rows = unique.map(p => ({
      meeting_id: String(meetingId),
      email: p.user_email || null,
      nombre: p.name,
      duracion_minutos: Math.round((p.totalDuration || p.duration || 0) / 60),
      hora_entrada: p.join_time || null,
      hora_salida: p.leave_time || null,
      clase_fecha: p.join_time ? p.join_time.split('T')[0] : new Date().toISOString().split('T')[0]
    }));

    await fetch(`${SB_URL}/rest/v1/asistencias`, {
      method: 'POST',
      headers: { ...sbHeaders, 'Prefer': 'return=minimal' },
      body: JSON.stringify(rows)
    });

    // 6. Upsert lead_estados → mark as 'asistio' for any email found in clase_viral_registros
    let matched = 0;
    for (const p of unique) {
      if (!p.user_email) continue;

      // Check if email exists in registros
      const checkRes = await fetch(
        `${SB_URL}/rest/v1/clase_viral_registros?email=eq.${encodeURIComponent(p.user_email)}&select=email`,
        { headers: sbHeaders }
      );
      const registrados = await checkRes.json();
      if (!Array.isArray(registrados) || registrados.length === 0) continue;

      matched++;

      // Don't downgrade if already at a higher-intent state
      const HIGHER_STATES = ['interesado', 'compro_evento', 'seguimiento', 'seguimiento_exitoso'];
      const currentRes = await fetch(
        `${SB_URL}/rest/v1/lead_estados?registro_email=eq.${encodeURIComponent(p.user_email)}&select=estado`,
        { headers: sbHeaders }
      );
      const currentEstado = await currentRes.json();
      if (Array.isArray(currentEstado) && currentEstado[0] && HIGHER_STATES.includes(currentEstado[0].estado)) continue;

      // Try PATCH first (update existing row)
      const patchRes = await fetch(
        `${SB_URL}/rest/v1/lead_estados?registro_email=eq.${encodeURIComponent(p.user_email)}`,
        {
          method: 'PATCH',
          headers: { ...sbHeaders, 'Prefer': 'return=representation' },
          body: JSON.stringify({ estado: 'asistio', updated_at: new Date().toISOString() })
        }
      );
      const updated = await patchRes.json();

      // If no row existed, INSERT new one
      if (!Array.isArray(updated) || updated.length === 0) {
        await fetch(`${SB_URL}/rest/v1/lead_estados`, {
          method: 'POST',
          headers: { ...sbHeaders, 'Prefer': 'return=minimal' },
          body: JSON.stringify({
            registro_email: p.user_email,
            estado: 'asistio',
            vendedor: '',
            updated_at: new Date().toISOString()
          })
        });
      }
    }

    return res.status(200).json({
      synced: unique.length,
      matched,
      message: `${unique.length} participantes sincronizados, ${matched} cruzados con tus registrados`
    });

  } catch (err) {
    console.error('zoom-sync error:', err);
    return res.status(500).json({ error: 'Error interno', detail: err.message });
  }
}
