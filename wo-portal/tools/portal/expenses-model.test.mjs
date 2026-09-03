// ---------------------------------------------------------------------------
// The expense arithmetic.
//
//   node --test tools/portal/expenses-model.test.mjs
//
// Covers js/portal/expenses-model.js. Every failure this file guards against
// is silent on screen and loud in April: an invoice in the wrong ageing
// bucket, a 1099 threshold missed by a dollar, a meal with no story that the
// list called complete, a subscription that billed February on the 31st, a
// filter that dropped a row the search should have found.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AGING_BUCKETS,
  DEFAULT_NEC_THRESHOLD_CENTS,
  PAYMENT_METHODS,
  RECEIPT_TYPES,
  agingReport,
  categoryOptions,
  clampDay,
  compareLines,
  expensePatch,
  expenseYear,
  filterExpenses,
  formatSigned,
  isSubstantiated,
  matchVendor,
  methodLabel,
  monthName,
  monthSpans,
  receiptMime,
  receiptsOf,
  recentValues,
  recurringPatch,
  recurringSpentOn,
  recurringStatus,
  scheduleCLabel,
  substantiationGaps,
  sumCents,
  vendorNameOf,
  vendorTotals,
  yearOptions,
} from '../../js/portal/expenses-model.js';

// Money and methods
// ---------------------------------------------------------------------------

test('the payment methods are the enum in schema.sql, and each has a label', () => {
  assert.deepEqual(PAYMENT_METHODS.map((m) => m.value),
    ['ach', 'check', 'zelle', 'card', 'cash', 'other']);
  assert.equal(methodLabel('ach'), 'ACH');
  assert.equal(methodLabel('zelle'), 'Zelle');
  // An unknown value prints as itself rather than as "undefined".
  assert.equal(methodLabel('wire'), 'wire');
  assert.equal(methodLabel(null), '');
});

test('a negative amount prints in parentheses, the way a preparer reads it', () => {
  assert.equal(formatSigned(123456), '$1,234.56');
  assert.equal(formatSigned(-4500), '($45.00)');
  assert.equal(formatSigned(0), '$0.00');
  assert.equal(formatSigned('nonsense'), '$0.00');
});

test('sumCents adds rows or bare numbers, and ignores garbage', () => {
  assert.equal(sumCents([{ amount_cents: 100 }, { amount_cents: -40 }, { amount_cents: 'x' }]), 60);
  assert.equal(sumCents([100, 250, null]), 350);
  assert.equal(sumCents([]), 0);
  assert.equal(sumCents(null), 0);
});

// Schedule C
// ---------------------------------------------------------------------------

test('Schedule C lines sort as numbers with their suffix, not as strings', () => {
  const lines = ['27a', '8', '24b', '11', '24a', '9'].sort(compareLines);
  assert.deepEqual(lines, ['8', '9', '11', '24a', '24b', '27a']);
});

test('a line prints with its caption where it has one', () => {
  assert.equal(scheduleCLabel('24b'), 'Line 24b · Meals');
  assert.equal(scheduleCLabel('12'), 'Line 12');
  assert.equal(scheduleCLabel(''), '');
});

test('category options are grouped by line, then in the owner\'s order, with the line in the label', () => {
  const options = categoryOptions([
    { id: 'c', name: 'Miscellaneous', schedule_c_line: '27a', position: 900 },
    { id: 'a', name: 'Business meals', schedule_c_line: '24b', position: 90 },
    { id: 'b', name: 'Software & subscriptions', schedule_c_line: '27a', position: 100 },
    { id: 'd', name: 'Advertising', schedule_c_line: '8', position: 10 },
  ]);
  assert.deepEqual(options.map((o) => o.value), ['d', 'a', 'b', 'c']);
  assert.equal(options[1].label, '24b · Business meals');
});

