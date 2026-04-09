create table if not exists proximity_creators_interesados (
  id          bigserial primary key,
  nombre      text not null,
  email       text not null,
  phone       text,
  created_at  timestamptz default now()
);

alter table proximity_creators_interesados enable row level security;

create policy "insert_public" on proximity_creators_interesados
  for insert with check (true);

create policy "select_authenticated" on proximity_creators_interesados
  for select using (auth.role() = 'authenticated');
