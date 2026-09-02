// ---------------------------------------------------------------------------
// The bookkeeping arithmetic.
//
//   node --test tools/portal/*.test.mjs
//
// Covers js/portal/ledger-catalog.js. The database guarantees that the books
// balance — an entry that does not is refused, and tools/portal/schema-check.sh
// proves it against a real Postgres. What this file covers is the layer above
// that: the reports. A ledger can be perfectly consistent and still be reported
// wrongly, and every one of those failures is silent. A balance sheet that does
// not balance, a gross margin computed off the wrong subtotal, an invoice sat
// in the wrong ageing bucket, a 1099 threshold missed by a dollar — none of
// them look like anything on screen, and all of them reach an accountant.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AGING_BUCKETS,
  accountLabel,
  agingReport,
  balanceSheet,
  blockers,
  byClient,
  dayBefore,
  entryTotals,
  fiscalYearStart,
  filterEntries,
  formatSigned,
  isSubstantiated,
  mileageAmount,
  memberName,
  mileageRateLabel,
  monthSpans,
  monthlyProfitAndLoss,
  ownerCapital,
  normalSide,
  profitAndLoss,
  reconcileTotals,
  recurringStatus,
  substantiationGaps,
  subtypesFor,
  trialBalance,
  validateEntry,
  vendorTotals,
} from '../../js/portal/ledger-catalog.js';
import { packFiles } from '../../js/portal/ledger-export.js';

// A balance row as ledger_balances() returns it: already signed the way the
// account is normally read.
function acct(code, name, type, subtype, balance, extra = {}) {
  const debits = type === 'asset' || type === 'expense'
    ? Math.max(balance, 0) : Math.max(-balance, 0);
  const credits = type === 'asset' || type === 'expense'
    ? Math.max(-balance, 0) : Math.max(balance, 0);
  return {
    account_id: `id-${code}`,
    code,
    name,
    type,
    subtype,
    balance,
    debits,
    credits,
    archived: false,
    ...extra,
  };
}

// Money
// ---------------------------------------------------------------------------

test('a negative on a report is written in parentheses, the way books are', () => {
  assert.equal(formatSigned(125000), '$1,250.00');
  assert.equal(formatSigned(-125000), '($1,250.00)');
  assert.equal(formatSigned(0), '$0.00');
});

test('an account is named by its code first, which is what sorts', () => {
  assert.equal(accountLabel({ code: '1000', name: 'Business checking' }),
    '1000 · Business checking');
  assert.equal(accountLabel(null), '—');
});

// The type system
// ---------------------------------------------------------------------------

test('debits increase what you own and what you spend; credits increase the rest', () => {
  assert.equal(normalSide('asset'), 'debit');
  assert.equal(normalSide('expense'), 'debit');
  assert.equal(normalSide('liability'), 'credit');
  assert.equal(normalSide('equity'), 'credit');
  assert.equal(normalSide('income'), 'credit');
});

test('every subtype belongs to exactly one type', () => {
  const types = ['asset', 'liability', 'equity', 'income', 'expense'];
  const seen = types.flatMap((type) => subtypesFor(type).map((row) => row.value));
  assert.equal(seen.length, new Set(seen).size);
  assert.ok(subtypesFor('asset').every((row) => row.type === 'asset'));
});

// Fiscal years
// ---------------------------------------------------------------------------

test('a January fiscal year starts on the first of January', () => {
  assert.equal(fiscalYearStart('2026-08-08', 1), '2026-01-01');
  assert.equal(fiscalYearStart('2026-01-01', 1), '2026-01-01');
});

test('a fiscal year that starts mid-year reaches back into last year', () => {
  // July start: August 2026 is in FY2026; June 2026 is still in FY2025.
  assert.equal(fiscalYearStart('2026-08-08', 7), '2026-07-01');
  assert.equal(fiscalYearStart('2026-06-30', 7), '2025-07-01');
});

test('the day before a year start crosses the boundary properly', () => {
  assert.equal(dayBefore('2026-01-01'), '2025-12-31');
  assert.equal(dayBefore('2026-03-01'), '2026-02-28');
});

// Trial balance
// ---------------------------------------------------------------------------

test('the trial balance sums both columns and says whether they match', () => {
  const report = trialBalance([
    acct('1000', 'Checking', 'asset', 'bank', 500000),
    acct('4000', 'Design services', 'income', 'income', 500000),
  ]);

  assert.equal(report.debits, 500000);
  assert.equal(report.credits, 500000);
  assert.equal(report.difference, 0);
  assert.equal(report.balanced, true);
});

test('an account nobody has used is left off the report', () => {
  const report = trialBalance([
    acct('1000', 'Checking', 'asset', 'bank', 500000),
    acct('4000', 'Design services', 'income', 'income', 500000),
    acct('6070', 'Meals', 'expense', 'expense', 0),
  ]);

  assert.equal(report.rows.length, 2);
  assert.ok(!report.rows.some((row) => row.code === '6070'));
});

// Profit and loss
// ---------------------------------------------------------------------------

const TRADING = [
  acct('4010', 'Web design', 'income', 'income', 1000000),
  acct('4020', 'Branding', 'income', 'income', 400000),
  acct('5000', 'Subcontractors', 'expense', 'cost_of_sales', 300000),
  acct('6000', 'Software', 'expense', 'expense', 100000),
  acct('6020', 'Professional fees', 'expense', 'expense', 50000),
  acct('7000', 'Interest income', 'income', 'other_income', 2000),
  acct('7500', 'Interest expense', 'expense', 'other_expense', 5000),
];

test('gross profit is revenue less the cost of the work itself', () => {
  const pl = profitAndLoss(TRADING);
  assert.equal(pl.revenueTotal, 1400000);
  assert.equal(pl.costTotal, 300000);
  assert.equal(pl.grossProfit, 1100000);
});

test('operating profit takes off the cost of being open, and nothing else', () => {
  const pl = profitAndLoss(TRADING);
  assert.equal(pl.operatingTotal, 150000);
  assert.equal(pl.operatingProfit, 950000);
});