test('an archived category is offered only to the expense already booked to it', () => {
  const categories = [
    { id: 'live', name: 'Live', schedule_c_line: '8', position: 1 },
    { id: 'old', name: 'Old', schedule_c_line: '8', position: 2, archived_at: '2026-01-01T00:00:00Z' },
  ];
  assert.deepEqual(categoryOptions(categories).map((o) => o.value), ['live']);
  const kept = categoryOptions(categories, { keepId: 'old' });
  assert.deepEqual(kept.map((o) => o.value), ['live', 'old']);
  assert.match(kept[1].label, /archived/);
});

// Accounts receivable ageing
// ---------------------------------------------------------------------------

function invoice(number, status, dueOn, total, paid = 0, client = 'Acme') {
  return {
    id: `inv-${number}`,
    client_id: `client-${client}`,
    number,
    status,
    due_on: dueOn,
    issued_on: dueOn,
    total_cents: total,
    paid_cents: paid,
    client: { name: client },
  };
}

test('an invoice lands in the bucket its age puts it in', () => {
  const report = agingReport([
    invoice(1, 'sent', '2026-08-20', 100000),  // not due yet
    invoice(2, 'sent', '2026-08-01', 100000),  // 7 days
    invoice(3, 'sent', '2026-07-01', 100000),  // 38 days
    invoice(4, 'sent', '2026-06-01', 100000),  // 68 days
    invoice(5, 'sent', '2026-01-01', 100000),  // 219 days
  ], '2026-08-08');

  assert.equal(report.totals.current, 100000);
  assert.equal(report.totals.d30, 100000);
  assert.equal(report.totals.d60, 100000);
  assert.equal(report.totals.d90, 100000);
  assert.equal(report.totals.older, 100000);
  assert.equal(report.total, 500000);
  assert.equal(report.overdue, 400000);
});

test('the boundary days fall on the right side', () => {
  const at = (due) => agingReport([invoice(1, 'sent', due, 1000)], '2026-08-08')
    .clients[0].rows[0].bucket;

  assert.equal(at('2026-08-08'), 'current');  // due today is not late
  assert.equal(at('2026-08-07'), 'd30');      // one day
  assert.equal(at('2026-07-09'), 'd30');      // 30 days
  assert.equal(at('2026-07-08'), 'd60');      // 31 days
  assert.equal(at('2026-06-08'), 'd90');      // 61 days
  assert.equal(at('2026-05-10'), 'd90');      // 90 days is the last day of it
  assert.equal(at('2026-05-09'), 'older');    // 91 days
});

test('drafts, voids and paid invoices are nobody owing anything', () => {
  const report = agingReport([
    invoice(1, 'draft', '2026-01-01', 100000),
    invoice(2, 'void', '2026-01-01', 100000),
    invoice(3, 'paid', '2026-01-01', 100000, 100000),
  ], '2026-08-08');

  assert.equal(report.total, 0);
  assert.equal(report.clients.length, 0);
});

test('only the unpaid part of a part-paid invoice is owed', () => {
  const report = agingReport([invoice(1, 'sent', '2026-08-01', 100000, 40000)], '2026-08-08');
  assert.equal(report.total, 60000);
});

test('an invoice with no due date is treated as due when it was issued', () => {
  const row = invoice(1, 'sent', null, 100000);
  row.issued_on = '2026-06-01';
  const report = agingReport([row], '2026-08-08');
  assert.equal(report.totals.current, 0);
  assert.equal(report.totals.d90, 100000);
});

test('what is owed is grouped by client, biggest first', () => {
  const report = agingReport([
    invoice(1, 'sent', '2026-08-01', 100000, 0, 'Acme'),
    invoice(2, 'sent', '2026-08-01', 500000, 0, 'Switch Commerce'),
    invoice(3, 'sent', '2026-08-01', 100000, 0, 'Acme'),
  ], '2026-08-08');

  assert.equal(report.clients.length, 2);
  assert.equal(report.clients[0].name, 'Switch Commerce');
  assert.equal(report.clients[0].total, 500000);
  assert.equal(report.clients[1].total, 200000);
});

