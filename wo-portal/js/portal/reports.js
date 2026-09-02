// ---------------------------------------------------------------------------
// The reports.
//
// Six of them, and between them they answer everything a small studio and its
// accountant need: is the business making money, what is it worth, do the books
// add up, who owes us, which clients are actually worth having, and who needs a
// 1099 in January.
//
// Two things are worth knowing about how they are built.
//
// Every report is assembled from ledger_balances() — one function, called with
// different windows. A profit and loss is the income and expense accounts over
// a period; a balance sheet is everything else, cumulative, plus two equity
// figures worked out rather than posted. Having one source means the balance
// sheet and the profit and loss can never disagree about a number, which is the
// classic way a hand-rolled reporting layer goes wrong.
//
// And every report can be exported as CSV, because the point of keeping books
// is eventually to hand them to somebody else.
// ---------------------------------------------------------------------------

import { bootstrap, renderError } from './shell.js';
import { el, mount, byId, toast, fmtDate, panelHead, table } from './ui.js';
import { formatMoney } from './sow-fees.js';
import { downloadCsv } from './csv.js';
import { invoiceLabel } from './invoice-catalog.js';
import {
  AGING_BUCKETS,
  accountLabel,
  agingReport,
  balanceSheet,
  byClient,
  dayBefore,
  fiscalYearStart,
  formatSigned,
  memberName,
  monthSpans,
  monthlyProfitAndLoss,
  ownerCapital,
  profitAndLoss,
  trialBalance,
  vendorTotals,
} from './ledger-catalog.js';
import { downloadPack, loadPack, printPack } from './ledger-export.js';
import {
  loadBalances,
  loadCashIncome,
  loadClientLines,
  loadExpenses,
  loadOpenInvoices,
  loadOwners,
  loadSettings,
  loadVendors,
} from './ledger-data.js';

const REPORTS = [
  { key: 'pl', label: 'Profit & loss', blurb: 'What the studio earned, what it cost, what is left.' },
  { key: 'months', label: 'By month', blurb: 'The same report a column at a time — where the year moved.' },
  { key: 'balance', label: 'Balance sheet', blurb: 'What it owns, what it owes, and the difference.' },
  { key: 'trial', label: 'Trial balance', blurb: 'Every account and both columns — the proof the books add up.' },
  { key: 'aging', label: 'Who owes us', blurb: 'Outstanding invoices, by how late they are.' },
  { key: 'clients', label: 'By client', blurb: 'What each one was worth after what they cost.' },
  { key: 'owners', label: 'Owner capital', blurb: 'What each member put in, took out and holds — the schedule a K-1 is built from.' },
  { key: '1099', label: '1099s', blurb: 'Contractors over the threshold, and whose W-9 is missing.' },
];

const state = {
  report: 'pl',
  basis: 'accrual',
  from: '',
  to: '',
  settings: null,
  period: [],
  toDate: [],
  thisYear: [],
  cashIncome: [],
  invoices: [],
  clientLines: [],
  vendors: [],
  expenses: [],
  months: [],
  byMonth: {},
  owners: [],
  loading: false,
};

const body = el('div', {});
const controls = el('div', { class: 'filters' });

function todayIso() {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
}

// Loading
// ---------------------------------------------------------------------------

/**
 * Only what the chosen report needs.
 *
 * A balance sheet does not need the invoice list and the ageing report does not
 * need three windows of balances. Fetching everything on every change would be
 * simpler and would make each switch four round trips slower than it has to be.
 */
