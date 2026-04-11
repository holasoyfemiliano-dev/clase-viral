// Vercel Serverless Function — Auto-optimize underperforming A/B variant
// POST /api/optimize-variant
// Body: { variant, currentTitle, winnerTitle, winnerCVR, loserCVR, visits }

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const authHeader = (req.headers['authorization'] || '').trim();
  const secret = (process.env.DASHBOARD_SECRET || 'proximity-dash-2026').trim();
  if (authHeader !== `Bearer ${secret}`) return res.status(401).json({ error: 'Unauthorized' });

  const { variant, currentTitle, winnerTitle, winnerCVR, loserCVR, visits } = req.body;
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

  if (!GEMINI_API_KEY) {
    return res.status(500).json({ error: 'GEMINI_API_KEY no configurado en Vercel.' });
  }

  const prompt = `Eres un experto en copywriting para landing pages en español latinoamericano.

Estás optimizando el título de una clase en vivo gratuita sobre marketing y ventas para emprendedores.

CONTEXTO:
- Título actual (variante ${variant}): "${currentTitle}"
- Este título tiene ${loserCVR}% de conversión con ${visits} visitas — está bajo rendimiento
- El título ganador actual convierte al ${winnerCVR}%: "${winnerTitle}"

Tu tarea: Escribe UN nuevo título que sea MEJOR que el actual.

Reglas:
- Máximo 12 palabras
- Debe generar urgencia o curiosidad inmediata
- Enfocado en el resultado/transformación del cliente (más ventas, más dinero, escalar su negocio)
- Tono directo, sin clichés ni palabras relleno
- En español latinoamericano, sin "vosotros"
- NO copies el título ganador — propone un ángulo diferente

Responde ÚNICAMENTE con el nuevo título, sin comillas, sin explicación.`;

  try {
    const aiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 100 }
        })
      }
    );

    const aiData = await aiRes.json();
    if (!aiRes.ok || !aiData.candidates?.[0]?.content?.parts?.[0]?.text) {
      return res.status(500).json({ error: 'Error de IA', detail: aiData });
    }

    const newTitle = aiData.candidates[0].content.parts[0].text.trim().replace(/^["']|["']$/g, '');

    return res.status(200).json({
      variant,
      oldTitle: currentTitle,
      newTitle,
      reason: `Variante ${variant} tenía ${loserCVR}% CVR con ${visits} visitas (vs ${winnerCVR}% del ganador)`
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
