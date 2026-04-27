/**
 * /api/sheets-proxy.js — Escribe leads directo en Google Sheets via Sheets API v4
 * Usa cuenta de servicio (sin Apps Script). Variables de entorno requeridas:
 *   GOOGLE_SERVICE_ACCOUNT_EMAIL
 *   GOOGLE_PRIVATE_KEY   (la clave privada completa, con \n como saltos de línea)
 *   GOOGLE_SHEET_ID      (ID del spreadsheet: docs.google.com/spreadsheets/d/<ID>)
 */
const crypto = require('crypto');

async function getAccessToken(email, privateKeyPem) {
  const now = Math.floor(Date.now() / 1000);
  const header  = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })).toString('base64url');

  const sign = crypto.createSign('RSA-SHA256');
  sign.update(`${header}.${payload}`);
  const sig = sign.sign(privateKeyPem, 'base64url');

  const jwt = `${header}.${payload}.${sig}`;

  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  const data = await r.json();
  if (!data.access_token) throw new Error('Token error: ' + JSON.stringify(data));
  return data.access_token;
}

function getWeekSheetName(tsStr) {
  const d = tsStr ? new Date(tsStr) : new Date();
  const month = d.getUTCMonth();
  const offsetHours = (month >= 3 && month <= 9) ? -5 : -6;
  const mx = new Date(d.getTime() + offsetHours * 3600000);
  const day = mx.getUTCDay();
  const diff = (day === 0) ? -6 : 1 - day;
  const monday = new Date(mx);
  monday.setUTCDate(mx.getUTCDate() + diff);
  const dd = String(monday.getUTCDate()).padStart(2, '0');
  const mm  = String(monday.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = monday.getUTCFullYear();
  return `Semana ${dd}/${mm}/${yyyy}`;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const SA_EMAIL  = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const SA_KEY    = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  const SHEET_ID  = process.env.GOOGLE_SHEET_ID;

  if (!SA_EMAIL || !SA_KEY || !SHEET_ID) {
    return res.status(500).json({ error: 'Google Sheets not configured' });
  }

  const { nombre, email, phone, ts, variante } = req.body || {};
  if (!email) return res.status(400).json({ error: 'email required' });

  try {
    const token = await getAccessToken(SA_EMAIL, SA_KEY);

    const sheetName = getWeekSheetName(ts);
    const fecha = new Date(ts || Date.now()).toLocaleString('es-MX', { timeZone: 'America/Mexico_City' });

    // Ensure sheet exists — get spreadsheet metadata
    const metaRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const meta = await metaRes.json();
    const sheets = (meta.sheets || []).map(s => s.properties.title);

    if (!sheets.includes(sheetName)) {
      // Create the sheet
      await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}:batchUpdate`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ requests: [{ addSheet: { properties: { title: sheetName } } }] }),
      });
      // Add header row
      await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(sheetName + '!A1')}:append?valueInputOption=RAW`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ values: [['Nombre', 'Email', 'Teléfono', 'Variante', 'Fecha', 'Semana']] }),
        }
      );
    }

    // Append the lead row
    const appendRes = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(sheetName + '!A1')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: [[nombre || '', email, phone || '', variante || '', fecha, sheetName]] }),
      }
    );
    const appendData = await appendRes.json();
    if (appendData.error) throw new Error(appendData.error.message);

    return res.status(200).json({ ok: true, sheet: sheetName });
  } catch (e) {
    return res.status(502).json({ ok: false, error: e.message });
  }
};