test('net profit picks up what sits below the line', () => {
  const pl = profitAndLoss(TRADING);
  assert.equal(pl.netProfit, 950000 + 2000 - 5000);
});

test('the gross margin is a fraction of revenue, not of profit', () => {
  const pl = profitAndLoss(TRADING);
  assert.equal(pl.grossMargin, 1100000 / 1400000);
});

test('a period with no revenue has no margin rather than a division by zero', () => {
  const pl = profitAndLoss([acct('6000', 'Software', 'expense', 'expense', 100000)]);
  assert.equal(pl.grossMargin, null);
  assert.equal(pl.netProfit, -100000);
});

test('interest income does not flatter the gross margin', () => {
  // The bug this guards: folding other income into revenue would make a studio
  // that earned nothing look like it had a margin.
  const pl = profitAndLoss(TRADING);
  assert.ok(!pl.revenue.some((row) => row.code === '7000'));
  assert.equal(pl.otherIncomeTotal, 2000);
});

test('on a cash basis the revenue lines are replaced, and the costs are not', () => {
  const cash = [{ account_id: 'id-4010', code: '4010', name: 'Web design', amount: 600000 }];
  const pl = profitAndLoss(TRADING, cash);

  assert.equal(pl.revenueTotal, 600000);
  assert.equal(pl.revenue.length, 1);
  // Costs are recorded when paid, so both bases read them the same.
  assert.equal(pl.costTotal, 300000);
  assert.equal(pl.operatingTotal, 150000);
  assert.equal(pl.grossProfit, 300000);
});

// Balance sheet
// ---------------------------------------------------------------------------

test('the balance sheet balances, and works out equity nobody posted', () => {
  // Since the books opened, TRADING is $14,020 of income (including the $20 of
  // interest, which is easy to forget and is exactly why this test exists) less
  // $4,550 of costs — a profit of $9,470. With $5,000 of contributions, cash
  // holds 5,000 + 9,470 = 14,470.
  const toDate = [
    acct('1000', 'Checking', 'asset', 'bank', 1447000),
    acct('3100', 'Contributions', 'equity', 'equity', 500000),
    ...TRADING,
  ];
  // This financial year: half the trading.
  const thisYear = [
    acct('4010', 'Web design', 'income', 'income', 500000),
    acct('5000', 'Subcontractors', 'expense', 'cost_of_sales', 150000),
  ];

  const bs = balanceSheet(toDate, thisYear);

  assert.equal(bs.assetsTotal, 1447000);
  assert.equal(bs.liabilitiesTotal, 0);
  assert.equal(bs.netProfit, 350000);
  // Everything earned before this year: 947,000 total profit less 350,000.
  assert.equal(bs.retained, 947000 - 350000);
  assert.equal(bs.equityTotal, 500000 + 947000);
  assert.equal(bs.balanced, true);
  assert.equal(bs.difference, 0);
});

test('a card balance lands in liabilities, not as negative cash', () => {
  const bs = balanceSheet([
    acct('1000', 'Checking', 'asset', 'bank', 200000),
    acct('2100', 'Credit card', 'liability', 'credit_card', 50000),
    acct('3100', 'Contributions', 'equity', 'equity', 150000),
  ], []);

  assert.equal(bs.assetsTotal, 200000);
  assert.equal(bs.liabilitiesTotal, 50000);
  assert.equal(bs.equityTotal, 150000);
  assert.equal(bs.balanced, true);
});

test('a balance sheet that does not balance says so and by how much', () => {
  const bs = balanceSheet([
    acct('1000', 'Checking', 'asset', 'bank', 200000),
    acct('3100', 'Contributions', 'equity', 'equity', 150000),
  ], []);

  assert.equal(bs.balanced, false);
  assert.equal(bs.difference, 50000);
});

test('income and expense accounts never print as assets', () => {
  const bs = balanceSheet(TRADING, []);
  const printed = [...bs.currentAssets, ...bs.fixedAssets,
    ...bs.currentLiabilities, ...bs.longTermLiabilities, ...bs.equity];
  assert.ok(!printed.some((row) => ['income', 'expense'].includes(row.type)));
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
    clients: { name: client },
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
    invoice(2, 'sent', '2026-08-01', 500000, 0, 'Nall'),
    invoice(3, 'sent', '2026-08-01', 100000, 0, 'Acme'),
  ], '2026-08-08');

  assert.equal(report.clients.length, 2);
  assert.equal(report.clients[0].name, 'Nall');
  assert.equal(report.clients[0].total, 500000);
  assert.equal(report.clients[1].total, 200000);
});

test('every bucket key the report fills is one the screen knows how to print', () => {
  const report = agingReport([invoice(1, 'sent', '2026-01-01', 1000)], '2026-08-08');
  const keys = AGING_BUCKETS.map((row) => row.key);
  Object.keys(report.totals).forEach((key) => assert.ok(keys.includes(key)));
});

// What a client was worth
// ---------------------------------------------------------------------------

test('a client\'s profit is what they paid less what they cost', () => {
  const rows = byClient([
    { client_id: 'c1', credit_cents: 500000, debit_cents: 0,
      ledger_accounts: { type: 'income' }, clients: { name: 'Acme' } },
    { client_id: 'c1', credit_cents: 0, debit_cents: 120000,
      ledger_accounts: { type: 'expense' }, clients: { name: 'Acme' } },
  ]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].revenue, 500000);
  assert.equal(rows[0].cost, 120000);
  assert.equal(rows[0].profit, 380000);
  assert.equal(rows[0].margin, 380000 / 500000);
});

test('overheads with no client on them are gathered rather than dropped', () => {
  const rows = byClient([
    { client_id: null, credit_cents: 0, debit_cents: 90000,
      ledger_accounts: { type: 'expense' }, clients: null },
  ]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].clientId, null);
  assert.equal(rows[0].cost, 90000);
});

