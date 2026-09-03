// ---------------------------------------------------------------------------
// Expenses — the pure half.
//
// Everything on the Expenses page that is worth a test lives here: no DOM, no
// network, no clock. expenses.js opens a page and runs bootstrap() the moment
// it is imported, so anything an accountant would want to check — the 1099
// list, the ageing buckets, what a meal is missing before it survives an
// examination, when a subscription falls due — has to live somewhere a test
// can import. This is that somewhere.
//
// Money is integer cents throughout. Dates are YYYY-MM-DD strings and are cut
// apart by hand rather than parsed: `new Date('2026-08-01')` is UTC midnight,
// which is the previous evening in Texas.
// ---------------------------------------------------------------------------

import { formatMoney, parseMoney } from './money.js';

// How money moved
// ---------------------------------------------------------------------------

/** The payment_method enum in schema.sql, in the order the business uses them. */
export const PAYMENT_METHODS = [
  { value: 'ach',   label: 'ACH' },
  { value: 'check', label: 'Check' },
  { value: 'zelle', label: 'Zelle' },
  { value: 'card',  label: 'Card' },
  { value: 'cash',  label: 'Cash' },
  { value: 'other', label: 'Other' },
];

export function methodLabel(value) {
  const found = PAYMENT_METHODS.find((row) => row.value === value);
  return found ? found.label : String(value || '');
}

/**
 * Money for a report, where a negative is written in parentheses.
 *
 * Not decoration: it is what every accountant and every tax preparer does,
 * and a list with "-$400.00" on it reads as a typo to the person this exists
 * to be handed to. A refund from a supplier is a negative expense.
 */
export function formatSigned(cents) {
  const amount = Number(cents) || 0;
  if (amount < 0) return `(${formatMoney(-amount)})`;
  return formatMoney(amount);
}

/** The total of a list of cents, or of rows carrying amount_cents. Garbage
 *  counts as nothing rather than as NaN, which would poison every figure. */
export function sumCents(list) {
  return (list || []).reduce((total, item) => {
    const raw = item && typeof item === 'object' ? item.amount_cents : item;
    const n = Number(raw);
    return total + (Number.isFinite(n) ? n : 0);
  }, 0);
}

// Schedule C
// ---------------------------------------------------------------------------

/**
 * Part II of Schedule C, so a category's line number can be printed as a
 * name. Only the lines a service business meets; a line missing from this
 * list still prints as "Line 12", it just does not get a caption.
 */
export const SCHEDULE_C_LINES = [
  { line: '8',   label: 'Advertising' },
  { line: '9',   label: 'Car and truck expenses' },
  { line: '10',  label: 'Commissions and fees' },
  { line: '11',  label: 'Contract labor' },
  { line: '13',  label: 'Depreciation' },
  { line: '15',  label: 'Insurance' },
  { line: '16b', label: 'Interest' },
  { line: '17',  label: 'Legal and professional services' },
  { line: '18',  label: 'Office expense' },
  { line: '20b', label: 'Rent or lease' },
  { line: '21',  label: 'Repairs and maintenance' },
  { line: '22',  label: 'Supplies' },
  { line: '23',  label: 'Taxes and licenses' },
  { line: '24a', label: 'Travel' },
  { line: '24b', label: 'Meals' },
  { line: '25',  label: 'Utilities' },
  { line: '27a', label: 'Other expenses' },
  { line: '30',  label: 'Home office' },
];

/** "Line 24b · Meals", or just "Line 12" for a line this file has no name for. */
export function scheduleCLabel(line) {
  const key = String(line || '').trim();
  if (!key) return '';
  const found = SCHEDULE_C_LINES.find((row) => row.line === key);
  return found ? `Line ${key} · ${found.label}` : `Line ${key}`;
}

/** '24b' → [24, 'b'], so lines sort the way the form reads: 8, 9, 11, 24a,
 *  24b, 27a. A plain string sort would put 11 before 8. */
function lineRank(line) {
  const match = /^(\d+)([a-z]?)$/i.exec(String(line || '').trim());
  if (!match) return [999, String(line || '')];
  return [Number(match[1]), match[2].toLowerCase()];
}

export function compareLines(a, b) {
  const [na, sa] = lineRank(a);
  const [nb, sb] = lineRank(b);
  return (na - nb) || sa.localeCompare(sb);
}

/**
 * The category list as a <select> reads it: grouped by Schedule C line, then
 * in the owner's own order. A plain <select> has no headings, so the line is
 * written into each label — "24b · Business meals" — which is what makes the
 * grouping visible.
 *
 * Archived categories are left out unless `keepId` names one: an expense
 * booked to a category that was archived afterwards must still be able to
 * open in the form without quietly moving somewhere else.
 */
