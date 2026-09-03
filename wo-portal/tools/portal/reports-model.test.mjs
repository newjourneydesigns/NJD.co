// ---------------------------------------------------------------------------
// The report arithmetic.
//
//   node --test tools/portal/reports-model.test.mjs
//
// Covers js/portal/reports-model.js. Every failure this file guards against
// is silent on screen and loud in April: a New Year's Eve payment counted in
// the wrong year, a meal deducted in full, a contractor at exactly the 1099
// threshold missed, an invoice paid in January not shown as owed in
// December, a draft forgotten for a week that the front page did not name.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_NEC_THRESHOLD_CENTS,
  MONTH_SHORT,
  byClient,
  byMonth,
  compareLines,
  contractorsCsv,
  csvFilename,
  dashboardFigures,
  daysBetween,
  dayNumber,
  expensesCsv,
  inMonth,
  inYear,
  invoiceLabel,
  invoicesCsv,
  methodLabel,
  moneyCsv,
  outstandingCents,
  overdueInvoices,
  paymentsCsv,
  receiptCount,
  recentActivity,
  scheduleCLabel,
  staleDrafts,
  taxYearSummary,
  unreceiptedExpenses,
  vendors1099,
  yearChoices,
  yearOf,
} from '../../js/portal/reports-model.js';

// Fixtures — one small business, one tax year (2026), with the edges that
// matter placed on purpose: the last day of the year, the first of the next.
// ---------------------------------------------------------------------------

const CATEGORIES = [
  { id: 'c-ads', code: 'advertising', name: 'Advertising & marketing', schedule_c_line: '8', half_deductible: false, position: 10 },
  { id: 'c-contract', code: 'contract_labor', name: 'Contract labor', schedule_c_line: '11', half_deductible: false, position: 30 },
  { id: 'c-meals', code: 'meals', name: 'Business meals', schedule_c_line: '24b', half_deductible: true, position: 90 },
  { id: 'c-soft', code: 'software', name: 'Software & subscriptions', schedule_c_line: '27a', half_deductible: false, position: 100 },
  { id: 'c-host', code: 'hosting', name: 'Hosting & domains', schedule_c_line: '27a', half_deductible: false, position: 120 },
];

const CLIENTS = [
  { id: 'cl-1', name: 'Acme' },
  { id: 'cl-2', name: 'Bolt' },
];

const VENDORS = [
  { id: 'v-dev', name: 'Dev Contractor', email: 'dev@example.com', files_1099: true, tax_id_on_file: false },
  { id: 'v-soft', name: 'SoftCo', files_1099: false, tax_id_on_file: false },
  { id: 'v-eq', name: 'Equal Design', files_1099: true, tax_id_on_file: true },
  { id: 'v-idle', name: 'Idle Contractor', files_1099: true, tax_id_on_file: true },
  { id: 'v-none', name: 'Never Paid', files_1099: false, tax_id_on_file: false },
];

const EXPENSES = [
  // Odd cents on a meal: the 50% limit has to round once, at the category.
  { id: 'e1', spent_on: '2026-01-15', category_id: 'c-meals', amount_cents: 10001, client_id: 'cl-1', receipts: [{ id: 'r1' }], created_at: '2026-01-15T10:00:00Z' },
  { id: 'e2', spent_on: '2026-06-30', category_id: 'c-meals', amount_cents: 5000, receipts: [], created_at: '2026-06-30T10:00:00Z' },
  // The last day of the year, and a receipt count rather than an embed.
  { id: 'e3', spent_on: '2026-12-31', category_id: 'c-soft', amount_cents: 12000, receipt_count: 2, vendor_id: 'v-soft', created_at: '2026-12-31T09:00:00Z' },
  // The first day of the next year: not this year's.
  { id: 'e4', spent_on: '2027-01-01', category_id: 'c-soft', amount_cents: 99900, vendor_id: 'v-soft', created_at: '2027-01-01T11:00:00Z' },
  // The last day of the previous year: not this year's either.
  { id: 'e5', spent_on: '2025-12-31', category_id: 'c-ads', amount_cents: 100, vendor_id: 'v-dev', created_at: '2025-12-31T10:00:00Z' },
  { id: 'e6', spent_on: '2026-03-01', category_id: 'c-ads', amount_cents: 20000, receipts: [], created_at: '2026-03-01T10:00:00Z' },
  // Exactly the 1099 threshold, to one contractor.
  { id: 'e7', spent_on: '2026-04-01', category_id: 'c-contract', amount_cents: 200000, vendor_id: 'v-dev', client_id: 'cl-2', receipts: [{ id: 'r7' }], created_at: '2026-04-01T10:00:00Z' },
  // A category that no longer exists.
  { id: 'e8', spent_on: '2026-05-05', category_id: 'c-gone', amount_cents: 700, receipts: [], created_at: '2026-05-05T10:00:00Z' },
  // A supplier refund.
  { id: 'e9', spent_on: '2026-07-07', category_id: 'c-host', amount_cents: -1500, receipts: [{ id: 'r9' }], created_at: '2026-07-07T10:00:00Z' },
  // Not enough to matter, but to a vendor with a W-9 and the 1099 box ticked.
  { id: 'e10', spent_on: '2026-02-02', category_id: 'c-contract', amount_cents: 199999, vendor_id: 'v-eq', receipts: [{ id: 'r10' }], created_at: '2026-02-02T10:00:00Z' },
  // Big spend on a vendor nobody flagged for a 1099.
  { id: 'e11', spent_on: '2026-09-09', category_id: 'c-soft', amount_cents: 300000, vendor_id: 'v-soft', receipts: [{ id: 'r11' }], created_at: '2026-09-09T10:00:00Z' },
];