test('the client name is read off either embed shape', () => {
  const njdShape = { ...invoice(1, 'sent', '2026-08-01', 1000), client: undefined, clients: { name: 'Old shape' } };
  assert.equal(agingReport([njdShape], '2026-08-08').clients[0].name, 'Old shape');
  const bare = { ...invoice(2, 'sent', '2026-08-01', 1000), client: undefined };
  assert.equal(agingReport([bare], '2026-08-08').clients[0].name, 'Unknown client');
});

test('every bucket key the report fills is one the screen knows how to print', () => {
  const report = agingReport([invoice(1, 'sent', '2026-01-01', 1000)], '2026-08-08');
  const keys = AGING_BUCKETS.map((row) => row.key);
  Object.keys(report.totals).forEach((key) => assert.ok(keys.includes(key)));
});

// 1099s
// ---------------------------------------------------------------------------

const CONTRACTOR = { id: 'v1', name: 'A Developer', files_1099: true, tax_id_on_file: true };
const NO_W9 = { id: 'v2', name: 'A Writer', files_1099: true, tax_id_on_file: false };
const SUPPLIER = { id: 'v3', name: 'Adobe', files_1099: false, tax_id_on_file: false };

test('a contractor over the threshold is reportable', () => {
  const rows = vendorTotals(
    [{ vendor_id: 'v1', spent_on: '2026-04-01', amount_cents: 250000 }],
    [CONTRACTOR], 2026);

  assert.equal(rows[0].total_cents, 250000);
  assert.equal(rows[0].files_1099, true);
  assert.equal(rows[0].tax_id_on_file, true);
  assert.equal(rows[0].over_threshold, true);
  assert.equal(rows[0].reportable, true);
  assert.equal(rows[0].missing_tax_id, false);
});

test('the default threshold is the 2026 figure, and it is a floor, not a ceiling', () => {
  assert.equal(DEFAULT_NEC_THRESHOLD_CENTS, 200000);
  const at = (cents) => vendorTotals(
    [{ vendor_id: 'v1', spent_on: '2026-04-01', amount_cents: cents }],
    [CONTRACTOR], 2026)[0].over_threshold;

  assert.equal(at(199999), false);
  assert.equal(at(200000), true);
});

test('the threshold is a parameter, because the IRS moves it', () => {
  const rows = vendorTotals(
    [{ vendor_id: 'v1', spent_on: '2025-04-01', amount_cents: 60000 }],
    [CONTRACTOR], 2025, 60000);
  assert.equal(rows[0].over_threshold, true);
  assert.equal(rows[0].reportable, true);
});

test('a reportable contractor with no W-9 on file is flagged', () => {
  const rows = vendorTotals(
    [{ vendor_id: 'v2', spent_on: '2026-04-01', amount_cents: 300000 }],
    [NO_W9], 2026);

  assert.equal(rows[0].reportable, true);
  assert.equal(rows[0].missing_tax_id, true);
});

test('a supplier who does not need a 1099 is never reportable, however much they were paid', () => {
  const rows = vendorTotals(
    [{ vendor_id: 'v3', spent_on: '2026-04-01', amount_cents: 900000 }],
    [SUPPLIER], 2026);

  assert.equal(rows[0].total_cents, 900000);
  assert.equal(rows[0].over_threshold, true);
  assert.equal(rows[0].reportable, false);
  assert.equal(rows[0].missing_tax_id, false);
});

test('spend is counted per calendar year, because that is what the form asks', () => {
  const expenses = [
    { vendor_id: 'v1', spent_on: '2025-12-31', amount_cents: 500000 },
    { vendor_id: 'v1', spent_on: '2026-01-01', amount_cents: 70000 },
  ];

  assert.equal(vendorTotals(expenses, [CONTRACTOR], 2026)[0].total_cents, 70000);
  assert.equal(vendorTotals(expenses, [CONTRACTOR], 2025)[0].total_cents, 500000);
});

