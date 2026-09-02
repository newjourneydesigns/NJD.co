// ---------------------------------------------------------------------------
// Rendering an invoice to paper
//
// The same approach as the scope of work next door — no PDF library, because
// the browser already has one behind window.print(), and printing a
// purpose-built container keeps the type crisp instead of flattening the page
// into a picture of itself. The container is display:none on screen and only
// exists inside @media print, so building it shifts nothing.
//
// It renders a snapshot from invoice-doc.js and nothing else. It never reads
// the form and never decides what the document says: if a section is absent
// from the snapshot it is absent from the paper, heading and all.
//
// Most of the vocabulary is shared with the SOW document (`sow-table`,
// `sow-section`, the letterhead) because the two are from the same studio and
// should look it. What is not shared is the part that is only true of an
// invoice: the amount due, set large enough to be the thing you see first.
// ---------------------------------------------------------------------------

import { el } from './ui.js';

const PRINT_ID = 'invoice-print';

const MARK_SRC = '/assets/img/njd-mark-orange.png';

const SITE_URL = 'newjourneydesigns.com';

function section(title, children, className) {
  const kept = children.filter(Boolean);
  if (!kept.length) return null;
  return el('section', {
    class: className
      ? `print-section sow-section ${className}`
      : 'print-section sow-section',
  }, [
    el('h2', { class: 'sow-section__title', text: title }),
    ...kept,
  ]);
}

function para(value, className = 'sow-p') {
  return value ? el('p', { class: className, text: value }) : null;
}

function partyBlock(label, party) {
  if (!party) return null;

  return el('div', { class: 'sow-party' }, [
    el('p', { class: 'sow-party__role', text: label }),
    el('p', { class: 'sow-party__name', text: party.name }),
    party.entityType ? el('p', { class: 'sow-party__meta', text: party.entityType }) : null,
    ...(party.address || []).map((line) => el('p', { class: 'sow-party__meta', text: line })),
    party.contactName
      ? el('p', {
        class: 'sow-party__meta',
        text: party.contactTitle
          ? `Attn: ${party.contactName}, ${party.contactTitle}`
          : `Attn: ${party.contactName}`,
      })
      : null,
    party.contactEmail
      ? el('p', { class: 'sow-party__meta', text: party.contactEmail })
      : null,
  ]);
}

/**
 * The lines, and the totals under them.
 *
 * The totals are rows of the same table rather than a block beside it, so the
 * amount column stays one column all the way down. A total that does not line
 * up with the numbers it totals is the sort of thing that makes somebody
 * re-add the column by hand.
 */
function linesTable(snapshot) {
  const body = snapshot.lines.map((row) => el('tr', {}, [
    el('td', {}, [
      el('span', { class: 'sow-cell__name', text: row.name }),
      row.description ? el('span', { class: 'sow-cell__desc', text: row.description }) : null,
    ]),
    el('td', { class: 'sow-table__mid', text: row.detail || '' }),
    el('td', { class: 'sow-table__num', text: row.amount }),
  ]));

  const totals = snapshot.totals;

  if (totals.showSubtotal) {
    body.push(el('tr', { class: 'sow-row--total' }, [
      el('td', { text: 'Subtotal' }),
      el('td', {}),
      el('td', { class: 'sow-table__num', text: totals.subtotal }),
    ]));
  }

  // Between the subtotal and what is owed, which is the only place it can go:
  // a client checking the arithmetic reads down this column.
  if (totals.tax) {
    body.push(el('tr', { class: 'sow-row--total' }, [
      el('td', { text: totals.taxLabel }),
      el('td', {}),
      el('td', { class: 'sow-table__num', text: totals.tax }),
    ]));
  }

  if (totals.paid) {
    body.push(el('tr', { class: 'sow-row--discount' }, [
      el('td', {}, [
        el('span', { class: 'sow-cell__name', text: 'Already received' }),
        el('span', { class: 'sow-cell__desc', text: 'Thank you.' }),
      ]),
      el('td', {}),
      el('td', { class: 'sow-table__num', text: `− ${totals.paid}` }),
    ]));
  }

  body.push(el('tr', { class: 'inv-row--due' }, [
    el('td', { text: 'Amount due' }),
    el('td', {}),
    el('td', { class: 'sow-table__num', text: totals.due }),
  ]));

  return el('table', { class: 'sow-table sow-table--fees inv-table' }, [
    el('thead', {}, [
      el('tr', {}, [
        el('th', { scope: 'col', text: 'Description' }),
        el('th', { scope: 'col', text: 'Detail' }),
        el('th', { scope: 'col', class: 'sow-table__num', text: 'Amount' }),
      ]),
    ]),
    el('tbody', {}, body),
  ]);
}

