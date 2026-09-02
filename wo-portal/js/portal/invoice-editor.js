// ---------------------------------------------------------------------------
// The invoice form.
//
// A deliberately smaller screen than the scope of work builder next door, and
// that is the design rather than an omission. By the time an invoice is being
// written, every hard question has already been answered: what the work is,
// what it costs, what came off and why. This screen's job is to ask for a
// number that was agreed weeks ago, and the more it lets you rethink that
// number the less useful it is.
//
// So there are no discounts here, no fee engine, and no package catalog. There
// are lines, dates, and the terms. The one piece of arithmetic is quantity ×
// rate, which exists because billing six hours of out-of-scope work is a real
// thing the studio does.
//
// The three habits it shares with the SOW form:
//
//   Nothing is lost. Edits save a beat after you stop typing.
//
//   An issued invoice cannot be edited. The form renders read-only once it is
//   frozen, and the database refuses the write regardless — see the guard
//   triggers in supabase/schema.sql.
//
//   The checks before issuing are split into things that stop you and things
//   that are worth a look. Billing a deposit against a scope of work nobody has
//   marked signed yet is the second kind, not the first.
// ---------------------------------------------------------------------------

import { errorMessage } from './client.js';
import { bootstrap, renderError } from './shell.js';
import { el, mount, byId, toast, formModal, fmtDate, fmtDateTime, confirmModal } from './ui.js';
import { formatMoney, parseMoney, resolveHourlyRate } from './sow-fees.js';
import { sowLabel } from './sow-catalog.js';
import {
  STAGE_OPTIONS,
  blockers,
  computeTotals,
  formatRate,
  invoiceFilename,
  invoiceLabel,
  lineAmount,
  stageLabel,
  validate,
} from './invoice-catalog.js';
import { assemble, digest } from './invoice-doc.js';
import { accountLabel } from './ledger-catalog.js';
import { loadAccounts } from './ledger-data.js';
import { openRecordPayment, paymentContext, paymentRows, paymentsForInvoice } from './payments.js';
import { printSnapshot } from './invoice-print.js';
import {
  billedAgainstSow,
  issueInvoice,
  loadInvoice,
  loadProjects,
  loadTerms,
  saveInvoice,
} from './invoice-data.js';
import { loadSettings } from './sow-data.js';
import { reorderList, moveItem } from './reorder.js';
import { attachAiRewrite } from './ai-rewrite.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SAVE_DELAY_MS = 1200;

const state = {
  id: null,
  invoice: null,
  client: null,
  items: [],
  projects: [],
  sow: null,
  billed: 0,
  settings: null,
  terms: null,
  // The income accounts a line's revenue can be booked to, and the payments
  // recorded against this invoice. Both are ledger business; the invoice only
  // needs enough of each to offer a picker and to show what has arrived.
  incomeAccounts: [],
  payments: [],
  paymentContext: null,
  totals: null,
  problems: [],
  readOnly: false,
  dirty: false,
  saving: false,
};

const inputs = new Map();

const nodes = {
  lineList: el('div', { class: 'row-list' }),
  payments: el('div', { class: 'doc-list' }),
  totals: el('div', {}),
  problems: el('div', {}),
  saveState: el('span', { class: 'save-state', role: 'status', 'aria-live': 'polite' }),
};

let saveTimer = 0;

// Form plumbing
// ---------------------------------------------------------------------------

function field(name, label, input, hint) {
  inputs.set(name, input);
  return el('div', { class: 'form-field' }, [
    el('label', { for: input.id, text: label }),
    input,
    hint ? el('span', { class: 'progress__label', text: hint }) : null,
  ]);
}

function textInput(name, { type = 'text', value = '', placeholder = '' } = {}) {
  const input = el('input', {
    type,
    id: `inv-${name}`,
    name,
    placeholder: placeholder || null,
    oninput: touch,
    onchange: touch,
  });
  input.value = value == null ? '' : value;
  return input;
}

