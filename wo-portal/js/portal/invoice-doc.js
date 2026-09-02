// ---------------------------------------------------------------------------
// Invoice assembly
//
// Turns an invoice and its lines into the document, as data — the exact object
// the PDF is rendered from and the exact object stored on `invoices.snapshot`
// when it is issued. No DOM, no network, no clock.
//
// This is sow-doc.js's sibling and deliberately works the same way: every
// sentence is resolved here, a section with nothing to say comes back null and
// the renderer skips it whole, and the canonical JSON is what gets hashed. The
// argument for doing it this way is written out in full above assemble() in
// that file and in the README; it applies here unchanged.
//
// What is different is what the document is *for*. A scope of work is an offer
// and a signature block. An invoice is a demand for a specific number, and the
// number has already been agreed — so nothing in this file computes a price.
// It reads the figures it was handed, states them, and says how to pay.
// ---------------------------------------------------------------------------

import { canonical, clientParty, longDate } from './sow-doc.js';
import { formatMoney } from './sow-fees.js';
import {
  computeTotals, formatRate, invoiceLabel, lineAmount, stageLabel,
} from './invoice-catalog.js';

export { canonical, digest } from './sow-doc.js';

const DEFAULT_TERMS = 'Payment is due within 14 days of the invoice date.';

function text(value) {
  const trimmed = String(value === null || value === undefined ? '' : value).trim();
  return trimmed || null;
}

