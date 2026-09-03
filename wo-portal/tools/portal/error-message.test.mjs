// ---------------------------------------------------------------------------
// client.js — the pure parts: what a person is allowed to be shown when
// something fails, and the four small decisions every page leans on.
//
//   node --test tools/portal/*.test.mjs
//
// errorMessage is routed through by every write in the portal. The two rules
// worth holding on to are pulled out as their own tests, because both are
// easy to break by making the function "simpler":
//
//   1. A message that is already in English survives a second pass. The portal
//      does `throw new Error(errorMessage(err))` and then calls errorMessage
//      again on the Error it just made, so idempotence is not a nicety —
//      without it every hand-written validation line turns into "Something
//      went wrong."
//   2. A message that is Postgres talking never reaches a screen, even when
//      nobody has written a translation for it yet. A `raise exception` from
//      one of the schema's own triggers is the exception: it was written for
//      a person and passes through.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  errorMessage, usernameToEmail, isAdmin, isOwner, safeNext,
} from '../../js/portal/client.js';
import { USERNAME_DOMAIN } from '../../js/portal/config.js';

const FALLBACK = 'Something went wrong.';

test('no error at all gives the fallback', () => {
  assert.equal(errorMessage(null), FALLBACK);
  assert.equal(errorMessage(undefined), FALLBACK);
  assert.equal(errorMessage(null, 'Could not load the invoice.'),
    'Could not load the invoice.');
});