function areaInput(name, { value = '', rows = 3, placeholder = '' } = {}) {
  const input = el('textarea', {
    id: `inv-${name}`,
    name,
    rows,
    placeholder: placeholder || null,
    oninput: touch,
  });
  input.value = value == null ? '' : value;
  // This page sits behind bootstrap({ requireAdmin: true }).
  attachAiRewrite(input, { isAdmin: true, surface: `invoice:${name}` });
  return input;
}

function selectInput(name, options, value) {
  return el('select', { id: `inv-${name}`, name, onchange: touch },
    options.map((option) => el('option', {
      value: option.value,
      text: option.label,
      selected: String(option.value) === String(value == null ? '' : value),
    })));
}

function valueOf(name) {
  const input = inputs.get(name);
  if (!input) return '';
  if (input.type === 'checkbox') return input.checked;
  return input.value.trim();
}

function touch() {
  if (state.readOnly) return;
  state.dirty = true;
  readForm();
  recompute();
  queueSave();
}

function readForm() {
  const invoice = state.invoice;

  invoice.number = Number(valueOf('number')) || invoice.number;
  invoice.stage = valueOf('stage') || 'other';
  invoice.project_id = valueOf('project_id') || null;
  invoice.project_name = valueOf('project_name');
  invoice.issued_on = valueOf('issued_on') || null;
  invoice.due_on = valueOf('due_on') || null;
  invoice.purchase_order = valueOf('purchase_order');
  invoice.summary = valueOf('summary');
  invoice.notes = valueOf('notes');

  // paid_cents is deliberately not read from the form any more. It is the sum
  // of the payments recorded against this invoice, maintained by a trigger, and
  // a second place to type it would be a second answer to "how much came in".
}

// The lines
// ---------------------------------------------------------------------------

// The lines live in memory until the debounced save writes the whole invoice,
// so reordering them is an array move and nothing else — no position column,
// no round trip. Only the grip is shared with the five database-backed lists.
const lineOrder = reorderList({
  noun: 'line',
  onReorder: (from, to) => {
    state.items.splice(0, state.items.length, ...moveItem(state.items, from, to));
    state.dirty = true;
    renderLines();
    recompute();
    queueSave();
  },
});

function rowControls(index, render, label) {
  return el('div', { class: 'btn-row' }, [
    el('button', {
      class: 'btn btn--ghost btn--tiny',
      type: 'button',
      text: 'Remove',
      'aria-label': `Remove ${label}`,
      onclick: () => {
        state.items.splice(index, 1);
        state.dirty = true;
        render();
        recompute();
        queueSave();
      },
    }),
  ]);
}

/**
 * One line.
 *
 * Quantity and rate are separate inputs, and the amount is derived from them
 * rather than typed. That is the same rule the SOW's fee block follows for the
 * same reason: a total somebody can type is a total that can disagree with the
 * numbers above it.
 */
