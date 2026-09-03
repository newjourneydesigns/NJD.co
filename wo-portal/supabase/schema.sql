-- ===========================================================================
-- Walter Ochenski LLC — Portal schema
--
-- Applied to the Supabase project WO-PORTAL. Idempotent: re-running it is
-- safe and does nothing the second time. This file is the source of truth for
-- the database; any DDL run on the live project goes into this file in the
-- same piece of work.
--
-- Security model
-- --------------
-- Every table has Row Level Security enabled. The browser only ever holds the
-- publishable key, so authorization is enforced here in Postgres, not in
-- JavaScript. There are no client logins: every row belongs to the business.
--
--   owner   the proprietor. Everything below, plus creating and removing the
--           portal's sign-ins (through the admin-users function) and the
--           business details.
--   staff   the bookkeeper. Everything about clients, invoices, payments,
--           expenses, receipts and documents. Cannot manage sign-ins.
--   none    a signed-in account with no invite behind it. Sees nothing. This
--           is the default a stray sign-up lands on, and it is what makes
--           "Allow new users to sign up" a nuisance rather than a breach.
--
-- The helper functions are SECURITY DEFINER so that reading a user's own role
-- does not re-trigger the policies that depend on it.
-- ===========================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Enumerated types
-- ---------------------------------------------------------------------------

do $$ begin
  create type user_role as enum ('owner', 'staff', 'none');
exception when duplicate_object then null; end $$;

do $$ begin
  create type client_status as enum ('lead', 'active', 'past');
exception when duplicate_object then null; end $$;

-- draft   being written; editable; deletable
-- issued  frozen with a snapshot; the PDF exists
-- sent    the owner has handed it to the client (set by hand)
-- paid    payments recorded against it cover the total (set by trigger)
-- void    cancelled; never deleted, because the number was used
do $$ begin
  create type invoice_status as enum ('draft', 'issued', 'sent', 'paid', 'void');
exception when duplicate_object then null; end $$;

-- How money moved, in either direction.
do $$ begin
  create type payment_method as enum ('ach', 'check', 'zelle', 'card', 'cash', 'other');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

-- The client record. `name` is what the business calls them; `legal_name` is
-- what prints in the "Billed to" block when it differs.
create table if not exists clients (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  legal_name    text,
  contact_name  text,
  contact_email text,
  contact_phone text,
  website       text,
  address_line1 text,
  address_line2 text,
  city          text,
  region        text,
  postal_code   text,
  country       text,
  status        client_status not null default 'active',
  notes         text,
  -- A negotiated hourly rate, in cents. Null means the business's standard
  -- rate (studio_settings.hourly_rate_cents) on the day the line is written.
  hourly_rate_cents integer,
  -- Payment terms for this client, in days. Null means the standard terms
  -- (invoice_settings.net_days). Most clients are Net 15, some are Net 30.
  net_days      integer,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint clients_hourly_rate_positive
    check (hourly_rate_cents is null or hourly_rate_cents > 0),
  constraint clients_net_days_range
    check (net_days is null or (net_days >= 0 and net_days <= 365))
);

-- One row per sign-in, created automatically by the trigger at the bottom of
-- this file. `email` mirrors auth.users.email; for a bare username it is the
-- synthetic address the portal maps the handle to, and nothing ever mails it.
create table if not exists profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  email      text,
  full_name  text,
  role       user_role not null default 'none',
  phone      text,
  created_at timestamptz not null default now()
);

-- An invite is what turns a fresh auth.users row into a profile with a role.
-- admin-users.js writes the invite first and creates the auth user second;
-- handle_new_user() consumes it on the insert.
create table if not exists invites (
  id          uuid primary key default gen_random_uuid(),
  email       text not null,
  role        user_role not null default 'staff',
  invited_by  uuid references profiles (id) on delete set null,
  consumed_at timestamptz,
  created_at  timestamptz not null default now()
);

create unique index if not exists invites_pending_email_idx
  on invites (lower(email)) where consumed_at is null;

