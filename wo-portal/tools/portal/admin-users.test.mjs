// ---------------------------------------------------------------------------
// The pure parts of netlify/functions/admin-users.js — password and email
// validation. Everything network-shaped in that function sits behind
// requireAdmin() and is deliberately not simulated here; what this suite
// pins down is the validation that decides whether a request is even worth
// a round-trip, because those rules are shared by three actions (create,
// set-password, set-email) and drift in one would be invisible in the others.
//
//   node --test tools/portal/*.test.mjs
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { _internal } = require('../../netlify/functions/admin-users.js');
const { validatePassword, parseEmail, MIN_PASSWORD } = _internal;

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

test('parseEmail normalizes case and whitespace', () => {
  assert.equal(parseEmail('  Trip@NewJourneyDesigns.com '), 'trip@newjourneydesigns.com');
  assert.equal(parseEmail('kit@newjourneydesigns.com'), 'kit@newjourneydesigns.com');
});

test('parseEmail rejects what is not an address', () => {
  for (const bad of [null, undefined, '', '   ', 'plainaddress', 'no-dot@domain',
    'two words@example.com', '@example.com', 'name@', 42]) {
    assert.equal(parseEmail(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

// The delete action -----------------------------------------------------------
//
// Deleting a sign-in is the one irreversible thing this endpoint does, and its
// two refusals are the only things standing between a mis-click and a portal
// nobody can administer. Both are server-side because the browser's copy of
// them is a convenience; these tests drive the real handler with fetch stubbed,
// the same way notify-message.test.mjs does, so the guards are checked where
// they actually run.

process.env.SUPABASE_URL = 'https://stub.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'sb_secret_stub';

const { handler } = require('../../netlify/functions/admin-users.js');

const KIT = { id: '00000000-0000-4000-8000-00000000000a', role: 'admin', email: 'kit@njd.com' };
const ERIN = { id: '00000000-0000-4000-8000-00000000000b', role: 'admin', email: 'erin@njd.com' };
const DANA = { id: '00000000-0000-4000-8000-00000000000c', role: 'client', email: 'dana@acme.com' };

/**
 * Drive the handler as Kit, with Supabase stubbed out of `world`.
 *
 * Returns { status, body, deleted } — `deleted` being the user id the auth
 * admin API was actually asked to destroy, or null when it never was. That
 * last one is the assertion that matters: a guard that returns the right error
 * but has already deleted the account is not a guard.
 */
async function callDelete(userId, { profiles = [KIT, ERIN, DANA], caller = KIT } = {}) {
  const realFetch = globalThis.fetch;
  let deleted = null;

  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    const ok = (rows) => ({
      ok: true, status: 200, json: async () => rows, text: async () => JSON.stringify(rows),
    });

    if (target.includes('/auth/v1/user')) return ok({ id: caller.id });

    if (target.includes('/auth/v1/admin/users/')) {
      if (options.method === 'DELETE') {
        deleted = target.slice(target.lastIndexOf('/') + 1);
        return ok({});
      }
      return ok({});
    }

    if (target.includes('/rest/v1/profiles?')) {
      if (target.includes('role=eq.admin')) {
        return ok(profiles.filter((p) => p.role === 'admin'));
      }
      const match = /id=eq\.([^&]+)/.exec(target);
      return ok(match ? profiles.filter((p) => p.id === match[1]) : []);
    }

    return ok([]);
  };

  try {
    const response = await handler({
      httpMethod: 'POST',
      headers: { authorization: 'Bearer stub-token' },
      body: JSON.stringify({ action: 'delete', user_id: userId }),
    });
    return { status: response.statusCode, body: JSON.parse(response.body), deleted };
  } finally {
    globalThis.fetch = realFetch;
  }
}

test('delete destroys the account it was asked to', async () => {
  const { status, body, deleted } = await callDelete(DANA.id);
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.email, 'dana@acme.com');
  assert.equal(deleted, DANA.id);
});

test('delete refuses to delete you', async () => {
  const { status, body, deleted } = await callDelete(KIT.id);
  assert.equal(status, 400);
  assert.match(body.error, /your own account/i);
  // The refusal has to come before the destruction, not after it.
  assert.equal(deleted, null);
});

test('the last admin cannot be reached through this door at all', async () => {
  // Not a guard in the function — an invariant of the two that are. The caller
  // is always an admin and never the target, so an admin target means two
  // admins exist and one survives. Deleting the *only* admin would have to be
  // a self-delete, which is refused above. If somebody ever adds a path that
  // calls deleteUser without requireAdmin, this is the assumption it breaks.
  const { status, body } = await callDelete(KIT.id, { profiles: [KIT, DANA] });
  assert.equal(status, 400);
  assert.match(body.error, /your own account/i);
});

test('delete allows an admin while another admin remains', async () => {
  const { status, deleted } = await callDelete(ERIN.id);
  assert.equal(status, 200);
  assert.equal(deleted, ERIN.id);
});

test('delete rejects a missing or malformed user id', async () => {
  for (const bad of ['', 'not-a-uuid', '12345']) {
    const { status, deleted } = await callDelete(bad);
    assert.equal(status, 400, `expected 400 for ${JSON.stringify(bad)}`);
    assert.equal(deleted, null);
  }
});

test('delete 404s on an account that is already gone', async () => {
  const { status, body, deleted } = await callDelete('00000000-0000-4000-8000-0000000000ff');
  assert.equal(status, 404);
  assert.match(body.error, /no longer exists/i);
  assert.equal(deleted, null);
});