test('balance-sheet movements are not mistaken for revenue', () => {
  const rows = byClient([
    { client_id: 'c1', credit_cents: 500000, debit_cents: 0,
      ledger_accounts: { type: 'asset' }, clients: { name: 'Acme' } },
  ]);
  assert.equal(rows.length, 0);
});

// 1099s
// ---------------------------------------------------------------------------

const CONTRACTOR = { id: 'v1', name: 'A Developer', files_1099: true, tax_id_on_file: true };
const NO_W9 = { id: 'v2', name: 'A Writer', files_1099: true, tax_id_on_file: false };
const SUPPLIER = { id: 'v3', name: 'Adobe', files_1099: false, tax_id_on_file: false };

test('a contractor over the threshold is reportable', () => {
  const rows = vendorTotals(
    [{ vendor_id: 'v1', spent_on: '2026-04-01', amount_cents: 120000 }],
    [CONTRACTOR], 2026);

  assert.equal(rows[0].paid, 120000);
  assert.equal(rows[0].reportable, true);
  assert.equal(rows[0].missingTaxId, false);
});

test('the threshold is a floor, not a ceiling — exactly $600 counts', () => {
  const at = (cents) => vendorTotals(
    [{ vendor_id: 'v1', spent_on: '2026-04-01', amount_cents: cents }],
    [CONTRACTOR], 2026)[0].reportable;

  assert.equal(at(59999), false);
  assert.equal(at(60000), true);
});

test('a reportable contractor with no W-9 on file is flagged', () => {
  const rows = vendorTotals(
    [{ vendor_id: 'v2', spent_on: '2026-04-01', amount_cents: 200000 }],
    [NO_W9], 2026);

  assert.equal(rows[0].reportable, true);
  assert.equal(rows[0].missingTaxId, true);
});

test('a supplier who does not need a 1099 is never reportable, however much they were paid', () => {
  const rows = vendorTotals(
    [{ vendor_id: 'v3', spent_on: '2026-04-01', amount_cents: 900000 }],
    [SUPPLIER], 2026);

  assert.equal(rows[0].paid, 900000);
  assert.equal(rows[0].reportable, false);
});

test('spend is counted per calendar year, because that is what the form asks', () => {
  const expenses = [
    { vendor_id: 'v1', spent_on: '2025-12-31', amount_cents: 500000 },
    { vendor_id: 'v1', spent_on: '2026-01-01', amount_cents: 70000 },
  ];

  assert.equal(vendorTotals(expenses, [CONTRACTOR], 2026)[0].paid, 70000);
  assert.equal(vendorTotals(expenses, [CONTRACTOR], 2025)[0].paid, 500000);
});

test('several payments to one vendor add up across the year', () => {
  const rows = vendorTotals([
    { vendor_id: 'v1', spent_on: '2026-02-01', amount_cents: 30000 },
    { vendor_id: 'v1', spent_on: '2026-05-01', amount_cents: 35000 },
  ], [CONTRACTOR], 2026);

  assert.equal(rows[0].paid, 65000);
  assert.equal(rows[0].reportable, true);
});

// Writing an entry by hand
// ---------------------------------------------------------------------------

const LINE = (accountId, debit = 0, credit = 0) => ({
  account_id: accountId, debit_cents: debit, credit_cents: credit,
});

test('a balanced two-line entry is accepted', () => {
  const problems = validateEntry({
    entry: { entry_date: '2026-08-08', memo: 'Owner draw' },
    lines: [LINE('a', 100000), LINE('b', 0, 100000)],
  });
  assert.equal(blockers(problems).length, 0);
});

test('an entry that does not balance says which way and by how much', () => {
  const problems = validateEntry({
    entry: { entry_date: '2026-08-08', memo: 'Wrong' },
    lines: [LINE('a', 100000), LINE('b', 0, 90000)],
  });

  const problem = blockers(problems).find((row) => row.field === 'lines');
  assert.ok(problem);
  assert.match(problem.message, /\$100\.00/);
  assert.match(problem.message, /\$1,000\.00/);
  assert.match(problem.message, /\$900\.00/);
});

test('one line is half an entry', () => {
  const problems = validateEntry({
    entry: { entry_date: '2026-08-08', memo: 'Half' },
    lines: [LINE('a', 100000)],
  });
  assert.ok(blockers(problems).some((row) => /at least two lines/.test(row.message)));
});

test('an amount with no account behind it is blocked', () => {
  const problems = validateEntry({
    entry: { entry_date: '2026-08-08', memo: 'Oops' },
    lines: [LINE('a', 100000), LINE('b', 0, 100000), LINE(null, 5000)],
  });
  assert.ok(blockers(problems).some((row) => /needs an account/.test(row.message)));
});

test('a line cannot be a debit and a credit at once', () => {
  const problems = validateEntry({
    entry: { entry_date: '2026-08-08', memo: 'Both' },
    lines: [LINE('a', 100000, 100000), LINE('b', 0, 100000)],
  });
  assert.ok(blockers(problems).some((row) => /never both/.test(row.message)));
});

test('a missing date stops the save; a missing memo only warns', () => {
  const problems = validateEntry({
    entry: { entry_date: '', memo: '' },
    lines: [LINE('a', 100000), LINE('b', 0, 100000)],
  });

  assert.ok(blockers(problems).some((row) => row.field === 'entry_date'));
  assert.ok(problems.some((row) => row.field === 'memo' && !row.blocking));
});

test('the running total closes as the second side is typed', () => {
  assert.deepEqual(entryTotals([LINE('a', 100000)]), {
    debits: 100000, credits: 0, difference: 100000, balanced: false,
  });
  assert.deepEqual(entryTotals([LINE('a', 100000), LINE('b', 0, 100000)]), {
    debits: 100000, credits: 100000, difference: 0, balanced: true,
  });
});

// Reconciling
// ---------------------------------------------------------------------------

