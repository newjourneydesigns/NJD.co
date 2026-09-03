// ---------------------------------------------------------------------------
// The invoice form, and the frozen document it becomes.
//
// A small screen on purpose. There are lines, dates, and the terms. The one
// piece of arithmetic is quantity × rate, which exists because billing six
// hours of consulting is a real thing the business does; the tax on the
// taxable lines is the other, and it is off unless the invoice says so.
//
// Three habits:
//
//   Nothing is lost. Edits save a beat after you stop typing, through the
//   save_invoice RPC, which rewrites the header and every line together.
//
//   An issued invoice cannot be edited. Once issued this screen renders the
//   stored snapshot as a document, offers to print it again, and takes
//   payments against it. The database refuses any other write regardless —
//   see the guard triggers in supabase/schema.sql.
//
//   The checks before issuing are split into things that stop you and things
//   that are worth a look.
// ---------------------------------------------------------------------------

import { errorMessage } from './client.js';
import { bootstrap, renderError } from './shell.js';
import {
  el, mount, byId, toast, busy, formModal, fmtDate, fmtDateTime, confirmModal, table,
} from './ui.js';
import { formatMoney, parseMoney, resolveHourlyRate, centsOf } from './money.js';
import { isoToday, addDays, longDate, lines as textLines } from './doc-common.js';
import { reorderList, moveItem } from './reorder.js';
import {
  LINE_PRESETS,
  blockers,
  formatRate,
  invoiceFilename,
  invoiceLabel,
  invoiceTotals,
  isValidNumber,
  itemAmount,
  overdueDays,
  parseRate,
  statusLabel,
  statusTone,
  validate,
} from './invoice-catalog.js';
import { assemble, digest } from './invoice-doc.js';
import { printSnapshot } from './invoice-print.js';
import { openRecordPayment, paymentRows, paymentsForInvoice } from './payments.js';
import {
  deleteInvoice,
  duplicateInvoice,
  issueInvoice,
  loadClients,
  loadInvoice,
  loadInvoiceSettings,
  loadStudio,
  markExpensesBilled,
  saveInvoice,
  setStatus,
  unbilledExpenses,
} from './invoice-data.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SAVE_DELAY_MS = 1200;

const LIST_URL = '/portal/invoices/';

