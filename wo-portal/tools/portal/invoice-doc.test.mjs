// ---------------------------------------------------------------------------
// Invoice document assembly, totals and checks.
//
//   node --test tools/portal/*.test.mjs
//
// Covers js/portal/invoice-doc.js and js/portal/invoice-catalog.js.
//
// The same two things are being defended here as in sow-doc.test.mjs — no
// placeholder text may reach a client, and the same inputs must hash the same —
// plus one that is specific to this document and matters more than either: an
// invoice must ask for the figure the client agreed to, and there must be
// nowhere in this code for a different number to come from.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assemble, canonical, digest } from '../../js/portal/invoice-doc.js';
import {
  computeTotals,
  filterInvoices,
  formatRate,
  parseRate,
  invoiceClientName,
  invoiceFilename,
  invoiceLabel,
  lineAmount,
  overdueDays,
  validate,
  blockers,
} from '../../js/portal/invoice-catalog.js';

const SETTINGS = {
  party_name: 'Walter Ochenski d/b/a New Journey Designs',
  party_entity: 'a Texas sole proprietorship',
  party_address: '123 Elm Street\nDenton, TX 76201',
};

const TERMS = {
  payment_terms: 'Payment is due within 14 days of the invoice date.',
  payment_details: 'Bank: Example Credit Union\nRouting 111000025\nAccount 9876543210',
  net_days: 14,
};

const CLIENT = {
  id: 'c1',
  name: 'Acme Roofing',
  legal_name: 'Acme Roofing LLC',
  entity_type: 'a Texas limited liability company',
  contact_name: 'Dana Whitfield',
  contact_title: 'Owner',
  contact_email: 'dana@acmeroofing.example',
  address_line1: '1400 Harbor Way',
  city: 'Denton',
  region: 'TX',
  postal_code: '76201',
};

const INVOICE = {
  number: 7,
  stage: 'deposit',
  status: 'draft',
  issued_on: '2026-08-06',
  due_on: '2026-08-20',
  sow_label: 'SOW 014',
  project_name: 'Acme Roofing website',
  purchase_order: null,
  summary: null,
  notes: '',
  paid_cents: 0,
};

const ITEMS = [{
  name: 'Deposit — due on signing',
  description: 'Half of the agreed project fee, due on signing. Books the time.',
  quantity: 1,
  unit_cents: 195000,
}];

function build(overrides = {}) {
  return assemble({
    invoice: { ...INVOICE, ...(overrides.invoice || {}) },
    client: overrides.client === undefined ? CLIENT : overrides.client,
    items: overrides.items || ITEMS,
    settings: SETTINGS,
    terms: overrides.terms === undefined ? TERMS : overrides.terms,
    today: overrides.today || '2026-08-06',
  });
}

// No empty brackets, anywhere
// ---------------------------------------------------------------------------

function everyString(value, seen = []) {
  if (typeof value === 'string') seen.push(value);
  else if (Array.isArray(value)) value.forEach((entry) => everyString(entry, seen));
  else if (value && typeof value === 'object') {
    Object.values(value).forEach((entry) => everyString(entry, seen));
  }
  return seen;
}

test('a sparse invoice still produces no placeholder text', () => {
  const snapshot = build({
    client: { id: 'c2', name: 'Someone New' },
    terms: null,
    invoice: {
      sow_label: null,
      project_name: '',
      due_on: null,
      summary: null,
      notes: '',
    },
  });

  for (const value of everyString(snapshot)) {
    assert.doesNotMatch(value, /\[.*?\]/, `placeholder left in: ${value}`);
    assert.doesNotMatch(value, /___|\bTBD\b|\bXXX\b/i, `placeholder left in: ${value}`);
    assert.doesNotMatch(value, /undefined|\bnull\b|NaN/, `unresolved value in: ${value}`);
  }
});

test('an absent section is absent, not an empty one', () => {
  const snapshot = build({
    terms: null,
    invoice: { sow_label: null, summary: null, notes: '' },
  });

  assert.equal(snapshot.authority, null);
  assert.equal(snapshot.summary, null);
  assert.equal(snapshot.notes, null);
  assert.deepEqual(snapshot.payment.details, []);
});

test('the header drops the rows that have nothing to say', () => {
  const labels = build({ invoice: { purchase_order: null, due_on: null } })
    .header.map(([label]) => label);

  assert.ok(!labels.includes('Purchase order'));
  assert.ok(!labels.includes('Due'));
  assert.ok(labels.includes('Amount due'));
});

// The number is the agreed number
// ---------------------------------------------------------------------------

test('the total is the sum of the lines and nothing else', () => {
  const snapshot = build();
  assert.equal(snapshot.totals.totalCents, 195000);
  assert.equal(snapshot.totals.dueCents, 195000);
  assert.equal(snapshot.totals.due, '$1,950.00');
});

