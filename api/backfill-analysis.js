// One-shot: compute + save ai_analysis for the most recent clase_analisis row that has ai_summary but no ai_analysis
module.exports = async function handler(req, res) {
  const authHeader = (req.headers['authorization'] || '').trim();
  const secret = (process.env.DASHBOARD_SECRET || 'proximity-dash-2026').trim();
  if (authHeader !== `Bearer ${secret}`) return res.status(401).json({ error: 'Unauthorized' });

  const SB_URL     = process.env.SB_URL;
  const SB_SERVICE = process.env.SB_SERVICE;
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (!SB_URL || !SB_SERVICE || !GEMINI_API_KEY) return res.status(500).json({ error: 'Missing env vars' });

  const sbHeaders = {
    'apikey': SB_SERVICE,
    'Authorization': `Bearer ${SB_SERVICE}`,
    'Content-Type': 'application/json'
  };

  // Get latest row missing ai_analysis — accepts rows with ai_summary OR transcript_segments
  const rowRes = await fetch(
    `${SB_URL}/rest/v1/clase_analisis?select=*&ai_analysis=is.null&order=updated_at.desc&limit=1`,
    { headers: sbHeaders }
  );
  const rows = await rowRes.json();
  if (!rows || !rows.length) return res.status(200).json({ message: 'Nothing to backfill — all rows already have ai_analysis' });

  const row = rows[0];
  const { meeting_id, ai_summary, transcript_segments, critical_moments, total_participants } = row;

  if (!ai_summary && (!transcript_segments || !transcript_segments.length)) {
    return res.status(200).json({ message: 'No hay ai_summary ni transcript_segments para analizar', meeting_id });
  }

  // Build prompt context from critical moments
  const criticalCtx = (critical_moments || []).map(cm =>
    `- Minuto ${cm.minute}: ${cm.prevPct}% → ${cm.pct}% (−${cm.drop}% en 5 min)`
  ).join('\n');

  // Use ai_summary if available, else build from transcript
  let claseContext;
  if (ai_summary) {
    claseContext = `RESUMEN DE LA CLASE (generado por Zoom AI):\n${ai_summary.substring(0, 3000)}`;
  } else {
    const transcriptText = transcript_segments
      .map(s => `[min ${s.minute}] ${s.text}`)
      .join('\n')
      .substring(0, 4000);
    claseContext = `TRANSCRIPCIÓN DE LA CLASE (minuto a minuto):\n${transcriptText}`;
  }

  const prompt = `Eres un estratega de contenido experto. Analiza esta clase en vivo y dame dos cosas:

DATOS DE LA CLASE:
- Total asistentes: ${total_participants || 'desconocido'}
- Caídas de audiencia más importantes:
${criticalCtx || 'Sin datos de caída'}

${claseContext}

---

Responde en JSON con exactamente esta estructura:
{
  "recomendaciones": [
    { "titulo": "Título corto", "descripcion": "Qué mejorar, máximo 2 oraciones", "prioridad": "alta|media|baja" }
  ],
  "momentos_clipeables": [
    { "titulo": "Nombre del momento", "descripcion": "Por qué es clipeable", "formato": "reel|story|carrusel|hilo", "hook": "Hook de 1 línea" }
  ],
  "topic_timeline": [
    { "minute_start": 0, "minute_end": 20, "topic": "Frase corta del tema (máx 6 palabras)" }
  ]
}

Para recomendaciones: enfócate en los minutos donde más gente se fue.
Para momentos clipeables: 4-5 momentos más poderosos.
Para topic_timeline: 8-10 segmentos de ~15-20 min cada uno.
Responde SOLO el JSON, sin texto adicional.`;

  const geminiRes = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 1500 }
      })
    }
  );

  const geminiData = await geminiRes.json();
  if (geminiData.error) return res.status(500).json({ error: 'Gemini API error', detail: geminiData.error });
  const text = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return res.status(500).json({
    error: 'Gemini no devolvió JSON válido',
    raw: text,
    has_transcript: !!(transcript_segments?.length),
    transcript_len: transcript_segments?.length || 0
  });

  const analysis = JSON.parse(jsonMatch[0]);

  // Save to Supabase
  await fetch(`${SB_URL}/rest/v1/clase_analisis?meeting_id=eq.${meeting_id}`, {
    method: 'PATCH',
    headers: { ...sbHeaders, 'Prefer': 'return=minimal' },
    body: JSON.stringify({ ai_analysis: analysis, updated_at: new Date().toISOString() })
  });

  return res.status(200).json({ ok: true, meeting_id, analysis });
};
