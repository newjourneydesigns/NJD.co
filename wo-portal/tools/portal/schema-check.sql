-- ---------------------------------------------------------------------------
-- Does the schema actually behave?
--
-- Run by tools/portal/schema-check.sh against a throwaway database that has
-- just had supabase/schema.sql applied to it, twice. Everything here is a rule
-- the schema claims to enforce, exercised against a real Postgres — because a
-- constraint that was never fired is a comment.
--
-- The pattern is `assert(condition, 'what was expected')` for the things that
-- should work, and `refuses($$ statement $$, 'what should be rejected')` for
-- the things that should not. A failure raises and psql's ON_ERROR_STOP takes
-- the script — and the check script — down with it.
--
-- These run as the database owner, so RLS is bypassed and what is under test
-- is the triggers, the constraints and the invoice functions. The RLS section
-- at the bottom takes off the owner's hat and puts on each of the three roles
-- in turn, the way tools/portal/supabase-stub.sql lets a session say "now be
-- this person".
-- ---------------------------------------------------------------------------

\set ON_ERROR_STOP on
\timing off
-- The assertions report through NOTICE; their return values are all void, and
-- forty "(1 row)" banners would bury the one line that matters.
\pset tuples_only on
\pset format unaligned

create or replace function assert(ok boolean, what text) returns void
language plpgsql as $$
begin
  if ok is not true then
    raise exception 'FAILED: %', what;
  end if;
  raise notice '  ok: %', what;
end $$;

-- Runs a statement that is supposed to be rejected, and fails if it is not.
--
-- The statement runs in its own subtransaction so a legitimately-raised error
-- does not poison the rest of the script. `set constraints all immediate`
-- pulls any deferred check inside the handler's reach; there are none in this
-- schema today, and the line costs nothing against the day there is one.
create or replace function refuses(stmt text, what text) returns void
language plpgsql as $$
begin
  begin
    execute stmt;
    set constraints all immediate;
  exception when others then
    raise notice '  ok: % (%)', what, left(sqlerrm, 60);
    return;
  end;
  raise exception 'FAILED: % — the statement was accepted', what;
end $$;

-- Supabase grants the browser roles USAGE on the auth schema and EXECUTE on
-- auth.uid(); the stub in supabase-stub.sql does not, and create_invoice()
-- reads auth.uid() as the caller to stamp created_by. Granted here, as the
-- owner, so the seats in the RLS section below match production.
grant usage on schema auth to authenticated;
grant execute on function auth.uid() to authenticated;

-- create_invoice() runs as the caller and calls next_invoice_number(), which
-- schema.sql revokes from the browser roles — so until schema.sql grants it,
-- a bookkeeper raising an invoice from the browser gets "permission denied
-- for function next_invoice_number". Said out loud as a WARNING rather than
-- failing the run, then granted here so the policy checks below can proceed.
-- The grant is a no-op once schema.sql carries it, and the warning goes away.
do $$
begin
  if not has_function_privilege('authenticated', 'next_invoice_number(date)', 'execute') then
    raise warning 'schema.sql: next_invoice_number(date) is not executable by authenticated, so create_invoice() fails from the browser. Add: grant execute on function next_invoice_number(date) to authenticated;';
  end if;
end $$;
grant execute on function next_invoice_number(date) to authenticated;

-- A little fixture: two clients, one of them on Net 30.
do $$
declare
  c uuid;
  other uuid;
begin
  insert into clients (name, contact_email, status)
  values ('Switch Commerce', 'ap@switch.example', 'active') returning id into c;

  insert into clients (name, status, net_days)
  values ('Other Corp', 'active', 30) returning id into other;

  create temporary table fixture as select c as client_id, other as other_client_id;
  grant select on fixture to authenticated;
end $$;

\echo 'Row Level Security is on everywhere'

select assert(count(*) >= 16, 'the schema created its tables')
  from pg_tables where schemaname = 'public';

select assert(
  not exists (select 1 from pg_tables where schemaname = 'public' and not rowsecurity),
  'every table in public has RLS enabled');

select assert(
  (select rowsecurity from pg_tables where schemaname = 'public' and tablename = 'seeds_applied'),
  'seeds_applied included, with no policy at all');

\echo 'Invoice numbers'

do $$
declare
  a uuid;
  b uuid;
  c uuid;
  d uuid;
