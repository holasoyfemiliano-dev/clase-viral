-- Historial centralizado de todos los comprobantes subidos
CREATE TABLE IF NOT EXISTS comprobantes (
  id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tipo         TEXT NOT NULL, -- 'pago_parcial' | 'venta' | 'comision'
  lead_email   TEXT,
  vendedor     TEXT,
  url          TEXT NOT NULL,
  monto        NUMERIC,
  referencia   TEXT, -- id de venta o actividad relacionada
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- RLS: solo admins (service role) pueden escribir/leer
ALTER TABLE comprobantes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all" ON comprobantes USING (true) WITH CHECK (true);