async function loadFor(report) {
  const fyStart = fiscalYearStart(state.to,
    state.settings && state.settings.fiscal_year_start_month);

  if (report === 'pl') {
    const [period, cash] = await Promise.all([
      loadBalances({ from: state.from, to: state.to }),
      state.basis === 'cash'
        ? loadCashIncome({ from: state.from, to: state.to })
        : Promise.resolve([]),
    ]);
    state.period = period;
    state.cashIncome = cash;
    return;
  }

  if (report === 'months') {
    // One window per month of the financial year so far. Twelve small queries
    // rather than one big one, because ledger_balances() answers for a range
    // and a month-by-month answer is twelve ranges — and they go together, so
    // the wait is one round trip long, not twelve.
    const spans = monthSpans(state.to,
      state.settings && state.settings.fiscal_year_start_month);
    const balances = await Promise.all(
      spans.map((span) => loadBalances({ from: span.from, to: span.to })),
    );
    state.months = spans;
    state.byMonth = Object.fromEntries(spans.map((span, i) => [span.key, balances[i]]));
    return;
  }

  if (report === 'balance') {
    const [toDate, thisYear] = await Promise.all([
      loadBalances({ to: state.to }),
      loadBalances({ from: fyStart, to: state.to }),
    ]);
    state.toDate = toDate;
    state.thisYear = thisYear;
    return;
  }

  if (report === 'trial') {
    state.toDate = await loadBalances({ to: state.to });
    return;
  }

  if (report === 'aging') {
    const [invoices, balances] = await Promise.all([
      loadOpenInvoices(),
      loadBalances({ to: state.to }),
    ]);
    state.invoices = invoices;
    state.toDate = balances;
    return;
  }

  if (report === 'owners') {
    // Capital is a since-the-books-opened figure, so it reads to the date and
    // not across a window: what somebody holds today is every contribution
    // they have ever made less every draw. The profit being allocated is the
    // financial year's, which is the period a K-1 covers.
    const [owners, toDate, thisYear] = await Promise.all([
      loadOwners({ includeFormer: true }),
      loadBalances({ to: state.to }),
      loadBalances({ from: fyStart, to: state.to }),
    ]);
    state.owners = owners;
    state.toDate = toDate;
    state.thisYear = thisYear;
    return;
  }

  if (report === 'clients') {
    state.clientLines = await loadClientLines({ from: state.from, to: state.to });
    return;
  }

  if (report === '1099') {
    const [vendors, expenses] = await Promise.all([
      loadVendors({ includeArchived: true }),
      loadExpenses({ from: `${state.to.slice(0, 4)}-01-01`, to: `${state.to.slice(0, 4)}-12-31` }),
    ]);
    state.vendors = vendors;
    state.expenses = expenses;
  }
}

async function reload() {
  state.loading = true;
  mount(body, el('p', { class: 'skeleton', text: 'Working it out…' }));

  try {
    await loadFor(state.report);
  } catch (error) {
    mount(body, el('p', { class: 'notice notice--error', text: error.message }));
    state.loading = false;
    return;
  }

  state.loading = false;
  render();
}

// Shared bits of a report
// ---------------------------------------------------------------------------

/** A named block of accounts with a subtotal. Every report is made of these. */
function section(title, rows, total, { strong = false } = {}) {
  return el('div', { class: 'report__section' }, [
    el('h3', { text: title }),
    rows.length
      ? el('table', { class: 'table report__table' }, [
        el('tbody', {}, [
          ...rows.map((row) => el('tr', {}, [
            el('td', {}, [
              el('a', {
                class: 'report__account',
                href: `/portal/admin/ledger/entries/?account=${encodeURIComponent(row.account_id)}`,
                text: accountLabel(row),
              }),
            ]),
            el('td', { class: 'is-numeric', text: formatSigned(row.balance) }),
          ])),
          el('tr', { class: strong ? 'report__total report__total--strong' : 'report__total' }, [
            el('td', { text: `Total ${title.toLowerCase()}` }),
            el('td', { class: 'is-numeric', text: formatSigned(total) }),
          ]),
        ]),
      ])
      : el('p', { class: 'empty', text: 'Nothing here in this period. Widen the dates, or clear the filters.' }),
  ]);
}

/** A standalone figure between sections — gross profit, net profit, the check. */
function figureLine(label, value, tone) {
  return el('p', {
    class: tone ? `report__figure report__figure--${tone}` : 'report__figure',
  }, [
    el('span', { text: label }),
    el('strong', { text: formatSigned(value) }),
  ]);
}

// The reports
// ---------------------------------------------------------------------------

function renderProfitAndLoss() {
  const cash = state.basis === 'cash' ? state.cashIncome : null;
  const pl = profitAndLoss(state.period, cash);

  return el('div', { class: 'report' }, [
    el('p', { class: 'progress__label',
      text: state.basis === 'cash'
        ? 'Cash basis: revenue is counted in the month the money arrived, split '
          + 'across the accounts its invoice was for. Costs are recorded when they '
          + 'are paid, so they read the same on both bases.'
        : 'Accrual basis: revenue is counted when the work was invoiced, whether '
          + 'or not it has been paid. This is what the ledger actually holds.' }),

    section('Revenue', pl.revenue, pl.revenueTotal),
    section('Cost of sales', pl.costOfSales, pl.costTotal),
    figureLine('Gross profit', pl.grossProfit, pl.grossProfit < 0 ? 'bad' : null),
    pl.grossMargin === null
      ? null
      : el('p', { class: 'progress__label',
        text: `A gross margin of ${(pl.grossMargin * 100).toFixed(1)}%.` }),

    section('Operating expenses', pl.operating, pl.operatingTotal),
    figureLine('Operating profit', pl.operatingProfit, pl.operatingProfit < 0 ? 'bad' : null),

    pl.otherIncome.length ? section('Other income', pl.otherIncome, pl.otherIncomeTotal) : null,
    pl.otherExpense.length ? section('Other costs', pl.otherExpense, pl.otherExpenseTotal) : null,

    figureLine('Net profit', pl.netProfit, pl.netProfit < 0 ? 'bad' : 'good'),
  ]);
}