begin
  a := create_invoice((select client_id from fixture), '2026-09-01');
  b := create_invoice((select client_id from fixture), '2026-09-01');
  c := create_invoice((select client_id from fixture), '2026-09-02');
  d := create_invoice((select other_client_id from fixture), '2026-10-01');

  perform assert((select number from invoices where id = a) = '20260901-1',
    'the first invoice of a day is YYYYMMDD-1');
  perform assert((select number from invoices where id = b) = '20260901-2',
    'the second that day is -2');
  perform assert((select number from invoices where id = c) = '20260902-1',
    'another day starts again at -1');

  perform assert((select status from invoices where id = a) = 'draft',
    'a raised invoice starts as a draft');
  perform assert((select issued_on from invoices where id = a) = date '2026-09-01',
    'dated the day it was asked for');
  perform assert((select due_on from invoices where id = a) = date '2026-09-16',
    'due 15 days on — the default terms');
  perform assert((select net_days from invoices where id = a) = 15,
    'and the terms it was computed from are kept on the row');
  perform assert((select due_on from invoices where id = d) = date '2026-10-31',
    'a client on Net 30 gets 30 days');
  perform assert((select created_by from invoices where id = a) is null,
    'created_by is null when nobody is signed in — the SQL editor, or this test');

  create temporary table inv as select a as first_id, b as second_id, c as third_id, d as fourth_id;
  grant select on inv to authenticated;
end $$;

select refuses(
  $$ select create_invoice(gen_random_uuid(), current_date) $$,
  'an invoice cannot be raised for a client that does not exist');

select refuses(
  $$ update invoices set number = '0001' where id = (select first_id from inv) $$,
  'a number that is not YYYYMMDD-N is refused');

select refuses(
  $$ update invoices set number = '20260901-1' where id = (select second_id from inv) $$,
  'two invoices cannot share a number');

select assert(
  (select tax_rate_bp from invoices where id = (select first_id from inv))
    = (select tax_rate_bp from invoice_settings where id = true),
  'the tax rate is copied from the settings at creation');

\echo 'Saving rewrites the lines'

select save_invoice(
  (select first_id from inv),
  jsonb_build_object('summary', 'September work',
                     'subtotal_cents', 150000, 'tax_cents', 0, 'total_cents', 150000),
  jsonb_build_array(
    jsonb_build_object('name', 'Consulting', 'quantity', 10, 'unit_cents', 10000, 'amount_cents', 100000),
    jsonb_build_object('name', 'Design', 'quantity', 1, 'unit_cents', 50000, 'amount_cents', 50000)));

select assert(count(*) = 2, 'save_invoice writes the lines')
  from invoice_items where invoice_id = (select first_id from inv);

select assert(
  (select summary from invoices where id = (select first_id from inv)) = 'September work',
  'and the header columns land');

select assert(
  (select array_agg(position order by position) from invoice_items
    where invoice_id = (select first_id from inv)) = array[0, 1],
  'a line with no position takes its place in the array');

select save_invoice(
  (select first_id from inv),
  jsonb_build_object('summary', 'September work',
                     'subtotal_cents', 100000, 'tax_cents', 0, 'total_cents', 100000),
  jsonb_build_array(
    jsonb_build_object('name', 'Consulting', 'quantity', 10, 'unit_cents', 10000, 'amount_cents', 100000)));

select assert(count(*) = 1, 'saving again replaces the lines rather than adding to them')
  from invoice_items where invoice_id = (select first_id from inv);

select refuses(
  $$ select save_invoice(gen_random_uuid(), '{}'::jsonb, '[]'::jsonb) $$,
  'saving an invoice that does not exist is an error, not a silent no-op');

\echo 'Issuing'

-- A total that disagrees with the lines: the one thing a client must never
-- be handed a PDF of.
select save_invoice(
  (select first_id from inv),
  jsonb_build_object('summary', 'September work',
                     'subtotal_cents', 100000, 'tax_cents', 0, 'total_cents', 99900),
  jsonb_build_array(
    jsonb_build_object('name', 'Consulting', 'quantity', 10, 'unit_cents', 10000, 'amount_cents', 100000)));

select refuses(
  $$ select issue_invoice((select first_id from inv), '{}'::jsonb, 'hash') $$,
  'an invoice whose lines and tax do not add up to its total cannot be issued');