export function categoryOptions(categories, { keepId = null } = {}) {
  return (categories || [])
    .filter((row) => !row.archived_at || row.id === keepId)
    .slice()
    .sort((a, b) => compareLines(a.schedule_c_line, b.schedule_c_line)
      || ((Number(a.position) || 0) - (Number(b.position) || 0))
      || String(a.name).localeCompare(String(b.name)))
    .map((row) => ({
      value: row.id,
      label: `${row.schedule_c_line ? `${row.schedule_c_line} · ` : ''}${row.name}`
        + (row.archived_at ? ' (archived)' : ''),
    }));
}

// Accounts receivable ageing
// ---------------------------------------------------------------------------

export const AGING_BUCKETS = [
  { key: 'current', label: 'Not yet due' },
  { key: 'd30',     label: '1–30 days' },
  { key: 'd60',     label: '31–60 days' },
  { key: 'd90',     label: '61–90 days' },
  { key: 'older',   label: 'Over 90 days' },
];

/**
 * Who owes what, and how long they have owed it.
 *
 * Built from the invoices, because "chase this one" is a question about a
 * document. Drafts, voids and paid invoices are all excluded. An invoice with
 * no due date counts as due on the day it was issued, which is the least
 * generous honest reading and stops a missing field hiding a debt in the "not
 * yet due" column.
 *
 * The client name is read off either embed shape — `clients` (NJD's) or
 * `client` (this portal's) — so the dashboard and the reports can share it.
 */
export function agingReport(invoices, today) {
  const now = String(today).slice(0, 10);
  const rows = [];

  (invoices || []).forEach((invoice) => {
    if (['draft', 'void', 'paid'].includes(invoice.status)) return;
    const outstanding = (Number(invoice.total_cents) || 0) - (Number(invoice.paid_cents) || 0);
    if (outstanding <= 0) return;

    const due = String(invoice.due_on || invoice.issued_on || now).slice(0, 10);
    const days = Math.floor(
      (Date.parse(`${now}T00:00:00Z`) - Date.parse(`${due}T00:00:00Z`)) / 86400000,
    );

    let bucket = 'current';
    if (days > 90) bucket = 'older';
    else if (days > 60) bucket = 'd90';
    else if (days > 30) bucket = 'd60';
    else if (days > 0) bucket = 'd30';

    rows.push({ invoice, outstanding, days: days > 0 ? days : 0, bucket });
  });

  const byClient = new Map();
  rows.forEach((row) => {
    const client = row.invoice.clients || row.invoice.client || {};
    const key = row.invoice.client_id || 'unknown';
    if (!byClient.has(key)) {
      byClient.set(key, {
        clientId: key,
        name: client.name || client.legal_name || 'Unknown client',
        total: 0,
        rows: [],
        ...Object.fromEntries(AGING_BUCKETS.map((b) => [b.key, 0])),
      });
    }
    const entry = byClient.get(key);
    entry.total += row.outstanding;
    entry[row.bucket] += row.outstanding;
    entry.rows.push(row);
  });

  const clients = Array.from(byClient.values()).sort((a, b) => b.total - a.total);
  const totals = Object.fromEntries(AGING_BUCKETS.map((b) => [
    b.key, clients.reduce((t, row) => t + row[b.key], 0),
  ]));

  return {
    clients,
    totals,
    total: clients.reduce((t, row) => t + row.total, 0),
    overdue: clients.reduce((t, row) => t + (row.total - row.current), 0),
  };
}

// 1099s
// ---------------------------------------------------------------------------

/** The 1099-NEC threshold for payments made in 2026 onward. The live value
 *  is studio_settings.nec_threshold_cents; this is the fallback. */
export const DEFAULT_NEC_THRESHOLD_CENTS = 200000;

/**
 * The 1099-NEC list: what each vendor was paid in a calendar year.
 *
 * `over_threshold` is the arithmetic; `files_1099` is the owner's decision
 * about whether that vendor is the kind that gets a form. `reportable` is the
 * two together, and `missing_tax_id` is the column that earns this report its
 * place: a contractor who needs a form and whose W-9 was never collected is a
 * cheap problem in June and an expensive one in January.
 *
 * Vendors with nothing paid and no 1099 flag are left out; a flagged vendor
 * always prints, so a contractor on zero for the year is still visible.
 */