function lineRow(item, index) {
  const id = `line-${index}`;

  const name = el('input', { type: 'text', id: `${id}-name`, value: item.name || '' });
  name.addEventListener('input', () => {
    item.name = name.value;
    state.dirty = true;
    queueSave();
  });

  const description = el('textarea', { id: `${id}-desc`, rows: 2 });
  description.value = item.description || '';
  description.addEventListener('input', () => {
    item.description = description.value;
    state.dirty = true;
    queueSave();
  });
  attachAiRewrite(description, { isAdmin: true, surface: 'invoice:line-description' });

  const quantity = el('input', {
    type: 'text',
    inputmode: 'decimal',
    id: `${id}-qty`,
    value: item.quantity == null ? '1' : String(item.quantity),
  });
  quantity.addEventListener('input', () => {
    const parsed = Number(quantity.value.trim());
    item.quantity = Number.isFinite(parsed) ? parsed : 0;
    state.dirty = true;
    recompute();
    queueSave();
  });

  const unit = el('input', {
    type: 'text',
    inputmode: 'decimal',
    id: `${id}-unit`,
    value: item.unit_cents ? formatMoney(item.unit_cents).replace(/^\$/, '') : '',
  });
  unit.addEventListener('input', () => {
    const parsed = parseMoney(unit.value);
    item.unit_cents = parsed === null ? 0 : parsed;
    state.dirty = true;
    recompute();
    queueSave();
  });
  unit.addEventListener('blur', () => {
    if (item.unit_cents) unit.value = formatMoney(item.unit_cents).replace(/^\$/, '');
  });

  // Which income account this line's revenue belongs to. Almost always right
  // already — an invoice raised from a scope of work arrives with the studio's
  // matching service line filled in — so it sits below the amounts rather than
  // among them, and "the usual" is a real option rather than a blank.
  const income = el('select', { id: `${id}-income` }, [
    el('option', { value: '', text: 'The default income account' }),
    ...state.incomeAccounts.map((row) => el('option', {
      value: row.id,
      text: accountLabel(row),
      selected: row.id === item.income_account_id,
    })),
  ]);
  income.addEventListener('change', () => {
    item.income_account_id = income.value || null;
    state.dirty = true;
    queueSave();
  });

  // Per line, because one document routinely has both kinds on it: the design
  // work that is exempt and the printing bought on the client's behalf that is
  // not. Hidden entirely when no rate is set, so an invoice for pure service
  // work never has to think about it.
  const taxable = el('input', {
    type: 'checkbox',
    id: `${id}-taxable`,
    checked: Boolean(item.taxable),
  });
  taxable.addEventListener('change', () => {
    item.taxable = taxable.checked;
    state.dirty = true;
    recompute();
    queueSave();
  });

  return el('div', { class: 'row-card' }, [
    state.readOnly ? null : lineOrder.handle(index, `line ${index + 1}`),
    el('div', { class: 'row-card__grid' }, [
      el('div', { class: 'form-field' }, [
        el('label', { for: `${id}-name`, text: `Line ${index + 1}` }),
        name,
      ]),
      el('div', { class: 'form-field' }, [
        el('label', { for: `${id}-qty`, text: 'Quantity' }),
        quantity,
      ]),
      el('div', { class: 'form-field' }, [
        el('label', { for: `${id}-unit`, text: 'Rate' }),
        unit,
      ]),
      el('div', { class: 'form-field' }, [
        el('span', { class: 'form-field__label', text: 'Amount' }),
        el('p', { class: 'row-card__amount', text: formatMoney(lineAmount(item)) }),
      ]),
    ]),
    el('div', { class: 'form-field' }, [
      el('label', { for: `${id}-desc`, text: 'Description' }),
      description,
    ]),
    state.incomeAccounts.length
      ? el('div', { class: 'form-field' }, [
        el('label', { for: `${id}-income`, text: 'Books to' }),
        income,
        el('span', {
          class: 'progress__label',
          text: 'Which line of the profit and loss this revenue shows up on.',
        }),
      ])
      : null,
    Number(state.invoice.tax_rate_bp)
      ? el('div', { class: 'form-field form-field--check' }, [
        taxable,
        el('label', { for: `${id}-taxable`, text: 'Sales tax applies to this line' }),
      ])
      : null,
    item.sow_item_id
      ? el('p', { class: 'progress__label', text: 'From the scope of work. Edited freely from here.' })
      : null,
    state.readOnly ? null : rowControls(index, renderLines, `line ${index + 1}`),
  ]);
}

function renderLines() {
  mount(nodes.lineList, ...(state.items.length
    ? state.items.map(lineRow)
    : [el('p', {
      class: 'empty',
      text: 'No lines yet. Add one — or, if this bills a scope of work, pick the '
          + 'payment it is for from the list.',
    })]));
  lineOrder.attach(nodes.lineList);
}

function addBlankLine() {
  state.items.push({ name: '', description: '', quantity: 1, unit_cents: 0 });
  state.dirty = true;
  renderLines();
  recompute();
  queueSave();
}