/**
 * The year, a column at a time.
 *
 * Wide by nature, so it scrolls inside its own container rather than taking
 * the page sideways — the one thing §7.12 will not have. The account name
 * column is what a reader needs kept in view, so it is the sticky one.
 */
function renderByMonth() {
  const spread = monthlyProfitAndLoss(state.months, state.byMonth);

  if (!spread.months.length) {
    return el('div', { class: 'report' }, [
      el('p', { class: 'empty', text: 'No months in this financial year yet.' }),
    ]);
  }

  const headings = ['', ...spread.months.map((m) => m.label), 'Year'];

  const bodyRows = [];
  spread.groups.forEach((group) => {
    bodyRows.push(el('tr', { class: 'report__group' }, [
      el('td', { text: group.title }),
      ...group.totals.map((value) => el('td', { class: 'is-numeric', text: formatSigned(value) })),
      el('td', { class: 'is-numeric', text: formatSigned(group.total) }),
    ]));

    group.rows.forEach((row) => {
      bodyRows.push(el('tr', {}, [
        el('td', {}, [
          el('a', {
            class: 'report__account',
            href: `/portal/admin/ledger/entries/?account=${encodeURIComponent(row.account_id)}`,
            text: accountLabel(row),
          }),
        ]),
        ...row.values.map((value) => el('td', { class: 'is-numeric', text: formatSigned(value) })),
        el('td', { class: 'is-numeric', text: formatSigned(row.total) }),
      ]));
    });
  });

  spread.figures.forEach((figure) => {
    bodyRows.push(el('tr', {
      class: figure.key === 'netProfit'
        ? 'report__total report__total--strong'
        : 'report__total',
    }, [
      el('td', { text: figure.label }),
      ...figure.values.map((value) => el('td', { class: 'is-numeric', text: formatSigned(value) })),
      el('td', { class: 'is-numeric', text: formatSigned(figure.total) }),
    ]));
  });

  return el('div', { class: 'report' }, [
    el('p', { class: 'progress__label',
      text: 'Accrual basis, month by month across this financial year — revenue '
        + 'counted when it was invoiced. This is the shape a seasonal dip or a '
        + 'cost that quietly doubled shows up in, which a single-period report '
        + 'cannot say. Scroll it sideways for the later months.' }),
    table(headings, bodyRows, { wide: true }),
  ]);
}

/**
 * Each member's capital account.
 *
 * The schedule a K-1 is built from, and the one report that could not exist
 * while capital was pooled into a single owner's account. Read to the date
 * rather than across a window, because what somebody holds is every
 * contribution they have ever made less every draw they have ever taken.
 *
 * The profit share is shown and deliberately not posted: allocating profit to
 * member capital is a year-end entry a preparer makes, and a report that
 * quietly made it would put a figure in the books nobody chose.
 */
function renderOwners() {
  const bs = balanceSheet(state.toDate, state.thisYear);
  const cap = ownerCapital(state.owners, state.toDate, bs.netProfit);

  if (!cap.rows.length) {
    return el('div', { class: 'report' }, [
      el('p', { class: 'empty',
        text: 'Nobody is recorded as a member yet, so there is no capital to split.' }),
    ]);
  }

  const rows = cap.rows.map((row) => el('tr', {}, [
    el('td', {}, [
      el('span', { class: 'sow-cell__name', text: row.name }),
      // The portal calls them Trip and Vic; the books call them what a tax
      // document calls them. Showing both keeps the report readable by the
      // people in it as well as by their preparer.
      row.member.profiles && row.member.profiles.full_name !== row.name
        ? el('span', { class: 'sow-cell__desc', text: row.member.profiles.full_name })
        : null,
      row.member.ended_on
        ? el('span', { class: 'sow-cell__desc', text: `Left ${fmtDate(row.member.ended_on)}` })
        : null,
    ]),
    el('td', { class: 'is-numeric', text: `${row.pct.toFixed(2)}%` }),
    el('td', { class: 'is-numeric', text: formatSigned(row.contributed) }),
    el('td', { class: 'is-numeric', text: formatSigned(row.drawn) }),
    el('td', { class: 'is-numeric', text: formatSigned(row.share) }),
    el('td', { class: 'is-numeric', text: formatSigned(row.capital) }),
  ]));

  rows.push(el('tr', { class: 'report__total report__total--strong' }, [
    el('td', { text: 'Total' }),
    el('td', { class: 'is-numeric', text: `${(cap.totalBp / 100).toFixed(2)}%` }),
    el('td', { class: 'is-numeric', text: formatSigned(cap.contributed) }),
    el('td', { class: 'is-numeric', text: formatSigned(cap.drawn) }),
    el('td', { class: 'is-numeric', text: formatSigned(bs.netProfit - cap.rounding) }),
    el('td', { class: 'is-numeric', text: formatSigned(cap.capital) }),
  ]));

  return el('div', { class: 'report' }, [
    el('p', { class: 'progress__label',
      text: `Every member's own capital account as at ${fmtDate(state.to)}, with this `
        + 'financial year’s profit split by the share each of them owns. Contributions '
        + 'and draws are since the books opened; the profit share is shown here and '
        + 'is not posted — allocating it to capital is a year-end entry your '
        + 'preparer makes.' }),

    table(['Member', 'Share', 'Put in', 'Taken out', 'Share of profit', 'Capital'],
      rows, { wide: true }),

    cap.balanced
      ? null
      : el('p', { class: 'notice notice--warn',
        text: `The ownership shares come to ${(cap.totalBp / 100).toFixed(2)}%, not 100%. `
          + 'A split that does not tie is a set of K-1s that does not tie — fix the '
          + 'percentages under Owners before this goes anywhere near a return.' }),

    cap.rounding
      ? el('p', { class: 'progress__label',
        text: `${formatMoney(Math.abs(cap.rounding))} of profit does not divide into whole `
          + 'cents across these shares. Your preparer decides who absorbs it; this report '
          + 'will not quietly hand it to anybody.' })
      : null,
  ]);
}

