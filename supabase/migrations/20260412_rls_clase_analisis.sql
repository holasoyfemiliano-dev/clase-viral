-- RLS para clase_analisis
-- Tabla interna con análisis de clases (transcripciones, retención, IA).
-- Datos sensibles — solo service role tiene acceso.

ALTER TABLE clase_analisis ENABLE ROW LEVEL SECURITY;

-- Solo service role tiene acceso total (zoom-webhook, zoom-transcript, dashboard proxy)
CREATE POLICY "service_role_only"
  ON clase_analisis
  FOR ALL
  USING (auth.role() = 'service_role');