test('there is no discount anywhere in an assembled invoice', () => {
  // The fee engine had its say when the scope of work was written. If the word
  // ever appears here, a second place to decide the price has been introduced.
  const snapshot = build();
  assert.equal(Object.prototype.hasOwnProperty.call(snapshot.totals, 'discounts'), false);
  assert.equal(snapshot.totals.subtotalCents, snapshot.totals.totalCents);
});

test('a part payment comes off the amount due, not off the total', () => {
  const snapshot = build({ invoice: { paid_cents: 50000 } });

  assert.equal(snapshot.totals.totalCents, 195000);
  assert.equal(snapshot.totals.paidCents, 50000);
  assert.equal(snapshot.totals.dueCents, 145000);
  assert.ok(snapshot.payment.paragraphs.some((line) => /\$500\.00 has already been received/.test(line)));
});

test('hours times a rate is worked out, and rounded once', () => {
  assert.equal(lineAmount({ quantity: 6, unit_cents: 9500 }), 57000);
  assert.equal(lineAmount({ quantity: 1.5, unit_cents: 9500 }), 14250);
  // A third of an hour at $95 is 3166.66…, and a cent has to be decided on.
  assert.equal(lineAmount({ quantity: 1 / 3, unit_cents: 9500 }), 3167);
});

test('a nonsense quantity contributes zero rather than NaN', () => {
  assert.equal(lineAmount({ quantity: 'six', unit_cents: 9500 }), 0);
  assert.equal(lineAmount({ quantity: 2, unit_cents: undefined }), 0);

  const snapshot = build({ items: [{ name: 'Broken', quantity: 'x', unit_cents: 'y' }] });
  assert.equal(snapshot.totals.totalCents, 0);
  for (const value of everyString(snapshot)) {
    assert.doesNotMatch(value, /NaN/, `NaN reached the document: ${value}`);
  }
});

test('the quantity column shows the working only when there is working', () => {
  const flat = build();
  assert.equal(flat.lines[0].detail, null);

  const hourly = build({
    items: [{ name: 'Extra page', quantity: 6, unit_cents: 9500 }],
  });
  assert.equal(hourly.lines[0].detail, '6 × $95.00');
});

test('a single-line invoice does not print its subtotal twice', () => {
  assert.equal(build().totals.showSubtotal, false);

  const two = build({
    items: [...ITEMS, { name: 'Second thing', quantity: 1, unit_cents: 10000 }],
  });
  assert.equal(two.totals.showSubtotal, true);
});

// What the document says about the scope of work
// ---------------------------------------------------------------------------

test('the invoice names the scope of work it bills against', () => {
  const snapshot = build();
  assert.match(snapshot.authority, /SOW 014/);
  assert.match(snapshot.authority, /deposit/);
});

test('with no scope of work behind it there is no sentence rather than a blank one', () => {
  assert.equal(build({ invoice: { sow_label: null } }).authority, null);
});

// Payment block
// ---------------------------------------------------------------------------

test('how to pay is absent rather than an empty heading', () => {
  const withDetails = build();
  assert.deepEqual(withDetails.payment.details, [
    'Bank: Example Credit Union',
    'Routing 111000025',
    'Account 9876543210',
  ]);

  assert.deepEqual(build({ terms: { payment_terms: 'Net 30.' } }).payment.details, []);
});

test('with no terms configured the document still states some', () => {
  const snapshot = build({ terms: null });
  assert.ok(snapshot.payment.paragraphs.length);
  assert.match(snapshot.payment.paragraphs[0], /due within 14 days/);
});

// Determinism
// ---------------------------------------------------------------------------

test('the same inputs assemble to the same bytes', () => {
  assert.equal(canonical(build()), canonical(build()));
});

test('the hash changes when the document does, and only then', async () => {
  const before = await digest(build());
  const again = await digest(build());
  assert.equal(before, again);
  assert.match(before, /^[0-9a-f]{64}$/);

  const after = await digest(build({ invoice: { summary: 'A different summary.' } }));
  assert.notEqual(before, after);
});

// Totals helper
// ---------------------------------------------------------------------------

test('computeTotals never reports a negative payment', () => {
  const totals = computeTotals(ITEMS, -500);
  assert.equal(totals.paid, 0);
  assert.equal(totals.due, 195000);
});

// The checks before issuing
// ---------------------------------------------------------------------------

function check(overrides = {}) {
  return validate({
    invoice: { ...INVOICE, ...(overrides.invoice || {}) },
    client: overrides.client === undefined ? CLIENT : overrides.client,
    items: overrides.items === undefined ? ITEMS : overrides.items,
    sow: overrides.sow === undefined ? null : overrides.sow,
    billedCents: overrides.billedCents || 0,
  });
}

