// ---------------------------------------------------------------------------
// Sign-in management — create an account with a password, set a new password,
// change the username an account signs in with, change its role, or delete it.
//
// This endpoint holds the service-role key, which bypasses Row Level Security
// entirely. Everything else in the portal is safe because Postgres refuses the
// query; this function is safe only because of the check in requireAdmin()
// below. Treat that function as the security boundary it is: an unauthenticated
// caller reaching createUser here could mint themselves an owner account and
// read every client's files. If you change one thing in this file, do not let
// it be that.
//
// Why a function at all: assigning someone else's password needs the Supabase
// Admin API, and that needs the service-role key, and that key can never go in
// a browser. So the browser asks this, and this asks Supabase.
//
// Usernames: Supabase identifies accounts by email address, so a bare
// username is mapped to <handle>@wo-portal.invalid here — the same mapping
// js/portal/client.js applies at the login box. The domain is reserved by RFC
// 2606, never resolves, and nothing is ever mailed to it: every write below
// passes email_confirm so GoTrue's mailer never fires.
//
// Order matters. handle_new_user() in supabase/schema.sql runs on insert into
// auth.users, reads the pending `invites` row for that address, and copies its
// role onto the new profile. With no invite it defaults to 'none', which sees
// nothing. So the invite is written first and the auth user second — and if
// the auth user fails, the invite is rolled back rather than left as a trap
// for whoever signs up with that address next.
//
// SETUP — environment variables (Netlify → Site configuration → Environment
// variables, functions scope):
//
//   SUPABASE_URL               https://<project-ref>.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY  Project Settings → API Keys → the secret key
//                              (`sb_secret_…`), or the legacy service_role JWT.
// ---------------------------------------------------------------------------

const REQUIRED_ENV = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];

// Long enough that a leaked password is not worth guessing, short enough that
// somebody can read it down the phone. The Add-person form generates one by
// default, so this length costs nobody any typing. Mirrored in accounts.js and
// shell.js; this is the copy that enforces it.
const MIN_PASSWORD = 10;
const MAX_PASSWORD = 200;

// profiles.full_name is unbounded text; this cap is only against a caller
// pasting a document into the name box.
const MAX_NAME = 200;

// Must match USERNAME_DOMAIN in js/portal/config.js. Duplicated because this
// file is CommonJS with no build step and cannot import the ES module.
const USERNAME_DOMAIN = 'wo-portal.invalid';

// A username: lower-case letters and digits, with dots, underscores and
// hyphens inside, 2–31 characters. Mirrored as USERNAME_RE in accounts.js.
const HANDLE_RE = /^[a-z0-9][a-z0-9._-]{1,30}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// 'none' is what a stray account lands on, never something to assign.
const ROLES = new Set(['owner', 'staff']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function header(headers, name) {
  if (!headers) return '';
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key] || '';
  }
  return '';
}

function text(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function api(path) {
  return `${process.env.SUPABASE_URL}${path}`;
}

/** Headers that speak as the service role — full access, no RLS. */
function serviceHeaders() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  };
}

