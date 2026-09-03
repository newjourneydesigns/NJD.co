// ---------------------------------------------------------------------------
// The reports: one tax year, and the files to hand over with it.
//
// A one-person LLC files a Schedule C, on a cash basis, for a calendar year.
// Everything the preparer asks for is derivable from three tables — what
// came in (payments), what went out (expenses, by Schedule C line) and what
// was still owed at the year's end (invoices) — so this page is one year at
// a time, chosen from a picker rather than typed as two dates: "which year
// are you filing" is the actual question, and a pair of dates is four
// chances to get it slightly wrong.
//
// Four sections under a jump bar: the summary the return is filled from,
// the same year by client and by month, and the 1099-NEC list. And four
// CSVs, because the point of keeping books is eventually to hand them to
// somebody else. There is no print pack: the CSVs import, and the summary
// on screen prints as any page does.
//
// Every sum is made in reports-model.js, where node --test can hold it to
// account; this file loads rows and draws them. The loaders are its own and
// name only the columns they read — the invoices, expenses and clients
// screens each keep theirs, by agreement.
// ---------------------------------------------------------------------------

import { supabase, errorMessage } from './client.js';
import { bootstrap, renderError } from './shell.js';
import {
  el, mount, byId, toast, figure, figureRow, panelHead, table, stackedCell, filterField,
} from './ui.js';
import { formatMoney } from './money.js';
import { isoToday } from './doc-common.js';
import { downloadCsv } from './csv.js';
import { sectionNav } from './section-nav.js';
import {
  DEFAULT_NEC_THRESHOLD_CENTS,
  byClient,
  byMonth,
  contractorsCsv,
  expensesCsv,
  invoicesCsv,
  paymentsCsv,
  taxYearSummary,
  vendors1099,
  yearChoices,
  yearOf,
} from './reports-model.js';

const state = {
  year: '',
  years: [],
  threshold: DEFAULT_NEC_THRESHOLD_CENTS,
  clients: [],
  categories: [],
  vendors: [],
  invoices: [],
  payments: [],
  expenses: [],
};

// The four panels are built once and refilled on every change of year, so
// the jump bar's targets never move.
const panels = {
  summary: el('section', { class: 'panel' }),
  clients: el('section', { class: 'panel' }),
  months: el('section', { class: 'panel' }),
  contractors: el('section', { class: 'panel' }),
};

// Loading
// ---------------------------------------------------------------------------

function unwrap(result) {
  if (result.error) throw new Error(errorMessage(result.error));
  return result.data || [];
}

async function loadClients() {
  return unwrap(await supabase.from('clients').select('id, name, legal_name').order('name'));
}

/** Archived categories included: an expense booked to one in March is still
 *  on that Schedule C line in April. */
async function loadCategories() {
  return unwrap(await supabase
    .from('expense_categories')
    .select('id, code, name, schedule_c_line, half_deductible, position, archived_at')
    .order('position')
    .order('name'));
}

/** Archived vendors included, for the same reason: a contractor let go in
 *  June still gets a 1099 in January. */
async function loadVendors() {
  return unwrap(await supabase
    .from('vendors')
    .select('id, name, email, phone, address, files_1099, tax_id_on_file, archived_at')
    .order('name'));
}

/**
 * Every invoice. The receivable at a year's end is "raised by then, less
 * paid by then", which needs invoices from before the year as well as in
 * it, and paid_at can fall in a later year than issued_on — so no date
 * bound. Never the snapshot.
 */
const INVOICE_COLUMNS = `
  id, client_id, number, status, issued_on, due_on, project_name, purchase_order,
  subtotal_cents, tax_cents, total_cents, paid_cents, paid_at, created_at
`;

async function loadInvoices() {
  return unwrap(await supabase
    .from('invoices')
    .select(INVOICE_COLUMNS)
    .order('issued_on', { ascending: true })
    .order('created_at', { ascending: true }));
}

/** Every payment up to the year's end: the year's own are gross receipts,
 *  the earlier ones settle earlier invoices in the receivable figure. */
const PAYMENT_COLUMNS = `
  id, invoice_id, client_id, received_on, amount_cents, method, reference, notes, created_at
`;

async function loadPayments(year) {
  return unwrap(await supabase
    .from('payments')
    .select(PAYMENT_COLUMNS)
    .lte('received_on', `${year}-12-31`)
    .order('received_on', { ascending: true })
    .order('created_at', { ascending: true }));
}

