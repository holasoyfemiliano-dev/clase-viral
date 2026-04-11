-- Agregar columna aprobado a vendedor_actividad para flujo de aprobación de pagos parciales
ALTER TABLE vendedor_actividad ADD COLUMN IF NOT EXISTS aprobado BOOLEAN DEFAULT FALSE;
ALTER TABLE vendedor_actividad ADD COLUMN IF NOT EXISTS aprobado_por TEXT;
ALTER TABLE vendedor_actividad ADD COLUMN IF NOT EXISTS aprobado_at TIMESTAMPTZ;
