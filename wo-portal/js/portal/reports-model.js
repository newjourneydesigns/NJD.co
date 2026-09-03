// ---------------------------------------------------------------------------
// The report arithmetic — pure.
//
//   node --test tools/portal/reports-model.test.mjs
//
// Everything the Dashboard and the Reports page add up lives here, with no
// DOM, no network and no clock, so a test can hold a tax year to account
// without a browser. The pages load rows and hand them in; this file decides
// what they come to.
//
// Two rules run through all of it.
//
// Dates are compared as strings. Every date column is a plain YYYY-MM-DD, and
// `new Date('2026-12-31')` is midnight UTC — which in Texas is still the 30th.
// A payment received on New Year's Eve landing in the wrong tax year is the
// exact failure a report exists to prevent, so a year is the first four
// characters of the string and nothing else. Timestamps (paid_at, created_at)
// are ISO strings too and their first ten characters are the UTC date;
// paid_at is set by the payments trigger to noon UTC of the last received_on,
// so its date is the received date in every timezone.
//
// Money is integer cents, signed. A refund is a negative payment and a
// supplier credit is a negative expense; both simply sum.
// ---------------------------------------------------------------------------

// Dates
// ---------------------------------------------------------------------------

/** 'YYYY' off a date or timestamp string; '' for anything else. */
export function yearOf(iso) {
  const value = String(iso == null ? '' : iso);
  return /^\d{4}/.test(value) ? value.slice(0, 4) : '';
}

export function inYear(iso, year) {
  const wanted = String(year == null ? '' : year);
  return wanted !== '' && yearOf(iso) === wanted;
}

/** 'YYYY-MM' off a date or timestamp string; '' for anything else. */
export function monthOf(iso) {
  const value = String(iso == null ? '' : iso);
  return /^\d{4}-\d{2}/.test(value) ? value.slice(0, 7) : '';
}

export function inMonth(iso, month) {
  const wanted = String(month == null ? '' : month);
  return wanted !== '' && monthOf(iso) === wanted;
}

/** Just the date part of anything date-shaped. */
function dateOf(iso) {
  return String(iso == null ? '' : iso).slice(0, 10);
}

/**
 * Whole days since the epoch for a YYYY-MM-DD, or NaN. Built from the parts
 * with Date.UTC so no timezone is ever consulted — the difference of two of
 * these is a count of calendar days, which is what "12 days late" means.
 */
export function dayNumber(iso) {
  const parts = dateOf(iso).split('-');
  if (parts.length !== 3 || parts.some((part) => !/^\d+$/.test(part))) return NaN;
  const [y, m, d] = parts.map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}

/** Calendar days from one date to another; NaN when either is not a date. */
export function daysBetween(fromIso, toIso) {
  return dayNumber(toIso) - dayNumber(fromIso);
}

/** This year and the previous few, newest first, as strings for a picker. */
export function yearChoices(todayIso, count = 4) {
  const year = Number(yearOf(todayIso));
  if (!Number.isFinite(year) || year < 1) return [];
  return Array.from({ length: count }, (_, i) => String(year - i));
}

export const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Money
// ---------------------------------------------------------------------------