/**
 * The out-of-scope shortcut.
 *
 * Hours at the agreed rate is the one calculation this screen does often enough
 * to be worth a button, and the rate is resolved exactly the way the scope of
 * work resolves it — this client's negotiated rate if they have one, the studio
 * settings row if they do not. Same function, resolveHourlyRate(), rather than
 * a second copy of the rule here.
 *
 * That shared resolver is the whole point. Until it existed this line read
 * `state.settings.hourly_rate_cents || 9500`, which is the studio rate and
 * nothing else — so an invoice would happily bill $95 an hour for work the
 * signed scope of work promised at $90, from the same screen, on the same
 * client, in the same week. Two documents disagreeing about a price is the
 * defect the client column was added to close, and it had two doors.
 */
async function addHours() {
  const { cents: rate, negotiated } = resolveHourlyRate(
    state.client && state.client.hourly_rate_cents,
    state.settings,
  );

  await formModal({
    title: 'Bill hours',
    submitLabel: 'Add line',
    intro: negotiated
      ? `Out-of-scope work, at the ${formatMoney(rate)} an hour negotiated with this `
        + 'client and quoted on their scopes of work. Change the rate here if this '
        + 'particular work was agreed at a different one.'
      : `Out-of-scope work, at the ${formatMoney(rate)} an hour every scope of `
        + 'work quotes. Change the rate here if this was agreed at a different one.',
    fields: [
      { name: 'what', label: 'What the work was', type: 'text', required: true, placeholder: 'Extra landing page, agreed 12 August' },
      { name: 'hours', label: 'Hours', type: 'text', inputmode: 'decimal', required: true, placeholder: '6' },
      {
        name: 'rate',
        label: 'Hourly rate',
        type: 'text',
        inputmode: 'decimal',
        value: formatMoney(rate).replace(/^\$/, ''),
        required: true,
      },
    ],
    onSubmit: async (values) => {
      const hours = Number(String(values.hours).trim());
      if (!Number.isFinite(hours) || hours <= 0) throw new Error('That is not a number of hours.');

      const parsed = parseMoney(values.rate);
      if (parsed === null || parsed <= 0) throw new Error('That rate is not a number.');

      state.items.push({
        name: values.what,
        description: 'Work outside the agreed scope, quoted and agreed before it began.',
        quantity: hours,
        unit_cents: parsed,
      });

      state.dirty = true;
      renderLines();
      recompute();
      queueSave();
    },
  });
}

// Totals and checks
// ---------------------------------------------------------------------------

function totalLine(label, value, className) {
  return el('div', { class: className ? `fee-line ${className}` : 'fee-line' }, [
    el('span', { class: 'fee-line__label', text: label }),
    el('span', { class: 'fee-line__value', text: value }),
  ]);
}

function renderTotals() {
  const totals = state.totals;

  mount(nodes.totals,
    el('div', { class: 'fee-block' }, [
      totalLine('Subtotal', formatMoney(totals.subtotal)),
      totals.tax > 0
        ? totalLine(
          `${(state.terms && state.terms.tax_label) || 'Sales tax'} at `
          + `${formatRate(totals.taxRateBp)} on ${formatMoney(totals.taxable)}`,
          formatMoney(totals.tax),
        )
        : null,
      totals.paid > 0
        ? totalLine('Already received', `− ${formatMoney(totals.paid)}`, 'fee-line--muted')
        : null,
      totalLine('Amount due', formatMoney(totals.due), 'fee-line--total fee-line--split'),
    ]),
    // What this scope of work has been billed in total, this invoice included.
    // The number nobody has otherwise, and the one that stops a deposit going
    // out twice.
    //
    // state.billed is what the *other* invoices come to; this one is added live
    // so the figure moves as the lines are edited. A void invoice asks for
    // nothing, so it contributes nothing.
    state.sow
      ? el('p', { class: 'progress__label' }, [
        `Billed against SOW ${sowLabel(state.sow.number, state.sow.revision)}: `,
        el('strong', {
          text: formatMoney(
            state.billed + (state.invoice.status === 'void' ? 0 : totals.total),
          ),
        }),
        ` of ${formatMoney(state.sow.adjusted_fee_cents)} agreed.`,
      ])
      : null,
  );
}