test('several payments to one vendor add up across the year, and a refund comes off', () => {
  const rows = vendorTotals([
    { vendor_id: 'v1', spent_on: '2026-02-01', amount_cents: 130000 },
    { vendor_id: 'v1', spent_on: '2026-05-01', amount_cents: 90000 },
    { vendor_id: 'v1', spent_on: '2026-06-01', amount_cents: -10000 },
  ], [CONTRACTOR], 2026);

  assert.equal(rows[0].total_cents, 210000);
  assert.equal(rows[0].reportable, true);
});

test('a flagged contractor prints even on zero; an unflagged one on zero does not', () => {
  const rows = vendorTotals([], [CONTRACTOR, SUPPLIER], 2026);
  assert.deepEqual(rows.map((row) => row.vendor.id), ['v1']);
});

test('a one-off typed name with no vendor row is not on the 1099 list', () => {
  const rows = vendorTotals(
    [{ vendor_id: null, vendor_name: 'Somebody', spent_on: '2026-04-01', amount_cents: 900000 }],
    [CONTRACTOR], 2026);
  assert.equal(rows[0].total_cents, 0);
});

test('the biggest total is first', () => {
  const rows = vendorTotals([
    { vendor_id: 'v3', spent_on: '2026-04-01', amount_cents: 5000 },
    { vendor_id: 'v1', spent_on: '2026-04-01', amount_cents: 400000 },
  ], [SUPPLIER, CONTRACTOR], 2026);
  assert.deepEqual(rows.map((row) => row.vendor.id), ['v1', 'v3']);
});

// Substantiation
// ---------------------------------------------------------------------------

const MEALS = { code: 'meals', name: 'Business meals', needs_substantiation: true, needs_attendees: true };
const TRAVEL = { code: 'travel', name: 'Travel', needs_substantiation: true, needs_attendees: false };
const GIFTS = { code: 'gifts', name: 'Client gifts', needs_substantiation: true, needs_attendees: true };
const SOFTWARE = { code: 'software', name: 'Software', needs_substantiation: false, needs_attendees: false };
const WHO_ONLY = { code: 'odd', name: 'Attendees only', needs_substantiation: false, needs_attendees: true };

test('an ordinary expense needs no story at all', () => {
  assert.deepEqual(substantiationGaps({}, SOFTWARE), []);
  assert.equal(isSubstantiated({}, SOFTWARE), true);
});

test('a meal needs where, why and who', () => {
  const gaps = substantiationGaps({}, MEALS);
  assert.deepEqual(gaps, ['where it was', 'the business purpose', 'who was there']);
});

test('a complete meal passes', () => {
  const meal = {
    place: 'Rise Bakery',
    business_purpose: 'Discussing the rebrand',
    attendees: 'Dana Reid (client)',
  };
  assert.deepEqual(substantiationGaps(meal, MEALS), []);
  assert.equal(isSubstantiated(meal, MEALS), true);
});

test('travel needs where and why, but nobody has to name a hotel bill', () => {
  const gaps = substantiationGaps({ place: 'Austin' }, TRAVEL);
  assert.deepEqual(gaps, ['the business purpose']);
});

test('a gift needs the recipient, because that is the whole rule', () => {
  const gaps = substantiationGaps(
    { place: 'Dallas', business_purpose: 'Thank you for the referral' }, GIFTS,
  );
  assert.deepEqual(gaps, ['who was there']);
});

test('the two flags are independent', () => {
  assert.deepEqual(substantiationGaps({}, WHO_ONLY), ['who was there']);
  assert.deepEqual(substantiationGaps({ attendees: 'Dana' }, WHO_ONLY), []);
});

test('whitespace is not a business purpose', () => {
  const meal = { place: '  ', business_purpose: '\t', attendees: '' };
  assert.equal(substantiationGaps(meal, MEALS).length, 3);
});

test('an expense with no category on it is not judged', () => {
  assert.deepEqual(substantiationGaps({}, null), []);
  assert.deepEqual(substantiationGaps(null, MEALS).length, 3);
});