const INVOICES = [
  { id: 'inv-a', client_id: 'cl-1', number: '20260102-1', status: 'paid', issued_on: '2026-01-02', due_on: '2026-01-17', subtotal_cents: 43000, tax_cents: 2000, total_cents: 45000, paid_cents: 45000, paid_at: '2026-08-01T12:00:00+00:00', created_at: '2026-01-02T09:00:00Z', updated_at: '2026-08-01T12:00:00Z' },
  { id: 'inv-b', client_id: 'cl-2', number: '20261220-1', status: 'paid', issued_on: '2026-12-20', due_on: '2027-01-04', subtotal_cents: 30000, tax_cents: 0, total_cents: 30000, paid_cents: 30000, paid_at: '2026-12-31T12:00:00+00:00', created_at: '2026-12-20T09:00:00Z', updated_at: '2026-12-31T12:00:00Z' },
  // Raised in December, paid in January: owed at year end, tax not this year's.
  { id: 'inv-c', client_id: 'cl-2', number: '20261228-1', status: 'paid', issued_on: '2026-12-28', due_on: '2027-01-12', subtotal_cents: 39500, tax_cents: 500, total_cents: 40000, paid_cents: 40000, paid_at: '2027-01-01T12:00:00+00:00', created_at: '2026-12-28T09:00:00Z', updated_at: '2027-01-01T12:00:00Z' },
  // Still open.
  { id: 'inv-d', client_id: 'cl-1', number: '20261101-1', status: 'sent', issued_on: '2026-11-01', due_on: '2026-11-16', subtotal_cents: 20000, tax_cents: 0, total_cents: 20000, paid_cents: 0, paid_at: null, created_at: '2026-11-01T09:00:00Z', updated_at: '2026-11-01T09:00:00Z' },
  // A draft: nobody's document yet.
  { id: 'inv-e', client_id: 'cl-1', number: '20261201-1', status: 'draft', issued_on: '2026-12-01', due_on: '2026-12-16', subtotal_cents: 999, tax_cents: 0, total_cents: 999, paid_cents: 0, paid_at: null, created_at: '2026-12-01T09:00:00Z', updated_at: '2026-12-03T10:00:00Z' },
  // Void: taken back.
  { id: 'inv-f', client_id: 'cl-1', number: '20260601-1', status: 'void', issued_on: '2026-06-01', due_on: '2026-06-16', subtotal_cents: 5000, tax_cents: 0, total_cents: 5000, paid_cents: 0, paid_at: null, created_at: '2026-06-01T09:00:00Z', updated_at: '2026-06-02T09:00:00Z' },
  // Last year's, settled last year: a prior-year payment must still count
  // towards what was owed at this year's end.
  { id: 'inv-z', client_id: 'cl-1', number: '20251101-1', status: 'paid', issued_on: '2025-11-01', due_on: '2025-11-16', subtotal_cents: 10000, tax_cents: 0, total_cents: 10000, paid_cents: 10000, paid_at: '2025-12-31T12:00:00+00:00', created_at: '2025-11-01T09:00:00Z', updated_at: '2025-12-31T12:00:00Z' },
  // Next year's.
  { id: 'inv-g', client_id: 'cl-2', number: '20270105-1', status: 'sent', issued_on: '2027-01-05', due_on: '2027-01-20', subtotal_cents: 7000, tax_cents: 0, total_cents: 7000, paid_cents: 0, paid_at: null, created_at: '2027-01-05T09:00:00Z', updated_at: '2027-01-05T09:00:00Z' },
];

