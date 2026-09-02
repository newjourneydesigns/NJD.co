-- ---------------------------------------------------------------------------
-- Just enough Supabase to run supabase/schema.sql on a bare Postgres.
--
--   tools/portal/schema-check.sh
--
-- Everything the schema leans on that Supabase provides and stock Postgres does
-- not: the two roles its grants name, the auth schema its profiles hang off,
-- the storage tables its bucket policies attach to, and auth.uid().
--
-- This is a test harness, not a description of production. It exists so that a
-- change to the schema can be run — twice, to prove it is idempotent — before
-- it reaches the live database, which is the only database the studio has.
-- Nothing here is deployed anywhere.
-- ---------------------------------------------------------------------------

create extension if not exists pgcrypto;

do $$ begin create role anon nologin;          exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin;  exception when duplicate_object then null; end $$;

create schema if not exists auth;
create schema if not exists storage;
create schema if not exists extensions;

-- The columns schema.sql actually reads or writes: the bootstrap admin block,
-- handle_new_user()'s trigger source, and the profiles foreign key.
create table if not exists auth.users (
  id                 uuid primary key default gen_random_uuid(),
  email              text unique,
  encrypted_password text,
  email_confirmed_at timestamptz,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  raw_app_meta_data  jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- In production this reads the JWT. Here it reads a session setting, which is
-- what lets a test say "now be this person" — see schema-check.sql.
create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

create table if not exists storage.buckets (
  id                 text primary key,
  name               text not null,
  public             boolean not null default false,
  file_size_limit    bigint,
  allowed_mime_types text[],
  created_at         timestamptz not null default now()
);

create table if not exists storage.objects (
  id         uuid primary key default gen_random_uuid(),
  bucket_id  text references storage.buckets (id),
  name       text,
  owner      uuid,
  created_at timestamptz not null default now()
);

alter table storage.objects enable row level security;

-- schema.sql adds tables to this publication.
do $$ begin
  create publication supabase_realtime;
exception when duplicate_object then null; end $$;
