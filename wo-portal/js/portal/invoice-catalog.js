// ---------------------------------------------------------------------------
// The standing lists an invoice is assembled from, and the arithmetic behind
// its totals.
//
// The same split as sow-catalog.js and for the same reason: invoice-list.js and
// invoice-editor.js both open a page, so importing either outside a browser
// runs bootstrap(). Everything worth a test lives here instead.
// ---------------------------------------------------------------------------

import { clientSlug } from './sow-catalog.js';
import { formatMoney } from './sow-fees.js';

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
 * 'paid' is not one of them any more, and that is the point rather than an
 * omission. It is now decided by the payments recorded against the invoice: the
 * moment they cover the total the database sets it, and if one is removed it
 * un-sets it. An invoice that could be marked paid without a payment behind it
 * would be an invoice the books know nothing about, which is precisely the gap
 * the ledger exists to close.
 *
 * 'draft' is missing for a different reason — a draft becomes issued by being
 * issued, and going back is what voiding is for.
 */
export const MANUAL_STATUS_OPTIONS = STATUS_OPTIONS.filter(
  (option) => !['draft', 'paid'].includes(option.value),
);

/**
 * The payment an invoice is for.
 *
 * The first three are the scope of work's own fee block, which is what makes
 * "raise the deposit invoice" a single click rather than a retyping exercise.
 * `other` is everything that did not come from a SOW.
 */
export const STAGE_OPTIONS = [
  { value: 'deposit', label: 'Deposit', hint: 'Half the project fee, due on signing' },
  { value: 'balance', label: 'Balance', hint: 'The other half, due at launch' },
  { value: 'full', label: 'Full amount', hint: 'The whole project fee on one invoice' },
  { value: 'other', label: 'Something else', hint: 'Out-of-scope work, a Support Plan, an ad-hoc job' },
];

export function stageLabel(value) {
  const found = STAGE_OPTIONS.find((option) => option.value === value);
  return found ? found.label : 'Something else';
}

export function statusLabel(value) {
  const found = STATUS_OPTIONS.find((option) => option.value === value);
  return found ? found.label : value;
}

/** INV 0001. Four digits rather than the SOW's three: invoices outnumber scopes
 *  of work — a project produces one SOW and at least two invoices. */
export function invoiceLabel(number) {
  return String(number == null ? 0 : number).padStart(4, '0');
}

export function invoiceFilename(invoice, clientName, date) {
  return `NJD-INV-${invoiceLabel(invoice.number)}`
       + `-${clientSlug(clientName)}-${String(date).slice(0, 10)}.pdf`;
}

/** The client name off a list row, whose `clients` embed may not have resolved.
 *  Same fallback as the SOW list, so an orphaned row still lists. */
export function invoiceClientName(row) {
  const client = (row && row.clients) || {};
  return client.name || client.legal_name || 'Unknown client';
}

/**
 * One line's amount.
 *
 * Quantity is a float on purpose — 1.5 hours is a real thing to bill — and the
 * rounding happens once, here, so the number stored is the number printed. A
 * line whose quantity or rate is nonsense contributes zero rather than NaN: a
 * total that reads "$NaN" on a document sent to a client is the failure this
 * whole file exists to avoid.
 */
export function lineAmount({ quantity, unit_cents: unitCents }) {
  const qty = Number(quantity);
  const unit = Number(unitCents);
  if (!Number.isFinite(qty) || !Number.isFinite(unit)) return 0;
  return Math.round(qty * unit);
}

/**
 * What the invoice asks for.
 *
 * There is no discount arithmetic here, and that is the point. Every discount
 * this studio gives is decided by the fee engine when the scope of work is
 * written, and is already baked into the figures the client agreed to. An
 * invoice that could discount again would be a second place for the price to be
 * decided, and the two would drift.
 *
 * `paid` is part payment against this document — the client who sends half of
 * what was asked — not the deposit/balance split, which is two invoices.
 */
export function computeTotals(items = [], paidCents = 0, taxRateBp = 0) {
  const subtotal = items.reduce((sum, item) => sum + lineAmount(item), 0);
  const paid = Math.max(0, Number(paidCents) || 0);

  // Tax is charged on the lines that say they are taxable, not on the invoice.
  // "Build the site, and here is the printing we bought on your behalf" is one
  // document with two answers, and an invoice that could only say yes or no
  // would force it to be two documents or to be wrong.
  const rate = Math.max(0, Number(taxRateBp) || 0);
  const taxable = items
    .filter((item) => item.taxable)
    .reduce((sum, item) => sum + lineAmount(item), 0);
  // Basis points, and the rounding happens once here so the number stored is
  // the number printed and the number posted.
  const tax = rate ? Math.round((taxable * rate) / 10000) : 0;
  const total = subtotal + tax;

  return {
    subtotal,
    taxable,
    taxRateBp: rate,
    tax,
    total,
    paid,
    due: total - paid,
  };
}