function renderProblems() {
  const problems = state.problems;

  if (!problems.length) {
    mount(nodes.problems, el('p', {
      class: 'notice notice--ok',
      text: 'Ready to issue. Nothing is missing.',
    }));
    return;
  }

  const stopping = blockers(problems);
  const warnings = problems.length - stopping.length;

  mount(nodes.problems,
    el('p', {
      class: stopping.length ? 'notice notice--error' : 'notice',
      text: stopping.length
        ? `${stopping.length} thing${stopping.length === 1 ? '' : 's'} to fix before this can be issued.`
        : `Everything required is filled in. ${warnings === 1 ? 'One thing' : `${warnings} things`} worth a look:`,
    }),
    el('ul', { class: 'problem-list' }, problems.map((problem) => el('li', {
      class: problem.blocking ? 'problem-list__item' : 'problem-list__item is-warning',
      text: problem.message,
    }))),
  );
}

function recompute() {
  state.totals = computeTotals(state.items, state.invoice.paid_cents,
    state.invoice.tax_rate_bp);

  state.problems = validate({
    invoice: state.invoice,
    client: state.client,
    items: state.items,
    sow: state.sow
      ? {
        ...state.sow,
        label: `SOW ${sowLabel(state.sow.number, state.sow.revision)}`,
      }
      : null,
    billedCents: state.billed,
  });

  renderTotals();
  renderProblems();
}

// Saving
// ---------------------------------------------------------------------------

function setSaveState(text, tone = '') {
  nodes.saveState.textContent = text;
  nodes.saveState.className = tone ? `save-state save-state--${tone}` : 'save-state';
}

function payload() {
  const invoice = state.invoice;
  const totals = state.totals;

  return {
    id: state.id,
    invoice: {
      client_id: invoice.client_id,
      project_id: invoice.project_id || '',
      number: invoice.number,
      stage: invoice.stage || 'other',
      status: invoice.status,
      issued_on: invoice.issued_on || '',
      due_on: invoice.due_on || '',
      project_name: invoice.project_name || '',
      purchase_order: invoice.purchase_order || '',
      summary: invoice.summary || '',
      notes: invoice.notes || '',
      subtotal_cents: totals.subtotal,
      tax_rate_bp: invoice.tax_rate_bp || 0,
      tax_cents: totals.tax,
      // Passed straight back rather than read off the form: the payments own it.
      paid_cents: invoice.paid_cents || 0,
      total_cents: totals.total,
    },
    items: state.items.map((item) => ({
      sow_item_id: item.sow_item_id || '',
      name: item.name || '',
      description: item.description || '',
      quantity: item.quantity == null ? 1 : item.quantity,
      unit_cents: item.unit_cents || 0,
      amount_cents: lineAmount(item),
      income_account_id: item.income_account_id || '',
      taxable: Boolean(item.taxable),
    })),
  };
}

async function save() {
  if (state.readOnly || state.saving) return;

  state.saving = true;
  setSaveState('Saving…');

  try {
    await saveInvoice(payload());
    state.dirty = false;
    setSaveState(`Saved ${fmtDateTime(new Date().toISOString())}`, 'ok');
  } catch (error) {
    // The form keeps everything typed, for the same reason the SOW form does.
    setSaveState('Not saved — still on screen, try again', 'error');
    toast(errorMessage(error), 'error');
  } finally {
    state.saving = false;
  }
}

function queueSave() {
  if (state.readOnly) return;
  setSaveState('Unsaved changes');
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(save, SAVE_DELAY_MS);
}

function flushOnHide() {
  if (state.dirty && !state.saving) save();
}

// Issuing
// ---------------------------------------------------------------------------

function todayIso() {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
}

function clientName() {
  const client = state.client || {};
  return client.legal_name || client.name || 'client';
}

function snapshotNow() {
  return assemble({
    invoice: state.invoice,
    client: state.client,
    items: state.items,
    settings: state.settings,
    terms: state.terms,
    today: todayIso(),
  });
}

