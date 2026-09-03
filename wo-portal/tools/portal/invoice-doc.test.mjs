// ---------------------------------------------------------------------------
// Invoice document assembly, totals and checks.
//
//   node --test tools/portal/invoice-doc.test.mjs
//
// Covers js/portal/invoice-doc.js and js/portal/invoice-catalog.js.
//
// Three things are defended here: no placeholder text may reach a client, the
// same inputs must hash the same (the hash is stored beside the frozen
// snapshot), and an invoice must ask for exactly the sum of its lines plus
// the tax on the taxable ones — with nowhere in this code for a different
// number to come from.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SNAPSHOT_VERSION, assemble, canonical, digest,
} from '../../js/portal/invoice-doc.js';
import {
  MANUAL_STATUS_OPTIONS,
  PAYMENT_METHODS,
  STATUS_OPTIONS,
  blockers,
  filterInvoices,
  invoiceClientName,
  invoiceFilename,
  invoiceLabel,
  invoiceTotals,
  isValidNumber,
  itemAmount,
  methodLabel,
  outstandingCents,
  overdueDays,
  parseRate,
  statusLabel,
  validate,
} from '../../js/portal/invoice-catalog.js';

// Fixtures: the shapes of studio_settings, invoice_settings, clients,
// invoices and invoice_items as supabase/schema.sql defines them.
// ---------------------------------------------------------------------------

const STUDIO = {
  business_name: 'Walter Ochenski LLC',
  entity_line: '',
  address_line1: '2001 Creekdale Drive',
  address_line2: '',
  city: 'Denton',
  region: 'Texas',
  postal_code: '76210',
  phone: '(972) 467-5988',
  email: 'tripochinski@gmail.com',
  website: '',
  payee_name: 'Walter Ochenski',
  hourly_rate_cents: 15000,
};

const SETTINGS = {
  payment_details: 'Checks payable to Walter Ochenski, or direct ACH — bank details on request.',
  net_days: 15,
  late_note: null,
  tax_rate_bp: 0,
  tax_label: 'Sales tax',
  tax_registration: null,
};

const CLIENT = {
  id: 'c1',
  name: 'Switch Commerce',
  legal_name: 'Switch Commerce LLC',
  contact_name: 'Dana Whitfield',
  contact_email: 'dana@switchcommerce.example',
  contact_phone: null,
  address_line1: '1400 Harbor Way',
  address_line2: null,
  city: 'Denton',
  region: 'TX',
  postal_code: '76201',
  country: null,
  hourly_rate_cents: null,
  net_days: 30,
};

const INVOICE = {
  id: 'i1',
  client_id: 'c1',
  number: '20260901-1',
  status: 'draft',
  issued_on: '2026-09-01',
  due_on: '2026-09-16',
  net_days: 15,
  project_name: 'Website refresh',
  purchase_order: null,
  summary: null,
  notes: '',
  subtotal_cents: 195000,
  tax_rate_bp: 0,
  tax_cents: 0,
  paid_cents: 0,
  total_cents: 195000,
};

const ITEMS = [{
  name: 'Website creation',
  description: 'Design and build of the marketing site.',
  quantity: 1,
  unit_cents: 195000,
  taxable: false,
}];

function build(overrides = {}) {
  return assemble({
    invoice: { ...INVOICE, ...(overrides.invoice || {}) },
    items: overrides.items || ITEMS,
    client: overrides.client === undefined ? CLIENT : overrides.client,
    studio: overrides.studio === undefined ? STUDIO : overrides.studio,
    settings: overrides.settings === undefined ? SETTINGS : overrides.settings,
  });
}

function everyString(value, seen = []) {
  if (typeof value === 'string') seen.push(value);
  else if (Array.isArray(value)) value.forEach((entry) => everyString(entry, seen));
  else if (value && typeof value === 'object') {
    Object.values(value).forEach((entry) => everyString(entry, seen));
  }
  return seen;
}

// The snapshot's shape
// ---------------------------------------------------------------------------

