// ---------------------------------------------------------------------------
// The standing lists an invoice is assembled from, and the checks before one
// goes out.
//
// invoice-list.js and invoice-editor.js both open a page, so importing either
// outside a browser runs bootstrap(). Everything worth a test lives here
// instead: no DOM, no network, no clock. node --test holds it to account
// through tools/portal/invoice-doc.test.mjs.
// ---------------------------------------------------------------------------

import { clientSlug } from './doc-common.js';
import { centsOf, computeTotals, formatRate, lineAmount } from './money.js';

// The arithmetic is money.js's; re-exported so the two invoice screens and
// the document assembler read it from one place.
export { computeTotals, formatRate } from './money.js';

// Statuses
// ---------------------------------------------------------------------------

export const STATUS_OPTIONS = [
  { value: 'draft', label: 'Draft' },
  { value: 'issued', label: 'Issued' },
  { value: 'sent', label: 'Sent' },
  { value: 'paid', label: 'Paid' },
  { value: 'void', label: 'Void' },
];

/**
 * The statuses a person sets by hand.
 *
 * 'paid' is not one of them, and that is the point rather than an omission.
 * It is decided by the payments recorded against the invoice: the moment they
 * cover the total the database sets it, and if one is removed it un-sets it.
 * An invoice that could be marked paid without a payment behind it would be
 * income the tax-year report knows nothing about.
 *
 * 'draft' is missing for a different reason — a draft becomes issued by being
 * issued, and going back is what voiding is for. 'issued' is what issuing
 * does. That leaves the two that are observations rather than arithmetic:
 * the invoice was handed over, or the invoice was cancelled.
 */
export const MANUAL_STATUS_OPTIONS = STATUS_OPTIONS.filter(
  (option) => ['sent', 'void'].includes(option.value),
);

export function statusLabel(value) {
  const found = STATUS_OPTIONS.find((option) => option.value === value);
  return found ? found.label : String(value || '');
}

/** The pill colour for a status: the same vocabulary portal.css's .pill--*
 *  modifiers speak. Blank means the plain grey pill. */
export function statusTone(value) {
  return {
    draft: '',
    issued: 'blue',
    sent: 'amber',
    paid: 'green',
    void: 'red',
  }[value] || '';
}

// How money moves
// ---------------------------------------------------------------------------

/** The payment_method enum, in the order the owner reaches for them. */
export const PAYMENT_METHODS = [
  { value: 'ach', label: 'ACH / bank transfer' },
  { value: 'check', label: 'Check' },
  { value: 'zelle', label: 'Zelle' },
  { value: 'card', label: 'Card' },
  { value: 'cash', label: 'Cash' },
  { value: 'other', label: 'Other' },
];

export function methodLabel(value) {
  const found = PAYMENT_METHODS.find((option) => option.value === value);
  return found ? found.label : String(value || '');
}

// What the business sells
// ---------------------------------------------------------------------------

/** The services the owner listed, offered as suggestions on a line's name so
 *  the same work is not spelled four ways across a year of invoices. Never
 *  enforced — a line can say anything. */
export const LINE_PRESETS = [
  'Marketing consulting',
  'Business consulting',
  'Business system architecture & delivery',
  'App design',
  'Graphic design',
  'Video design',
  'Print work',
  'Website creation',
];

// Numbers, labels, filenames
// ---------------------------------------------------------------------------

/** YYYYMMDD-N: the day the invoice was raised and that day's sequence. The
 *  same shape the database's invoices_number_shape constraint insists on. */
export const NUMBER_RE = /^[0-9]{8}-[0-9]+$/;

export function isValidNumber(number) {
  return NUMBER_RE.test(String(number == null ? '' : number).trim());
}

/** What people call it: "Invoice 20260901-1". */
export function invoiceLabel(number) {
  const shown = String(number == null ? '' : number).trim();
  return `Invoice ${shown || '—'}`;
}

/** WO-INV-20260901-1-acme-roofing-llc.pdf — the number already carries the
 *  date, so the filename does not repeat it. */
export function invoiceFilename(invoice, clientName) {
  const number = String((invoice && invoice.number) || '').trim() || 'draft';
  return `WO-INV-${number}-${clientSlug(clientName)}.pdf`;
}

/** The client name off a list row, whose embed may not have resolved. The
 *  embed is aliased `client` by invoice-data.js; `clients` is tolerated so a
 *  row shaped by somebody else's loader still lists. */
export function invoiceClientName(row) {
  const client = (row && (row.client || row.clients)) || {};
  return client.name || client.legal_name || 'Unknown client';
}

// Lines and totals
// ---------------------------------------------------------------------------

/** One line's amount: quantity × unit price, rounded once. A line whose
 *  quantity or rate is nonsense contributes zero rather than NaN, because a
 *  total that reads "$NaN" on a document sent to a client is the failure this
 *  whole file exists to avoid — money.js's lineAmount already promises that. */
export function itemAmount(item) {
  if (!item) return 0;
  return lineAmount(item.quantity, item.unit_cents);
}

/** The lines with their amount_cents worked out from quantity × rate, so the
 *  number stored is the number printed and the number the database checks. */
export function withAmounts(items) {
  return (items || []).map((item) => ({ ...item, amount_cents: itemAmount(item) }));
}

/** Subtotal, tax and total for the lines as they stand. Tax is rounded once,
 *  on the taxable subtotal — see computeTotals in money.js. */
export function invoiceTotals(items, taxRateBp) {
  return computeTotals(withAmounts(items), taxRateBp);
}

/** "8.25" or "8.25%" → 825. Null for anything that is not a number, so a typo
 *  is not read as "no tax". */
