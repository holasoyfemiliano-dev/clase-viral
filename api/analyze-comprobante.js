// Analyze payment proof with Gemini Vision — verify amount, date, parties
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const authHeader = (req.headers['authorization'] || '').trim();
  const secret = (process.env.DASHBOARD_SECRET || 'proximity-dash-2026').trim();
  if (authHeader !== `Bearer ${secret}`) return res.status(401).json({ error: 'Unauthorized' });

  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_API_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY no configurado' });

  const { imageBase64, mimeType, expectedMonto, context } = req.body || {};
  if (!imageBase64) return res.status(400).json({ error: 'imageBase64 requerido' });

  const prompt = `Eres un asistente financiero. Analiza este comprobante de pago y extrae la información clave.

${expectedMonto ? `Monto esperado según el reporte: $${expectedMonto} MXN` : ''}
Contexto: ${context || 'comprobante de pago de venta'}

Responde SOLO con JSON válido (sin markdown, sin texto extra):
{
  "monto_detectado": 0,
  "moneda": "MXN",
  "fecha": "YYYY-MM-DD o null si no se ve",
  "emisor": "nombre de quien pagó o null",
  "receptor": "nombre de quien recibió o null",
  "concepto": "descripción del pago o null",
  "match": true,
  "confianza": "alta|media|baja",
  "observaciones": "nota breve sobre el comprobante"
}

Reglas:
- match: true si el monto_detectado coincide con el esperado (±5%), false si difiere o no se puede confirmar
- Si es transferencia bancaria, SPEI, depósito o pago digital, extrae el monto de la transacción
- Si no puedes leer el monto claramente, pon monto_detectado: 0 y match: false
- Responde SOLO el JSON`;

  try {
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: prompt },
              { inline_data: { mime_type: mimeType || 'image/jpeg', data: imageBase64 } }
            ]
          }],
          generationConfig: { maxOutputTokens: 500, responseMimeType: 'application/json' }
        })
      }
    );

    const geminiData = await geminiRes.json();
    let text = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '';
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.status(200).json({ error: 'No se pudo leer el comprobante', monto_detectado: 0, match: false });

    const result = JSON.parse(jsonMatch[0]);
    return res.status(200).json(result);

  } catch(e) {
    return res.status(500).json({ error: e.message, monto_detectado: 0, match: false });
  }
};
