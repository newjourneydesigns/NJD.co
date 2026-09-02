// ---------------------------------------------------------------------------
// Invoices — the list, and the payment terms.
//
// The list answers the question the studio could not answer before without
// opening a folder: what has gone out, to whom, for how much, and what is
// still owed. The overdue count at the top is the whole reason it is a page
// rather than a panel on the client record — money that is late is a fact about
// the business, not about one client.
//
// Raising one is deliberately two shapes. Most invoices come off a scope of
// work, and for those the studio should never retype a figure: pick the SOW,
// pick which payment it is, done. The rest — out-of-scope hours, a Support Plan
// year, an ad-hoc job — start blank, because there is no document to copy.
// ---------------------------------------------------------------------------

import { errorMessage } from './client.js';
import { bootstrap, renderError } from './shell.js';
import { el, mount, byId, toast, formModal, fmtDate, panelHead, table, confirmModal } from './ui.js';
import { formatMoney, parseMoney } from './sow-fees.js';
import { sowLabel } from './sow-catalog.js';
import {
  MANUAL_STATUS_OPTIONS,
  STAGE_OPTIONS,
  STATUS_OPTIONS,
  filterInvoices,
  formatRate,
  parseRate,
  invoiceClientName,
  invoiceLabel,
  overdueDays,
  stageLabel,
} from './invoice-catalog.js';
import { openRecordPayment, paymentContext } from './payments.js';
import {
  billableSows,
  createBlankInvoice,
  createInvoiceFromSow,
  deleteInvoice,
  loadClients,
  loadInvoices,
  loadTerms,
  saveTerms,
  setStatus,
} from './invoice-data.js';

const state = {
  invoices: [],
  clients: [],
  terms: null,
  // The deposit accounts and the default one, loaded once for the whole page so
  // the payment dialog opens instantly rather than after a round trip.
  payments: { accounts: [], deposits: [], settings: null },
  search: '',
  status: '',
};

const panels = {
  invoices: el('section', { class: 'panel' }),
  terms: el('section', { class: 'panel' }),
};

const invoiceTable = el('div', {});

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

async function loadAll() {
  const [invoices, clients, terms, payments] = await Promise.all([
    loadInvoices(),
    loadClients(),
    loadTerms(),
    paymentContext(),
  ]);

  state.invoices = invoices;
  state.clients = clients;
  state.terms = terms;
  state.payments = payments;
}

async function refresh(render) {
  try {
    await loadAll();
  } catch (error) {
    toast(errorMessage(error), 'error');
    return;
  }
  render();
}

// The list
// ---------------------------------------------------------------------------

function statusPill(row) {
  const late = overdueDays(row, todayIso());

  if (late) {
    return el('span', {
      class: 'pill pill--red',
      text: `${late} day${late === 1 ? '' : 's'} overdue`,
    });
  }

  const tone = {
    draft: '',
    issued: 'blue',
    sent: 'amber',
    paid: 'green',
    void: 'red',
  }[row.status] || '';

  const label = (STATUS_OPTIONS.find((option) => option.value === row.status) || {}).label
    || row.status;
  return el('span', { class: tone ? `pill pill--${tone}` : 'pill', text: label });
}

