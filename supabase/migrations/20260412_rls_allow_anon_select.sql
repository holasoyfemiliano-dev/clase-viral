-- Permitir al portal de vendedores (usa clave anon) leer registros
-- El portal está protegido por contraseña internamente, así que esto es seguro
CREATE POLICY IF NOT EXISTS "select_anon"
  ON clase_viral_registros
  FOR SELECT
  USING (auth.role() = 'anon');
