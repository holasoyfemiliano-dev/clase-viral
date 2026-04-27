// Meta Ads Graph API proxy — Vercel Serverless Function
// GET/POST /api/meta-ads?action=...
//
// Required Vercel env vars:
//   META_ACCESS_TOKEN   — System User token (no expiry) with ads_read + ads_management
//   META_AD_ACCOUNT_ID  — Ad account numeric ID (without "act_" prefix)
//
// Optional:
//   DASHBOARD_SECRET    — Same secret used by other dashboard functions

const META_API = 'https://graph.facebook.com/v21.0';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Auth check
  const authHeader = (req.headers['authorization'] || '').trim();
  const secret = (process.env.DASHBOARD_SECRET || 'proximity-dash-2026').trim();
  if (authHeader !== `Bearer ${secret}`) return res.status(401).json({ error: 'Unauthorized' });

  const token = process.env.META_ACCESS_TOKEN;
  const accountId = process.env.META_AD_ACCOUNT_ID;

  if (!token || !accountId) {
    return res.status(500).json({
      error: 'Faltan variables de entorno en Vercel: META_ACCESS_TOKEN y META_AD_ACCOUNT_ID',
      setup: 'Ve a vercel.com → tu proyecto → Settings → Environment Variables'
    });
  }

  const params = req.method === 'POST' ? req.body : req.query;
  const { action, campaign_id, object_id, date_preset = 'last_7d', budget } = params;
  const actId = `act_${accountId}`;

  try {
    // ── LIST CAMPAIGNS WITH INSIGHTS ──────────────────────────────────────
    if (action === 'campaigns') {
      const insightFields = [
        'spend', 'impressions', 'reach', 'clicks', 'ctr', 'cpm', 'cpc',
        'frequency', 'actions', 'cost_per_action_type'
      ].join(',');

      const fields = [
        'id', 'name', 'status', 'objective', 'daily_budget', 'lifetime_budget',
        `insights.date_preset(${date_preset}){${insightFields}}`
      ].join(',');

      const url = `${META_API}/${actId}/campaigns?fields=${encodeURIComponent(fields)}&access_token=${token}&limit=50&effective_status=["ACTIVE","PAUSED","ARCHIVED"]`;
      const r = await fetch(url);
      const data = await r.json();

      if (!r.ok || data.error) {
        return res.status(400).json({ error: data.error?.message || 'Error Meta API', code: data.error?.code, detail: data });
      }

      const campaigns = (data.data || []).map(c => processCampaign(c));
      return res.status(200).json({ campaigns, date_preset });
    }

    // ── ACCOUNT SUMMARY ───────────────────────────────────────────────────
    if (action === 'account_summary') {
      const insightFields = 'spend,impressions,reach,clicks,actions,cost_per_action_type,cpm,cpc,ctr';
      const since = params.since, until = params.until;
      const timeParam = (since && until)
        ? `time_range=${encodeURIComponent(JSON.stringify({ since, until }))}`
        : `date_preset=${date_preset}`;
      const url = `${META_API}/${actId}/insights?fields=${insightFields}&${timeParam}&access_token=${token}`;
      const r = await fetch(url);
      const data = await r.json();
      if (!r.ok || data.error) return res.status(400).json({ error: data.error?.message || 'Error Meta API' });

      const ins = data.data?.[0] || {};
      return res.status(200).json({
        spend: ins.spend || '0',
        impressions: ins.impressions || '0',
        reach: ins.reach || '0',
        clicks: ins.clicks || '0',
        ctr: ins.ctr || '0',
        cpm: ins.cpm || '0',
        leads: getAction(ins.actions, 'lead'),
        cpl: getCostPerAction(ins.cost_per_action_type, 'lead'),
        date_preset
      });
    }

    // ── LIST ADSETS FOR A CAMPAIGN ─────────────────────────────────────────
    if (action === 'adsets') {
      if (!campaign_id) return res.status(400).json({ error: 'campaign_id requerido' });

      const insightFields = 'spend,impressions,reach,clicks,ctr,cpm,actions,cost_per_action_type';
      const fields = [
        'id', 'name', 'status', 'daily_budget', 'lifetime_budget',
        `insights.date_preset(${date_preset}){${insightFields}}`
      ].join(',');

      const url = `${META_API}/${campaign_id}/adsets?fields=${encodeURIComponent(fields)}&access_token=${token}&limit=50&effective_status=["ACTIVE","PAUSED"]`;
      const r = await fetch(url);
      const data = await r.json();
      if (!r.ok || data.error) return res.status(400).json({ error: data.error?.message || 'Error Meta API' });

      const adsets = (data.data || []).map(s => {
        const ins = s.insights?.data?.[0] || {};
        return {
          id: s.id, name: s.name, status: s.status,
          daily_budget: s.daily_budget ? (parseInt(s.daily_budget) / 100).toFixed(2) : null,
          spend: ins.spend || '0',
          impressions: ins.impressions || '0',
          reach: ins.reach || '0',
          clicks: ins.clicks || '0',
          ctr: ins.ctr || '0',
          cpm: ins.cpm || '0',
          leads: getAction(ins.actions, 'lead'),
          cpl: getCostPerAction(ins.cost_per_action_type, 'lead'),
        };
      });

      return res.status(200).json({ adsets, date_preset });
    }

    // ── PAUSE / ACTIVATE ──────────────────────────────────────────────────
    if (action === 'pause' || action === 'activate') {
      if (!object_id) return res.status(400).json({ error: 'object_id requerido' });
      const newStatus = action === 'pause' ? 'PAUSED' : 'ACTIVE';

      const r = await fetch(`${META_API}/${object_id}?access_token=${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus })
      });
      const data = await r.json();
      if (!r.ok || data.error) return res.status(400).json({ error: data.error?.message || 'Error Meta API' });
      return res.status(200).json({ success: true, object_id, status: newStatus });
    }

    // ── UPDATE DAILY BUDGET (adset or campaign) ───────────────────────────
    if (action === 'set_budget') {
      if (!object_id || !budget) return res.status(400).json({ error: 'object_id y budget requeridos' });
      const budgetCents = Math.round(parseFloat(budget) * 100);
      if (isNaN(budgetCents) || budgetCents < 100) return res.status(400).json({ error: 'Presupuesto inválido (mínimo $1)' });

      const r = await fetch(`${META_API}/${object_id}?access_token=${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ daily_budget: budgetCents })
      });
      const data = await r.json();
      if (!r.ok || data.error) return res.status(400).json({ error: data.error?.message || 'Error Meta API' });
      return res.status(200).json({ success: true, object_id, daily_budget: budget });
    }

    return res.status(400).json({ error: `Acción desconocida: "${action}"` });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