function renderBalanceSheet() {
  const bs = balanceSheet(state.toDate, state.thisYear);

  return el('div', { class: 'report' }, [
    el('p', { class: 'progress__label',
      text: `Everything the studio owned and owed as at ${fmtDate(state.to)}.` }),

    section('Current assets', bs.currentAssets,
      bs.currentAssets.reduce((t, r) => t + r.balance, 0)),
    bs.fixedAssets.length
      ? section('Fixed assets', bs.fixedAssets, bs.fixedAssets.reduce((t, r) => t + r.balance, 0))
      : null,
    figureLine('Total assets', bs.assetsTotal, null),

    section('Current liabilities', bs.currentLiabilities,
      bs.currentLiabilities.reduce((t, r) => t + r.balance, 0)),
    bs.longTermLiabilities.length
      ? section('Long-term liabilities', bs.longTermLiabilities,
        bs.longTermLiabilities.reduce((t, r) => t + r.balance, 0))
      : null,
    figureLine('Total liabilities', bs.liabilitiesTotal, null),

    el('div', { class: 'report__section' }, [
      el('h3', { text: 'Equity' }),
      el('table', { class: 'table report__table' }, [
        el('tbody', {}, [
          ...bs.equity.map((row) => el('tr', {}, [
            el('td', { text: accountLabel(row) }),
            el('td', { class: 'is-numeric', text: formatSigned(row.balance) }),
          ])),
          // Neither of these is an account. Both are worked out — see the note
          // on balanceSheet() in ledger-catalog.js.
          el('tr', {}, [
            el('td', {}, [
              el('span', { text: 'Retained earnings' }),
              el('span', { class: 'sow-cell__desc', text: 'Kept from earlier years' }),
            ]),
            el('td', { class: 'is-numeric', text: formatSigned(bs.retained) }),
          ]),
          el('tr', {}, [
            el('td', {}, [
              el('span', { text: 'Profit this financial year' }),
              el('span', { class: 'sow-cell__desc', text: 'Not yet rolled into the above' }),
            ]),
            el('td', { class: 'is-numeric', text: formatSigned(bs.netProfit) }),
          ]),
          el('tr', { class: 'report__total' }, [
            el('td', { text: 'Total equity' }),
            el('td', { class: 'is-numeric', text: formatSigned(bs.equityTotal) }),
          ]),
        ]),
      ]),
    ]),

    el('p', {
      class: bs.balanced ? 'notice notice--ok' : 'notice notice--error',
      text: bs.balanced
        ? `Assets equal liabilities plus equity, at ${formatMoney(bs.assetsTotal)}. `
          + 'The balance sheet balances.'
        : `This does not balance — assets are out by ${formatMoney(Math.abs(bs.difference))}. `
          + 'That is a problem with the books rather than with this report.',
    }),
  ]);
}

