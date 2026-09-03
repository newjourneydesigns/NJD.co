// ---------------------------------------------------------------------------
// The client record's pure helpers.
//
//   node --test tools/portal/clients-model.test.mjs
//
// client-form.js and client-documents.js import the Supabase client, but
// nothing at their top level touches a browser — client.js guards `window`
// and ui.js only defines functions — so the sentence-and-number helpers in
// them can be held to account here without a DOM.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseNetDays, clientDeleteWarning, CLIENT_STATUS_OPTIONS } from '../../js/portal/client-form.js';
import { documentContentType, DOCUMENT_ACCEPT } from '../../js/portal/client-documents.js';
import { telNumber } from '../../js/portal/contact-actions.js';

// Payment terms
// ---------------------------------------------------------------------------

test('blank terms mean the standard terms, not zero', () => {
  assert.equal(parseNetDays(''), null);
  assert.equal(parseNetDays('   '), null);
  assert.equal(parseNetDays(null), null);
  assert.equal(parseNetDays(undefined), null);
});

test('terms are read the way people type them', () => {
  assert.equal(parseNetDays('15'), 15);
  assert.equal(parseNetDays(' 30 '), 30);
  assert.equal(parseNetDays('Net 30'), 30);
  assert.equal(parseNetDays('net45'), 45);
  assert.equal(parseNetDays('0'), 0);
  assert.equal(parseNetDays('365'), 365);
});

test('terms the database would refuse are refused in a sentence', () => {
  // clients_net_days_range is 0–365; the form says so before the round trip.
  assert.throws(() => parseNetDays('366'), /365/);
  assert.throws(() => parseNetDays('-1'), /number of days/);
  assert.throws(() => parseNetDays('thirty'), /number of days/);
  assert.throws(() => parseNetDays('30 days'), /number of days/);
  assert.throws(() => parseNetDays('1.5'), /number of days/);
});

test('the status options are the client_status enum, in the order a record moves', () => {
  assert.deepEqual(CLIENT_STATUS_OPTIONS.map((o) => o.value), ['lead', 'active', 'past']);
});

// Deleting
// ---------------------------------------------------------------------------

test('the delete warning names the client, the cascade, and the invoice rule', () => {
  const warning = clientDeleteWarning({ name: 'Switch Commerce' });
  assert.equal(warning.title, 'Delete Switch Commerce?');
  assert.ok(Array.isArray(warning.body));
  assert.match(warning.body.join(' '), /contacts, notes and every document/);
  assert.match(warning.body.join(' '), /invoices cannot be deleted/);
});

// Documents
// ---------------------------------------------------------------------------

test('the upload type is on the bucket list, by declared type or by extension', () => {
  assert.equal(documentContentType({ name: 'w9.pdf', type: 'application/pdf' }), 'application/pdf');
  // A phone picker often leaves the type blank; the extension decides.
  assert.equal(documentContentType({ name: 'IMG_0042.HEIC', type: '' }), 'image/heic');
  assert.equal(documentContentType({ name: 'brief.docx', type: '' }),
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.equal(documentContentType({ name: 'rates.xlsx', type: 'application/octet-stream' }),
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(documentContentType({ name: 'notes.txt', type: 'text/plain' }), 'text/plain');
});

test('a file the bucket will not take is null, never octet-stream', () => {
  assert.equal(documentContentType({ name: 'site.html', type: 'text/html' }), null);
  assert.equal(documentContentType({ name: 'archive.zip', type: 'application/zip' }), null);
  assert.equal(documentContentType({ name: 'noext', type: '' }), null);
  assert.equal(documentContentType({ name: 'run.exe', type: 'application/octet-stream' }), null);
});

test('the picker filter lists every type and every extension the bucket allows', () => {
  const parts = DOCUMENT_ACCEPT.split(',');
  for (const wanted of ['application/pdf', 'image/heic', 'text/csv', '.pdf', '.jpg', '.xlsx', '.docx']) {
    assert.ok(parts.includes(wanted), `${wanted} missing from the accept string`);
  }
  assert.ok(!parts.includes('application/octet-stream'));
});

// Dialling
// ---------------------------------------------------------------------------

test('a number typed for humans dials, and a leading + survives', () => {
  assert.equal(telNumber('(972) 467-5988'), '9724675988');
  assert.equal(telNumber('+1 972.467.5988'), '+19724675988');
  assert.equal(telNumber(''), '');
  assert.equal(telNumber(null), '');
});
