// ---------------------------------------------------------------------------
// The front page.
//
// One question, asked seven ways: how is the money, today? What is owed and
// how much of it is late, what this month has brought in and billed, and
// what the year looks like so far. Under the figures, the short list of
// things that are actually wrong — an invoice past due, a draft going stale,
// an expense with no receipt, a contractor with no W-9 — and then the last
// few things that happened.
//
// It is deliberately not a dashboard of everything. An empty attention list
// should be the normal state of affairs, and is the point of the panel: a
// list that always has something in it stops being read. Anything merely
// interesting lives on Reports.
//
// Every sum is made in reports-model.js, where node --test can hold it to
// account; this file loads rows and draws them. The loaders are its own and
// name only the columns it reads — the invoices, expenses and clients
// screens each keep theirs, by agreement.
// ---------------------------------------------------------------------------

import { supabase, errorMessage } from './client.js';
import { bootstrap, renderError } from './shell.js';
import {
  el, mount, byId, fmtDate, figure, figureRow, panelHead,
} from './ui.js';
import { formatMoney } from './money.js';
import { isoToday } from './doc-common.js';
import {
  DEFAULT_NEC_THRESHOLD_CENTS,
  MONTH_SHORT,
  dashboardFigures,
  inMonth,
  invoiceLabel,
  methodLabel,
  monthOf,
  overdueInvoices,
  recentActivity,
  staleDrafts,
  unreceiptedExpenses,
  vendors1099,
  yearOf,
} from './reports-model.js';

/** A draft nobody has touched for longer than this is probably forgotten. */
const STALE_DRAFT_DAYS = 7;

const RECENT_LIMIT = 8;

const state = {
  today: '',
  threshold: DEFAULT_NEC_THRESHOLD_CENTS,
  invoices: [],
  payments: [],
  expenses: [],
  vendors: [],
  clients: [],
};

// Loading
// ---------------------------------------------------------------------------

function unwrap(result) {
  if (result.error) throw new Error(errorMessage(result.error));
  return result.data || [];
}

/**
 * Every invoice, newest first. There is no date bound because an open
 * invoice from two years ago is still owed on, and a one-person business
 * has hundreds of these, not thousands. Columns: what the figures, the
 * attention list and the activity feed read — never the snapshot.
 */
const INVOICE_COLUMNS = `
  id, client_id, number, status, issued_on, due_on,
  total_cents, paid_cents, created_at, updated_at
`;

async function loadInvoices() {
  return unwrap(await supabase
    .from('invoices')
    .select(INVOICE_COLUMNS)
    .order('created_at', { ascending: false }));
}

/** This year's payments: income to date, this month's takings, the feed. */
const PAYMENT_COLUMNS = `
  id, invoice_id, client_id, received_on, amount_cents, method, reference, created_at
`;

async function loadPayments(from) {
  return unwrap(await supabase
    .from('payments')
    .select(PAYMENT_COLUMNS)
    .gte('received_on', from)
    .order('received_on', { ascending: false })
    .order('created_at', { ascending: false }));
}

/** This year's expenses, each with the ids of its receipts — the count is
 *  all the front page needs, and the 1099 list needs vendor_id. */
const EXPENSE_COLUMNS = `
  id, spent_on, vendor_id, vendor_name, category_id, amount_cents, description,
  client_id, created_at,
  receipts:expense_receipts(id)
`;

async function loadExpenses(from) {
  return unwrap(await supabase
    .from('expenses')
    .select(EXPENSE_COLUMNS)
    .gte('spent_on', from)
    .order('spent_on', { ascending: false })
    .order('created_at', { ascending: false }));
}

/** Archived vendors included: a contractor let go in June still gets a
 *  1099 in January. */
async function loadVendors() {
  return unwrap(await supabase
    .from('vendors')
    .select('id, name, files_1099, tax_id_on_file, archived_at')
    .order('name'));
}

async function loadClients() {
  return unwrap(await supabase.from('clients').select('id, name').order('name'));
}

/** The 1099-NEC threshold the owner set in Admin, in cents. */
async function loadThreshold() {
  const result = await supabase
    .from('studio_settings')
    .select('nec_threshold_cents')
    .eq('id', true)
    .maybeSingle();
  if (result.error) throw new Error(errorMessage(result.error));
  const value = result.data ? Number(result.data.nec_threshold_cents) : 0;
  return value > 0 ? value : DEFAULT_NEC_THRESHOLD_CENTS;
}

