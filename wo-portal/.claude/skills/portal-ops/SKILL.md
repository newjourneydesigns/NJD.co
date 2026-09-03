---
name: portal-ops
description: Operate the Walter Ochenski LLC portal as R2 — clients, invoices, payments, expenses, receipts, documents, reports and sign-ins. Use for any request to look something up in the portal, raise or issue an invoice, record a payment or an expense, file a document, add a client, run a tax-year figure, or manage who can sign in. Read it before writing any SQL against the portal's database.
---

# Operating the portal

You are **R2** (`CLAUDE.md`). This is how the work is actually done, so you do
not rediscover the schema every session.

Project ref `gkzhspoqokjjnvhziivt`. Read `supabase/schema.sql` for anything not
covered here — its comments explain why each rule is the way it is, and the
column names in it are the law.

## Two ways in

**Reading, investigating, bulk work:** Supabase MCP `execute_sql`. Fast, and
runs as the database owner — which means it bypasses Row Level Security and
every guard. Fine for reads. For writes it will happily do things the portal
is built to refuse.

**Acting as R2:** sign in and use the REST API. What you can do is exactly what
Walter could do at the same screen, and the work is attributable.

```bash
URL=https://gkzhspoqokjjnvhziivt.supabase.co
KEY=sb_publishable_DGoS4FOHO34UgsAEz5KGCQ_2_cu-bc4   # public by design
# password: select decrypted_secret from vault.decrypted_secrets
#            where name = 'r2_portal_password';
curl -sS -X POST "$URL/auth/v1/token?grant_type=password" \
  -H "apikey: $KEY" -H 'Content-Type: application/json' \
  -d '{"email":"r2@wo-portal.invalid","password":"…"}'
# → .access_token, good for an hour. Then on every call:
#   -H "apikey: $KEY" -H "Authorization: Bearer <access_token>"
```

Prefer the second for writes. Use the first to read, and for the deliberate
administrative act — and when you write with it, say so in the log entry.

## Always: log what you changed

One row per batch of work, not per statement. It is insert-only: you cannot
edit or delete a row afterwards, including your own.

```sql
insert into activity_log (actor_id, action, detail)
values (
  (select id from profiles where email = 'r2@wo-portal.invalid'),
  'raise-invoice',
  jsonb_build_object(
    'invoice', '20260903-1',
    'client', 'Switch Commerce',
    'why', 'Walter asked for the March consulting to be billed'));
```

Through the API, `actor_id` must be your own id or the insert is refused.

## The shape of the money

Read this once and a lot of the rest follows.

- **Cents, always.** `amount_cents`, `total_cents`. Never a float, never
  dollars.
- **Dates are strings.** `spent_on`, `issued_on`, `received_on` are
  `YYYY-MM-DD`. Compare them as text. Parsing one as a `Date` shifts it a day
  in some timezones, which puts an expense in the wrong tax year.
- **An invoice is a draft until it is issued.** A draft is editable and
  deletable. Issuing freezes it: `issued_at`, a `snapshot` of the document, and
  a hash. From then on only `status`, `paid_cents` and `paid_at` can move —
  enforced by a trigger, not by the UI — and it cannot be deleted at all.
- **Numbers are `YYYYMMDD-N`**, assigned by `create_invoice()` under a lock.
  Never invent one.
- **Payments drive status.** Insert a payment; a trigger recomputes the
  invoice's `paid_cents`, `paid_at` and `status`. Never write those columns
  yourself. A refund is a payment with a negative amount.

## Recipes

### Who owes us money

```sql
select i.number, c.name, i.issued_on, i.due_on,
       (i.total_cents - i.paid_cents) / 100.0 as owed,
       case when i.due_on < current_date then current_date - i.due_on end as days_late
  from invoices i join clients c on c.id = i.client_id
 where i.status in ('issued', 'sent') and i.total_cents > i.paid_cents
 order by i.due_on;
```

### Add a client

Only `name` is required. `net_days` null means the standard terms;
`hourly_rate_cents` null means the standard rate.

```sql
insert into clients (name, legal_name, contact_name, contact_email, contact_phone,
                     address_line1, city, region, postal_code, net_days)
values ('Switch Commerce', 'Switch Commerce LLC', 'Dana Reid',
        'dana@example.com', '(940) 555-0123',
        '100 Main Street', 'Denton', 'Texas', '76201', 30)
returning id;
```

### Raise an invoice

Always through the RPC — it assigns the number, copies the terms and the tax
rate as they stand today, and computes the due date.

```sql
select create_invoice(
  (select id from clients where name = 'Switch Commerce'),
  current_date);                                    -- → the new invoice's id
```