// The calendar
// ---------------------------------------------------------------------------

test('clampDay keeps a day inside its month', () => {
  assert.equal(clampDay(2026, 2, 31), 28);
  assert.equal(clampDay(2028, 2, 31), 29);   // leap year
  assert.equal(clampDay(2026, 4, 31), 30);
  assert.equal(clampDay(2026, 8, 31), 31);
  assert.equal(clampDay(2026, 8, 15), 15);
});

test('clampDay lands nonsense on the 1st rather than nowhere', () => {
  assert.equal(clampDay(2026, 8, 0), 1);
  assert.equal(clampDay(2026, 8, -3), 1);
  assert.equal(clampDay(2026, 8, 'x'), 1);
  assert.equal(clampDay(2026, 8, null), 1);
  assert.equal(clampDay(2026, 8, 15.7), 15);
});

test('expenseYear reads the year off spent_on', () => {
  assert.equal(expenseYear({ spent_on: '2026-08-15' }), 2026);
  assert.equal(expenseYear({ spent_on: null }), null);
  assert.equal(expenseYear(null), null);
});

test('monthName names a month without a Date object in the way', () => {
  assert.equal(monthName('2026-08-15'), 'August');
  assert.equal(monthName('2026-01-31', { withYear: true }), 'January 2026');
  assert.equal(monthName(''), '');
  assert.equal(monthName('2026-13-01'), '');
});

test('a calendar year is twelve month columns with honest ends', () => {
  const spans = monthSpans(2026);
  assert.equal(spans.length, 12);
  assert.deepEqual(spans[0], {
    key: '2026-01', month: 1, from: '2026-01-01', to: '2026-01-31', label: 'Jan',
  });
  assert.equal(spans[1].to, '2026-02-28');
  assert.equal(spans[11].to, '2026-12-31');
  assert.equal(monthSpans(2028)[1].to, '2028-02-29');
});

test('the year filter reaches back to the oldest expense, and always to last year', () => {
  assert.deepEqual(yearOptions(2026, null), [2026, 2025]);
  assert.deepEqual(yearOptions(2026, 2023), [2026, 2025, 2024, 2023]);
  // An "earliest" in the future cannot shorten the list below two.
  assert.deepEqual(yearOptions(2026, 2027), [2026, 2025]);
});

// Subscriptions
// ---------------------------------------------------------------------------

const SUB = { active: true, day_of_month: 15, last_recorded_on: null };

test('a paused subscription is never due', () => {
  assert.deepEqual(recurringStatus({ ...SUB, active: false }, '2026-08-27'),
    { due: false, dueOn: null, behind: 0, recordedThisMonth: false });
});

test('a fresh template waits for its billing day, then is due for this month', () => {
  assert.deepEqual(recurringStatus(SUB, '2026-08-10'),
    { due: false, dueOn: '2026-08-15', behind: 0, recordedThisMonth: false });
  assert.deepEqual(recurringStatus(SUB, '2026-08-27'),
    { due: true, dueOn: '2026-08-15', behind: 1, recordedThisMonth: false });
});

test('recorded for this month means done until next month', () => {
  const done = { ...SUB, last_recorded_on: '2026-08-15' };
  assert.deepEqual(recurringStatus(done, '2026-08-27'),
    { due: false, dueOn: null, behind: 0, recordedThisMonth: true });
  assert.deepEqual(recurringStatus(done, '2026-09-20'),
    { due: true, dueOn: '2026-09-15', behind: 1, recordedThisMonth: false });
});

test('a lapse is counted, and the next due month is the oldest missed one', () => {
  const lapsed = { ...SUB, last_recorded_on: '2026-05-15' };
  assert.deepEqual(recurringStatus(lapsed, '2026-08-27'),
    { due: true, dueOn: '2026-06-15', behind: 3, recordedThisMonth: false });
});