test('the snapshot has the frozen shape, and nothing that keeps moving', () => {
  const snapshot = build();

  assert.equal(snapshot.kind, 'invoice');
  assert.equal(snapshot.version, SNAPSHOT_VERSION);
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.number, '20260901-1');
  assert.equal(snapshot.label, 'Invoice 20260901-1');
  assert.equal(snapshot.issued_on, '2026-09-01');
  assert.equal(snapshot.due_on, '2026-09-16');
  assert.equal(snapshot.net_days, 15);
  assert.equal(snapshot.project_name, 'Website refresh');
  assert.equal(snapshot.purchase_order, null);
  assert.equal(snapshot.summary, null);
  assert.equal(snapshot.notes, null);
  assert.equal(snapshot.late_note, null);
  assert.match(snapshot.payment_details, /Checks payable to Walter Ochenski/);

  assert.deepEqual(Object.keys(snapshot.lines[0]).sort(),
    ['amount_cents', 'description', 'name', 'quantity', 'taxable', 'unit_cents']);
  assert.deepEqual(Object.keys(snapshot.tax).sort(), ['cents', 'label', 'rate_bp', 'registration']);

  // Status, paid_cents and paid_at change after the document is frozen; a
  // snapshot that carried them would be wrong the day the money arrived.
  for (const key of ['status', 'paid_cents', 'paid_at', 'issued_at', 'snapshot_hash']) {
    assert.equal(Object.prototype.hasOwnProperty.call(snapshot, key), false, `${key} leaked in`);
  }
});

test('the letterhead comes off studio_settings and the billed-to block off the client', () => {
  const snapshot = build();

  assert.equal(snapshot.from.name, 'Walter Ochenski LLC');
  assert.deepEqual(snapshot.from.address, ['2001 Creekdale Drive', 'Denton, Texas 76210']);
  assert.equal(snapshot.from.phone, '(972) 467-5988');
  assert.equal(snapshot.from.email, 'tripochinski@gmail.com');
  assert.equal(snapshot.from.entityLine, null);

  // Legal name where one is recorded, working name otherwise.
  assert.equal(snapshot.billed_to.name, 'Switch Commerce LLC');
  assert.deepEqual(snapshot.billed_to.address, ['1400 Harbor Way', 'Denton, TX 76201']);
  assert.equal(snapshot.billed_to.contactName, 'Dana Whitfield');
  assert.equal(build({ client: { name: 'Someone New' } }).billed_to.name, 'Someone New');
});

test('with no studio row the letterhead still names the business', () => {
  assert.equal(build({ studio: null }).from.name, 'Walter Ochenski LLC');
  assert.doesNotMatch(build({ studio: null }).from.name, /Oshinsky/);
});

test('a sparse invoice still produces no placeholder text', () => {
  const snapshot = build({
    client: { id: 'c2', name: 'Someone New' },
    studio: null,
    settings: null,
    invoice: { project_name: '', due_on: null, summary: null, notes: '', purchase_order: '' },
  });

  for (const value of everyString(snapshot)) {
    assert.doesNotMatch(value, /\[.*?\]/, `placeholder left in: ${value}`);
    assert.doesNotMatch(value, /___|\bTBD\b|\bXXX\b/i, `placeholder left in: ${value}`);
    assert.doesNotMatch(value, /undefined|\bnull\b|NaN/, `unresolved value in: ${value}`);
  }
  assert.equal(snapshot.payment_details, null);
  assert.equal(snapshot.due_on, null);
});

// The number is the agreed number
// ---------------------------------------------------------------------------

test('the total is the sum of the lines and nothing else', () => {
  const snapshot = build();
  assert.equal(snapshot.subtotal_cents, 195000);
  assert.equal(snapshot.tax.cents, 0);
  assert.equal(snapshot.total_cents, 195000);
  assert.equal(snapshot.lines[0].amount_cents, 195000);

  const two = build({
    items: [...ITEMS, { name: 'Hosting setup', quantity: 1, unit_cents: 25000 }],
  });
  assert.equal(two.total_cents, 220000);
});

test('hours times a rate is worked out, and rounded once', () => {
  assert.equal(itemAmount({ quantity: 6, unit_cents: 15000 }), 90000);
  assert.equal(itemAmount({ quantity: 1.5, unit_cents: 15000 }), 22500);
  // A third of an hour at $95 is 3166.66…, and a cent has to be decided on.
  assert.equal(itemAmount({ quantity: 1 / 3, unit_cents: 9500 }), 3167);

  const hourly = build({ items: [{ name: 'Consulting', quantity: 6, unit_cents: 15000 }] });
  assert.equal(hourly.lines[0].quantity, 6);
  assert.equal(hourly.lines[0].unit_cents, 15000);
  assert.equal(hourly.lines[0].amount_cents, 90000);
});

