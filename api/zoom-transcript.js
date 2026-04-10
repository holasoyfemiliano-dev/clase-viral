// Vercel Serverless Function — Zoom Transcript + Dropout Analysis
// POST /api/zoom-transcript  { meetingId: "123456789" }

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const authHeader = (req.headers['authorization'] || '').trim();
  const secret = (process.env.DASHBOARD_SECRET || 'proximity-dash-2026').trim();
  if (authHeader !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { meetingId } = req.body;
  if (!meetingId) return res.status(400).json({ error: 'meetingId requerido' });

  const ZOOM_ACCOUNT_ID   = process.env.ZOOM_ACCOUNT_ID;
  const ZOOM_CLIENT_ID    = process.env.ZOOM_CLIENT_ID;
  const ZOOM_CLIENT_SECRET = process.env.ZOOM_CLIENT_SECRET;
  const SB_URL            = process.env.SB_URL;
  const SB_SERVICE        = process.env.SB_SERVICE;

  const sbHeaders = {
    'apikey': SB_SERVICE,
    'Authorization': `Bearer ${SB_SERVICE}`,
    'Content-Type': 'application/json'
  };

  try {
    // 1. Zoom OAuth token
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

    // 2. Get UUID via reports API (required for transcript endpoint)
    const reportRes = await fetch(
      `https://api.zoom.us/v2/report/meetings/${meetingId}`,
      { headers: { 'Authorization': `Bearer ${accessToken}` } }
    );
    const reportData = await reportRes.json();
    const uuid = reportData.uuid;

    // 3. Get recordings — try UUID first (AI Companion transcripts need it), fallback to numeric ID
    let recData = null;
    if (uuid) {
      const enc = uuid.startsWith('/') || uuid.includes('//')
        ? encodeURIComponent(encodeURIComponent(uuid))
        : encodeURIComponent(uuid);
      const r = await fetch(
        `https://api.zoom.us/v2/meetings/${enc}/recordings`,
        { headers: { 'Authorization': `Bearer ${accessToken}` } }
      );
      const d = await r.json();
      if (r.ok) recData = d;
    }

    if (!recData) {
      const r = await fetch(
        `https://api.zoom.us/v2/meetings/${meetingId}/recordings`,
        { headers: { 'Authorization': `Bearer ${accessToken}` } }
      );
      recData = await r.json();
      if (!r.ok) {
        return res.status(500).json({
          error: 'No se encontraron grabaciones/transcripciones para este meeting.',
          detail: recData
        });
      }
    }

    const startTime = recData.start_time || reportData.start_time;
    const recordingFiles = recData.recording_files || [];

    // 4. Get asistencias from Supabase (needed regardless of transcript)
    const asistRes = await fetch(
      `${SB_URL}/rest/v1/asistencias?meeting_id=eq.${encodeURIComponent(meetingId)}&select=*`,
      { headers: sbHeaders }
    );
    const asistencias = await asistRes.json();

    if (!Array.isArray(asistencias) || asistencias.length === 0) {
      return res.status(400).json({
        error: 'No hay datos de asistencia para este meeting. Primero haz la sincronización de asistencia (Zoom Sync).'
      });
    }

    // 5. Build retention curve from asistencias + recording start_time
    const retention = buildRetention(asistencias, startTime);

    // 6. Try to get transcript (VTT)
    const transcriptFile = recordingFiles.find(f =>
      f.file_type === 'TRANSCRIPT' || f.recording_type === 'audio_transcript'
    );

    let transcriptByMinute = [];
    let transcriptWarning = null;

    if (!transcriptFile) {
      transcriptWarning = 'No se encontró transcripción automática. Ve a Zoom > Settings > Recording > habilita "Audio transcript" para futuras clases.';
    } else {
      // Download VTT
      const vttUrl = `${transcriptFile.download_url}?access_token=${accessToken}`;
      const vttRes = await fetch(vttUrl);
      if (!vttRes.ok) {
        transcriptWarning = 'No se pudo descargar la transcripción.';
      } else {
        const vttText = await vttRes.text();
        const segments = parseVTT(vttText);
        transcriptByMinute = groupTranscriptByMinute(segments);
      }
    }

    // 7. Find critical moments (>=10% drop in a 5-min window)
    const criticalMoments = findCriticalMoments(retention, transcriptByMinute);

    // 8. Cache in Supabase (upsert by meeting_id)
    const payload = {
      meeting_id: String(meetingId),
      start_time: startTime || null,
      total_participants: asistencias.length,
      retention_data: retention,
      critical_moments: criticalMoments,
      transcript_segments: transcriptByMinute,
      updated_at: new Date().toISOString()
    };

    await fetch(`${SB_URL}/rest/v1/clase_analisis`, {
      method: 'POST',
      headers: { ...sbHeaders, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(payload)
    });

    return res.status(200).json({
      meetingId,
      startTime,
      totalParticipants: asistencias.length,
      retention,
      criticalMoments,
      transcript: transcriptByMinute,
      transcriptWarning
    });

  } catch (err) {
    console.error('zoom-transcript error:', err);
    return res.status(500).json({ error: 'Error interno', detail: err.message });
  }
};

// ── VTT Parser ──────────────────────────────────────────────────────────────

function parseVTT(vttText) {
  const segments = [];
  const lines = vttText.split('\n');
  let i = 0;

  while (i < lines.length) {
    if (lines[i] && lines[i].includes('-->')) {
      const [startStr] = lines[i].split('-->');
      const startSec = vttTimeToSeconds(startStr.trim());
      const textLines = [];
      i++;
      while (i < lines.length && lines[i].trim() !== '' && !lines[i].includes('-->')) {
        const text = lines[i].replace(/<[^>]+>/g, '').trim(); // strip speaker tags
        if (text && !/^\d+$/.test(text)) textLines.push(text);
        i++;
      }
      if (textLines.length > 0) {
        segments.push({
          startSec,
          minute: Math.floor(startSec / 60),
          text: textLines.join(' ')
        });
      }
    } else {
      i++;
    }
  }

  return segments;
}

function vttTimeToSeconds(t) {
  const parts = t.replace(',', '.').split(':');
  if (parts.length === 3) {
    return parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseFloat(parts[2]);
  }
  return parseInt(parts[0]) * 60 + parseFloat(parts[1]);
}

// ── Retention Curve ──────────────────────────────────────────────────────────

function buildRetention(asistencias, startTime) {
  if (!startTime || !asistencias.length) return [];

  const start = new Date(startTime).getTime();

  // Find max meeting minute from leave times
  let maxMinute = 0;
  for (const a of asistencias) {
    if (a.hora_salida) {
      const m = Math.round((new Date(a.hora_salida).getTime() - start) / 60000);
      if (m > maxMinute) maxMinute = m;
    }
  }

  // Fallback: use duracion_minutos
  if (maxMinute === 0) {
    maxMinute = Math.max(...asistencias.map(a => a.duracion_minutos || 0));
  }
  if (maxMinute === 0) return [];

  const total = asistencias.length;
  const retention = [];

  // Build point every 5 minutes
  for (let m = 0; m <= maxMinute + 5; m += 5) {
    let stillIn = 0;
    for (const a of asistencias) {
      let leaveMin;
      if (a.hora_salida) {
        leaveMin = Math.round((new Date(a.hora_salida).getTime() - start) / 60000);
      } else {
        leaveMin = a.duracion_minutos || maxMinute;
      }
      if (leaveMin >= m) stillIn++;
    }
    retention.push({ minute: m, count: stillIn, pct: Math.round(stillIn / total * 100) });
    if (stillIn === 0) break;
  }

  return retention;
}

// ── Critical Moments ──────────────────────────────────────────────────────────

function findCriticalMoments(retention, transcriptByMinute) {
  if (retention.length < 2) return [];

  const critical = [];

  for (let i = 1; i < retention.length; i++) {
    const drop = retention[i - 1].pct - retention[i].pct;
    if (drop >= 10) {
      const minute = retention[i].minute;
      // Grab transcript text in a ±3 min window around the drop
      const relevant = transcriptByMinute
        .filter(s => s.minute >= minute - 3 && s.minute <= minute + 2)
        .map(s => s.text)
        .join(' ')
        .trim();

      critical.push({
        minute,
        prevPct: retention[i - 1].pct,
        pct: retention[i].pct,
        drop,
        transcript: relevant || null
      });
    }
  }

  return critical.sort((a, b) => b.drop - a.drop);
}

function groupTranscriptByMinute(segments) {
  const byMinute = {};
  for (const s of segments) {
    byMinute[s.minute] = (byMinute[s.minute] || '') + ' ' + s.text;
  }
  return Object.entries(byMinute)
    .map(([m, t]) => ({ minute: parseInt(m), text: t.trim() }))
    .sort((a, b) => a.minute - b.minute);
}