// ── Helpers ────────────────────────────────────────────────────────────────

function processCampaign(c) {
  const ins = c.insights?.data?.[0] || {};
  return {
    id: c.id,
    name: c.name,
    status: c.status,
    objective: c.objective || '',
    daily_budget: c.daily_budget ? (parseInt(c.daily_budget) / 100).toFixed(2) : null,
    lifetime_budget: c.lifetime_budget ? (parseInt(c.lifetime_budget) / 100).toFixed(2) : null,
    spend: ins.spend || '0',
    impressions: ins.impressions || '0',
    reach: ins.reach || '0',
    clicks: ins.clicks || '0',
    ctr: ins.ctr ? parseFloat(ins.ctr).toFixed(2) : '0',
    cpm: ins.cpm ? parseFloat(ins.cpm).toFixed(2) : '0',
    cpc: ins.cpc ? parseFloat(ins.cpc).toFixed(2) : '0',
    frequency: ins.frequency ? parseFloat(ins.frequency).toFixed(2) : '0',
    leads: getAction(ins.actions, 'lead'),
    purchases: getAction(ins.actions, 'purchase'),
    cpl: getCostPerAction(ins.cost_per_action_type, 'lead'),
  };
}

function getAction(actions, type) {
  if (!Array.isArray(actions)) return '0';
  return actions.find(a => a.action_type === type)?.value || '0';
}

function getCostPerAction(costArr, type) {
  if (!Array.isArray(costArr)) return null;
  return costArr.find(a => a.action_type === type)?.value || null;
}