test('a reconciliation balances when the ticked lines reach the statement', () => {
  const lines = [
    { debit_cents: 500000, credit_cents: 0, cleared_on: '2026-03-31' },
    { debit_cents: 0, credit_cents: 120000, cleared_on: '2026-03-31' },
    { debit_cents: 0, credit_cents: 90000, cleared_on: null },
  ];

  const totals = reconcileTotals(lines, { openingCents: 0, closingCents: 380000 });
  assert.equal(totals.ticked, 2);
  assert.equal(totals.cleared, 380000);
  assert.equal(totals.difference, 0);
  assert.equal(totals.balanced, true);
});

test('an un-ticked line is what leaves a difference to hunt down', () => {
  const lines = [
    { debit_cents: 500000, credit_cents: 0, cleared_on: '2026-03-31' },
    { debit_cents: 0, credit_cents: 120000, cleared_on: null },
  ];

  const totals = reconcileTotals(lines, { openingCents: 0, closingCents: 380000 });
  assert.equal(totals.difference, -120000);
  assert.equal(totals.balanced, false);
});

test('the opening balance carries into the cleared figure', () => {
  const totals = reconcileTotals(
    [{ debit_cents: 100000, credit_cents: 0, cleared_on: '2026-03-31' }],
    { openingCents: 250000, closingCents: 350000 },
  );
  assert.equal(totals.cleared, 350000);
  assert.equal(totals.balanced, true);
});

// The journal filter
// ---------------------------------------------------------------------------

const ENTRIES = [
  {
    id: 'e1', memo: 'Payment received — INV 0001', source: 'payment', reference: 'INV 0001',
    ledger_lines: [{ account_id: 'a-bank', ledger_accounts: { code: '1000', name: 'Checking' } }],
  },
  {
    id: 'e2', memo: 'Adobe — monthly', source: 'expense', reference: null,
    ledger_lines: [{ account_id: 'a-soft', ledger_accounts: { code: '6000', name: 'Software' } }],
  },
];

test('the journal searches memo, reference and the accounts on the lines', () => {
  assert.equal(filterEntries(ENTRIES, { search: 'adobe' })[0].id, 'e2');
  assert.equal(filterEntries(ENTRIES, { search: 'INV 0001' })[0].id, 'e1');
  assert.equal(filterEntries(ENTRIES, { search: 'checking' })[0].id, 'e1');
  assert.equal(filterEntries(ENTRIES, { search: '6000' })[0].id, 'e2');
});

test('it can be narrowed to one account, or to where entries came from', () => {
  assert.equal(filterEntries(ENTRIES, { accountId: 'a-soft' }).length, 1);
  assert.equal(filterEntries(ENTRIES, { source: 'payment' })[0].id, 'e1');
  assert.equal(filterEntries(ENTRIES, { source: 'manual' }).length, 0);
});

test('an empty filter is not a filter', () => {
  assert.equal(filterEntries(ENTRIES, {}).length, 2);
});

// The year-end pack
// ---------------------------------------------------------------------------
//
// The CSVs are what a preparer actually imports, so what matters is that the
// figures in them agree with the statements printed beside them, that the
// general ledger is complete, and that nothing arrives as an empty file with a
// confident name on it.

const PACK_ACCOUNTS = {
  ar: { account_id: 'a-ar', code: '1200', name: 'Accounts receivable',
        type: 'asset', subtype: 'receivable', system_key: 'accounts_receivable' },
  bank: { account_id: 'a-bank', code: '1000', name: 'Checking',
          type: 'asset', subtype: 'bank', system_key: null },
  kit: { account_id: 'a-kit', code: '1500', name: 'Equipment',
         type: 'asset', subtype: 'fixed_asset', system_key: null },
  card: { account_id: 'a-card', code: '2100', name: 'Credit card',
          type: 'liability', subtype: 'credit_card', system_key: null },
  draw: { account_id: 'a-draw', code: '3200', name: "Owner's draws",
          type: 'equity', subtype: 'equity', system_key: null },
  web: { account_id: 'a-web', code: '4010', name: 'Web design',
         type: 'income', subtype: 'income', system_key: 'income_website' },
  meals: { account_id: 'a-meals', code: '6070', name: 'Meals',
           type: 'expense', subtype: 'expense', system_key: null },
};

function balance(account, debits, credits) {
  const sign = ['asset', 'expense'].includes(account.type) ? 1 : -1;
  return { ...account, archived: false, debits, credits, balance: sign * (debits - credits) };
}

/** Read a cell by its column heading rather than by position. Adding a column
 *  to an export should not quietly move what a test is asserting about. */
function cell(file, row, heading) {
  const index = file.headers.indexOf(heading);
  assert.ok(index >= 0, `no "${heading}" column in ${file.filename}`);
  return row[index];
}