export function vendorTotals(expenses, vendors, year, thresholdCents = DEFAULT_NEC_THRESHOLD_CENTS) {
  const totals = new Map();
  const threshold = Number(thresholdCents) || DEFAULT_NEC_THRESHOLD_CENTS;

  (expenses || []).forEach((row) => {
    if (year && String(row.spent_on).slice(0, 4) !== String(year)) return;
    if (!row.vendor_id) return;
    totals.set(row.vendor_id, (totals.get(row.vendor_id) || 0) + (Number(row.amount_cents) || 0));
  });

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
    .sort((a, b) => b.total_cents - a.total_cents);
}

// Substantiation
// ---------------------------------------------------------------------------

/**
 * What is missing from an expense before it would survive an examination.
 *
 * Publication 463 wants the where, the business purpose and the business
 * relationship of anybody else there for a meal, a trip or a gift. The
 * category's own flags say which apply: `needs_substantiation` asks for the
 * place and the purpose, `needs_attendees` asks who was there. Nobody has to
 * name the people on a hotel bill.
 *
 * Returns the list of what is missing, so a screen can name it rather than
 * show a red dot. It is a warning, never a blocker: the expense records
 * either way, and the gap is reported until it is filled.
 */
export function substantiationGaps(expense, category) {
  if (!category) return [];
  const row = expense || {};
  const blank = (value) => !String(value || '').trim();
  const gaps = [];

  if (category.needs_substantiation) {
    if (blank(row.place)) gaps.push('where it was');
    if (blank(row.business_purpose)) gaps.push('the business purpose');
  }
  if (category.needs_attendees && blank(row.attendees)) gaps.push('who was there');

  return gaps;
}

/** Is this expense ready to hand to a preparer? */
export function isSubstantiated(expense, category) {
  return substantiationGaps(expense, category).length === 0;
}

// The calendar
// ---------------------------------------------------------------------------

export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

export const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** Days in a month, asked of the calendar rather than remembered. `month` is
 *  1–12, the way a person counts. */
export function daysInMonth(year, month) {
  return new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
}

/**
 * A day of the month that exists: "the 31st" bills February on the 28th (or
 * the 29th), and a nonsense day lands on the 1st rather than nowhere.
 */
export function clampDay(year, month, day) {
  const wanted = Math.floor(Number(day));
  if (!Number.isFinite(wanted) || wanted < 1) return 1;
  return Math.min(wanted, daysInMonth(year, month));
}