/** Preview prints the same document issuing does, and changes nothing. It
 *  exists so the first look at an invoice is not also the act that freezes it. */
async function preview(button) {
  button.disabled = true;
  try {
    const snapshot = snapshotNow();
    await printSnapshot(snapshot, invoiceFilename(state.invoice, clientName(), todayIso()));
  } catch (error) {
    toast(errorMessage(error), 'error');
  } finally {
    button.disabled = false;
  }
}

async function issue(button) {
  if (state.dirty) await save();

  const stopping = blockers(state.problems);
  if (stopping.length) {
    toast(`Fix ${stopping.length} thing${stopping.length === 1 ? '' : 's'} first.`, 'error');
    nodes.problems.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }

  const confirmed = await confirmModal({
    title: `Issue INV ${invoiceLabel(state.invoice.number)} for ${formatMoney(state.totals.due)}?`,
    body: 'This freezes the document. An issued invoice cannot be edited — to change '
        + 'it you void it and raise a new one.',
    confirmLabel: 'Issue invoice',
  });
  if (!confirmed) return;

  button.disabled = true;
  button.textContent = 'Issuing…';

  try {
    const snapshot = snapshotNow();
    const hash = await digest(snapshot);

    await issueInvoice({ id: state.id, snapshot, hash });
    await printSnapshot(snapshot, invoiceFilename(state.invoice, clientName(), todayIso()));

    toast('Issued and frozen.', 'ok');
    window.location.reload();
  } catch (error) {
    toast(errorMessage(error), 'error');
    button.disabled = false;
    button.textContent = 'Issue and download';
  }
}

// Rendering the page
// ---------------------------------------------------------------------------

function notFound() {
  mount(byId('portal-root'),
    el('div', { class: 'panel' }, [
      el('h1', { text: 'Invoice not found' }),
      el('p', { text: 'It may have been deleted.' }),
      el('p', {}, [
        el('a', { class: 'btn btn--ghost btn--small', href: '/portal/admin/invoices/', text: 'Back to the list' }),
      ]),
    ]),
  );
}

function panel(title, children, lede, action) {
  return el('section', { class: 'panel' }, [
    el('div', { class: 'panel__head' }, [
      el('div', {}, [
        el('h2', { text: title }),
        lede ? el('p', { class: 'progress__label', text: lede }) : null,
      ]),
      action ? el('div', { class: 'page-head__actions' }, [action]) : null,
    ]),
    ...children.filter(Boolean),
  ]);
}