// ---------------------------------------------------------------------------
// The security boundary.
//
// Two separate questions, and both have to be answered by the server:
//
//   1. Is this token real? Only Supabase can say. We hand it to /auth/v1/user,
//      which verifies the signature and expiry. We never decode it ourselves —
//      a locally-parsed JWT is just a base64 string a caller chose.
//   2. Is that user the owner? The token says nothing trustworthy about role,
//      because role lives in `profiles`, not in the token. So we read it with
//      the service key. Reading it as the caller would mean asking the person
//      being checked to grade their own paper.
//
// The bookkeeper (role 'staff') is refused here on purpose: sign-ins are the
// owner's, and the profiles policies in the schema say the same thing.
// ---------------------------------------------------------------------------
async function requireAdmin(event) {
  const auth = header(event.headers, 'authorization');
  const token = /^Bearer\s+(.+)$/i.exec(auth || '')?.[1];
  if (!token) return { error: json(401, { error: 'Not signed in' }) };

  let userRes;
  try {
    userRes = await fetch(api('/auth/v1/user'), {
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        // The caller's own token — this is what identifies them. The apikey
        // above only gets the request past the gateway.
        Authorization: `Bearer ${token}`,
      },
    });
  } catch (cause) {
    console.error('admin-users: could not reach Supabase to verify the token', cause);
    return { error: json(502, { error: 'Could not verify your session. Try again.' }) };
  }

  if (!userRes.ok) return { error: json(401, { error: 'Your session has expired. Sign in again.' }) };

  const user = await userRes.json().catch(() => null);
  if (!user || !user.id) return { error: json(401, { error: 'Your session has expired. Sign in again.' }) };

  const profRes = await fetch(
    api(`/rest/v1/profiles?select=id,role,email&id=eq.${encodeURIComponent(user.id)}`),
    { headers: serviceHeaders() },
  );
  if (!profRes.ok) {
    console.error('admin-users: profile lookup failed', profRes.status, await profRes.text());
    return { error: json(502, { error: 'Could not check your account. Try again.' }) };
  }

  const rows = await profRes.json().catch(() => []);
  const profile = Array.isArray(rows) ? rows[0] : null;

  // Deliberately the same message either way. Someone poking at this endpoint
  // learns only that they cannot use it, not whether they have an account.
  if (!profile || profile.role !== 'owner') {
    console.warn(`admin-users: refused a non-owner caller (${user.id})`);
    return { error: json(403, { error: 'Only the owner can manage sign-ins.' }) };
  }

  return { admin: profile };
}

function validatePassword(raw) {
  const password = typeof raw === 'string' ? raw : '';
  if (password.length < MIN_PASSWORD) {
    return `Password must be at least ${MIN_PASSWORD} characters.`;
  }
  if (password.length > MAX_PASSWORD) {
    return 'That password is too long.';
  }
  // Whitespace-only padding passes a length check and fools nobody else.
  if (!password.trim()) return 'Password cannot be only spaces.';
  return null;
}

/**
 * The address an account signs in with, from what the form sent: a bare
 * username becomes <handle>@wo-portal.invalid; a full address is accepted as
 * it is, lower-cased. Null for anything else.
 *
 * The shape check on a full address is deliberately shallow — Supabase
 * applies the real validation when it reaches auth — but it catches the empty
 * and the obviously mangled before a network round-trip is spent on them.
 */
function parseEmail(raw) {
  const value = text(raw)?.toLowerCase() || null;
  if (!value) return null;
  if (HANDLE_RE.test(value)) return `${value}@${USERNAME_DOMAIN}`;
  if (EMAIL_RE.test(value)) return value;
  return null;
}

/** The username to show back: the part before the synthetic domain. */
function handleOf(email) {
  const suffix = `@${USERNAME_DOMAIN}`;
  return email.endsWith(suffix) ? email.slice(0, -suffix.length) : email;
}

/** One profile row by id, or null. `false` when the lookup itself failed. */
async function findProfile(userId) {
  const res = await fetch(
    api(`/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=id,email,role`),
    { headers: serviceHeaders() },
  );
  if (!res.ok) {
    console.error('admin-users: profile lookup failed', res.status, await res.text());
    return false;
  }
  const rows = await res.json().catch(() => []);
  return (Array.isArray(rows) && rows[0]) || null;
}

/** How many owner sign-ins exist. Null when the count could not be read. */
async function countOwners() {
  const res = await fetch(
    api('/rest/v1/profiles?select=id&role=eq.owner'),
    { headers: serviceHeaders() },
  );
  if (!res.ok) {
    console.error('admin-users: owner count failed', res.status, await res.text());
    return null;
  }
  const rows = await res.json().catch(() => null);
  return Array.isArray(rows) ? rows.length : null;
}