create table if not exists client_contacts (
  id         uuid primary key default gen_random_uuid(),
  client_id  uuid not null references clients (id) on delete cascade,
  name       text not null,
  title      text,
  email      text,
  phone      text,
  position   integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists client_contacts_client_id_idx
  on client_contacts (client_id, position);

-- The communication log. Plain text, editable; the UI says "edited" when
-- updated_at differs from created_at.
create table if not exists client_notes (
  id         uuid primary key default gen_random_uuid(),
  client_id  uuid not null references clients (id) on delete cascade,
  body       text not null,
  author_id  uuid references profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists client_notes_client_id_idx
  on client_notes (client_id, created_at desc);

-- The business's own details: the letterhead, and the rates. One row, keyed
-- on a boolean so there can only ever be one.
create table if not exists studio_settings (
  id             boolean primary key default true,
  business_name  text not null default 'Walter Ochenski LLC',
  -- Printed under the name on documents when set, e.g. 'A Texas limited
  -- liability company'. Blank until the owner wants it.
  entity_line    text not null default '',
  address_line1  text not null default '2001 Creekdale Drive',
  address_line2  text not null default '',
  city           text not null default 'Denton',
  region         text not null default 'Texas',
  postal_code    text not null default '76210',
  phone          text not null default '(972) 467-5988',
  email          text not null default 'tripochinski@gmail.com',
  website        text not null default '',
  -- Who a check is made out to. Prints in the how-to-pay block.
  payee_name     text not null default 'Walter Ochenski',
  -- The standard hourly rate, in cents. Null until the owner sets one; the
  -- "Bill hours" shortcut refuses to price a line while it is null rather
  -- than quietly writing $0.00 an hour.
  hourly_rate_cents integer,
  -- The 1099-NEC reporting threshold, in cents. $2,000 for payments made in
  -- 2026 onward (indexed after that); it was $600 before. Editable so the
  -- January report follows the law of the year rather than a constant.
  nec_threshold_cents integer not null default 200000,
  updated_at     timestamptz not null default now(),
  constraint studio_settings_singleton check (id),
  constraint studio_settings_hourly_rate_positive
    check (hourly_rate_cents is null or hourly_rate_cents > 0)
);

insert into studio_settings (id) values (true) on conflict (id) do nothing;

-- How invoices are worded and when they fall due. One row, same pattern.
create table if not exists invoice_settings (
  id              boolean primary key default true,
  -- How to actually pay. Free text, printed on every invoice. The owner adds
  -- ACH details here from the Admin page; they are never in this file.
  payment_details text not null default
    'Checks payable to Walter Ochenski, or direct ACH — bank details on request.',
  -- Fills the due date when an invoice is raised, unless the client has
  -- terms of their own. Always editable afterwards on the invoice.
  net_days        integer not null default 15,
  late_note       text,
  -- Sales tax. Off by default. Rate in basis points so 8.25% is 825 and no
  -- float ever touches it. Copied onto each invoice at creation, so a later
  -- change never restates an invoice already sent.
  tax_rate_bp     integer not null default 0
    check (tax_rate_bp >= 0 and tax_rate_bp <= 10000),
  tax_label       text not null default 'Sales tax',
  -- The permit number, printed on the document when tax is charged.
  tax_registration text,
  updated_at      timestamptz not null default now(),
  constraint invoice_settings_singleton check (id),
  constraint invoice_settings_net_days_range check (net_days >= 0 and net_days <= 365)
);

insert into invoice_settings (id) values (true) on conflict (id) do nothing;

-- Invoices.
--
-- The number is the date the invoice was created followed by that day's
-- sequence: 20260901-1, 20260901-2, 20260902-1. Assigned by create_invoice()
-- under a lock so two tabs cannot mint the same one; editable afterwards but
-- must keep the shape, and must stay unique.
create table if not exists invoices (
  id            uuid primary key default gen_random_uuid(),
  -- restrict: an issued invoice is a business record with a seven-year life,
  -- and deleting the client out from under it should be a deliberate act.
  client_id     uuid not null references clients (id) on delete restrict,
  number        text not null,
  status        invoice_status not null default 'draft',

  issued_on     date,
  due_on        date,
  -- The terms the due date was computed from, so the document can print
  -- "Net 15" and stay right when the settings change.
  net_days      integer not null default 15,

  project_name   text not null default '',
  purchase_order text,
  summary       text,
  notes         text,

  -- Computed from the line items and written back on every save, so the list
  -- can total and sort without reading every line of every invoice.
  subtotal_cents integer not null default 0,
  tax_rate_bp    integer not null default 0,
  tax_cents      integer not null default 0,
  -- Maintained by refresh_invoice_payment() from the payments table.
  paid_cents     integer not null default 0,
  total_cents    integer not null default 0,
  currency       text not null default 'usd',
  paid_at       timestamptz,

  -- Set the first time the invoice is issued, and what makes it immutable from
  -- then on: a client is holding a copy, so the record behind it cannot move.
  issued_at     timestamptz,
  snapshot      jsonb,
  snapshot_hash text,

  created_by    uuid references profiles (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint invoices_number_shape check (number ~ '^[0-9]{8}-[0-9]+$')
);

create unique index if not exists invoices_number_idx on invoices (number);
create index if not exists invoices_client_idx on invoices (client_id, created_at desc);
create index if not exists invoices_status_idx on invoices (status, created_at desc);

-- The line items. quantity and unit price are separate from the amount because
-- both kinds of line are real: a flat fee is one line, and six hours at a rate
-- is a calculation the client is entitled to see. amount_cents is stored so a
-- rounding decision made once at save time is the one that prints.
create table if not exists invoice_items (
  id           uuid primary key default gen_random_uuid(),
  invoice_id   uuid not null references invoices (id) on delete cascade,
  name         text not null,
  description  text,
  quantity     numeric not null default 1,
  unit_cents   integer not null default 0,
  amount_cents integer not null default 0,
  taxable      boolean not null default false,
  position     integer not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists invoice_items_invoice_idx on invoice_items (invoice_id, position);

-- Money that came in. Always against an issued invoice: gross receipts for
-- the year are the sum of this table, so a payment with no document behind
-- it would be income the reports could not explain.
create table if not exists payments (
  id           uuid primary key default gen_random_uuid(),
  invoice_id   uuid not null references invoices (id) on delete restrict,
  client_id    uuid not null references clients (id) on delete restrict,
  received_on  date not null default current_date,
  -- Signed, so a refund is a payment of a negative amount.
  amount_cents integer not null,
  method       payment_method not null default 'ach',
  reference    text,
  notes        text,
  created_by   uuid references profiles (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint payments_amount_nonzero check (amount_cents <> 0)
);

create index if not exists payments_invoice_idx on payments (invoice_id, received_on);
create index if not exists payments_client_idx on payments (client_id, received_on desc);
create index if not exists payments_received_idx on payments (received_on desc);

-- What an expense is for. Each category names the Schedule C line it rolls
-- up to, so the tax-year report is a grouping rather than a mapping exercise
-- in April. Editable from Admin; the seed below is a starting list.
create table if not exists expense_categories (
  id                   uuid primary key default gen_random_uuid(),
  code                 text not null unique,
  name                 text not null,
  -- Part II of Schedule C: '8' Advertising, '9' Car and truck, '11' Contract
  -- labor, '15' Insurance, '17' Legal and professional, '18' Office, '22'
  -- Supplies, '24a' Travel, '24b' Meals, '27a' Other.
  schedule_c_line      text not null default '27a',
  description          text not null default '',
  -- Publication 463 wants the where, why and who for meals, travel, gifts
  -- and vehicle use. These flags are what the expense form asks for.
  needs_substantiation boolean not null default false,
  needs_attendees      boolean not null default false,
  -- Business meals are deductible at 50%. The report shows the full amount
  -- and the deductible half side by side.
  half_deductible      boolean not null default false,
  position             integer not null default 0,
  archived_at          timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- Who the business pays. Light on purpose: it exists so "what did we spend at
-- Adobe this year" has an answer, and so the January 1099-NEC filing is a
-- report rather than a memory test.
create table if not exists vendors (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  email        text,
  phone        text,
  website      text,
  address      text,
  -- files_1099 is "does this one need a form"; tax_id_on_file is "can we
  -- actually produce it". A contractor flagged for a 1099 whose W-9 was never
  -- collected is the situation worth seeing in November, not January.
  files_1099   boolean not null default false,
  tax_id_on_file boolean not null default false,
  default_category_id uuid references expense_categories (id) on delete set null,
  notes        text,
  archived_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create unique index if not exists vendors_name_idx on vendors (lower(name));

-- Money that went out. Recorded when it is paid, on a cash basis.
create table if not exists expenses (
  id            uuid primary key default gen_random_uuid(),
  spent_on      date not null default current_date,
  vendor_id     uuid references vendors (id) on delete set null,
  -- For the one-off nobody will ever buy from again.
  vendor_name   text,
  category_id   uuid not null references expense_categories (id) on delete restrict,
  -- Signed: a refund from a supplier is a negative expense.
  amount_cents  integer not null,
  description   text,
  method        payment_method not null default 'card',
  reference     text,
  -- Job costing. A licence bought for one client is that client's cost;
  -- billable marks the ones meant to be passed on, billed_invoice_id is what
  -- stops one being passed on twice.
  client_id     uuid references clients (id) on delete set null,
  billable      boolean not null default false,
  billed_invoice_id uuid references invoices (id) on delete set null,
  -- Substantiation: the where, why and who. Free text on purpose.
  place            text,
  business_purpose text,
  attendees        text,
  created_by    uuid references profiles (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint expenses_amount_nonzero check (amount_cents <> 0)
);

create index if not exists expenses_spent_idx on expenses (spent_on desc);
create index if not exists expenses_vendor_idx on expenses (vendor_id) where vendor_id is not null;
create index if not exists expenses_category_idx on expenses (category_id, spent_on desc);
create index if not exists expenses_client_idx on expenses (client_id) where client_id is not null;
-- What "bill this back" asks for.
create index if not exists expenses_billable_idx
  on expenses (client_id, spent_on) where billable and billed_invoice_id is null;

-- The receipt itself. Its own table because one expense routinely has more
-- than one photograph. thumb_path is a small version made in the browser.
create table if not exists expense_receipts (
  id           uuid primary key default gen_random_uuid(),
  expense_id   uuid not null references expenses (id) on delete cascade,
  -- <expense_id>/<uuid>-<filename> in the private expense-receipts bucket.
  storage_path text not null,
  thumb_path   text,
  name         text not null,
  size_bytes   bigint,
  mime_type    text,
  captured_on  date,
  position     integer not null default 0,
  uploaded_by  uuid references profiles (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists expense_receipts_expense_idx
  on expense_receipts (expense_id, position);
create unique index if not exists expense_receipts_path_idx
  on expense_receipts (storage_path);

-- Subscriptions and licences: the charges that land every month. A template,
-- recorded as an ordinary expense one month at a time from the Expenses page;
-- never cron-driven.
create table if not exists recurring_expenses (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  vendor_id     uuid references vendors (id) on delete set null,
  vendor_name   text,
  category_id   uuid not null references expense_categories (id) on delete restrict,
  amount_cents  integer not null,
  method        payment_method not null default 'card',
  -- The day the charge lands. Clamped to the month's length when recorded.
  day_of_month  integer not null default 1
    check (day_of_month between 1 and 31),
  client_id     uuid references clients (id) on delete set null,
  billable      boolean not null default false,
  active        boolean not null default true,
  -- The last month actually recorded, as the date it was recorded for.
  last_recorded_on date,
  created_by    uuid references profiles (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint recurring_expenses_amount check (amount_cents <> 0)
);

create index if not exists recurring_expenses_active_idx
  on recurring_expenses (active, day_of_month);

-- Documents filed against a client: anything the business wants to keep with
-- the record. Bytes live in the private client-documents bucket under
-- <client_id>/<uuid>-<filename>; this is the index of them.
create table if not exists documents (
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid not null references clients (id) on delete cascade,
  name         text not null,
  storage_path text not null unique,
  label        text,
  size_bytes   bigint,
  mime_type    text,
  uploaded_by  uuid references profiles (id) on delete set null,
  created_at   timestamptz not null default now()
);

create index if not exists documents_client_id_idx
  on documents (client_id, created_at desc);

-- What R2 did.
--
-- R2 is the portal's AI operator: a sign-in like any other (see CLAUDE.md),
-- which is exactly why this table exists. An assistant that can raise an
-- invoice and set a password is one whose work has to be answerable in the
-- same way a person's is, and "what has it been doing" must be a query rather
-- than a matter of trust or recollection.
--
-- Insert-only by construction: there is no update policy and no delete
-- policy, so a row cannot be edited or removed by anybody reaching the
-- database through the portal's key — including R2 itself. A log its author
-- can quietly rewrite is not a log.
--
-- One row per batch of work, not per statement. `action` is a short slug
-- ('raise-invoice', 'record-expenses', 'add-client'); `detail` is whatever
-- makes the row answerable later — which rows, and why.
create table if not exists activity_log (
  id         uuid primary key default gen_random_uuid(),
  actor_id   uuid references profiles (id) on delete set null,
  action     text not null,
  detail     jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint activity_log_action_shape check (action <> '' and length(action) <= 80)
);

create index if not exists activity_log_created_idx
  on activity_log (created_at desc);

-- Which seed blocks have run. RLS on with no policies so nobody but this file
-- can see or touch it.
create table if not exists seeds_applied (
  key        text primary key,
  applied_at timestamptz not null default now()
);

alter table seeds_applied enable row level security;

-- ---------------------------------------------------------------------------
-- updated_at
-- ---------------------------------------------------------------------------

create or replace function set_updated_at() returns trigger
language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['clients', 'client_contacts', 'client_notes',
                           'studio_settings', 'invoice_settings',
                           'invoices', 'invoice_items', 'payments',
                           'expense_categories', 'vendors', 'expenses',
                           'expense_receipts', 'recurring_expenses'] loop
    execute format('drop trigger if exists %I_set_updated_at on %I', t, t);
    execute format(
      'create trigger %I_set_updated_at before update on %I
         for each row execute function set_updated_at()', t, t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Table privileges
--
-- Spelled out so it is obvious that `anon` — an unauthenticated visitor — is
-- granted nothing at all. Row Level Security is what narrows these grants to
-- the caller's role.
-- ---------------------------------------------------------------------------

grant usage on schema public to authenticated;

grant select, insert, update, delete on
  clients, profiles, invites, client_contacts, client_notes,
  studio_settings, invoice_settings, invoices, invoice_items, payments,
  expense_categories, vendors, expenses, expense_receipts,
  recurring_expenses, documents
  to authenticated;

-- Written once and read forever: no UPDATE, no DELETE, for anyone. The policy
-- below narrows the read to staff; this is what stops the row being edited
-- even by the account that wrote it.
revoke all on table activity_log from authenticated;
grant select, insert on activity_log to authenticated;

revoke all on table
  clients, profiles, invites, client_contacts, client_notes,
  studio_settings, invoice_settings, invoices, invoice_items, payments,
  expense_categories, vendors, expenses, expense_receipts,
  recurring_expenses, documents, activity_log, seeds_applied
  from anon;

-- ---------------------------------------------------------------------------
-- Authorization helpers
--
-- SECURITY DEFINER + a pinned search_path: these read profiles without being
-- subject to the profiles policies, which is what keeps the policies below
-- from recursing into themselves.
-- ---------------------------------------------------------------------------

create or replace function current_role_name() returns user_role
language sql stable security definer set search_path = public as $$
  select role from profiles where id = auth.uid()
$$;

-- "Is staff": the owner or the bookkeeper. Named is_admin because that is
-- what every policy and every page asks; the two roles differ only in what
-- is_owner() gates.
create or replace function is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(current_role_name() in ('owner', 'staff'), false)
$$;

create or replace function is_owner() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(current_role_name() = 'owner', false)
$$;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table clients            enable row level security;
alter table profiles           enable row level security;
alter table invites            enable row level security;
alter table client_contacts    enable row level security;
alter table client_notes       enable row level security;
alter table studio_settings    enable row level security;
alter table invoice_settings   enable row level security;
alter table invoices           enable row level security;
alter table invoice_items      enable row level security;
alter table payments           enable row level security;
alter table expense_categories enable row level security;
alter table vendors            enable row level security;
alter table expenses           enable row level security;
alter table expense_receipts   enable row level security;
alter table recurring_expenses enable row level security;
alter table documents          enable row level security;
alter table activity_log       enable row level security;

-- The safety net for a table added later: RLS goes on for any table created
-- in `public` from now on, whether by this file, a migration, or the
-- dashboard at eleven at night. RLS with no policy denies everything, so the
-- worst an auto-enabled table can do is return nothing until it gets one.
create or replace function rls_auto_enable() returns event_trigger
language plpgsql security definer set search_path = pg_catalog as $$
declare
  cmd record;
begin
  for cmd in
    select *
      from pg_event_trigger_ddl_commands()
     where command_tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
       and object_type in ('table', 'partitioned table')
  loop
    if cmd.schema_name = 'public' then
      begin
        execute format('alter table if exists %s enable row level security', cmd.object_identity);
        raise log 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      exception when others then
        raise log 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      end;
    end if;
  end loop;
end $$;

do $$ begin
  create event trigger ensure_rls on ddl_command_end execute function rls_auto_enable();
exception
  when duplicate_object then null;
  when insufficient_privilege then
    raise notice 'Could not create the ensure_rls event trigger: not enough rights. '
                 'Every table in this file still enables RLS explicitly.';
end $$;

-- profiles ------------------------------------------------------------------

-- Staff see every profile (there are two of them); anyone sees their own.
drop policy if exists profiles_select on profiles;
create policy profiles_select on profiles for select to authenticated
  using (id = auth.uid() or is_admin());

-- Your own name and phone are yours to edit. The guard trigger below is what
-- stops the role moving in the same statement.
drop policy if exists profiles_update_self on profiles;
create policy profiles_update_self on profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists profiles_owner_write on profiles;
create policy profiles_owner_write on profiles for all to authenticated
  using (is_owner()) with check (is_owner());

-- RLS cannot restrict individual columns, so a trigger stops a person from
-- promoting themselves while editing their own display name. A null
-- auth.uid() is the SQL editor, a migration, or the service role: trusted.
create or replace function guard_profile_privileges() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not is_owner() then
    if new.role is distinct from old.role then
      raise exception 'Only the owner can change a role';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists profiles_guard_privileges on profiles;
create trigger profiles_guard_privileges before update on profiles
  for each row execute function guard_profile_privileges();

-- invites: the owner's, in both directions ---------------------------------

drop policy if exists invites_owner_all on invites;
create policy invites_owner_all on invites for all to authenticated
  using (is_owner()) with check (is_owner());

-- everything else: staff, in both directions -------------------------------

drop policy if exists clients_admin_all on clients;
create policy clients_admin_all on clients for all to authenticated
  using (is_admin()) with check (is_admin());

drop policy if exists client_contacts_admin_all on client_contacts;
create policy client_contacts_admin_all on client_contacts for all to authenticated
  using (is_admin()) with check (is_admin());

drop policy if exists client_notes_admin_all on client_notes;
create policy client_notes_admin_all on client_notes for all to authenticated
  using (is_admin()) with check (is_admin());

drop policy if exists studio_settings_admin_all on studio_settings;
create policy studio_settings_admin_all on studio_settings for all to authenticated
  using (is_admin()) with check (is_admin());

drop policy if exists invoice_settings_admin_all on invoice_settings;
create policy invoice_settings_admin_all on invoice_settings for all to authenticated
  using (is_admin()) with check (is_admin());

drop policy if exists invoices_admin_all on invoices;
create policy invoices_admin_all on invoices for all to authenticated
  using (is_admin()) with check (is_admin());

drop policy if exists invoice_items_admin_all on invoice_items;
create policy invoice_items_admin_all on invoice_items for all to authenticated
  using (is_admin()) with check (is_admin());

drop policy if exists payments_admin_all on payments;
create policy payments_admin_all on payments for all to authenticated
  using (is_admin()) with check (is_admin());

drop policy if exists expense_categories_admin_all on expense_categories;
create policy expense_categories_admin_all on expense_categories for all to authenticated
  using (is_admin()) with check (is_admin());

drop policy if exists vendors_admin_all on vendors;
create policy vendors_admin_all on vendors for all to authenticated
  using (is_admin()) with check (is_admin());

drop policy if exists expenses_admin_all on expenses;
create policy expenses_admin_all on expenses for all to authenticated
  using (is_admin()) with check (is_admin());

drop policy if exists expense_receipts_admin_all on expense_receipts;
create policy expense_receipts_admin_all on expense_receipts for all to authenticated
  using (is_admin()) with check (is_admin());

drop policy if exists recurring_expenses_admin_all on recurring_expenses;
create policy recurring_expenses_admin_all on recurring_expenses for all to authenticated
  using (is_admin()) with check (is_admin());

drop policy if exists documents_admin_all on documents;
create policy documents_admin_all on documents for all to authenticated
  using (is_admin()) with check (is_admin());

-- The log is readable by staff and appendable by staff, and that is all it
-- is. No update policy and no delete policy exist on purpose: with RLS on,
-- an operation with no policy is refused, so the absence is the rule.
drop policy if exists activity_log_read on activity_log;
create policy activity_log_read on activity_log for select to authenticated
  using (is_admin());

-- A row must be signed by whoever wrote it. Nobody can log work as somebody
-- else, which is the half of attribution a comment in a rulebook cannot
-- enforce.
drop policy if exists activity_log_append on activity_log;
create policy activity_log_append on activity_log for insert to authenticated
  with check (is_admin() and actor_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Invoices: numbering, saving, freezing
-- ---------------------------------------------------------------------------

-- The next number for a given day: YYYYMMDD-N. Serialised per day with an
-- advisory lock so two tabs raising an invoice at once get -1 and -2 rather
-- than two -1s and a unique-index error.
create or replace function next_invoice_number(p_on date) returns text
language plpgsql set search_path = public as $$
declare
  prefix text := to_char(p_on, 'YYYYMMDD');
  seq    integer;
begin
  perform pg_advisory_xact_lock(hashtext('invoice-number:' || prefix));
  select coalesce(max(split_part(number, '-', 2)::integer), 0) + 1
    into seq
    from invoices
   where number like prefix || '-%';
  return prefix || '-' || seq::text;
end $$;

-- Raise a blank draft. The number, the due date, the terms and the tax rate
-- are all decided here, from the settings as they stand today, so a later
-- change to the settings never restates an invoice already raised.
create or replace function create_invoice(
  p_client_id uuid,
  p_issued_on date default current_date
) returns uuid
language plpgsql set search_path = public as $$
declare
  terms  invoice_settings;
  cl     clients;
  days   integer;
  fresh  uuid;
begin
  select * into terms from invoice_settings where id = true;
  select * into cl from clients where id = p_client_id;
  if cl.id is null then
    raise exception 'That client no longer exists.';
  end if;

  days := coalesce(cl.net_days, terms.net_days, 15);

  insert into invoices (
    client_id, number, status, issued_on, due_on, net_days,
    tax_rate_bp, created_by
  )
  values (
    p_client_id,
    next_invoice_number(p_issued_on),
    'draft',
    p_issued_on,
    p_issued_on + days,
    days,
    coalesce(terms.tax_rate_bp, 0),
    auth.uid()
  )
  returning id into fresh;

  return fresh;
end $$;

-- Copy an invoice into a new draft: same client, same lines, today's number.
-- What "raise another one like it" means when a voided invoice has to be
-- redone or a retainer bills the same every month.
create or replace function duplicate_invoice(p_id uuid) returns uuid
language plpgsql set search_path = public as $$
declare
  source invoices;
  fresh  uuid;
begin
  select * into source from invoices where id = p_id;
  if source.id is null then
    raise exception 'That invoice no longer exists.';
  end if;

  fresh := create_invoice(source.client_id, current_date);

  update invoices set
    project_name   = source.project_name,
    purchase_order = source.purchase_order,
    summary        = source.summary,
    notes          = source.notes,
    subtotal_cents = source.subtotal_cents,
    -- The rate travels with the document, exactly as the tax it produced
    -- does. create_invoice set the new draft's rate from today's settings,
    -- which is right for an invoice raised today and wrong for a copy of one
    -- that charged a different rate: leaving it would hand back a row whose
    -- stored tax no rate on it can explain, and the editor would then print a
    -- document disagreeing with its own record.
    tax_rate_bp    = source.tax_rate_bp,
    tax_cents      = source.tax_cents,
    total_cents    = source.total_cents
  where id = fresh;

  insert into invoice_items
    (invoice_id, name, description, quantity, unit_cents, amount_cents, taxable, position)
  select fresh, name, description, quantity, unit_cents, amount_cents, taxable, position
    from invoice_items where invoice_id = source.id
   order by position;

  return fresh;
end $$;

-- Save an invoice and its lines as one statement: the lines are cleared and
-- rewritten rather than diffed, because a partial save would leave an invoice
-- whose total and whose lines disagree.
create or replace function save_invoice(
  p_id      uuid,
  p_invoice jsonb,
  p_items   jsonb default '[]'::jsonb
) returns void
language plpgsql set search_path = public as $$
begin
  update invoices set
    client_id      = coalesce((p_invoice->>'client_id')::uuid, client_id),
    number         = coalesce(nullif(p_invoice->>'number', ''), number),
    status         = coalesce((p_invoice->>'status')::invoice_status, status),
    issued_on      = nullif(p_invoice->>'issued_on', '')::date,
    due_on         = nullif(p_invoice->>'due_on', '')::date,
    net_days       = coalesce((p_invoice->>'net_days')::integer, net_days),
    project_name   = coalesce(p_invoice->>'project_name', ''),
    purchase_order = nullif(p_invoice->>'purchase_order', ''),
    summary        = nullif(p_invoice->>'summary', ''),
    notes          = nullif(p_invoice->>'notes', ''),
    subtotal_cents = coalesce((p_invoice->>'subtotal_cents')::integer, 0),
    tax_rate_bp    = coalesce((p_invoice->>'tax_rate_bp')::integer, tax_rate_bp),
    tax_cents      = coalesce((p_invoice->>'tax_cents')::integer, 0),
    total_cents    = coalesce((p_invoice->>'total_cents')::integer, 0)
  where id = p_id;

  if not found then
    raise exception 'That invoice no longer exists.';
  end if;

  delete from invoice_items where invoice_id = p_id;

  insert into invoice_items
    (invoice_id, name, description, quantity, unit_cents, amount_cents, position, taxable)
  select
    p_id,
    coalesce(row->>'name', 'Item'),
    nullif(row->>'description', ''),
    coalesce((row->>'quantity')::numeric, 1),
    coalesce((row->>'unit_cents')::integer, 0),
    coalesce((row->>'amount_cents')::integer, 0),
    coalesce((row->>'position')::integer, ordinality::integer - 1),
    coalesce((row->>'taxable')::boolean, false)
  from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) with ordinality as t(row, ordinality);
end $$;

-- Freeze an invoice. Refuses a document whose lines and tax do not add up to
-- its total: a client would be holding a PDF that disagrees with the record.
create or replace function issue_invoice(
  p_id       uuid,
  p_snapshot jsonb,
  p_hash     text
) returns timestamptz
language plpgsql set search_path = public as $$
declare
  stamp       timestamptz := now();
  doc         invoices;
  lines_total integer;
begin
  select * into doc from invoices where id = p_id;
  if doc.id is null then
    raise exception 'That invoice no longer exists.';
  end if;
  if doc.issued_at is not null then
    raise exception 'That invoice is already issued.';
  end if;

  select coalesce(sum(amount_cents), 0)::integer into lines_total
    from invoice_items where invoice_id = p_id;

  if lines_total + doc.tax_cents <> doc.total_cents then
    raise exception
      'Invoice % does not add up: its lines and tax come to % but the invoice says %. Fix it before issuing it.',
      doc.number,
      to_char((lines_total + doc.tax_cents) / 100.0, 'FM$999,999,990.00'),
      to_char(doc.total_cents / 100.0, 'FM$999,999,990.00');
  end if;

  update invoices set
    issued_at     = stamp,
    issued_on     = coalesce(issued_on, stamp::date),
    snapshot      = p_snapshot,
    snapshot_hash = p_hash,
    status        = case when status = 'draft' then 'issued' else status end
  where id = p_id and issued_at is null;

  return stamp;
end $$;

-- Once issued, only status, the payment columns and updated_at may move.
-- Written as "copy the frozen row, allow these through, compare the rest" so
-- a column added later is frozen by default rather than quietly editable.
create or replace function guard_issued_invoice() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  probe invoices;
begin
  if old.issued_at is null then
    return new;
  end if;

  probe := old;
  probe.status     := new.status;
  probe.paid_at    := new.paid_at;
  probe.paid_cents := new.paid_cents;
  probe.updated_at := new.updated_at;

  if row(probe.*) is distinct from row(new.*) then
    raise exception
      'This invoice has been issued. Void it and raise a new one instead of editing it.';
  end if;

  return new;
end $$;

drop trigger if exists invoices_guard_issued on invoices;
create trigger invoices_guard_issued before update on invoices
  for each row execute function guard_issued_invoice();

-- And it cannot be deleted either.
--
-- The freeze above stops an issued invoice being edited, which made deleting
-- one the way around it: the number is spent, a client is holding the
-- document, and the row is the only record of what was asked for. The list
-- screen only offers Delete on a draft, but that is a convention in a
-- JavaScript file — this is the rule, and it holds for anything that reaches
-- the table, including a hand-written query in the dashboard.
--
-- Void is the way to cancel an issued invoice: it leaves the number spent and
-- the history readable, which is what an accountant expects to find.
create or replace function guard_issued_invoice_delete() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.issued_at is not null then
    raise exception
      'Invoice % has been issued and cannot be deleted. Void it instead.', old.number;
  end if;
  return old;
end $$;

drop trigger if exists invoices_guard_delete on invoices;
create trigger invoices_guard_delete before delete on invoices
  for each row execute function guard_issued_invoice_delete();

-- The lines are frozen by the same rule: a line added to an issued invoice
-- changes what a client owes without touching the header row at all.
create or replace function guard_issued_invoice_child() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  target uuid;
begin
  target := case when tg_op = 'DELETE' then old.invoice_id else new.invoice_id end;

  if exists (select 1 from invoices where id = target and issued_at is not null) then
    raise exception
      'This invoice has been issued. Void it and raise a new one instead of editing it.';
  end if;

  if tg_op = 'UPDATE' and old.invoice_id is distinct from new.invoice_id
     and exists (select 1 from invoices where id = old.invoice_id and issued_at is not null) then
    raise exception
      'This invoice has been issued. Void it and raise a new one instead of editing it.';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end $$;

drop trigger if exists invoice_items_guard_issued on invoice_items;
create trigger invoice_items_guard_issued
  before insert or update or delete on invoice_items
  for each row execute function guard_issued_invoice_child();

-- ---------------------------------------------------------------------------
-- Payments: what an invoice's own columns say, given the payments against it
-- ---------------------------------------------------------------------------

-- paid_cents, paid_at and status are the three the issued-invoice freeze lets
-- through, which is exactly why they are the three maintained from here.
-- Status only ever moves between issued/sent and paid: a draft has no
-- payments, and a void one is a decision that money arriving does not undo.
create or replace function refresh_invoice_payment(p_invoice_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  doc     invoices;
  paid    integer;
  last_on date;
begin
  if p_invoice_id is null then return; end if;

  select * into doc from invoices where id = p_invoice_id;
  if doc.id is null then return; end if;

  select coalesce(sum(amount_cents), 0)::integer, max(received_on)
    into paid, last_on
    from payments where invoice_id = p_invoice_id;

  update invoices
     set paid_cents = paid,
         paid_at = case
           when doc.total_cents > 0 and paid >= doc.total_cents
             then (last_on::text || ' 12:00:00+00')::timestamptz
           else null end,
         status = case
           when doc.status in ('draft', 'void') then doc.status
           when doc.total_cents > 0 and paid >= doc.total_cents then 'paid'::invoice_status
           when doc.status = 'paid' then 'sent'::invoice_status
           else doc.status end
   where id = p_invoice_id;
end $$;

create or replace function payments_sync() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    perform refresh_invoice_payment(old.invoice_id);
    return old;
  end if;

  perform refresh_invoice_payment(new.invoice_id);
  if tg_op = 'UPDATE' and old.invoice_id is distinct from new.invoice_id then
    perform refresh_invoice_payment(old.invoice_id);
  end if;

  return new;
end $$;

drop trigger if exists payments_sync_invoice on payments;
create trigger payments_sync_invoice after insert or update or delete on payments
  for each row execute function payments_sync();

-- A payment settles a document somebody is holding. Recording one against a
-- draft would also make that draft undeletable, so the refusal is here, at
-- the point of the mistake. The client is pinned to the invoice's too.
create or replace function guard_payment_invoice() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  doc invoices;
begin
  select * into doc from invoices where id = new.invoice_id;
  if doc.id is null or doc.issued_at is null then
    raise exception
      'That invoice is still a draft. Issue it before recording a payment against it.';
  end if;
  new.client_id := doc.client_id;
  return new;
end $$;

drop trigger if exists payments_guard_invoice on payments;
create trigger payments_guard_invoice before insert or update on payments
  for each row execute function guard_payment_invoice();

-- ---------------------------------------------------------------------------
-- Storage
--
-- Two private buckets, staff-only in both directions. Files live under
-- <parent_id>/<uuid>-<filename>. Downloads go through short-lived signed URLs
-- minted in the browser. The bucket enforces what the upload forms promise:
-- 25 MiB and these types, so a form written next year cannot forget.
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('client-documents', 'client-documents', false,
        26214400, array['application/pdf', 'image/jpeg', 'image/png',
                        'image/heic', 'image/heif', 'image/webp',
                        'text/plain', 'text/csv',
                        'application/msword',
                        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                        'application/vnd.ms-excel',
                        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'])
on conflict (id) do update
  set file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists client_documents_admin_all on storage.objects;
create policy client_documents_admin_all on storage.objects for all to authenticated
  using (bucket_id = 'client-documents' and is_admin())
  with check (bucket_id = 'client-documents' and is_admin());

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('expense-receipts', 'expense-receipts', false,
        26214400, array['application/pdf', 'image/jpeg', 'image/png',
                        'image/heic', 'image/heif', 'image/webp'])
on conflict (id) do update
  set file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists expense_receipts_admin_all on storage.objects;
create policy expense_receipts_admin_all on storage.objects for all to authenticated
  using (bucket_id = 'expense-receipts' and is_admin())
  with check (bucket_id = 'expense-receipts' and is_admin());

-- ---------------------------------------------------------------------------
-- Sign-up: create the profile and consume any matching invite
--
-- Fires for ANY auth.users insert — the dashboard's Add user, the admin API,
-- or a public sign-up if that were ever switched on. With no pending invite
-- the profile lands on role 'none' and sees nothing.
-- ---------------------------------------------------------------------------

create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare invite invites;
begin
  -- Only a fresh invite counts. One left behind by an interrupted account
  -- creation is a role nobody is watching; an hour is far longer than the
  -- round trip that writes it, and far shorter than the window an attacker
  -- would need to find it.
  select * into invite
    from invites
   where lower(email) = lower(new.email)
     and consumed_at is null
     and created_at > now() - interval '1 hour'
   order by created_at
   limit 1;

  insert into profiles (id, email, full_name, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', ''),
    coalesce(invite.role, 'none')
  )
  on conflict (id) do nothing;

  if invite.id is not null then
    update invites set consumed_at = now() where id = invite.id;
  end if;

  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function handle_new_user();

-- Backfill profiles for any users who existed before this schema ran.
insert into profiles (id, email, full_name)
select u.id, u.email, coalesce(u.raw_user_meta_data ->> 'full_name', '')
  from auth.users u
 where not exists (select 1 from profiles p where p.id = u.id);

-- No seeded invite, and that is the point.
--
-- The obvious way to bootstrap the first account is to seed a pending invite
-- for the owner and let the trigger above grant the role on first sign-in.
-- Do not: a pending invite is a role waiting for whoever presents that address
-- first, and Supabase's public sign-up endpoint is ON by default. Until the
-- owner got round to signing in, a stranger who guessed the address would have
-- been handed the business.
--
-- So the first account is made deliberately, in the SQL editor, by somebody
-- who already has the keys to the database — see WO-LAUNCH.md step 1. It
-- creates the auth row and sets the role in the same statement, so there is
-- never an unclaimed grant sitting in this table.
--
-- Every account after that is made from Admin → People by a signed-in owner,
-- which writes the invite and creates the account in the same request. An
-- invite is therefore never pending for longer than that round trip.

-- An invite that was written but never consumed is a role somebody could still
-- claim. Nothing should leave one behind, so anything older than a day is
-- swept up here rather than waiting for someone to notice it.
update invites
   set consumed_at = now()
 where consumed_at is null
   and created_at < now() - interval '1 day';

-- ---------------------------------------------------------------------------
-- Seed: expense categories
--
-- Claimed once through seeds_applied so the owner's edits and archives are
-- never undone by re-running this file.
-- ---------------------------------------------------------------------------

with claim as (
  insert into seeds_applied (key) values ('expenses:categories-v1')
  on conflict (key) do nothing
  returning key
)
insert into expense_categories
  (code, name, schedule_c_line, description, needs_substantiation, needs_attendees, half_deductible, position)
select v.code, v.name, v.line, v.description, v.subst, v.attendees, v.half, v.position
  from claim, (values
    ('advertising',    'Advertising & marketing',      '8',   'Ads, sponsorships, promotion of the business.',                                  false, false, false, 10),
    ('vehicle',        'Car & truck',                  '9',   'Business driving. Keep the date, distance, destination and reason.',            true,  false, false, 20),
    ('contract_labor', 'Contract labor',               '11',  'Other people''s work on a client job. Flag them as 1099 vendors.',               false, false, false, 30),
    ('insurance',      'Insurance',                    '15',  'General liability, professional liability, cyber.',                              false, false, false, 40),
    ('professional',   'Legal & professional fees',    '17',  'Accountant, attorney, bookkeeper.',                                              false, false, false, 50),
    ('office',         'Office expense',               '18',  'Postage, printing, the small things that keep an office running.',               false, false, false, 60),
    ('supplies',       'Supplies',                     '22',  'Consumables used up within the year.',                                           false, false, false, 70),
    ('travel',         'Travel',                       '24a', 'Flights, hotels, ground transport on a business trip. Meals go to their own line.', true, false, false, 80),
    ('meals',          'Business meals',               '24b', 'Deductible at 50%. Record who was there and why.',                               true,  true,  true,  90),
    ('software',       'Software & subscriptions',     '27a', 'The monthly stack: design tools, AI tools, cloud services.',                    false, false, false, 100),
    ('licensing',      'Licensing & app store fees',   '27a', 'Developer programs, app store fees, API usage, licences bought to ship an app.', false, false, false, 110),
    ('hosting',        'Hosting & domains',            '27a', 'Servers, hosting plans, domain renewals, SSL.',                                  false, false, false, 120),
    ('equipment',      'Equipment & hardware',         '27a', 'Kit written off in the year it was bought. Ask the CPA about anything large.',   false, false, false, 130),
    ('phone_internet', 'Phone & internet',             '27a', 'The business share, not the whole household bill.',                              false, false, false, 140),
    ('bank_fees',      'Bank & merchant fees',         '27a', 'Card processing, wire fees, monthly account charges.',                           false, false, false, 150),
    ('education',      'Education & training',         '27a', 'Courses, conferences and books that keep the craft current.',                   false, false, false, 160),
    ('gifts',          'Client gifts',                 '27a', 'Deductible to $25 per recipient per year. Record who it went to.',              true,  true,  false, 170),
    ('misc',           'Miscellaneous',                '27a', 'A holding pen, not a habit. Anything here three times deserves its own category.', false, false, false, 900)
  ) as v(code, name, line, description, subst, attendees, half, position)
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------
-- Function privileges
--
-- A function in `public` is an RPC endpoint at /rest/v1/rpc/<name> unless its
-- grants say otherwise. Revoke from PUBLIC as well as the two named roles,
-- then grant back only what the browser calls.
-- ---------------------------------------------------------------------------

revoke all on function current_role_name()        from public, anon, authenticated;
revoke all on function is_admin()                 from public, anon, authenticated;
revoke all on function is_owner()                 from public, anon, authenticated;
revoke all on function set_updated_at()           from public, anon, authenticated;
revoke all on function handle_new_user()          from public, anon, authenticated;
revoke all on function guard_profile_privileges() from public, anon, authenticated;
revoke all on function rls_auto_enable()          from public, anon, authenticated;
revoke all on function next_invoice_number(date)  from public, anon, authenticated;
revoke all on function create_invoice(uuid, date) from public, anon, authenticated;
revoke all on function duplicate_invoice(uuid)    from public, anon, authenticated;
revoke all on function save_invoice(uuid, jsonb, jsonb) from public, anon, authenticated;
revoke all on function issue_invoice(uuid, jsonb, text) from public, anon, authenticated;
revoke all on function guard_issued_invoice()       from public, anon, authenticated;
revoke all on function guard_issued_invoice_child() from public, anon, authenticated;
revoke all on function guard_issued_invoice_delete() from public, anon, authenticated;
revoke all on function refresh_invoice_payment(uuid) from public, anon, authenticated;
revoke all on function payments_sync()            from public, anon, authenticated;
revoke all on function guard_payment_invoice()    from public, anon, authenticated;

-- Policies call these two as the querying role, so `authenticated` needs
-- EXECUTE on them. Each answers only about the caller's own row, so exposing
-- them over /rest/v1/rpc reveals nothing the caller could not already read.
-- current_role_name() is deliberately NOT granted: it is only ever called from
-- inside these two, where the privilege check is made as the owner.
grant execute on function is_admin()          to authenticated;
grant execute on function is_owner()          to authenticated;

-- The invoice writers run as the caller, so the staff-only policies on
-- invoices and its lines are what actually decides. A 'none' account calling
-- one updates zero rows and gets an exception.
-- next_invoice_number is called from inside create_invoice, which runs as the
-- caller (SECURITY INVOKER, so RLS decides the insert). The caller therefore
-- needs EXECUTE on it too; it only reads invoices under RLS.
grant execute on function next_invoice_number(date)       to authenticated;
grant execute on function create_invoice(uuid, date)          to authenticated;
grant execute on function duplicate_invoice(uuid)             to authenticated;
grant execute on function save_invoice(uuid, jsonb, jsonb)    to authenticated;
grant execute on function issue_invoice(uuid, jsonb, text)    to authenticated;

-- ---------------------------------------------------------------------------
-- Table privileges RLS cannot defend against
--
-- TRUNCATE ignores row policies, TRIGGER lets a caller attach code to a
-- table, REFERENCES lets one table's constraint probe another's rows, and
-- MAINTAIN (Postgres 17) runs VACUUM and friends. None belongs to a browser
-- role. MAINTAIN does not exist before 17, so the sweep is version-guarded.
-- ---------------------------------------------------------------------------

do $$
declare privs text;
begin
  privs := case when current_setting('server_version_num')::int >= 170000
                then 'truncate, trigger, references, maintain'
                else 'truncate, trigger, references' end;
  execute format('revoke %s on all tables in schema public from anon, authenticated', privs);
  begin
    execute format('alter default privileges for role postgres in schema public '
                   'revoke %s on tables from anon', privs);
    execute format('alter default privileges for role postgres in schema public '
                   'revoke %s on tables from authenticated', privs);
  exception when insufficient_privilege then
    raise notice 'Could not set default privileges for postgres: not enough rights.';
  end;
  begin
    execute format('alter default privileges for role supabase_admin in schema public '
                   'revoke %s on tables from anon', privs);
    execute format('alter default privileges for role supabase_admin in schema public '
                   'revoke %s on tables from authenticated', privs);
  exception
    when insufficient_privilege then
      raise notice 'Could not set default privileges for supabase_admin: not enough rights.';
    when others then null;
  end;
end $$;

-- The backstop for a table added later, in the image of rls_auto_enable().
create or replace function grants_auto_harden() returns event_trigger
language plpgsql security definer set search_path = pg_catalog as $$
declare
  cmd   record;
  privs text;
begin
  privs := case when current_setting('server_version_num')::int >= 170000
                then 'truncate, trigger, references, maintain'
                else 'truncate, trigger, references' end;
  for cmd in
    select *
      from pg_event_trigger_ddl_commands()
     where command_tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
       and object_type in ('table', 'partitioned table')
  loop
    if cmd.schema_name = 'public' then
      begin
        execute format('revoke %s on table %s from anon, authenticated', privs, cmd.object_identity);
        raise log 'grants_auto_harden: hardened %', cmd.object_identity;
      exception when others then
        raise log 'grants_auto_harden: failed to harden %', cmd.object_identity;
      end;
    end if;
  end loop;
end $$;

revoke all on function grants_auto_harden() from public, anon, authenticated;

do $$ begin
  create event trigger harden_grants on ddl_command_end
    execute function grants_auto_harden();
exception
  when duplicate_object then null;
  when insufficient_privilege then
    raise notice 'Could not create the harden_grants event trigger: not enough rights. '
                 'The sweep above still applies to every table in this file.';
end $$;