const PAYMENTS = [
  { id: 'p1', invoice_id: 'inv-a', client_id: 'cl-1', received_on: '2026-01-05', amount_cents: 50000, method: 'ach', created_at: '2026-01-05T10:00:00Z' },
  { id: 'p2', invoice_id: 'inv-b', client_id: 'cl-2', received_on: '2026-12-31', amount_cents: 30000, method: 'check', reference: '1042', created_at: '2026-12-31T10:00:00Z' },
  { id: 'p3', invoice_id: 'inv-c', client_id: 'cl-2', received_on: '2027-01-01', amount_cents: 40000, method: 'ach', created_at: '2027-01-01T10:00:00Z' },
  { id: 'p4', invoice_id: 'inv-z', client_id: 'cl-1', received_on: '2025-12-31', amount_cents: 10000, method: 'ach', created_at: '2025-12-31T10:00:00Z' },
  // A refund: a negative payment.
  { id: 'p5', invoice_id: 'inv-a', client_id: 'cl-1', received_on: '2026-08-01', amount_cents: -5000, method: 'ach', created_at: '2026-08-01T10:00:00Z' },
];

const YEAR = '2026';

function summary() {
  return taxYearSummary({
    payments: PAYMENTS, invoices: INVOICES, expenses: EXPENSES, categories: CATEGORIES, year: YEAR,
  });
}

// Dates
// ---------------------------------------------------------------------------

test('a year is the first four characters of the string, never a Date', () => {
  assert.equal(yearOf('2026-12-31'), '2026');
  // Midnight UTC on New Year's Day is still the 31st in Texas; as a Date this
  // would come back 2025 west of Greenwich. As a string it cannot.
  assert.equal(yearOf('2027-01-01T00:00:00+00:00'), '2027');
  assert.equal(yearOf('2026-12-31T23:59:59Z'), '2026');
  assert.equal(yearOf(''), '');
  assert.equal(yearOf(null), '');
  assert.equal(yearOf('nope'), '');

  assert.equal(inYear('2026-12-31', 2026), true);
  assert.equal(inYear('2027-01-01', '2026'), false);
  assert.equal(inYear('2025-12-31', '2026'), false);
  assert.equal(inYear('2026-06-01', ''), false);
  assert.equal(inYear(null, '2026'), false);

  assert.equal(inMonth('2026-03-31', '2026-03'), true);
  assert.equal(inMonth('2026-04-01', '2026-03'), false);
  assert.equal(inMonth('2026-03-31T23:00:00Z', '2026-03'), true);
});

test('day arithmetic counts calendar days and knows leap years', () => {
  assert.equal(daysBetween('2026-02-28', '2026-03-01'), 1);
  assert.equal(daysBetween('2028-02-28', '2028-03-01'), 2);
  assert.equal(daysBetween('2026-01-01', '2026-12-31'), 364);
  assert.equal(daysBetween('2026-11-16', '2026-12-01'), 15);
  // Timestamps are cut to their date.
  assert.equal(daysBetween('2026-12-02T23:59:59Z', '2026-12-10'), 8);
  assert.ok(Number.isNaN(dayNumber('')));
  assert.ok(Number.isNaN(dayNumber('2026-13')));
  assert.ok(Number.isNaN(daysBetween(null, '2026-01-01')));
});

test('the year picker offers this year and the previous three', () => {
  assert.deepEqual(yearChoices('2026-09-02'), ['2026', '2025', '2024', '2023']);
  assert.deepEqual(yearChoices('2026-09-02', 2), ['2026', '2025']);
  assert.deepEqual(yearChoices(''), []);
});

// Schedule C lines
// ---------------------------------------------------------------------------

test('lines sort by number then letter, and anything odd sorts last', () => {
  const lines = ['27a', '9', '24b', '11', '8', '24a', 'zzz', '16b', '16a'];
  assert.deepEqual([...lines].sort(compareLines),
    ['8', '9', '11', '16a', '16b', '24a', '24b', '27a', 'zzz']);
  assert.equal(scheduleCLabel('24b'), 'Line 24b · Deductible meals');
  assert.equal(scheduleCLabel('99'), 'Line 99');
  assert.equal(scheduleCLabel(''), 'No Schedule C line');
});