function samplePack() {
  // These have to add up, or the test that says the pack balances is testing
  // the fixture rather than the code. Invoiced 10,000 and collected 8,000, so
  // A/R holds 2,000; a 2,500 laptop and a 3,000 draw leave the bank at 2,500;
  // 400 of meals sits on the card.
  const period = [
    balance(PACK_ACCOUNTS.web, 0, 1000000),
    balance(PACK_ACCOUNTS.meals, 40000, 0),
    balance(PACK_ACCOUNTS.kit, 250000, 0),
    balance(PACK_ACCOUNTS.draw, 300000, 0),
    balance(PACK_ACCOUNTS.ar, 200000, 0),
    balance(PACK_ACCOUNTS.bank, 250000, 0),
    balance(PACK_ACCOUNTS.card, 0, 40000),
  ];

  const line = (account, debit, credit, description) => ({
    id: `l-${account.code}-${debit}-${credit}`,
    account_id: account.account_id,
    debit_cents: debit,
    credit_cents: credit,
    description,
    position: 0,
    ledger_accounts: { code: account.code, name: account.name },
    clients: null,
  });

  return {
    from: '2026-01-01',
    to: '2026-12-31',
    period,
    toDate: period,
    priorTo: [],
    cashIncome: [{ account_id: 'a-web', code: '4010', name: 'Web design', amount: 800000 }],
    entries: [
      { id: 'e1', entry_date: '2026-03-01', memo: 'INV 0001', reference: 'INV 0001',
        source: 'invoice',
        ledger_lines: [line(PACK_ACCOUNTS.ar, 1000000, 0, 'Website'),
          line(PACK_ACCOUNTS.web, 0, 1000000, 'Website')] },
      { id: 'e2', entry_date: '2026-06-01', memo: 'New laptop', reference: null,
        source: 'manual',
        ledger_lines: [line(PACK_ACCOUNTS.kit, 250000, 0, 'MacBook'),
          line(PACK_ACCOUNTS.bank, 0, 250000, 'MacBook')] },
      { id: 'e3', entry_date: '2026-07-01', memo: 'Owner draw', reference: null,
        source: 'manual',
        ledger_lines: [line(PACK_ACCOUNTS.draw, 300000, 0, 'July draw'),
          line(PACK_ACCOUNTS.bank, 0, 300000, 'July draw')] },
      { id: 'e4', entry_date: '2026-04-15', memo: 'Payment received — INV 0001',
        reference: 'INV 0001', source: 'payment',
        ledger_lines: [line(PACK_ACCOUNTS.bank, 800000, 0, 'INV 0001'),
          line(PACK_ACCOUNTS.ar, 0, 800000, 'INV 0001')] },
      { id: 'e5', entry_date: '2026-05-02', memo: 'A Restaurant — Client lunch',
        reference: null, source: 'expense',
        ledger_lines: [line(PACK_ACCOUNTS.meals, 40000, 0, 'Client lunch'),
          line(PACK_ACCOUNTS.card, 0, 40000, 'Client lunch')] },
    ],
    expenses: [{
      id: 'x1', spent_on: '2026-05-02', vendor_id: 'v1', vendor_name: null,
      amount_cents: 40000, description: 'Client lunch', method: 'card', reference: null,
      billable: false,
      expense_receipts: [{ id: 'r1', storage_path: 'x1/r.jpg', name: 'r.jpg' }],
      place: 'Rise Bakery, Dallas',
      business_purpose: 'Discussing the spring rebrand',
      attendees: 'Dana Reid (prospective client, Acme Co)',
      miles: null,
      vendors: { name: 'A Restaurant' }, clients: null,
      account: { code: '6070', name: 'Meals', needs_substantiation: true },
      paid_from: { code: '2100', name: 'Credit card' },
    }],
    vendors: [{ id: 'v1', name: 'A Restaurant', email: null, phone: null,
      files_1099: false, tax_id_on_file: false }],
    invoices: [{
      id: 'i1', client_id: 'c1', number: 1, status: 'sent',
      issued_on: '2026-12-01', due_on: '2026-12-15',
      total_cents: 200000, paid_cents: 0, clients: { name: 'Nall Holdings' },
    }],
  };
}

test('the pack produces every file a preparer expects, and none of them empty', () => {
  const files = packFiles(samplePack());
  const names = files.map((f) => f.filename);

  ['general-ledger', 'trial-balance', 'profit-and-loss', 'balance-sheet',
    'expenses', 'receivables', 'fixed-asset-additions', 'owner-equity', '1099']
    .forEach((part) => {
      assert.ok(names.some((n) => n.includes(part)), `missing the ${part} file`);
    });

  files.forEach((file) => {
    assert.ok(file.headers.length > 0, `${file.filename} has no headers`);
  });
});

test('the general ledger carries every line, in date order', () => {
  const gl = packFiles(samplePack()).find((f) => f.filename.includes('general-ledger'));
  assert.equal(gl.rows.length, 10);

  const dates = gl.rows.map((row) => row[0]);
  assert.deepEqual(dates, [...dates].sort());
});

test('the general ledger balances, which is the first thing a preparer checks', () => {
  const gl = packFiles(samplePack()).find((f) => f.filename.includes('general-ledger'));
  const debit = gl.rows.reduce((t, row) => t + Number(row[8]), 0);
  const credit = gl.rows.reduce((t, row) => t + Number(row[9]), 0);
  assert.equal(debit.toFixed(2), credit.toFixed(2));
});

test('the profit and loss file carries both bases, and they differ where they should', () => {
  const pl = packFiles(samplePack()).find((f) => f.filename.includes('profit-and-loss'));
  const net = (basis) => pl.rows.find((row) => row[0] === basis && row[3] === 'Net profit')[4];

  // Accrual: 10,000 invoiced less 400 of meals. Cash: only 8,000 collected.
  assert.equal(net('Accrual'), '9600.00');
  assert.equal(net('Cash'), '7600.00');
});

test('the fixed asset file picks up the laptop and nothing else', () => {
  const assets = packFiles(samplePack())
    .find((f) => f.filename.includes('fixed-asset-additions'));

  assert.equal(assets.rows.length, 1);
  assert.equal(assets.rows[0][2], 'Equipment');
  assert.equal(assets.rows[0][4], '2500.00');
});

test("the owner's draw is reported as equity, never as an expense", () => {
  const equity = packFiles(samplePack()).find((f) => f.filename.includes('owner-equity'));
  assert.equal(equity.rows.length, 1);
  assert.equal(equity.rows[0][4], '0.00');       // nothing in
  assert.equal(equity.rows[0][5], '3000.00');    // three thousand out

  const pl = packFiles(samplePack()).find((f) => f.filename.includes('profit-and-loss'));
  assert.ok(!pl.rows.some((row) => row[3] === "Owner's draws"));
});

test('meals are flagged as half deductible rather than silently reduced', () => {
  const expenses = packFiles(samplePack()).find((f) => f.filename.includes('expenses.csv'));
  const row = expenses.rows[0];

  assert.equal(cell(expenses, row, 'Amount'), '400.00');   // gross, untouched
  assert.equal(cell(expenses, row, 'Deductible note'), '50% deductible');
});

