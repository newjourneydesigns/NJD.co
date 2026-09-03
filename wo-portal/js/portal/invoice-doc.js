// ---------------------------------------------------------------------------
// Invoice assembly
//
// Turns an invoice and its lines into the document, as data — the exact
// object the PDF is rendered from and the exact object stored on
// invoices.snapshot when it is issued. No DOM, no network, no clock.
//
// Every value is resolved here: a section with nothing to say comes back
// null and the renderer skips it whole, and the canonical JSON of this object
// is what gets hashed. The same inputs must always produce the same bytes,
// which is why nothing in here reads Date.now() and why the tests compare
// canonical(assemble(x)) against itself.
//
// An invoice is a demand for a specific number that has already been agreed,
// so nothing here computes a price beyond quantity × rate and the tax on the
// taxable lines. It reads the figures it was handed, states them, and says
// how to pay.
//
// The snapshot is status-free on purpose. Status, paid_cents and paid_at
// keep moving after the document is frozen — money arrives, the invoice is
// marked sent — and the document a client is holding does not change when
// they do. What has been paid is rendered beside the frozen document at
// print time, from the row, never baked into the snapshot.
// ---------------------------------------------------------------------------

import { clientParty, studioParty, text } from './doc-common.js';
import { centsOf, computeTotals } from './money.js';
import { invoiceLabel, itemAmount } from './invoice-catalog.js';

export { canonical, digest } from './doc-common.js';

/** Bumped when the shape of the snapshot changes, so a snapshot stored by an
 *  older release stays readable rather than being silently misparsed. */
export const SNAPSHOT_VERSION = 1;

function isoDate(value) {
  const trimmed = text(value);
  return trimmed ? trimmed.slice(0, 10) : null;
}

function wholeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : null;
}

/** One line as the document states it. The amount is quantity × rate rounded
 *  once — the same arithmetic the editor saves and the database checks. */
function line(item) {
  const qty = Number(item.quantity);
  return {
    name: text(item.name) || 'Item',
    description: text(item.description),
    quantity: Number.isFinite(qty) ? qty : 0,
    unit_cents: centsOf(item.unit_cents),
    amount_cents: itemAmount(item),
    taxable: Boolean(item.taxable),
  };
}

/**
 * Assemble the document.
 *
 *   invoice   the invoices row (number, dates, net_days, project_name,
 *             purchase_order, summary, notes, tax_rate_bp)
 *   items     the invoice_items rows, in order
 *   client    the clients row the invoice is billed to
 *   studio    the studio_settings row — the letterhead
 *   settings  the invoice_settings row — how to pay, the late note, what the
 *             tax is called and under which permit
 */
export function assemble({
  invoice,
  items = [],
  client = null,
  studio = null,
  settings = null,
} = {}) {
  const inv = invoice || {};
  const cfg = settings || {};

  const lines = (items || []).map(line);
  const rateBp = Math.max(0, centsOf(inv.tax_rate_bp));
  const totals = computeTotals(lines, rateBp);

  return {
    kind: 'invoice',
    version: SNAPSHOT_VERSION,

    number: text(inv.number),
    label: invoiceLabel(inv.number),
    issued_on: isoDate(inv.issued_on),
    due_on: isoDate(inv.due_on),
    net_days: wholeNumber(inv.net_days),

    from: studioParty(studio),
    billed_to: clientParty(client),

    project_name: text(inv.project_name),
    purchase_order: text(inv.purchase_order),
    summary: text(inv.summary),

    lines,

    subtotal_cents: totals.subtotal_cents,
    // The tax block is always present so the shape is stable; the renderer
    // prints the tax row only when cents > 0. A taxing authority expects an
    // invoice that charges tax to say under what permit, so the registration
    // is carried only when tax is actually on the document.
    tax: {
      label: text(cfg.tax_label) || 'Sales tax',
      rate_bp: rateBp,
      cents: totals.tax_cents,
      registration: totals.tax_cents > 0 ? text(cfg.tax_registration) : null,
    },
    total_cents: totals.total_cents,

    payment_details: text(cfg.payment_details),
    late_note: text(cfg.late_note),
    notes: text(inv.notes),
  };
}