// The tax year
// ---------------------------------------------------------------------------

test('gross receipts are the payments received in the year, refunds included', () => {
  const s = summary();
  // p1 50000 + p2 30000 (Dec 31) − p5 5000; p3 (Jan 1 next) and p4 (Dec 31 last) excluded.
  assert.equal(s.gross_receipts_cents, 75000);
});

test('sales tax collected follows paid_at, not issued_on', () => {
  const s = summary();
  // inv-a's 2000 (paid in August); inv-c's 500 was paid on Jan 1 2027.
  assert.equal(s.sales_tax_collected_cents, 2000);
});

test('expenses group by Schedule C line in line order, categories in owner order', () => {
  const s = summary();
  assert.deepEqual(s.by_line.map((line) => line.schedule_c_line), ['8', '11', '24b', '27a']);
  assert.equal(s.by_line[0].label, 'Line 8 · Advertising');

  const other = s.by_line.find((line) => line.schedule_c_line === '27a');
  assert.deepEqual(other.categories.map((c) => c.name),
    ['Software & subscriptions', 'Hosting & domains', 'Uncategorised']);
  assert.equal(other.categories[0].total_cents, 312000);
  assert.equal(other.categories[0].count, 2);
  assert.equal(other.categories[1].total_cents, -1500);
  // The category that no longer exists still has a row, under Other.
  assert.equal(other.categories[2].total_cents, 700);
  assert.equal(other.categories[2].id, 'c-gone');
  assert.equal(other.total_cents, 311200);
  assert.equal(other.deductible_cents, 311200);
});

test('meals show in full and at 50%, rounded once at the category', () => {
  const s = summary();
  const meals = s.by_line.find((line) => line.schedule_c_line === '24b');
  assert.equal(meals.categories.length, 1);
  assert.equal(meals.categories[0].half_deductible, true);
  assert.equal(meals.categories[0].total_cents, 15001);
  // 7500.5 rounds to 7501 — one rounding, not one per receipt.
  assert.equal(meals.categories[0].deductible_cents, 7501);
  assert.equal(meals.total_cents, 15001);
  assert.equal(meals.deductible_cents, 7501);
});

test('the totals: as spent, deductible, and net of gross receipts', () => {
  const s = summary();
  // e1 10001 + e2 5000 + e3 12000 + e6 20000 + e7 200000 + e8 700 − e9 1500 + e10 199999 + e11 300000
  assert.equal(s.expenses_total_cents, 746200);
  assert.equal(s.expense_count, 9);
  // Everything at full value except the meals at 7501 instead of 15001.
  assert.equal(s.deductible_total_cents, 746200 - 7500);
  assert.equal(s.net_cents, 75000 - 738700);
  assert.equal(s.year, '2026');
});

test('the year boundary is the date string: Dec 31 is in, Jan 1 is out', () => {
  const s = summary();
  const soft = s.by_line.find((line) => line.schedule_c_line === '27a').categories[0];
  // e3 on 2026-12-31 and e11 count; e4 on 2027-01-01 does not.
  assert.equal(soft.total_cents, 312000);
  const ads = s.by_line.find((line) => line.schedule_c_line === '8');
  // e6 counts; e5 on 2025-12-31 does not.
  assert.equal(ads.total_cents, 20000);
});

test('receivable at year end: raised by the 31st, less payments received by the 31st', () => {
  const s = summary();
  // inv-c (40000, paid Jan 1) + inv-d (20000, still open). inv-b was paid on
  // the 31st itself; inv-z was settled by a prior-year payment; inv-e is a
  // draft, inv-f void, inv-g raised next year.
  assert.equal(s.receivable_at_year_end_cents, 60000);
  assert.equal(s.receivable_at_year_end_count, 2);
});

test('unreceipted counts the year\'s expenses with no receipt, whatever shape the row has', () => {
  const s = summary();
  // e2, e6, e8 have empty embeds; e3 carries receipt_count: 2; the rest have one.
  assert.equal(s.unreceipted_count, 3);

  assert.equal(receiptCount({ receipts: [{}, {}] }), 2);
  assert.equal(receiptCount({ expense_receipts: [{}] }), 1);
  assert.equal(receiptCount({ receipt_count: 3 }), 3);
  assert.equal(receiptCount({ receipt_count: '2' }), 2);
  assert.equal(receiptCount({}), 0);
  assert.equal(receiptCount(null), 0);
  // The helper itself does not know the year; the summary applies it.
  assert.deepEqual(unreceiptedExpenses(EXPENSES).map((row) => row.id), ['e2', 'e4', 'e5', 'e6', 'e8']);
});

