-- RLS para lead_estados
-- Tabla interna de seguimiento de ventas — nunca debe ser accesible públicamente.
-- Solo el service role (APIs del servidor) puede leer/escribir.

ALTER TABLE lead_estados ENABLE ROW LEVEL SECURITY;

-- Solo service role tiene acceso total (zoom-sync, auto-sync, dashboard proxy)
CREATE POLICY "service_role_only"
  ON lead_estados
  FOR ALL
  USING (auth.role() = 'service_role');
