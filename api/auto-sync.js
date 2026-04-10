// Vercel Cron Job — Auto sync after Thursday class
// Runs every Friday 4:00 AM UTC = Thursday 11:00 PM Mexico City (CDT)
// GET /api/auto-sync

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Accept from Vercel cron (no auth header) OR manual call with secret
  const authHeader = (req.headers['authorization'] || '').trim();
  const secret = (process.env.DASHBOARD_SECRET || 'proximity-dash-2026').trim();
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  if (authHeader && authHeader !== `Bearer ${secret}` && !isVercelCron) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const ZOOM_ACCOUNT_ID    = process.env.ZOOM_ACCOUNT_ID;
  const ZOOM_CLIENT_ID     = process.env.ZOOM_CLIENT_ID;
  const ZOOM_CLIENT_SECRET = process.env.ZOOM_CLIENT_SECRET;
  const SB_URL             = process.env.SB_URL;
  const SB_SERVICE         = process.env.SB_SERVICE;

  const sbHeaders = {
    'apikey': SB_SERVICE,
    'Authorization': `Bearer ${SB_SERVICE}`,
    'Content-Type': 'application/json'
  };

  const log = [];

  try {
    // 1. Get Zoom token
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
      return res.status(500).json({ error: 'Zoom auth failed', detail: tokenData });
    }
    const accessToken = tokenData.access_token;
    log.push('✓ Zoom auth OK');

    // 2. Find the most recent recording from the last 7 days
    const today = new Date();
    const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
    const from = weekAgo.toISOString().split('T')[0];
    const to   = today.toISOString().split('T')[0];

    const recListRes = await fetch(
      `https://api.zoom.us/v2/users/me/recordings?from=${from}&to=${to}&page_size=10`,
      { headers: { 'Authorization': `Bearer ${accessToken}` } }
    );
    const recListData = await recListRes.json();
    const meetings = (recListData.meetings || [])
      .sort((a, b) => new Date(b.start_time) - new Date(a.start_time));

    if (meetings.length === 0) {
      return res.status(200).json({ message: 'No recordings found in the last 7 days. Skipping.', log });
    }

    const latestMeeting = meetings[0];
    const meetingId = String(latestMeeting.id);
    const startTime = latestMeeting.start_time;
    log.push(`✓ Latest meeting: ${meetingId} — ${startTime}`);

    // ── PART A: Participant sync ──────────────────────────────────────────────

    // Paginate participants
    let allParticipants = [];
    let nextPageToken = '';
    do {
      const url = `https://api.zoom.us/v2/report/meetings/${meetingId}/participants?page_size=300${nextPageToken ? `&next_page_token=${nextPageToken}` : ''}`;
      const partRes = await fetch(url, { headers: { 'Authorization': `Bearer ${accessToken}` } });
      const partData = await partRes.json();
      if (!partRes.ok) {
        log.push(`⚠ Could not fetch participants: ${JSON.stringify(partData)}`);
        break;
      }
      allParticipants = allParticipants.concat(partData.participants || []);
      nextPageToken = partData.next_page_token || '';
    } while (nextPageToken);

    log.push(`✓ ${allParticipants.length} participant records fetched`);

    if (allParticipants.length > 0) {
      // Delete previous records for clean re-sync
      await fetch(`${SB_URL}/rest/v1/asistencias?meeting_id=eq.${encodeURIComponent(meetingId)}`, {
        method: 'DELETE',
        headers: { ...sbHeaders, 'Prefer': 'return=minimal' }
      });

      // Deduplicate by email
      const byEmail = {};
      for (const p of allParticipants) {
        const key = p.user_email || p.id || p.name;
        if (!byEmail[key]) byEmail[key] = { ...p, totalDuration: p.duration };
        else byEmail[key].totalDuration += p.duration;
      }
      const unique = Object.values(byEmail);

      // Insert asistencias
      const rows = unique.map(p => ({
        meeting_id: meetingId,
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
      log.push(`✓ ${unique.length} participants synced to asistencias`);

      // Upsert lead_estados
      let matched = 0;
      for (const p of unique) {
        if (!p.user_email) continue;
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

        const patchRes = await fetch(
          `${SB_URL}/rest/v1/lead_estados?registro_email=eq.${encodeURIComponent(p.user_email)}`,
          {
            method: 'PATCH',
            headers: { ...sbHeaders, 'Prefer': 'return=representation' },
            body: JSON.stringify({ estado: 'asistio', updated_at: new Date().toISOString() })
          }
        );
        const updated = await patchRes.json();
        if (!Array.isArray(updated) || updated.length === 0) {
          await fetch(`${SB_URL}/rest/v1/lead_estados`, {
            method: 'POST',
            headers: { ...sbHeaders, 'Prefer': 'return=minimal' },
            body: JSON.stringify({ registro_email: p.user_email, estado: 'asistio', vendedor: '', updated_at: new Date().toISOString() })
          });
        }
      }
      log.push(`✓ ${matched} leads matched and marked as asistio`);
    }

    // ── PART B: Transcript Analysis ───────────────────────────────────────────

    const recordingFiles = latestMeeting.recording_files || [];
    const transcriptFile = recordingFiles.find(f =>
      f.file_type === 'TRANSCRIPT' || f.recording_type === 'audio_transcript'
    );

    // Re-fetch asistencias for retention curve
    const asistRes = await fetch(
      `${SB_URL}/rest/v1/asistencias?meeting_id=eq.${encodeURIComponent(meetingId)}&select=*`,
      { headers: sbHeaders }
    );
    const asistencias = await asistRes.json();

    const retention = buildRetention(asistencias || [], startTime);
    let transcriptByMinute = [];

    if (transcriptFile) {
      const vttUrl = `${transcriptFile.download_url}?access_token=${accessToken}`;
      const vttRes = await fetch(vttUrl);
      if (vttRes.ok) {
        const vttText = await vttRes.text();
        transcriptByMinute = groupTranscriptByMinute(parseVTT(vttText));
        log.push(`✓ Transcript parsed — ${transcriptByMinute.length} minute segments`);
      }
    } else {
      log.push('⚠ No transcript file found for this meeting');
    }

    const criticalMoments = findCriticalMoments(retention, transcriptByMinute);

    // Cache analysis
    await fetch(`${SB_URL}/rest/v1/clase_analisis`, {
      method: 'POST',
      headers: { ...sbHeaders, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({
        meeting_id: meetingId,
        start_time: startTime,
        total_participants: (asistencias || []).length,
        retention_data: retention,
        critical_moments: criticalMoments,
        transcript_segments: transcriptByMinute,
        updated_at: new Date().toISOString()
      })
    });
    log.push(`✓ Analysis cached — ${criticalMoments.length} critical moments found`);

    return res.status(200).json({
      success: true,
      meetingId,
      startTime,
      participants: allParticipants.length,
      criticalMoments: criticalMoments.length,
      log
    });

  } catch (err) {
    console.error('auto-sync error:', err);
    return res.status(500).json({ error: err.message, log });
  }
};

// ── Helpers (same as zoom-transcript.js) ─────────────────────────────────────

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
        const text = lines[i].replace(/<[^>]+>/g, '').trim();
        if (text && !/^\d+$/.test(text)) textLines.push(text);
        i++;
      }
      if (textLines.length > 0) segments.push({ startSec, minute: Math.floor(startSec / 60), text: textLines.join(' ') });
    } else { i++; }
  }
  return segments;
}