test('an empty year is all zeros and no lines', () => {
  const s = taxYearSummary({ year: '2024' });
  assert.equal(s.gross_receipts_cents, 0);
  assert.equal(s.sales_tax_collected_cents, 0);
  assert.deepEqual(s.by_line, []);
  assert.equal(s.expenses_total_cents, 0);
  assert.equal(s.deductible_total_cents, 0);
  assert.equal(s.net_cents, 0);
  assert.equal(s.receivable_at_year_end_cents, 0);
  assert.equal(s.unreceipted_count, 0);
});

test('a row carrying its own category embed is grouped even when the list lacks it', () => {
  const s = taxYearSummary({
    year: '2026',
    categories: [],
    expenses: [{
      id: 'x', spent_on: '2026-02-02', category_id: 'c-emb', amount_cents: 400,
      category: { id: 'c-emb', name: 'Embedded', schedule_c_line: '15', half_deductible: false },
    }],
  });
  assert.equal(s.by_line[0].schedule_c_line, '15');
  assert.equal(s.by_line[0].categories[0].name, 'Embedded');
});

// By client and by month
// ---------------------------------------------------------------------------

test('by client: invoiced, received, spent on their behalf, and still owed', () => {
  const rows = byClient({
    invoices: INVOICES, payments: PAYMENTS, expenses: EXPENSES, clients: CLIENTS, year: YEAR,
  });
  assert.deepEqual(rows.map((row) => row.client), ['Acme', 'Bolt']);

  const acme = rows[0];
  assert.equal(acme.client_id, 'cl-1');
  assert.equal(acme.invoiced, 65000); // inv-a 45000 + inv-d 20000; draft, void and 2025 excluded
  assert.equal(acme.received, 45000); // 50000 − 5000 refund; 2025 excluded
  assert.equal(acme.expenses, 10001); // e1
  assert.equal(acme.outstanding, 20000); // inv-d

  const bolt = rows[1];
  assert.equal(bolt.invoiced, 70000); // inv-b + inv-c; inv-g is 2027
  assert.equal(bolt.received, 30000); // p2; p3 is 2027
  assert.equal(bolt.expenses, 200000); // e7
  assert.equal(bolt.outstanding, 0);
});

test('by client names a client the list does not know, and skips overhead', () => {
  const rows = byClient({
    expenses: [
      { spent_on: '2026-03-03', client_id: 'cl-x', amount_cents: 100 },
      { spent_on: '2026-03-03', client_id: null, amount_cents: 900 },
    ],
    clients: [],
    year: '2026',
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].client, 'Unknown client');
  assert.equal(rows[0].expenses, 100);
});

test('by month is twelve rows, January to December, with the quiet months present', () => {
  const rows = byMonth({ payments: PAYMENTS, expenses: EXPENSES, year: YEAR });
  assert.equal(rows.length, 12);
  assert.deepEqual(rows.map((row) => row.label), MONTH_SHORT);
  assert.equal(rows[0].month, '2026-01');
  assert.equal(rows[11].month, '2026-12');

  assert.equal(rows[0].received, 50000);
  assert.equal(rows[0].spent, 10001);
  assert.equal(rows[0].net, 39999);

  // Row 1 (February) has e10 only; row 7 (August) has the refund.
  assert.equal(rows[1].received, 0);
  assert.equal(rows[1].spent, 199999);
  assert.equal(rows[7].received, -5000);

  // December: the payment on the 31st and the expense on the 31st.
  assert.equal(rows[11].received, 30000);
  assert.equal(rows[11].spent, 12000);
  assert.equal(rows[11].net, 18000);

  const totalReceived = rows.reduce((sum, row) => sum + row.received, 0);
  assert.equal(totalReceived, summary().gross_receipts_cents);
});

// Overdue and stale
// ---------------------------------------------------------------------------

