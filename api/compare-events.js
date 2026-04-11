// Compare all clase_analisis rows to find speech evolution and best practices
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const authHeader = (req.headers['authorization'] || '').trim();
  const secret = (process.env.DASHBOARD_SECRET || 'proximity-dash-2026').trim();
  if (authHeader !== `Bearer ${secret}`) return res.status(401).json({ error: 'Unauthorized' });

  const SB_URL     = process.env.SB_URL;
  const SB_SERVICE = process.env.SB_SERVICE;
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

  if (!GEMINI_API_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY no configurado' });

  const sbHeaders = {
    'apikey': SB_SERVICE,
    'Authorization': `Bearer ${SB_SERVICE}`,
    'Content-Type': 'application/json'
  };

  try {
    // 1. Fetch all events with transcripts, ordered by date
    const r = await fetch(
      `${SB_URL}/rest/v1/clase_analisis?select=meeting_id,start_time,total_participants,retention_data,critical_moments,transcript_segments,ai_analysis&order=start_time.asc`,
      { headers: sbHeaders }
    );
    const events = await r.json();

    if (!Array.isArray(events) || events.length === 0) {
      return res.status(200).json({ error: 'No hay eventos guardados aún.' });
    }

    // Filter to events that have a transcript or analysis
    const withData = events.filter(e =>
      (e.transcript_segments && e.transcript_segments.length > 0) ||
      (e.ai_analysis && e.ai_analysis.topic_timeline)
    );

    if (withData.length === 0) {
      return res.status(200).json({ error: 'Ningún evento tiene transcripción guardada todavía.' });
    }

    if (withData.length === 1) {
      return res.status(200).json({
        error: 'Solo hay 1 evento con datos. Sube más transcripciones para comparar evolución.',
        eventCount: 1
      });
    }

    // 2. Build context for each event (cap transcript at 1500 chars each)
    const eventSummaries = withData.map((e, idx) => {
      const fecha = e.start_time ? new Date(e.start_time).toLocaleDateString('es-MX') : `Evento ${idx + 1}`;
      const ret = e.retention_data || [];
      const avgRetention = ret.length > 1
        ? Math.round(ret.slice(-1)[0].pct)
        : null;
      const drops = (e.critical_moments || [])
        .slice(0, 3)
        .map(c => `min ${c.minute}: −${c.drop}%`)
        .join(', ');
      const transcript = (e.transcript_segments || [])
        .map(s => `[${s.minute}min] ${s.text}`)
        .join(' ')
        .substring(0, 1500);
      const topics = e.ai_analysis?.topic_timeline
        ? e.ai_analysis.topic_timeline.map(t => `${t.minute_start}-${t.minute_end}min: ${t.topic}`).join(' | ')
        : '';

      return `--- EVENTO ${idx + 1}: ${fecha} (${e.total_participants || '?'} asistentes) ---
Retención final: ${avgRetention !== null ? avgRetention + '%' : 'N/D'}
Caídas principales: ${drops || 'sin datos'}
Temas: ${topics || 'sin datos'}
Transcripción: ${transcript || 'sin transcripción'}`;
    });

    // 3. Ask Claude for cross-event analysis
    const prompt = `Eres un experto en optimización de presentaciones en vivo. Tienes datos de ${withData.length} clases del mismo instructor. Tu objetivo es identificar la evolución del speech y qué versión funciona mejor.

${eventSummaries.join('\n\n')}

---

Analiza la evolución entre eventos y responde en JSON con exactamente esta estructura:
{
  "evolucion": [
    {
      "aspecto": "Nombre del aspecto analizado (ej: apertura, pitch, cierre)",
      "tendencia": "mejoro|empeoro|estable",
      "descripcion": "Qué cambió entre eventos y cómo afectó la retención"
    }
  ],
  "mejores_momentos": [
    {
      "evento_idx": 1,
      "minuto_aprox": 45,
      "descripcion": "Qué se dijo o hizo que funcionó bien (alta retención en ese punto)",
      "replicar": "Por qué replicarlo y cómo"
    }
  ],
  "peores_momentos": [
    {
      "descripcion": "Patrón que se repite y causa deserción",
      "minuto_tipico": 60,
      "solucion": "Cómo corregirlo"
    }
  ],
  "speech_optimo": {
    "resumen": "Descripción del speech ideal basado en los datos de todos los eventos (2-3 párrafos)",
    "estructura": ["Fase 1: ...", "Fase 2: ...", "Fase 3: ..."]
  }
}

Responde SOLO el JSON, sin texto adicional.`;

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 2000 }
        })
      }
    );

    const geminiData = await geminiRes.json();
    const text = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.status(500).json({ error: 'Gemini no devolvió JSON válido', raw: text });

    const analysis = JSON.parse(jsonMatch[0]);
    return res.status(200).json({
      eventCount: withData.length,
      events: withData.map((e, idx) => ({
        idx,
        meeting_id: e.meeting_id,
        fecha: e.start_time ? new Date(e.start_time).toLocaleDateString('es-MX') : `Evento ${idx + 1}`,
        total_participants: e.total_participants
      })),
      ...analysis
    });

  } catch (err) {
    console.error('compare-events error:', err);
    return res.status(500).json({ error: 'Error interno', detail: err.message });
  }
};
