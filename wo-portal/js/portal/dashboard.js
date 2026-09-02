// ---------------------------------------------------------------------------
// The ledger's front page.
//
// One question, asked four ways: how is the business doing? What is in the
// accounts right now, what has this month earned, who owes money, and what
// still needs doing before the books can be trusted.
//
// It is deliberately not a dashboard of everything. The four numbers at the top
// are the ones a studio owner actually looks at, and the list underneath is
// work — a reconciliation left half done, a contractor over the 1099 threshold
// with no W-9. Anything that is merely interesting lives on Reports.
// ---------------------------------------------------------------------------

import { bootstrap, renderError } from './shell.js';
import { el, mount, byId, figure, figureRow, fmtDate, table } from './ui.js';
import { formatMoney } from './sow-fees.js';
import { invoiceLabel } from './invoice-catalog.js';
import {
  CASH_SUBTYPES,
  accountLabel,
  agingReport,
  dayBefore,
  fiscalYearStart,
  formatSigned,
  profitAndLoss,
  vendorTotals,
} from './ledger-catalog.js';
import {
  loadBalances,
  loadExpenses,
  loadOpenInvoices,
  loadPayments,
  loadSettings,
  loadVendors,
} from './ledger-data.js';

const state = {
  settings: null,
  cash: [],
  monthToDate: [],
  yearToDate: [],
  invoices: [],
  vendors: [],
  expenses: [],
  payments: [],
};

function todayIso() {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
}

function monthStart(iso) {
  return `${String(iso).slice(0, 7)}-01`;
}

async function loadAll() {
  const today = todayIso();
  const settings = await loadSettings();
  const fyStart = fiscalYearStart(today, settings && settings.fiscal_year_start_month);

  const [cash, monthToDate, yearToDate, invoices, vendors, expenses, payments] =
    await Promise.all([
      // Null `from`: a bank balance is everything that ever moved through it,
      // not this month's movement.
      loadBalances({ to: today }),
      loadBalances({ from: monthStart(today), to: today }),
      loadBalances({ from: fyStart, to: today }),
      loadOpenInvoices(),
      loadVendors(),
      loadExpenses({ from: `${today.slice(0, 4)}-01-01`, to: today }),
      loadPayments({ from: monthStart(today), to: today }),
    ]);

  Object.assign(state, {
    settings, cash, monthToDate, yearToDate, invoices, vendors, expenses, payments,
  });
}

/**
 * The four numbers.
 *
 * Cash first, because it is the one that decides what the studio can do this
 * week. Profit is shown for the year rather than the month — a month is too
 * short a window for a business with two invoices in it to say anything — and
 * owed is split into "owed" and "of which late", because those are two
 * different problems.
 */
function figures() {
  const cashAccounts = state.cash.filter((row) => (
    CASH_SUBTYPES.includes(row.subtype) && !row.archived
  ));
  const inTheBank = cashAccounts
    .filter((row) => row.subtype !== 'credit_card')
    .reduce((total, row) => total + row.balance, 0);
  const owedOnCards = cashAccounts
    .filter((row) => row.subtype === 'credit_card')
    .reduce((total, row) => total + row.balance, 0);

  const year = profitAndLoss(state.yearToDate);
  const month = profitAndLoss(state.monthToDate);
  const aging = agingReport(state.invoices, todayIso());

  return { cashAccounts, inTheBank, owedOnCards, year, month, aging };
}

function renderFigures(data) {
  const yearLabel = `Year to date${state.settings && state.settings.fiscal_year_start_month > 1
    ? ' (financial year)' : ''}`;

  return figureRow([
    figure('In the bank', formatMoney(data.inTheBank),
      data.owedOnCards ? `${formatMoney(data.owedOnCards)} owed on cards` : null),
    figure(yearLabel, formatSigned(data.year.netProfit),
      `${formatMoney(data.year.revenueTotal)} in, ${formatMoney(
        data.year.costTotal + data.year.operatingTotal + data.year.otherExpenseTotal)} out`,
      data.year.netProfit < 0 ? 'bad' : null),
    figure('Owed to us', formatMoney(data.aging.total),
      data.aging.overdue
        ? `${formatMoney(data.aging.overdue)} of it late`
        : 'None of it late'),
    figure('This month', formatSigned(data.month.netProfit),
      `${formatMoney(data.month.revenueTotal)} invoiced · `
      + `${formatMoney(state.payments.reduce((t, p) => t + (Number(p.amount_cents) || 0), 0))} received`,
      data.month.netProfit < 0 ? 'bad' : null),
  ]);
}

/**
 * What needs doing.
 *
 * Only things that are actually wrong or actually waiting — an empty list here
 * should be the normal state of affairs, and is the point of the panel. A list
 * that always has something in it stops being read.
 */
