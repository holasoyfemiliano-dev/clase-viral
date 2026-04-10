// Zoom Webhook — auto-syncs participants and AI summary after each meeting
module.exports = async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({ message: 'Zoom webhook endpoint active' });
  }
  if (req.method !== 'POST') return res.status(405).end();

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch(e) { return res.status(400).json({ error: 'Invalid JSON' }); }
  }
  if (!body) return res.status(400).json({ error: 'Empty body' });

  // Zoom URL validation challenge
  if (body.event === 'endpoint.url_validation') {
    const crypto = require('crypto');
    const hashForValidate = crypto
      .createHmac('sha256', (process.env.ZOOM_WEBHOOK_SECRET_TOKEN || '').trim())
      .update(body.payload.plainToken)
      .digest('hex');
    return res.status(200).json({
      plainToken: body.payload.plainToken,
      encryptedToken: hashForValidate
    });
  }

  const SB_URL     = process.env.SB_URL;
  const SB_SERVICE = process.env.SB_SERVICE;
  const sbHeaders  = {
    'apikey': SB_SERVICE,
    'Authorization': `Bearer ${SB_SERVICE}`,
    'Content-Type': 'application/json'
  };

  // ── Meeting Ended: sync participants + fetch AI summary ──────────────────
  if (body.event === 'meeting.ended') {
    const obj       = body.payload?.object || {};
    const meetingId = String(obj.id || '');
    const uuid      = obj.uuid || '';

    // Respond immediately so Zoom doesn't timeout
    res.status(200).json({ received: true });

    // 1. Sync participants
    try {
      await fetch(`https://clase-viral.vercel.app/api/zoom-sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${(process.env.DASHBOARD_SECRET || 'proximity-dash-2026').trim()}`
        },
        body: JSON.stringify({ meetingId })
      });
    } catch(e) { console.error('zoom-sync trigger failed', e.message); }

    // 2. Try to fetch AI Companion summary (may take a few minutes to generate)
    if (uuid) {
      const encoded = uuid.startsWith('/') || uuid.includes('//')
        ? encodeURIComponent(encodeURIComponent(uuid))
        : encodeURIComponent(uuid);

      // Get Zoom token
      const ZOOM_ACCOUNT_ID    = process.env.ZOOM_ACCOUNT_ID;
      const ZOOM_CLIENT_ID     = process.env.ZOOM_CLIENT_ID;
      const ZOOM_CLIENT_SECRET = process.env.ZOOM_CLIENT_SECRET;

      try {
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

        if (access_token) {
          const summaryRes = await fetch(
            `https://api.zoom.us/v2/meetings/${encoded}/meeting_summary`,
            { headers: { 'Authorization': `Bearer ${access_token}` } }
          );
          const summary = await summaryRes.json();

          if (summary && !summary.code) {
            const aiSummaryText = summary.summary_content || summary.summary || null;

            // Save summary first
            await fetch(`${SB_URL}/rest/v1/clase_analisis`, {
              method: 'POST',
              headers: { ...sbHeaders, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
              body: JSON.stringify({
                meeting_id:         meetingId,
                start_time:         obj.start_time || new Date().toISOString(),
                total_participants: obj.participant_count || 0,
                ai_summary:         aiSummaryText,
                ai_next_steps:      summary.next_steps || null,
                ai_keywords:        summary.keywords || null,
                updated_at:         new Date().toISOString()
              })
            });
            console.log(`[zoom-webhook] AI summary saved for meeting ${meetingId}`);

            // Pre-compute AI analysis (recomendaciones + clips + topic_timeline) so dashboard loads instantly
            if (aiSummaryText && process.env.ANTHROPIC_API_KEY) {
              try {
                const analysisRes = await fetch(`https://clase-viral.vercel.app/api/analyze-clase`, {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${(process.env.DASHBOARD_SECRET || 'proximity-dash-2026').trim()}`
                  },
                  body: JSON.stringify({
                    aiSummary: aiSummaryText,
                    retentionData: [],
                    criticalMoments: [],
                    totalParticipants: obj.participant_count || 0
                  })
                });
                const aiAnalysis = await analysisRes.json();
                if (aiAnalysis && !aiAnalysis.error) {
                  await fetch(`${SB_URL}/rest/v1/clase_analisis?meeting_id=eq.${meetingId}`, {
                    method: 'PATCH',
                    headers: { ...sbHeaders, 'Prefer': 'return=minimal' },
                    body: JSON.stringify({ ai_analysis: aiAnalysis, updated_at: new Date().toISOString() })
                  });
                  console.log(`[zoom-webhook] AI analysis pre-computed for meeting ${meetingId}`);
                }
              } catch(e) { console.error('AI analysis pre-compute failed', e.message); }
            }
          }
        }
      } catch(e) { console.error('AI summary fetch failed', e.message); }
    }

    return; // already responded
  }

  return res.status(200).json({ received: true, event: body.event });
};