select assert(
  (select issued_at from invoices where id = (select first_id from inv)) is null,
  'and it stays unissued');

-- Tax counts: lines 1000.00 + tax 82.50 = 1082.50.
select save_invoice(
  (select first_id from inv),
  jsonb_build_object('summary', 'September work', 'tax_rate_bp', 825,
                     'subtotal_cents', 100000, 'tax_cents', 8250, 'total_cents', 108250),
  jsonb_build_array(
    jsonb_build_object('name', 'Consulting', 'quantity', 10, 'unit_cents', 10000,
                       'amount_cents', 100000, 'taxable', true)));

do $$
declare stamp timestamptz;
begin
  stamp := issue_invoice((select first_id from inv),
                         jsonb_build_object('number', '20260901-1'), 'abc123');
  perform assert(stamp is not null, 'issuing returns the timestamp');
  perform assert((select issued_at from invoices where id = (select first_id from inv)) = stamp,
    'and stamps it on the invoice');
  perform assert((select status from invoices where id = (select first_id from inv)) = 'issued',
    'draft becomes issued');
  perform assert((select snapshot_hash from invoices where id = (select first_id from inv)) = 'abc123',
    'the snapshot hash is kept');
  perform assert((select snapshot ->> 'number' from invoices where id = (select first_id from inv)) = '20260901-1',
    'and so is the snapshot');
end $$;

select refuses(
  $$ select issue_invoice((select first_id from inv), '{}'::jsonb, 'again') $$,
  'an invoice cannot be issued twice');

\echo 'Once issued, frozen'

select refuses(
  $$ update invoices set summary = 'Changed' where id = (select first_id from inv) $$,
  'the summary cannot change after issue');

select refuses(
  $$ update invoices set total_cents = 1 where id = (select first_id from inv) $$,
  'nor the total');

select refuses(
  $$ update invoices set client_id = (select other_client_id from fixture)
      where id = (select first_id from inv) $$,
  'nor the client');

select refuses(
  $$ update invoices set issued_at = null where id = (select first_id from inv) $$,
  'and it cannot be un-issued');

update invoices set status = 'sent' where id = (select first_id from inv);

select assert(
  (select status from invoices where id = (select first_id from inv)) = 'sent',
  'but status may move to sent');

select refuses(
  $$ insert into invoice_items (invoice_id, name, amount_cents)
     values ((select first_id from inv), 'Extra', 100) $$,
  'a line cannot be added to an issued invoice');

select refuses(
  $$ update invoice_items set amount_cents = 1 where invoice_id = (select first_id from inv) $$,
  'nor changed');

select refuses(
  $$ delete from invoice_items where invoice_id = (select first_id from inv) $$,
  'nor removed');

select refuses(
  $$ update invoice_items set invoice_id = (select second_id from inv)
      where invoice_id = (select first_id from inv) $$,
  'nor moved to another invoice');

select refuses(
  $$ select save_invoice((select first_id from inv), '{}'::jsonb, '[]'::jsonb) $$,
  'and save_invoice on an issued invoice is refused with the rest');

select assert(count(*) = 1, 'the line is still there afterwards')
  from invoice_items where invoice_id = (select first_id from inv);

\echo 'Payments'

select refuses(
  $$ insert into payments (invoice_id, received_on, amount_cents, method)
     values ((select second_id from inv), '2026-09-05', 1000, 'ach') $$,
  'a payment against a draft is refused');

select refuses(
  $$ insert into payments (invoice_id, received_on, amount_cents, method)
     values ((select first_id from inv), '2026-09-05', 0, 'ach') $$,
  'a payment of nothing is refused');

do $$
begin
  insert into payments (invoice_id, received_on, amount_cents, method)
  values ((select first_id from inv), '2026-09-10', 40000, 'ach');

  perform assert((select paid_cents from invoices where id = (select first_id from inv)) = 40000,
    'a part payment lands as paid_cents');
  perform assert((select status from invoices where id = (select first_id from inv)) = 'sent',
    'and leaves the status where it was');
  perform assert((select paid_at from invoices where id = (select first_id from inv)) is null,
    'with no paid_at yet');
  perform assert(
    (select client_id from payments where invoice_id = (select first_id from inv))
      = (select client_id from fixture),
    'the payment carries the invoice''s client without being told it');