test('a nonsense quantity contributes zero rather than NaN', () => {
  assert.equal(itemAmount({ quantity: 'six', unit_cents: 9500 }), 0);
  assert.equal(itemAmount({ quantity: 2, unit_cents: undefined }), 0);

  const snapshot = build({ items: [{ name: 'Broken', quantity: 'x', unit_cents: 'y' }] });
  assert.equal(snapshot.total_cents, 0);
  assert.equal(snapshot.lines[0].quantity, 0);
  assert.doesNotMatch(canonical(snapshot), /NaN/);
});

// Sales tax
// ---------------------------------------------------------------------------
//
// Tax is the one number on an invoice that is not the business's money.
// Undercharge and the business owes the difference; overcharge and it has
// collected money from a client that it now has to hand over and explain.

test('no rate means no tax, however the lines are marked', () => {
  const totals = invoiceTotals([{ quantity: 1, unit_cents: 100000, taxable: true }], 0);
  assert.equal(totals.tax_cents, 0);
  assert.equal(totals.total_cents, 100000);
});

test('a rate with no taxable line charges nothing', () => {
  const totals = invoiceTotals([{ quantity: 1, unit_cents: 100000, taxable: false }], 825);
  assert.equal(totals.taxable_cents, 0);
  assert.equal(totals.tax_cents, 0);
  assert.equal(totals.total_cents, 100000);
});

test('tax is charged on the taxable lines only, not on the invoice', () => {
  const totals = invoiceTotals([
    { quantity: 1, unit_cents: 300000, taxable: false }, // exempt design work
    { quantity: 1, unit_cents: 100000, taxable: true },  // printing bought in
  ], 825);

  assert.equal(totals.subtotal_cents, 400000);
  assert.equal(totals.taxable_cents, 100000);
  assert.equal(totals.tax_cents, 8250);
  assert.equal(totals.total_cents, 408250);
});

test('the rounding happens once, on the taxable subtotal', () => {
  // Three lines that would each round up separately, but together do not.
  const items = [
    { name: 'a', quantity: 1, unit_cents: 3333, taxable: true },
    { name: 'b', quantity: 1, unit_cents: 3333, taxable: true },
    { name: 'c', quantity: 1, unit_cents: 3333, taxable: true },
  ];
  const totals = invoiceTotals(items, 825);
  assert.equal(totals.taxable_cents, 9999);
  assert.equal(totals.tax_cents, Math.round((9999 * 825) / 10000));
  assert.equal(totals.tax_cents, 825);

  const snapshot = build({ items, invoice: { tax_rate_bp: 825, total_cents: 9999 + 825 } });
  assert.equal(snapshot.tax.cents, 825);
  assert.equal(snapshot.total_cents, 10824);
});

test('the permit number travels only when tax is charged', () => {
  const settings = { ...SETTINGS, tax_label: 'TX sales tax', tax_registration: '3-12345-6789-0' };

  const taxed = build({
    settings,
    items: [{ name: 'Printing', quantity: 1, unit_cents: 100000, taxable: true }],
    invoice: { tax_rate_bp: 825, total_cents: 108250 },
  });
  assert.equal(taxed.tax.label, 'TX sales tax');
  assert.equal(taxed.tax.rate_bp, 825);
  assert.equal(taxed.tax.cents, 8250);
  assert.equal(taxed.tax.registration, '3-12345-6789-0');

  const exempt = build({ settings });
  assert.equal(exempt.tax.cents, 0);
  assert.equal(exempt.tax.registration, null);
});