function renderTrialBalance() {
  const tb = trialBalance(state.toDate);

  return el('div', { class: 'report' }, [
    el('p', { class: 'progress__label',
      text: 'Every account with any movement, both columns, as at '
          + `${fmtDate(state.to)}. This is the report an accountant asks for first.` }),
    table(['Code', 'Account', 'Debit', 'Credit'],
      [
        ...tb.rows.map((row) => el('tr', {}, [
          el('td', { text: row.code }),
          el('td', { text: row.name }),
          el('td', { class: 'is-numeric', text: row.debits ? formatMoney(row.debits) : '' }),
          el('td', { class: 'is-numeric', text: row.credits ? formatMoney(row.credits) : '' }),
        ])),
        el('tr', { class: 'report__total' }, [
          el('td', { text: '' }),
          el('td', { text: 'Total' }),
          el('td', { class: 'is-numeric', text: formatMoney(tb.debits) }),
          el('td', { class: 'is-numeric', text: formatMoney(tb.credits) }),
        ]),
      ]),
    el('p', {
      class: tb.balanced ? 'notice notice--ok' : 'notice notice--error',
      text: tb.balanced
        ? 'Debits equal credits. The books are internally consistent.'
        : `Out by ${formatMoney(Math.abs(tb.difference))}, which should not be possible — `
          + 'the database refuses an entry that does not balance.',
    }),
  ]);
}

/**
 * Who owes us, and the cross-check that makes it trustworthy.
 *
 * The total here is built from the invoices; Accounts receivable in the ledger
 * is the same fact counted the other way. They should be identical, and saying
 * so on the report is what turns "here is a list" into "here is a list you can
 * rely on".
 */
function renderAging() {
  const report = agingReport(state.invoices, state.to);
  const ar = state.toDate.find((row) => row.system_key === 'accounts_receivable');
  const control = ar ? ar.balance : 0;
  const agrees = control === report.total;

  const rows = report.clients.map((client) => el('tr', {}, [
    el('td', {}, [
      el('span', { class: 'sow-cell__name', text: client.name }),
      el('span', { class: 'sow-cell__desc',
        text: client.rows.map((r) => `INV ${invoiceLabel(r.invoice.number)}`).join(', ') }),
    ]),
    ...AGING_BUCKETS.map((bucket) => el('td', {
      class: 'is-numeric',
      text: client[bucket.key] ? formatMoney(client[bucket.key]) : '',
    })),
    el('td', { class: 'is-numeric', text: formatMoney(client.total) }),
  ]));

  return el('div', { class: 'report' }, [
    report.clients.length
      ? table(['Client', ...AGING_BUCKETS.map((b) => b.label), 'Total'],
        [
          ...rows,
          el('tr', { class: 'report__total' }, [
            el('td', { text: 'Total' }),
            ...AGING_BUCKETS.map((bucket) => el('td', {
              class: 'is-numeric',
              text: report.totals[bucket.key] ? formatMoney(report.totals[bucket.key]) : '',
            })),
            el('td', { class: 'is-numeric', text: formatMoney(report.total) }),
          ]),
        ])
      : el('p', { class: 'empty', text: 'Nobody owes the studio anything. ' }),

    el('p', {
      class: agrees ? 'progress__label' : 'notice notice--warn',
      text: agrees
        ? 'This agrees with the Accounts receivable balance in the ledger.'
        : `The ledger says ${formatMoney(control)} is owed and these invoices come to `
          + `${formatMoney(report.total)}. The gap is usually an invoice issued before `
          + 'the books were started, or a payment recorded against the wrong one.',
    }),
  ]);
}

function renderByClient() {
  const rows = byClient(state.clientLines);

  if (!rows.length) {
    return el('p', { class: 'empty', text: 'Nothing has been posted against a client yet.' });
  }

  return el('div', { class: 'report' }, [
    el('p', { class: 'progress__label',
      text: 'Revenue less the costs recorded against each client. A cost only '
          + 'appears here if it was tagged with the client when it was recorded.' }),
    table(['Client', 'Revenue', 'Costs', 'Profit', 'Margin'],
      rows.map((row) => el('tr', {}, [
        el('td', { text: row.name }),
        el('td', { class: 'is-numeric', text: formatSigned(row.revenue) }),
        el('td', { class: 'is-numeric', text: formatSigned(row.cost) }),
        el('td', { class: 'is-numeric', text: formatSigned(row.profit) }),
        el('td', { class: 'is-numeric',
          text: row.margin === null ? '—' : `${(row.margin * 100).toFixed(0)}%` }),
      ]))),
  ]);
}

