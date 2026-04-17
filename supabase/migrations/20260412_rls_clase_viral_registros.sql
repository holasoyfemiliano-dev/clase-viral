-- RLS para clase_viral_registros
-- Cualquier persona puede registrarse (INSERT público)
-- Solo usuarios autenticados (dashboard / service role) pueden leer o modificar

ALTER TABLE clase_viral_registros ENABLE ROW LEVEL SECURITY;

-- Cualquiera puede registrarse desde el landing
CREATE POLICY "insert_public"
  ON clase_viral_registros
  FOR INSERT
  WITH CHECK (true);

-- Solo autenticados pueden leer
CREATE POLICY "select_authenticated"
  ON clase_viral_registros
  FOR SELECT
  USING (auth.role() = 'authenticated');

-- Solo service role puede actualizar o borrar (operaciones internas)
CREATE POLICY "modify_service_role"
  ON clase_viral_registros
  FOR ALL
  USING (auth.role() = 'service_role');