const state = {
  id: null,
  invoice: null,
  client: null,
  items: [],
  clients: [],
  studio: null,
  settings: null,
  payments: [],
  totals: null,
  problems: [],
  readOnly: false,
  dirty: false,
  saving: false,
  // Whether the per-line taxable boxes are on screen, so a rate typed into
  // the header can bring them out without a full re-render on every key.
  taxShown: false,
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

function textInput(name, { type = 'text', value = '', placeholder = '', inputmode = null } = {}) {
  const input = el('input', {
    type,
    id: `inv-${name}`,
    name,
    placeholder: placeholder || null,
    inputmode,
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
  return input;
}

function valueOf(name) {
  const input = inputs.get(name);
  if (!input) return '';
  if (input.type === 'checkbox') return input.checked;
  return input.value.trim();
}

function setValue(name, value) {
  const input = inputs.get(name);
  if (input) input.value = value == null ? '' : value;
}

/** Any edit to the header: read the form, redo the sums, queue the save. */
function touch(event) {
  if (state.readOnly) return;
  const changed = event && event.target ? event.target.name : '';

  // The due date follows the terms. Typing a new date or a new Net N moves
  // it; typing straight into the due date leaves the two alone.
  if ((changed === 'issued_on' || changed === 'net_days') && valueOf('issued_on')) {
    const net = Number(valueOf('net_days'));
    if (Number.isFinite(net) && net >= 0) setValue('due_on', addDays(valueOf('issued_on'), net));
  }

  state.dirty = true;
  readForm();
  recompute();

  // A rate arriving or leaving changes what every line asks for.
  const taxNow = centsOf(state.invoice.tax_rate_bp) > 0;
  if (taxNow !== state.taxShown) renderLines();

  queueSave();
}

function readForm() {
  const invoice = state.invoice;

  invoice.number = valueOf('number');
  invoice.issued_on = valueOf('issued_on') || null;
  invoice.due_on = valueOf('due_on') || null;

  const net = Number(valueOf('net_days'));
  if (valueOf('net_days') !== '' && Number.isFinite(net) && net >= 0 && net <= 365) {
    invoice.net_days = Math.round(net);
  }

  invoice.project_name = valueOf('project_name');
  invoice.purchase_order = valueOf('purchase_order');
  invoice.summary = valueOf('summary');
  invoice.notes = valueOf('notes');

  // Blank means no tax. A typo keeps the rate as it was rather than reading
  // as "no tax" — the checks flag it either way.
  const rateText = valueOf('tax_rate');
  const rate = rateText === '' ? 0 : parseRate(rateText);
  if (rate !== null) invoice.tax_rate_bp = rate;

  // paid_cents is deliberately not read from the form. It is the sum of the
  // payments recorded against this invoice, maintained by a trigger, and a
  // second place to type it would be a second answer to "how much came in".
}

/** The client picker. Changing it saves at once and reloads the client row,
 *  because the "Billed to" block and the hourly rate come off that row. */
async function changeClient(clientId) {
  if (state.readOnly || !clientId) return;
  state.invoice.client_id = clientId;
  state.dirty = true;
  readForm();
  recompute();

  const saved = await save();
  if (!saved) return;

  try {
    const loaded = await loadInvoice(state.id);
    if (loaded) {
      state.client = loaded.client;
      state.invoice.client = loaded.client;
    }
  } catch (error) {
    toast(errorMessage(error), 'error');
    return;
  }
  renderHead();
  recompute();
}

// The lines
// ---------------------------------------------------------------------------

// The lines live in memory until the debounced save writes the whole invoice,
// so reordering them is an array move and nothing else — no position column,
// no round trip. Only the grip is shared with the database-backed lists.
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

function rowControls(index, label) {
  return el('div', { class: 'btn-row' }, [
    el('button', {
      class: 'btn btn--ghost btn--tiny',
      type: 'button',
      text: 'Remove',
      'aria-label': `Remove ${label}`,
      onclick: () => {
        state.items.splice(index, 1);
        state.dirty = true;
        renderLines();
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
 * rather than typed: a total somebody can type is a total that can disagree
 * with the numbers above it.
 */
function lineRow(item, index) {
  const id = `line-${index}`;

  const name = el('input', {
    type: 'text',
    id: `${id}-name`,
    list: 'inv-line-presets',
    value: item.name || '',
  });
  name.addEventListener('input', () => {
    item.name = name.value;
    state.dirty = true;
    recompute();
    queueSave();
  });

  const description = el('textarea', { id: `${id}-desc`, rows: 2 });
  description.value = item.description || '';
  description.addEventListener('input', () => {
    item.description = description.value;
    state.dirty = true;
    queueSave();
  });

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
    amount.textContent = formatMoney(itemAmount(item));
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
    amount.textContent = formatMoney(itemAmount(item));
    recompute();
    queueSave();
  });
  unit.addEventListener('blur', () => {
    if (item.unit_cents) unit.value = formatMoney(item.unit_cents).replace(/^\$/, '');
  });

  const amount = el('p', { class: 'row-card__amount', text: formatMoney(itemAmount(item)) });

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
    lineOrder.handle(index, item.name ? `${item.name}` : `line ${index + 1}`),
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
        amount,
      ]),
    ]),
    el('div', { class: 'form-field' }, [
      el('label', { for: `${id}-desc`, text: 'Description' }),
      description,
    ]),
    state.taxShown
      ? el('div', { class: 'form-field form-field--check' }, [
        taxable,
        el('label', { for: `${id}-taxable`, text: 'Sales tax applies to this line' }),
      ])
      : null,
    rowControls(index, item.name ? `the line "${item.name}"` : `line ${index + 1}`),
  ]);
}

function renderLines() {
  state.taxShown = centsOf(state.invoice.tax_rate_bp) > 0;
  mount(nodes.lineList, ...(state.items.length
    ? state.items.map(lineRow)
    : [el('p', {
      class: 'empty',
      text: 'No lines yet. Add one, bill hours at the client\'s rate, or pass on '
          + 'the costs marked billable to them.',
    })]));
  lineOrder.attach(nodes.lineList);
}

function pushLines(newItems) {
  state.items.push(...newItems);
  state.dirty = true;
  renderLines();
  recompute();
  queueSave();
}

function addBlankLine() {
  pushLines([{ name: '', description: '', quantity: 1, unit_cents: 0, taxable: false }]);
}

/**
 * Hours at the rate.
 *
 * The rate is this client's negotiated one if they have one, the business's
 * standard rate from Admin → Business details if they do not — the same
 * resolveHourlyRate() the client form explains. When neither exists the
 * button refuses rather than pricing a line at $0.00 an hour, which is the
 * kind of invoice that gets paid exactly as written.
 */
async function addHours() {
  const { cents: rate, negotiated, missing } = resolveHourlyRate(
    state.client && state.client.hourly_rate_cents,
    state.studio,
  );

  if (missing) {
    toast('There is no hourly rate to bill at. Set the standard rate under '
        + 'Admin → Business details, or a negotiated rate on this client.', 'error');
    return;
  }

  await formModal({
    title: 'Bill hours',
    submitLabel: 'Add line',
    intro: negotiated
      ? `At the ${formatMoney(rate)} an hour negotiated with this client. Change `
        + 'the rate here if this particular work was agreed at a different one.'
      : `At the standard ${formatMoney(rate)} an hour. Change the rate here if this `
        + 'work was agreed at a different one.',
    fields: [
      { name: 'what', label: 'What the work was', type: 'text', required: true, placeholder: 'Marketing consulting, August' },
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

      pushLines([{
        name: values.what,
        description: `${hours} hour${hours === 1 ? '' : 's'} at ${formatMoney(parsed)} an hour.`,
        quantity: hours,
        unit_cents: parsed,
        taxable: false,
      }]);
    },
  });
}

/**
 * Costs bought for this client and marked billable, passed on as lines.
 *
 * The expenses are stamped with this invoice only after the save that added
 * the lines has gone through, so a failed save cannot leave a cost marked as
 * billed on an invoice that does not carry it. The reverse — lines saved,
 * stamp failed — is the safer mistake: the cost is offered again next time,
 * and the person sees it twice rather than never.
 */
async function addExpenses() {
  if (!state.client) {
    toast('Pick a client first — the costs are theirs.', 'error');
    return;
  }

  let rows;
  try {
    rows = await unbilledExpenses(state.client.id);
  } catch (error) {
    toast(errorMessage(error), 'error');
    return;
  }

  if (!rows.length) {
    toast('Nothing to pass on: no expense is marked billable to this client and '
        + 'not yet on an invoice.', 'ok');
    return;
  }

  const describe = (row) => {
    const category = (row.category && row.category.name) || 'Expense';
    const vendor = row.vendor_name || (row.vendor && row.vendor.name) || '';
    return { category, vendor };
  };

  await formModal({
    title: 'Add unbilled expenses',
    submitLabel: 'Add as lines',
    intro: 'One line per cost, at the amount paid. Edit the lines afterwards if '
         + 'a markup was agreed. Each one is marked as billed on this invoice.',
    fields: [{
      name: 'expenses',
      label: 'Costs to pass on',
      type: 'checkboxes',
      required: true,
      value: rows.map((row) => row.id),
      options: rows.map((row) => {
        const { category, vendor } = describe(row);
        return {
          value: row.id,
          label: [
            fmtDate(row.spent_on),
            vendor ? `${category} · ${vendor}` : category,
            formatMoney(row.amount_cents),
            row.description || null,
          ].filter(Boolean).join(' — '),
        };
      }),
    }],
    onSubmit: async (values) => {
      const picked = rows.filter((row) => values.expenses.includes(row.id));
      if (!picked.length) throw new Error('Tick at least one.');

      const added = picked.map((row) => {
        const { category, vendor } = describe(row);
        return {
          name: vendor ? `${category} — ${vendor}` : category,
          description: [row.description, longDate(row.spent_on)].filter(Boolean).join(' · '),
          quantity: 1,
          unit_cents: centsOf(row.amount_cents),
          taxable: false,
        };
      });

      const before = state.items.length;
      state.items.push(...added);
      state.dirty = true;
      renderLines();
      recompute();

      const saved = await save();
      if (!saved) {
        state.items.splice(before, added.length);
        renderLines();
        recompute();
        throw new Error('The lines could not be saved, so nothing was added. Try again.');
      }

      await markExpensesBilled(picked.map((row) => row.id), state.id);
      toast(`${added.length} line${added.length === 1 ? '' : 's'} added.`, 'ok');
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

function feeBlock(totals, paidCents) {
  const paid = Math.max(0, centsOf(paidCents));
  const taxLabel = (state.settings && state.settings.tax_label) || 'Sales tax';

  return el('div', { class: 'fee-block' }, [
    totalLine('Subtotal', formatMoney(totals.subtotal_cents)),
    totals.tax_cents > 0
      ? totalLine(
        `${taxLabel} at ${formatRate(state.invoice.tax_rate_bp)} on ${formatMoney(totals.taxable_cents)}`,
        formatMoney(totals.tax_cents),
      )
      : null,
    totalLine('Total', formatMoney(totals.total_cents), paid > 0 ? '' : 'fee-line--total fee-line--split'),
    paid > 0 ? totalLine('Paid', `− ${formatMoney(paid)}`, 'fee-line--muted') : null,
    paid > 0
      ? totalLine('Balance due', formatMoney(totals.total_cents - paid), 'fee-line--total fee-line--split')
      : null,
  ]);
}

function renderTotals() {
  mount(nodes.totals, feeBlock(state.totals, state.invoice.paid_cents));
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

/** Redo the sums, write them onto the row the way save_invoice will, and run
 *  the checks against the result. */
function recompute() {
  const invoice = state.invoice;
  state.totals = invoiceTotals(state.items, invoice.tax_rate_bp);

  // Did the row we were handed already disagree with its own lines?
  //
  // Asked BEFORE the overwrite below, because after it the answer is always
  // no — which is what made invoice-catalog's "the saved total does not match"
  // blocker unable to fire. A row can arrive inconsistent (a copy carrying a
  // tax its rate no longer produces, a save that half-landed), and the editor
  // shows the recomputed figures, so pressing Issue without typing anything
  // would freeze a document the record does not agree with. Marking it dirty
  // means the correction is written before anything can be frozen.
  const stale = !state.readOnly && (
    invoice.subtotal_cents !== state.totals.subtotal_cents
    || invoice.tax_cents !== state.totals.tax_cents
    || invoice.total_cents !== state.totals.total_cents
  );

  invoice.subtotal_cents = state.totals.subtotal_cents;
  invoice.tax_cents = state.totals.tax_cents;
  invoice.total_cents = state.totals.total_cents;

  if (stale) queueSave();

  state.problems = validate(invoice, state.items, state.client);

  if (!state.readOnly) {
    renderTotals();
    renderProblems();
  }
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
      // A malformed number is left out so the database keeps the old one; the
      // checks say why it will not issue. A well-formed duplicate comes back
      // as "already exists" from the unique index.
      number: isValidNumber(invoice.number) ? String(invoice.number).trim() : '',
      status: invoice.status,
      issued_on: invoice.issued_on || '',
      due_on: invoice.due_on || '',
      net_days: invoice.net_days,
      project_name: invoice.project_name || '',
      purchase_order: invoice.purchase_order || '',
      summary: invoice.summary || '',
      notes: invoice.notes || '',
      subtotal_cents: totals.subtotal_cents,
      tax_rate_bp: centsOf(invoice.tax_rate_bp),
      tax_cents: totals.tax_cents,
      total_cents: totals.total_cents,
    },
    items: state.items.map((item, index) => ({
      name: item.name || '',
      description: item.description || '',
      quantity: item.quantity == null ? 1 : item.quantity,
      unit_cents: centsOf(item.unit_cents),
      amount_cents: itemAmount(item),
      taxable: Boolean(item.taxable),
      position: index,
    })),
  };
}

// The save in flight, if any. Saves are serialised rather than raced: a
// second one waits for the first to land and then sends the state as it
// stands, so the last write is always the newest one.
let inflight = null;

/** Write everything. Resolves true when it went through. */
async function save() {
  if (state.readOnly) return false;
  while (inflight) await inflight;

  inflight = (async () => {
    state.saving = true;
    setSaveState('Saving…');
    try {
      await saveInvoice(payload());
      state.dirty = false;
      setSaveState(`Saved ${fmtDateTime(new Date().toISOString())}`, 'ok');
      return true;
    } catch (error) {
      // The form keeps everything typed: a failed save is not a lost edit.
      setSaveState('Not saved — still on screen, try again', 'error');
      toast(errorMessage(error), 'error');
      return false;
    } finally {
      state.saving = false;
    }
  })();

  try {
    return await inflight;
  } finally {
    inflight = null;
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

// Issuing and printing
// ---------------------------------------------------------------------------

function clientName() {
  const client = state.client || {};
  return client.legal_name || client.name || 'client';
}

function snapshotNow() {
  return assemble({
    invoice: state.invoice,
    items: state.items,
    client: state.client,
    studio: state.studio,
    settings: state.settings,
  });
}

/** The document as it was frozen. A fresh assembly only when the stored one
 *  is missing, which it never is after issue_invoice has run. */
function storedSnapshot() {
  const stored = state.invoice.snapshot;
  return stored && stored.kind === 'invoice' ? stored : snapshotNow();
}

async function print(snapshot) {
  await printSnapshot(snapshot, invoiceFilename(state.invoice, clientName()), {
    paidCents: state.invoice.paid_cents,
  });
}

/** Preview prints the same document issuing does, and changes nothing. It
 *  exists so the first look at an invoice is not also the act that freezes it. */
async function preview() {
  try {
    await print(snapshotNow());
  } catch (error) {
    toast(errorMessage(error), 'error');
  }
}

/** Save → check → assemble → hash → issue_invoice → re-render → print. */
async function issue() {
  window.clearTimeout(saveTimer);
  // Always, not just when something is dirty. Freezing is the one action that
  // cannot be undone, and the row on the server is what the freeze reads: a
  // save here costs a round trip and removes the whole class of "the PDF says
  // one number and the record says another".
  const saved = await save();
  if (!saved) return;

  const stopping = blockers(state.problems);
  if (stopping.length) {
    toast(`Fix ${stopping.length} thing${stopping.length === 1 ? '' : 's'} first.`, 'error');
    nodes.problems.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }

  const confirmed = await confirmModal({
    title: `Issue ${invoiceLabel(state.invoice.number)} for ${formatMoney(state.totals.total_cents)}?`,
    body: 'This freezes the document. An issued invoice cannot be edited — to change '
        + 'it you void it and raise a new one.',
    confirmLabel: 'Issue invoice',
  });
  if (!confirmed) return;

  let snapshot;
  try {
    snapshot = snapshotNow();
    const hash = await digest(snapshot);
    await issueInvoice({ id: state.id, snapshot, hash });
    await reload();
  } catch (error) {
    toast(errorMessage(error), 'error');
    return;
  }

  toast('Issued and frozen.', 'ok');

  try {
    await print(storedSnapshot());
  } catch (error) {
    toast(errorMessage(error), 'error');
  }
}

// Status and lifecycle
// ---------------------------------------------------------------------------

/** Re-read the invoice, its client and its lines, and render from scratch. */
async function reload() {
  const loaded = await loadInvoice(state.id);
  if (!loaded) throw new Error('That invoice is no longer there.');

  state.invoice = loaded.invoice;
  state.client = loaded.client;
  state.items = loaded.items;
  state.readOnly = Boolean(loaded.invoice.issued_at);
  state.dirty = false;
  state.payments = state.readOnly ? await paymentsForInvoice(state.id) : [];

  renderPage();
}

async function markSent() {
  try {
    await setStatus(state.id, 'sent');
    await reload();
  } catch (error) {
    toast(errorMessage(error), 'error');
    return;
  }
  toast('Marked sent.', 'ok');
}

async function voidInvoice() {
  const ok = await confirmModal({
    title: `Void ${invoiceLabel(state.invoice.number)}?`,
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
    await setStatus(state.id, 'void');
    await reload();
  } catch (error) {
    toast(errorMessage(error), 'error');
    return;
  }
  toast('Voided.', 'ok');
}

async function removeDraft() {
  const ok = await confirmModal({
    title: `Delete draft ${invoiceLabel(state.invoice.number)}?`,
    body: 'The lines go with it. This cannot be undone.',
    confirmLabel: 'Delete draft',
    tone: 'danger',
  });
  if (!ok) return;

  window.clearTimeout(saveTimer);
  state.dirty = false;

  try {
    await deleteInvoice(state.id);
  } catch (error) {
    toast(errorMessage(error), 'error');
    return;
  }
  window.location.assign(LIST_URL);
}

async function duplicate() {
  window.clearTimeout(saveTimer);
  if (state.dirty && !state.readOnly) {
    const saved = await save();
    if (!saved) return;
  }

  let fresh;
  try {
    fresh = await duplicateInvoice(state.id);
  } catch (error) {
    toast(errorMessage(error), 'error');
    return;
  }
  window.location.assign(`/portal/invoice/?id=${encodeURIComponent(fresh)}`);
}

// Payments
// ---------------------------------------------------------------------------

async function takePayment() {
  const recorded = await openRecordPayment(state.invoice);
  if (!recorded) return;

  await refreshPayments();
  toast('Payment recorded.', 'ok');
}

/** Only the payments panel and the invoice's own header are re-rendered
 *  afterwards; the document itself has not changed. */
async function refreshPayments() {
  try {
    const [payments, loaded] = await Promise.all([
      paymentsForInvoice(state.id),
      loadInvoice(state.id),
    ]);
    state.payments = payments;
    if (loaded) {
      state.invoice.paid_cents = loaded.invoice.paid_cents;
      state.invoice.paid_at = loaded.invoice.paid_at;
      state.invoice.status = loaded.invoice.status;
    }
  } catch (error) {
    toast(errorMessage(error), 'error');
    return;
  }
  renderPage();
}

function renderPayments() {
  mount(nodes.payments, ...paymentRows(state.payments, { onChange: refreshPayments }));
}

// Rendering the page
// ---------------------------------------------------------------------------

function notFound() {
  mount(byId('portal-root'),
    el('div', { class: 'panel' }, [
      el('h1', { text: 'Invoice not found' }),
      el('p', { text: 'It may have been deleted.' }),
      el('p', {}, [
        el('a', { class: 'btn btn--ghost btn--small', href: LIST_URL, text: 'Back to the list' }),
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

function statusPill() {
  const tone = statusTone(state.invoice.status);
  return el('span', {
    class: tone ? `pill pill--${tone}` : 'pill',
    text: statusLabel(state.invoice.status),
  });
}

function overdueTag() {
  const late = overdueDays(state.invoice, isoToday());
  if (!late) return null;
  return el('span', { class: 'pill pill--red', text: `${late} day${late === 1 ? '' : 's'} overdue` });
}

const headNode = el('div', { class: 'page-head' });

function renderHead() {
  const invoice = state.invoice;

  mount(headNode,
    el('div', {}, [
      el('h1', { text: invoiceLabel(invoice.number) }),
      el('p', {}, state.readOnly
        ? [
          `${clientName()} · `,
          statusPill(),
          ' ',
          overdueTag(),
          ` · Issued ${fmtDate(invoice.issued_on || invoice.issued_at)}`,
        ]
        : [`${clientName()} · `, nodes.saveState]),
    ]),
    actionBar(),
  );
}

function actionBar() {
  const status = state.invoice.status;

  if (state.readOnly) {
    return el('div', { class: 'page-head__actions btn-row' }, [
      el('button', {
        class: 'btn btn--small',
        type: 'button',
        text: 'Download again',
        onclick: busy(async () => {
          try {
            // The stored snapshot, not a fresh assembly: re-printing a frozen
            // document has to give the document that was frozen, even if the
            // letterhead or the terms have changed since.
            await print(storedSnapshot());
          } catch (error) {
            toast(errorMessage(error), 'error');
          }
        }),
      }),
      status === 'issued'
        ? el('button', {
          class: 'btn btn--ghost btn--small',
          type: 'button',
          text: 'Mark sent',
          onclick: busy(markSent, { label: 'Marking…' }),
        })
        : null,
      el('button', {
        class: 'btn btn--ghost btn--small',
        type: 'button',
        text: 'Duplicate',
        onclick: busy(duplicate, { label: 'Copying…' }),
      }),
      ['issued', 'sent'].includes(status)
        ? el('button', {
          class: 'btn btn--danger btn--small',
          type: 'button',
          text: 'Void',
          onclick: busy(voidInvoice),
        })
        : null,
    ]);
  }

  return el('div', { class: 'page-head__actions btn-row' }, [
    el('button', {
      class: 'btn btn--ghost btn--small',
      type: 'button',
      text: 'Preview',
      onclick: busy(preview),
    }),
    el('button', {
      class: 'btn btn--ghost btn--small',
      type: 'button',
      text: 'Duplicate',
      onclick: busy(duplicate, { label: 'Copying…' }),
    }),
    el('button', {
      class: 'btn btn--danger btn--small',
      type: 'button',
      text: 'Delete draft',
      onclick: busy(removeDraft),
    }),
    el('button', {
      class: 'btn btn--small',
      type: 'button',
      text: 'Issue and download',
      onclick: busy(issue, { label: 'Issuing…' }),
    }),
  ]);
}

/** The draft form. */
function buildForm() {
  const invoice = state.invoice;
  inputs.clear();

  const clientSelect = el('select', { id: 'inv-client_id', name: 'client_id' }, [
    ...(state.clients.some((row) => row.id === invoice.client_id)
      ? []
      : [el('option', { value: invoice.client_id || '', text: clientName() })]),
    ...state.clients.map((row) => el('option', {
      value: row.id,
      text: row.status && row.status !== 'active' ? `${row.name} (${row.status})` : row.name,
      selected: row.id === invoice.client_id,
    })),
  ]);
  clientSelect.addEventListener('change', () => changeClient(clientSelect.value));

  const header = panel('Invoice', [
    el('div', { class: 'form-grid' }, [
      field('client_id', 'Client', clientSelect,
        'The "Billed to" block, and the rate hours are billed at, come off the client record.'),
      field('number', 'Number', textInput('number', { value: invoice.number }),
        'The date it was raised and that day\'s sequence, like 20260901-1. Editable, and must stay unique.'),
      field('issued_on', 'Invoice date', textInput('issued_on', {
        type: 'date',
        value: invoice.issued_on || '',
      }), 'What the payment terms count from.'),
      field('net_days', 'Terms (Net days)', textInput('net_days', {
        type: 'number',
        inputmode: 'numeric',
        value: invoice.net_days == null ? '' : invoice.net_days,
      }), 'Moves the due date. Net 15 for most clients, Net 30 for some.'),
      field('due_on', 'Due', textInput('due_on', { type: 'date', value: invoice.due_on || '' })),
      field('project_name', 'Project', textInput('project_name', {
        value: invoice.project_name || '',
        placeholder: 'What the work was called',
      })),
      field('purchase_order', 'Purchase order', textInput('purchase_order', {
        value: invoice.purchase_order || '',
        placeholder: 'Only if they gave you one',
      }), 'Some clients will not pay an invoice without theirs on it.'),
      field('tax_rate', 'Sales tax rate', textInput('tax_rate', {
        inputmode: 'decimal',
        placeholder: '0',
        value: centsOf(invoice.tax_rate_bp) ? formatRate(invoice.tax_rate_bp).replace('%', '') : '',
      }), 'Leave blank for none. With a rate set, each line says whether it applies.'),
    ]),
  ]);

  const summary = panel('Summary', [
    field('summary', 'What this is for', areaInput('summary', {
      value: invoice.summary || '',
      rows: 3,
      placeholder: 'One or two sentences. The client reads this before the numbers.',
    })),
  ], 'Optional, and worth the thirty seconds on anything that is not obvious from the lines.');

  const linesPanel = panel('Lines', [
    el('datalist', { id: 'inv-line-presets' }, LINE_PRESETS.map((name) => el('option', { value: name }))),
    nodes.lineList,
    el('div', { class: 'btn-row' }, [
      el('button', { class: 'btn btn--small', type: 'button', text: 'Add line', onclick: addBlankLine }),
      el('button', { class: 'btn btn--ghost btn--small', type: 'button', text: 'Bill hours', onclick: addHours }),
      el('button', {
        class: 'btn btn--ghost btn--small',
        type: 'button',
        text: 'Add unbilled expenses',
        onclick: busy(addExpenses),
      }),
    ]),
  ], 'Quantity times rate. The amount is worked out, never typed.');

  const totals = panel('Total', [nodes.totals]);

  const notes = panel('Notes', [
    field('notes', 'Anything else on the document', areaInput('notes', {
      value: invoice.notes || '',
      rows: 3,
      placeholder: 'One per line. Prints as a short list at the foot of the invoice.',
    })),
  ]);

  const checks = panel('Before issuing', [nodes.problems]);

  return [header, summary, linesPanel, totals, notes, checks];
}

/** The frozen document, on screen. What has been paid is rendered beside it
 *  from the row, not from the snapshot, so it moves as payments are recorded. */
function documentView() {
  const snapshot = storedSnapshot();
  const from = snapshot.from || {};
  const to = snapshot.billed_to;
  const tax = snapshot.tax || {};
  const totals = {
    subtotal_cents: snapshot.subtotal_cents,
    taxable_cents: 0,
    tax_cents: tax.cents,
    total_cents: snapshot.total_cents,
  };

  const partyBlock = (label, party) => el('div', { class: 'detail-block' }, [
    el('div', { class: 'progress__label', text: label }),
    el('div', { text: party.name || '' }),
    ...(party.address || []).map((line) => el('div', { class: 'progress__label', text: line })),
    party.contactName ? el('div', { class: 'progress__label', text: `Attn: ${party.contactName}` }) : null,
    party.contactEmail ? el('div', { class: 'progress__label', text: party.contactEmail }) : null,
  ]);

  const facts = [
    ['Issued', longDate(snapshot.issued_on)],
    ['Due', longDate(snapshot.due_on)],
    ['Terms', snapshot.net_days == null ? '' : `Net ${snapshot.net_days}`],
    ['Purchase order', snapshot.purchase_order],
    ['Project', snapshot.project_name],
  ].filter(([, value]) => Boolean(value));

  const rows = (snapshot.lines || []).map((line) => {
    const qty = Number(line.quantity);
    const working = Number.isFinite(qty) && qty !== 1 ? `${qty} × ${formatMoney(line.unit_cents)}` : '—';
    return el('tr', {}, [
      el('td', {}, [
        el('span', { class: 'row-cell__name', text: line.name }),
        line.description ? el('span', { class: 'row-cell__desc', text: line.description }) : null,
      ]),
      el('td', { class: 'is-tight', text: working }),
      el('td', { class: 'is-numeric', text: formatMoney(line.amount_cents) }),
    ]);
  });

  const taxLine = tax.cents > 0
    ? `${tax.label || 'Sales tax'} at ${formatRate(tax.rate_bp)}`
      + (tax.registration ? ` · Permit ${tax.registration}` : '')
    : null;

  return panel('Document', [
    el('div', { class: 'form-grid' }, [
      partyBlock('From', from),
      to ? partyBlock('Billed to', to) : null,
    ]),
    el('dl', { class: 'detail-list' }, facts.map(([label, value]) => el('div', { class: 'detail-row' }, [
      el('dt', { class: 'detail-row__label', text: label }),
      el('dd', { class: 'detail-row__value', text: value }),
    ]))),
    snapshot.summary ? el('p', { text: snapshot.summary }) : null,
    table(['Description', 'Qty × rate', 'Amount'], rows),
    el('div', { class: 'fee-block' }, [
      totalLine('Subtotal', formatMoney(totals.subtotal_cents)),
      taxLine ? totalLine(taxLine, formatMoney(tax.cents)) : null,
      totalLine('Total', formatMoney(totals.total_cents),
        centsOf(state.invoice.paid_cents) > 0 ? '' : 'fee-line--total fee-line--split'),
      centsOf(state.invoice.paid_cents) > 0
        ? totalLine('Paid', `− ${formatMoney(state.invoice.paid_cents)}`, 'fee-line--muted')
        : null,
      centsOf(state.invoice.paid_cents) > 0
        ? totalLine('Balance due',
          formatMoney(centsOf(totals.total_cents) - centsOf(state.invoice.paid_cents)),
          'fee-line--total fee-line--split')
        : null,
    ]),
    snapshot.payment_details
      ? el('dl', { class: 'detail-list' }, [
        el('div', { class: 'detail-row' }, [
          el('dt', { class: 'detail-row__label', text: 'How to pay' }),
          el('dd', { class: 'detail-row__value' }, [
            el('div', { class: 'detail-block' },
              textLines(snapshot.payment_details).map((line) => el('div', { text: line }))),
          ]),
        ]),
        snapshot.late_note
          ? el('div', { class: 'detail-row' }, [
            el('dt', { class: 'detail-row__label', text: 'Late payment' }),
            el('dd', { class: 'detail-row__value', text: snapshot.late_note }),
          ])
          : null,
      ])
      : null,
    snapshot.notes
      ? el('ul', { class: 'problem-list' }, textLines(snapshot.notes).map((line) => (
        el('li', { class: 'problem-list__item is-warning', text: line })
      )))
      : null,
  ], 'The document as it was issued. Payments are shown beside it and move as they are recorded.');
}

function frozenNotice() {
  const invoice = state.invoice;
  const isVoid = invoice.status === 'void';

  return el('div', { class: 'panel panel--frozen' }, [
    el('h2', { text: isVoid ? 'Voided' : 'Issued and frozen' }),
    el('p', {
      text: isVoid
        ? 'Nothing is owed on this invoice. It stays on file because its number was '
          + 'used; duplicate it to bill the work again.'
        : `Issued ${fmtDateTime(invoice.issued_at)}. This invoice cannot be edited — `
          + 'a client is holding a copy of it. To change what is owed, void it and '
          + 'raise a new one.',
    }),
    invoice.snapshot_hash
      ? el('p', { class: 'progress__label' }, [
        'Content hash ',
        el('code', { text: invoice.snapshot_hash.slice(0, 16) }),
        ' — the document as it was issued.',
      ])
      : null,
  ]);
}

function paymentsPanel() {
  const status = state.invoice.status;
  return panel('Payments', [nodes.payments],
    'What has actually arrived. The invoice is marked paid once the payments cover '
    + 'the total, and goes back to sent if one is removed.',
    status === 'void'
      ? null
      : el('button', {
        class: 'btn btn--small',
        type: 'button',
        text: 'Record a payment',
        onclick: takePayment,
      }));
}

function renderPage() {
  window.clearTimeout(saveTimer);
  renderHead();

  if (state.readOnly) {
    mount(byId('portal-root'),
      el('p', { class: 'breadcrumb' }, [el('a', { href: LIST_URL, text: '← Invoices' })]),
      headNode,
      frozenNotice(),
      documentView(),
      paymentsPanel(),
    );
    renderPayments();
    recompute();
    return;
  }

  mount(byId('portal-root'),
    el('p', { class: 'breadcrumb' }, [el('a', { href: LIST_URL, text: '← Invoices' })]),
    headNode,
    ...buildForm(),
  );

  setSaveState('Saved');
  renderLines();
  recompute();
}

async function main() {
  const ctx = await bootstrap({ requireAdmin: true });
  if (!ctx) return;

  const id = new URLSearchParams(window.location.search).get('id');
  if (!id || !UUID_RE.test(id)) {
    notFound();
    return;
  }

  try {
    const loaded = await loadInvoice(id);
    if (!loaded) {
      notFound();
      return;
    }

    state.id = id;
    state.invoice = loaded.invoice;
    state.client = loaded.client;
    state.items = loaded.items;
    state.readOnly = Boolean(loaded.invoice.issued_at);

    const [studio, settings, clients, payments] = await Promise.all([
      loadStudio(),
      loadInvoiceSettings(),
      state.readOnly ? Promise.resolve([]) : loadClients(),
      state.readOnly ? paymentsForInvoice(id) : Promise.resolve([]),
    ]);

    state.studio = studio;
    state.settings = settings;
    state.clients = clients;
    state.payments = payments;
  } catch (error) {
    renderError(error);
    return;
  }

  renderPage();

  window.addEventListener('pagehide', flushOnHide);
  window.addEventListener('beforeunload', (event) => {
    if (!state.dirty && !state.saving) return;
    event.preventDefault();
    event.returnValue = '';
  });
}

main();