test('December rolls into January without inventing a thirteenth month', () => {
  const yearEnd = { ...SUB, last_recorded_on: '2025-12-15' };
  assert.equal(recurringStatus(yearEnd, '2026-01-20').dueOn, '2026-01-15');
});

test('"the 31st" bills a short month on its last day', () => {
  const eom = { active: true, day_of_month: 31, last_recorded_on: null };
  assert.deepEqual(recurringStatus(eom, '2026-04-30'),
    { due: true, dueOn: '2026-04-30', behind: 1, recordedThisMonth: false });
  // February, in a leap year, honestly.
  assert.equal(recurringStatus(eom, '2028-02-29').dueOn, '2028-02-29');
});

test('a paused template still says whether this month was recorded', () => {
  const paused = { active: false, day_of_month: 1, last_recorded_on: '2026-08-01' };
  assert.equal(recurringStatus(paused, '2026-08-20').recordedThisMonth, true);
});

test('the recorded expense is dated the billing day of the month asked for, clamped', () => {
  assert.equal(recurringSpentOn({ day_of_month: 31 }, '2026-02-10'), '2026-02-28');
  assert.equal(recurringSpentOn({ day_of_month: 5 }, '2026-06-01'), '2026-06-05');
});

// What the form can work out for itself
// ---------------------------------------------------------------------------

const VENDORS = [
  { id: 'v1', name: 'Adobe' },
  { id: 'v2', name: ' Figma ' },
];

test('a typed name finds its vendor whatever the case or spacing', () => {
  assert.equal(matchVendor(VENDORS, 'adobe').id, 'v1');
  assert.equal(matchVendor(VENDORS, '  ADOBE ').id, 'v1');
  assert.equal(matchVendor(VENDORS, 'figma').id, 'v2');
});

test('a name nobody has used is null, and so is nothing at all', () => {
  assert.equal(matchVendor(VENDORS, 'Netlify'), null);
  assert.equal(matchVendor(VENDORS, ''), null);
  assert.equal(matchVendor(VENDORS, null), null);
  assert.equal(matchVendor(null, 'Adobe'), null);
});

test('recent values are distinct, in the order given, in their last casing', () => {
  const rows = [
    { place: 'Rise Bakery' },
    { place: 'rise bakery' },
    { place: '' },
    { place: 'Austin' },
    { place: null },
  ];
  assert.deepEqual(recentValues(rows, 'place'), ['Rise Bakery', 'Austin']);
  assert.deepEqual(recentValues(rows, 'place', { limit: 1 }), ['Rise Bakery']);
  assert.deepEqual(recentValues(null, 'place'), []);
});

test('vendorNameOf prefers the saved vendor over the typed one', () => {
  assert.equal(vendorNameOf({ vendor: { name: 'Adobe' }, vendor_name: 'adobe inc' }), 'Adobe');
  assert.equal(vendorNameOf({ vendor: null, vendor_name: 'Somebody' }), 'Somebody');
  assert.equal(vendorNameOf({}), '');
  assert.equal(vendorNameOf(null), '');
});

test('receiptsOf reads either embed name', () => {
  assert.equal(receiptsOf({ receipts: [1, 2] }).length, 2);
  assert.equal(receiptsOf({ expense_receipts: [1] }).length, 1);
  assert.deepEqual(receiptsOf({}), []);
});

// The list filter
// ---------------------------------------------------------------------------

const EXPENSES = [
  { id: 'e1', spent_on: '2026-08-14', vendor_id: 'v1', vendor: { name: 'Adobe' },
    category_id: 'c1', category: { name: 'Software', code: 'software' },
    client_id: null, description: 'Creative Cloud', amount_cents: 5999 },
  { id: 'e2', spent_on: '2026-07-02', vendor_id: null, vendor_name: 'Rise Bakery',
    category_id: 'c2', category: { name: 'Business meals', code: 'meals' },
    client_id: 'k1', client: { name: 'Switch Commerce' }, description: 'Lunch',
    place: 'Denton', attendees: 'Dana Reid', amount_cents: 4200 },
  { id: 'e3', spent_on: '2025-12-30', vendor_id: 'v1', vendor: { name: 'Adobe' },
    category_id: 'c1', category: { name: 'Software', code: 'software' },
    client_id: null, description: 'Stock photo', amount_cents: 1200 },
];