test('the expense export carries the who, what and where a preparer needs', () => {
  const expenses = packFiles(samplePack()).find((f) => f.filename.includes('expenses.csv'));
  const row = expenses.rows[0];

  assert.equal(cell(expenses, row, 'Where'), 'Rise Bakery, Dallas');
  assert.equal(cell(expenses, row, 'Business purpose'), 'Discussing the spring rebrand');
  assert.equal(cell(expenses, row, 'Who was there'), 'Dana Reid (prospective client, Acme Co)');
  assert.equal(cell(expenses, row, 'Receipts on file'), 1);
  assert.equal(cell(expenses, row, 'Substantiation'), 'complete');
});

test('an expense missing its story is named in the export rather than dropped', () => {
  const pack = samplePack();
  pack.expenses.push({
    id: 'x2', spent_on: '2026-08-01', vendor_id: null, vendor_name: 'A Diner',
    amount_cents: 3200, description: 'Lunch', method: 'card', reference: null,
    billable: false, expense_receipts: [],
    place: null, business_purpose: null, attendees: null, miles: null,
    vendors: null, clients: null,
    account: { code: '6070', name: 'Meals', needs_substantiation: true },
    paid_from: { code: '2100', name: 'Credit card' },
  });

  const expenses = packFiles(pack).find((f) => f.filename.includes('expenses.csv'));
  const row = expenses.rows[1];

  assert.match(cell(expenses, row, 'Substantiation'), /missing/);
  assert.match(cell(expenses, row, 'Substantiation'), /where it was/);
  assert.match(cell(expenses, row, 'Substantiation'), /business purpose/);
  assert.match(cell(expenses, row, 'Substantiation'), /who was there/);
  assert.equal(cell(expenses, row, 'Receipts on file'), 0);
});

test('the mileage log is its own file, because the rate needs one', () => {
  const pack = samplePack();
  pack.expenses.push({
    id: 'x3', spent_on: '2026-03-14', vendor_id: null, vendor_name: null,
    amount_cents: 3220, description: 'Site visit', method: 'other', reference: null,
    billable: false, expense_receipts: [],
    place: 'Fort Worth', business_purpose: 'Client kickoff', attendees: null, miles: 46,
    vendors: null, clients: null,
    account: { code: '6090', name: 'Vehicle & mileage', needs_substantiation: true },
    paid_from: { code: '1000', name: 'Checking' },
    creator: { full_name: 'Erin Ochenski', email: 'erin@newjourneydesigns.com' },
  });

  const log = packFiles(pack).find((f) => f.filename.includes('mileage-log'));
  assert.equal(log.rows.length, 1);
  assert.equal(cell(log, log.rows[0], 'Miles'), 46);
  assert.equal(cell(log, log.rows[0], 'To'), 'Fort Worth');
  assert.equal(cell(log, log.rows[0], 'Business purpose'), 'Client kickoff');
  assert.equal(cell(log, log.rows[0], 'Claimed'), '32.20');
});

test('the mileage log names its driver — four owners, four returns to file', () => {
  const pack = samplePack();
  pack.expenses.push({
    id: 'x4', spent_on: '2026-03-14', amount_cents: 3220, miles: 46,
    place: 'Fort Worth', business_purpose: 'Client kickoff', expense_receipts: [],
    account: { code: '6090', name: 'Vehicle & mileage', needs_substantiation: true },
    paid_from: { code: '3100', name: "Owner's contributions" },
    creator: { full_name: 'Erin Ochenski', email: 'erin@newjourneydesigns.com' },
  });
  // Typed in before drives existed, so nobody is on it.
  pack.expenses.push({
    id: 'x5', spent_on: '2026-04-02', amount_cents: 700, miles: 10,
    place: 'Denton', business_purpose: 'Press check', expense_receipts: [],
    account: { code: '6090', name: 'Vehicle & mileage', needs_substantiation: true },
    paid_from: { code: '3100', name: "Owner's contributions" },
  });

  const log = packFiles(pack).find((f) => f.filename.includes('mileage-log'));
  assert.equal(log.headers[0], 'Driver');
  assert.equal(cell(log, log.rows[0], 'Driver'), 'Erin Ochenski');
  // Never silently borrows the name above it.
  assert.equal(cell(log, log.rows[1], 'Driver'), 'Not recorded');
});

test('what was owed at year end is in the pack, which is what converts the bases', () => {
  const ar = packFiles(samplePack()).find((f) => f.filename.includes('receivables'));
  assert.equal(ar.rows.length, 1);
  assert.equal(ar.rows[0][0], 'Nall Holdings');
  assert.equal(ar.rows[0][5], '2000.00');
});

test('the trial balance in the pack agrees with itself', () => {
  const tb = packFiles(samplePack()).find((f) => f.filename.includes('trial-balance'));
  const debit = tb.rows.reduce((t, row) => t + Number(row[3]), 0);
  const credit = tb.rows.reduce((t, row) => t + Number(row[4]), 0);
  assert.equal(debit.toFixed(2), credit.toFixed(2));
});

test('every file is named with the year, so a folder of them stays sorted', () => {
  packFiles(samplePack()).forEach((file) => {
    assert.match(file.filename, /^njd-2026-.+\.csv$/);
  });
});

// Substantiation — the who, what and where
// ---------------------------------------------------------------------------
//
// The amount and the date are on every expense and a photograph proves them.
// These are the three that get forgotten and the three a deduction is
// disallowed for, so the rules about when each is demanded are worth pinning.

const MEALS = { code: '6070', name: 'Meals', needs_substantiation: true };
const TRAVEL = { code: '6080', name: 'Travel', needs_substantiation: true };
const VEHICLE = { code: '6090', name: 'Vehicle', needs_substantiation: true };
const GIFTS = { code: '6075', name: 'Client gifts', needs_substantiation: true };
const SOFTWARE = { code: '6000', name: 'Software', needs_substantiation: false };

test('an ordinary expense needs no story at all', () => {
  assert.deepEqual(substantiationGaps({}, SOFTWARE), []);
  assert.equal(isSubstantiated({}, SOFTWARE), true);
});

