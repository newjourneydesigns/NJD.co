// ---------------------------------------------------------------------------
// Invoices — the list.
//
// It answers the question the business could not answer before without
// opening a folder: what has gone out, to whom, for how much, and what is
// still owed. The figures at the top are the whole reason it is a page rather
// than a panel on the client record — money that is late is a fact about the
// business, not about one client.
//
// Raising one is a client and a date: the database picks the number, copies
// the terms and the tax rate, and the editor takes it from there. The terms
// themselves are edited under Admin → Invoice terms.
// ---------------------------------------------------------------------------

import { errorMessage } from './client.js';
import { bootstrap, renderError } from './shell.js';
import {
  el, mount, byId, toast, busy, formModal, fmtDate, panelHead, table, confirmModal,
  figure, figureRow, filterField,
} from './ui.js';
import { formatMoney, centsOf } from './money.js';
import { isoToday } from './doc-common.js';
import {
  STATUS_OPTIONS,
  filterInvoices,
  invoiceClientName,
  invoiceLabel,
  outstandingCents,
  overdueDays,
  statusLabel,
  statusTone,
} from './invoice-catalog.js';
import {
  createInvoice,
  deleteInvoice,
  duplicateInvoice,
  loadClients,
  loadInvoices,
  setStatus,
} from './invoice-data.js';

const state = {
  invoices: [],
  clients: [],
  search: '',
  status: '',
  clientId: '',
};

const nodes = {
  figures: el('div', {}),
  table: el('div', {}),
};

function editorUrl(id) {
  return `/portal/invoice/?id=${encodeURIComponent(id)}`;
}

// Loading
// ---------------------------------------------------------------------------

/** Everything, once. The filters run in the browser: the list is a sole
 *  proprietor's, and a round trip per keystroke is slower than the filter. */
async function loadAll() {
  const [invoices, clients] = await Promise.all([loadInvoices(), loadClients()]);
  state.invoices = invoices;
  state.clients = clients;
}

async function refresh() {
  try {
    await loadAll();
  } catch (error) {
    toast(errorMessage(error), 'error');
    return;
  }
  renderFigures();
  renderTable();
}

// The figures
// ---------------------------------------------------------------------------

/**
 * Outstanding is what issued and sent invoices still ask for; a draft is not
 * owed by anyone, a void never was, and a paid one is settled. Overdue is the
 * subset of that past its due date, stated separately because "you are owed
 * $12,000" and "$4,000 of it is late" are different problems.
 */
function renderFigures() {
  const today = isoToday();
  const live = state.invoices.filter((row) => ['issued', 'sent'].includes(row.status));
  const outstanding = live.reduce((sum, row) => sum + outstandingCents(row), 0);
  const late = live.filter((row) => overdueDays(row, today) > 0);
  const lateTotal = late.reduce((sum, row) => sum + outstandingCents(row), 0);
  const drafts = state.invoices.filter((row) => row.status === 'draft');

  mount(nodes.figures, figureRow([
    figure('Outstanding', formatMoney(outstanding),
      `${live.length} open invoice${live.length === 1 ? '' : 's'}`),
    figure('Overdue', formatMoney(lateTotal),
      late.length ? `${late.length} invoice${late.length === 1 ? '' : 's'} past due` : 'Nothing late',
      late.length ? 'bad' : undefined),
    figure('Drafts', String(drafts.length),
      drafts.length ? 'Not yet issued' : 'Nothing in progress'),
  ]));
}

// The table
// ---------------------------------------------------------------------------

function statusCell(row) {
  const tone = statusTone(row.status);
  const late = overdueDays(row, isoToday());

  return el('div', { class: 'btn-row' }, [
    el('span', { class: tone ? `pill pill--${tone}` : 'pill', text: statusLabel(row.status) }),
    late
      ? el('span', { class: 'pill pill--red', text: `${late} day${late === 1 ? '' : 's'} overdue` })
      : null,
  ]);
}