function render1099() {
  const year = state.to.slice(0, 4);
  const rows = vendorTotals(state.expenses, state.vendors, year);
  const reportable = rows.filter((row) => row.reportable);
  const missing = rows.filter((row) => row.missingTaxId);

  return el('div', { class: 'report' }, [
    el('p', { class: 'progress__label',
      text: `Everyone paid in ${year}. Anyone unincorporated paid $600 or more for `
          + 'services needs a 1099-NEC, and the deadline is January 31st.' }),

    rows.length
      ? table(['Vendor', `Paid in ${year}`, 'Needs a 1099', 'W-9'],
        rows.map((row) => el('tr', {}, [
          el('td', { text: row.vendor.name }),
          el('td', { class: 'is-numeric', text: formatMoney(row.paid) }),
          el('td', {}, [
            row.reportable
              ? el('span', { class: 'pill pill--amber', text: 'Yes' })
              : el('span', { class: 'progress__label',
                text: row.vendor.files_1099 ? 'Under the threshold' : 'No' }),
          ]),
          el('td', {}, [
            row.vendor.files_1099
              ? el('span', {
                class: row.vendor.tax_id_on_file ? 'pill pill--green' : 'pill pill--red',
                text: row.vendor.tax_id_on_file ? 'On file' : 'Missing',
              })
              : el('span', { class: 'progress__label', text: '—' }),
          ]),
        ])))
      : el('p', { class: 'empty', text: 'No vendor spend recorded for this year.' }),

    missing.length
      ? el('p', { class: 'notice notice--error',
        text: `${missing.length} contractor${missing.length === 1 ? '' : 's'} `
            + `over the threshold with no W-9 on file. Collect ${missing.length === 1
              ? 'it' : 'them'} now — chasing a W-9 in January, from somebody who no `
            + 'longer works with you, is the hardest version of this job.' })
      : el('p', { class: 'progress__label',
        text: `${reportable.length} 1099${reportable.length === 1 ? '' : 's'} to file `
            + `for ${year}, and every W-9 is on file.` }),
  ]);
}

function render() {
  const views = {
    pl: renderProfitAndLoss,
    months: renderByMonth,
    balance: renderBalanceSheet,
    trial: renderTrialBalance,
    aging: renderAging,
    clients: renderByClient,
    owners: renderOwners,
    1099: render1099,
  };

  mount(body, views[state.report]());
}

// Export
// ---------------------------------------------------------------------------

function exportCsv() {
  const stamp = `${state.from || 'start'}-to-${state.to}`;

  if (state.report === 'pl') {
    const pl = profitAndLoss(state.period, state.basis === 'cash' ? state.cashIncome : null);
    const rows = [];
    const push = (heading, set) => set.forEach((row) => rows.push(
      [heading, row.code, row.name, (row.balance / 100).toFixed(2)],
    ));
    push('Revenue', pl.revenue);
    push('Cost of sales', pl.costOfSales);
    rows.push(['', '', 'Gross profit', (pl.grossProfit / 100).toFixed(2)]);
    push('Operating expenses', pl.operating);
    rows.push(['', '', 'Operating profit', (pl.operatingProfit / 100).toFixed(2)]);
    push('Other income', pl.otherIncome);
    push('Other costs', pl.otherExpense);
    rows.push(['', '', 'Net profit', (pl.netProfit / 100).toFixed(2)]);
    downloadCsv(`njd-profit-and-loss-${state.basis}-${stamp}.csv`,
      ['Section', 'Code', 'Account', 'Amount'], rows);
    return;
  }

  if (state.report === 'months') {
    const spread = monthlyProfitAndLoss(state.months, state.byMonth);
    const rows = [];

    spread.groups.forEach((group) => {
      rows.push([group.title, '', 'Total',
        ...group.totals.map((v) => (v / 100).toFixed(2)),
        (group.total / 100).toFixed(2)]);
      group.rows.forEach((row) => rows.push([group.title, row.code, row.name,
        ...row.values.map((v) => (v / 100).toFixed(2)),
        (row.total / 100).toFixed(2)]));
    });
    spread.figures.forEach((figure) => rows.push(['', '', figure.label,
      ...figure.values.map((v) => (v / 100).toFixed(2)),
      (figure.total / 100).toFixed(2)]));

    downloadCsv(`njd-profit-and-loss-by-month-${state.to.slice(0, 4)}.csv`,
      ['Section', 'Code', 'Account', ...spread.months.map((m) => m.label), 'Year'],
      rows);
    return;
  }

  if (state.report === 'owners') {
    const bs = balanceSheet(state.toDate, state.thisYear);
    const cap = ownerCapital(state.owners, state.toDate, bs.netProfit);
    downloadCsv(`njd-owner-capital-${state.to}.csv`,
      ['Member', 'Portal name', 'Share %', 'Put in', 'Taken out',
       'Share of profit', 'Capital'],
      cap.rows.map((row) => [
        row.name,
        (row.member.profiles && row.member.profiles.full_name) || '',
        row.pct.toFixed(2),
        (row.contributed / 100).toFixed(2),
        (row.drawn / 100).toFixed(2),
        (row.share / 100).toFixed(2),
        (row.capital / 100).toFixed(2),
      ]));
    return;
  }

  if (state.report === 'balance') {
    const bs = balanceSheet(state.toDate, state.thisYear);
    const rows = [];
    const push = (heading, set) => set.forEach((row) => rows.push(
      [heading, row.code, row.name, (row.balance / 100).toFixed(2)],
    ));
    push('Current assets', bs.currentAssets);
    push('Fixed assets', bs.fixedAssets);
    push('Current liabilities', bs.currentLiabilities);
    push('Long-term liabilities', bs.longTermLiabilities);
    push('Equity', bs.equity);
    rows.push(['Equity', '', 'Retained earnings', (bs.retained / 100).toFixed(2)]);
    rows.push(['Equity', '', 'Profit this year', (bs.netProfit / 100).toFixed(2)]);
    downloadCsv(`njd-balance-sheet-${state.to}.csv`,
      ['Section', 'Code', 'Account', 'Amount'], rows);
    return;
  }

  if (state.report === 'trial') {
    const tb = trialBalance(state.toDate);
    downloadCsv(`njd-trial-balance-${state.to}.csv`,
      ['Code', 'Account', 'Debit', 'Credit'],
      tb.rows.map((row) => [row.code, row.name,
        (row.debits / 100).toFixed(2), (row.credits / 100).toFixed(2)]));
    return;
  }

  if (state.report === 'aging') {
    const report = agingReport(state.invoices, state.to);
    downloadCsv(`njd-receivables-${state.to}.csv`,
      ['Client', 'Invoice', 'Issued', 'Due', 'Days late', 'Outstanding'],
      report.clients.flatMap((client) => client.rows.map((row) => [
        client.name,
        `INV ${invoiceLabel(row.invoice.number)}`,
        row.invoice.issued_on || '',
        row.invoice.due_on || '',
        row.days,
        (row.outstanding / 100).toFixed(2),
      ])));
    return;
  }

  if (state.report === 'clients') {
    downloadCsv(`njd-by-client-${stamp}.csv`,
      ['Client', 'Revenue', 'Costs', 'Profit', 'Margin'],
      byClient(state.clientLines).map((row) => [
        row.name,
        (row.revenue / 100).toFixed(2),
        (row.cost / 100).toFixed(2),
        (row.profit / 100).toFixed(2),
        row.margin === null ? '' : `${(row.margin * 100).toFixed(1)}%`,
      ]));
    return;
  }

  const year = state.to.slice(0, 4);
  downloadCsv(`njd-1099-${year}.csv`,
    ['Vendor', 'Email', `Paid in ${year}`, 'Reportable', 'W-9 on file'],
    vendorTotals(state.expenses, state.vendors, year).map((row) => [
      row.vendor.name,
      row.vendor.email || '',
      (row.paid / 100).toFixed(2),
      row.reportable ? 'yes' : 'no',
      row.vendor.tax_id_on_file ? 'yes' : 'no',
    ]));
}

