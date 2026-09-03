// ---------------------------------------------------------------------------
// netlify/functions/admin-users.js — the pure parts, and the handler with
// Supabase stubbed out.
//
//   node --test tools/portal/*.test.mjs
//
// The pure parts first: password and username validation, because those
// rules are shared by four actions and drift in one would be invisible in the
// others. Then the handler itself, driven with fetch replaced by a small
// in-memory Supabase: the guards that keep the portal administrable (not
// yourself, not the last owner) are server-side because a browser check is a
// convenience, and this is where they actually run. No network anywhere.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// The env has to be set before the handler is first invoked, not before the
// module loads — the check runs per request, which is what the 500 test below
// relies on.
process.env.SUPABASE_URL = 'https://stub.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'sb_secret_stub';

const { handler, _internal } = require('../../netlify/functions/admin-users.js');
const { validatePassword, parseEmail, handleOf, MIN_PASSWORD, USERNAME_DOMAIN, ROLES } = _internal;

// Validation -----------------------------------------------------------------

test('validatePassword accepts a reasonable password', () => {
  assert.equal(validatePassword('correct-horse-battery'), null);
  assert.equal(validatePassword('a'.repeat(MIN_PASSWORD)), null);
});

test('validatePassword rejects short, missing, padded, and absurd', () => {
  assert.ok(validatePassword('short'));
  assert.ok(validatePassword(''));
  assert.ok(validatePassword(null));
  assert.ok(validatePassword(undefined));
  // Long enough by count, nothing but spaces — fools the length check only.
  assert.ok(validatePassword(' '.repeat(MIN_PASSWORD + 2)));
  assert.ok(validatePassword('x'.repeat(201)));
});

test('the minimum password length agrees with the browser', () => {
  assert.equal(MIN_PASSWORD, 10);
});

test('parseEmail maps a bare username to the synthetic domain', () => {
  assert.equal(USERNAME_DOMAIN, 'wo-portal.invalid');
  assert.equal(parseEmail('walter'), 'walter@wo-portal.invalid');
  assert.equal(parseEmail('  Walter '), 'walter@wo-portal.invalid');
  assert.equal(parseEmail('books.2026'), 'books.2026@wo-portal.invalid');
  assert.equal(parseEmail('dana-w_1'), 'dana-w_1@wo-portal.invalid');
});

test('parseEmail still takes a full address, lower-cased', () => {
  assert.equal(parseEmail('  Trip@Example.com '), 'trip@example.com');
});