function invoiceRow(row) {
  const editable = !row.issued_at;
  const due = (Number(row.total_cents) || 0) - (Number(row.paid_cents) || 0);

  // No Open/View button. The invoice number in the first cell is already a link
  // to this exact URL, and two controls side by side for one destination is one
  // control too many.
  const actions = el('div', {
    class: editable ? 'btn-row btn-row--split' : 'btn-row',
  }, [
    // Only once it has been issued: the database refuses a payment against a
    // draft, and offering a button that always fails is a worse screen than not
    // offering it.
    !editable && row.status !== 'void'
      ? el('button', {
        class: 'btn btn--ghost btn--tiny',
        type: 'button',
        text: 'Payment',
        'aria-label': `Record a payment against INV ${invoiceLabel(row.number)}`,
        onclick: () => takePayment(row),
      })
      : null,
    el('button', {
      class: 'btn btn--ghost btn--tiny',
      type: 'button',
      text: 'Status',
      'aria-label': `Change the status of INV ${invoiceLabel(row.number)}`,
      onclick: () => changeStatus(row),
    }),
    // A draft is scratch work. An issued invoice is a business record with a
    // seven-year life, so there is no delete for it here — void it instead.
    // Destroying one is not a routine choice, so it takes the destructive
    // colour and the row's end group, the same way the SOW list holds Void and
    // Delete apart from Duplicate and Status.
    editable
      ? el('div', { class: 'btn-row__end' }, [
        el('button', {
          class: 'btn btn--danger btn--tiny',
          type: 'button',
          text: 'Delete',
          'aria-label': `Delete draft INV ${invoiceLabel(row.number)}`,
          onclick: () => removeDraft(row),
        }),
      ])
      : null,
  ]);

  // is-tight and is-numeric are the ledger's classes for the same problem it
  // had: nine columns squeezed into a panel let the browser break "INV
  // 20260810", "Aug 24, 2026" and even "$7,500.00" wherever it liked, and
  // every cell came out as two stacked fragments. The invoice number, the
  // dates and the money each read as one token; the client and stage columns
  // are prose and keep the wrap.
  return el('tr', {}, [
    el('td', { class: 'is-tight' }, [
      el('a', {
        class: 'record-row__name',
        href: `/portal/admin/invoice/?id=${encodeURIComponent(row.id)}`,
        text: `INV ${invoiceLabel(row.number)}`,
      }),
      row.sow_label ? el('span', { class: 'sow-cell__desc', text: row.sow_label }) : null,
    ]),
    el('td', { text: invoiceClientName(row) }),
    el('td', {}, [
      el('span', { text: stageLabel(row.stage) }),
      row.project_name ? el('span', { class: 'sow-cell__desc', text: row.project_name }) : null,
    ]),
    el('td', { class: 'is-tight', text: row.issued_on ? fmtDate(row.issued_on) : '—' }),
    el('td', { class: 'is-tight', text: row.due_on ? fmtDate(row.due_on) : '—' }),
    el('td', { class: 'is-numeric', text: formatMoney(row.total_cents) }),
    el('td', { class: 'is-numeric', text: row.status === 'paid' ? '—' : formatMoney(due) }),
    el('td', {}, [statusPill(row)]),
    el('td', {}, [actions]),
  ]);
}

const HEADINGS = ['Invoice', 'Client', 'For', 'Dated', 'Due', 'Total', 'Outstanding', 'Status', ''];

/**
 * The two numbers under the table.
 *
 * Outstanding excludes drafts and voids: a draft is not owed by anyone, and a
 * void never was. Overdue is the subset of that which is past its due date, and
 * it is stated separately because "you are owed $12,000" and "$4,000 of it is
 * late" are different problems.
 */
function totalsLine(rows) {
  const live = rows.filter((row) => !['draft', 'void', 'paid'].includes(row.status));
  const outstanding = live.reduce((sum, row) => (
    sum + ((Number(row.total_cents) || 0) - (Number(row.paid_cents) || 0))
  ), 0);
  const late = live.filter((row) => overdueDays(row, todayIso()));
  const lateTotal = late.reduce((sum, row) => (
    sum + ((Number(row.total_cents) || 0) - (Number(row.paid_cents) || 0))
  ), 0);

  const parts = [`${rows.length} of ${state.invoices.length} shown`];
  parts.push(`${formatMoney(outstanding)} outstanding`);
  if (late.length) {
    parts.push(`${formatMoney(lateTotal)} of it overdue across ${late.length} `
      + `invoice${late.length === 1 ? '' : 's'}`);
  }

  return el('p', {
    class: late.length ? 'notice notice--warn' : 'progress__label',
    text: parts.join(' · '),
  });
}

function renderInvoiceTable() {
  const rows = filterInvoices(state.invoices, state);

  if (!state.invoices.length) {
    mount(invoiceTable, el('p', {
      class: 'empty',
      text: 'No invoices yet. Raise the first one from a scope of work that has '
          + 'been exported — the deposit takes one click and copies the figure '
          + 'the client already agreed to.',
    }));
    return;
  }

  if (!rows.length) {
    mount(invoiceTable, el('p', { class: 'empty', text: 'Nothing matches that search.' }));
    return;
  }

  // wide: nine columns is ledger territory — let the table scroll in its
  // panel rather than crush every column into fragments.
  mount(invoiceTable, table(HEADINGS, rows.map(invoiceRow), { wide: true }), totalsLine(rows));
}