end $$;

do $$
declare p uuid;
begin
  -- Claims the wrong client on purpose.
  insert into payments (invoice_id, client_id, received_on, amount_cents, method, reference)
  values ((select first_id from inv), (select other_client_id from fixture),
          '2026-09-12', 68250, 'check', '1042')
  returning id into p;

  perform assert(
    (select client_id from payments where id = p) = (select client_id from fixture),
    'a payment claiming another client is pinned back to the invoice''s');
  perform assert((select paid_cents from invoices where id = (select first_id from inv)) = 108250,
    'the two payments add up');
  perform assert((select status from invoices where id = (select first_id from inv)) = 'paid',
    'covering the total marks it paid');
  perform assert(
    (select paid_at from invoices where id = (select first_id from inv))
      = '2026-09-12 12:00:00+00'::timestamptz,
    'paid_at is noon UTC of the last payment');

  create temporary table pay as select p as covering_payment;
end $$;

insert into payments (invoice_id, received_on, amount_cents, method, notes)
values ((select first_id from inv), '2026-09-13', -10000, 'ach', 'Overpaid; returned');

select assert(paid_cents = 98250 and status = 'sent' and paid_at is null,
  'a refund is a negative payment: it reduces paid_cents and reopens the invoice')
  from invoices where id = (select first_id from inv);

delete from payments where amount_cents < 0 and invoice_id = (select first_id from inv);

select assert(paid_cents = 108250 and status = 'paid',
  'deleting the refund makes it paid again')
  from invoices where id = (select first_id from inv);

delete from payments where id = (select covering_payment from pay);

select assert(paid_cents = 40000 and status = 'sent' and paid_at is null,
  'deleting a payment drops the status back to sent')
  from invoices where id = (select first_id from inv);

select refuses(
  $$ delete from invoices where id = (select first_id from inv) $$,
  'an invoice with a payment against it cannot be deleted');

select refuses(
  $$ delete from clients where id = (select client_id from fixture) $$,
  'nor a client with invoices — deleting one is a deliberate act, not a side effect');

delete from invoices where id = (select second_id from inv);
select assert(count(*) = 0, 'a draft can be deleted')
  from invoices where id = (select second_id from inv);

update invoices set status = 'void' where id = (select third_id from inv);
select assert(
  (select status from invoices where id = (select third_id from inv)) = 'void',
  'and a draft can be voided outright');

\echo 'Duplicating'

do $$
declare fresh uuid;
begin
  fresh := duplicate_invoice((select first_id from inv));

  perform assert((select status from invoices where id = fresh) = 'draft',
    'a duplicate is a fresh draft');
  perform assert((select number from invoices where id = fresh) like to_char(current_date, 'YYYYMMDD') || '-%',
    'numbered for today');
  perform assert((select issued_at from invoices where id = fresh) is null,
    'and not issued');
  perform assert(
    (select client_id from invoices where id = fresh)
      = (select client_id from invoices where id = (select first_id from inv)),
    'for the same client');
  perform assert(
    (select count(*) from invoice_items where invoice_id = fresh)
      = (select count(*) from invoice_items where invoice_id = (select first_id from inv)),
    'with the same lines');
  perform assert((select name from invoice_items where invoice_id = fresh) = 'Consulting',
    'copied by value');
  perform assert((select total_cents from invoices where id = fresh) = 108250,
    'and the same total');
  perform assert((select paid_cents from invoices where id = fresh) = 0,
    'but nothing paid against it');
  perform assert((select summary from invoices where id = fresh) = 'September work',
    'and the same summary');
end $$;

select refuses(
  $$ select duplicate_invoice(gen_random_uuid()) $$,
  'duplicating an invoice that does not exist is refused');

\echo 'Expenses'

select assert(count(*) >= 12, 'the expense categories are seeded')
  from expense_categories where archived_at is null;

select assert(
  (select half_deductible and needs_attendees and needs_substantiation
     from expense_categories where code = 'meals'),
  'business meals ask for who, where and why, and count at 50%');

select assert(count(*) = 1, 'the seed ran exactly once, and says so')
  from seeds_applied where key = 'expenses:categories-v1';

select refuses(
  $$ insert into expenses (spent_on, amount_cents, description)
     values (current_date, 1200, 'No category') $$,
  'an expense with no category is refused');