/** Whole cents; garbage as zero, so a bad row cannot poison a total with NaN. */
export function cents(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

export function sumCents(rows, field = 'amount_cents') {
  return (rows || []).reduce((total, row) => total + cents(row && row[field]), 0);
}

/** Cents as '1234.56' for a spreadsheet cell — no symbol, no thousands
 *  separator, so every importer reads it as a number. */
export function moneyCsv(value) {
  return (cents(value) / 100).toFixed(2);
}

const METHOD_LABELS = {
  ach: 'ACH', check: 'Check', zelle: 'Zelle', card: 'Card', cash: 'Cash', other: 'Other',
};

export function methodLabel(value) {
  if (value == null || value === '') return '';
  return METHOD_LABELS[value] || String(value);
}

// Invoices
// ---------------------------------------------------------------------------

/** Handed to a client and not yet settled: the only two statuses that can
 *  be owed on, or late. */
const OPEN_STATUSES = ['issued', 'sent'];

/** Raised for real. A draft is nobody's document yet and a void one was
 *  taken back, so neither counts as invoiced. */
const BILLED_STATUSES = ['issued', 'sent', 'paid'];

export function isOpen(invoice) {
  return Boolean(invoice) && OPEN_STATUSES.includes(invoice.status);
}

export function isBilled(invoice) {
  return Boolean(invoice) && BILLED_STATUSES.includes(invoice.status);
}

/** What is still owed on an invoice right now: nothing on a draft, a void
 *  or a paid one. paid_cents is maintained by the payments trigger. */
export function outstandingCents(invoice) {
  if (!isOpen(invoice)) return 0;
  return cents(invoice.total_cents) - cents(invoice.paid_cents);
}

/** What people call it: 'Invoice 20260901-1'. Kept here rather than imported
 *  so the model has no dependency on the invoice screens. */
export function invoiceLabel(number) {
  const shown = String(number == null ? '' : number).trim();
  return `Invoice ${shown || '—'}`;
}

/** A client's name off a list of clients, then off a row's own embed, then a
 *  placeholder — never undefined in a cell. */
function clientNameOf(names, clientId, row) {
  const known = names.get(clientId);
  if (known) return known;
  const embed = row && (row.client || row.clients);
  return (embed && (embed.name || embed.legal_name)) || 'Unknown client';
}

function nameMap(clients) {
  return new Map((clients || []).map((client) => [client.id, client.name || client.legal_name || '']));
}

/**
 * Overdue: handed over, past its due date, and still owed on. Most-late
 * first, because that is the one to chase. `today` is passed in rather than
 * read off the clock so a test can ask about a Tuesday.
 */
export function overdueInvoices(invoices, todayIso) {
  const today = dateOf(todayIso);
  if (!today) return [];

  return (invoices || [])
    .filter((invoice) => isOpen(invoice) && invoice.due_on
      && dateOf(invoice.due_on) < today && outstandingCents(invoice) > 0)
    .map((invoice) => ({
      invoice,
      days: daysBetween(invoice.due_on, today),
      outstanding: outstandingCents(invoice),
    }))
    .sort((a, b) => b.days - a.days || dateOf(a.invoice.due_on).localeCompare(dateOf(b.invoice.due_on)));
}

/**
 * Drafts nobody has touched for more than `days` days. Judged on updated_at
 * rather than created_at: a draft written a month ago and edited yesterday
 * is being worked on, not forgotten. Oldest first.
 */
export function staleDrafts(invoices, todayIso, days = 7) {
  const today = dateOf(todayIso);
  if (!today) return [];

  return (invoices || [])
    .filter((invoice) => invoice && invoice.status === 'draft')
    .map((invoice) => ({
      invoice,
      days: daysBetween(invoice.updated_at || invoice.created_at, today),
    }))
    .filter((row) => Number.isFinite(row.days) && row.days > days)
    .sort((a, b) => b.days - a.days);
}

// Expenses
// ---------------------------------------------------------------------------

/**
 * How many receipts a row carries, whatever shape the loader gave it: an
 * embedded array (`receipts` or `expense_receipts`), or a plain count.
 */
export function receiptCount(row) {
  if (!row) return 0;
  if (Array.isArray(row.receipts)) return row.receipts.length;
  if (Array.isArray(row.expense_receipts)) return row.expense_receipts.length;
  const n = Number(row.receipt_count);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

export function unreceiptedExpenses(expenses) {
  return (expenses || []).filter((row) => receiptCount(row) === 0);
}

/** Part II of Schedule C, as the form numbers its lines. A category names
 *  one of these; the tax-year summary groups by it. */
export const SCHEDULE_C_LABELS = {
  8: 'Advertising',
  9: 'Car and truck expenses',
  10: 'Commissions and fees',
  11: 'Contract labor',
  12: 'Depletion',
  13: 'Depreciation',
  14: 'Employee benefit programs',
  15: 'Insurance',
  '16a': 'Mortgage interest',
  '16b': 'Other interest',
  17: 'Legal and professional services',
  18: 'Office expense',
  19: 'Pension and profit-sharing plans',
  '20a': 'Rent — vehicles, machinery, equipment',
  '20b': 'Rent — other business property',
  21: 'Repairs and maintenance',
  22: 'Supplies',
  23: 'Taxes and licenses',
  '24a': 'Travel',
  '24b': 'Deductible meals',
  25: 'Utilities',
  26: 'Wages',
  '27a': 'Other expenses',
  30: 'Business use of home',
};

/** '24b' → 'Line 24b · Deductible meals'; an unknown line still says which. */
export function scheduleCLabel(line) {
  const key = String(line == null ? '' : line).trim();
  if (!key) return 'No Schedule C line';
  const name = SCHEDULE_C_LABELS[key];
  return name ? `Line ${key} · ${name}` : `Line ${key}`;
}

/** Sort '8' before '11' before '24a' before '24b': by number, then letter.
 *  Anything that is not line-shaped sorts after the lines, alphabetically. */
export function compareLines(a, b) {
  const shape = /^(\d+)([a-z]*)$/;
  const left = shape.exec(String(a == null ? '' : a).trim());
  const right = shape.exec(String(b == null ? '' : b).trim());
  if (left && right) {
    return (Number(left[1]) - Number(right[1])) || left[2].localeCompare(right[2]);
  }
  if (left) return -1;
  if (right) return 1;
  return String(a).localeCompare(String(b));
}

/** The category a row was booked to: from the list first, from the row's
 *  own embed second, and a named placeholder last — an expense whose
 *  category was deleted out from under it still has to appear somewhere. */
function categoryFor(row, categories) {
  const known = categories.get(row.category_id);
  if (known) return known;
  const embed = row.category;
  if (embed && embed.id === row.category_id) return embed;
  return {
    id: row.category_id || null,
    code: '',
    name: 'Uncategorised',
    schedule_c_line: '27a',
    half_deductible: false,
    position: Number.MAX_SAFE_INTEGER,
  };
}

/** Half of a total, rounded once at the category level — the way the 50%
 *  meals limit is applied on the return — rather than per receipt. */
function deductibleOf(totalCents, halfDeductible) {
  return halfDeductible ? Math.round(totalCents / 2) : totalCents;
}

/**
 * One tax year, cash basis, as Schedule C wants it.
 *
 *   gross_receipts_cents         every payment received in the year (refunds
 *                                are negative payments and simply reduce it)
 *   sales_tax_collected_cents    tax on the invoices that were settled in the
 *                                year — it is collected when paid, and it is
 *                                the state's, not income
 *   by_line                      expenses grouped by Schedule C line, each
 *                                line by category, with the full amount and
 *                                the deductible amount side by side so a
 *                                50% meal is never silently either
 *   net_cents                    gross receipts less deductible expenses
 *   receivable_at_year_end_cents what was still owed at midnight on the 31st:
 *                                every invoice raised by then, less the
 *                                payments received by then — an invoice paid
 *                                in January was still receivable in December
 *   unreceipted_count            expenses in the year with no receipt on file
 */
export function taxYearSummary({
  payments = [], invoices = [], expenses = [], categories = [], year,
} = {}) {
  const wanted = String(year == null ? '' : year);
  const yearEnd = `${wanted}-12-31`;
  const categoryMap = new Map((categories || []).map((category) => [category.id, category]));

  const grossReceipts = sumCents((payments || []).filter((row) => inYear(row.received_on, wanted)));

  const salesTax = (invoices || [])
    .filter((row) => inYear(row.paid_at, wanted))
    .reduce((total, row) => total + cents(row.tax_cents), 0);

  const lines = new Map();
  let expensesTotal = 0;
  let expenseCount = 0;
  let unreceipted = 0;

  for (const row of expenses || []) {
    if (!row || !inYear(row.spent_on, wanted)) continue;
    const amount = cents(row.amount_cents);
    expensesTotal += amount;
    expenseCount += 1;
    if (receiptCount(row) === 0) unreceipted += 1;

    const category = categoryFor(row, categoryMap);
    const lineKey = String(category.schedule_c_line || '27a');
    if (!lines.has(lineKey)) lines.set(lineKey, new Map());
    const byCategory = lines.get(lineKey);
    const key = category.id || 'uncategorised';
    if (!byCategory.has(key)) {
      byCategory.set(key, {
        id: category.id || null,
        code: category.code || '',
        name: category.name || 'Uncategorised',
        half_deductible: Boolean(category.half_deductible),
        position: Number.isFinite(Number(category.position)) ? Number(category.position) : 0,
        count: 0,
        total_cents: 0,
      });
    }
    const entry = byCategory.get(key);
    entry.count += 1;
    entry.total_cents += amount;
  }

  const byLine = [...lines.keys()].sort(compareLines).map((lineKey) => {
    const rows = [...lines.get(lineKey).values()]
      .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
      .map((entry) => ({
        id: entry.id,
        code: entry.code,
        name: entry.name,
        half_deductible: entry.half_deductible,
        count: entry.count,
        total_cents: entry.total_cents,
        deductible_cents: deductibleOf(entry.total_cents, entry.half_deductible),
      }));
    return {
      schedule_c_line: lineKey,
      label: scheduleCLabel(lineKey),
      categories: rows,
      total_cents: rows.reduce((total, row) => total + row.total_cents, 0),
      deductible_cents: rows.reduce((total, row) => total + row.deductible_cents, 0),
    };
  });

  const deductibleTotal = byLine.reduce((total, line) => total + line.deductible_cents, 0);

  // Receivable at year end. Payments are keyed by invoice and cut off at the
  // 31st, so a payment that arrived in January does not settle December.
  const paidThrough = new Map();
  for (const row of payments || []) {
    if (!row || !row.invoice_id) continue;
    const received = dateOf(row.received_on);
    if (!received || received > yearEnd) continue;
    paidThrough.set(row.invoice_id, (paidThrough.get(row.invoice_id) || 0) + cents(row.amount_cents));
  }

  let receivable = 0;
  let receivableCount = 0;
  for (const invoice of invoices || []) {
    if (!isBilled(invoice)) continue;
    const issued = dateOf(invoice.issued_on);
    if (!issued || issued > yearEnd) continue;
    const owed = cents(invoice.total_cents) - (paidThrough.get(invoice.id) || 0);
    if (owed > 0) {
      receivable += owed;
      receivableCount += 1;
    }
  }

  return {
    year: wanted,
    gross_receipts_cents: grossReceipts,
    sales_tax_collected_cents: salesTax,
    by_line: byLine,
    expenses_total_cents: expensesTotal,
    deductible_total_cents: deductibleTotal,
    net_cents: grossReceipts - deductibleTotal,
    receivable_at_year_end_cents: receivable,
    receivable_at_year_end_count: receivableCount,
    unreceipted_count: unreceipted,
    expense_count: expenseCount,
  };
}

/**
 * The year by client: what each was invoiced, what they actually paid, what
 * was spent on their behalf, and what they still owe on that year's
 * invoices. Every figure is cents. Only clients with something in the year
 * appear; overhead with no client is not anybody's row.
 */
export function byClient({
  invoices = [], payments = [], expenses = [], clients = [], year,
} = {}) {
  const wanted = String(year == null ? '' : year);
  const names = nameMap(clients);
  const rows = new Map();

  function rowFor(clientId, source) {
    const key = clientId || 'none';
    if (!rows.has(key)) {
      rows.set(key, {
        client_id: clientId || null,
        client: clientNameOf(names, clientId, source),
        invoiced: 0,
        received: 0,
        expenses: 0,
        outstanding: 0,
      });
    }
    return rows.get(key);
  }

  for (const invoice of invoices || []) {
    if (!isBilled(invoice) || !inYear(invoice.issued_on, wanted)) continue;
    const row = rowFor(invoice.client_id, invoice);
    row.invoiced += cents(invoice.total_cents);
    row.outstanding += outstandingCents(invoice);
  }

  for (const payment of payments || []) {
    if (!payment || !inYear(payment.received_on, wanted)) continue;
    rowFor(payment.client_id, payment).received += cents(payment.amount_cents);
  }

  for (const expense of expenses || []) {
    if (!expense || !expense.client_id || !inYear(expense.spent_on, wanted)) continue;
    rowFor(expense.client_id, expense).expenses += cents(expense.amount_cents);
  }

  return [...rows.values()]
    .filter((row) => row.invoiced || row.received || row.expenses || row.outstanding)
    .sort((a, b) => b.received - a.received || b.invoiced - a.invoiced
      || a.client.localeCompare(b.client));
}

/** Twelve rows, January to December: what came in, what went out, and the
 *  difference. A month with nothing in it is still a row, because a gap in
 *  a table reads as a missing month rather than a quiet one. */
export function byMonth({ payments = [], expenses = [], year } = {}) {
  const wanted = String(year == null ? '' : year);

  return MONTH_SHORT.map((label, index) => {
    const month = `${wanted}-${String(index + 1).padStart(2, '0')}`;
    const received = sumCents((payments || []).filter((row) => row && inMonth(row.received_on, month)));
    const spent = sumCents((expenses || []).filter((row) => row && inMonth(row.spent_on, month)));
    return {
      month, label, received, spent, net: received - spent,
    };
  });
}

// 1099-NEC
// ---------------------------------------------------------------------------

export const DEFAULT_NEC_THRESHOLD_CENTS = 200000;

/**
 * Every vendor paid in the year against the 1099-NEC threshold.
 *
 * Reaching the threshold exactly counts: the law says "$2,000 or more". A
 * vendor is `reportable` only when the owner has also flagged them as one
 * who gets a form — a software company over the threshold is not a
 * contractor — and `missing_tax_id` is the row worth seeing in November:
 * reportable, and no W-9 collected. Spend is matched by vendor_id; a one-off
 * typed as a bare vendor_name has no record to file a form against.
 */
export function vendors1099({
  expenses = [], vendors = [], year, thresholdCents = DEFAULT_NEC_THRESHOLD_CENTS,
} = {}) {
  const wanted = String(year == null ? '' : year);
  const threshold = cents(thresholdCents) > 0 ? cents(thresholdCents) : DEFAULT_NEC_THRESHOLD_CENTS;
  const totals = new Map();

  for (const row of expenses || []) {
    if (!row || !row.vendor_id) continue;
    if (wanted && !inYear(row.spent_on, wanted)) continue;
    totals.set(row.vendor_id, (totals.get(row.vendor_id) || 0) + cents(row.amount_cents));
  }

  return (vendors || [])
    .map((vendor) => {
      const total = totals.get(vendor.id) || 0;
      const files = Boolean(vendor.files_1099);
      const over = total >= threshold;
      return {
        vendor,
        total_cents: total,
        files_1099: files,
        tax_id_on_file: Boolean(vendor.tax_id_on_file),
        over_threshold: over,
        reportable: files && over,
        missing_tax_id: files && over && !vendor.tax_id_on_file,
      };
    })
    .filter((row) => row.total_cents !== 0 || row.files_1099)
    .sort((a, b) => b.total_cents - a.total_cents
      || String(a.vendor.name || '').localeCompare(String(b.vendor.name || '')));
}

// The dashboard
// ---------------------------------------------------------------------------

/**
 * The seven numbers on the front page. Outstanding and overdue are as of
 * today across every open invoice; the rest are this month's and this
 * year's cash movement. Expenses here are the full amount spent — the
 * deductible view belongs to the tax year page.
 */
export function dashboardFigures({
  invoices = [], payments = [], expenses = [], today,
} = {}) {
  const day = dateOf(today);
  const month = monthOf(day);
  const year = yearOf(day);
  const late = overdueInvoices(invoices, day);

  const outstanding = (invoices || []).reduce((total, row) => total + outstandingCents(row), 0);
  const overdue = late.reduce((total, row) => total + row.outstanding, 0);
  const receivedMonth = sumCents((payments || []).filter((row) => row && inMonth(row.received_on, month)));
  const invoicedMonth = (invoices || [])
    .filter((row) => isBilled(row) && inMonth(row.issued_on, month))
    .reduce((total, row) => total + cents(row.total_cents), 0);
  const incomeYtd = sumCents((payments || []).filter((row) => row && inYear(row.received_on, year)));
  const expensesYtd = sumCents((expenses || []).filter((row) => row && inYear(row.spent_on, year)));

  return {
    outstanding_cents: outstanding,
    overdue_cents: overdue,
    overdue_count: late.length,
    received_month_cents: receivedMonth,
    invoiced_month_cents: invoicedMonth,
    income_ytd_cents: incomeYtd,
    expenses_ytd_cents: expensesYtd,
    net_ytd_cents: incomeYtd - expensesYtd,
  };
}

/**
 * The last few things that happened, across all three tables, newest first.
 * An invoice dates from the day it was raised, a payment from the day the
 * money arrived, an expense from the day it was paid; created_at breaks
 * ties so two things on one day keep the order they were entered in.
 */
export function recentActivity({ invoices = [], payments = [], expenses = [] } = {}, limit = 8) {
  const items = [
    ...(invoices || []).map((row) => ({
      kind: 'invoice',
      id: row.id,
      date: dateOf(row.issued_on || row.created_at),
      stamp: String(row.created_at || ''),
      client_id: row.client_id || null,
      number: row.number,
      status: row.status,
      amount_cents: cents(row.total_cents),
    })),
    ...(payments || []).map((row) => ({
      kind: 'payment',
      id: row.id,
      date: dateOf(row.received_on),
      stamp: String(row.created_at || ''),
      client_id: row.client_id || null,
      invoice_id: row.invoice_id || null,
      method: row.method,
      amount_cents: cents(row.amount_cents),
    })),
    ...(expenses || []).map((row) => ({
      kind: 'expense',
      id: row.id,
      date: dateOf(row.spent_on),
      stamp: String(row.created_at || ''),
      client_id: row.client_id || null,
      vendor_id: row.vendor_id || null,
      vendor_name: row.vendor_name || '',
      description: row.description || '',
      amount_cents: cents(row.amount_cents),
    })),
  ];

  return items
    .sort((a, b) => b.date.localeCompare(a.date) || b.stamp.localeCompare(a.stamp))
    .slice(0, limit);
}

// CSV
// ---------------------------------------------------------------------------
//
// Each builder returns { filename, headers, rows } rather than downloading,
// so the files can be tested without a browser. Filenames say the year and
// the contents, so four of them dropped in one folder sort themselves.

export function csvFilename(year, what) {
  return `wo-${String(year)}-${what}.csv`;
}

function yesNo(value) {
  return value ? 'yes' : 'no';
}

export function invoicesCsv({ invoices = [], clients = [], year } = {}) {
  const wanted = String(year == null ? '' : year);
  const names = nameMap(clients);

  const rows = (invoices || [])
    .filter((row) => row && inYear(row.issued_on, wanted))
    .sort((a, b) => dateOf(a.issued_on).localeCompare(dateOf(b.issued_on))
      || String(a.number || '').localeCompare(String(b.number || '')))
    .map((row) => [
      row.number || '',
      clientNameOf(names, row.client_id, row),
      row.status || '',
      dateOf(row.issued_on),
      dateOf(row.due_on),
      row.project_name || '',
      row.purchase_order || '',
      moneyCsv(row.subtotal_cents),
      moneyCsv(row.tax_cents),
      moneyCsv(row.total_cents),
      moneyCsv(row.paid_cents),
      // A draft or a void invoice is owed nothing; the cell stays blank
      // rather than printing a zero that looks settled.
      isBilled(row) ? moneyCsv(cents(row.total_cents) - cents(row.paid_cents)) : '',
      dateOf(row.paid_at),
    ]);

  return {
    filename: csvFilename(wanted, 'invoices'),
    headers: ['Number', 'Client', 'Status', 'Issued', 'Due', 'Project', 'PO',
      'Subtotal', 'Tax', 'Total', 'Paid', 'Outstanding', 'Paid on'],
    rows,
  };
}

export function paymentsCsv({
  payments = [], invoices = [], clients = [], year,
} = {}) {
  const wanted = String(year == null ? '' : year);
  const names = nameMap(clients);
  const numbers = new Map((invoices || []).map((row) => [row.id, row.number]));

  const rows = (payments || [])
    .filter((row) => row && inYear(row.received_on, wanted))
    .sort((a, b) => dateOf(a.received_on).localeCompare(dateOf(b.received_on))
      || String(a.created_at || '').localeCompare(String(b.created_at || '')))
    .map((row) => [
      dateOf(row.received_on),
      clientNameOf(names, row.client_id, row),
      numbers.get(row.invoice_id) || '',
      moneyCsv(row.amount_cents),
      methodLabel(row.method),
      row.reference || '',
      row.notes || '',
    ]);

  return {
    filename: csvFilename(wanted, 'payments'),
    headers: ['Received', 'Client', 'Invoice', 'Amount', 'Method', 'Reference', 'Notes'],
    rows,
  };
}

/**
 * Everything a preparer needs to reclassify a line, substantiate it or ask
 * about it, in one file. The deductible note names the 50% rule rather than
 * halving each row: the limit is applied to the year's meals once, on the
 * return, and per-row halves of odd cents would not add up to it.
 */
export function expensesCsv({
  expenses = [], categories = [], vendors = [], clients = [], year,
} = {}) {
  const wanted = String(year == null ? '' : year);
  const names = nameMap(clients);
  const categoryMap = new Map((categories || []).map((category) => [category.id, category]));
  const vendorNames = new Map((vendors || []).map((vendor) => [vendor.id, vendor.name || '']));

  const rows = (expenses || [])
    .filter((row) => row && inYear(row.spent_on, wanted))
    .sort((a, b) => dateOf(a.spent_on).localeCompare(dateOf(b.spent_on))
      || String(a.created_at || '').localeCompare(String(b.created_at || '')))
    .map((row) => {
      const category = categoryFor(row, categoryMap);
      const embeddedVendor = row.vendor && row.vendor.name;
      return [
        dateOf(row.spent_on),
        vendorNames.get(row.vendor_id) || embeddedVendor || row.vendor_name || '',
        row.description || '',
        String(category.schedule_c_line || ''),
        category.name || '',
        moneyCsv(row.amount_cents),
        category.half_deductible ? '50% deductible' : '',
        methodLabel(row.method),
        row.reference || '',
        row.client_id ? clientNameOf(names, row.client_id, row) : '',
        yesNo(row.billable),
        yesNo(row.billed_invoice_id),
        row.place || '',
        row.business_purpose || '',
        row.attendees || '',
        receiptCount(row),
      ];
    });

  return {
    filename: csvFilename(wanted, 'expenses'),
    headers: ['Date', 'Vendor', 'Description', 'Schedule C line', 'Category', 'Amount',
      'Deductible note', 'Method', 'Reference', 'Client', 'Billable', 'Billed',
      'Where', 'Business purpose', 'Who was there', 'Receipts on file'],
    rows,
  };
}

/** The 1099 list as a file: `rows` is what vendors1099() returned. */
export function contractorsCsv({ rows = [], year } = {}) {
  const wanted = String(year == null ? '' : year);

  return {
    filename: csvFilename(wanted, '1099'),
    headers: ['Vendor', 'Email', 'Phone', 'Address', `Paid in ${wanted}`,
      'Over threshold', 'Needs 1099', 'W-9 on file'],
    rows: (rows || []).map((row) => [
      row.vendor.name || '',
      row.vendor.email || '',
      row.vendor.phone || '',
      row.vendor.address || '',
      moneyCsv(row.total_cents),
      yesNo(row.over_threshold),
      yesNo(row.reportable),
      yesNo(row.tax_id_on_file),
    ]),
  };
}