test('a complete invoice has nothing to say about itself', () => {
  assert.deepEqual(check(), []);
});

test('an invoice with no lines cannot be issued', () => {
  assert.ok(blockers(check({ items: [] })).some((p) => p.field === 'items'));
});

test('an invoice where every line is zero cannot be issued', () => {
  const problems = check({ items: [{ name: 'Nothing', quantity: 1, unit_cents: 0 }] });
  assert.ok(blockers(problems).some((p) => /zero/i.test(p.message)));
});

test('an invoice with no date cannot be issued', () => {
  assert.ok(blockers(check({ invoice: { issued_on: null } })).some((p) => p.field === 'issued_on'));
});

test('a due date before the invoice date cannot be issued', () => {
  const problems = check({ invoice: { issued_on: '2026-08-20', due_on: '2026-08-06' } });
  assert.ok(blockers(problems).some((p) => p.field === 'due_on'));
});

test('an unsigned scope of work warns rather than blocks', () => {
  const problems = check({
    sow: { label: 'SOW 014', status: 'sent', adjusted_fee_cents: 390000 },
  });

  assert.equal(blockers(problems).length, 0);
  assert.ok(problems.some((p) => p.field === 'sow' && /not signed/.test(p.message)));
});

test('billing past the agreed fee warns, with both numbers in the sentence', () => {
  const problems = check({
    sow: { label: 'SOW 014', status: 'signed', adjusted_fee_cents: 390000 },
    billedCents: 300000,
  });

  const over = problems.find((p) => /more than the/.test(p.message));
  assert.ok(over);
  assert.equal(over.blocking, false);
  assert.match(over.message, /\$4,950\.00/);   // 300000 + 195000
  assert.match(over.message, /\$3,900\.00/);   // the agreed fee
  assert.match(over.message, /\$1,050\.00/);   // the overrun
});

test('billing exactly the agreed fee says nothing', () => {
  const problems = check({
    sow: { label: 'SOW 014', status: 'signed', adjusted_fee_cents: 390000 },
    billedCents: 195000,
  });

  assert.ok(!problems.some((p) => /more than the/.test(p.message)));
});

test('blocking problems sort ahead of warnings', () => {
  const problems = check({
    items: [],
    sow: { label: 'SOW 014', status: 'draft', adjusted_fee_cents: 390000 },
  });

  assert.ok(problems.length > 1);
  assert.equal(problems[0].blocking, true);
  assert.equal(problems[problems.length - 1].blocking, false);
});

// Labels, filenames and the list
// ---------------------------------------------------------------------------

test('an invoice number is padded to four digits', () => {
  assert.equal(invoiceLabel(7), '0007');
  assert.equal(invoiceLabel(1234), '1234');
  assert.equal(invoiceLabel(12345), '12345');
});

test('the filename follows the convention, whatever the client is called', () => {
  assert.equal(
    invoiceFilename({ number: 7 }, 'Acme Roofing LLC', '2026-08-06'),
    'NJD-INV-0007-acme-roofing-llc-2026-08-06.pdf',
  );
});

test('the list search finds an invoice by number, client, project or SOW', () => {
  const rows = [
    { number: 7, status: 'sent', project_name: 'Acme site', sow_label: 'SOW 014', clients: { name: 'Acme Roofing' } },
    { number: 8, status: 'draft', project_name: 'Bell rebrand', sow_label: 'SOW 015', clients: { name: 'Bell Dental' } },
    { number: 9, status: 'paid', project_name: 'Bell rebrand', sow_label: 'SOW 015', clients: { name: 'Bell Dental' } },
  ];

  assert.equal(filterInvoices(rows, { search: '0007' }).length, 1);
  assert.equal(filterInvoices(rows, { search: '7' }).length, 1);
  assert.equal(filterInvoices(rows, { search: 'bell' }).length, 2);
  assert.equal(filterInvoices(rows, { search: 'SOW 015' }).length, 2);
  assert.equal(filterInvoices(rows, { search: 'nothing here' }).length, 0);
  assert.equal(filterInvoices(rows, { status: 'paid' }).length, 1);
  assert.equal(filterInvoices(rows, { status: 'draft', search: 'acme' }).length, 0);
  assert.equal(filterInvoices(rows, {}).length, 3);
});

test('a row whose client embed did not resolve still lists and still searches', () => {
  const orphan = { number: 9, status: 'draft', project_name: 'Mystery', clients: null };
  assert.equal(invoiceClientName(orphan), 'Unknown client');
  assert.equal(filterInvoices([orphan], { search: 'mystery' }).length, 1);
});