function actionsCell(row) {
  const draft = row.status === 'draft';

  return el('div', { class: draft ? 'btn-row btn-row--split' : 'btn-row' }, [
    el('a', {
      class: 'btn btn--ghost btn--tiny',
      href: editorUrl(row.id),
      text: 'Open',
      'aria-label': `Open ${invoiceLabel(row.number)}`,
    }),
    row.status === 'issued'
      ? el('button', {
        class: 'btn btn--ghost btn--tiny',
        type: 'button',
        text: 'Mark sent',
        'aria-label': `Mark ${invoiceLabel(row.number)} sent`,
        onclick: busy(() => markSent(row), { label: 'Marking…' }),
      })
      : null,
    ['issued', 'sent'].includes(row.status)
      ? el('button', {
        class: 'btn btn--ghost btn--tiny',
        type: 'button',
        text: 'Void',
        'aria-label': `Void ${invoiceLabel(row.number)}`,
        onclick: busy(() => voidInvoice(row)),
      })
      : null,
    el('button', {
      class: 'btn btn--ghost btn--tiny',
      type: 'button',
      text: 'Duplicate',
      'aria-label': `Duplicate ${invoiceLabel(row.number)} into a new draft`,
      onclick: busy(() => duplicate(row), { label: 'Copying…' }),
    }),
    // A draft is scratch work. An issued invoice is a business record with a
    // seven-year life, so there is no delete for it — void it instead.
    // Destroying one is not a routine choice, so it takes the destructive
    // colour and the row's end group.
    draft
      ? el('div', { class: 'btn-row__end' }, [
        el('button', {
          class: 'btn btn--danger btn--tiny',
          type: 'button',
          text: 'Delete draft',
          'aria-label': `Delete draft ${invoiceLabel(row.number)}`,
          onclick: busy(() => removeDraft(row)),
        }),
      ])
      : null,
  ]);
}

function invoiceRow(row) {
  const paid = centsOf(row.paid_cents);

  // is-tight and is-numeric keep a number, a date and a sum each reading as
  // one token when the table is squeezed; the client and project columns are
  // prose and keep the wrap.
  return el('tr', {}, [
    el('td', { class: 'is-tight' }, [
      el('a', { class: 'record-row__name', href: editorUrl(row.id), text: invoiceLabel(row.number) }),
      row.project_name ? el('span', { class: 'row-cell__desc', text: row.project_name }) : null,
    ]),
    el('td', { text: invoiceClientName(row) }),
    el('td', { class: 'is-tight', text: row.issued_on ? fmtDate(row.issued_on) : '—' }),
    el('td', { class: 'is-tight', text: row.due_on ? fmtDate(row.due_on) : '—' }),
    el('td', { class: 'is-numeric', text: formatMoney(row.total_cents) }),
    el('td', { class: 'is-numeric', text: paid ? formatMoney(paid) : '—' }),
    el('td', {}, [statusCell(row)]),
    el('td', {}, [actionsCell(row)]),
  ]);
}

const HEADINGS = ['Invoice', 'Client', 'Issued', 'Due', 'Total', 'Paid', 'Status', ''];

function renderTable() {
  if (!state.invoices.length) {
    mount(nodes.table, el('p', {
      class: 'empty',
      text: 'No invoices yet. Raise the first one with "New invoice": pick the client, '
          + 'add the lines, issue it, and save the PDF to send however you like.',
    }));
    return;
  }

  const rows = filterInvoices(state.invoices, state);

  if (!rows.length) {
    mount(nodes.table, el('p', { class: 'empty', text: 'Nothing matches those filters.' }));
    return;
  }

  mount(nodes.table,
    table(HEADINGS, rows.map(invoiceRow), { wide: true }),
    el('p', {
      class: 'progress__label',
      text: `${rows.length} of ${state.invoices.length} shown`,
    }));
}