function buildForm() {
  const invoice = state.invoice;
  const readOnly = state.readOnly;

  const header = panel('Invoice', [
    el('div', { class: 'form-grid' }, [
      field('number', 'Number', textInput('number', { type: 'number', value: invoice.number }),
        'Editable, so an invoice already sent on paper can be matched by hand.'),
      field('stage', 'This bills', selectInput('stage', STAGE_OPTIONS.map((option) => ({
        value: option.value,
        label: `${option.label} — ${option.hint}`,
      })), invoice.stage)),
      field('issued_on', 'Invoice date', textInput('issued_on', {
        type: 'date',
        value: invoice.issued_on || '',
      }), 'What the payment terms count from.'),
      field('due_on', 'Due', textInput('due_on', { type: 'date', value: invoice.due_on || '' })),
      field('project_name', 'Project', textInput('project_name', { value: invoice.project_name || '' })),
      field('project_id', 'Linked project', selectInput('project_id', [
        { value: '', label: 'Not linked to a project' },
        ...state.projects.map((row) => ({ value: row.id, label: row.name })),
      ], invoice.project_id || '')),
      field('purchase_order', 'Purchase order', textInput('purchase_order', {
        value: invoice.purchase_order || '',
        placeholder: 'Only if they gave you one',
      }), 'Some clients will not pay an invoice without theirs on it.'),
    ]),
    state.sow
      ? el('p', { class: 'notice' }, [
        `Billing against SOW ${sowLabel(state.sow.number, state.sow.revision)}`
        + `${state.invoice.project_name ? ` — ${state.invoice.project_name}` : ''}. `,
        el('a', {
          href: `/portal/admin/sow/?id=${encodeURIComponent(state.sow.id)}`,
          text: 'Open the scope of work',
        }),
      ])
      : null,
  ]);

  const summary = panel('Summary', [
    field('summary', 'What this is for', areaInput('summary', {
      value: invoice.summary || '',
      rows: 3,
      placeholder: 'One or two sentences. The client reads this before the numbers.',
    })),
  ], 'Optional, and worth the thirty seconds on anything that is not obvious from the lines.');

  const lines = panel('Lines', [
    nodes.lineList,
    readOnly ? null : el('div', { class: 'btn-row' }, [
      el('button', { class: 'btn btn--small', type: 'button', text: 'Add line', onclick: addBlankLine }),
      el('button', { class: 'btn btn--ghost btn--small', type: 'button', text: 'Bill hours', onclick: addHours }),
    ]),
  ], 'Quantity times rate. The amount is worked out, never typed.');

  const totals = panel('Total', [nodes.totals],
    'There are no discounts here on purpose — everything that came off was '
    + 'agreed on the scope of work, and is already in these numbers.');

  const notes = panel('Notes', [
    field('notes', 'Anything else on the document', areaInput('notes', {
      value: invoice.notes || '',
      rows: 3,
      placeholder: 'One per line. Prints as a short list at the foot of the invoice.',
    })),
  ]);

  const checks = panel('Before issuing', [nodes.problems]);

  // Only on an issued invoice, because the database refuses a payment against a
  // draft — there is nothing to pay yet.
  const payments = state.readOnly
    ? panel('Payments', [nodes.payments],
      'What has actually arrived. Each one posts itself to the books: the '
      + 'account it landed in goes up, and what this client owes goes down.',
      el('button', {
        class: 'btn btn--small',
        type: 'button',
        text: 'Record a payment',
        onclick: takePayment,
      }))
    : null;

  return [header, summary, lines, totals, payments, notes, checks].filter(Boolean);
}

/**
 * Money in.
 *
 * Only the payments panel and the invoice's own header are re-rendered
 * afterwards. A full rebuild would be simpler and would also throw away
 * anything half-typed elsewhere on the form.
 */
async function takePayment() {
  const recorded = await openRecordPayment(state.invoice, state.paymentContext);
  if (!recorded) return;

  await refreshPayments();
  toast('Payment recorded, and posted to the books.', 'ok');
}

async function refreshPayments() {
  try {
    const [payments, invoice] = await Promise.all([
      paymentsForInvoice(state.id),
      loadInvoice(state.id),
    ]);
    state.payments = payments;
    if (invoice && invoice.invoice) state.invoice.paid_cents = invoice.invoice.paid_cents;
    if (invoice && invoice.invoice) state.invoice.status = invoice.invoice.status;
  } catch (error) {
    toast(errorMessage(error), 'error');
    return;
  }
  renderPayments();
  recompute();
}

function renderPayments() {
  mount(nodes.payments, ...paymentRows(state.payments, { onChange: refreshPayments }));
}

function actionBar() {
  if (state.readOnly) {
    return el('div', { class: 'page-head__actions' }, [
      el('button', {
        class: 'btn btn--ghost btn--small',
        type: 'button',
        text: 'Download again',
        onclick: async (event) => {
          const button = event.currentTarget;
          button.disabled = true;
          try {
            // The stored snapshot, not a fresh assembly: re-printing a frozen
            // document has to give the document that was frozen, even if the
            // terms or the party block have changed since.
            const stored = state.invoice.snapshot;
            await printSnapshot(stored || snapshotNow(),
              invoiceFilename(state.invoice, clientName(),
                state.invoice.issued_on || state.invoice.issued_at || todayIso()));
          } catch (error) {
            toast(errorMessage(error), 'error');
          } finally {
            button.disabled = false;
          }
        },
      }),
    ]);
  }

  return el('div', { class: 'page-head__actions' }, [
    el('button', {
      class: 'btn btn--ghost btn--small',
      type: 'button',
      text: 'Preview',
      onclick: (event) => preview(event.currentTarget),
    }),
    el('button', {
      class: 'btn btn--small',
      type: 'button',
      text: 'Issue and download',
      onclick: (event) => issue(event.currentTarget),
    }),
  ]);
}