function buildFilters() {
  const search = el('input', {
    type: 'search',
    id: 'invoice-search',
    placeholder: 'Client, project, SOW, or number',
    oninput: (event) => {
      state.search = event.target.value;
      renderInvoiceTable();
    },
  });

  const status = el('select', {
    id: 'invoice-status',
    onchange: (event) => {
      state.status = event.target.value;
      renderInvoiceTable();
    },
  }, [
    el('option', { value: '', text: 'Any status' }),
    ...STATUS_OPTIONS.map((option) => el('option', { value: option.value, text: option.label })),
  ]);

  return el('div', { class: 'filters' }, [
    el('div', { class: 'form-field' }, [
      el('label', { for: 'invoice-search', text: 'Search' }),
      search,
    ]),
    el('div', { class: 'form-field' }, [
      el('label', { for: 'invoice-status', text: 'Status' }),
      status,
    ]),
  ]);
}

// Raising one
// ---------------------------------------------------------------------------

/**
 * From a scope of work, which is the path that matters.
 *
 * The client is picked first because that is what narrows the list of scopes to
 * something you can read. Only frozen, non-void SOWs are offered: the database
 * refuses anything else, and offering a draft only to reject it is a worse
 * screen than not offering it.
 */
async function startFromSow() {
  if (!state.clients.length) {
    toast('Add a client first — an invoice is addressed to somebody.', 'error');
    return;
  }

  const picked = await formModal({
    title: 'Invoice a scope of work',
    submitLabel: 'Next',
    intro: 'Which client is this for? The next step picks the scope of work and '
         + 'which payment it is.',
    fields: [{
      name: 'client_id',
      label: 'Client',
      type: 'select',
      options: state.clients.map((row) => ({ value: row.id, label: row.name })),
    }],
  });

  if (!picked) return;

  let sows;
  try {
    sows = await billableSows(picked.client_id);
  } catch (error) {
    toast(errorMessage(error), 'error');
    return;
  }

  if (!sows.length) {
    toast('That client has no exported scope of work to bill against. '
        + 'Export one first, or raise a blank invoice.', 'error');
    return;
  }

  await formModal({
    title: 'Which payment?',
    submitLabel: 'Raise invoice',
    intro: 'The amount comes straight off the scope of work — the figure the '
         + 'client already agreed to. You can still edit the lines afterwards.',
    fields: [
      {
        name: 'sow_id',
        label: 'Scope of work',
        type: 'select',
        options: sows.map((row) => ({
          value: row.id,
          label: `SOW ${sowLabel(row.number, row.revision)} — `
               + `${row.project_name || 'Untitled'} — ${formatMoney(row.adjusted_fee_cents)}`
               + `${row.status === 'signed' ? '' : ` (${row.status})`}`,
        })),
      },
      {
        name: 'stage',
        label: 'This invoice bills',
        type: 'select',
        options: STAGE_OPTIONS.map((option) => ({
          value: option.value,
          label: `${option.label} — ${option.hint}`,
        })),
      },
      { name: 'issued_on', label: 'Invoice date', type: 'date', value: todayIso(), required: true },
    ],
    onSubmit: async (values) => {
      const id = await createInvoiceFromSow({
        sowId: values.sow_id,
        stage: values.stage,
        issuedOn: values.issued_on,
      });
      window.location.assign(`/portal/admin/invoice/?id=${encodeURIComponent(id)}`);
    },
  });
}

/** For everything that did not come from a scope of work. */
async function startBlank() {
  if (!state.clients.length) {
    toast('Add a client first — an invoice is addressed to somebody.', 'error');
    return;
  }

  await formModal({
    title: 'Blank invoice',
    submitLabel: 'Start it',
    intro: 'For work with no scope of work behind it — out-of-scope hours, a care '
         + 'plan year, an ad-hoc job. Add the lines on the next screen.',
    fields: [
      {
        name: 'client_id',
        label: 'Client',
        type: 'select',
        options: state.clients.map((row) => ({ value: row.id, label: row.name })),
      },
      { name: 'issued_on', label: 'Invoice date', type: 'date', value: todayIso(), required: true },
    ],
    onSubmit: async (values) => {
      const net = (state.terms && Number(state.terms.net_days)) || 14;
      const due = new Date(`${values.issued_on}T00:00:00`);
      due.setDate(due.getDate() + net);

      const id = await createBlankInvoice({
        clientId: values.client_id,
        issuedOn: values.issued_on,
        dueOn: due.toISOString().slice(0, 10),
        taxRateBp: (state.terms && state.terms.tax_rate_bp) || 0,
      });
      window.location.assign(`/portal/admin/invoice/?id=${encodeURIComponent(id)}`);
    },
  });
}