test('overdue: open, past due, still owed on — most late first', () => {
  const invoices = [
    ...INVOICES,
    // Due today: not late yet.
    { id: 'inv-h', status: 'sent', due_on: '2026-12-01', total_cents: 100, paid_cents: 0 },
    // Issued but fully covered (the trigger has not flipped it yet): nothing owed.
    { id: 'inv-i', status: 'issued', due_on: '2026-10-01', total_cents: 1000, paid_cents: 1000 },
    { id: 'inv-j', status: 'sent', due_on: '2026-09-01', total_cents: 500, paid_cents: 0 },
    // Part paid.
    { id: 'inv-k', status: 'issued', due_on: '2026-11-30', total_cents: 1000, paid_cents: 250 },
  ];
  const late = overdueInvoices(invoices, '2026-12-01');
  assert.deepEqual(late.map((row) => row.invoice.id), ['inv-j', 'inv-d', 'inv-k']);
  assert.deepEqual(late.map((row) => row.days), [91, 15, 1]);
  assert.deepEqual(late.map((row) => row.outstanding), [500, 20000, 750]);

  assert.deepEqual(overdueInvoices(invoices, ''), []);
  assert.deepEqual(overdueInvoices([], '2026-12-01'), []);

  assert.equal(outstandingCents({ status: 'sent', total_cents: 100, paid_cents: 40 }), 60);
  assert.equal(outstandingCents({ status: 'paid', total_cents: 100, paid_cents: 100 }), 0);
  assert.equal(outstandingCents({ status: 'draft', total_cents: 100, paid_cents: 0 }), 0);
  assert.equal(outstandingCents({ status: 'void', total_cents: 100, paid_cents: 0 }), 0);
});

test('stale drafts: untouched for more than seven days, judged on updated_at', () => {
  const invoices = [
    ...INVOICES, // inv-e: draft updated 2026-12-03 → 7 days on the 10th: not stale
    { id: 'd-8', status: 'draft', created_at: '2026-11-01T09:00:00Z', updated_at: '2026-12-02T09:00:00Z' },
    // Old, but edited yesterday.
    { id: 'd-fresh', status: 'draft', created_at: '2026-10-01T09:00:00Z', updated_at: '2026-12-09T09:00:00Z' },
    // No updated_at at all: created_at stands in.
    { id: 'd-old', status: 'draft', created_at: '2026-11-01T09:00:00Z' },
    { id: 'not-a-draft', status: 'sent', created_at: '2026-01-01T09:00:00Z', updated_at: '2026-01-01T09:00:00Z' },
  ];
  const stale = staleDrafts(invoices, '2026-12-10');
  assert.deepEqual(stale.map((row) => row.invoice.id), ['d-old', 'd-8']);
  assert.deepEqual(stale.map((row) => row.days), [39, 8]);

  // The boundary is configurable.
  assert.deepEqual(staleDrafts(invoices, '2026-12-10', 6).map((row) => row.invoice.id),
    ['d-old', 'd-8', 'inv-e']);
  assert.deepEqual(staleDrafts(invoices, ''), []);
});

// 1099
// ---------------------------------------------------------------------------

test('1099: reaching the threshold exactly counts as over it', () => {
  const rows = vendors1099({ expenses: EXPENSES, vendors: VENDORS, year: YEAR });
  const byId = Object.fromEntries(rows.map((row) => [row.vendor.id, row]));

  // Exactly $2,000: over. Flagged, no W-9: the November job.
  assert.equal(byId['v-dev'].total_cents, DEFAULT_NEC_THRESHOLD_CENTS);
  assert.equal(byId['v-dev'].over_threshold, true);
  assert.equal(byId['v-dev'].reportable, true);
  assert.equal(byId['v-dev'].missing_tax_id, true);

  // One cent under: not over.
  assert.equal(byId['v-eq'].total_cents, 199999);
  assert.equal(byId['v-eq'].over_threshold, false);
  assert.equal(byId['v-eq'].reportable, false);
  assert.equal(byId['v-eq'].missing_tax_id, false);

  // Over, but nobody ticked the 1099 box: a software company, not a contractor.
  assert.equal(byId['v-soft'].total_cents, 312000);
  assert.equal(byId['v-soft'].over_threshold, true);
  assert.equal(byId['v-soft'].reportable, false);

  // Flagged and unpaid this year: still listed, at zero.
  assert.equal(byId['v-idle'].total_cents, 0);
  assert.equal(byId['v-idle'].reportable, false);

  // Never paid, never flagged: not a row.
  assert.equal(byId['v-none'], undefined);

  // Highest spend first.
  assert.deepEqual(rows.map((row) => row.vendor.id), ['v-soft', 'v-dev', 'v-eq', 'v-idle']);
});