function bulletList(values) {
  return el('ul', { class: 'sow-list' }, values.map((value) => el('li', { text: value })));
}

/** The whole document, from a snapshot and nothing else. */
export function buildDocument(snapshot) {
  return el('div', { class: 'print-doc sow-doc inv-doc', id: PRINT_ID }, [
    el('header', { class: 'print-head' }, [
      el('img', { class: 'print-head__mark', src: MARK_SRC, alt: '', width: '44', height: '44' }),
      el('div', { class: 'print-head__names' }, [
        el('p', { class: 'print-head__wordmark', text: 'New Journey Designs' }),
        el('p', { class: 'print-head__site', text: SITE_URL }),
      ]),
      el('p', { class: 'sow-head__ref', text: snapshot.label }),
    ]),

    el('h1', { class: 'print-title sow-title', text: 'Invoice' }),
    el('p', { class: 'sow-subtitle', text: snapshot.title }),

    el('div', { class: 'sow-parties' }, [
      partyBlock('From', snapshot.studio),
      partyBlock('Billed to', snapshot.client),
    ]),

    el('dl', { class: 'print-facts sow-facts' }, snapshot.header.map(([label, value]) => (
      el('div', { class: 'print-fact' }, [
        el('dt', { text: label }),
        el('dd', {
          // The amount due is the one fact on this list anybody is looking for.
          class: label === 'Amount due' ? 'inv-fact__due' : null,
          text: value,
        }),
      ])
    ))),

    snapshot.authority ? el('p', { class: 'sow-msa', text: snapshot.authority }) : null,

    snapshot.summary ? section('Summary', [para(snapshot.summary)]) : null,

    section('Charges', [linesTable(snapshot)]),

    // Kept whole across a page break. The terms and the account number are one
    // instruction, and half of it at the foot of page one with the rest
    // overleaf is how a client pays the wrong way or not at all.
    section(snapshot.payment.heading, [
      ...snapshot.payment.paragraphs.map((line) => para(line)),
      snapshot.payment.details.length
        ? el('div', { class: 'inv-pay' }, snapshot.payment.details.map((line) => (
          el('p', { class: 'inv-pay__line', text: line })
        )))
        : null,
    ], 'inv-section--pay'),

    snapshot.notes
      ? section(snapshot.notes.heading, [bulletList(snapshot.notes.lines)])
      : null,

    // The running footer proper is a @page margin box (see css/print.css). This
    // closing line is what an engine without margin-box support is left holding,
    // so the party name and the reference are on the paper either way.
    el('div', { class: 'sow-end' }, [
      el('p', { text: snapshot.footer }),
      el('p', { text: snapshot.label }),
      snapshot.preparedOn ? el('p', { text: `Prepared ${snapshot.preparedOn}` }) : null,
    ]),
  ]);
}

/** A display:none <img> is still fetched, but printing before it lands leaves a
 *  hole where the mark should be. Never blocks for long — the dialog is worth
 *  more than the logo. */
function imageReady(img, timeout = 2000) {
  if (!img || (img.complete && img.naturalWidth)) return Promise.resolve();

  return new Promise((resolve) => {
    let timer = 0;
    const done = () => {
      window.clearTimeout(timer);
      resolve();
    };
    timer = window.setTimeout(done, timeout);
    img.addEventListener('load', done, { once: true });
    img.addEventListener('error', done, { once: true });
  });
}

/**
 * Build the document and open the print dialog.
 *
 * `filename` is set as the document title for the duration of the dialog,
 * because that is what every browser offers as the default name in Save as PDF.
 * It is put back afterwards.
 */
export async function printSnapshot(snapshot, filename) {
  const stale = document.getElementById(PRINT_ID);
  if (stale) stale.remove();

  const container = buildDocument(snapshot);
  document.body.append(container);

  await imageReady(container.querySelector('img'));

  const previousTitle = document.title;
  if (filename) document.title = filename.replace(/\.pdf$/i, '');

  // The running footer's text, handed to the @page margin box that draws it.
  // Quoted and escaped rather than interpolated: a party name containing a
  // quote or a backslash would otherwise produce a declaration the parser drops
  // and the footer would silently vanish. Setting it through .style is CSSOM,
  // not an inline style attribute, so the site's style-src is untroubled.
  const cssString = JSON.stringify(String(snapshot.footer || ''));
  document.documentElement.style.setProperty('--sow-party', cssString);

  const cleanup = () => {
    container.remove();
    document.documentElement.style.removeProperty('--sow-party');
    document.title = previousTitle;
  };

  window.addEventListener('afterprint', cleanup, { once: true });

  try {
    window.print();
  } catch (error) {
    window.removeEventListener('afterprint', cleanup);
    cleanup();
    throw new Error('This browser would not open its print dialog.');
  }
}
