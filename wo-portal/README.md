# Walter Ochenski LLC — Portal

An internal tool for one owner and a bookkeeper: clients, invoices and payments, expenses
with receipts, documents filed per client, and a tax-year report. Modelled on the New Journey
Designs client portal and built the same way: hand-written HTML, plain ES modules, no build
step, Supabase Postgres with Row Level Security as the only authorization, one Netlify function.

- `WO-LAUNCH.md` — how to stand it up (Supabase settings, the Netlify project, first sign-in).
- `supabase/schema.sql` — the database, idempotent; the source of truth.
- `js/portal/` — the app. `shell.js` puts the header on every page; `client.js` wraps
  Supabase; the rest is one module per page plus a few pure helpers (`money.js`,
  `doc-common.js`, `*-model.js`) that `node --test` covers.
- `netlify/functions/admin-users.js` — creates and manages sign-ins with the service-role key.
  The only server code, and the only secret.
- `tools/portal/` — `syntax-check.sh` (every module parses), `schema-check.sh` (the schema
  applies twice and its rules hold, on a local Postgres), `*.test.mjs` (`node --test`).
- `tools/icons/render.mjs` — rasterises the WO mark into the icon set with headless Chromium.
- `CLAUDE.md` — **R2**, the portal's AI operator: what it is, what it may do on
  its own, and the kill switch. R2 is an ordinary sign-in (`profiles.role =
  'owner'`, password in Supabase Vault) held to the same Row Level Security as
  anyone else, and everything it does lands in `activity_log`, which takes
  inserts and nothing else. `.claude/skills/portal-ops/SKILL.md` is its recipes.

## Before you push

```
bash tools/portal/syntax-check.sh          # every module parses
node --test "tools/portal/*.test.mjs"      # the pure modules, and the deploy config
node tools/portal/smoke.mjs                # every page renders, in a browser
bash tools/portal/schema-check.sh          # the schema applies twice and its rules hold
```

Against the live project, when you need it:

```
WO_CHECK_USER=… WO_CHECK_PASSWORD=… node tools/portal/live-check.mjs
WO_R2_PASSWORD=… node tools/portal/operator-check.mjs   # R2 signs in; its limits hold
```

`smoke.mjs` is hermetic: `tools/portal/stub-client.js` stands in for Supabase, so
it needs no account and no network, and it says the same thing every time. Add
`WO_SHOTS=1` to write screenshots to `tools/portal/shots/` (git-ignored), and
`WO_WIDTH=1280 WO_HEIGHT=900` to look at the desktop layout.

`schema-check.sh` needs postgresql-16 on the box and skips with a message when
there is none.

There is one more, and it is the only thing that talks to the real database:

```
WO_CHECK_USER=<username> WO_CHECK_PASSWORD=<password> node tools/portal/live-check.mjs
```

It signs in with the publishable key, walks the whole money path — numbering,
the issue guard, the freeze, part and full payment, refunds, duplication,
receipts, documents — and deletes everything it made. It refuses to run unless
the account starts out seeing no clients, so it cannot be pointed at live data.
Run it against a scratch account after a schema change, never against the
owner's account on a database with real records in it.

To look at the portal by hand: `python3 -m http.server 8000`, then
http://localhost:8000/portal/ (it will talk to the real Supabase project).

## Rules of the house

- No build step, ever. No package.json at this level, no bundler, no CDN.
- RLS is the security boundary, not the UI. A new table gets policies in the same change.
- `textContent`, never `innerHTML`, for anything a person typed. All DOM through `el()`.
- The service-role key lives only in Netlify environment variables.
- Bump `?v=` on a stylesheet or module when you change it; nothing fails loudly if you forget.
- Money is integer cents. Dates are `YYYY-MM-DD` strings.
- The business name is Walter Ochenski LLC.
- Anything added at this folder's root is a public URL until `netlify.toml` says
  otherwise. `tools/portal/deploy.test.mjs` fails until it does.