// ---------------------------------------------------------------------------
// create — an invite (so the trigger knows the role) then the account itself.
// ---------------------------------------------------------------------------
async function createUser(body, admin) {
  const email = parseEmail(body.username ?? body.email);
  const role = text(body.role) || 'staff';
  const fullName = text(body.full_name);

  if (!email) {
    return json(400, { error: 'Enter a username: letters and digits, dots, dashes or underscores.' });
  }
  if (!ROLES.has(role)) return json(400, { error: 'Unknown role.' });
  if (fullName && fullName.length > MAX_NAME) {
    return json(400, { error: 'That name is too long.' });
  }

  const badPassword = validatePassword(body.password);
  if (badPassword) return json(400, { error: badPassword });

  // 1. The invite. A pending one for this address may already exist (the
  //    seeded owner invite, or a create that failed halfway); reuse it rather
  //    than failing, so the two can coexist.
  const inviteRow = { email, role, invited_by: admin.id };

  // No plain-column upsert is possible here: the only unique index on invites
  // is partial and on an expression — unique (lower(email)) where consumed_at
  // is null — which PostgREST's on_conflict cannot target. So: insert, and fall
  // back to patching the pending row if one already exists.
  let invite = null;

  const inviteRes = await fetch(api('/rest/v1/invites'), {
    method: 'POST',
    headers: { ...serviceHeaders(), Prefer: 'return=representation' },
    body: JSON.stringify(inviteRow),
  });

  if (inviteRes.ok) {
    const rows = await inviteRes.json().catch(() => []);
    invite = Array.isArray(rows) ? rows[0] : null;
  } else {
    // A pending invite for this address already exists (23505). Point it at the
    // role we were just asked for rather than silently honouring the older one.
    const patch = await fetch(
      api(`/rest/v1/invites?email=eq.${encodeURIComponent(email)}&consumed_at=is.null`),
      {
        method: 'PATCH',
        headers: { ...serviceHeaders(), Prefer: 'return=representation' },
        body: JSON.stringify({ role, invited_by: admin.id }),
      },
    );
    const rows = patch.ok ? await patch.json().catch(() => []) : [];
    invite = Array.isArray(rows) ? rows[0] : null;
  }

  // Stop if neither path produced one. Creating the account anyway is the worst
  // outcome available: handle_new_user() would find no invite, default the
  // profile to 'none', and hand back an account that signs in successfully and
  // shows the not-set-up screen — which reads as a broken product rather than
  // a failed request.
  if (!invite || !invite.id) {
    console.error('admin-users: could not write an invite for', email);
    return json(502, { error: 'Could not prepare the account. Nothing was changed.' });
  }

  // 2. The account. email_confirm short-circuits the confirmation email — the
  //    owner assigning a password has already established who this is, and
  //    the address could not receive one anyway. The name travels as user
  //    metadata because that is where handle_new_user() reads it from when it
  //    writes the profile row.
  const createRes = await fetch(api('/auth/v1/admin/users'), {
    method: 'POST',
    headers: serviceHeaders(),
    body: JSON.stringify({
      email,
      password: body.password,
      email_confirm: true,
      ...(fullName ? { user_metadata: { full_name: fullName } } : {}),
    }),
  });

  if (!createRes.ok) {
    const detail = await createRes.text();
    // Roll the invite back. Leaving it would quietly hand this role to whoever
    // next signs up with that address.
    await fetch(api(`/rest/v1/invites?id=eq.${encodeURIComponent(invite.id)}`), {
      method: 'DELETE',
      headers: serviceHeaders(),
    }).catch(() => {});
    console.error('admin-users: createUser failed', createRes.status, detail);
    if (/already been registered|already exists|duplicate/i.test(detail)) {
      return json(409, {
        error: 'There is already a sign-in with that username. Open that person '
             + 'under Admin → People instead.',
      });
    }
    if (/password/i.test(detail)) {
      return json(400, { error: 'Supabase rejected that password. Try a longer one.' });
    }
    return json(502, { error: 'Could not create the account. Nothing was changed.' });
  }

  const created = await createRes.json().catch(() => null);
  console.log(`admin-users: ${admin.email} created ${email} as ${role}`);
  return json(200, {
    ok: true, user_id: created && created.id, email, username: handleOf(email), role,
  });
}

// ---------------------------------------------------------------------------
// set-password — for a forgotten password, or a first password on an account
// that predates this flow.
// ---------------------------------------------------------------------------
async function setPassword(body, admin) {
  const userId = text(body.user_id);
  if (!userId || !UUID_RE.test(userId)) return json(400, { error: 'Which account? No valid user id was sent.' });

  const badPassword = validatePassword(body.password);
  if (badPassword) return json(400, { error: badPassword });

  const res = await fetch(api(`/auth/v1/admin/users/${encodeURIComponent(userId)}`), {
    method: 'PUT',
    headers: serviceHeaders(),
    body: JSON.stringify({ password: body.password }),
  });

  if (!res.ok) {
    const detail = await res.text();
    console.error('admin-users: setPassword failed', res.status, detail);
    if (res.status === 404) return json(404, { error: 'That account no longer exists.' });
    if (/password/i.test(detail)) return json(400, { error: 'Supabase rejected that password. Try a longer one.' });
    return json(502, { error: 'Could not set the password. Nothing was changed.' });
  }

  console.log(`admin-users: ${admin.email} set a new password for ${userId}`);
  return json(200, { ok: true, user_id: userId });
}