export function isoDay(year, month, day) {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/** "August" or, with the year, "August 2026" — from a date-only string, with
 *  no Date object in the way. */
export function monthName(iso, { withYear = false } = {}) {
  const text = String(iso || '');
  const month = Number(text.slice(5, 7));
  if (!month || month > 12) return '';
  return MONTH_NAMES[month - 1] + (withYear ? ` ${text.slice(0, 4)}` : '');
}

/** The calendar year an expense belongs to, or null. */
export function expenseYear(expense) {
  const year = Number(String((expense && expense.spent_on) || '').slice(0, 4));
  return year > 0 ? year : null;
}

/**
 * The twelve months of a calendar year, each as a closed date range — what a
 * by-month report asks twelve times.
 */
export function monthSpans(year) {
  const y = Number(year);
  return MONTH_SHORT.map((label, index) => {
    const month = index + 1;
    return {
      key: `${y}-${pad2(month)}`,
      month,
      from: isoDay(y, month, 1),
      to: isoDay(y, month, daysInMonth(y, month)),
      label,
    };
  });
}

/**
 * The years the year filter offers: from the earliest expense on record (or
 * last year, whichever is earlier) up to this year, newest first. Always at
 * least two, so a first-year business can look at last year's empty page and
 * see that it is empty rather than wonder where the control went.
 */
export function yearOptions(currentYear, earliestYear = null) {
  const now = Number(currentYear);
  const first = Math.min(now - 1, Number(earliestYear) || now - 1);
  const years = [];
  for (let y = now; y >= first; y -= 1) years.push(y);
  return years;
}

// Subscriptions
// ---------------------------------------------------------------------------

/**
 * Where a recurring charge stands against the calendar.
 *
 * Returns { due, dueOn, behind, recordedThisMonth }. `dueOn` is the next
 * month it should be recorded for — the month after the last recorded one,
 * or the current month for a fresh template — with the billing day clamped to
 * the month's length. `behind` counts how many months are waiting (1 is the
 * normal case; more means bookkeeping lapsed and each Record walks forward a
 * month at a time, so a lapse backfills instead of leaving holes).
 * `recordedThisMonth` is what the "Record this month" button reads.
 *
 * A paused template is never due. A fresh template starts at the current
 * month rather than reaching into the past: the months before it existed
 * here were recorded by hand or not at all, and inventing them is not this
 * function's call.
 */
export function recurringStatus(template, todayIso) {
  const today = String(todayIso).slice(0, 10);
  const thisMonth = today.slice(0, 7);
  const last = template && template.last_recorded_on
    ? String(template.last_recorded_on).slice(0, 7)
    : null;
  const recordedThisMonth = Boolean(last) && last >= thisMonth;
  const none = { due: false, dueOn: null, behind: 0, recordedThisMonth };

  if (!template || !template.active) return none;

  const [ty, tm] = today.split('-').map(Number);
  let ny = ty;
  let nm = tm;
  if (last) {
    const [ly, lm] = last.split('-').map(Number);
    ny = lm === 12 ? ly + 1 : ly;
    nm = lm === 12 ? 1 : lm + 1;
    // Recorded through this month (or beyond) already: nothing is waiting.
    if (`${ny}-${pad2(nm)}` > thisMonth) return none;
  }

  const dueOn = isoDay(ny, nm, clampDay(ny, nm, template.day_of_month));
  if (dueOn > today) return { due: false, dueOn, behind: 0, recordedThisMonth };

  return { due: true, dueOn, behind: (ty - ny) * 12 + (tm - nm) + 1, recordedThisMonth };
}

/** The day a template's charge lands in the month of `forDateIso`, clamped —
 *  the spent_on an expense recorded from it carries. */
export function recurringSpentOn(template, forDateIso) {
  const iso = String(forDateIso || '').slice(0, 10);
  const year = Number(iso.slice(0, 4));
  const month = Number(iso.slice(5, 7));
  return isoDay(year, month, clampDay(year, month, template && template.day_of_month));
}

// What the form can work out for itself
// ---------------------------------------------------------------------------

/**
 * The saved vendor a typed name means, or null for a name nobody has used yet.
 *
 * Case- and space-insensitive because "adobe" typed on a phone and "Adobe" in
 * the vendor table are the same supplier, and a second vendor row for the
 * casing is how "what did we spend at Adobe this year" stops having an
 * answer. The unique index on lower(name) in schema.sql takes the same view.
 */
export function matchVendor(vendors, typedName) {
  const needle = String(typedName || '').trim().toLowerCase();
  if (!needle) return null;
  return (vendors || []).find(
    (vendor) => String(vendor.name || '').trim().toLowerCase() === needle,
  ) || null;
}

/**
 * The distinct values a column has recently held, in the order given (newest
 * first, as loadExpenses returns them), for a datalist.
 *
 * This is what stops "Client meeting" and "Client Meeting" becoming two
 * different reasons for the same trip. Matched case-insensitively but offered
 * in the casing it was last written in.
 */
export function recentValues(rows, field, { limit = 12 } = {}) {
  const seen = new Set();
  const out = [];

  for (const row of rows || []) {
    const value = String((row && row[field]) || '').trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= limit) break;
  }

  return out;
}

/** The name on an expense: the saved vendor's, or the one-off typed name. */
export function vendorNameOf(row) {
  if (!row) return '';
  return (row.vendor && row.vendor.name) || row.vendor_name || '';
}

/** The receipts on a loaded expense, whichever embed name carried them. */
export function receiptsOf(row) {
  return (row && (row.receipts || row.expense_receipts)) || [];
}

/**
 * The expense list filter. `year` and `month` are compared as text against
 * spent_on; `month` takes 8, '8', '08' or '2026-08' (the last also sets the
 * year). Search reads everything a person might remember about an expense a
 * year later: who, what, where, why, and who with.
 */
export function filterExpenses(expenses, filters = {}) {
  let { year = '', month = '' } = filters;
  const { categoryId = '', clientId = '', vendorId = '', search = '' } = filters;

  const yearMonth = /^(\d{4})-(\d{2})$/.exec(String(month || ''));
  if (yearMonth) { [, year, month] = yearMonth; }

  const wantYear = year ? String(year) : '';
  const wantMonth = month ? pad2(Number(month)) : '';
  const needle = String(search || '').trim().toLowerCase();

  return (expenses || []).filter((row) => {
    const spent = String(row.spent_on || '');
    if (wantYear && spent.slice(0, 4) !== wantYear) return false;
    if (wantMonth && spent.slice(5, 7) !== wantMonth) return false;
    if (categoryId && row.category_id !== categoryId) return false;
    if (clientId && row.client_id !== clientId) return false;
    if (vendorId && row.vendor_id !== vendorId) return false;
    if (!needle) return true;

    const haystack = [
      vendorNameOf(row),
      row.description,
      row.reference,
      row.place,
      row.business_purpose,
      row.attendees,
      row.category && row.category.name,
      row.category && row.category.code,
      row.client && row.client.name,
      row.creator && row.creator.full_name,
    ].filter(Boolean).join(' ').toLowerCase();

    return haystack.includes(needle);
  });
}

