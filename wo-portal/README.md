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

## Before you push

```
bash tools/portal/syntax-check.sh
node --test tools/portal/
bash tools/portal/schema-check.sh     # needs postgresql-16 locally
python3 -m http.server 8000           # then open http://localhost:8000/portal/
```

## Rules of the house

- No build step, ever. No package.json at this level, no bundler, no CDN.
- RLS is the security boundary, not the UI. A new table gets policies in the same change.
- `textContent`, never `innerHTML`, for anything a person typed. All DOM through `el()`.
- The service-role key lives only in Netlify environment variables.
- Bump `?v=` on a stylesheet or module when you change it; nothing fails loudly if you forget.
- Money is integer cents. Dates are `YYYY-MM-DD` strings.
- The business name is Walter Ochenski LLC.