// Overdue
// ---------------------------------------------------------------------------

test('overdue counts whole days past the due date', () => {
  const sent = { status: 'sent', due_on: '2026-08-20' };
  assert.equal(overdueDays(sent, '2026-08-20'), 0);
  assert.equal(overdueDays(sent, '2026-08-21'), 1);
  assert.equal(overdueDays(sent, '2026-09-01'), 12);
});

test('money that arrived, or was never owed, is never late', () => {
  assert.equal(overdueDays({ status: 'paid', due_on: '2020-01-01' }, '2026-08-21'), 0);
  assert.equal(overdueDays({ status: 'void', due_on: '2020-01-01' }, '2026-08-21'), 0);
  // A draft has not been sent to anybody, so nobody is late paying it.
  assert.equal(overdueDays({ status: 'draft', due_on: '2020-01-01' }, '2026-08-21'), 0);
  assert.equal(overdueDays({ status: 'sent', due_on: null }, '2026-08-21'), 0);
});

// Sales tax
// ---------------------------------------------------------------------------
//
// Tax is the one number on an invoice that is not the studio's money. Getting
// it wrong in either direction is expensive: undercharge and the studio owes
// the difference out of its own pocket, overcharge and it has collected money
// from a client that it now has to hand over and explain.

test('no rate means no tax, however the lines are marked', () => {
  const totals = computeTotals(
    [{ quantity: 1, unit_cents: 100000, taxable: true }], 0, 0,
  );
  assert.equal(totals.tax, 0);
  assert.equal(totals.total, 100000);
});

test('a rate with no taxable line charges nothing', () => {
  const totals = computeTotals(
    [{ quantity: 1, unit_cents: 100000, taxable: false }], 0, 825,
  );
  assert.equal(totals.taxable, 0);
  assert.equal(totals.tax, 0);
  assert.equal(totals.total, 100000);
});

test('tax is charged on the taxable lines only, not on the invoice', () => {
  const totals = computeTotals([
    { quantity: 1, unit_cents: 300000, taxable: false }, // exempt design work
    { quantity: 1, unit_cents: 100000, taxable: true },  // printing bought in
  ], 0, 825);

  assert.equal(totals.subtotal, 400000);
  assert.equal(totals.taxable, 100000);
  assert.equal(totals.tax, 8250);
  assert.equal(totals.total, 408250);
});

test('what is still owed includes the tax', () => {
  const totals = computeTotals(
    [{ quantity: 1, unit_cents: 100000, taxable: true }], 50000, 825,
  );
  assert.equal(totals.total, 108250);
  assert.equal(totals.due, 58250);
});

test('the rounding happens once, on the taxable subtotal', () => {
  // Three lines that would each round up separately, but together do not.
  const totals = computeTotals([
    { quantity: 1, unit_cents: 3333, taxable: true },
    { quantity: 1, unit_cents: 3333, taxable: true },
    { quantity: 1, unit_cents: 3333, taxable: true },
  ], 0, 825);

  assert.equal(totals.taxable, 9999);
  assert.equal(totals.tax, Math.round((9999 * 825) / 10000));
  assert.equal(totals.tax, 825);
});

test('a rate is read and written the way a person says it', () => {
  assert.equal(formatRate(825), '8.25%');
  assert.equal(formatRate(625), '6.25%');
  assert.equal(formatRate(800), '8%');
  assert.equal(formatRate(0), '0%');

  assert.equal(parseRate('8.25'), 825);
  assert.equal(parseRate('8.25%'), 825);
  assert.equal(parseRate('8'), 800);
  assert.equal(parseRate(''), null);
  assert.equal(parseRate('nonsense'), null);
});

test('the document prints the tax line only when tax is charged', () => {
  const taxed = assemble({
    invoice: { number: 7, issued_on: '2026-08-08', tax_rate_bp: 825, paid_cents: 0 },
    client: { name: 'Acme Co' },
    items: [{ name: 'Printing', quantity: 1, unit_cents: 100000, taxable: true }],
    settings: {},
    terms: { tax_label: 'TX sales tax' },
  });

  assert.equal(taxed.totals.taxCents, 8250);
  assert.match(taxed.totals.taxLabel, /TX sales tax at 8\.25%/);
  assert.equal(taxed.totals.totalCents, 108250);

  const exempt = assemble({
    invoice: { number: 8, issued_on: '2026-08-08', tax_rate_bp: 0, paid_cents: 0 },
    client: { name: 'Acme Co' },
    items: [{ name: 'Design', quantity: 1, unit_cents: 100000 }],
    settings: {},
    terms: {},
  });

  assert.equal(exempt.totals.tax, null);
  assert.equal(exempt.totals.taxLabel, null);
});
