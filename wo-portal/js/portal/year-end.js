// ---------------------------------------------------------------------------
// The year-end pack: everything a CPA asks for, in one go.
//
// This exists because the alternative is a phone call in March that begins "can
// you send me…" and ends three weeks later. An accountant preparing a return
// wants the same set of documents every year, and every one of them is already
// derivable from the ledger — so the studio should be able to hand the whole
// lot over in one action, on the second of January.
//
// What is in the pack, and why each piece is there:
//
//   Trial balance          The master document. Every account, both columns, at
//                          year end. It is the first thing a preparer asks for
//                          and the thing they reconcile everything else against.
//   Profit and loss        On both bases. A sole proprietor files on cash; the
//                          books are kept on accrual. Sending one and not the
//                          other guarantees a follow-up question.
//   Balance sheet          At year end, with the equity split out.
//   General ledger         Every line, in date order. This is the raw material —
//                          it is what gets imported, and what gets checked when
//                          a number on the summaries looks odd.
//   Receivables            What was owed at year end, which is exactly the
//                          figure that converts an accrual profit into a cash one.
//   Fixed asset additions  Anything bought into a fixed asset account during the
//                          year. The depreciation schedule is built from this,
//                          and it is the piece most often forgotten.
//   Member capital         What each member put in, took out and holds, with the
//                          year's profit split by their share. This is the
//                          schedule the K-1s are built from, and it is the one
//                          piece a pooled owner's-equity account cannot give.
//   Members' equity        The same movements line by line, per member account.
//   Expense detail         Every expense with its category, so a preparer can
//                          reclassify without asking what something was.
//   1099-NEC summary       Who needs a form, how much they were paid, and
//                          whether their W-9 is on file.
//   Notes                  The handful of things the books cannot decide on
//                          their own — meals, mileage, home office — stated
//                          plainly rather than left to be discovered.
//
// Two formats, because a preparer wants both: a printed pack to read and sign
// off, and CSVs to import. Neither is a summary of the other — they are the
// same numbers, rendered for a person and for a machine.
// ---------------------------------------------------------------------------

import { el } from './ui.js';
import { formatMoney } from './sow-fees.js';
import { downloadCsv } from './csv.js';
import { invoiceLabel } from './invoice-catalog.js';
import {
  accountLabel,
  agingReport,
  balanceSheet,
  dayBefore,
  formatSigned,
  ownerCapital,
  personName,
  profitAndLoss,
  substantiationGaps,
  trialBalance,
  vendorTotals,
} from './ledger-catalog.js';
import {
  loadBalances,
  loadCashIncome,
  loadEntries,
  loadExpenses,
  loadOpenInvoices,
  loadOwners,
  loadVendors,
} from './ledger-data.js';

const PRINT_ID = 'ledger-print';
const MARK_SRC = '/assets/img/njd-mark-orange.png';
const SITE_URL = 'newjourneydesigns.com';

/** Meals are half deductible and every other expense is not, so the pack says
 *  so next to the number rather than leaving it to be spotted. */
const HALF_DEDUCTIBLE = ['6070'];

/**
 * Everything the pack needs, for one financial year.
 *
 * `from` and `to` are passed in rather than derived, because a financial year
 * that does not start in January is a real thing and the caller already knows
 * which one it is asking about.
 */
export async function loadPack({ from, to }) {
  const [period, toDate, priorTo, cashIncome, entries, expenses, vendors, invoices, owners] =
    await Promise.all([
      loadBalances({ from, to }),
      loadBalances({ to }),
      // Everything before this year began, which is what separates profit kept
      // from earlier years from profit made in this one.
      loadBalances({ to: dayBefore(from) }),
      loadCashIncome({ from, to }),
      loadEntries({ from, to, limit: 5000 }),
      loadExpenses({ from, to, limit: 5000 }),
      loadVendors({ includeArchived: true }),
      loadOpenInvoices(),
      // Former members included: somebody who left mid-year still has a capital
      // account and still gets a K-1 for the part of the year they were in.
      loadOwners({ includeFormer: true }),
    ]);

  return {
    from, to, period, toDate, priorTo, cashIncome, entries, expenses, vendors,
    invoices, owners,
  };
}

