// Analyze clase data with Claude AI → content recommendations + clippable moments
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const authHeader = (req.headers['authorization'] || '').trim();
  const secret = (process.env.DASHBOARD_SECRET || 'proximity-dash-2026').trim();
  if (authHeader !== `Bearer ${secret}`) return res.status(401).json({ error: 'Unauthorized' });

  const { aiSummary, retentionData, criticalMoments, totalParticipants } = req.body || {};
  if (!aiSummary) return res.status(400).json({ error: 'aiSummary requerido' });

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY no configurado' });

  // Build context about when people left
  const criticalCtx = (criticalMoments || []).map(cm =>
    `- Minuto ${cm.minute}: ${cm.prevPct}% → ${cm.pct}% (−${cm.drop}% en 5 min)`
  ).join('\n');

  const prompt = `Eres un estratega de contenido experto. Analiza esta clase en vivo y dame dos cosas:

DATOS DE LA CLASE:
- Total asistentes: ${totalParticipants}
- Duración: ~140 minutos
- Caídas de audiencia más importantes:
${criticalCtx || 'Sin datos de caída'}

RESUMEN DE LA CLASE (generado por Zoom AI):
${aiSummary.substring(0, 3000)}

---

Responde en JSON con exactamente esta estructura:
{
  "recomendaciones": [
    {
      "titulo": "Título corto de la recomendación",
      "descripcion": "Qué mejorar y por qué, máximo 2 oraciones",
      "prioridad": "alta|media|baja"
    }
  ],
  "momentos_clipeables": [
    {
      "titulo": "Nombre del momento",
      "descripcion": "Qué se dijo o pasó en este momento que lo hace clipeable",
      "formato": "reel|story|carrusel|hilo",
      "hook": "El hook de 1 línea para usar en el clip"
    }
  ],
  "topic_timeline": [
    {
      "minute_start": 0,
      "minute_end": 20,
      "topic": "Descripción breve de qué se habló en este segmento"
    }
  ]
}

Para recomendaciones: enfócate en qué cambiar en el minuto 55-65 donde más gente se fue.
Para momentos clipeables: identifica los 4-5 momentos más poderosos de la clase (historias personales, datos sorprendentes, frameworks, el pitch).
Para topic_timeline: divide la clase en 8-10 segmentos de tiempo y describe brevemente qué tema se trató en cada uno. Usa rangos de ~15-20 minutos. El topic debe ser una frase corta (máximo 6 palabras) de qué se estaba hablando o haciendo en ese momento.
Responde SOLO el JSON, sin texto adicional.`;

  try {
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

    // Parse JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.status(500).json({ error: 'Claude no devolvió JSON válido', raw: text });

    const analysis = JSON.parse(jsonMatch[0]);
    return res.status(200).json(analysis);

  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};
