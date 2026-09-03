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
   Do this one first. It is on by default, which means that until you turn it off, anyone who
   finds the project can create themselves an account. They land with no role and see nothing,
   but there is no reason to let them in the door at all. Leave the Email provider itself
   enabled — password sign-in needs it. Do not configure SMTP: the portal never sends mail, and
   this keeps it that way.

2. **Make your sign-in.** **SQL Editor → New query**, paste this, put your own password in the
   first line, and Run. Then clear the editor so the password is not left in your query history.

   ```sql
   -- Your password. Long, and yours: nobody else ever sees this.
   \set pw 'choose-something-long-here'

   with new_user as (
     insert into auth.users (
       instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
       raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
       confirmation_token, recovery_token, email_change_token_new, email_change
     ) values (
       '00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated',
       'walter@wo-portal.invalid',
       extensions.crypt(:'pw', extensions.gen_salt('bf')), now(),
       '{"provider":"email","providers":["email"]}'::jsonb,
       '{"full_name":"Walter Ochenski"}'::jsonb, now(), now(), '', '', '', ''
     ) returning id
   ), identity as (
     insert into auth.identities (
       id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at
     )
     select gen_random_uuid(), id, id::text,
            jsonb_build_object('sub', id::text, 'email', 'walter@wo-portal.invalid',
                               'email_verified', true),
            'email', now(), now(), now()
       from new_user
     returning user_id
   )
   update profiles set role = 'owner', full_name = 'Walter Ochenski'
    where id = (select user_id from identity);
   ```

   It should report **UPDATE 1**. That address is not a mailbox and never receives anything —
   it is how the username `walter` is stored, because Supabase identifies accounts by an email
   address whether you use one or not.

   Why SQL rather than the dashboard's **Add user** button: that button is fine, but the account
   it makes has no role until something grants one, and the safe ways to grant one all end up
   back in this editor. One statement that creates the account and makes it the owner leaves no
   window in between. Every account after this one you create from **Admin → People** inside the
   portal, which is a form.

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
2. Sign in: username `walter`, the password you chose in step 1.2. You should land on the
   Dashboard. You type `walter`, not an address.
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

## 5. If you want to see it before it is live

Nothing here needs the internet:

```
cd wo-portal
node tools/portal/smoke.mjs          # renders every page in a headless browser
WO_SHOTS=1 node tools/portal/smoke.mjs   # …and writes screenshots to tools/portal/shots/
```

## If something goes wrong

- **Blank page after sign-in:** open the browser console. A 400 from `/rest/v1/profiles`
  means the schema and the code disagree — tell Claude which column.
- **"Check your username and password":** the SQL in step 1.2 did not report UPDATE 1, or the
  address it used differs by a character. Authentication → Users lists what exists.
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