// Controls
// ---------------------------------------------------------------------------

/**
 * Which controls a report actually uses.
 *
 * A balance sheet is as-at a date and has no start; a 1099 summary is a whole
 * calendar year and has neither. Showing a "from" box that changes nothing is
 * how a screen teaches people not to trust its controls.
 */
function buildControls() {
  const needsFrom = ['pl', 'clients'].includes(state.report);
  const needsBasis = state.report === 'pl';

  const picker = el('select', {
    id: 'report-kind',
    onchange: async (event) => {
      state.report = event.target.value;
      const url = new URL(window.location.href);
      url.searchParams.set('report', state.report);
      window.history.replaceState({}, '', url);
      buildControls();
      await reload();
    },
  }, REPORTS.map((row) => el('option', {
    value: row.key, text: row.label, selected: row.key === state.report,
  })));

  const from = el('input', {
    type: 'date', id: 'report-from', value: state.from,
    onchange: async (event) => { state.from = event.target.value; await reload(); },
  });

  const to = el('input', {
    type: 'date', id: 'report-to', value: state.to,
    onchange: async (event) => { state.to = event.target.value; await reload(); },
  });

  const basis = el('select', {
    id: 'report-basis',
    onchange: async (event) => { state.basis = event.target.value; await reload(); },
  }, [
    el('option', { value: 'accrual', text: 'Accrual — when invoiced', selected: state.basis === 'accrual' }),
    el('option', { value: 'cash', text: 'Cash — when paid', selected: state.basis === 'cash' }),
  ]);

  mount(controls,
    el('div', { class: 'form-field' }, [
      el('label', { for: 'report-kind', text: 'Report' }), picker,
    ]),
    needsFrom
      ? el('div', { class: 'form-field' }, [
        el('label', { for: 'report-from', text: 'From' }), from,
      ])
      : null,
    el('div', { class: 'form-field' }, [
      // The by-month spread reads the whole financial year this date falls in,
      // so "As at" would misdescribe it.
      el('label', { for: 'report-to',
        // eslint-disable-next-line no-nested-ternary
        text: needsFrom ? 'To' : (state.report === 'months' ? 'Year through' : 'As at') }),
      to,
    ]),
    needsBasis
      ? el('div', { class: 'form-field' }, [
        el('label', { for: 'report-basis', text: 'Basis' }), basis,
      ])
      : null,
  );
}