function frozenNotice() {
  if (!state.readOnly) return null;

  return el('div', { class: 'panel panel--frozen' }, [
    el('h2', { text: 'Issued and frozen' }),
    el('p', {
      text: `Issued ${fmtDateTime(state.invoice.issued_at)}. This invoice cannot be `
          + 'edited — a client is holding a copy of it. To change what is owed, '
          + 'void it from the list and raise a new one.',
    }),
    state.invoice.snapshot_hash
      ? el('p', { class: 'progress__label' }, [
        'Content hash ',
        el('code', { text: state.invoice.snapshot_hash.slice(0, 16) }),
        ' — the document as it was issued.',
      ])
      : null,
  ]);
}

async function main() {
  const ctx = await bootstrap({ requireAdmin: true });
  if (!ctx) return;

  const id = new URLSearchParams(window.location.search).get('id');
  if (!id || !UUID_RE.test(id)) {
    notFound();
    return;
  }

  let loaded;
  try {
    loaded = await loadInvoice(id);
    if (!loaded) {
      notFound();
      return;
    }

    state.id = id;
    state.invoice = loaded.invoice;
    state.client = loaded.client;
    state.items = loaded.items;
    state.sow = loaded.sow;
    state.readOnly = Boolean(loaded.invoice.issued_at);

    const [settings, terms, projects, billed, accounts, deposits, payments] =
      await Promise.all([
        loadSettings(),
        loadTerms(),
        loadProjects(loaded.invoice.client_id),
        // What is already billed against the scope of work, this invoice
        // excluded — otherwise a draft would be counted against itself and every
        // invoice would look like an overrun.
        billedAgainstSow(loaded.invoice.sow_id),
        loadAccounts({ includeArchived: false }),
        paymentContext(),
        state.readOnly ? paymentsForInvoice(id) : Promise.resolve([]),
      ]);

    state.settings = settings;
    state.terms = terms;
    state.projects = projects;
    state.incomeAccounts = accounts.filter((row) => row.type === 'income');
    state.paymentContext = deposits;
    state.payments = payments;
    state.billed = Math.max(0, billed - (loaded.invoice.status === 'void'
      ? 0
      : Number(loaded.invoice.total_cents) || 0));
  } catch (error) {
    renderError(error);
    return;
  }

  mount(byId('portal-root'),
    el('p', { class: 'breadcrumb' }, [
      el('a', { href: '/portal/admin/invoices/', text: '← Invoices' }),
    ]),
    el('div', { class: 'page-head' }, [
      el('div', {}, [
        el('h1', { text: `INV ${invoiceLabel(state.invoice.number)}` }),
        el('p', {}, [
          `${clientName()} · ${stageLabel(state.invoice.stage)} · `,
          state.readOnly
            ? `Issued ${fmtDate(state.invoice.issued_at)}`
            : nodes.saveState,
        ]),
      ]),
      actionBar(),
    ]),
    frozenNotice(),
    ...buildForm(),
  );

  // Read-only means read-only: the form renders with real values so the
  // document can be checked, and every control in it is disabled.
  if (state.readOnly) {
    byId('portal-root').querySelectorAll('input, textarea, select').forEach((node) => {
      node.disabled = true;
    });
  } else {
    setSaveState('Saved');
  }

  renderLines();
  if (state.readOnly) renderPayments();
  recompute();

  window.addEventListener('pagehide', flushOnHide);
  window.addEventListener('beforeunload', (event) => {
    if (!state.dirty && !state.saving) return;
    event.preventDefault();
    event.returnValue = '';
  });
}

main();