test('parseEmail rejects what is neither a username nor an address', () => {
  for (const bad of [null, undefined, '', '   ', 'a', '.lead', '-lead', 'two words',
    'x'.repeat(32), 'no-dot@domain', '@example.com', 'name@', 42, 'wal ter']) {
    assert.equal(parseEmail(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test('handleOf undoes the mapping, and leaves a real address alone', () => {
  assert.equal(handleOf('walter@wo-portal.invalid'), 'walter');
  assert.equal(handleOf('trip@example.com'), 'trip@example.com');
});

test('the roles that can be assigned are owner and staff, never none', () => {
  assert.deepEqual([...ROLES].sort(), ['owner', 'staff']);
});

// The handler ------------------------------------------------------------------

const WALTER = { id: '00000000-0000-4000-8000-00000000000a', role: 'owner', email: 'walter@wo-portal.invalid' };
const SECOND = { id: '00000000-0000-4000-8000-00000000000b', role: 'owner', email: 'second@wo-portal.invalid' };
const BOOKS = { id: '00000000-0000-4000-8000-00000000000c', role: 'staff', email: 'books@wo-portal.invalid' };
const STRAY = { id: '00000000-0000-4000-8000-00000000000d', role: 'none', email: 'stray@wo-portal.invalid' };
const GONE = '00000000-0000-4000-8000-0000000000ff';

/**
 * Drive the handler as `caller`, with Supabase stubbed out of `profiles`.
 *
 * Returns { status, body, calls } — `calls` being every request the function
 * made, in order, as { method, path, body }. The order is an assertion in its
 * own right: the invite before the user, the auth change before the mirror,
 * and never a DELETE after a refusal.
 *
 * `failCreate` makes the auth create fail with the given text, so the invite
 * rollback can be seen. `owners` overrides what the owner-count query returns,
 * for the one guard that can only be reached by a world that changed under
 * the caller's feet.
 */
async function drive(body, {
  profiles = [WALTER, SECOND, BOOKS, STRAY], caller = WALTER, failCreate = null, owners = null,
  headers = { authorization: 'Bearer stub-token' },
} = {}) {
  const realFetch = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    const path = target.replace(process.env.SUPABASE_URL, '');
    const method = options.method || 'GET';
    const sent = options.body ? JSON.parse(options.body) : null;
    calls.push({ method, path, body: sent });

    const ok = (rows, status = 200) => ({
      ok: true, status, json: async () => rows, text: async () => JSON.stringify(rows),
    });
    const fail = (status, text) => ({
      ok: false, status, json: async () => ({ msg: text }), text: async () => text,
    });

    if (path.startsWith('/auth/v1/user')) return ok({ id: caller.id });

    if (path === '/auth/v1/admin/users' && method === 'POST') {
      if (failCreate) return fail(422, failCreate);
      return ok({ id: '00000000-0000-4000-8000-0000000000ee', email: sent.email });
    }

    if (path.startsWith('/auth/v1/admin/users/')) {
      const id = decodeURIComponent(path.slice('/auth/v1/admin/users/'.length));
      if (!profiles.some((p) => p.id === id)) return fail(404, 'User not found');
      return ok({ id });
    }

    if (path.startsWith('/rest/v1/profiles?')) {
      if (path.includes('role=eq.owner')) {
        return ok(owners || profiles.filter((p) => p.role === 'owner'));
      }
      const match = /id=eq\.([^&]+)/.exec(path);
      const rows = match ? profiles.filter((p) => p.id === decodeURIComponent(match[1])) : [];
      return ok(rows);
    }

    if (path.startsWith('/rest/v1/invites')) {
      if (method === 'POST') return ok([{ id: 'invite-1', ...sent }]);
      return ok([]);
    }

    return ok([]);
  };

  try {
    const response = await handler({
      httpMethod: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    return { status: response.statusCode, body: JSON.parse(response.body), calls };
  } finally {
    globalThis.fetch = realFetch;
  }
}

/** The user id the auth admin API was asked to destroy, or null. A guard
 *  that returns the right error but has already deleted the account is not
 *  a guard. */
function deletedBy(calls) {
  const hit = calls.find((c) => c.method === 'DELETE' && c.path.startsWith('/auth/v1/admin/users/'));
  return hit ? hit.path.slice(hit.path.lastIndexOf('/') + 1) : null;
}

test('the function 500s naming the missing environment variable', async () => {
  const saved = process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    const response = await handler({ httpMethod: 'POST', headers: {}, body: '{}' });
    assert.equal(response.statusCode, 500);
    assert.match(JSON.parse(response.body).error, /SUPABASE_SERVICE_ROLE_KEY/);
  } finally {
    process.env.SUPABASE_SERVICE_ROLE_KEY = saved;
  }
});

test('anything but POST is refused, and so is a caller with no token', async () => {
  const response = await handler({ httpMethod: 'GET', headers: {}, body: '' });
  assert.equal(response.statusCode, 405);

  const { status } = await drive({ action: 'delete', user_id: BOOKS.id }, { headers: {} });
  assert.equal(status, 401);
});

test('only the owner can use this endpoint — the bookkeeper is refused', async () => {
  const { status, body, calls } = await drive(
    { action: 'delete', user_id: STRAY.id }, { caller: BOOKS });
  assert.equal(status, 403);
  assert.equal(body.error, 'Only the owner can manage sign-ins.');
  assert.equal(deletedBy(calls), null);
});

// create ---------------------------------------------------------------------

test('create writes the invite first, then the account, with email_confirm', async () => {
  const { status, body, calls } = await drive({
    action: 'create', username: 'Dana', full_name: 'Dana Whitfield', role: 'staff',
    password: 'correct-horse-battery',
  });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.email, 'dana@wo-portal.invalid');
  assert.equal(body.username, 'dana');
  assert.equal(body.role, 'staff');

  const invite = calls.find((c) => c.method === 'POST' && c.path.startsWith('/rest/v1/invites'));
  const user = calls.find((c) => c.method === 'POST' && c.path === '/auth/v1/admin/users');
  assert.ok(invite, 'an invite was written');
  assert.ok(user, 'an auth user was created');
  assert.ok(calls.indexOf(invite) < calls.indexOf(user), 'the invite goes first — the trigger reads it');
  assert.deepEqual(invite.body, { email: 'dana@wo-portal.invalid', role: 'staff', invited_by: WALTER.id });
  assert.equal(user.body.email_confirm, true, 'no confirmation email, ever');
  assert.equal(user.body.password, 'correct-horse-battery');
  assert.deepEqual(user.body.user_metadata, { full_name: 'Dana Whitfield' });
  assert.ok(!('client_id' in invite.body), 'nothing here knows about clients');
});

test('create rolls the invite back when the account cannot be made', async () => {
  const { status, body, calls } = await drive(
    { action: 'create', username: 'dana', role: 'staff', password: 'correct-horse-battery' },
    { failCreate: 'A user with this email address has already been registered' });
  assert.equal(status, 409);
  assert.match(body.error, /already a sign-in with that username/i);
  const rollback = calls.find((c) => c.method === 'DELETE' && c.path.includes('/rest/v1/invites?id=eq.invite-1'));
  assert.ok(rollback, 'the invite was deleted rather than left as a trap');
});

test('create refuses a bad username, an unknown role, and a weak password', async () => {
  let out = await drive({ action: 'create', username: 'two words', role: 'staff', password: 'correct-horse-battery' });
  assert.equal(out.status, 400);
  assert.match(out.body.error, /username/i);

  out = await drive({ action: 'create', username: 'dana', role: 'admin', password: 'correct-horse-battery' });
  assert.equal(out.status, 400);
  assert.match(out.body.error, /unknown role/i);

  out = await drive({ action: 'create', username: 'dana', role: 'none', password: 'correct-horse-battery' });
  assert.equal(out.status, 400, "'none' is not a role anybody is given");

  out = await drive({ action: 'create', username: 'dana', role: 'staff', password: 'short' });
  assert.equal(out.status, 400);
  assert.match(out.body.error, /at least 10/);
  assert.equal(out.calls.some((c) => c.method === 'POST' && c.path !== '/auth/v1/user'), false,
    'nothing was written');
});

// set-username ---------------------------------------------------------------

test('set-username changes auth first and mirrors it to the profile second', async () => {
  const { status, body, calls } = await drive({ action: 'set-username', user_id: BOOKS.id, username: 'Ledger' });
  assert.equal(status, 200);
  assert.equal(body.username, 'ledger');
  assert.equal(body.email, 'ledger@wo-portal.invalid');

  const auth = calls.find((c) => c.method === 'PUT' && c.path.startsWith('/auth/v1/admin/users/'));
  const mirror = calls.find((c) => c.method === 'PATCH' && c.path.startsWith('/rest/v1/profiles?'));
  assert.ok(auth && mirror);
  assert.ok(calls.indexOf(auth) < calls.indexOf(mirror));
  assert.deepEqual(auth.body, { email: 'ledger@wo-portal.invalid', email_confirm: true });
  assert.deepEqual(mirror.body, { email: 'ledger@wo-portal.invalid' });
});

test('set-username 404s on an account that is gone', async () => {
  const { status } = await drive({ action: 'set-username', user_id: GONE, username: 'ghost' });
  assert.equal(status, 404);
});

// set-password ---------------------------------------------------------------

test('set-password sends the new password to the auth admin API', async () => {
  const { status, calls } = await drive({ action: 'set-password', user_id: BOOKS.id, password: 'correct-horse-battery' });
  assert.equal(status, 200);
  const auth = calls.find((c) => c.method === 'PUT' && c.path.endsWith(BOOKS.id));
  assert.deepEqual(auth.body, { password: 'correct-horse-battery' });
});

// set-role -------------------------------------------------------------------

test('set-role patches the profile', async () => {
  const { status, body, calls } = await drive({ action: 'set-role', user_id: BOOKS.id, role: 'owner' });
  assert.equal(status, 200);
  assert.equal(body.role, 'owner');
  const patch = calls.find((c) => c.method === 'PATCH');
  assert.ok(patch.path.includes(`id=eq.${BOOKS.id}`));
  assert.deepEqual(patch.body, { role: 'owner' });
});

test('set-role refuses your own role', async () => {
  const { status, body, calls } = await drive({ action: 'set-role', user_id: WALTER.id, role: 'staff' });
  assert.equal(status, 400);
  assert.match(body.error, /your own role/i);
  assert.equal(calls.some((c) => c.method === 'PATCH'), false);
});

test('set-role refuses to demote the last owner', async () => {
  // The caller is an owner and never the target, so in a consistent world an
  // owner target means two owners exist. The guard is for the world that
  // changed between the auth check and the count — and for any future caller
  // that reaches setRole without requireAdmin.
  const { status, body, calls } = await drive(
    { action: 'set-role', user_id: SECOND.id, role: 'staff' }, { owners: [SECOND] });
  assert.equal(status, 400);
  assert.match(body.error, /only owner/i);
  assert.equal(calls.some((c) => c.method === 'PATCH'), false);
});

test('set-role lets an owner step down while another remains', async () => {
  const { status } = await drive({ action: 'set-role', user_id: SECOND.id, role: 'staff' });
  assert.equal(status, 200);
});

test('set-role refuses a role that is not one of ours', async () => {
  for (const role of ['none', 'admin', 'client', '']) {
    const { status } = await drive({ action: 'set-role', user_id: BOOKS.id, role });
    assert.equal(status, 400, `expected 400 for role ${JSON.stringify(role)}`);
  }
});

// delete ---------------------------------------------------------------------

test('delete destroys the account it was asked to', async () => {
  const { status, body, calls } = await drive({ action: 'delete', user_id: BOOKS.id });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.email, BOOKS.email);
  assert.equal(deletedBy(calls), BOOKS.id);
});

test('delete refuses to delete you', async () => {
  const { status, body, calls } = await drive({ action: 'delete', user_id: WALTER.id });
  assert.equal(status, 400);
  assert.match(body.error, /your own account/i);
  // The refusal has to come before the destruction, not after it.
  assert.equal(deletedBy(calls), null);
});

test('delete refuses the last owner', async () => {
  const { status, body, calls } = await drive(
    { action: 'delete', user_id: SECOND.id }, { owners: [SECOND] });
  assert.equal(status, 400);
  assert.match(body.error, /only owner/i);
  assert.equal(deletedBy(calls), null);
});

test('delete allows an owner while another owner remains', async () => {
  const { status, calls } = await drive({ action: 'delete', user_id: SECOND.id });
  assert.equal(status, 200);
  assert.equal(deletedBy(calls), SECOND.id);
});

test('delete rejects a missing or malformed user id', async () => {
  for (const bad of ['', 'not-a-uuid', '12345']) {
    const { status, calls } = await drive({ action: 'delete', user_id: bad });
    assert.equal(status, 400, `expected 400 for ${JSON.stringify(bad)}`);
    assert.equal(deletedBy(calls), null);
  }
});

test('delete 404s on an account that is already gone', async () => {
  const { status, body, calls } = await drive({ action: 'delete', user_id: GONE });
  assert.equal(status, 404);
  assert.match(body.error, /no longer exists/i);
  assert.equal(deletedBy(calls), null);
});

test('an unknown action is a 400, and set-email is no longer one of ours', async () => {
  const { status } = await drive({ action: 'set-email', user_id: BOOKS.id, email: 'x@y.z' });
  assert.equal(status, 400);
});