export function parseRate(input) {
  if (input === null || input === undefined) return null;
  const cleaned = String(input).replace(/[%\s]/g, '');
  if (cleaned === '') return null;
  if (!/^\d*\.?\d*$/.test(cleaned)) return null;
  const rate = Number(cleaned);
  if (!Number.isFinite(rate)) return null;
  return Math.round(rate * 100);
}

// The checks before issuing
// ---------------------------------------------------------------------------

function present(value) {
  return String(value === null || value === undefined ? '' : value).trim() !== '';
}

/**
 * Everything wrong with this invoice, worst first.
 *
 * `blocking` stops the issue; anything else is a warning the owner is trusted
 * to overrule. The database repeats the one check that matters most — the
 * lines and the tax have to add up to the total — so a stale browser cannot
 * freeze a document that disagrees with its own record.
 */
export function validate(invoice, items = [], client = null) {
  const problems = [];
  const add = (blocking, field, message) => problems.push({ blocking, field, message });
  const lines = items || [];

  if (!client) {
    add(true, 'client', 'This invoice has no client on it. An invoice is addressed to somebody.');
  }

  if (!lines.length) {
    add(true, 'items', 'An invoice with no lines is not one. Add at least one.');
  }

  const unnamed = lines.filter((item) => !present(item.name));
  if (unnamed.length) {
    add(true, 'items', `${unnamed.length} line${unnamed.length === 1 ? ' has' : 's have'} `
      + 'no name. Say what each one is for — it is what the client reads.');
  }

  if (!invoice || !isValidNumber(invoice.number)) {
    add(true, 'number', 'The number has to look like 20260901-1: the date it was '
      + 'raised, a dash, and that day\'s sequence.');
  }

  if (!invoice || !present(invoice.issued_on)) {
    add(true, 'issued_on', 'An invoice needs a date. It is what the payment terms count from.');
  }

  if (invoice && present(invoice.issued_on) && present(invoice.due_on)
      && String(invoice.due_on) < String(invoice.issued_on)) {
    add(true, 'due_on', 'This is due before it is dated. One of the two dates is wrong.');
  }

  const totals = invoiceTotals(lines, invoice ? invoice.tax_rate_bp : 0);
  const stored = invoice ? Number(invoice.total_cents) : NaN;
  if (Number.isFinite(stored) && centsOf(stored) !== totals.total_cents) {
    add(true, 'total', 'The saved total does not match the lines and the tax. '
      + 'Wait for the save to finish, or reload the page.');
  }

  const zeroLines = lines.filter((item) => itemAmount(item) === 0);
  if (lines.length && zeroLines.length === lines.length) {
    add(true, 'items', 'Every line on this invoice is zero. Nothing is being asked for.');
  } else if (zeroLines.length) {
    add(false, 'items', `${zeroLines.length} line${zeroLines.length === 1 ? ' adds' : 's add'} `
      + 'nothing to the total. Remove them, or say what they are for.');
  }

  if (lines.some((item) => itemAmount(item) < 0)) {
    add(false, 'items', 'A negative line reads as a credit. If that is what this is, '
      + 'say so in the summary — otherwise it looks like a typo.');
  }

  if (invoice && lines.some((item) => item.taxable) && !centsOf(invoice.tax_rate_bp)) {
    add(false, 'tax', 'A line is marked taxable but the tax rate is zero, so nothing '
      + 'is being charged. Set a rate on this invoice, or untick the line.');
  }

  if (invoice && centsOf(invoice.tax_rate_bp) && !lines.some((item) => item.taxable)) {
    add(false, 'tax', 'This invoice has a tax rate but no taxable lines, so it charges '
      + 'no tax. That is right for pure service work — tick a line if it is not.');
  }

  if (invoice && !present(invoice.due_on)) {
    add(false, 'due_on', 'No due date, so the document cannot say when to pay by. '
      + 'Setting one is clearer.');
  }

  return problems.sort((a, b) => Number(b.blocking) - Number(a.blocking));
}

export function blockers(problems) {
  return (problems || []).filter((problem) => problem.blocking);
}

// The list
// ---------------------------------------------------------------------------

/** The list view's filters: a status, a client, and a search over the number,
 *  the client and the project. Pure, so the same rule serves the page and the
 *  loader's `search` argument. */
export function filterInvoices(invoices, { search = '', status = '', clientId = '' } = {}) {
  const needle = String(search || '').trim().toLowerCase();

  return (invoices || []).filter((row) => {
    if (status && row.status !== status) return false;
    if (clientId && row.client_id !== clientId) return false;
    if (!needle) return true;

    const haystack = [
      invoiceClientName(row),
      row.project_name,
      row.purchase_order,
      invoiceLabel(row.number),
      String(row.number || ''),
    ].filter(Boolean).join(' ').toLowerCase();

    return haystack.includes(needle);
  });
}

/** What is still owed on a row: nothing for a draft, a void or a paid one. */
export function outstandingCents(row) {
  if (!row || !['issued', 'sent'].includes(row.status)) return 0;
  return centsOf(row.total_cents) - centsOf(row.paid_cents);
}

/**
 * Is this invoice overdue, and by how many whole days?
 *
 * `today` is passed in rather than read off the clock so a test can ask about
 * a Tuesday. Only an issued or sent invoice can be late: a draft has been
 * handed to nobody, and money that has arrived, or was never owed, is not
 * late.
 */
export function overdueDays(invoice, today) {
  if (!invoice || !invoice.due_on) return 0;
  if (!['issued', 'sent'].includes(invoice.status)) return 0;

  const due = Date.parse(`${String(invoice.due_on).slice(0, 10)}T00:00:00Z`);
  const now = Date.parse(`${String(today).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(due) || Number.isNaN(now)) return 0;

  const days = Math.floor((now - due) / 86400000);
  return days > 0 ? days : 0;
}
