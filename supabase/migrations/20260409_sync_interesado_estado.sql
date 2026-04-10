-- Auto-sync: when someone hits the payment page (proximity_creators_interesados),
-- if their email is a registered lead (clase_viral_registros),
-- upsert lead_estados to 'interesado' — but don't downgrade higher estados.

CREATE OR REPLACE FUNCTION sync_interesado_estado()
RETURNS TRIGGER AS $$
BEGIN
  -- Only act if the email is a registered lead
  IF EXISTS (SELECT 1 FROM clase_viral_registros WHERE email = NEW.email) THEN
    INSERT INTO lead_estados (registro_email, vendedor, estado, updated_at)
    VALUES (NEW.email, '', 'interesado', NOW())
    ON CONFLICT (registro_email) DO UPDATE
      SET estado = 'interesado', updated_at = NOW()
      -- Don't downgrade if already at a higher-intent state
      WHERE lead_estados.estado NOT IN (
        'compro_evento', 'seguimiento', 'seguimiento_exitoso'
      );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Drop if exists to allow re-runs
DROP TRIGGER IF EXISTS on_interesado_insert ON proximity_creators_interesados;

CREATE TRIGGER on_interesado_insert
  AFTER INSERT ON proximity_creators_interesados
  FOR EACH ROW EXECUTE FUNCTION sync_interesado_estado();

-- Backfill: apply to all existing interesados right now
INSERT INTO lead_estados (registro_email, vendedor, estado, updated_at)
SELECT i.email, '', 'interesado', NOW()
FROM proximity_creators_interesados i
WHERE EXISTS (SELECT 1 FROM clase_viral_registros r WHERE r.email = i.email)
ON CONFLICT (registro_email) DO UPDATE
  SET estado = 'interesado', updated_at = NOW()
  WHERE lead_estados.estado NOT IN (
    'compro_evento', 'seguimiento', 'seguimiento_exitoso'
  );