// Derived views the pack needs in both formats
// ---------------------------------------------------------------------------

/** Every ledger line in the year, flattened and in date order — the general
 *  ledger proper, and the file a preparer actually imports. */
function generalLedger(pack) {
  const rows = [];

  pack.entries.forEach((entry) => {
    (entry.ledger_lines || [])
      .slice()
      .sort((a, b) => a.position - b.position)
      .forEach((line) => {
        const account = line.ledger_accounts || {};
        rows.push({
          date: entry.entry_date,
          memo: entry.memo || '',
          reference: entry.reference || '',
          source: entry.source,
          code: account.code || '',
          account: account.name || '',
          description: line.description || '',
          client: (line.clients && line.clients.name) || '',
          debit: Number(line.debit_cents) || 0,
          credit: Number(line.credit_cents) || 0,
        });
      });
  });

  return rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** What was bought into a fixed asset account this year. Depreciation is the
 *  preparer's job; knowing what to depreciate is the studio's. */
function fixedAssetAdditions(pack) {
  const fixed = new Set(pack.period.filter((row) => row.subtype === 'fixed_asset')
    .map((row) => row.code));

  return generalLedger(pack).filter((row) => fixed.has(row.code) && row.debit > 0);
}

/**
 * The mileage log.
 *
 * The standard mileage rate needs a contemporaneous record of the date, the
 * distance, where to and why — four columns, all of which a vehicle expense
 * already carries. Without this the deduction is not defensible however
 * carefully the amount was worked out.
 */
function mileageLog(pack) {
  return (pack.expenses || [])
    .filter((row) => Number(row.miles) > 0)
    .sort((a, b) => (a.spent_on < b.spent_on ? -1 : 1));
}

/**
 * Whose miles a mileage line is.
 *
 * Every owner drives their own car and claims their own miles, so a log that
 * pools four people's driving is four unusable logs. The driver rides on the
 * expense's `created_by`, set from the drive rather than from whoever pressed
 * Save. Older rows — mileage typed in before drives existed — have nobody on
 * them, and say so rather than silently borrowing the last name printed.
 */
function driverOf(row) {
  return personName(row && row.creator);
}

/**
 * Expenses that would not survive a question.
 *
 * The gross-up of what the substantiation rules ask for and what is actually
 * recorded. Named on the pack rather than quietly excluded, because the studio
 * can still fix most of them — and a preparer would far rather be told than
 * find out.
 */
function substantiationGapsIn(pack) {
  return (pack.expenses || [])
    .map((row) => ({ row, gaps: substantiationGaps(row, row.account) }))
    .filter((entry) => entry.gaps.length);
}

/** Money the owner put in and took out. Not an expense, and the single thing a
 *  small business most often gets wrong in its own books. */
function equityMovements(pack) {
  const equity = new Set(pack.period.filter((row) => row.type === 'equity')
    .map((row) => row.code));

  return generalLedger(pack).filter((row) => equity.has(row.code));
}

// The printed pack
// ---------------------------------------------------------------------------

function amountRow(label, value, { strong = false, indent = false } = {}) {
  return el('tr', { class: strong ? 'report__total' : null }, [
    el('td', { class: indent ? 'pack-indent' : null, text: label }),
    el('td', { class: 'is-numeric', text: formatSigned(value) }),
  ]);
}

function statement(title, rows, note) {
  return el('section', { class: 'print-section pack-section' }, [
    el('h2', { class: 'pack-section__title', text: title }),
    note ? el('p', { class: 'pack-note', text: note }) : null,
    el('table', { class: 'pack-table' }, [el('tbody', {}, rows.filter(Boolean))]),
  ]);
}

function plRows(pl) {
  return [
    ...pl.revenue.map((row) => amountRow(accountLabel(row), row.balance, { indent: true })),
    amountRow('Total revenue', pl.revenueTotal, { strong: true }),
    ...pl.costOfSales.map((row) => amountRow(accountLabel(row), row.balance, { indent: true })),
    pl.costOfSales.length ? amountRow('Total cost of sales', pl.costTotal, { strong: true }) : null,
    amountRow('Gross profit', pl.grossProfit, { strong: true }),
    ...pl.operating.map((row) => amountRow(
      HALF_DEDUCTIBLE.includes(row.code)
        ? `${accountLabel(row)} — 50% deductible`
        : accountLabel(row),
      row.balance, { indent: true },
    )),
    amountRow('Total operating expenses', pl.operatingTotal, { strong: true }),
    amountRow('Operating profit', pl.operatingProfit, { strong: true }),
    ...pl.otherIncome.map((row) => amountRow(accountLabel(row), row.balance, { indent: true })),
    ...pl.otherExpense.map((row) => amountRow(accountLabel(row), row.balance, { indent: true })),
    amountRow('Net profit', pl.netProfit, { strong: true }),
  ];
}

function detailTable(headings, rows) {
  return el('table', { class: 'pack-table pack-table--detail' }, [
    el('thead', {}, [el('tr', {}, headings.map((h) => el('th', { text: h })))]),
    el('tbody', {}, rows),
  ]);
}

/**
 * The whole pack as one printable document.
 *
 * Built into a `.print-doc` container, which is display:none on screen and only
 * exists inside @media print — exactly as the invoice and the scope of work do
 * it, so there is one way of putting ink on paper in this codebase rather than
 * three.
 */
export function buildPack(pack, { studioName = 'New Journey Designs' } = {}) {
  const year = String(pack.to).slice(0, 4);
  const accrual = profitAndLoss(pack.period);
  const cash = profitAndLoss(pack.period, pack.cashIncome);
  const bs = balanceSheet(pack.toDate, pack.period);
  const tb = trialBalance(pack.toDate);
  const aging = agingReport(pack.invoices, pack.to);
  const gl = generalLedger(pack);
  const additions = fixedAssetAdditions(pack);
  const equity = equityMovements(pack);
  const capital = ownerCapital(pack.owners, pack.toDate, bs.netProfit);
  const vendors = vendorTotals(pack.expenses, pack.vendors, year);
  const reportable = vendors.filter((row) => row.reportable);
  const mileage = mileageLog(pack);
  const gaps = substantiationGapsIn(pack);
  const salesTax = pack.toDate.find((row) => row.system_key === 'sales_tax_payable');
  const noReceipt = (pack.expenses || [])
    .filter((row) => !(row.expense_receipts || []).length);

  return el('div', { class: 'print-doc pack-doc', id: PRINT_ID }, [
    el('header', { class: 'print-head' }, [
      el('img', { class: 'print-head__mark', src: MARK_SRC, alt: '', width: '44', height: '44' }),
      el('div', { class: 'print-head__names' }, [
        el('p', { class: 'print-head__wordmark', text: studioName }),
        el('p', { class: 'print-head__site', text: SITE_URL }),
      ]),
      el('p', { class: 'sow-head__ref', text: `FY ${year}` }),
    ]),

    el('h1', { class: 'print-title', text: 'Year-end accounts pack' }),
    el('p', { class: 'pack-subtitle',
      text: `${studioName} · ${pack.from} to ${pack.to}` }),

    el('section', { class: 'print-section pack-section' }, [
      el('h2', { class: 'pack-section__title', text: 'What is in this pack' }),
      el('ol', { class: 'pack-list' }, [
        'Trial balance at year end',
        'Profit and loss — accrual basis',
        'Profit and loss — cash basis',
        'Balance sheet at year end',
        'Accounts receivable at year end',
        'Fixed asset additions during the year',
        "Owner's contributions and draws",
        'Mileage log',
        'Sales tax collected and owed',
        '1099-NEC summary',
        'Notes for the preparer',
      ].map((line) => el('li', { text: line }))),
      el('p', { class: 'pack-note',
        text: 'The full general ledger — every line behind these summaries — is '
            + 'supplied alongside this document as a CSV, together with the '
            + 'expense detail and the 1099 list.' }),
    ]),

    statement('Trial balance', [
      ...tb.rows.map((row) => el('tr', {}, [
        el('td', { text: accountLabel(row) }),
        el('td', { class: 'is-numeric', text: row.debits ? formatMoney(row.debits) : '' }),
        el('td', { class: 'is-numeric', text: row.credits ? formatMoney(row.credits) : '' }),
      ])),
      el('tr', { class: 'report__total' }, [
        el('td', { text: 'Total' }),
        el('td', { class: 'is-numeric', text: formatMoney(tb.debits) }),
        el('td', { class: 'is-numeric', text: formatMoney(tb.credits) }),
      ]),
    ], tb.balanced
      ? `Debits equal credits at ${formatMoney(tb.debits)}.`
      : 'These do not agree, which should not be possible — please query it.'),

    statement('Profit and loss — accrual basis', plRows(accrual),
      'Revenue counted when the work was invoiced. This is what the ledger holds.'),

    statement('Profit and loss — cash basis', plRows(cash),
      'Revenue counted when the money arrived, allocated across the accounts its '
      + 'invoice was raised against. Expenses are recorded when paid, so they are '
      + 'identical on both bases.'),

    statement('Balance sheet', [
      ...bs.currentAssets.map((row) => amountRow(accountLabel(row), row.balance, { indent: true })),
      ...bs.fixedAssets.map((row) => amountRow(accountLabel(row), row.balance, { indent: true })),
      amountRow('Total assets', bs.assetsTotal, { strong: true }),
      ...bs.currentLiabilities.map((row) => amountRow(accountLabel(row), row.balance, { indent: true })),
      ...bs.longTermLiabilities.map((row) => amountRow(accountLabel(row), row.balance, { indent: true })),
      amountRow('Total liabilities', bs.liabilitiesTotal, { strong: true }),
      ...bs.equity.map((row) => amountRow(accountLabel(row), row.balance, { indent: true })),
      amountRow('Retained earnings from earlier years', bs.retained, { indent: true }),
      amountRow('Profit this year', bs.netProfit, { indent: true }),
      amountRow('Total equity', bs.equityTotal, { strong: true }),
    ], bs.balanced
      ? 'Assets equal liabilities plus equity.'
      : `Out by ${formatMoney(Math.abs(bs.difference))} — please query it.`),

    el('section', { class: 'print-section pack-section' }, [
      el('h2', { class: 'pack-section__title', text: 'Accounts receivable at year end' }),
      el('p', { class: 'pack-note',
        text: 'What was invoiced and unpaid at the year end. This is the figure '
            + 'that converts the accrual profit above into the cash one.' }),
      aging.clients.length
        ? detailTable(['Client', 'Invoice', 'Due', 'Outstanding'],
          aging.clients.flatMap((client) => client.rows.map((row) => el('tr', {}, [
            el('td', { text: client.name }),
            el('td', { text: `INV ${invoiceLabel(row.invoice.number)}` }),
            el('td', { text: row.invoice.due_on || '' }),
            el('td', { class: 'is-numeric', text: formatMoney(row.outstanding) }),
          ]))).concat([
            el('tr', { class: 'report__total' }, [
              el('td', { text: 'Total owed' }),
              el('td', {}), el('td', {}),
              el('td', { class: 'is-numeric', text: formatMoney(aging.total) }),
            ]),
          ]))
        : el('p', { class: 'pack-note', text: 'Nothing was outstanding at the year end.' }),
    ]),

    el('section', { class: 'print-section pack-section' }, [
      el('h2', { class: 'pack-section__title', text: 'Fixed asset additions' }),
      el('p', { class: 'pack-note',
        text: 'Bought during the year and capitalised. Depreciation has not been '
            + 'calculated in these books — this is the schedule input.' }),
      additions.length
        ? detailTable(['Date', 'Account', 'Description', 'Cost'],
          additions.map((row) => el('tr', {}, [
            el('td', { text: row.date }),
            el('td', { text: `${row.code} · ${row.account}` }),
            el('td', { text: row.description || row.memo }),
            el('td', { class: 'is-numeric', text: formatMoney(row.debit) }),
          ])))
        : el('p', { class: 'pack-note', text: 'No fixed assets were capitalised this year.' }),
    ]),

    el('section', { class: 'print-section pack-section' }, [
      el('h2', { class: 'pack-section__title', text: 'Member capital accounts' }),
      el('p', { class: 'pack-note',
        text: 'What each member put in, took out, and holds at year end, with the '
            + 'year’s profit split by the share each of them owns. The profit share '
            + 'is shown and NOT posted — allocating it to capital is your entry to '
            + 'make, not one the books made on their own.' }),
      capital.rows.length
        ? detailTable(['Member', 'Share', 'Put in', 'Taken out', 'Share of profit', 'Capital'],
          capital.rows.map((row) => el('tr', {}, [
            el('td', { text: row.name }),
            el('td', { class: 'is-numeric', text: `${row.pct.toFixed(2)}%` }),
            el('td', { class: 'is-numeric', text: formatMoney(row.contributed) }),
            el('td', { class: 'is-numeric', text: formatMoney(row.drawn) }),
            el('td', { class: 'is-numeric', text: formatSigned(row.share) }),
            el('td', { class: 'is-numeric', text: formatSigned(row.capital) }),
          ])).concat([
            el('tr', { class: 'report__total' }, [
              el('td', { text: 'Total' }),
              el('td', { class: 'is-numeric', text: `${(capital.totalBp / 100).toFixed(2)}%` }),
              el('td', { class: 'is-numeric', text: formatMoney(capital.contributed) }),
              el('td', { class: 'is-numeric', text: formatMoney(capital.drawn) }),
              el('td', { class: 'is-numeric',
                text: formatSigned(bs.netProfit - capital.rounding) }),
              el('td', { class: 'is-numeric', text: formatSigned(capital.capital) }),
            ]),
          ]))
        : el('p', { class: 'pack-note', text: 'No members recorded.' }),
      capital.rows.length && !capital.balanced
        ? el('p', { class: 'pack-note',
          text: `NOTE: the ownership shares come to ${(capital.totalBp / 100).toFixed(2)}%, `
              + 'not 100%. The allocation above is therefore incomplete and should be '
              + 'settled before the returns are prepared.' })
        : null,
    ]),

    el('section', { class: 'print-section pack-section' }, [
      el('h2', { class: 'pack-section__title', text: "Members' contributions and draws" }),
      el('p', { class: 'pack-note',
        text: 'Money in and out of the business that is not income or expense, line '
            + 'by line. The account names say whose each one is; the summary above '
            + 'totals them per member.' }),
      equity.length
        ? detailTable(['Date', 'Account', 'Description', 'In', 'Out'],
          equity.map((row) => el('tr', {}, [
            el('td', { text: row.date }),
            el('td', { text: `${row.code} · ${row.account}` }),
            el('td', { text: row.description || row.memo }),
            el('td', { class: 'is-numeric', text: row.credit ? formatMoney(row.credit) : '' }),
            el('td', { class: 'is-numeric', text: row.debit ? formatMoney(row.debit) : '' }),
          ])))
        : el('p', { class: 'pack-note', text: 'None recorded this year.' }),
    ]),

    el('section', { class: 'print-section pack-section' }, [
      el('h2', { class: 'pack-section__title', text: 'Mileage log' }),
      el('p', { class: 'pack-note',
        text: 'Business driving recorded during the year, with the destination and '
            + 'the reason for each trip.' }),
      mileage.length
        ? detailTable(['Driver', 'Date', 'Miles', 'To', 'Purpose', 'Claimed'],
          mileage.map((row) => el('tr', {}, [
            el('td', { text: driverOf(row) }),
            el('td', { text: row.spent_on }),
            el('td', { text: String(row.miles) }),
            el('td', { text: row.place || '' }),
            el('td', { text: row.business_purpose || '' }),
            el('td', { class: 'is-numeric', text: formatMoney(row.amount_cents) }),
          ])).concat([
            el('tr', { class: 'report__total' }, [
              el('td', { text: 'Total' }),
              el('td', {}),
              el('td', { text: String(mileage.reduce((t, r) => t + Number(r.miles), 0)) }),
              el('td', {}), el('td', {}),
              el('td', { class: 'is-numeric',
                text: formatMoney(mileage.reduce((t, r) => t + r.amount_cents, 0)) }),
            ]),
          ]))
        : el('p', { class: 'pack-note', text: 'No business mileage recorded this year.' }),
    ]),

    el('section', { class: 'print-section pack-section' }, [
      el('h2', { class: 'pack-section__title', text: 'Sales tax' }),
      salesTax && salesTax.balance
        ? el('p', { class: 'pack-note',
          text: `${formatMoney(salesTax.balance)} was collected on clients' behalf and `
              + 'is shown as a liability at the year end. It is not revenue and has '
              + 'not been included in the profit and loss above.' })
        : el('p', { class: 'pack-note',
          text: 'No sales tax was charged during the year. The studio\'s work was '
              + 'treated as exempt professional services.' }),
    ]),

    el('section', { class: 'print-section pack-section' }, [
      el('h2', { class: 'pack-section__title', text: '1099-NEC summary' }),
      reportable.length
        ? detailTable(['Vendor', 'Paid', 'W-9 on file'],
          reportable.map((row) => el('tr', {}, [
            el('td', { text: row.vendor.name }),
            el('td', { class: 'is-numeric', text: formatMoney(row.paid) }),
            el('td', { text: row.vendor.tax_id_on_file ? 'Yes' : 'NO — not collected' }),
          ])))
        : el('p', { class: 'pack-note',
          text: 'Nobody was paid $600 or more for services who needs a 1099-NEC.' }),
    ]),

    el('section', { class: 'print-section pack-section' }, [
      el('h2', { class: 'pack-section__title', text: 'Notes for the preparer' }),
      gaps.length || noReceipt.length
        ? el('p', { class: 'pack-note pack-note--flag' }, [
          `Known gaps: ${gaps.length} expense${gaps.length === 1 ? '' : 's'} `
          + 'missing part of the substantiation the rules ask for'
          + (noReceipt.length
            ? `, and ${noReceipt.length} with no receipt photograph attached`
            : '')
          + '. Listed in the expense CSV supplied alongside this pack.',
        ])
        : el('p', { class: 'pack-note',
          text: 'Every expense in the period carries its receipt and, where the rules '
              + 'ask for one, the business purpose and the people present.' }),
      el('ul', { class: 'pack-list' }, [
        'These books are kept on a double-entry accrual basis. Every entry balances; '
        + 'the trial balance above is generated from the same ledger as every other '
        + 'statement in this pack.',
        'Revenue is recognised when an invoice is issued, and cleared against '
        + 'Accounts receivable when a payment is recorded. No revenue is recognised '
        + 'on a draft invoice.',
        'Expenses are recorded when paid rather than when billed, so the two bases '
        + 'agree on costs. Any genuine accrual will appear as a manual journal entry '
        + 'against Accounts payable.',
        'Meals are held in their own account and have not been reduced to 50% — the '
        + 'gross figure is shown.',
        'Sales tax charged to clients is credited to a liability account and never to '
        + 'revenue, so the profit and loss above is net of it.',
        'The mileage log above is the contemporaneous record for the standard mileage '
        + 'rate, and names the driver on every line: each owner drives their own '
        + 'vehicle and claims their own miles, so the log is filed per person rather '
        + 'than as one pooled total. The home office has not been apportioned in these '
        + 'books — the square footage and the method are held outside the system.',
        'Depreciation has not been posted. Fixed asset additions for the year are '
        + 'listed above.',
        `${reportable.length} 1099-NEC ${reportable.length === 1 ? 'form is' : 'forms are'} `
        + 'indicated by the summary above.',
      ].map((line) => el('li', { text: line }))),
      el('p', { class: 'pack-note',
        text: `Prepared from the New Journey Designs client portal ledger. `
            + `${gl.length} ledger line${gl.length === 1 ? '' : 's'} across `
            + `${pack.entries.length} entr${pack.entries.length === 1 ? 'y' : 'ies'} `
            + 'for the period.' }),
    ]),
  ]);
}

/** Same mechanism as the invoice and the SOW: build the container, hand the
 *  page to window.print(), take it away again afterwards. */
export async function printPack(pack, options = {}) {
  const stale = document.getElementById(PRINT_ID);
  if (stale) stale.remove();

  const container = buildPack(pack, options);
  document.body.append(container);

  const image = container.querySelector('img');
  if (image && !image.complete) {
    await new Promise((resolve) => {
      image.addEventListener('load', resolve, { once: true });
      image.addEventListener('error', resolve, { once: true });
    });
  }

  const previousTitle = document.title;
  document.title = `NJD-year-end-${String(pack.to).slice(0, 4)}`;

  const cleanup = () => {
    container.remove();
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

// The CSVs
// ---------------------------------------------------------------------------

/**
 * The files, as { filename, headers, rows }.
 *
 * Returned rather than downloaded so the caller decides when — and so this is
 * testable without a browser.
 */
export function packFiles(pack) {
  const year = String(pack.to).slice(0, 4);
  const stamp = `${year}`;
  const accrual = profitAndLoss(pack.period);
  const cash = profitAndLoss(pack.period, pack.cashIncome);
  const bs = balanceSheet(pack.toDate, pack.period);
  const tb = trialBalance(pack.toDate);
  const aging = agingReport(pack.invoices, pack.to);
  const money = (cents) => (Number(cents || 0) / 100).toFixed(2);

  const plRowsFor = (pl, basis) => {
    const out = [];
    const push = (section, set) => set.forEach((row) => out.push(
      [basis, section, row.code, row.name, money(row.balance)],
    ));
    push('Revenue', pl.revenue);
    push('Cost of sales', pl.costOfSales);
    out.push([basis, 'Subtotal', '', 'Gross profit', money(pl.grossProfit)]);
    push('Operating expenses', pl.operating);
    out.push([basis, 'Subtotal', '', 'Operating profit', money(pl.operatingProfit)]);
    push('Other income', pl.otherIncome);
    push('Other costs', pl.otherExpense);
    out.push([basis, 'Total', '', 'Net profit', money(pl.netProfit)]);
    return out;
  };

  return [
    {
      filename: `njd-${stamp}-general-ledger.csv`,
      headers: ['Date', 'Memo', 'Reference', 'Source', 'Account code', 'Account',
        'Line description', 'Client', 'Debit', 'Credit'],
      rows: generalLedger(pack).map((row) => [
        row.date, row.memo, row.reference, row.source, row.code, row.account,
        row.description, row.client, money(row.debit), money(row.credit),
      ]),
    },
    {
      filename: `njd-${stamp}-trial-balance.csv`,
      headers: ['Account code', 'Account', 'Type', 'Debit', 'Credit'],
      rows: tb.rows.map((row) => [
        row.code, row.name, row.type, money(row.debits), money(row.credits),
      ]),
    },
    {
      filename: `njd-${stamp}-profit-and-loss.csv`,
      headers: ['Basis', 'Section', 'Account code', 'Account', 'Amount'],
      rows: [...plRowsFor(accrual, 'Accrual'), ...plRowsFor(cash, 'Cash')],
    },
    {
      filename: `njd-${stamp}-balance-sheet.csv`,
      headers: ['Section', 'Account code', 'Account', 'Amount'],
      rows: [
        ...bs.currentAssets.map((r) => ['Current assets', r.code, r.name, money(r.balance)]),
        ...bs.fixedAssets.map((r) => ['Fixed assets', r.code, r.name, money(r.balance)]),
        ['Total', '', 'Total assets', money(bs.assetsTotal)],
        ...bs.currentLiabilities.map((r) => ['Current liabilities', r.code, r.name, money(r.balance)]),
        ...bs.longTermLiabilities.map((r) => ['Long-term liabilities', r.code, r.name, money(r.balance)]),
        ['Total', '', 'Total liabilities', money(bs.liabilitiesTotal)],
        ...bs.equity.map((r) => ['Equity', r.code, r.name, money(r.balance)]),
        ['Equity', '', 'Retained earnings', money(bs.retained)],
        ['Equity', '', 'Profit this year', money(bs.netProfit)],
        ['Total', '', 'Total equity', money(bs.equityTotal)],
      ],
    },
    {
      filename: `njd-${stamp}-expenses.csv`,
      // Everything a preparer needs to reclassify a line, substantiate it, or
      // ask about it — in one file, so there is nothing to cross-reference.
      headers: ['Date', 'Entered by', 'Vendor', 'Description', 'Category code',
        'Category', 'Paid from', 'Method', 'Reference', 'Client', 'Billable',
        'Where', 'Business purpose', 'Who was there', 'Miles',
        'Receipts on file', 'Amount', 'Deductible note', 'Substantiation'],
      rows: pack.expenses.map((row) => {
        const gaps = substantiationGaps(row, row.account);
        return [
          row.spent_on,
          // Who put it through — an audit-trail fact, not a claim about whose
          // money it was. What paid for it is the Paid from column.
          personName(row.creator),
          (row.vendors && row.vendors.name) || row.vendor_name || '',
          row.description || '',
          (row.account && row.account.code) || '',
          (row.account && row.account.name) || '',
          (row.paid_from && row.paid_from.name) || '',
          row.method,
          row.reference || '',
          (row.clients && row.clients.name) || '',
          row.billable ? 'yes' : 'no',
          row.place || '',
          row.business_purpose || '',
          row.attendees || '',
          row.miles == null ? '' : row.miles,
          (row.expense_receipts || []).length,
          money(row.amount_cents),
          HALF_DEDUCTIBLE.includes((row.account && row.account.code) || '')
            ? '50% deductible' : '',
          gaps.length ? `missing ${gaps.join(', ')}` : 'complete',
        ];
      }),
    },
    {
      filename: `njd-${stamp}-mileage-log.csv`,
      // Driver first, so a preparer can sort or split the file by person
      // without rearranging it — each owner files their own mileage.
      headers: ['Driver', 'Date', 'Miles', 'To', 'Business purpose', 'Claimed'],
      rows: mileageLog(pack).map((row) => [
        driverOf(row),
        row.spent_on,
        row.miles,
        row.place || '',
        row.business_purpose || '',
        money(row.amount_cents),
      ]),
    },
    {
      filename: `njd-${stamp}-receivables.csv`,
      headers: ['Client', 'Invoice', 'Issued', 'Due', 'Days late', 'Outstanding'],
      rows: aging.clients.flatMap((client) => client.rows.map((row) => [
        client.name,
        `INV ${invoiceLabel(row.invoice.number)}`,
        row.invoice.issued_on || '',
        row.invoice.due_on || '',
        row.days,
        money(row.outstanding),
      ])),
    },
    {
      filename: `njd-${stamp}-fixed-asset-additions.csv`,
      headers: ['Date', 'Account code', 'Account', 'Description', 'Cost'],
      rows: fixedAssetAdditions(pack).map((row) => [
        row.date, row.code, row.account, row.description || row.memo, money(row.debit),
      ]),
    },
    {
      filename: `njd-${stamp}-member-capital.csv`,
      headers: ['Member', 'Portal name', 'Share %', 'Put in', 'Taken out',
        'Share of profit', 'Capital'],
      rows: ownerCapital(pack.owners, pack.toDate,
        balanceSheet(pack.toDate, pack.period).netProfit).rows.map((row) => [
        row.name,
        (row.member.profiles && row.member.profiles.full_name) || '',
        row.pct.toFixed(2),
        money(row.contributed),
        money(row.drawn),
        money(row.share),
        money(row.capital),
      ]),
    },
    {
      filename: `njd-${stamp}-owner-equity.csv`,
      headers: ['Date', 'Account code', 'Account', 'Description', 'In', 'Out'],
      rows: equityMovements(pack).map((row) => [
        row.date, row.code, row.account, row.description || row.memo,
        money(row.credit), money(row.debit),
      ]),
    },
    {
      filename: `njd-${stamp}-1099.csv`,
      headers: ['Vendor', 'Email', 'Phone', 'Paid', 'Needs 1099', 'W-9 on file'],
      rows: vendorTotals(pack.expenses, pack.vendors, year).map((row) => [
        row.vendor.name,
        row.vendor.email || '',
        row.vendor.phone || '',
        money(row.paid),
        row.reportable ? 'yes' : 'no',
        row.vendor.tax_id_on_file ? 'yes' : 'no',
      ]),
    },
  ];
}

/**
 * Save every file in the pack.
 *
 * One download at a time with a gap between them. Browsers throttle or silently
 * drop a burst of programmatic downloads — Safari in particular keeps only the
 * first — and a pack that quietly arrives four files short is worse than one
 * that takes three seconds.
 */
export async function downloadPack(pack) {
  const files = packFiles(pack);

  for (const file of files) {
    downloadCsv(file.filename, file.headers, file.rows);
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => { window.setTimeout(resolve, 350); });
  }

  return files.length;
}