/** The year's expenses, each with the ids of its receipts for the count. */
const EXPENSE_COLUMNS = `
  id, spent_on, vendor_id, vendor_name, category_id, amount_cents, description,
  method, reference, client_id, billable, billed_invoice_id,
  place, business_purpose, attendees, created_at,
  receipts:expense_receipts(id)
`;

async function loadExpenses(year) {
  return unwrap(await supabase
    .from('expenses')
    .select(EXPENSE_COLUMNS)
    .gte('spent_on', `${year}-01-01`)
    .lte('spent_on', `${year}-12-31`)
    .order('spent_on', { ascending: true })
    .order('created_at', { ascending: true }));
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

/** What does not change with the year. */
async function loadStatic() {
  const [clients, categories, vendors, invoices, threshold] = await Promise.all([
    loadClients(), loadCategories(), loadVendors(), loadInvoices(), loadThreshold(),
  ]);
  Object.assign(state, {
    clients, categories, vendors, invoices, threshold,
  });
}

/** What does. */
async function loadYear(year) {
  const [payments, expenses] = await Promise.all([loadPayments(year), loadExpenses(year)]);
  Object.assign(state, { payments, expenses });
}

// Shared bits
// ---------------------------------------------------------------------------

function plural(count, one, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

function money(cents) {
  return el('td', { class: 'is-numeric', text: formatMoney(cents) });
}

/** A one-line figure between sections — a subtotal that belongs to no
 *  table. `tone` colours the number: 'good', 'bad', or nothing. */
function reportFigure(label, value, tone) {
  return el('p', { class: tone ? `report__figure report__figure--${tone}` : 'report__figure' }, [
    el('span', { text: label }),
    el('strong', { text: value }),
  ]);
}

function totalRow(label, cells) {
  return el('tr', { class: 'report__total' }, [el('td', { text: label }), ...cells.map(money)]);
}

// The tax year summary
// ---------------------------------------------------------------------------

/** One Schedule C line: its categories, the full amount and the deductible
 *  amount side by side. Meals are the only line where the two differ, and
 *  showing both columns on every line is what makes that visible. */
function lineSection(line) {
  const rows = line.categories.map((category) => el('tr', {}, [
    el('td', {}, stackedCell([
      category.name,
      [
        plural(category.count, 'item'),
        category.half_deductible ? '50% deductible' : '',
      ].filter(Boolean).join(' · '),
    ])),
    money(category.total_cents),
    money(category.deductible_cents),
  ]));

  return el('div', { class: 'report__section' }, [
    el('h3', { text: line.label }),
    table(['Category', 'Amount', 'Deductible'], [
      ...rows,
      totalRow(`Line ${line.schedule_c_line} total`, [line.total_cents, line.deductible_cents]),
    ], { className: 'report__table' }),
  ]);
}

function renderSummary() {
  const s = taxYearSummary({
    payments: state.payments,
    invoices: state.invoices,
    expenses: state.expenses,
    categories: state.categories,
    year: state.year,
  });

  const figures = figureRow([
    figure('Gross receipts', formatMoney(s.gross_receipts_cents), 'Payments received in the year'),
    figure('Deductible expenses', formatMoney(s.deductible_total_cents),
      s.expenses_total_cents === s.deductible_total_cents
        ? `${plural(s.expense_count, 'expense')}`
        : `${formatMoney(s.expenses_total_cents)} as spent, meals at 50%`),
    figure('Net', formatMoney(s.net_cents), 'Gross receipts less deductible expenses',
      s.net_cents < 0 ? 'bad' : null),
    figure('Receivable at year end', formatMoney(s.receivable_at_year_end_cents),
      s.receivable_at_year_end_count
        ? `${plural(s.receivable_at_year_end_count, 'invoice')} still owed on Dec 31`
        : 'Nothing was owed on Dec 31'),
  ]);
  figures.classList.add('figure-row--four');

  mount(panels.summary,
    panelHead(`Tax year ${state.year}`, null,
      'Cash basis, calendar year: what Schedule C asks for, in the order it asks. '
      + 'Income is what was actually received; expenses are grouped by the line they '
      + 'go on, with business meals shown in full and at the 50% that is deductible.'),
    figures,
    reportFigure('Sales tax collected on invoices paid this year',
      formatMoney(s.sales_tax_collected_cents)),
    s.unreceipted_count
      ? el('p', { class: 'notice notice--warn' }, [
        `${plural(s.unreceipted_count, 'expense')} in ${state.year} `
        + `${s.unreceipted_count === 1 ? 'has' : 'have'} no receipt on file. `,
        el('a', { href: '/portal/expenses/', text: 'Add them from Expenses.' }),
      ])
      : null,
    el('h3', { text: 'Expenses by Schedule C line' }),
    s.by_line.length
      ? el('div', {}, [
        ...s.by_line.map(lineSection),
        reportFigure('Total expenses, as spent', formatMoney(s.expenses_total_cents)),
        reportFigure('Total deductible', formatMoney(s.deductible_total_cents)),
      ])
      : el('p', { class: 'empty', text: `No expenses recorded for ${state.year}.` }),
  );
}

// By client
// ---------------------------------------------------------------------------

function renderClients() {
  const rows = byClient({
    invoices: state.invoices,
    payments: state.payments,
    expenses: state.expenses,
    clients: state.clients,
    year: state.year,
  });

  const totals = rows.reduce((sum, row) => ({
    invoiced: sum.invoiced + row.invoiced,
    received: sum.received + row.received,
    expenses: sum.expenses + row.expenses,
    outstanding: sum.outstanding + row.outstanding,
  }), {
    invoiced: 0, received: 0, expenses: 0, outstanding: 0,
  });

  mount(panels.clients,
    panelHead('By client', null,
      `What each client was invoiced in ${state.year}, what they actually paid, what was `
      + 'spent on their behalf, and what they still owe on that year\'s invoices.'),
    rows.length
      ? table(['Client', 'Invoiced', 'Received', 'Expenses', 'Outstanding'], [
        ...rows.map((row) => el('tr', {}, [
          el('td', { text: row.client }),
          money(row.invoiced),
          money(row.received),
          money(row.expenses),
          money(row.outstanding),
        ])),
        totalRow('Total', [totals.invoiced, totals.received, totals.expenses, totals.outstanding]),
      ])
      : el('p', { class: 'empty', text: `Nothing was invoiced, received or spent for a client in ${state.year}.` }),
  );
}

// By month
// ---------------------------------------------------------------------------

function renderMonths() {
  const rows = byMonth({ payments: state.payments, expenses: state.expenses, year: state.year });
  const received = rows.reduce((sum, row) => sum + row.received, 0);
  const spent = rows.reduce((sum, row) => sum + row.spent, 0);

  mount(panels.months,
    panelHead('By month', null,
      'Where the year moved: what came in and what went out, a month at a time. '
      + 'Expenses here are as spent, before the meals limit.'),
    table(['Month', 'Received', 'Spent', 'Net'], [
      ...rows.map((row) => el('tr', {}, [
        el('td', { text: `${row.label} ${state.year}` }),
        money(row.received),
        money(row.spent),
        money(row.net),
      ])),
      totalRow(`Total ${state.year}`, [received, spent, received - spent]),
    ]),
  );
}

// 1099 contractors
// ---------------------------------------------------------------------------

function renderContractors() {
  const rows = vendors1099({
    expenses: state.expenses,
    vendors: state.vendors,
    year: state.year,
    thresholdCents: state.threshold,
  });
  const reportable = rows.filter((row) => row.reportable);
  const missing = rows.filter((row) => row.missing_tax_id);

  mount(panels.contractors,
    panelHead('1099 contractors', null,
      `Everyone paid in ${state.year}, against the ${formatMoney(state.threshold)} 1099-NEC `
      + 'threshold set in Admin. A form is due for each contractor flagged on the Vendors '
      + 'panel who was paid that much or more; the deadline is January 31st.'),
    rows.length
      ? table(['Vendor', `Paid in ${state.year}`, 'Threshold', 'Needs a 1099', 'W-9'],
        rows.map((row) => el('tr', { class: row.vendor.archived_at ? 'is-archived' : null }, [
          el('td', { text: row.vendor.name }),
          money(row.total_cents),
          el('td', {}, [
            row.over_threshold
              ? el('span', { class: 'pill pill--amber', text: 'Over' })
              : el('span', { class: 'progress__label', text: 'Under' }),
          ]),
          el('td', {}, [
            row.reportable
              ? el('span', { class: 'pill pill--amber', text: 'Yes' })
              : el('span', { class: 'progress__label',
                text: row.files_1099 ? 'Under the threshold' : 'Not a contractor' }),
          ]),
          el('td', {}, [
            row.files_1099
              ? el('span', {
                class: row.tax_id_on_file ? 'pill pill--green' : 'pill pill--red',
                text: row.tax_id_on_file ? 'On file' : 'Missing',
              })
              : el('span', { class: 'progress__label', text: '—' }),
          ]),
        ])))
      : el('p', { class: 'empty', text: `No vendor spend recorded for ${state.year}.` }),
    missing.length
      ? el('p', { class: 'notice notice--error',
        text: `${plural(missing.length, 'contractor')} over the threshold with no W-9 on file. `
          + `Collect ${missing.length === 1 ? 'it' : 'them'} now — chasing a W-9 in January, `
          + 'from somebody who no longer works with you, is the hardest version of this job.' })
      : el('p', { class: 'progress__label',
        text: `${plural(reportable.length, '1099')} to file for ${state.year}`
          + `${reportable.length ? ', and every W-9 is on file.' : '.'}` }),
  );
}

// Export
// ---------------------------------------------------------------------------

function saveCsv(build) {
  const file = build();
  downloadCsv(file.filename, file.headers, file.rows);
  toast(`Saved ${file.filename} — ${plural(file.rows.length, 'row')}.`, 'ok');
}

function csvButtons() {
  const button = (text, build) => el('button', {
    class: 'btn btn--ghost btn--small', type: 'button', text, onclick: () => saveCsv(build),
  });

  return el('div', { class: 'btn-row' }, [
    button('Invoices CSV', () => invoicesCsv({
      invoices: state.invoices, clients: state.clients, year: state.year,
    })),
    button('Payments CSV', () => paymentsCsv({
      payments: state.payments, invoices: state.invoices, clients: state.clients, year: state.year,
    })),
    button('Expenses CSV', () => expensesCsv({
      expenses: state.expenses,
      categories: state.categories,
      vendors: state.vendors,
      clients: state.clients,
      year: state.year,
    })),
    button('1099 CSV', () => contractorsCsv({
      rows: vendors1099({
        expenses: state.expenses,
        vendors: state.vendors,
        year: state.year,
        thresholdCents: state.threshold,
      }),
      year: state.year,
    })),
  ]);
}

// Controls
// ---------------------------------------------------------------------------

function renderAll() {
  renderSummary();
  renderClients();
  renderMonths();
  renderContractors();
}

async function changeYear(year) {
  state.year = year;
  const url = new URL(window.location.href);
  url.searchParams.set('year', year);
  window.history.replaceState({}, '', url);

  for (const panel of Object.values(panels)) {
    mount(panel, el('p', { class: 'skeleton', text: 'Working it out…' }));
  }

  try {
    await loadYear(year);
  } catch (error) {
    toast(errorMessage(error), 'error');
    for (const panel of Object.values(panels)) {
      mount(panel, el('p', { class: 'notice notice--error', text: errorMessage(error) }));
    }
    return;
  }

  renderAll();
}

function buildControls() {
  const picker = el('select', {
    id: 'report-year',
    onchange: (event) => { changeYear(event.target.value); },
  }, state.years.map((year) => el('option', {
    value: year, text: year, selected: year === state.year,
  })));

  return el('div', { class: 'filters' }, [
    filterField('report-year', 'Tax year', picker),
    el('div', { class: 'filters__end' }, [csvButtons()]),
  ]);
}

async function main() {
  const ctx = await bootstrap({ requireAdmin: true });
  if (!ctx) return;

  const today = isoToday();
  state.years = yearChoices(today);
  state.year = yearOf(today);

  // A shared link or the dashboard's "see which" arrives with the year.
  const wanted = new URLSearchParams(window.location.search).get('year');
  if (wanted && state.years.includes(wanted)) state.year = wanted;

  try {
    await loadStatic();
    await loadYear(state.year);
  } catch (error) {
    renderError(error);
    return;
  }

  mount(byId('portal-root'),
    el('div', { class: 'page-head' }, [
      el('div', {}, [
        el('h1', { text: 'Reports' }),
        el('p', { text: 'One tax year at a time, and the files to hand to whoever prepares the return.' }),
      ]),
    ]),
    buildControls(),
    // The jump bar pins under the header; the panels must be direct children
    // of #portal-root for its scroll-spy to measure them.
    sectionNav([
      { id: 'summary', label: 'Tax year', target: panels.summary },
      { id: 'clients', label: 'By client', target: panels.clients },
      { id: 'months', label: 'By month', target: panels.months },
      { id: 'contractors', label: '1099s', target: panels.contractors },
    ]),
    panels.summary,
    panels.clients,
    panels.months,
    panels.contractors,
  );

  renderAll();
}

main();