/**
 * The expenses row the expense form's values describe.
 *
 * Throws with a sentence for the two things the form cannot save without;
 * formModal shows the message and keeps the dialog open. `vendorRef` is what
 * resolveVendor() answered: a saved vendor's id, or a one-off name for the
 * free-text column.
 */
export function expensePatch(values, vendorRef = {}) {
  const v = values || {};
  if (!v.spent_on) throw new Error('Pick the date it was paid.');
  if (!v.category_id) throw new Error('Pick a category.');

  const amount = parseMoney(v.amount);
  if (amount === null) throw new Error('That amount is not a number.');
  if (amount === 0) throw new Error('An expense of nothing is not an expense.');

  const text = (value) => (String(value || '').trim() || null);

  return {
    spent_on: v.spent_on,
    amount_cents: amount,
    vendor_id: vendorRef.vendor_id || null,
    vendor_name: vendorRef.vendor_id ? null : text(vendorRef.vendor_name),
    category_id: v.category_id,
    description: text(v.description),
    method: v.method || 'card',
    reference: text(v.reference),
    client_id: v.client_id || null,
    // Billable only means something against a client.
    billable: Boolean(v.billable) && Boolean(v.client_id),
    place: text(v.place),
    business_purpose: text(v.business_purpose),
    attendees: text(v.attendees),
  };
}

/** The recurring_expenses row the subscription form's values describe. */
export function recurringPatch(values, vendorRef = {}) {
  const v = values || {};
  const name = String(v.name || '').trim();
  if (!name) throw new Error('Give the subscription a name.');
  if (!v.category_id) throw new Error('Pick a category.');

  const amount = parseMoney(v.amount);
  if (amount === null) throw new Error('That amount is not a number.');
  if (amount === 0) throw new Error('A subscription of nothing is not a subscription.');

  const day = Number(v.day_of_month);
  if (!Number.isInteger(day) || day < 1 || day > 31) {
    throw new Error('The billing day is a number from 1 to 31.');
  }

  const patch = {
    name,
    vendor_id: vendorRef.vendor_id || null,
    vendor_name: vendorRef.vendor_id ? null : (String(vendorRef.vendor_name || '').trim() || null),
    category_id: v.category_id,
    amount_cents: amount,
    method: v.method || 'card',
    day_of_month: day,
    client_id: v.client_id || null,
    billable: Boolean(v.billable) && Boolean(v.client_id),
  };
  if (typeof v.active === 'boolean') patch.active = v.active;
  return patch;
}

// Receipts
// ---------------------------------------------------------------------------

/** What the expense-receipts bucket accepts (schema.sql). The upload's
 *  contentType must be one of these — Storage refuses anything else, and it
 *  refuses application/octet-stream in particular. */
export const RECEIPT_TYPES = [
  'application/pdf', 'image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp',
];

/** The file picker's filter: the types, and the extensions for the browsers
 *  that only understand those. */
export const RECEIPT_ACCEPT = `${RECEIPT_TYPES.join(',')},.pdf,.jpg,.jpeg,.png,.heic,.heif,.webp`;

const MIME_BY_EXTENSION = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  heic: 'image/heic',
  heif: 'image/heif',
  webp: 'image/webp',
};

/**
 * The content type a receipt uploads as, or null for a file the bucket will
 * not take.
 *
 * A phone often hands over a file with an empty `type` — a HEIC from the
 * camera roll, a PDF shared out of Mail — so the extension is the fallback.
 * Never application/octet-stream: the bucket lists what it allows and that
 * is not on the list, so the upload would fail at the end of the transfer
 * rather than before it.
 */
export function receiptMime(file) {
  const declared = String((file && file.type) || '').toLowerCase();
  if (declared === 'image/jpg') return 'image/jpeg';
  if (RECEIPT_TYPES.includes(declared)) return declared;
  const name = String((file && file.name) || '').toLowerCase();
  const extension = name.includes('.') ? name.split('.').pop() : '';
  return MIME_BY_EXTENSION[extension] || null;
}
