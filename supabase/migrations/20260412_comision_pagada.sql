-- Rastrear si la comisión de una venta ya fue pagada al vendedor
ALTER TABLE ventas ADD COLUMN IF NOT EXISTS comision_pagada BOOLEAN DEFAULT FALSE;
ALTER TABLE ventas ADD COLUMN IF NOT EXISTS comision_pagada_at TIMESTAMPTZ;