// The year-end pack
// ---------------------------------------------------------------------------

/**
 * One financial year, assembled the way a preparer wants it.
 *
 * The year is offered as a list rather than as two date boxes, because "which
 * year are you filing" is the actual question and a pair of dates is four
 * chances to get it slightly wrong. The financial year start is respected, so a
 * studio on a July year gets July-to-June.
 */
function packPanel() {
  const thisYear = Number(todayIso().slice(0, 4));
  const startMonth = (state.settings && state.settings.fiscal_year_start_month) || 1;

  const years = [thisYear, thisYear - 1, thisYear - 2, thisYear - 3];

  const picker = el('select', { id: 'pack-year' },
    years.map((year) => el('option', {
      value: String(year),
      // A financial year that straddles two calendar years should say so.
      text: startMonth === 1 ? String(year) : `${year}–${year + 1}`,
      // Last year is the one being filed for most of the time this is used.
      selected: year === thisYear - 1,
    })));

  const status = el('p', { class: 'progress__label', hidden: true });

  // A financial year runs from its start date to the day before the same date
  // a year later, which is right whether it starts in January or in July.
  function range() {
    const year = Number(picker.value);
    const month = String(startMonth).padStart(2, '0');
    return {
      from: `${year}-${month}-01`,
      to: dayBefore(`${year + 1}-${month}-01`),
    };
  }

  let fileCount = 0;

  async function withPack(label, run) {
    const { from, to } = range();
    status.hidden = false;
    status.className = 'progress__label';
    status.textContent = `Pulling ${from} to ${to} together…`;

    try {
      const pack = await loadPack({ from, to });
      await run(pack);
      status.className = 'notice notice--ok';
      status.textContent = label(pack);
    } catch (error) {
      status.className = 'notice notice--error';
      status.textContent = error.message;
    }
  }

  return el('section', { class: 'panel' }, [
    panelHead('Year-end pack for your accountant',
      el('div', { class: 'btn-row' }, [
        el('button', {
          class: 'btn btn--small',
          type: 'button',
          text: 'Print / save as PDF',
          onclick: () => withPack(
            () => 'Pack built. Save it as a PDF from the print dialog.',
            (pack) => printPack(pack),
          ),
        }),
        el('button', {
          class: 'btn btn--ghost btn--small',
          type: 'button',
          text: 'Download the CSVs',
          onclick: () => withPack(
            (pack) => `${fileCount} files downloaded for `
              + `${String(pack.to).slice(0, 4)}. Send the folder as it is.`,
            async (pack) => { fileCount = await downloadPack(pack); },
          ),
        }),
      ]),
      'Everything a CPA asks for, for one financial year: the trial balance, both '
      + 'bases of the profit and loss, the balance sheet, the full general ledger, '
      + 'what was owed at year end, fixed asset additions, owner\'s draws and the '
      + '1099 list. The PDF is to read; the CSVs are to import.'),
    el('div', { class: 'filters' }, [
      el('div', { class: 'form-field' }, [
        el('label', { for: 'pack-year', text: 'Financial year' }),
        picker,
      ]),
    ]),
    status,
  ]);
}

async function main() {
  const ctx = await bootstrap({ requireAdmin: true });
  if (!ctx) return;

  const params = new URLSearchParams(window.location.search);
  const wanted = params.get('report');
  if (REPORTS.some((row) => row.key === wanted)) state.report = wanted;

  try {
    state.settings = await loadSettings();
  } catch (error) {
    renderError(error);
    return;
  }

  state.basis = (state.settings && state.settings.default_basis) || 'accrual';
  state.to = todayIso();
  state.from = fiscalYearStart(state.to,
    state.settings && state.settings.fiscal_year_start_month);

  const current = () => REPORTS.find((row) => row.key === state.report) || REPORTS[0];

  const panel = el('section', { class: 'panel' }, [
    panelHead('Reports', el('button', {
      class: 'btn btn--ghost btn--small',
      type: 'button',
      text: 'Export CSV',
      onclick: () => {
        if (state.loading) {
          toast('Still working the numbers out — try again in a moment.', 'error');
          return;
        }
        exportCsv();
      },
    }), current().blurb),
    controls,
    body,
  ]);

  mount(byId('portal-root'),
    el('p', { class: 'breadcrumb' }, [el('a', { href: '/portal/admin/ledger/', text: '← Ledger' })]),
    el('div', { class: 'page-head' }, [
      el('div', {}, [
        el('h1', { text: 'Reports' }),
        el('p', { text: 'Everything an accountant asks for, and the two numbers a '
                      + 'studio owner actually steers by.' }),
      ]),
    ]),
    panel,
    packPanel(),
  );

  buildControls();
  await reload();
}

main();
