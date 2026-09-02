// ---------------------------------------------------------------------------
// errorMessage — what a person is allowed to be shown when something fails.
//
//   node --test tools/portal/*.test.mjs
//
// This covers js/portal/client.js, which 234 call sites route their failures
// through, 36 of them on screens a client can see. The two rules worth holding
// on to are pulled out as their own tests, because both are easy to break by
// making the function "simpler":
//
//   1. A message that is already in English survives a second pass. The portal
//      does `throw new Error(errorMessage(err))` in 72 places and then calls
//      errorMessage again on the Error it just made, so idempotence is not a
//      nicety — without it every hand-written validation line in the portal
//      turns into "Something went wrong."
//   2. A message that is Postgres talking never reaches a screen, even when
//      nobody has written a translation for it yet.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { errorMessage } from '../../js/portal/client.js';

const FALLBACK = 'Something went wrong.';

test('no error at all gives the fallback', () => {
  assert.equal(errorMessage(null), FALLBACK);
  assert.equal(errorMessage(undefined), FALLBACK);
  assert.equal(errorMessage(null, 'Could not load the invoice.'),
    'Could not load the invoice.');
});

test('SQLSTATE codes are translated, and beat whatever the message says', () => {
  const cases = [
    ['23505', 'duplicate key value violates unique constraint "client_contacts_client_id_email_key"'],
    ['23503', 'update or delete on table "clients" violates foreign key constraint'],
    ['23502', 'null value in column "title" of relation "waypoints" violates not-null constraint'],
    ['23514', 'new row for relation "sows" violates check constraint "sows_status_check"'],
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

test('the hand-written cases still win', () => {
  assert.equal(
    errorMessage({ message: 'new row violates row-level security policy for table "sows"' }),
    'You do not have permission to do that.');
  assert.equal(
    errorMessage({ message: 'JWT expired' }),
    'Your session expired. Please sign in again.');
  assert.equal(
    errorMessage({ message: 'Failed to fetch' }),
    'Could not reach the server. Check your connection and try again.');
  assert.match(
    errorMessage({ message: 'violates foreign key constraint "sows_client_id_fkey"' }),
    /scopes of work on file/);
  assert.match(
    errorMessage({ message: 'duplicate key value violates unique constraint "sow_credits_pkey"' }),
    /one-page credit/);
});

// Rule 1. Break this and forty validation messages become "Something went wrong."
test('a message already written for a person passes through unchanged', () => {
  const human = [
    'The stop time has to be after the start time.',
    'That start time is not a time.',
    'This client no longer exists.',
    'That website does not look like an address. Try acme.com or https://acme.com.',
    'Nothing was deleted.',
    'That hourly rate is not an amount. Leave it blank for the studio rate.',
  ];
  for (const message of human) {
    assert.equal(errorMessage({ message }), message);
    assert.equal(errorMessage(new Error(message)), message);
  }
});

test('applying it twice changes nothing — the portal does exactly that 72 times', () => {
  const inputs = [
    { code: '23505', message: 'duplicate key value violates unique constraint "x_key"' },
    { message: 'new row violates row-level security policy for table "sows"' },
    { message: 'The stop time has to be after the start time.' },
    { message: 'relation "public.nope" does not exist' },
    null,
  ];
  for (const input of inputs) {
    const once = errorMessage(input);
    assert.equal(errorMessage(new Error(once)), once,
      `not idempotent for ${JSON.stringify(input)}`);
  }
});

// Rule 2. This is the one a client would otherwise see.
test('an unmapped database error is withheld rather than printed', () => {
  const leaks = [
    'duplicate key value violates unique constraint "quick_links_project_id_position_key"',
    'null value in column "body" of relation "messages" violates not-null constraint',
    'relation "public.waypoint_notes" does not exist',
    'column "archived_at" of relation "clients" does not exist',
    'permission denied for sequence invoices_number_seq',
    'syntax error at or near ")"',
    'invalid input syntax for type date: ""',
    'value too long for type character varying(64)',
    'function public.presign_nda(uuid) does not exist',
  ];
  for (const message of leaks) {
    const out = errorMessage({ message });
    assert.equal(out, FALLBACK, `leaked to the screen: ${message}`);
  }
});

test('the caller\'s own fallback is used when the raw message is withheld', () => {
  const out = errorMessage(
    { message: 'null value in column "title" of relation "waypoints" violates not-null constraint' },
    'Could not save that waypoint.');
  assert.equal(out, 'Could not save that waypoint.');
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