// ---------------------------------------------------------------------------
// set-username — the address an account signs in with. It lives in auth.users;
// profiles.email is a mirror the UI reads. Auth goes first and the mirror
// second, because a failure in between leaves the display stale but sign-in
// correct — the recoverable side to be stranded on.
//
// GoTrue's admin route for updating a user is PUT /auth/v1/admin/users/:id
// (the SDK's updateUserById sends the same); there is no PATCH.
// ---------------------------------------------------------------------------
async function setUsername(body, admin) {
  const userId = text(body.user_id);
  if (!userId || !UUID_RE.test(userId)) return json(400, { error: 'Which account? No valid user id was sent.' });

  const email = parseEmail(body.username ?? body.email);
  if (!email) {
    return json(400, { error: 'Enter a username: letters and digits, dots, dashes or underscores.' });
  }

  const res = await fetch(api(`/auth/v1/admin/users/${encodeURIComponent(userId)}`), {
    method: 'PUT',
    headers: serviceHeaders(),
    // email_confirm for the same reason create sets it: the owner typing the
    // username has already established whose it is, and a "confirm your new
    // address" email would strand the account half-moved — and could not be
    // delivered anyway.
    body: JSON.stringify({ email, email_confirm: true }),
  });

  if (!res.ok) {
    const detail = await res.text();
    console.error('admin-users: setUsername failed', res.status, detail);
    if (res.status === 404) return json(404, { error: 'That account no longer exists.' });
    if (/already been registered|already exists|duplicate/i.test(detail)) {
      return json(409, { error: 'Another account already signs in with that username.' });
    }
    return json(502, { error: 'Could not change the username. Nothing was changed.' });
  }

  const mirror = await fetch(api(`/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}`), {
    method: 'PATCH',
    headers: serviceHeaders(),
    body: JSON.stringify({ email }),
  });

  if (!mirror.ok) {
    // The sign-in already changed; saying "nothing changed" here would be a
    // lie that costs someone a locked-out morning.
    console.error('admin-users: setUsername mirror failed', mirror.status, await mirror.text());
    return json(502, {
      error: 'The username changed, but the list still shows the old one. Reload the page and check.',
    });
  }

  console.log(`admin-users: ${admin.email} changed the username on ${userId} to ${email}`);
  return json(200, { ok: true, user_id: userId, email, username: handleOf(email) });
}

// ---------------------------------------------------------------------------
// set-role — owner or staff. profiles.role is the whole authorization story
// for the browser (is_admin() and is_owner() in the schema read it), so the
// two refusals here are the ones that keep the portal administrable:
//
//   * not your own role. Demoting yourself mid-session leaves a live token
//     pointed at a profile that can no longer reach this endpoint to undo it.
//   * not the last owner. With no owner left nobody can reach this endpoint
//     at all, and the fix is SQL in the Supabase dashboard.
//
// The service key bypasses the guard_profile_privileges trigger (auth.uid()
// is null for it), which is why the guards live here as well as there.
// ---------------------------------------------------------------------------
async function setRole(body, admin) {
  const userId = text(body.user_id);
  if (!userId || !UUID_RE.test(userId)) return json(400, { error: 'Which account? No valid user id was sent.' });

  const role = text(body.role);
  if (!role || !ROLES.has(role)) return json(400, { error: 'Unknown role.' });

  if (userId === admin.id) {
    return json(400, { error: 'You cannot change your own role. Ask another owner to do it.' });
  }

  const target = await findProfile(userId);
  if (target === false) return json(502, { error: 'Could not look that account up. Nothing was changed.' });
  if (!target) return json(404, { error: 'That account no longer exists.' });

  if (target.role === 'owner' && role !== 'owner') {
    const owners = await countOwners();
    if (owners === null) return json(502, { error: 'Could not check the owners. Nothing was changed.' });
    if (owners <= 1) {
      return json(400, { error: 'That is the only owner. Make somebody else an owner first.' });
    }
  }

  const res = await fetch(api(`/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}`), {
    method: 'PATCH',
    headers: { ...serviceHeaders(), Prefer: 'return=representation' },
    body: JSON.stringify({ role }),
  });

  if (!res.ok) {
    console.error('admin-users: setRole failed', res.status, await res.text());
    return json(502, { error: 'Could not change the role. Nothing was changed.' });
  }

  console.log(`admin-users: ${admin.email} made ${target.email} ${role}`);
  return json(200, { ok: true, user_id: userId, role });
}

