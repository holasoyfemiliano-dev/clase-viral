-- Prevenir registros duplicados por email en clase_viral_registros
-- Paso 1: eliminar duplicados existentes (conservar el registro más antiguo por email)
DELETE FROM clase_viral_registros
WHERE id NOT IN (
  SELECT MIN(id)
  FROM clase_viral_registros
  GROUP BY LOWER(email)
);

-- Paso 2: agregar constraint único en email (case-insensitive via índice funcional)
CREATE UNIQUE INDEX IF NOT EXISTS uq_registros_email
  ON clase_viral_registros (LOWER(email));