select refuses(
  $$ insert into expenses (spent_on, amount_cents, category_id)
     values (current_date, 0, (select id from expense_categories where code = 'software')) $$,
  'an expense of nothing is refused');

do $$
declare e uuid;
begin
  insert into expenses (spent_on, amount_cents, category_id, description, method)
  values ('2026-09-03', 2900, (select id from expense_categories where code = 'software'),
          'Figma', 'card')
  returning id into e;

  insert into expense_receipts (expense_id, storage_path, name)
  values (e, e::text || '/one.jpg', 'one.jpg'),
         (e, e::text || '/two.jpg', 'two.jpg');

  perform assert((select count(*) from expense_receipts where expense_id = e) = 2,
    'receipts attach to an expense');

  perform assert((select method from expenses where id = e) = 'card',
    'card is how a subscription is usually paid');

  delete from expenses where id = e;

  perform assert((select count(*) from expense_receipts where expense_id = e) = 0,
    'deleting the expense takes its receipt rows with it');
end $$;

do $$
declare e uuid;
begin
  insert into expenses (spent_on, amount_cents, category_id, description,
                        client_id, billable)
  values ('2026-09-04', 4500, (select id from expense_categories where code = 'meals'),
          'Lunch with the client', (select client_id from fixture), true)
  returning id into e;

  perform assert((select billed_invoice_id from expenses where id = e) is null,
    'a billable expense starts unbilled');

  create temporary table exp as select e as meal_id;
end $$;

select refuses(
  $$ delete from expense_categories where code = 'meals' $$,
  'a category with expenses filed under it cannot be deleted — archive it');

update expense_categories set archived_at = now() where code = 'meals';
select assert(
  (select archived_at from expense_categories where code = 'meals') is not null,
  'archiving is the way to retire one');
update expense_categories set archived_at = null where code = 'meals';

select refuses(
  $$ insert into expense_categories (code, name) values ('meals', 'Duplicate') $$,
  'two categories cannot share a code');

\echo 'RLS: who sees what'

do $$
declare
  stray uuid := gen_random_uuid();
  books uuid := gen_random_uuid();
  boss  uuid := gen_random_uuid();
begin
  insert into invites (email, role) values ('books@wo-portal.invalid', 'staff');

  -- Fires handle_new_user(), the way the dashboard's Add user or the
  -- admin-users function would.
  insert into auth.users (id, email) values
    (stray, 'stray@wo-portal.invalid'),
    (books, 'books@wo-portal.invalid'),
    (boss,  'walter@wo-portal.invalid');

  perform assert((select role from profiles where id = stray) = 'none',
    'an uninvited sign-up lands on no role');
  perform assert((select role from profiles where id = books) = 'staff',
    'an invited sign-up takes the invite''s role');
  perform assert((select role from profiles where id = boss) = 'owner',
    'and the seeded invite makes walter the owner');
  perform assert(
    (select consumed_at from invites where email = 'books@wo-portal.invalid') is not null,
    'the invite is consumed');
  perform assert(
    (select email from profiles where id = books) = 'books@wo-portal.invalid',
    'profiles.email mirrors the sign-in address');

  create temporary table people as select stray, books, boss;
  grant select on people to authenticated;
end $$;

-- A sign-in with no role --------------------------------------------------

select set_config('request.jwt.claim.sub', (select stray::text from people), false) \gset _
set role authenticated;

-- First: prove the session is real. Without this the checks below would all
-- pass on a null auth.uid(), which is to say they would pass for a reason
-- that has nothing to do with the policies being tested. (auth.uid() itself
-- is not called from this seat: the stub's auth schema is the owner's, and
-- the helpers reach it as SECURITY DEFINER the way the policies do.)
select assert(
  (select id from profiles) = (select stray from people),
  'the stray session is genuinely signed in — it can see its own profile');
-- current_role_name() is the owner's alone (the policies reach it through
-- is_admin()/is_owner(), which are SECURITY DEFINER); a browser role calling
-- it directly is refused, and that refusal is checked here too.
select assert(not is_admin() and not is_owner(), 'and the portal knows it is neither staff nor the owner');
select refuses(
  $$ select current_role_name() $$,
  'a browser role cannot call current_role_name() directly');