Then the lines. `save_invoice` rewrites all of them at once, and the header
totals must agree with them or issuing is refused:

```sql
select save_invoice(
  '<invoice id>',
  jsonb_build_object('summary', 'March consulting',
                     'subtotal_cents', 450000, 'tax_cents', 0, 'total_cents', 450000),
  jsonb_build_array(
    jsonb_build_object('name', 'Marketing consulting',
                       'description', 'Discovery and strategy',
                       'quantity', 30, 'unit_cents', 15000,
                       'amount_cents', 450000, 'position', 0)));
```

**Then stop.** Issuing is irreversible and needs a yes (rule 2). The honest way
to issue is the portal itself — open `/portal/invoice/?id=…`, check the
document, press Issue — because that path builds the snapshot the client's PDF
is rendered from. Doing it in SQL means hand-building that snapshot, and a
snapshot that disagrees with the row is the exact failure the freeze exists to
prevent.

### Record a payment

```sql
insert into payments (invoice_id, received_on, amount_cents, method, reference)
values ('<invoice id>', current_date, 450000, 'ach', 'ACH-7781');
-- client_id is filled from the invoice by a trigger; do not pass it.
-- method: ach | check | zelle | card | cash | other
```

The invoice marks itself paid when the payments cover the total. If it does not,
the total and the payments disagree — investigate, do not patch `paid_cents`.

### Record an expense

`category_id` is required. Categories carry the Schedule C line the tax-year
report groups by, and flags for what the IRS wants written down.

```sql
select id, code, name, schedule_c_line, needs_substantiation, needs_attendees
  from expense_categories where archived_at is null order by position;

insert into expenses (spent_on, vendor_name, category_id, amount_cents,
                      description, method, client_id, billable)
values (current_date, 'Adobe',
        (select id from expense_categories where code = 'software'),
        5499, 'Creative Cloud', 'card', null, false);
```

For a category with `needs_substantiation` (travel, vehicle, meals, gifts) also
fill `place` and `business_purpose`; with `needs_attendees`, `attendees` as
well. A deduction missing those is the one most reliably disallowed.

A supplier refund is a negative `amount_cents`, not a deletion.

### What did we spend on X this year

```sql
select ec.schedule_c_line, ec.name,
       sum(e.amount_cents) / 100.0 as total,
       sum(case when ec.half_deductible then e.amount_cents / 2 else e.amount_cents end) / 100.0
         as deductible
  from expenses e join expense_categories ec on ec.id = e.category_id
 where e.spent_on >= date_trunc('year', current_date)::date
 group by ec.schedule_c_line, ec.name
 order by ec.schedule_c_line;
```

Gross receipts for the same year are the payments, not the invoices — the books
are cash basis:

```sql
select sum(amount_cents) / 100.0
  from payments where received_on >= date_trunc('year', current_date)::date;
```

### Contractors who need a 1099

```sql
select v.name, sum(e.amount_cents) / 100.0 as paid, v.tax_id_on_file
  from expenses e join vendors v on v.id = e.vendor_id
 where v.files_1099
   and e.spent_on >= date_trunc('year', current_date)::date
 group by v.name, v.tax_id_on_file
having sum(e.amount_cents) >= (select nec_threshold_cents from studio_settings where id = true)
 order by paid desc;
```

A vendor over the threshold with `tax_id_on_file = false` is the thing worth
raising in November rather than January.

### Documents and receipts

The rows are metadata; the bytes are in private storage buckets
(`client-documents`, `expense-receipts`), reached with a signed URL. Uploading
needs a real HTTP request, so it is an API job, not a SQL one — and in practice
the portal's own upload button is the right tool. Never make a bucket public.

### Sign-ins

Through `Admin → People` in the portal, or the function:

```bash
curl -sS -X POST https://<site>/.netlify/functions/admin-users \
  -H "Authorization: Bearer <R2's access token>" \
  -H 'Content-Type: application/json' \
  -d '{"action":"create","username":"books","full_name":"…","role":"staff","password":"…"}'
```

Roles are `owner` (everything, including sign-ins), `staff` (everything except
sign-ins), `none` (nothing). Deleting a sign-in is irreversible and needs a yes.
Never delete or demote Walter. Never leave an invite pending.

### Changing the portal itself

Edit this folder, run the four checks in `CLAUDE.md`, push. Schema changes go
into `supabase/schema.sql` in the same piece of work, idempotently, and
`bash tools/portal/schema-check.sh` must stay green — it applies the file twice
and then asserts the rules still hold.

## Boundaries, worth repeating

Log every batch. Confirm anything irreversible. Never edit or delete an issued
invoice. Never put a secret in the repo. Never weaken RLS or grant to `anon`.
Never leave the portal with fewer than one human owner.