// Status and deletion
// ---------------------------------------------------------------------------

/**
 * Where an invoice stands, for the parts of it nobody can derive.
 *
 * "Sent" is an observation about an email; "void" is a decision. Neither is
 * visible from here, so both are set by hand. "Paid" is no longer on the list —
 * it follows the payments recorded against the invoice, which is what the
 * button next door is for.
 */
async function changeStatus(row) {
  const result = await formModal({
    title: `INV ${invoiceLabel(row.number)}`,
    submitLabel: 'Set status',
    intro: 'Nothing watches a mailbox yet, so this is set by hand. Paid is not '
         + 'here on purpose — record the payment and it follows.',
    fields: [
      {
        name: 'status',
        label: 'Status',
        type: 'select',
        value: row.status === 'paid' ? 'sent' : row.status,
        options: MANUAL_STATUS_OPTIONS,
      },
    ],
    onSubmit: async (values) => {
      await setStatus(row.id, values.status);
    },
  });

  if (result) {
    await refresh(renderInvoiceTable);
    toast('Status updated.', 'ok');
  }
}

/** Money in, against one invoice. The modal and everything behind it live in
 *  payments.js, because the invoice form offers the same thing. */
async function takePayment(row) {
  const recorded = await openRecordPayment(row, state.payments);
  if (!recorded) return;

  await refresh(renderInvoiceTable);
  toast('Payment recorded, and posted to the books.', 'ok');
}

async function removeDraft(row) {
  const confirmed = await confirmModal({
    title: `Delete draft INV ${invoiceLabel(row.number)}?`,
    body: 'This cannot be undone.',
    confirmLabel: 'Delete draft',
    tone: 'danger',
  });
  if (!confirmed) return;

  try {
    await deleteInvoice(row.id);
  } catch (error) {
    toast(errorMessage(error), 'error');
    return;
  }

  await refresh(renderInvoiceTable);
  toast('Draft deleted.', 'ok');
}

// Payment terms
// ---------------------------------------------------------------------------

async function editTerms() {
  const row = state.terms || {};

  const result = await formModal({
    title: 'Payment terms',
    intro: 'What every invoice says about how and when to pay. The studio name '
         + 'and address are not here — an invoice is from the same party as the '
         + 'scope of work, and those live in Document settings on the SOWs page.',
    fields: [
      {
        name: 'payment_terms',
        label: 'Terms sentence',
        type: 'textarea',
        rows: 2,
        value: row.payment_terms || '',
        required: true,
        hint: 'Printed above the total on every invoice.',
      },
      {
        name: 'payment_details',
        label: 'How to pay',
        type: 'textarea',
        rows: 4,
        value: row.payment_details || '',
        hint: 'One per line — bank details, a Zelle handle, a cheque address. '
            + 'Left blank, the document simply does not print the block.',
      },
      {
        name: 'net_days',
        label: 'Default terms (days)',
        type: 'number',
        value: row.net_days == null ? 14 : row.net_days,
        required: true,
        hint: 'Fills the due date when an invoice is raised. Editable per invoice.',
      },
      {
        name: 'late_note',
        label: 'Late payment note',
        type: 'textarea',
        rows: 2,
        value: row.late_note || '',
        hint: 'Optional. Only include something you are actually willing to enforce.',
      },
      {
        name: 'tax_rate_bp',
        label: 'Sales tax rate',
        type: 'text',
        inputmode: 'decimal',
        value: row.tax_rate_bp ? formatRate(row.tax_rate_bp).replace('%', '') : '',
        hint: 'Leave empty if the studio does not charge sales tax. Texas is 6.25% '
            + 'state plus local, so 8.25% in much of DFW — but what is actually '
            + 'taxable is a question for your CPA, and it is set per line on each '
            + 'invoice rather than per invoice.',
      },
      {
        name: 'tax_label',
        label: 'What to call it',
        type: 'text',
        value: row.tax_label || 'Sales tax',
        hint: 'Printed on the invoice beside the rate.',
      },
      {
        name: 'tax_registration',
        label: 'Sales tax permit number',
        type: 'text',
        value: row.tax_registration || '',
        hint: 'Printed on any invoice that charges tax, which is what the state '
            + 'expects to see on one.',
      },
    ],
    onSubmit: async (values) => {
      const net = Number(values.net_days);
      if (!Number.isFinite(net) || net < 0) throw new Error('That is not a number of days.');

      const rate = values.tax_rate_bp ? parseRate(values.tax_rate_bp) : 0;
      if (rate === null) throw new Error('That tax rate is not a number.');

      await saveTerms({
        payment_terms: values.payment_terms,
        payment_details: values.payment_details || null,
        net_days: net,
        late_note: values.late_note || null,
        tax_rate_bp: rate,
        tax_label: values.tax_label || 'Sales tax',
        tax_registration: values.tax_registration || null,
      });
    },
  });

  if (result) {
    await refresh(renderTerms);
    toast('Terms saved.', 'ok');
  }
}

