create extension if not exists "uuid-ossp";

-- BOOKS
create table if not exists public.books (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  book_type text not null default 'physical' check (book_type in ('physical', 'audiobook')),
  total_pages int check (total_pages > 0),
  current_page int not null default 0 check (current_page >= 0),
  total_chapters int check (total_chapters > 0),
  current_chapter int not null default 0 check (current_chapter >= 0),
  start_date date not null default current_date,
  due_date date,
  reading_days boolean[] not null check (array_length(reading_days,1) = 7),
  status text not null default 'active' check (status in ('active','completed')),
  inserted_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint books_physical_pages_check check (
    (book_type = 'physical' and total_pages is not null) or 
    (book_type = 'audiobook' and total_chapters is not null)
  )
);

-- SESSIONS
create table if not exists public.sessions (
  id uuid primary key default gen_random_uuid(),
  book_id uuid not null references public.books(id) on delete cascade,
  date date not null default current_date,
  start_page int,
  end_page int,
  pages_read int,
  chapter int,
  minutes_listened int,
  notes text
);

-- Trigger for updated_at
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;

drop trigger if exists trg_books_updated_at on public.books;
create trigger trg_books_updated_at
before update on public.books
for each row execute function public.set_updated_at();

-- RLS
alter table public.books enable row level security;
alter table public.sessions enable row level security;

-- Book policies
drop policy if exists "Books readable by owner" on public.books;
drop policy if exists "Books insertable by owner" on public.books;
drop policy if exists "Books updatable by owner" on public.books;
drop policy if exists "Books deletable by owner" on public.books;

create policy "Books readable by owner" on public.books
  for select using (auth.uid() = user_id);
create policy "Books insertable by owner" on public.books
  for insert with check (auth.uid() = user_id);
create policy "Books updatable by owner" on public.books
  for update using (auth.uid() = user_id);
create policy "Books deletable by owner" on public.books
  for delete using (auth.uid() = user_id);

-- Session policies
drop policy if exists "Sessions readable if book belongs to user" on public.sessions;
drop policy if exists "Sessions insertable if book belongs to user" on public.sessions;
drop policy if exists "Sessions updatable if book belongs to user" on public.sessions;
drop policy if exists "Sessions deletable if book belongs to user" on public.sessions;

create policy "Sessions readable if book belongs to user" on public.sessions
  for select using (exists (select 1 from books b where b.id = sessions.book_id and b.user_id = auth.uid()));
create policy "Sessions insertable if book belongs to user" on public.sessions
  for insert with check (exists (select 1 from books b where b.id = sessions.book_id and b.user_id = auth.uid()));
create policy "Sessions updatable if book belongs to user" on public.sessions
  for update using (exists (select 1 from books b where b.id = sessions.book_id and b.user_id = auth.uid()));
create policy "Sessions deletable if book belongs to user" on public.sessions
  for delete using (exists (select 1 from books b where b.id = sessions.book_id and b.user_id = auth.uid()));