select assert(count(*) = 0, 'a sign-in with no role sees no clients')   from clients;
select assert(count(*) = 0, '… no invoices')                            from invoices;
select assert(count(*) = 0, '… no payments')                            from payments;
select assert(count(*) = 0, '… no expenses')                            from expenses;
select assert(count(*) = 0, '… no categories')                          from expense_categories;
select assert(count(*) = 0, '… not even the business details')          from studio_settings;
select assert(count(*) = 0, '… and no invites')                         from invites;
select assert(count(*) = 1, 'but can see its own profile, and only that') from profiles;

select refuses(
  $$ insert into clients (name) values ('Sneaky') $$,
  'and cannot add a client');

select refuses(
  $$ select create_invoice((select client_id from fixture), current_date) $$,
  'nor raise an invoice');

select refuses(
  $$ update profiles set role = 'owner' where id = (select stray from people) $$,
  'nor give itself a role');

reset role;
select set_config('request.jwt.claim.sub', '', false) \gset _

-- The bookkeeper -------------------------------------------------------------

select set_config('request.jwt.claim.sub', (select books::text from people), false) \gset _
set role authenticated;

select assert(is_admin() and not is_owner(), 'the bookkeeper is staff but not the owner');

select assert(count(*) >= 2, 'the bookkeeper sees the clients') from clients;
select assert(count(*) >= 1, '… the invoices')                   from invoices;
select assert(count(*) >= 1, '… the payments')                   from payments;
select assert(count(*) >= 1, '… the expenses')                   from expenses;
select assert(count(*) = 1,  '… and the business details')       from studio_settings;

insert into clients (name, status) values ('Bookkeeper added', 'lead');
select assert(count(*) = 1, 'and can add a client')
  from clients where name = 'Bookkeeper added';

do $$
declare fresh uuid;
begin
  fresh := create_invoice((select client_id from fixture), current_date);
  perform assert((select created_by from invoices where id = fresh) = (select books from people),
    'can raise an invoice, and it is stamped with who raised it');
end $$;

update studio_settings set hourly_rate_cents = 15000 where id = true;
select assert(
  (select hourly_rate_cents from studio_settings where id = true) = 15000,
  'and can set the hourly rate — the settings are staff''s');

select refuses(
  $$ insert into invites (email, role) values ('new@wo-portal.invalid', 'staff') $$,
  'but cannot write an invite');

select assert(count(*) = 0, 'and cannot read the invites either') from invites;

select refuses(
  $$ update profiles set role = 'owner' where id = (select books from people) $$,
  'and cannot change their own role');

update profiles set full_name = 'Books McGee' where id = (select books from people);
select assert(
  (select full_name from profiles where id = (select books from people)) = 'Books McGee',
  'but can change their own name');

select assert(count(*) = 3, 'staff can see every profile — there are three of them') from profiles;

-- Somebody else's row matches no update policy for staff, so this is silently
-- zero rows rather than an error. The proof is the role still being owner,
-- checked from the owner's seat below.
update profiles set role = 'none' where id = (select boss from people);

reset role;
select set_config('request.jwt.claim.sub', '', false) \gset _

select assert(
  (select role from profiles where id = (select boss from people)) = 'owner',
  'a staff update to somebody else''s profile changes nothing');

-- The owner ------------------------------------------------------------------

select set_config('request.jwt.claim.sub', (select boss::text from people), false) \gset _
set role authenticated;

select assert(is_admin() and is_owner(), 'the owner is staff and the owner');

insert into invites (email, role) values ('third@wo-portal.invalid', 'staff');
select assert(count(*) = 1, 'the owner can write an invite')
  from invites where email = 'third@wo-portal.invalid';

select assert(count(*) >= 1, 'and read them') from invites;

update profiles set role = 'owner' where id = (select books from people);
select assert(
  (select role from profiles where id = (select books from people)) = 'owner',
  'and can change another person''s role');

update profiles set role = 'staff' where id = (select books from people);
select assert(
  (select role from profiles where id = (select books from people)) = 'staff',
  'in both directions');

update profiles set role = 'staff' where id = (select stray from people);
select assert(
  (select role from profiles where id = (select stray from people)) = 'staff',
  'which is how a stray sign-in gets finished');

delete from invites where email = 'third@wo-portal.invalid';

reset role;
select set_config('request.jwt.claim.sub', '', false) \gset _

\echo ''
\echo 'Portal behaviour: all checks passed.'
