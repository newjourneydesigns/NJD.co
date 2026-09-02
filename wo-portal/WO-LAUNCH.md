# Launching the Walter Ochenski LLC portal

The code lives in this folder (`wo-portal/`) of the NJD.co repository and deploys as its own
Netlify project. The database is the Supabase project **WO-PORTAL** (`gkzhspoqokjjnvhziivt`,
us-east-2, free tier), which already exists with the schema applied.

Steps marked **[you]** need a login only you have. Everything else is done.

**Time:** about 25 minutes.

---

## 1. Supabase: the one-time settings **[you]**

Sign in at [supabase.com/dashboard](https://supabase.com/dashboard), open **WO-PORTAL**.

1. **Authentication → Sign In / Providers → Email.** Turn **off** "Allow new users to sign up".
   Leave the Email provider itself enabled (password sign-in needs it). Do not configure SMTP:
   the portal never sends mail, and this keeps it that way.
2. **Authentication → Users → Add user → Create new user.**
   - Email: `walter@wo-portal.invalid` — exactly that. It is not a real mailbox. The portal maps
     the username `walter` to it; nothing is ever sent to it.
   - Password: something long. You will change it from the portal header on first sign-in.
   - Tick **Auto Confirm User**. Create.

   The database already holds an owner invite for that address, so this account becomes the
   owner the moment it is created. If the form refuses the address, use
   `walter@wo-portal.local` instead and tell Claude — it is one constant in
   `js/portal/config.js` and one row in `invites`.
3. **Project Settings → API Keys → Secret keys.** You will paste the `sb_secret_…` key into
   Netlify in step 2. It bypasses every security rule in the database: never paste it into a
   file, a commit, or a chat.

## 2. Netlify: the new account and project **[you]**

The portal must not sit in the Valley Creek or New Journey Netlify accounts, so:

1. Go to [app.netlify.com/signup](https://app.netlify.com/signup) and sign up with the address
   you want the LLC's hosting under (GitHub sign-in is fine; a fresh email is fine too).
2. **Add new project → Import an existing project → GitHub.** Authorise Netlify for the
   `newjourneydesigns` GitHub account and pick **NJD.co**.
3. On the configuration screen:
   - **Branch to deploy:** `claude/walter-oshinsky-portal-pq2tql` (until the branch is merged
     to `main`; then change it to `main` under Site configuration → Build & deploy).
   - **Base directory:** `wo-portal` — this one is load-bearing. Without it Netlify deploys the
     repository root, which is a different website.
   - **Build command:** leave empty. **Publish directory:** leave as `wo-portal` (the folder's
     own `netlify.toml` says `publish = "."`, relative to the base directory).
4. **Environment variables** (same screen, or later under Site configuration → Environment
   variables). Add two, scoped to Functions:

   | Variable | Value |
   |---|---|
   | `SUPABASE_URL` | `https://gkzhspoqokjjnvhziivt.supabase.co` |
   | `SUPABASE_SERVICE_ROLE_KEY` | the `sb_secret_…` key from step 1.3, marked **secret** |

   These are only used by `/.netlify/functions/admin-users`, the one server function, which is
   how you create the bookkeeper's sign-in and set passwords. Everything else talks to Supabase
   straight from the browser under Row Level Security.
5. **Deploy.** Then **Site configuration → Site details → Change site name** to something like
   `wo-portal`, so the address is `https://wo-portal.netlify.app`.

## 3. Supabase: tell it the address **[you, 1 minute]**

**Authentication → URL Configuration:** Site URL `https://<your-site>.netlify.app`; Redirect
URLs `https://<your-site>.netlify.app/portal/**` and `http://localhost:8000/portal/**`.
Password sign-in does not depend on these, but anything added later will.

## 4. Check it worked **[you, 5 minutes]**

1. Open `https://<your-site>.netlify.app/`. It should land on the sign-in page with the WO mark.
2. Sign in: username `walter`, the password from step 1.2. You should land on the Dashboard.
3. **Change your password** from the header menu.
4. **Admin → Business details.** Confirm the letterhead. Add your standard hourly rate if you
   bill hours. **Admin → Invoice terms.** Put your ACH details into "How to pay" (this is the
   only place they live; they print on every invoice).
5. **Admin → People → Add person.** Create the bookkeeper: name, a username, role Bookkeeper.
   Copy the generated password from the panel that appears — it is shown once.
6. **Clients → Add client.** Switch Commerce, for a start.
7. **Invoices → New invoice.** Pick the client, add a line, Issue. The print dialog opens;
   choose "Save as PDF". The number will be today's date and `-1`.
8. **Record a payment** on it. The status should flip to Paid.
9. **Expenses → Snap a receipt** from your phone. Then **Reports** for the year.

## If something goes wrong

- **Blank page after sign-in:** open the browser console. A 400 from `/rest/v1/profiles`
  means the schema and the code disagree — tell Claude which column.
- **"Check your username and password":** the account was not created with Auto Confirm, or the
  address differs from the invite. Authentication → Users shows both.
- **Signed in but "Your sign-in is not set up yet":** the account exists with no role. In the
  SQL editor: `update profiles set role = 'owner' where email = 'walter@wo-portal.invalid';`
- **Add person fails with 500 naming a variable:** step 2.4 is incomplete.
- **Add person fails with 403:** you are signed in as the bookkeeper. Only the owner manages
  sign-ins.
- **Locked out of the owner account:** SQL editor, then delete the query from your history:
  ```sql
  update auth.users
     set encrypted_password = extensions.crypt('a-new-long-password', extensions.gen_salt('bf'))
   where email = 'walter@wo-portal.invalid';
  ```
- **Roll back a bad deploy:** Netlify → Deploys → the previous deploy → Publish deploy.

## What is deliberately not here

Email of any kind. Self-serve password reset. Client logins. Contracts, SOWs, e-signatures.
Projects, boards, messages. A double-entry ledger. Stripe. A custom domain (add one later under
Domain management, then update step 3).

## Free tier notes

Supabase pauses a free project after about a week without traffic; the dashboard has a
one-click restore. There are no automatic backups on the free tier, so the **Reports** page's
CSV buttons are your backup — download the year's invoices, payments and expenses now and then.