test('a rate is read the way a person types it', () => {
  assert.equal(parseRate('8.25'), 825);
  assert.equal(parseRate('8.25%'), 825);
  assert.equal(parseRate('8'), 800);
  assert.equal(parseRate(''), null);
  assert.equal(parseRate('nonsense'), null);
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

test('key order in the inputs does not change the hash', () => {
  const shuffled = assemble({
    settings: SETTINGS,
    studio: STUDIO,
    client: { ...CLIENT },
    items: ITEMS.map((item) => ({ unit_cents: item.unit_cents, name: item.name, quantity: item.quantity, description: item.description, taxable: item.taxable })),
    invoice: { ...INVOICE },
  });
  assert.equal(canonical(shuffled), canonical(build()));
});

// Labels and filenames
// ---------------------------------------------------------------------------

test('the label is the number the way people say it', () => {
  assert.equal(invoiceLabel('20260901-1'), 'Invoice 20260901-1');
  assert.equal(invoiceLabel('20260901-12'), 'Invoice 20260901-12');
  assert.equal(invoiceLabel(null), 'Invoice —');
});

test('the number has to be YYYYMMDD-N', () => {
  assert.ok(isValidNumber('20260901-1'));
  assert.ok(isValidNumber('20261231-42'));
  assert.ok(!isValidNumber('2026-09-01-1'));
  assert.ok(!isValidNumber('INV 0001'));
  assert.ok(!isValidNumber('20260901'));
  assert.ok(!isValidNumber(''));
  assert.ok(!isValidNumber(null));
});

test('the filename follows the convention, whatever the client is called', () => {
  assert.equal(
    invoiceFilename({ number: '20260901-1' }, 'Switch Commerce LLC'),
    'WO-INV-20260901-1-switch-commerce-llc.pdf',
  );
  assert.equal(
    invoiceFilename({ number: '20260901-2' }, 'Café “Ünïcode” & Sons, Inc.'),
    'WO-INV-20260901-2-cafe-unicode-sons-inc.pdf',
  );
  assert.doesNotMatch(invoiceFilename({ number: '20260901-1' }, 'x'), /NJD/);
});

test('the status lists are what the database and the owner agreed', () => {
  assert.deepEqual(STATUS_OPTIONS.map((o) => o.value), ['draft', 'issued', 'sent', 'paid', 'void']);
  assert.deepEqual(MANUAL_STATUS_OPTIONS.map((o) => o.value), ['sent', 'void']);
  assert.equal(statusLabel('issued'), 'Issued');
  assert.deepEqual(PAYMENT_METHODS.map((o) => o.value), ['ach', 'check', 'zelle', 'card', 'cash', 'other']);
  assert.equal(methodLabel('zelle'), 'Zelle');
});

// The checks before issuing
// ---------------------------------------------------------------------------

function check(overrides = {}) {
  return validate(
    { ...INVOICE, ...(overrides.invoice || {}) },
    overrides.items === undefined ? ITEMS : overrides.items,
    overrides.client === undefined ? CLIENT : overrides.client,
  );
}

test('a complete invoice has nothing to say about itself', () => {
  assert.deepEqual(check(), []);
});

test('an invoice with no client cannot be issued', () => {
  assert.ok(blockers(check({ client: null })).some((p) => p.field === 'client'));
});

test('an invoice with no lines cannot be issued', () => {
  const problems = check({ items: [], invoice: { total_cents: 0 } });
  assert.ok(blockers(problems).some((p) => p.field === 'items'));
});

test('a line with no name cannot be issued', () => {
  const problems = check({ items: [{ name: '  ', quantity: 1, unit_cents: 195000 }] });
  assert.ok(blockers(problems).some((p) => p.field === 'items' && /no name/.test(p.message)));
});

test('a malformed number cannot be issued', () => {
  assert.ok(blockers(check({ invoice: { number: 'INV 0001' } })).some((p) => p.field === 'number'));
  assert.ok(blockers(check({ invoice: { number: '' } })).some((p) => p.field === 'number'));
});

test('a total that disagrees with the lines and the tax cannot be issued', () => {
  const problems = check({ invoice: { total_cents: 100000 } });
  assert.ok(blockers(problems).some((p) => p.field === 'total'));
  // The database repeats this check; the browser says it first.
  assert.deepEqual(check({ invoice: { total_cents: 195000 } }), []);
});

test('an invoice with no date cannot be issued', () => {
  assert.ok(blockers(check({ invoice: { issued_on: null } })).some((p) => p.field === 'issued_on'));
});

test('a due date before the invoice date cannot be issued', () => {
  const problems = check({ invoice: { issued_on: '2026-09-20', due_on: '2026-09-06' } });
  assert.ok(blockers(problems).some((p) => p.field === 'due_on'));
});

test('an invoice where every line is zero cannot be issued', () => {
  const problems = check({
    items: [{ name: 'Nothing', quantity: 1, unit_cents: 0 }],
    invoice: { total_cents: 0 },
  });
  assert.ok(blockers(problems).some((p) => /zero/i.test(p.message)));
});

test('a taxable line with no rate warns rather than blocks', () => {
  const problems = check({ items: [{ ...ITEMS[0], taxable: true }] });
  assert.equal(blockers(problems).length, 0);
  assert.ok(problems.some((p) => p.field === 'tax'));
});

test('blocking problems sort ahead of warnings', () => {
  const problems = check({
    items: [{ ...ITEMS[0], taxable: true }],
    invoice: { number: 'bad' },
  });
  assert.ok(problems.length > 1);
  assert.equal(problems[0].blocking, true);
  assert.equal(problems[problems.length - 1].blocking, false);
});

// The list
// ---------------------------------------------------------------------------

test('the list search finds an invoice by number, client or project', () => {
  const rows = [
    { client_id: 'a', number: '20260901-1', status: 'sent', project_name: 'Switch site', client: { name: 'Switch Commerce' } },
    { client_id: 'b', number: '20260901-2', status: 'draft', project_name: 'Bell rebrand', client: { name: 'Bell Dental' } },
    { client_id: 'b', number: '20260902-1', status: 'paid', project_name: 'Bell rebrand', client: { name: 'Bell Dental' } },
  ];

  assert.equal(filterInvoices(rows, { search: '20260901-1' }).length, 1);
  assert.equal(filterInvoices(rows, { search: '20260901' }).length, 2);
  assert.equal(filterInvoices(rows, { search: 'invoice 20260902' }).length, 1);
  assert.equal(filterInvoices(rows, { search: 'bell' }).length, 2);
  assert.equal(filterInvoices(rows, { search: 'nothing here' }).length, 0);
  assert.equal(filterInvoices(rows, { status: 'paid' }).length, 1);
  assert.equal(filterInvoices(rows, { clientId: 'b' }).length, 2);
  assert.equal(filterInvoices(rows, { status: 'draft', search: 'switch' }).length, 0);
  assert.equal(filterInvoices(rows, {}).length, 3);
});

test('a row whose client embed did not resolve still lists and still searches', () => {
  const orphan = { number: '20260901-9', status: 'draft', project_name: 'Mystery', client: null };
  assert.equal(invoiceClientName(orphan), 'Unknown client');
  assert.equal(filterInvoices([orphan], { search: 'mystery' }).length, 1);
});

test('what is outstanding is owed only on an issued or sent invoice', () => {
  assert.equal(outstandingCents({ status: 'sent', total_cents: 10000, paid_cents: 2500 }), 7500);
  assert.equal(outstandingCents({ status: 'issued', total_cents: 10000, paid_cents: 0 }), 10000);
  assert.equal(outstandingCents({ status: 'draft', total_cents: 10000, paid_cents: 0 }), 0);
  assert.equal(outstandingCents({ status: 'paid', total_cents: 10000, paid_cents: 10000 }), 0);
  assert.equal(outstandingCents({ status: 'void', total_cents: 10000, paid_cents: 0 }), 0);
});

// Overdue
// ---------------------------------------------------------------------------

test('overdue counts whole days past the due date', () => {
  const sent = { status: 'sent', due_on: '2026-09-16' };
  assert.equal(overdueDays(sent, '2026-09-16'), 0);
  assert.equal(overdueDays(sent, '2026-09-17'), 1);
  assert.equal(overdueDays(sent, '2026-10-01'), 15);
  assert.equal(overdueDays({ status: 'issued', due_on: '2026-09-16' }, '2026-09-20'), 4);
});

test('money that arrived, or was never owed, is never late', () => {
  assert.equal(overdueDays({ status: 'paid', due_on: '2020-01-01' }, '2026-09-21'), 0);
  assert.equal(overdueDays({ status: 'void', due_on: '2020-01-01' }, '2026-09-21'), 0);
  // A draft has not been handed to anybody, so nobody is late paying it.
  assert.equal(overdueDays({ status: 'draft', due_on: '2020-01-01' }, '2026-09-21'), 0);
  assert.equal(overdueDays({ status: 'sent', due_on: null }, '2026-09-21'), 0);
});
