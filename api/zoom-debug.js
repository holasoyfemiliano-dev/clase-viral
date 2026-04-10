// Fetch AI Companion transcript from Zoom
module.exports = async function handler(req, res) {
  const authHeader = (req.headers['authorization'] || '').trim();
  const secret = (process.env.DASHBOARD_SECRET || 'proximity-dash-2026').trim();
  if (authHeader !== `Bearer ${secret}`) return res.status(401).json({ error: 'Unauthorized' });

  const { ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET } = process.env;

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
  const { access_token } = await tokenRes.json();
  if (!access_token) return res.status(500).json({ error: 'Zoom auth failed' });

  const meetingId = req.query.meetingId || '89295646404';

  // Get UUID from reports API
  const reportRes = await fetch(`https://api.zoom.us/v2/report/meetings/${meetingId}`,
    { headers: { 'Authorization': `Bearer ${access_token}` } });
  const reportData = await reportRes.json();
  const uuid = reportData.uuid;

  // Try summary with UUID
  let summary = null;
  if (uuid) {
    const enc = uuid.startsWith('/') || uuid.includes('//')
      ? encodeURIComponent(encodeURIComponent(uuid))
      : encodeURIComponent(uuid);
    const sumRes = await fetch(`https://api.zoom.us/v2/meetings/${enc}/meeting_summary`,
      { headers: { 'Authorization': `Bearer ${access_token}` } });
    summary = await sumRes.json();
  }

  // Also try direct summary with numeric ID
  const sumDirectRes = await fetch(`https://api.zoom.us/v2/meetings/${meetingId}/meeting_summary`,
    { headers: { 'Authorization': `Bearer ${access_token}` } });
  const sumDirect = await sumDirectRes.json();

  return res.status(200).json({ uuid, reportData, summary, sumDirect });
};