const ids = (rows) => rows.map((row) => row.id);

test('no filters is everything', () => {
  assert.deepEqual(ids(filterExpenses(EXPENSES, {})), ['e1', 'e2', 'e3']);
  assert.deepEqual(ids(filterExpenses(EXPENSES)), ['e1', 'e2', 'e3']);
});

test('year and month narrow by spent_on, however the month is spelt', () => {
  assert.deepEqual(ids(filterExpenses(EXPENSES, { year: 2026 })), ['e1', 'e2']);
  assert.deepEqual(ids(filterExpenses(EXPENSES, { year: '2025' })), ['e3']);
  assert.deepEqual(ids(filterExpenses(EXPENSES, { month: 7 })), ['e2']);
  assert.deepEqual(ids(filterExpenses(EXPENSES, { month: '08' })), ['e1']);
  assert.deepEqual(ids(filterExpenses(EXPENSES, { month: '2025-12' })), ['e3']);
  assert.deepEqual(ids(filterExpenses(EXPENSES, { year: 2026, month: 12 })), []);
});

test('category, client and vendor filters are exact matches on the ids', () => {
  assert.deepEqual(ids(filterExpenses(EXPENSES, { categoryId: 'c2' })), ['e2']);
  assert.deepEqual(ids(filterExpenses(EXPENSES, { clientId: 'k1' })), ['e2']);
  assert.deepEqual(ids(filterExpenses(EXPENSES, { vendorId: 'v1' })), ['e1', 'e3']);
});

test('search reads who, what, where, why and who with', () => {
  assert.deepEqual(ids(filterExpenses(EXPENSES, { search: 'adobe' })), ['e1', 'e3']);
  assert.deepEqual(ids(filterExpenses(EXPENSES, { search: 'rise' })), ['e2']);
  assert.deepEqual(ids(filterExpenses(EXPENSES, { search: 'DENTON' })), ['e2']);
  assert.deepEqual(ids(filterExpenses(EXPENSES, { search: 'dana' })), ['e2']);
  assert.deepEqual(ids(filterExpenses(EXPENSES, { search: 'switch' })), ['e2']);
  assert.deepEqual(ids(filterExpenses(EXPENSES, { search: 'meals' })), ['e2']);
  assert.deepEqual(ids(filterExpenses(EXPENSES, { search: '  ' })), ['e1', 'e2', 'e3']);
  assert.deepEqual(ids(filterExpenses(EXPENSES, { search: 'zzz' })), []);
});

test('the filters combine', () => {
  assert.deepEqual(ids(filterExpenses(EXPENSES, { year: 2026, search: 'adobe' })), ['e1']);
  assert.deepEqual(ids(filterExpenses(EXPENSES, { vendorId: 'v1', month: 12 })), ['e3']);
});

// The rows the forms write
// ---------------------------------------------------------------------------

const FORM = {
  spent_on: '2026-08-14',
  amount: '$1,299.50',
  vendor: 'Adobe',
  category_id: 'c1',
  description: ' Creative Cloud ',
  method: 'card',
  reference: '',
  client_id: 'k1',
  billable: true,
  place: '',
  business_purpose: '',
  attendees: '',
};

test('the expense form becomes an expenses row in cents, with blanks as null', () => {
  const patch = expensePatch(FORM, { vendor_id: 'v1', vendor_name: null });
  assert.equal(patch.amount_cents, 129950);
  assert.equal(patch.vendor_id, 'v1');
  assert.equal(patch.vendor_name, null);
  assert.equal(patch.description, 'Creative Cloud');
  assert.equal(patch.reference, null);
  assert.equal(patch.place, null);
  assert.equal(patch.client_id, 'k1');
  assert.equal(patch.billable, true);
  assert.equal(patch.method, 'card');
});