test('1099: the threshold is the owner\'s, the year is a filter, garbage falls back', () => {
  const low = vendors1099({ expenses: EXPENSES, vendors: VENDORS, year: YEAR, thresholdCents: 60000 });
  assert.equal(low.find((row) => row.vendor.id === 'v-eq').reportable, true);

  // v-dev's 2025 spend is not 2026's.
  const last = vendors1099({ expenses: EXPENSES, vendors: VENDORS, year: '2025' });
  assert.equal(last.find((row) => row.vendor.id === 'v-dev').total_cents, 100);
  assert.equal(last.find((row) => row.vendor.id === 'v-dev').over_threshold, false);

  const fallback = vendors1099({ expenses: EXPENSES, vendors: VENDORS, year: YEAR, thresholdCents: 0 });
  assert.equal(fallback.find((row) => row.vendor.id === 'v-dev').over_threshold, true);
  assert.equal(fallback.find((row) => row.vendor.id === 'v-eq').over_threshold, false);
});

// The dashboard
// ---------------------------------------------------------------------------

test('the dashboard figures: owed now, late now, this month, this year', () => {
  const figures = dashboardFigures({
    invoices: INVOICES, payments: PAYMENTS, expenses: EXPENSES, today: '2026-12-15',
  });
  // Every open invoice, whatever its date: inv-d 20000 and inv-g 7000.
  assert.equal(figures.outstanding_cents, 27000);
  // Only inv-d is past due; inv-g falls due in January.
  assert.equal(figures.overdue_cents, 20000);
  assert.equal(figures.overdue_count, 1);
  // The month is the calendar month, not "the month so far": a payment
  // dated the 31st is December's on the 15th too. Rows dated ahead of today
  // are the bookkeeper's to explain, not the figure's to hide.
  assert.equal(figures.received_month_cents, 30000); // p2
  assert.equal(figures.invoiced_month_cents, 70000); // inv-b + inv-c; inv-e is a draft
  assert.equal(figures.income_ytd_cents, 75000);
  assert.equal(figures.expenses_ytd_cents, 746200);
  assert.equal(figures.net_ytd_cents, 75000 - 746200);

  const november = dashboardFigures({
    invoices: INVOICES, payments: PAYMENTS, expenses: EXPENSES, today: '2026-11-15',
  });
  assert.equal(november.received_month_cents, 0);
  assert.equal(november.invoiced_month_cents, 20000); // inv-d
  assert.equal(november.overdue_cents, 0); // inv-d falls due on the 16th

  const empty = dashboardFigures({ today: '2026-01-01' });
  assert.equal(empty.outstanding_cents, 0);
  assert.equal(empty.net_ytd_cents, 0);
});

test('recent activity merges the three tables newest first and stops at the limit', () => {
  const items = recentActivity({ invoices: INVOICES, payments: PAYMENTS, expenses: EXPENSES }, 5);
  assert.equal(items.length, 5);
  assert.deepEqual(items.map((item) => `${item.kind}:${item.id}`),
    ['invoice:inv-g', 'expense:e4', 'payment:p3', 'payment:p2', 'expense:e3']);
  // Same day: the later entry first.
  assert.equal(items[3].date, '2026-12-31');
  assert.equal(items[4].date, '2026-12-31');

  const all = recentActivity({ invoices: INVOICES, payments: PAYMENTS, expenses: EXPENSES });
  assert.equal(all.length, 8);
  assert.equal(all[0].amount_cents, 7000);
  assert.equal(all[0].number, '20270105-1');
});

// CSV
// ---------------------------------------------------------------------------

test('filenames say the year and the contents', () => {
  assert.equal(csvFilename('2026', 'invoices'), 'wo-2026-invoices.csv');
  assert.equal(csvFilename(2025, '1099'), 'wo-2025-1099.csv');
  assert.equal(moneyCsv(123456), '1234.56');
  assert.equal(moneyCsv(-5), '-0.05');
  assert.equal(moneyCsv(null), '0.00');
  assert.equal(methodLabel('ach'), 'ACH');
  assert.equal(methodLabel('wire'), 'wire');
  assert.equal(methodLabel(null), '');
  assert.equal(invoiceLabel('20260901-1'), 'Invoice 20260901-1');
  assert.equal(invoiceLabel(''), 'Invoice —');
});

