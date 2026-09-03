// ---------------------------------------------------------------------------
// Rendering an invoice to paper
//
// No PDF library: the browser already has one behind window.print(), and
// printing a purpose-built container keeps the type crisp instead of
// flattening the page into a picture of itself. The container is
// display:none on screen and only exists inside @media print (css/print.css),
// so building it shifts nothing.
//
// It renders a snapshot from invoice-doc.js and nothing else. It never reads
// the form and never decides what the document says: if a section is absent
// from the snapshot it is absent from the paper, heading and all.
//
// The one thing rendered from outside the snapshot is what has been paid.
// The snapshot is frozen the day the invoice is issued; the money arrives
// afterwards. So "Paid" and "Balance due" are passed in from the row at print
// time, and a re-print after a part payment shows the client what is left.
// ---------------------------------------------------------------------------

import { el } from './ui.js';
import { openPrintDialog } from './print-dialog.js';
import { formatMoney, formatRate, centsOf } from './money.js';
import { longDate, lines } from './doc-common.js';

const PRINT_ID = 'invoice-print';

const MARK_SRC = '/assets/img/wo-mark-orange.png';

function section(title, children, className) {
  const kept = (children || []).filter(Boolean);
  if (!kept.length) return null;
  return el('section', {
    class: className ? `print-section doc-section ${className}` : 'print-section doc-section',
  }, [
    el('h2', { class: 'doc-section__title', text: title }),
    ...kept,
  ]);
}

function para(value, className = 'doc-p') {
  return value ? el('p', { class: className, text: value }) : null;
}

/** The letterhead: the mark, the business name, the entity line, the address
 *  and the ways to reach it — all from studio_settings via the snapshot. */
function letterhead(from) {
  const party = from || {};
  const reach = [party.phone, party.email, party.website].filter(Boolean).join(' · ');

  return el('header', { class: 'print-head' }, [
    el('img', { class: 'print-head__mark', src: MARK_SRC, alt: '', width: '44', height: '44' }),
    el('div', { class: 'print-head__names' }, [
      el('p', { class: 'print-head__wordmark', text: party.name || 'Walter Ochenski LLC' }),
      party.entityLine ? el('p', { class: 'print-head__line', text: party.entityLine }) : null,
      ...(party.address || []).map((line) => el('p', { class: 'print-head__line', text: line })),
      reach ? el('p', { class: 'print-head__line', text: reach }) : null,
    ]),
    el('p', { class: 'doc-head__ref', text: 'Invoice' }),
  ]);
}

function partyBlock(label, party) {
  if (!party) return null;

  return el('div', { class: 'doc-party' }, [
    el('p', { class: 'doc-party__role', text: label }),
    el('p', { class: 'doc-party__name', text: party.name }),
    ...(party.address || []).map((line) => el('p', { class: 'doc-party__meta', text: line })),
    party.contactName ? el('p', { class: 'doc-party__meta', text: `Attn: ${party.contactName}` }) : null,
    party.contactEmail ? el('p', { class: 'doc-party__meta', text: party.contactEmail }) : null,
    party.contactPhone ? el('p', { class: 'doc-party__meta', text: party.contactPhone }) : null,
  ]);
}

/**
 * The quantity column, printed only when it says something. A flat fee is one
 * line and "1 × $1,950.00" next to $1,950.00 is noise; six hours at $95 is a
 * calculation the client is entitled to check.
 */
function working(row) {
  const qty = Number(row.quantity);
  if (!Number.isFinite(qty) || qty === 1) return '';
  return `${qty} × ${formatMoney(row.unit_cents)}`;
}

function totalRow(label, value, className, note) {
  return el('tr', { class: className }, [
    el('td', {}, [
      el('span', { class: 'doc-cell__name', text: label }),
      note ? el('span', { class: 'doc-cell__desc', text: note }) : null,
    ]),
    el('td', {}),
    el('td', { class: 'doc-table__num', text: value }),
  ]);
}

/**
 * The lines, and the totals under them. The totals are rows of the same table
 * rather than a block beside it, so the amount column stays one column all
 * the way down: a total that does not line up with the numbers it totals is
 * the sort of thing that makes somebody re-add the column by hand.
 */