test('a meal needs where, why and who', () => {
  const gaps = substantiationGaps({}, MEALS);
  assert.ok(gaps.includes('where it was'));
  assert.ok(gaps.includes('the business purpose'));
  assert.ok(gaps.includes('who was there'));
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

test('a mileage claim with no distance is not a claim', () => {
  const trip = { place: 'Fort Worth', business_purpose: 'Client kickoff' };
  assert.deepEqual(substantiationGaps(trip, VEHICLE), ['how many miles']);
  assert.deepEqual(substantiationGaps({ ...trip, miles: 46 }, VEHICLE), []);
});

test('whitespace is not a business purpose', () => {
  const meal = { place: '  ', business_purpose: '\t', attendees: '' };
  assert.equal(substantiationGaps(meal, MEALS).length, 3);
});

test('an expense with no account on it is not judged', () => {
  assert.deepEqual(substantiationGaps({}, null), []);
});

test('the standard mileage rate prices a trip', () => {
  assert.equal(mileageAmount(46, 70), 3220);
  assert.equal(mileageAmount(46.5, 70), 3255);
  // The rate moves most years, which is why it is a parameter.
  assert.equal(mileageAmount(100, 67), 6700);
  assert.equal(mileageAmount('nonsense', 70), 0);
});

test('the rate label keeps the IRS half-cent instead of rounding it away', () => {
  assert.equal(mileageRateLabel(76), '$0.76');
  assert.equal(mileageRateLabel(72.5), '$0.725');
  assert.equal(mileageRateLabel(70), '$0.70');
});

// The subscription stack
// ---------------------------------------------------------------------------

const SUB = { active: true, day_of_month: 15, last_recorded_on: null };

test('a paused subscription is never due', () => {
  assert.deepEqual(recurringStatus({ ...SUB, active: false }, '2026-08-27'),
    { due: false, dueOn: null, behind: 0 });
});

test('a fresh template waits for its billing day, then is due for this month', () => {
  assert.deepEqual(recurringStatus(SUB, '2026-08-10'),
    { due: false, dueOn: '2026-08-15', behind: 0 });
  assert.deepEqual(recurringStatus(SUB, '2026-08-27'),
    { due: true, dueOn: '2026-08-15', behind: 1 });
});

test('recorded for this month means done until next month', () => {
  const done = { ...SUB, last_recorded_on: '2026-08-15' };
  assert.deepEqual(recurringStatus(done, '2026-08-27'),
    { due: false, dueOn: null, behind: 0 });
  assert.deepEqual(recurringStatus(done, '2026-09-20'),
    { due: true, dueOn: '2026-09-15', behind: 1 });
});

test('a lapse is counted, and the next due month is the oldest missed one', () => {
  const lapsed = { ...SUB, last_recorded_on: '2026-05-15' };
  assert.deepEqual(recurringStatus(lapsed, '2026-08-27'),
    { due: true, dueOn: '2026-06-15', behind: 3 });
});

test('December rolls into January without inventing a thirteenth month', () => {
  const yearEnd = { ...SUB, last_recorded_on: '2025-12-15' };
  assert.equal(recurringStatus(yearEnd, '2026-01-20').dueOn, '2026-01-15');
});

test('"the 31st" bills a short month on its last day', () => {
  const eom = { active: true, day_of_month: 31, last_recorded_on: null };
  assert.deepEqual(recurringStatus(eom, '2026-04-30'),
    { due: true, dueOn: '2026-04-30', behind: 1 });
  // February, in a leap year, honestly.
  assert.equal(recurringStatus(eom, '2028-02-29').dueOn, '2028-02-29');
});

// The by-month spread
// ---------------------------------------------------------------------------

test('a calendar year in August is eight month columns', () => {
  const spans = monthSpans('2026-08-27');
  assert.equal(spans.length, 8);
  assert.deepEqual(spans[0], {
    key: '2026-01', from: '2026-01-01', to: '2026-01-31', label: 'Jan',
  });
  assert.deepEqual(spans[7], {
    key: '2026-08', from: '2026-08-01', to: '2026-08-31', label: 'Aug',
  });
});

test('a July fiscal year reaches back into last year, and its labels say so', () => {
  const spans = monthSpans('2026-02-10', 7);
  assert.equal(spans.length, 8);
  assert.equal(spans[0].key, '2025-07');
  assert.equal(spans[0].label, 'Jul 25');
  assert.equal(spans[7].key, '2026-02');
  assert.equal(spans[7].label, 'Feb 26');
});

test('a full year is twelve columns and February knows about leap years', () => {
  assert.equal(monthSpans('2026-12-31').length, 12);
  const leap = monthSpans('2028-03-01').find((s) => s.key === '2028-02');
  assert.equal(leap.to, '2028-02-29');
});

test('the by-month spread lines every account up across the columns', () => {
  const spans = monthSpans('2026-03-15');
  const spread = monthlyProfitAndLoss(spans, {
    '2026-01': [
      acct('4010', 'Web design', 'income', 'income', 500000),
      acct('6000', 'Software', 'expense', 'expense', 10000),
    ],
    // February earned nothing from web design and bought no software.
    '2026-02': [acct('4020', 'Branding', 'income', 'income', 200000)],
    '2026-03': [
      acct('4010', 'Web design', 'income', 'income', 300000),
      acct('6000', 'Software', 'expense', 'expense', 10000),
    ],
  });

  assert.equal(spread.months.length, 3);

  const revenue = spread.groups.find((g) => g.key === 'revenue');
  const web = revenue.rows.find((r) => r.code === '4010');
  // A month the account never appeared in is a zero, not a missing column.
  assert.deepEqual(web.values, [500000, 0, 300000]);
  assert.equal(web.total, 800000);
  assert.deepEqual(revenue.totals, [500000, 200000, 300000]);
  assert.equal(revenue.total, 1000000);

  const net = spread.figures.find((f) => f.key === 'netProfit');
  assert.deepEqual(net.values, [490000, 200000, 290000]);
  assert.equal(net.total, 980000);
});

test('a section nothing ever touched is left off the spread entirely', () => {
  const spread = monthlyProfitAndLoss(monthSpans('2026-01-31'), {
    '2026-01': [acct('4010', 'Web design', 'income', 'income', 100000)],
  });
  assert.deepEqual(spread.groups.map((g) => g.key), ['revenue']);
});

// Whose capital is whose
// ---------------------------------------------------------------------------

const MEMBERS = [
  { profile_id: 'p-erin', ownership_bp: 2600, position: 0,
    legal_name: 'Erin Ashley Michelle Ochenski',
    profiles: { full_name: 'Erin Ochenski' },
    contributions_account_id: 'a-3110', draws_account_id: 'a-3210' },
  { profile_id: 'p-kim', ownership_bp: 2600, position: 1,
    legal_name: 'Kimberly Dianna Gardner',
    profiles: { full_name: 'Kimberly Gardner' },
    contributions_account_id: 'a-3120', draws_account_id: 'a-3220' },
  { profile_id: 'p-trip', ownership_bp: 2400, position: 2,
    legal_name: 'Walter James Ochenski III',
    profiles: { full_name: 'Trip Ochenski' },
    contributions_account_id: 'a-3130', draws_account_id: 'a-3230' },
  { profile_id: 'p-vic', ownership_bp: 2400, position: 3,
    legal_name: 'Victor Sinclair Gardner Jr.',
    profiles: { full_name: 'Vic Gardner' },
    contributions_account_id: 'a-3140', draws_account_id: 'a-3240' },
];

/** An equity balance as ledger_balances() hands it over: credit-normal, so a
 *  draw (a debit) arrives negative. */
function equity(accountId, balance) {
  return { account_id: accountId, code: '3xxx', name: 'x', type: 'equity',
    subtype: 'equity', balance, debits: 0, credits: 0 };
}

test('the books print the legal name, and the portal keeps the display one', () => {
  assert.equal(memberName(MEMBERS[2]), 'Walter James Ochenski III');
  // No legal name recorded yet: better the display name than a blank.
  assert.equal(memberName({ profiles: { full_name: 'Trip Ochenski' } }), 'Trip Ochenski');
  assert.equal(memberName({ profiles: { email: 'vic@newjourneydesigns.com' } }), 'vic');
  assert.equal(memberName(null), 'Unnamed member');
});

test('each member’s capital is their own contributions less their own draws', () => {
  const cap = ownerCapital(MEMBERS, [
    equity('a-3110', 500000),   // Erin put in $5,000
    equity('a-3210', -200000),  // and took out $2,000
    equity('a-3130', 100000),   // Trip put in $1,000
  ], 0);

  const erin = cap.rows.find((r) => r.member.profile_id === 'p-erin');
  assert.equal(erin.contributed, 500000);
  assert.equal(erin.drawn, 200000);   // reported as taken out, not as a negative
  assert.equal(erin.capital, 300000);

  const trip = cap.rows.find((r) => r.member.profile_id === 'p-trip');
  assert.equal(trip.capital, 100000);

  // A member who has neither put in nor taken out holds nothing, and still
  // appears — a missing row reads as a missing member.
  const vic = cap.rows.find((r) => r.member.profile_id === 'p-vic');
  assert.equal(vic.capital, 0);
  assert.equal(cap.rows.length, 4);
});

test('profit is allocated by the share each member actually owns', () => {
  const cap = ownerCapital(MEMBERS, [], 1000000); // $10,000 profit
  const share = Object.fromEntries(cap.rows.map((r) => [r.member.profile_id, r.share]));
  assert.equal(share['p-erin'], 260000);
  assert.equal(share['p-kim'], 260000);
  assert.equal(share['p-trip'], 240000);
  assert.equal(share['p-vic'], 240000);
  assert.equal(cap.rounding, 0);
});

test('the ownership split is checked, because a K-1 that does not tie is a problem', () => {
  assert.equal(ownerCapital(MEMBERS, [], 0).totalBp, 10000);
  assert.equal(ownerCapital(MEMBERS, [], 0).balanced, true);

  const short = ownerCapital(MEMBERS.slice(0, 3), [], 0);
  assert.equal(short.totalBp, 7600);
  assert.equal(short.balanced, false);
});

test('a rounding penny is named rather than quietly given to somebody', () => {
  // $100.01 across 26/26/24/24 does not divide into whole cents.
  const cap = ownerCapital(MEMBERS, [], 10001);
  const allocated = cap.rows.reduce((t, r) => t + r.share, 0);
  assert.equal(cap.rounding, 10001 - allocated);
  assert.notEqual(cap.rounding, 0);
});

test('the report reads in the order the members are positioned', () => {
  const names = ownerCapital(MEMBERS, [], 0).rows.map((r) => r.name);
  assert.deepEqual(names, [
    'Erin Ashley Michelle Ochenski',
    'Kimberly Dianna Gardner',
    'Walter James Ochenski III',
    'Victor Sinclair Gardner Jr.',
  ]);
});

test('a loss reduces every member’s capital in proportion', () => {
  const cap = ownerCapital(MEMBERS, [equity('a-3110', 500000)], -100000);
  const erin = cap.rows.find((r) => r.member.profile_id === 'p-erin');
  assert.equal(erin.share, -26000);
  assert.equal(erin.capital, 500000 - 26000);
});

test('every expense in the pack says who put it through', () => {
  const pack = samplePack();
  pack.expenses[0].creator = { full_name: 'Vic Gardner', email: 'vic@newjourneydesigns.com' };
  const file = packFiles(pack).find((f) => f.filename.includes('expenses.csv'));

  assert.equal(cell(file, file.rows[0], 'Entered by'), 'Vic Gardner');
  // It is an audit-trail fact and not a claim about whose money it was, so it
  // sits alongside "Paid from" rather than replacing it.
  assert.ok(file.headers.includes('Paid from'));
});

test('an expense recorded before the column existed says so rather than blank', () => {
  const file = packFiles(samplePack()).find((f) => f.filename.includes('expenses.csv'));
  assert.equal(cell(file, file.rows[0], 'Entered by'), 'Not recorded');
});
