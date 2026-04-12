-- Agregar flag de administrador a vendedores
-- Los admins ven TODOS los leads en el portal, sin filtro de asignación
ALTER TABLE vendedores ADD COLUMN IF NOT EXISTS es_admin BOOLEAN DEFAULT FALSE;

-- Marcar a Femiliano como admin
UPDATE vendedores SET es_admin = TRUE WHERE nombre = 'Femiliano';