function linesTable(snapshot, paidCents) {
  const body = snapshot.lines.map((row) => el('tr', {}, [
    el('td', {}, [
      el('span', { class: 'doc-cell__name', text: row.name }),
      row.description ? el('span', { class: 'doc-cell__desc', text: row.description }) : null,
    ]),
    el('td', { class: 'doc-table__mid', text: working(row) }),
    el('td', { class: 'doc-table__num', text: formatMoney(row.amount_cents) }),
  ]));

  const tax = snapshot.tax || {};
  const taxed = centsOf(tax.cents) > 0;
  const paid = centsOf(paidCents);

  // A single-line invoice's subtotal and total are the same number twice,
  // which reads as a mistake rather than as arithmetic.
  if (snapshot.lines.length > 1 || taxed) {
    body.push(totalRow('Subtotal', formatMoney(snapshot.subtotal_cents), 'doc-tr--total'));
  }

  // The tax row prints only where tax is actually charged. An invoice for
  // exempt service work should say nothing about sales tax at all rather
  // than print a confident "$0.00" beside it.
  if (taxed) {
    body.push(totalRow(
      `${tax.label || 'Sales tax'} at ${formatRate(tax.rate_bp)}`,
      formatMoney(tax.cents),
      'doc-tr--total',
      tax.registration ? `Permit ${tax.registration}` : null,
    ));
  }

  if (paid > 0) {
    body.push(totalRow('Total', formatMoney(snapshot.total_cents), 'doc-tr--total'));
    body.push(totalRow('Paid', `− ${formatMoney(paid)}`, 'doc-tr--muted', 'Thank you.'));
    body.push(totalRow('Balance due', formatMoney(snapshot.total_cents - paid), 'inv-row--due'));
  } else {
    body.push(totalRow('Total due', formatMoney(snapshot.total_cents), 'inv-row--due'));
  }

  return el('table', { class: 'doc-table inv-table' }, [
    el('thead', {}, [
      el('tr', {}, [
        el('th', { scope: 'col', text: 'Description' }),
        el('th', { scope: 'col', text: 'Qty × rate' }),
        el('th', { scope: 'col', class: 'doc-table__num', text: 'Amount' }),
      ]),
    ]),
    el('tbody', {}, body),
  ]);
}

function fact(label, value, className) {
  if (!value) return null;
  return el('div', { class: 'print-fact' }, [
    el('dt', { text: label }),
    el('dd', { class: className || null, text: value }),
  ]);
}

/**
 * The whole document, from a snapshot and nothing else — plus what has been
 * paid, which is the one fact that keeps moving after the snapshot is frozen.
 */
export function buildDocument(snapshot, { paidCents = 0 } = {}) {
  const paid = Math.max(0, centsOf(paidCents));
  const due = Math.max(0, centsOf(snapshot.total_cents) - paid);
  const terms = Number.isFinite(Number(snapshot.net_days)) && snapshot.net_days !== null
    ? `Net ${snapshot.net_days}`
    : null;
  const from = snapshot.from || {};

  return el('div', { class: 'print-doc doc-page inv-doc', id: PRINT_ID }, [
    letterhead(from),

    el('h1', { class: 'print-title doc-title', text: snapshot.label }),
    snapshot.project_name ? el('p', { class: 'doc-subtitle', text: snapshot.project_name }) : null,

    // Everything the eye goes to first, as a fact list. The amount due is here
    // as well as at the foot of the table on purpose: an invoice whose total is
    // only reachable by reading to the end is an invoice that gets paid late.
    el('dl', { class: 'print-facts doc-facts' }, [
      fact('Issued', longDate(snapshot.issued_on)),
      fact('Due', longDate(snapshot.due_on)),
      fact('Terms', terms),
      fact('Purchase order', snapshot.purchase_order),
      fact(paid > 0 ? 'Balance due' : 'Amount due', formatMoney(due), 'inv-fact__due'),
    ]),

    el('div', { class: 'doc-parties' }, [
      partyBlock('Billed to', snapshot.billed_to),
    ]),

    snapshot.summary ? section('Summary', [para(snapshot.summary)]) : null,

    section('Charges', [linesTable(snapshot, paid)]),

    // Kept whole across a page break (css/print.css): the terms and the
    // account details are one instruction, and half of it at the foot of page
    // one with the rest overleaf is how a client pays the wrong way or not
    // at all.
    section('How to pay', [
      snapshot.payment_details
        ? el('div', { class: 'inv-pay' }, lines(snapshot.payment_details).map((line) => (
          el('p', { class: 'inv-pay__line', text: line })
        )))
        : null,
      para(snapshot.late_note, 'doc-note'),
    ], 'inv-section--pay'),

    snapshot.notes
      ? section('Notes', [
        el('ul', { class: 'doc-bullets' }, lines(snapshot.notes).map((line) => el('li', { text: line }))),
      ])
      : null,

    // The running footer proper is a @page margin box (css/print.css). This
    // closing line is what an engine without margin-box support is left
    // holding, so the party name and the reference are on the paper either way.
    el('div', { class: 'doc-end' }, [
      el('p', { text: from.name || 'Walter Ochenski LLC' }),
      el('p', { text: snapshot.label }),
      snapshot.issued_on ? el('p', { text: `Issued ${longDate(snapshot.issued_on)}` }) : null,
    ]),
  ]);
}

/**
 * Build the document and open the print dialog.
 *
 * `filename` becomes the document title for the duration of the dialog,
 * because that is what every browser offers as the default name in Save as
 * PDF; print-dialog.js puts it back afterwards, and sets the running footer's
 * text for the @page margin box.
 */
export async function printSnapshot(snapshot, filename, { paidCents = 0 } = {}) {
  const container = buildDocument(snapshot, { paidCents });
  const from = snapshot.from || {};
  await openPrintDialog({
    container,
    filename,
    footer: `${from.name || 'Walter Ochenski LLC'} · ${snapshot.label}`,
  });
}