test('the invoices CSV: the year\'s invoices in date order, owed blank on drafts and voids', () => {
  const file = invoicesCsv({ invoices: INVOICES, clients: CLIENTS, year: YEAR });
  assert.equal(file.filename, 'wo-2026-invoices.csv');
  assert.deepEqual(file.headers, ['Number', 'Client', 'Status', 'Issued', 'Due', 'Project', 'PO',
    'Subtotal', 'Tax', 'Total', 'Paid', 'Outstanding', 'Paid on']);
  assert.deepEqual(file.rows.map((row) => row[0]),
    ['20260102-1', '20260601-1', '20261101-1', '20261201-1', '20261220-1', '20261228-1']);

  const sent = file.rows.find((row) => row[0] === '20261101-1');
  assert.deepEqual(sent, ['20261101-1', 'Acme', 'sent', '2026-11-01', '2026-11-16', '', '',
    '200.00', '0.00', '200.00', '0.00', '200.00', '']);

  const paid = file.rows.find((row) => row[0] === '20260102-1');
  assert.equal(paid[8], '20.00');
  assert.equal(paid[11], '0.00');
  assert.equal(paid[12], '2026-08-01');

  const draft = file.rows.find((row) => row[0] === '20261201-1');
  assert.equal(draft[11], '');
  const voided = file.rows.find((row) => row[0] === '20260601-1');
  assert.equal(voided[11], '');
});

test('the payments CSV names the invoice and the client', () => {
  const file = paymentsCsv({ payments: PAYMENTS, invoices: INVOICES, clients: CLIENTS, year: YEAR });
  assert.equal(file.filename, 'wo-2026-payments.csv');
  assert.deepEqual(file.headers, ['Received', 'Client', 'Invoice', 'Amount', 'Method', 'Reference', 'Notes']);
  assert.deepEqual(file.rows, [
    ['2026-01-05', 'Acme', '20260102-1', '500.00', 'ACH', '', ''],
    ['2026-08-01', 'Acme', '20260102-1', '-50.00', 'ACH', '', ''],
    ['2026-12-31', 'Bolt', '20261220-1', '300.00', 'Check', '1042', ''],
  ]);
});

test('the expenses CSV carries the Schedule C line, category, vendor, client and receipt count', () => {
  const file = expensesCsv({
    expenses: EXPENSES, categories: CATEGORIES, vendors: VENDORS, clients: CLIENTS, year: YEAR,
  });
  assert.equal(file.filename, 'wo-2026-expenses.csv');
  assert.deepEqual(file.headers, ['Date', 'Vendor', 'Description', 'Schedule C line', 'Category',
    'Amount', 'Deductible note', 'Method', 'Reference', 'Client', 'Billable', 'Billed',
    'Where', 'Business purpose', 'Who was there', 'Receipts on file']);
  assert.equal(file.rows.length, 9);
  assert.equal(file.rows[0][0], '2026-01-15');

  const meal = file.rows.find((row) => row[0] === '2026-01-15');
  assert.equal(meal[3], '24b');
  assert.equal(meal[4], 'Business meals');
  assert.equal(meal[5], '100.01');
  assert.equal(meal[6], '50% deductible');
  assert.equal(meal[9], 'Acme');
  assert.equal(meal[15], 1);

  const contractor = file.rows.find((row) => row[0] === '2026-04-01');
  assert.equal(contractor[1], 'Dev Contractor');
  assert.equal(contractor[3], '11');
  assert.equal(contractor[9], 'Bolt');
  assert.equal(contractor[10], 'no');

  const gone = file.rows.find((row) => row[0] === '2026-05-05');
  assert.equal(gone[3], '27a');
  assert.equal(gone[4], 'Uncategorised');
  assert.equal(gone[15], 0);

  const counted = file.rows.find((row) => row[0] === '2026-12-31');
  assert.equal(counted[1], 'SoftCo');
  assert.equal(counted[15], 2);
});

test('the 1099 CSV is the vendor list with the year in the heading', () => {
  const rows = vendors1099({ expenses: EXPENSES, vendors: VENDORS, year: YEAR });
  const file = contractorsCsv({ rows, year: YEAR });
  assert.equal(file.filename, 'wo-2026-1099.csv');
  assert.equal(file.headers[4], 'Paid in 2026');
  const dev = file.rows.find((row) => row[0] === 'Dev Contractor');
  assert.deepEqual(dev, ['Dev Contractor', 'dev@example.com', '', '', '2000.00', 'yes', 'yes', 'no']);
  const soft = file.rows.find((row) => row[0] === 'SoftCo');
  assert.deepEqual(soft.slice(4), ['3120.00', 'yes', 'no', 'no']);
});