async function loadAll() {
  const today = isoToday();
  const yearStart = `${yearOf(today)}-01-01`;

  const [invoices, payments, expenses, vendors, clients, threshold] = await Promise.all([
    loadInvoices(),
    loadPayments(yearStart),
    loadExpenses(yearStart),
    loadVendors(),
    loadClients(),
    loadThreshold(),
  ]);

  Object.assign(state, {
    today, invoices, payments, expenses, vendors, clients, threshold,
  });
}

// Names
// ---------------------------------------------------------------------------

function clientName(clientId) {
  const client = state.clients.find((row) => row.id === clientId);
  return (client && client.name) || 'Unknown client';
}

function vendorName(item) {
  const vendor = state.vendors.find((row) => row.id === item.vendor_id);
  return (vendor && vendor.name) || item.vendor_name || '';
}

function plural(count, one, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

/** 'September 2026' for the figure notes. */
function monthLabel(iso) {
  const month = monthOf(iso);
  if (!month) return '';
  return `${MONTH_SHORT[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
}

// The figures
// ---------------------------------------------------------------------------

/**
 * Two rows rather than one rank of seven: what is true right now, then the
 * year so far. Counted columns (reports.css) so neither row strands a tile
 * alone; the default auto-fit row would land four as three-and-one on a
 * tablet.
 */
function renderFigures() {
  const data = dashboardFigures({
    invoices: state.invoices,
    payments: state.payments,
    expenses: state.expenses,
    today: state.today,
  });
  const month = monthLabel(state.today);
  const year = yearOf(state.today);

  const now = figureRow([
    figure('Outstanding', formatMoney(data.outstanding_cents),
      'On issued and sent invoices'),
    figure('Overdue', formatMoney(data.overdue_cents),
      data.overdue_count
        ? `${plural(data.overdue_count, 'invoice')} past due`
        : 'Nothing is late',
      data.overdue_cents > 0 ? 'bad' : null),
    figure('Received this month', formatMoney(data.received_month_cents), month),
    figure('Invoiced this month', formatMoney(data.invoiced_month_cents), month),
  ]);
  now.classList.add('figure-row--four');

  const ytd = figureRow([
    figure('Income YTD', formatMoney(data.income_ytd_cents), `Payments received in ${year}`),
    figure('Expenses YTD', formatMoney(data.expenses_ytd_cents), `Spent in ${year}`),
    figure('Net YTD', formatMoney(data.net_ytd_cents), 'Income less expenses, cash basis',
      data.net_ytd_cents < 0 ? 'bad' : null),
  ]);
  ytd.classList.add('figure-row--three');

  return [now, ytd];
}

// Needs attention
// ---------------------------------------------------------------------------

function attentionRow(tone, text, href, action) {
  return el('div', { class: `notice notice--${tone} attention-row` }, [
    el('span', { text }),
    el('a', { href, text: action }),
  ]);
}

/**
 * Only things that are actually wrong or actually waiting. Each overdue
 * invoice and each stale draft gets its own line with its own link, because
 * the next step is to open that one; the receipts and the W-9s are counts,
 * because the next step is a page.
 */
function renderAttention() {
  const jobs = [];
  const year = yearOf(state.today);
  const month = monthOf(state.today);

  for (const row of overdueInvoices(state.invoices, state.today)) {
    jobs.push(attentionRow('warn',
      `${invoiceLabel(row.invoice.number)} · ${clientName(row.invoice.client_id)} · `
      + `${formatMoney(row.outstanding)} · ${plural(row.days, 'day')} late`,
      `/portal/invoice/?id=${encodeURIComponent(row.invoice.id)}`,
      'Open'));
  }

  for (const row of staleDrafts(state.invoices, state.today, STALE_DRAFT_DAYS)) {
    jobs.push(attentionRow('info',
      `${invoiceLabel(row.invoice.number)} for ${clientName(row.invoice.client_id)} `
      + `has been a draft for ${plural(row.days, 'day')}. Issue it or delete it.`,
      `/portal/invoice/?id=${encodeURIComponent(row.invoice.id)}`,
      'Open'));
  }

  const unreceipted = unreceiptedExpenses(
    state.expenses.filter((row) => inMonth(row.spent_on, month)),
  );
  if (unreceipted.length) {
    jobs.push(attentionRow('warn',
      `${plural(unreceipted.length, 'expense')} this month ${unreceipted.length === 1 ? 'has' : 'have'} `
      + 'no receipt on file. A deduction without one does not survive an audit.',
      '/portal/expenses/',
      'Add receipts'));
  }

  const missing = vendors1099({
    expenses: state.expenses, vendors: state.vendors, year, thresholdCents: state.threshold,
  }).filter((row) => row.missing_tax_id);
  if (missing.length) {
    jobs.push(attentionRow('warn',
      `${plural(missing.length, 'contractor')} ${missing.length === 1 ? 'is' : 'are'} over the `
      + `${formatMoney(state.threshold)} 1099 threshold with no W-9 on file. `
      + 'Chasing one in January is much harder than now.',
      `/portal/reports/?year=${encodeURIComponent(year)}#contractors`,
      'See which'));
  }

  if (!jobs.length) {
    return el('p', { class: 'empty', text: 'Nothing needs attention. The books are up to date.' });
  }

  return el('div', { class: 'doc-list' }, jobs);
}

