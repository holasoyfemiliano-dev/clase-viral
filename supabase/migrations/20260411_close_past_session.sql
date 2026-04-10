-- Cierre de sesión pasada: marcar registros no-asistentes como 'no_asistio'
-- Los que asistieron ya fueron marcados como 'asistio' por zoom-sync.
-- Este script mueve todos los que quedaron en estados pre-sesión a 'no_asistio'.

-- 1. Actualizar lead_estados existentes que quedaron en estados pre-sesión
UPDATE lead_estados
SET estado = 'no_asistio', updated_at = NOW()
WHERE estado IN ('por_confirmar', 'pendiente_confirmar', 'confirmado', 'no_asistira')
  AND registro_email IN (SELECT email FROM clase_viral_registros);

-- 2. Insertar 'no_asistio' para registros que nunca tuvieron lead_estado
INSERT INTO lead_estados (registro_email, vendedor, estado, updated_at)
SELECT r.email, '', 'no_asistio', NOW()
FROM clase_viral_registros r
LEFT JOIN lead_estados l ON l.registro_email = r.email
WHERE l.registro_email IS NULL;
