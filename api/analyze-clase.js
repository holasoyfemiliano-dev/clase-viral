// Analyze clase data OR payment comprobante with Gemini AI
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const authHeader = (req.headers['authorization'] || '').trim();
  const secret = (process.env.DASHBOARD_SECRET || 'proximity-dash-2026').trim();
  if (authHeader !== `Bearer ${secret}`) return res.status(401).json({ error: 'Unauthorized' });

  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_API_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY no configurado' });

  // ── ACTION: analyze payment comprobante (image/PDF) ──
  const action = req.query?.action || req.body?.action;
  if (action === 'comprobante') {
    const { imageBase64, mimeType, expectedMonto, context } = req.body || {};
    if (!imageBase64) return res.status(400).json({ error: 'imageBase64 requerido' });

    const prompt = `Eres un asistente financiero. Analiza este comprobante de pago y extrae la información clave.
${expectedMonto ? `\nMonto esperado según el reporte: $${expectedMonto} MXN` : ''}
Contexto: ${context || 'comprobante de pago'}

Responde SOLO con JSON válido (sin markdown, sin texto extra):
{"monto_detectado":0,"moneda":"MXN","fecha":null,"emisor":null,"receptor":null,"concepto":null,"match":false,"confianza":"baja","observaciones":""}

Reglas:
- match: true si monto_detectado coincide con el esperado (±5%)
- Si es transferencia SPEI, depósito o pago digital, extrae el monto de la transacción
- Si no puedes leer el monto, pon monto_detectado:0 y match:false
- Responde SOLO el JSON`;

    try {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mimeType || 'image/jpeg', data: imageBase64 } }] }],
            generationConfig: { maxOutputTokens: 400, responseMimeType: 'application/json' }
          })
        }
      );
      const d = await r.json();
      let text = d.candidates?.[0]?.content?.parts?.[0]?.text || '';
      text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) return res.status(200).json({ error: 'No se pudo leer', monto_detectado: 0, match: false });
      return res.status(200).json(JSON.parse(m[0]));
    } catch(e) {
      return res.status(500).json({ error: e.message, monto_detectado: 0, match: false });
    }
  }

  // ── ACTION: analyze clase content (default) ──
  const { aiSummary, transcriptSegments, retentionData, criticalMoments, totalParticipants } = req.body || {};
  if (!aiSummary && (!transcriptSegments || !transcriptSegments.length)) {
    return res.status(400).json({ error: 'Se requiere aiSummary o transcriptSegments' });
  }

  // Build context about when people left
  const criticalCtx = (criticalMoments || []).map(cm =>
    `- Minuto ${cm.minute}: ${cm.prevPct}% → ${cm.pct}% (−${cm.drop}% en 5 min)`
  ).join('\n');

  // Build transcript context — use aiSummary if available, otherwise use raw transcript
  let claseContext;
  if (aiSummary) {
    claseContext = `RESUMEN DE LA CLASE (generado por Zoom AI):\n${aiSummary.substring(0, 3000)}`;
  } else {
    // Build a readable transcript from segments (cap at ~4000 chars)
    const transcriptText = (transcriptSegments || [])
      .map(s => `[min ${s.minute}] ${s.text}`)
      .join('\n')
      .substring(0, 4000);
    claseContext = `TRANSCRIPCIÓN DE LA CLASE (minuto a minuto):\n${transcriptText}`;
  }

  const prompt = `Eres un estratega de contenido experto. Analiza esta clase en vivo y dame dos cosas:

DATOS DE LA CLASE:
- Total asistentes: ${totalParticipants || 'desconocido'}
- Caídas de audiencia más importantes:
${criticalCtx || 'Sin datos de caída'}

${claseContext}

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
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            maxOutputTokens: 2500,
            responseMimeType: 'application/json'
          }
        })
      }
    );

    const geminiData = await geminiRes.json();
    let text = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '';

    // Strip markdown code fences if present
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.status(500).json({ error: 'Gemini no devolvió JSON válido', raw: text.substring(0, 300) });

    const analysis = JSON.parse(jsonMatch[0]);
    return res.status(200).json(analysis);

  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};