function lines(value) {
  const body = text(value);
  if (!body) return [];
  return body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

/** The studio, as the party being paid. Same source as the scope of work's
 *  party block — sow_settings — because it is the same business, and a second
 *  copy of the name is a second thing to change on the day it becomes an LLC. */
function studioParty(settings) {
  const config = settings || {};
  return {
    name: text(config.party_name) || 'Walter Ochenski d/b/a New Journey Designs',
    entityType: text(config.party_entity),
    address: lines(config.party_address),
  };
}

/**
 * The quantity column, printed only when it says something.
 *
 * A deposit is one line of a flat figure and "1 × $1,950.00" next to $1,950.00
 * is noise. Six hours at $95 is a calculation the client is entitled to check.
 * So the rule is: show the working when there is working to show.
 */
function lineDetail(item) {
  const qty = Number(item.quantity);
  if (!Number.isFinite(qty) || qty === 1) return null;
  const shown = Number.isInteger(qty) ? String(qty) : String(qty);
  return `${shown} × ${formatMoney(item.unit_cents)}`;
}

/**
 * How to pay, as the document says it.
 *
 * Absent rather than empty when the studio has not filled the details in: a
 * heading reading "How to pay" over nothing is worse than no heading, because
 * it looks like the details failed to load.
 */
function paymentBlock(terms, totals, invoice) {
  const config = terms || {};
  const detail = lines(config.payment_details);

  // The standing terms, and nothing that repeats the header. The due date is
  // already in the fact list at the top of the document, in bold, next to the
  // amount — saying it a second time three inches lower adds a line and no
  // information. Where there is no due date the terms sentence is the only
  // thing that answers "by when", which is exactly when it earns its place.
  const paragraphs = [text(config.payment_terms) || DEFAULT_TERMS];

  if (totals.paid > 0) {
    paragraphs.push(
      `${formatMoney(totals.paid)} has already been received against this `
      + `invoice, leaving ${formatMoney(totals.due)} outstanding.`,
    );
  }

  const late = text(config.late_note);
  if (late) paragraphs.push(late);

  return {
    paragraphs,
    details: detail,
    heading: 'How to pay',
  };
}

/**
 * Assemble the document.
 *
 * `today` is passed in rather than read off the clock, for the reason spelled
 * out in sow-doc.js: a function that reads Date.now() internally cannot be
 * tested for determinism.
 *
 * `sowRef` is what the invoice says about the scope of work behind it, copied
 * onto the invoice row when it was raised rather than looked up here — the
 * document has to keep naming the right scope after that SOW is superseded.
 */
export function assemble({
  invoice,
  client,
  items = [],
  settings = null,
  terms = null,
  today = null,
}) {
  const studio = studioParty(settings);
  const party = clientParty(client);
  const totals = computeTotals(items, invoice.paid_cents, invoice.tax_rate_bp);

  // A taxing authority expects an invoice that charges tax to say who is
  // charging it under what permit. Printed only when tax is actually on the
  // document, for the same reason the tax row is.
  const taxRegistration = totals.tax && terms && text(terms.tax_registration)
    ? `Sales tax permit ${text(terms.tax_registration)}`
    : null;

  const rows = items
    .map((item) => ({
      name: text(item.name) || 'Item',
      description: text(item.description),
      detail: lineDetail(item),
      amount: formatMoney(lineAmount(item)),
      amountCents: lineAmount(item),
    }));

  const label = `INV ${invoiceLabel(invoice.number)}`;

  return {
    // Bumped when the shape of this object changes, so a snapshot stored by an
    // older release stays readable rather than being silently misparsed.
    schema: 1,

    label,
    number: invoice.number,
    stage: invoice.stage,
    title: text(invoice.project_name) || 'Invoice',
    preparedOn: today ? longDate(today) : null,

    studio,
    client: party,

    // Everything the eye goes to first, as a fact list. The amount due is here
    // as well as at the foot of the table on purpose: an invoice whose total is
    // only reachable by reading to the end is an invoice that gets paid late.
    //
    // The reference and the client are deliberately not repeated here. Both are
    // already on the document a couple of inches above — the reference in the
    // letterhead and again in the running footer, the client in the "Billed to"
    // block this list sits directly under. Restating them costs a whole row of
    // the grid at print width, which is the difference between a one-page
    // invoice and a second sheet carrying a footer.
    header: [
      ['Date', longDate(invoice.issued_on)],
      ['Due', longDate(invoice.due_on)],
      ['Project', text(invoice.project_name)],
      // Named rather than linked: the client's copy of the scope of work is a
      // PDF in their inbox, and a reference they can match against it is the
      // useful thing.
      ['Scope of work', text(invoice.sow_label)],
      ['Purchase order', text(invoice.purchase_order)],
      ['Amount due', formatMoney(totals.due)],
      ['Sales tax permit', taxRegistration ? taxRegistration.replace('Sales tax permit ', '') : null],
    ].filter(([, value]) => Boolean(value)),

    summary: text(invoice.summary),

    // The sentence that ties this document to the one that authorised it. Absent
    // when there is no SOW behind the invoice, which is a real case — an hour of
    // out-of-scope work is billed without one.
    authority: text(invoice.sow_label)
      ? `This invoice bills work agreed under ${text(invoice.sow_label)}`
        + (text(invoice.project_name) ? `, ${text(invoice.project_name)}` : '')
        + `. It asks only for what that document set out — ${stageLabel(invoice.stage).toLowerCase()}.`
      : null,

    lines: rows,

    totals: {
      subtotal: formatMoney(totals.subtotal),
      subtotalCents: totals.subtotal,
      // The tax row prints only where tax is actually charged. An invoice for
      // exempt service work should say nothing about sales tax at all rather
      // than print a confident "$0.00" beside it.
      tax: totals.tax ? formatMoney(totals.tax) : null,
      taxCents: totals.tax,
      taxLabel: totals.tax
        ? `${text(terms && terms.tax_label) || 'Sales tax'} at `
          + `${formatRate(totals.taxRateBp)}`
        : null,
      taxableCents: totals.taxable,
      total: formatMoney(totals.total),
      totalCents: totals.total,
      paid: totals.paid > 0 ? formatMoney(totals.paid) : null,
      paidCents: totals.paid,
      due: formatMoney(totals.due),
      dueCents: totals.due,
      // A single-line invoice's subtotal and total are the same number twice,
      // which reads as a mistake rather than as arithmetic.
      showSubtotal: rows.length > 1 || totals.paid > 0 || totals.tax > 0,
    },

    payment: paymentBlock(terms, totals, invoice),

    notes: lines(invoice.notes).length
      ? { lines: lines(invoice.notes), heading: 'Notes' }
      : null,

    footer: studio.name,
  };
}