test('a one-off vendor name goes to the free-text column, and only when there is no id', () => {
  const typed = expensePatch(FORM, { vendor_id: null, vendor_name: 'Somebody' });
  assert.equal(typed.vendor_id, null);
  assert.equal(typed.vendor_name, 'Somebody');
  const none = expensePatch(FORM, {});
  assert.equal(none.vendor_id, null);
  assert.equal(none.vendor_name, null);
});

test('billable means nothing without a client', () => {
  const patch = expensePatch({ ...FORM, client_id: '' }, {});
  assert.equal(patch.client_id, null);
  assert.equal(patch.billable, false);
});

test('a refund is a negative amount', () => {
  assert.equal(expensePatch({ ...FORM, amount: '-45' }, {}).amount_cents, -4500);
});

test('the form refuses what the database would refuse, in a sentence', () => {
  assert.throws(() => expensePatch({ ...FORM, category_id: '' }, {}), /category/i);
  assert.throws(() => expensePatch({ ...FORM, spent_on: '' }, {}), /date/i);
  assert.throws(() => expensePatch({ ...FORM, amount: 'twelve' }, {}), /not a number/i);
  assert.throws(() => expensePatch({ ...FORM, amount: '0' }, {}), /nothing/i);
});

test('the subscription form becomes a recurring_expenses row', () => {
  const patch = recurringPatch({
    name: ' Netlify Pro ', amount: '19', vendor: 'Netlify', category_id: 'c3',
    method: 'card', day_of_month: '31', client_id: '', billable: true, active: false,
  }, { vendor_id: 'v9' });
  assert.equal(patch.name, 'Netlify Pro');
  assert.equal(patch.amount_cents, 1900);
  assert.equal(patch.day_of_month, 31);
  assert.equal(patch.vendor_id, 'v9');
  assert.equal(patch.billable, false);
  assert.equal(patch.active, false);
});

test('a new subscription leaves active alone for the caller to set', () => {
  const patch = recurringPatch({
    name: 'X', amount: '1', category_id: 'c', day_of_month: '1',
  });
  assert.equal('active' in patch, false);
});

test('the subscription form checks the billing day', () => {
  const base = { name: 'X', amount: '1', category_id: 'c' };
  assert.throws(() => recurringPatch({ ...base, day_of_month: '0' }), /1 to 31/);
  assert.throws(() => recurringPatch({ ...base, day_of_month: '32' }), /1 to 31/);
  assert.throws(() => recurringPatch({ ...base, day_of_month: '2.5' }), /1 to 31/);
  assert.throws(() => recurringPatch({ ...base, name: ' ', day_of_month: '1' }), /name/i);
});

// Receipts
// ---------------------------------------------------------------------------

test('the upload type is on the bucket\'s list, by declared type or by extension', () => {
  assert.equal(receiptMime({ name: 'lunch.jpg', type: 'image/jpeg' }), 'image/jpeg');
  assert.equal(receiptMime({ name: 'IMG_0042.HEIC', type: '' }), 'image/heic');
  assert.equal(receiptMime({ name: 'invoice.pdf', type: '' }), 'application/pdf');
  assert.equal(receiptMime({ name: 'scan.PNG', type: 'application/octet-stream' }), 'image/png');
  assert.equal(receiptMime({ name: 'photo.jpeg', type: 'image/jpg' }), 'image/jpeg');
});

test('a file the bucket will not take is null, never octet-stream', () => {
  assert.equal(receiptMime({ name: 'notes.txt', type: 'text/plain' }), null);
  assert.equal(receiptMime({ name: 'archive', type: '' }), null);
  assert.equal(receiptMime({ name: 'x.exe', type: 'application/octet-stream' }), null);
  assert.equal(receiptMime(null), null);
  assert.ok(!RECEIPT_TYPES.includes('application/octet-stream'));
});