function renderTerms() {
  const row = state.terms || {};

  mount(panels.terms,
    panelHead('Payment terms', el('button', {
      class: 'btn btn--small',
      type: 'button',
      text: 'Edit',
      onclick: editTerms,
    })),
    el('dl', { class: 'detail-list' }, [
      el('div', { class: 'detail-row' }, [
        el('dt', { class: 'detail-row__label', text: 'Terms' }),
        el('dd', { class: 'detail-row__value' }, [
          el('div', { class: 'detail-block' }, [
            el('div', { text: row.payment_terms || '—' }),
            el('div', { text: `Due ${row.net_days == null ? 14 : row.net_days} days after the invoice date, by default` }),
          ]),
        ]),
      ]),
      el('div', { class: 'detail-row' }, [
        el('dt', { class: 'detail-row__label', text: 'How to pay' }),
        el('dd', { class: 'detail-row__value' }, [
          row.payment_details
            ? el('div', { class: 'detail-block' },
              String(row.payment_details).split('\n').filter(Boolean)
                .map((line) => el('div', { text: line.trim() })))
            : el('span', {
              class: 'progress__label',
              text: 'Not set, so no invoice tells a client where to send the money. '
                  + 'Worth two minutes.',
            }),
        ]),
      ]),
      el('div', { class: 'detail-row' }, [
        el('dt', { class: 'detail-row__label', text: 'Sales tax' }),
        el('dd', { class: 'detail-row__value' }, [
          row.tax_rate_bp
            ? el('div', { class: 'detail-block' }, [
              el('div', { text: `${row.tax_label || 'Sales tax'} at ${formatRate(row.tax_rate_bp)}` }),
              el('div', {
                class: 'progress__label',
                text: row.tax_registration
                  ? `Permit ${row.tax_registration}. Charged only on invoice lines ticked as taxable.`
                  : 'No permit number set — an invoice charging tax should carry one.',
              }),
            ])
            : el('span', {
              class: 'progress__label',
              text: 'Not charged. Right for professional service work; set a rate here '
                  + 'if the studio bills anything taxable.',
            }),
        ]),
      ]),
      row.late_note
        ? el('div', { class: 'detail-row' }, [
          el('dt', { class: 'detail-row__label', text: 'Late payment' }),
          el('dd', { class: 'detail-row__value', text: row.late_note }),
        ])
        : null,
    ]),
  );
}

// ---------------------------------------------------------------------------

function renderAll() {
  renderInvoiceTable();
  renderTerms();
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

  mount(panels.invoices,
    panelHead('Invoices', el('div', { class: 'btn-row' }, [
      el('button', {
        class: 'btn btn--small',
        type: 'button',
        text: 'From a scope of work',
        onclick: startFromSow,
      }),
      el('button', {
        class: 'btn btn--ghost btn--small',
        type: 'button',
        text: 'Blank invoice',
        onclick: startBlank,
      }),
    ])),
    buildFilters(),
    invoiceTable,
  );

  mount(byId('portal-root'),
    el('p', { class: 'breadcrumb' }, [el('a', { href: '/portal/admin/', text: '← Admin' })]),
    el('div', { class: 'page-head' }, [
      el('div', {}, [
        el('h1', { text: 'Invoices' }),
        el('p', {
          text: 'Every invoice the studio has raised, what is still owed, and what '
              + 'is late.',
        }),
      ]),
    ]),
    panels.invoices,
    panels.terms,
  );

  renderAll();
}

main();