function renderAttention(data) {
  const jobs = [];

  const unreconciled = data.cashAccounts.filter((row) => row.subtype !== 'credit_card');
  if (!state.cash.some((row) => row.debits || row.credits)) {
    jobs.push({
      tone: 'info',
      text: 'The books have no entries yet. Start with your opening balances — '
          + 'what each account held on the day you started keeping them here.',
      href: '/portal/admin/ledger/entries/',
      action: 'Enter opening balances',
    });
  }

  if (data.aging.overdue) {
    const late = data.aging.clients.filter((row) => row.total - row.current > 0);
    jobs.push({
      tone: 'warn',
      text: `${formatMoney(data.aging.overdue)} is overdue across `
          + `${late.length} client${late.length === 1 ? '' : 's'}.`,
      href: '/portal/admin/ledger/reports/?report=aging',
      action: 'See who',
    });
  }

  const missing1099 = vendorTotals(state.expenses, state.vendors, todayIso().slice(0, 4))
    .filter((row) => row.missingTaxId);
  if (missing1099.length) {
    jobs.push({
      tone: 'warn',
      text: `${missing1099.length} contractor${missing1099.length === 1 ? '' : 's'} `
          + `${missing1099.length === 1 ? 'is' : 'are'} over the $600 1099 threshold `
          + 'with no W-9 on file. Chasing one in January is much harder than now.',
      href: '/portal/admin/ledger/reports/?report=1099',
      action: 'See which',
    });
  }

  const uncategorised = state.yearToDate.find((row) => row.system_key === 'sales' && row.balance);
  if (uncategorised && unreconciled.length) {
    jobs.push({
      tone: 'info',
      text: `${formatMoney(uncategorised.balance)} of revenue is sitting in the `
          + 'catch-all income account. Splitting it across the service lines is what '
          + 'makes the profit and loss worth reading.',
      href: '/portal/admin/ledger/reports/?report=pl',
      action: 'Open the profit and loss',
    });
  }

  if (state.settings && state.settings.closed_through) {
    jobs.push({
      tone: 'ok',
      text: `The books are closed through ${fmtDate(state.settings.closed_through)}. `
          + 'Nothing on or before that date can be changed.',
      href: '/portal/admin/ledger/accounts/',
      action: 'Change',
    });
  }

  if (!jobs.length) {
    return el('p', { class: 'empty', text: 'Nothing needs attention. The books are up to date.' });
  }

  return el('div', { class: 'doc-list' }, jobs.map((job) => el('div', {
    class: `notice notice--${job.tone} attention-row`,
  }, [
    el('span', { text: job.text }),
    el('a', { href: job.href, text: job.action }),
  ])));
}

function renderAccounts(data) {
  if (!data.cashAccounts.length) {
    return el('p', {
      class: 'empty',
      text: 'No bank or card accounts in the chart yet.',
    });
  }

  // A table rather than a definition list: these are two columns of the same
  // kind of thing, and the amounts have to line up under each other to be
  // readable as a set. The register link is the point of the panel — "what is
  // in this account" is always followed by "and what went through it".
  return table(['Account', 'Balance', ''], data.cashAccounts.map((row) => el('tr', {}, [
    el('td', { text: accountLabel(row) }),
    el('td', { class: 'is-numeric', text: formatMoney(row.balance) }),
    el('td', {}, [
      el('a', {
        class: 'btn btn--ghost btn--tiny',
        href: `/portal/admin/ledger/entries/?account=${encodeURIComponent(row.account_id)}`,
        text: 'Register',
      }),
    ]),
  ])));
}

function renderRecent() {
  if (!state.payments.length) {
    return el('p', { class: 'empty', text: 'No payments received this month.' });
  }

  return el('div', { class: 'doc-list' }, state.payments.slice(0, 8).map((row) => el('div', {
    class: 'doc-row',
  }, [
    el('div', { class: 'doc-row__main' }, [
      el('p', { class: 'doc-row__name', text: formatMoney(row.amount_cents) }),
      el('p', { class: 'doc-row__meta' }, [
        el('span', { text: (row.clients && row.clients.name) || 'Unknown client' }),
        row.invoices ? el('span', { text: `INV ${invoiceLabel(row.invoices.number)}` }) : null,
        el('span', { text: fmtDate(row.received_on) }),
      ]),
    ]),
  ])));
}

function panel(title, body, lede, action) {
  return el('section', { class: 'panel' }, [
    el('div', { class: 'panel__head' }, [
      el('div', {}, [
        el('h2', { text: title }),
        lede ? el('p', { class: 'progress__label', text: lede }) : null,
      ]),
      action ? el('div', { class: 'page-head__actions' }, [action]) : null,
    ]),
    body,
  ]);
}

function link(href, text, ghost = true) {
  return el('a', { class: `btn btn--small${ghost ? ' btn--ghost' : ''}`, href, text });
}

async function main() {
  const ctx = await bootstrap({ requireAdmin: true });
  if (!ctx) return;

  try {
    await loadAll();
  } catch (error) {
    renderError(error);
    return;
  }

  const data = figures();

  mount(byId('portal-root'),
    el('div', { class: 'page-head' }, [
      el('div', {}, [
        el('h1', { text: 'Ledger' }),
        el('p', {
          text: 'The studio\'s books. Every invoice issued and every payment '
              + 'received is already in here.',
        }),
      ]),
      el('div', { class: 'page-head__actions' }, [
        link('/portal/admin/ledger/expenses/', 'Expenses'),
        link('/portal/admin/ledger/drives/', 'Drives'),
        link('/portal/admin/ledger/entries/', 'Journal'),
        link('/portal/admin/ledger/reconcile/', 'Reconcile'),
        link('/portal/admin/ledger/reports/', 'Reports', false),
      ]),
    ]),
    renderFigures(data),
    panel('Needs attention', renderAttention(data)),
    panel('Accounts', renderAccounts(data),
      'What each account holds right now.',
      link('/portal/admin/ledger/accounts/', 'Chart of accounts')),
    panel('Received this month', renderRecent(), null,
      link('/portal/admin/invoices/', 'Invoices')),
  );
}

main();