test('SQLSTATE codes are translated, and beat whatever the message says', () => {
  const cases = [
    ['23505', 'duplicate key value violates unique constraint "vendors_name_idx"'],
    ['23503', 'update or delete on table "clients" violates foreign key constraint "invoices_client_id_fkey"'],
    ['23502', 'null value in column "category_id" of relation "expenses" violates not-null constraint'],
    ['23514', 'new row for relation "invoices" violates check constraint "invoices_number_shape"'],
    ['22001', 'value too long for type character varying(120)'],
    ['22P02', 'invalid input syntax for type uuid: "not-a-uuid"'],
    ['42501', 'permission denied for table profiles'],
    ['PGRST116', 'JSON object requested, multiple (or no) rows returned'],
  ];
  for (const [code, message] of cases) {
    const out = errorMessage({ code, message });
    assert.notEqual(out, message, `${code} leaked its raw message`);
    // The point of the mapping is a message that says something. Withholding
    // the raw string is the safety net underneath it, and the net alone would
    // satisfy every other assertion here — so require more than the net.
    assert.notEqual(out, FALLBACK,
      `${code} is not actually translated; it is only being caught by the fallback`);
    assert.equal(out, out.trim());
    assert.match(out, /^[A-Z]/, `${code} should read like a sentence`);
    assert.match(out, /\.$/, `${code} should end in a full stop`);
    assert.ok(!/constraint|relation "|column "|varying\(|uuid|PGRST/i.test(out),
      `${code} leaked database vocabulary: ${out}`);
  }
});

test('the four the contract names say what they promise', () => {
  assert.match(errorMessage({ code: '23503', message: 'x' }), /still refers to this/i);
  assert.match(errorMessage({ code: '23505', message: 'x' }), /already exists/i);
  assert.match(errorMessage({ code: 'PGRST116', message: 'x' }), /not found/i);
  assert.equal(errorMessage({ code: '42501', message: 'x' }),
    'You do not have permission to do that.');
});

test('the hand-written cases still win', () => {
  assert.equal(
    errorMessage({ message: 'new row violates row-level security policy for table "invites"' }),
    'You do not have permission to do that.');
  assert.equal(
    errorMessage({ message: 'JWT expired' }),
    'Your session expired. Please sign in again.');
  assert.equal(
    errorMessage({ message: 'Failed to fetch' }),
    'Could not reach the server. Check your connection and try again.');
});

// Rule 1. Break this and every validation message becomes "Something went wrong."
test('a message already written for a person passes through unchanged', () => {
  const human = [
    'That is not a number of days.',
    'This client no longer exists.',
    'That hourly rate is not an amount. Leave it blank until there is one.',
    'Nothing was deleted.',
    'Only the owner can manage sign-ins.',
  ];
  for (const message of human) {
    assert.equal(errorMessage({ message }), message);
    assert.equal(errorMessage(new Error(message)), message);
  }
});

test('what the schema raises for a person passes through too', () => {
  // These are the `raise exception` texts in supabase/schema.sql, arriving
  // from PostgREST with SQLSTATE P0001 and the text as the message.
  const raised = [
    'This invoice has been issued. Void it and raise a new one instead of editing it.',
    'That invoice is still a draft. Issue it before recording a payment against it.',
    'That invoice is already issued.',
    'Only the owner can change a role',
    'Invoice 20260901-1 does not add up: its lines and tax come to $100.00 but the invoice says $99.00. Fix it before issuing it.',
  ];
  for (const message of raised) {
    assert.equal(errorMessage({ code: 'P0001', message }), message);
  }
});

test('applying it twice changes nothing — the portal does exactly that', () => {
  const inputs = [
    { code: '23505', message: 'duplicate key value violates unique constraint "x_key"' },
    { message: 'new row violates row-level security policy for table "invites"' },
    { message: 'That is not a number of days.' },
    { message: 'relation "public.nope" does not exist' },
    null,
  ];
  for (const input of inputs) {
    const once = errorMessage(input);
    assert.equal(errorMessage(new Error(once)), once,
      `not idempotent for ${JSON.stringify(input)}`);
  }
});

// Rule 2. This is the one a person would otherwise see.
test('an unmapped database error is withheld rather than printed', () => {
  const leaks = [
    'duplicate key value violates unique constraint "expense_receipts_path_idx"',
    'null value in column "name" of relation "clients" violates not-null constraint',
    'relation "public.projects" does not exist',
    'column "archived_at" of relation "clients" does not exist',
    'permission denied for sequence invoices_number_seq',
    'syntax error at or near ")"',
    'invalid input syntax for type date: ""',
    'value too long for type character varying(64)',
    'function public.post_payment(uuid) does not exist',
  ];
  for (const message of leaks) {
    const out = errorMessage({ message });
    assert.equal(out, FALLBACK, `leaked to the screen: ${message}`);
  }
});

test('the caller\'s own fallback is used when the raw message is withheld', () => {
  const out = errorMessage(
    { message: 'null value in column "name" of relation "clients" violates not-null constraint' },
    'Could not save that client.');
  assert.equal(out, 'Could not save that client.');
});

test('an empty error object gives the fallback rather than an empty string', () => {
  assert.equal(errorMessage({}), FALLBACK);
  assert.equal(errorMessage({ message: '' }), FALLBACK);
  assert.equal(errorMessage({ message: '' }, 'Could not load.'), 'Could not load.');
});

test('error_description is read too — that is the shape auth errors arrive in', () => {
  assert.equal(
    errorMessage({ error_description: 'Invalid login credentials' }),
    'Invalid login credentials');
});

// The username mapping ------------------------------------------------------
//
// The login box holds a username; Supabase holds an email. The mapping is the
// same in the browser (here) and in the function (admin-users.js, tested in
// admin-users.test.mjs), and the two have to agree or a person the owner just
// created cannot sign in.

test('usernameToEmail maps a bare username to the synthetic domain', () => {
  assert.equal(usernameToEmail('walter'), `walter@${USERNAME_DOMAIN}`);
  assert.equal(usernameToEmail('  Walter '), `walter@${USERNAME_DOMAIN}`);
  assert.equal(usernameToEmail('books.2026'), `books.2026@${USERNAME_DOMAIN}`);
});

test('usernameToEmail passes a real address through, lower-cased', () => {
  assert.equal(usernameToEmail('Trip@Example.com'), 'trip@example.com');
  assert.equal(usernameToEmail(''), '');
  assert.equal(usernameToEmail(null), '');
});

test('the synthetic domain is one that can never receive mail', () => {
  // RFC 2606 reserves .invalid; nothing resolves it. This is the guarantee
  // that "the system sends no email" holds even if a mailer were switched on.
  assert.match(USERNAME_DOMAIN, /\.invalid$/);
});

// Roles ---------------------------------------------------------------------

test('isAdmin means staff: the owner or the bookkeeper', () => {
  assert.equal(isAdmin({ role: 'owner' }), true);
  assert.equal(isAdmin({ role: 'staff' }), true);
  assert.equal(isAdmin({ role: 'none' }), false);
  assert.equal(isAdmin({ role: 'admin' }), false, 'NJD\'s role name is not one of ours');
  assert.equal(isAdmin(null), false);
});

test('isOwner is the owner alone', () => {
  assert.equal(isOwner({ role: 'owner' }), true);
  assert.equal(isOwner({ role: 'staff' }), false);
  assert.equal(isOwner({ role: 'none' }), false);
  assert.equal(isOwner(undefined), false);
});

// Redirects -----------------------------------------------------------------

test('safeNext stays inside the portal and lands on the Dashboard by default', () => {
  assert.equal(safeNext(undefined), '/portal/dashboard/');
  assert.equal(safeNext(null), '/portal/dashboard/');
  assert.equal(safeNext(''), '/portal/dashboard/');
  assert.equal(safeNext('/portal/invoices/?id=1'), '/portal/invoices/?id=1');
  assert.equal(safeNext('https://evil.example/portal/'), '/portal/dashboard/');
  assert.equal(safeNext('//evil.example/portal/'), '/portal/dashboard/');
  assert.equal(safeNext('/admin/'), '/portal/dashboard/');
});
