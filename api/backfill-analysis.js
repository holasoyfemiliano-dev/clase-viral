// One-shot: compute + save ai_analysis for the most recent clase_analisis row that has ai_summary but no ai_analysis
module.exports = async function handler(req, res) {
  const authHeader = (req.headers['authorization'] || '').trim();
  const secret = (process.env.DASHBOARD_SECRET || 'proximity-dash-2026').trim();
  if (authHeader !== `Bearer ${secret}`) return res.status(401).json({ error: 'Unauthorized' });

  const SB_URL     = process.env.SB_URL;
  const SB_SERVICE = process.env.SB_SERVICE;
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!SB_URL || !SB_SERVICE || !ANTHROPIC_API_KEY) return res.status(500).json({ error: 'Missing env vars' });

  const sbHeaders = {
    'apikey': SB_SERVICE,
    'Authorization': `Bearer ${SB_SERVICE}`,
    'Content-Type': 'application/json'
  };

  // Get latest row with ai_summary but missing ai_analysis
  const rowRes = await fetch(
    `${SB_URL}/rest/v1/clase_analisis?select=*&ai_summary=not.is.null&ai_analysis=is.null&order=updated_at.desc&limit=1`,
    { headers: sbHeaders }
  );
  const rows = await rowRes.json();
  if (!rows || !rows.length) return res.status(200).json({ message: 'Nothing to backfill — all rows already have ai_analysis' });

  const row = rows[0];
  const { meeting_id, ai_summary, critical_moments, total_participants } = row;

  // Build prompt context from critical moments
  const criticalCtx = (critical_moments || []).map(cm =>
    `- Minuto ${cm.minute}: ${cm.prevPct}% → ${cm.pct}% (−${cm.drop}% en 5 min)`
  ).join('\n');

  const prompt = `Eres un estratega de contenido experto. Analiza esta clase en vivo y dame dos cosas:

DATOS DE LA CLASE:
- Total asistentes: ${total_participants}
- Duración: ~140 minutos
- Caídas de audiencia más importantes:
${criticalCtx || 'Sin datos de caída'}

RESUMEN DE LA CLASE (generado por Zoom AI):
${(ai_summary || '').substring(0, 3000)}

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

Para recomendaciones: enfócate en el minuto 55-65 donde más gente se fue.
Para momentos clipeables: 4-5 momentos más poderosos.
Para topic_timeline: 8-10 segmentos de ~15-20 min cada uno.
Responde SOLO el JSON, sin texto adicional.`;

  const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  const claudeData = await claudeRes.json();
  const text = claudeData.content?.[0]?.text || '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return res.status(500).json({ error: 'Claude no devolvió JSON válido', raw: text });

  const analysis = JSON.parse(jsonMatch[0]);

  // Save to Supabase
  await fetch(`${SB_URL}/rest/v1/clase_analisis?meeting_id=eq.${meeting_id}`, {
    method: 'PATCH',
    headers: { ...sbHeaders, 'Prefer': 'return=minimal' },
    body: JSON.stringify({ ai_analysis: analysis, updated_at: new Date().toISOString() })
  });

  return res.status(200).json({ ok: true, meeting_id, analysis });
};