// ---------------------------------------------------------------------------
// delete — destroy a sign-in.
//
// The one irreversible action this endpoint has. Deleting the auth user is
// enough on its own: profiles.id references auth.users on delete cascade, and
// every table that names a person (created_by, author_id, uploaded_by,
// invited_by) is `on delete set null` — the records stay, the byline goes. So
// nothing a client's file depends on disappears with the account, and nothing
// here can fail on a foreign key.
//
// Two guards, server-side because a browser check is not a boundary: you may
// not delete yourself, and you may not delete the last owner. The second
// cannot actually be reached through this door — the caller is always an
// owner (requireAdmin) and never the target — but it is cheap, and it is the
// assumption a future caller of deleteUser would otherwise break silently.
// ---------------------------------------------------------------------------
async function deleteUser(body, admin) {
  const userId = text(body.user_id);
  if (!userId || !UUID_RE.test(userId)) {
    return json(400, { error: 'Which account? No valid user id was sent.' });
  }

  if (userId === admin.id) {
    return json(400, {
      error: 'You cannot delete your own account. Ask another owner to do it.',
    });
  }

  const target = await findProfile(userId);
  if (target === false) return json(502, { error: 'Could not look that account up. Nothing was deleted.' });
  if (!target) return json(404, { error: 'That account no longer exists.' });

  if (target.role === 'owner') {
    const owners = await countOwners();
    if (owners === null) return json(502, { error: 'Could not check the owners. Nothing was deleted.' });
    if (owners <= 1) {
      return json(400, { error: 'That is the only owner. Make somebody else an owner first.' });
    }
  }

  const res = await fetch(api(`/auth/v1/admin/users/${encodeURIComponent(userId)}`), {
    method: 'DELETE',
    headers: serviceHeaders(),
  });

  if (!res.ok) {
    const detail = await res.text();
    console.error('admin-users: deleteUser failed', res.status, detail);
    if (res.status === 404) return json(404, { error: 'That account no longer exists.' });
    return json(502, { error: 'Could not delete the account. Nothing was changed.' });
  }

  // Loud on purpose. This is the one call here that cannot be undone, and the
  // log line is the only record that it happened.
  console.log(`admin-users: ${admin.email} DELETED account ${target.email} (${userId})`);
  return json(200, { ok: true, user_id: userId, email: target.email });
}

exports.handler = async (event) => {
  const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
  if (missing.length) {
    console.error(`admin-users: missing ${missing.join(', ')}`);
    return json(500, { error: `admin-users is not configured: missing ${missing.join(', ')}` });
  }

  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  // Authorize before parsing anything. A caller who cannot use this endpoint
  // should not get to exercise the parser either.
  const { admin, error } = await requireAdmin(event);
  if (error) return error;

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Body is not valid JSON' });
  }
  if (!body || typeof body !== 'object') return json(400, { error: 'Body is not valid JSON' });

  switch (body.action) {
    case 'create': return createUser(body, admin);
    case 'set-password': return setPassword(body, admin);
    case 'set-username': return setUsername(body, admin);
    case 'set-role': return setRole(body, admin);
    case 'delete': return deleteUser(body, admin);
    default: return json(400, { error: 'Unknown action.' });
  }
};

// Exported for the test suite, which drives the pure parts without a network.
exports._internal = {
  validatePassword, parseEmail, handleOf, MIN_PASSWORD, USERNAME_DOMAIN, ROLES: [...ROLES],
};