// Recent
// ---------------------------------------------------------------------------

/** Money in reads '+$500.00', money out '−$12.00'; a refund either way
 *  flips the sign and says so. */
function amountText(item) {
  const amount = item.amount_cents;
  if (item.kind === 'expense') {
    return amount >= 0 ? `−${formatMoney(amount)}` : `+${formatMoney(-amount)}`;
  }
  if (item.kind === 'payment') {
    return amount >= 0 ? `+${formatMoney(amount)}` : `−${formatMoney(-amount)}`;
  }
  return formatMoney(amount);
}

function recentRow(item) {
  let title = '';
  let meta = [];
  let href = '';
  let out = false;

  if (item.kind === 'invoice') {
    title = `${invoiceLabel(item.number)} · ${clientName(item.client_id)}`;
    meta = ['Invoice', item.status, fmtDate(item.date)];
    href = `/portal/invoice/?id=${encodeURIComponent(item.id)}`;
  } else if (item.kind === 'payment') {
    title = `Payment from ${clientName(item.client_id)}`;
    meta = [
      item.amount_cents < 0 ? 'Refund' : 'Payment',
      methodLabel(item.method),
      fmtDate(item.date),
    ];
    href = item.invoice_id ? `/portal/invoice/?id=${encodeURIComponent(item.invoice_id)}` : '/portal/invoices/';
  } else {
    title = vendorName(item) || item.description || 'Expense';
    meta = [
      item.amount_cents < 0 ? 'Supplier refund' : 'Expense',
      vendorName(item) ? item.description : '',
      fmtDate(item.date),
    ];
    href = '/portal/expenses/';
    out = item.amount_cents >= 0;
  }

  return el('div', { class: 'doc-row' }, [
    el('div', {}, [
      el('p', { class: 'doc-row__name', text: title }),
      el('p', { class: 'doc-row__meta' },
        meta.filter(Boolean).map((line) => el('span', { text: line }))),
    ]),
    el('div', { class: 'recent-row__end' }, [
      el('span', {
        class: out ? 'recent-row__amount recent-row__amount--out' : 'recent-row__amount',
        text: amountText(item),
      }),
      el('a', { class: 'btn btn--ghost btn--tiny', href, text: 'Open' }),
    ]),
  ]);
}

function renderRecent() {
  const items = recentActivity({
    invoices: state.invoices, payments: state.payments, expenses: state.expenses,
  }, RECENT_LIMIT);

  if (!items.length) {
    return el('p', {
      class: 'empty',
      text: 'Nothing yet. Raise the first invoice from Invoices, or record an expense.',
    });
  }

  return el('div', { class: 'doc-list' }, items.map(recentRow));
}

// The page
// ---------------------------------------------------------------------------

function panel(title, body, lede, action) {
  return el('section', { class: 'panel' }, [panelHead(title, action, lede), body]);
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

  mount(byId('portal-root'),
    el('div', { class: 'page-head' }, [
      el('div', {}, [
        el('h1', { text: 'Dashboard' }),
        el('p', { text: 'The money, today: what is owed, what came in, what went out.' }),
      ]),
      el('div', { class: 'page-head__actions' }, [
        link('/portal/invoices/', 'Invoices'),
        link('/portal/expenses/', 'Expenses'),
        link('/portal/reports/', 'Reports', false),
      ]),
    ]),
    renderFigures(),
    panel('Needs attention', renderAttention()),
    panel('Recent', renderRecent(),
      'The last few things that happened, across invoices, payments and expenses.'),
  );
}

main();
