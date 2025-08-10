-- ==== EXTENSIONS (safe to run multiple times) ===============================
create extension if not exists "pgcrypto";  -- dla gen_random_uuid()
create extension if not exists "pg_trgm";   -- dla indeksu trigramowego

-- ==== TABELA =================================================================
create table if not exists public.flashcards (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  front      text not null,
  back       text not null,
  created_at timestamptz not null default now()
);

-- ==== RLS ====================================================================
alter table public.flashcards enable row level security;

-- (opcjonalnie) wyczyść stare polityki, jeśli istnieją – dzięki temu skrypt
-- zadziała nawet, gdy odpalisz go ponownie.
drop policy if exists "Read own cards"   on public.flashcards;
drop policy if exists "Insert own cards" on public.flashcards;
drop policy if exists "Update own cards" on public.flashcards;
drop policy if exists "Delete own cards" on public.flashcards;

-- Użytkownik może czytać TYLKO swoje fiszki
create policy "Read own cards"
  on public.flashcards
  for select
  using (auth.uid() = user_id);

-- Użytkownik może dodawać TYLKO swoje fiszki
create policy "Insert own cards"
  on public.flashcards
  for insert
  with check (auth.uid() = user_id);

-- Użytkownik może aktualizować TYLKO swoje fiszki
create policy "Update own cards"
  on public.flashcards
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Użytkownik może usuwać TYLKO swoje fiszki
create policy "Delete own cards"
  on public.flashcards
  for delete
  using (auth.uid() = user_id);

-- ==== INDEKS (opcjonalny, przyspiesza wyszukiwanie po 'front') ===============
create index if not exists flashcards_front_trgm
  on public.flashcards
  using gin (front gin_trgm_ops);
