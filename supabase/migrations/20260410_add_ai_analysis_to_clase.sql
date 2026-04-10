-- Add pre-computed AI analysis column to clase_analisis
-- This lets the webhook compute it once after class ends, so the dashboard never calls Claude
ALTER TABLE clase_analisis
  ADD COLUMN IF NOT EXISTS ai_analysis jsonb;