function vttTimeToSeconds(t) {
  const parts = t.replace(',', '.').split(':');
  return parts.length === 3
    ? parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseFloat(parts[2])
    : parseInt(parts[0]) * 60 + parseFloat(parts[1]);
}

function buildRetention(asistencias, startTime) {
  if (!startTime || !asistencias.length) return [];
  const start = new Date(startTime).getTime();
  let maxMinute = 0;
  for (const a of asistencias) {
    if (a.hora_salida) {
      const m = Math.round((new Date(a.hora_salida).getTime() - start) / 60000);
      if (m > maxMinute) maxMinute = m;
    }
  }
  if (maxMinute === 0) maxMinute = Math.max(...asistencias.map(a => a.duracion_minutos || 0));
  if (maxMinute === 0) return [];
  const total = asistencias.length;
  const retention = [];
  for (let m = 0; m <= maxMinute + 5; m += 5) {
    let stillIn = 0;
    for (const a of asistencias) {
      const leaveMin = a.hora_salida
        ? Math.round((new Date(a.hora_salida).getTime() - start) / 60000)
        : a.duracion_minutos || maxMinute;
      if (leaveMin >= m) stillIn++;
    }
    retention.push({ minute: m, count: stillIn, pct: Math.round(stillIn / total * 100) });
    if (stillIn === 0) break;
  }
  return retention;
}

function findCriticalMoments(retention, transcriptByMinute) {
  if (retention.length < 2) return [];
  return retention.slice(1).reduce((acc, r, i) => {
    const drop = retention[i].pct - r.pct;
    if (drop >= 10) {
      const relevant = transcriptByMinute
        .filter(s => s.minute >= r.minute - 3 && s.minute <= r.minute + 2)
        .map(s => s.text).join(' ').trim();
      acc.push({ minute: r.minute, prevPct: retention[i].pct, pct: r.pct, drop, transcript: relevant || null });
    }
    return acc;
  }, []).sort((a, b) => b.drop - a.drop);
}

function groupTranscriptByMinute(segments) {
  const byMinute = {};
  for (const s of segments) byMinute[s.minute] = (byMinute[s.minute] || '') + ' ' + s.text;
  return Object.entries(byMinute)
    .map(([m, t]) => ({ minute: parseInt(m), text: t.trim() }))
    .sort((a, b) => a.minute - b.minute);
}
