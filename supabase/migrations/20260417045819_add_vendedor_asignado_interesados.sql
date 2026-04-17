alter table proximity_creators_interesados
  add column if not exists vendedor_asignado text;

create policy "update_authenticated" on proximity_creators_interesados
  for update using (true) with check (true);