/** 825 → "8.25%". Trailing zeros trimmed, because a rate is read aloud. */
export function formatRate(basisPoints) {
  const rate = (Number(basisPoints) || 0) / 100;
  return `${rate.toFixed(2).replace(/\.?0+$/, '')}%`;
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

/**
 * Everything wrong with this invoice, worst first.
 *
 * Same contract as the SOW's validate(): `blocking` stops the issue, anything
 * else is a warning the operator is trusted to overrule. The split matters —
 * an invoice for a scope of work nobody has marked signed yet is very often
 * correct (deposits are billed on the call that agrees the work), so it warns
 * rather than blocks.
 */
export function validate({ invoice, client, items = [], sow = null, billedCents = 0 } = {}) {
  const problems = [];
  const add = (blocking, field, message) => problems.push({ blocking, field, message });

  if (!client) {
    add(true, 'client', 'This invoice has no client on it. An invoice is addressed to somebody.');
  }

  if (!items.length) {
    add(true, 'items', 'An invoice with no lines is not one. Add at least one.');
  }

  const zeroLines = items.filter((item) => lineAmount(item) === 0);
  if (items.length && zeroLines.length === items.length) {
    add(true, 'items', 'Every line on this invoice is zero. Nothing is being asked for.');
  } else if (zeroLines.length) {
    add(false, 'items', `${zeroLines.length} line${zeroLines.length === 1 ? ' adds' : 's add'} `
      + 'nothing to the total. Remove them, or say what they are for.');
  }

  const negative = items.filter((item) => lineAmount(item) < 0);
  if (negative.length) {
    add(false, 'items', 'A negative line reads as a credit note. If that is what '
      + 'this is, say so in the summary — otherwise it looks like a typo.');
  }

  if (!invoice || !invoice.issued_on) {
    add(true, 'issued_on', 'An invoice needs a date. It is what the payment terms count from.');
  }

  if (invoice && invoice.issued_on && invoice.due_on && invoice.due_on < invoice.issued_on) {
    add(true, 'due_on', 'This is due before it is dated. One of the two dates is wrong.');
  }

  if (invoice && items.some((item) => item.taxable) && !Number(invoice.tax_rate_bp)) {
    add(false, 'tax', 'A line is marked taxable but the tax rate is zero, so nothing '
      + 'is being charged. Set the rate in Payment terms, or untick the line.');
  }

  if (invoice && Number(invoice.tax_rate_bp) && !items.some((item) => item.taxable)) {
    add(false, 'tax', 'This invoice has a tax rate but no taxable lines, so it charges '
      + 'no tax. That is right for pure service work — tick a line if it is not.');
  }

  if (invoice && !invoice.due_on) {
    add(false, 'due_on', 'No due date, so the document will fall back to the '
      + 'standing terms. Setting one is clearer.');
  }

  // Billing against a scope of work: the two questions worth asking before the
  // document goes out, neither of which is a hard stop.
  if (sow) {
    if (sow.status !== 'signed') {
      add(false, 'sow', `${sow.label || 'That scope of work'} is marked `
        + `“${statusLabel(sow.status)}”, not signed. Billing a deposit before the `
        + 'paperwork comes back is normal — billing a balance is worth a second look.');
    }

    const totals = computeTotals(items, invoice ? invoice.paid_cents : 0);
    const wouldBill = billedCents + totals.total;

    if (sow.adjusted_fee_cents && wouldBill > sow.adjusted_fee_cents) {
      const over = wouldBill - sow.adjusted_fee_cents;
      add(false, 'items', `This takes the total billed against `
        + `${sow.label || 'that scope of work'} to ${formatMoney(wouldBill)}, which is `
        + `${formatMoney(over)} more than the ${formatMoney(sow.adjusted_fee_cents)} `
        + 'agreed. That is right for out-of-scope work and wrong for everything '
        + 'else — make sure the lines say which this is.');
    }
  }

  return problems.sort((a, b) => Number(b.blocking) - Number(a.blocking));
}

export function blockers(problems) {
  return (problems || []).filter((problem) => problem.blocking);
}

/** The list view's search and status filter, same shape as filterSows(). */
export function filterInvoices(invoices, { search = '', status = '' } = {}) {
  const needle = String(search).trim().toLowerCase();

  return (invoices || []).filter((row) => {
    if (status && row.status !== status) return false;
    if (!needle) return true;

    const haystack = [
      invoiceClientName(row),
      row.project_name,
      row.sow_label,
      `inv ${invoiceLabel(row.number)}`,
      String(row.number),
    ].filter(Boolean).join(' ').toLowerCase();

    return haystack.includes(needle);
  });
}

/**
 * Is this invoice overdue, and by how much?
 *
 * `today` is passed in rather than read off the clock so a test can ask about a
 * Tuesday. Paid and void invoices are never overdue — money that has arrived,
 * or was never owed, is not late.
 */
export function overdueDays(invoice, today) {
  if (!invoice || !invoice.due_on) return 0;
  if (['paid', 'void', 'draft'].includes(invoice.status)) return 0;

  const due = Date.parse(`${String(invoice.due_on).slice(0, 10)}T00:00:00`);
  const now = Date.parse(`${String(today).slice(0, 10)}T00:00:00`);
  if (Number.isNaN(due) || Number.isNaN(now)) return 0;

  const days = Math.floor((now - due) / 86400000);
  return days > 0 ? days : 0;
}