function buildFilters() {
  const search = el('input', {
    type: 'search',
    id: 'invoice-search',
    placeholder: 'Number, client or project',
    oninput: (event) => {
      state.search = event.target.value;
      renderTable();
    },
  });

  const status = el('select', {
    id: 'invoice-status',
    onchange: (event) => {
      state.status = event.target.value;
      renderTable();
    },
  }, [
    el('option', { value: '', text: 'Any status' }),
    ...STATUS_OPTIONS.map((option) => el('option', { value: option.value, text: option.label })),
  ]);

  const client = el('select', {
    id: 'invoice-client',
    onchange: (event) => {
      state.clientId = event.target.value;
      renderTable();
    },
  }, [
    el('option', { value: '', text: 'Any client' }),
    ...state.clients.map((row) => el('option', { value: row.id, text: row.name })),
  ]);

  return el('div', { class: 'filters' }, [
    filterField('invoice-search', 'Search', search),
    filterField('invoice-status', 'Status', status),
    filterField('invoice-client', 'Client', client),
  ]);
}

// Raising one
// ---------------------------------------------------------------------------

async function startInvoice() {
  if (!state.clients.length) {
    toast('Add a client first — an invoice is addressed to somebody.', 'error');
    return;
  }

  const active = state.clients.filter((row) => row.status === 'active');
  const offered = active.length ? active : state.clients;

  await formModal({
    title: 'New invoice',
    submitLabel: 'Start it',
    intro: 'The number, the terms and the tax rate are set from today\'s settings. '
         + 'Add the lines on the next screen.',
    fields: [
      {
        name: 'client_id',
        label: 'Client',
        type: 'select',
        options: offered.map((row) => ({
          value: row.id,
          label: row.net_days ? `${row.name} — Net ${row.net_days}` : row.name,
        })),
      },
      { name: 'issued_on', label: 'Invoice date', type: 'date', value: isoToday(), required: true },
    ],
    onSubmit: async (values) => {
      const id = await createInvoice(values.client_id, values.issued_on);
      window.location.assign(editorUrl(id));
    },
  });
}

// Status, copies and deletion
// ---------------------------------------------------------------------------

async function markSent(row) {
  try {
    await setStatus(row.id, 'sent');
  } catch (error) {
    toast(errorMessage(error), 'error');
    return;
  }
  await refresh();
  toast(`${invoiceLabel(row.number)} marked sent.`, 'ok');
}

async function voidInvoice(row) {
  const ok = await confirmModal({
    title: `Void ${invoiceLabel(row.number)}?`,
    body: [
      'The number stays used and the document stays on file, but nothing is owed '
      + 'on it and it drops out of what is outstanding.',
      'To bill the same work again, duplicate it into a new draft.',
    ],
    confirmLabel: 'Void invoice',
    tone: 'danger',
  });
  if (!ok) return;

  try {
    await setStatus(row.id, 'void');
  } catch (error) {
    toast(errorMessage(error), 'error');
    return;
  }
  await refresh();
  toast(`${invoiceLabel(row.number)} voided.`, 'ok');
}

async function duplicate(row) {
  let fresh;
  try {
    fresh = await duplicateInvoice(row.id);
  } catch (error) {
    toast(errorMessage(error), 'error');
    return;
  }
  window.location.assign(editorUrl(fresh));
}

async function removeDraft(row) {
  const ok = await confirmModal({
    title: `Delete draft ${invoiceLabel(row.number)}?`,
    body: 'The lines go with it. This cannot be undone.',
    confirmLabel: 'Delete draft',
    tone: 'danger',
  });
  if (!ok) return;

  try {
    await deleteInvoice(row.id);
  } catch (error) {
    toast(errorMessage(error), 'error');
    return;
  }
  await refresh();
  toast('Draft deleted.', 'ok');
}

// ---------------------------------------------------------------------------

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
        el('h1', { text: 'Invoices' }),
        el('p', { text: 'Everything raised, what is still owed, and what is late.' }),
      ]),
      el('div', { class: 'page-head__actions' }, [
        el('button', {
          class: 'btn btn--small',
          type: 'button',
          text: 'New invoice',
          onclick: startInvoice,
        }),
      ]),
    ]),
    nodes.figures,
    el('section', { class: 'panel' }, [
      panelHead('All invoices'),
      buildFilters(),
      nodes.table,
    ]),
  );

  renderFigures();
  renderTable();
}

main();
