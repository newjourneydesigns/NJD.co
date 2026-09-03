// ---------------------------------------------------------------------------
// One client, end to end: who they are, what they have been billed, what has
// been spent on them, what is filed under them, who to call, and everything
// that has been said.
//
// Clients (js/portal/clients.js) lists them; this is the record behind a row.
// It is a page rather than a wider table because it is read on a phone between
// jobs — a number to tap, what is still owed, and what was agreed last time.
// Editing the record happens here too: the Details panel opens the same form
// the list uses (js/portal/client-form.js), so the two cannot drift.
//
// Six panels under a sticky section bar: Details, Invoices, Expenses,
// Documents (js/portal/client-documents.js), Contacts, Notes.
//
// Invoices and expenses belong to other pages. The two panels here read those
// tables with small loaders of their own rather than importing the modules
// behind /portal/invoices/ and /portal/expenses/ — a handful of columns each,
// listed at the loader, so what this page depends on is visible in one place.
//
// Staff-only, and the schema agrees: every table here is is_admin() in both
// directions.
// ---------------------------------------------------------------------------

import { supabase, errorMessage } from './client.js';
import { bootstrap, renderError } from './shell.js';
import {
  el, mount, byId, toast, busy, formModal, panelHead,
  fmtDate, fmtDateTime, titleCase, statusPill, confirmModal,
} from './ui.js';
import { formatMoney } from './money.js';
import { isoToday } from './doc-common.js';
import { tapAction, phoneAction, emailAction } from './contact-actions.js';
import { sectionNav } from './section-nav.js';
import { reorderList, positionWriter } from './reorder.js';
import {
  openClientForm, openClientDuplicateForm, deleteClient, clientDeleteWarning,
} from './client-form.js';
import { renderClientDocuments } from './client-documents.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// now() is transaction-time, so both defaults land identical on insert. The
// window is defensive: an "edited" stamp that appears on a note nobody touched
// is worse than one that takes a couple of seconds to become true.
const EDIT_GRACE_MS = 2000;

let ctx = null;
let client = null;
let contacts = [];
let notes = [];
let invoices = [];
let expenses = [];

// The list nodes each render into. Module-level, so re-rendering the contacts
// after a reorder never rebuilds the page head — or throws away a half-typed
// note sitting in the composer above the feed. The head has its own node for
// the same reason in reverse: saving the edit form redraws the name up top
// without touching anything below it.
const pageHead = el('div', { class: 'page-head' });
const detailList = el('dl', { class: 'detail-list' });
const documentsHost = el('div');
const invoiceList = el('div', { class: 'record-list' });
const expenseList = el('div', { class: 'record-list' });
const contactList = el('div', { class: 'record-list' });
const noteFeed = el('div', { class: 'note-feed' });

const panels = {
  details: el('section', { class: 'panel' }),
  invoices: el('section', { class: 'panel' }),
  expenses: el('section', { class: 'panel' }),
  documents: el('section', { class: 'panel' }),
  contacts: el('section', { class: 'panel' }),
  notes: el('section', { class: 'panel' }),
};

function notFound() {
  mount(byId('portal-root'),
    el('div', { class: 'panel' }, [
      el('h1', { text: 'Client not found' }),
      el('p', { text: 'It may have been deleted.' }),
      el('p', {}, [
        el('a', { class: 'btn btn--ghost btn--small', href: '/portal/clients/', text: 'Back to Clients' }),
      ]),
    ]),
  );
}

// Loading
// ---------------------------------------------------------------------------

async function loadContacts() {
  const { data, error } = await supabase
    .from('client_contacts')
    .select('*')
    .eq('client_id', client.id)
    .order('position', { ascending: true })
    .order('created_at', { ascending: true });

  if (error) throw error;
  contacts = data || [];
}

/**
 * What they have been billed, and what is still outstanding. Beside the rest
 * of the record rather than buried on the Invoices page, because "what do
 * they owe us" is asked while looking at the client.
 *
 * Reads invoices: id, number, status, issued_on, due_on, total_cents,
 * paid_cents, project_name.
 */
async function loadInvoices() {
  const { data, error } = await supabase
    .from('invoices')
    .select('id, number, status, issued_on, due_on, total_cents, paid_cents, project_name')
    .eq('client_id', client.id)
    .order('created_at', { ascending: false });

  if (error) throw error;
  invoices = data || [];
}

/**
 * What has been spent on their behalf — the licence bought for their site,
 * the stock photo, the courier — and whether it has been passed on yet.
 *
 * Reads expenses: id, spent_on, amount_cents, description, vendor_name,
 * billable, billed_invoice_id, plus the category's and vendor's names through
 * their single foreign keys.
 */
async function loadExpenses() {
  const { data, error } = await supabase
    .from('expenses')
    .select('id, spent_on, amount_cents, description, vendor_name, billable, billed_invoice_id, '
          + 'category:expense_categories(name), vendor:vendors(name)')
    .eq('client_id', client.id)
    .order('spent_on', { ascending: false });

  if (error) throw error;
  expenses = data || [];
}

async function loadNotes() {
  const { data, error } = await supabase
    .from('client_notes')
    // client_notes has one foreign key into profiles, but naming the constraint
    // keeps the embed working if a second reference is ever added.
    .select('*, author:profiles!client_notes_author_id_fkey(full_name, email)')
    .eq('client_id', client.id)
    .order('created_at', { ascending: false });

  if (error) throw error;
  notes = data || [];
}

/** Reload one list and redraw it, surfacing a failure instead of leaving the
 *  old rows on screen pretending the write did not happen. */
async function reload(load, render) {
  try {
    await load();
  } catch (error) {
    toast(errorMessage(error), 'error');
    return;
  }
  render();
}

/** Re-fetch the record this page stands on, after anything writes to it. */
async function loadClient() {
  const { data, error } = await supabase
    .from('clients').select('*').eq('id', client.id).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('This client no longer exists.');
  client = data;
}

// Details
// ---------------------------------------------------------------------------

/** The primary contact, as contact-actions expects one. Their name is the
 *  person we deal with; the business name is a poor substitute but a better
 *  greeting than nothing. */
function primaryContact() {
  return {
    name: client.contact_name || '',
    email: client.contact_email || '',
    phone: client.contact_phone || '',
  };
}

/** A postal address the way it goes on an envelope, with every missing part
 *  closing up rather than leaving a blank line or a stray comma. */
function addressLines(row) {
  const locality = [row.city, row.region].filter(Boolean).join(', ');
  return [
    row.address_line1,
    row.address_line2,
    [locality, row.postal_code].filter(Boolean).join(' '),
    row.country,
  ].filter(Boolean);
}

function detailRow(label, value) {
  return el('div', { class: 'detail-row' }, [
    el('dt', { class: 'detail-row__label', text: label }),
    el('dd', { class: 'detail-row__value' }, [value]),
  ]);
}

function renderDetails() {
  const who = primaryContact();
  const rows = [];

  if (client.contact_name) {
    rows.push(detailRow('Contact', el('span', { text: client.contact_name })));
  }

  if (client.contact_email) {
    rows.push(detailRow('Email', tapAction(
      client.contact_email,
      `Email ${who.name || client.name}`,
      () => emailAction(who),
    )));
  }

  if (client.contact_phone) {
    rows.push(detailRow('Phone', tapAction(
      client.contact_phone,
      `Call or text ${who.name || client.name}`,
      () => phoneAction(who),
    )));
  }

  if (client.website) {
    rows.push(detailRow('Website', el('a', {
      class: 'detail-row__link',
      href: client.website,
      target: '_blank',
      rel: 'noopener noreferrer',
    }, [
      client.website,
      el('span', { class: 'visually-hidden', text: ' (opens in a new tab)' }),
    ])));
  }

  const address = addressLines(client);
  if (address.length) {
    rows.push(detailRow('Address', el('div', { class: 'detail-block' },
      address.map((line) => el('div', { text: line })))));
  }

  // Only when it differs: a legal name that repeats the business name is a
  // line that says nothing.
  if (client.legal_name && client.legal_name !== client.name) {
    rows.push(detailRow('Legal name', el('span', { text: client.legal_name })));
  }

  // Status is never null in the schema, so it is the one row always worth a
  // line — and the one an empty record still tells you something with.
  rows.push(detailRow('Status', statusPill(client.status || 'active')));

  // Both billing rows are always shown, absent as well as present: "standard"
  // is an answer, and a missing row would read as a field nobody filled in.
  rows.push(detailRow('Hourly rate', el('span', {
    text: client.hourly_rate_cents
      ? `${formatMoney(client.hourly_rate_cents)} an hour, negotiated`
      : 'Standard rate',
  })));
  rows.push(detailRow('Payment terms', el('span', {
    text: client.net_days == null
      ? 'Standard terms'
      : (client.net_days === 0 ? 'Due on receipt' : `Net ${client.net_days}`),
  })));

  // clients.notes is the free-text field on the client record itself, edited
  // behind Edit client above. Shown as "Background" so it does not read as a
  // second thing called Notes beside the dated feed below — but shown, because
  // a field only visible inside an edit form may as well not exist.
  if (client.notes) {
    rows.push(detailRow('Background', el('p', { class: 'note__body', text: client.notes })));
  }

  mount(detailList, ...rows);
}

/** Open the shared client form on this record, then redraw what it changed —
 *  which includes the name and status up in the page head. */
async function editClient() {
  const result = await openClientForm(client);
  if (!result) return;

  // The record this page stands on is gone; the list is the only place left.
  if (result === 'deleted') {
    window.location.replace('/portal/clients/');
    return;
  }

  await reload(loadClient, () => {
    renderHead();
    renderDetails();
  });
}

/** Copy this record into a new client. Nothing on this page changes — the copy
 *  is a different record — so the page goes to it: you duplicated it to work on
 *  the new one, and its own heading is the confirmation the toast would have
 *  been. */
async function duplicateClient() {
  const result = await openClientDuplicateForm(client);
  if (!result || !result.id) return;

  window.location.href = `/portal/client/?id=${encodeURIComponent(result.id)}`;
}

/** The same delete the edit form offers, one tap nearer. Same words, same
 *  refusal for an invoiced client (client-form.js owns both). */
async function removeClient() {
  const warning = clientDeleteWarning(client);
  const ok = await confirmModal({
    title: warning.title,
    body: warning.body,
    confirmLabel: 'Delete client',
    tone: 'danger',
  });
  if (!ok) return;

  try {
    await deleteClient(client);
  } catch (error) {
    toast(errorMessage(error), 'error');
    return;
  }

  toast('Client deleted.', 'ok');
  window.location.replace('/portal/clients/');
}

// Invoices
// ---------------------------------------------------------------------------

/** Days past due, or 0. Only an invoice that is out with the client can be
 *  late: a draft has no due date that means anything, a paid one is settled,
 *  a void one is cancelled. Date-only strings compare as strings. */
function overdueDays(row, today) {
  if (!row.due_on || !['issued', 'sent'].includes(row.status)) return 0;
  const due = String(row.due_on).slice(0, 10);
  if (due >= today) return 0;
  const [dy, dm, dd] = due.split('-').map(Number);
  const [ty, tm, td] = today.split('-').map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(dy, dm - 1, dd)) / 86400000);
}

function owedOn(row) {
  return (Number(row.total_cents) || 0) - (Number(row.paid_cents) || 0);
}

function invoiceRow(row) {
  const late = overdueDays(row, isoToday());
  const due = owedOn(row);
  const live = row.status === 'issued' || row.status === 'sent';

  return el('div', { class: 'record-row' }, [
    el('a', {
      class: 'record-row__name',
      href: `/portal/invoice/?id=${encodeURIComponent(row.id)}`,
      text: `Invoice ${row.number}`,
    }),
    el('p', {
      class: 'record-row__desc',
      text: [
        row.project_name,
        row.issued_on ? `Issued ${fmtDate(row.issued_on)}` : null,
        row.due_on ? `Due ${fmtDate(row.due_on)}` : null,
      ].filter(Boolean).join(' · '),
    }),
    el('div', { class: 'tag-row' }, [
      // The overdue tag sits beside the status rather than replacing it:
      // "Sent" says where the document is, "31 days overdue" says what to do.
      statusPill(row.status),
      late
        ? el('span', {
          class: 'tag tag--overdue',
          text: `${late} day${late === 1 ? '' : 's'} overdue`,
        })
        : null,
      el('span', { class: 'tag', text: formatMoney(row.total_cents) }),
      (Number(row.paid_cents) || 0) > 0
        ? el('span', { class: 'tag', text: `${formatMoney(row.paid_cents)} paid` })
        : null,
      live && due > 0 && due !== (Number(row.total_cents) || 0)
        ? el('span', { class: 'tag', text: `${formatMoney(due)} outstanding` })
        : null,
    ]),
  ]);
}

/** Cents still owed across issued and sent invoices — the number the lede
 *  and the panel foot both quote. */
function outstandingTotal() {
  return invoices
    .filter((row) => row.status === 'issued' || row.status === 'sent')
    .reduce((sum, row) => sum + Math.max(0, owedOn(row)), 0);
}

function renderInvoices() {
  if (!invoices.length) {
    mount(invoiceList, el('p', {
      class: 'empty',
      text: 'Nothing invoiced to this client yet.',
    }));
    return;
  }

  const outstanding = outstandingTotal();

  mount(invoiceList,
    ...invoices.map(invoiceRow),
    outstanding > 0
      ? el('p', {
        class: 'progress__label',
        text: `${formatMoney(outstanding)} outstanding.`,
      })
      : null,
  );
}

/**
 * Raise a blank draft for this client and go to it. create_invoice decides
 * the number, the terms and the tax rate in the database (contract §5), so
 * there is nothing to ask here — the editor is where the lines go.
 */
async function newInvoice() {
  try {
    const { data, error } = await supabase.rpc('create_invoice', { p_client_id: client.id });
    if (error) throw error;
    if (!data) throw new Error('The invoice was not created.');
    window.location.href = `/portal/invoice/?id=${encodeURIComponent(data)}`;
  } catch (error) {
    toast(errorMessage(error), 'error');
  }
}

// Expenses
// ---------------------------------------------------------------------------

function expenseRow(row) {
  const vendor = (row.vendor && row.vendor.name) || row.vendor_name || '';
  const category = (row.category && row.category.name) || '';
  const amount = Number(row.amount_cents) || 0;

  // Three states, one tag: passed on already, waiting to be, or the client's
  // cost that was never meant to be re-billed.
  const billing = row.billed_invoice_id
    ? el('span', { class: 'tag tag--due', text: 'Billed' })
    : (row.billable
      ? el('span', { class: 'tag tag--overdue', text: 'Unbilled' })
      : el('span', { class: 'tag', text: 'Not billable' }));

  return el('div', { class: 'record-row' }, [
    el('p', {
      class: 'record-row__name',
      text: row.description || vendor || category || 'Expense',
    }),
    el('p', {
      class: 'record-row__desc',
      text: [fmtDate(row.spent_on), vendor, category].filter(Boolean).join(' · '),
    }),
    el('div', { class: 'tag-row' }, [
      el('span', { class: 'tag', text: amount < 0 ? `${formatMoney(amount)} refund` : formatMoney(amount) }),
      billing,
    ]),
  ]);
}

function renderExpenses() {
  if (!expenses.length) {
    mount(expenseList, el('p', {
      class: 'empty',
      text: 'No expenses recorded against this client. Record one from Expenses '
          + 'and pick the client there.',
    }));
    return;
  }

  const unbilled = expenses
    .filter((row) => row.billable && !row.billed_invoice_id)
    .reduce((sum, row) => sum + (Number(row.amount_cents) || 0), 0);

  mount(expenseList,
    ...expenses.map(expenseRow),
    unbilled > 0
      ? el('p', {
        class: 'progress__label',
        text: `${formatMoney(unbilled)} billable and not yet on an invoice. `
            + 'The invoice editor can add it.',
      })
      : null,
  );
}

// Contacts
// ---------------------------------------------------------------------------

function contactFields(row = {}) {
  return [
    { name: 'name', label: 'Name', type: 'text', value: row.name || '', required: true },
    {
      name: 'title',
      label: 'Title',
      type: 'text',
      value: row.title || '',
      placeholder: 'Office manager',
    },
    { name: 'email', label: 'Email', type: 'email', value: row.email || '' },
    { name: 'phone', label: 'Phone', type: 'tel', value: row.phone || '', placeholder: '(555) 010-4477' },
  ];
}

function contactPatch(values) {
  return {
    name: values.name,
    title: values.title || null,
    email: values.email || null,
    phone: values.phone || null,
  };
}

function contactRow(row, index) {
  const taps = [
    row.phone
      ? tapAction(row.phone, `Call or text ${row.name}`, () => phoneAction(row))
      : null,
    row.email
      ? tapAction(row.email, `Email ${row.name}`, () => emailAction(row))
      : null,
  ].filter(Boolean);

  return el('div', { class: 'record-row' }, [
    contactOrder.handle(index, row.name),
    el('p', { class: 'record-row__name', text: row.name }),
    row.title ? el('p', { class: 'record-row__desc', text: row.title }) : null,
    taps.length ? el('div', { class: 'btn-row' }, taps) : null,
    // The page is behind requireAdmin, so there is no non-staff branch to guard:
    // anyone who can see this row can edit it.
    el('div', { class: 'btn-row' }, [
      el('button', {
        class: 'btn btn--ghost btn--tiny',
        type: 'button',
        text: 'Edit',
        'aria-label': `Edit ${row.name}`,
        onclick: () => editContact(row),
      }),
    ]),
  ]);
}

function renderContacts() {
  mount(contactList, ...(contacts.length
    ? contacts.map(contactRow)
    : [el('p', {
      class: 'empty',
      text: 'No other contacts yet. Add the office manager, whoever approves '
          + 'the work, whoever pays the invoices — in the order you would try them.',
    })]));
  contactOrder.attach(contactList);
}

function nextPosition() {
  return contacts.reduce((max, row) => Math.max(max, Number(row.position) || 0), -1) + 1;
}

async function addContact() {
  const position = nextPosition();

  const result = await formModal({
    title: 'Add contact',
    submitLabel: 'Add contact',
    intro: 'Only the name is required. The primary contact stays on the client '
         + 'record itself — these are the other people you end up calling.',
    fields: contactFields(),
    onSubmit: async (values) => {
      const { error } = await supabase.from('client_contacts').insert({
        client_id: client.id,
        position,
        ...contactPatch(values),
      });
      if (error) throw new Error(errorMessage(error));
    },
  });

  if (result) {
    await reload(loadContacts, renderContacts);
    toast('Contact added.', 'ok');
  }
}

async function editContact(row) {
  const result = await formModal({
    title: 'Edit contact',
    fields: contactFields(row),
    onSubmit: async (values) => {
      const { error } = await supabase
        .from('client_contacts')
        .update(contactPatch(values))
        .eq('id', row.id);
      if (error) throw new Error(errorMessage(error));
    },
    onDelete: async () => {
      const { error } = await supabase.from('client_contacts').delete().eq('id', row.id);
      if (error) throw new Error(errorMessage(error));
    },
    deleteLabel: 'Delete contact',
    confirmDelete: {
      title: `Delete ${row.name}?`,
      body: 'Only this contact row goes. The client record and everything else on it stay.',
    },
  });

  if (result === 'deleted') {
    await reload(loadContacts, renderContacts);
    toast('Contact deleted.', 'ok');
    return;
  }
  if (result) {
    await reload(loadContacts, renderContacts);
    toast('Contact updated.', 'ok');
  }
}

// The order these are listed in is the order you would try them, so it is
// worth being able to change: js/portal/reorder.js puts one grip on each row.
const contactOrder = reorderList({
  noun: 'contact',
  onReorder: positionWriter({
    client: supabase,
    table: 'client_contacts',
    rows: () => contacts,
    after: () => reload(loadContacts, renderContacts),
    onError: (error) => toast(errorMessage(error), 'error'),
  }),
});

// Notes
// ---------------------------------------------------------------------------

/** profiles is readable to staff, so the embed normally resolves. It comes back
 *  null for a note whose author's sign-in has since been removed — say so
 *  rather than leaving the byline blank. */
function authorName(note) {
  const author = note.author;
  if (author && author.full_name) return author.full_name;
  if (author && author.email) return author.email.split('@')[0];
  if (note.author_id && ctx && note.author_id === ctx.profile.id) return 'You';
  return note.author_id ? 'A former sign-in' : 'Someone';
}

function wasEdited(note) {
  if (!note.created_at || !note.updated_at) return false;
  return new Date(note.updated_at) - new Date(note.created_at) > EDIT_GRACE_MS;
}

/** Your own notes are yours to change. The owner can also tidy anyone's —
 *  including a note whose author no longer has a sign-in, which nobody else
 *  could ever remove. */
function canEditNote(note) {
  if (!ctx) return false;
  return ctx.isOwner || note.author_id === ctx.profile.id;
}

function noteRow(note) {
  return el('article', { class: 'note' }, [
    el('p', { class: 'note__meta' }, [
      el('strong', { text: authorName(note) }),
      ` · ${fmtDateTime(note.created_at)}`,
      // A note that can be rewritten in place and does not say so is weak
      // evidence of what was actually said.
      wasEdited(note)
        ? el('span', { class: 'note__edited', text: ` · edited ${fmtDateTime(note.updated_at)}` })
        : null,
    ]),
    // A text node, always: a note containing something that looks like markup
    // stays text.
    el('p', { class: 'note__body', text: note.body }),
    canEditNote(note)
      ? el('div', { class: 'btn-row' }, [
        el('button', {
          class: 'btn btn--ghost btn--tiny',
          type: 'button',
          text: 'Edit',
          'aria-label': `Edit note from ${fmtDateTime(note.created_at)}`,
          onclick: () => editNote(note),
        }),
        el('button', {
          class: 'btn btn--ghost btn--tiny',
          type: 'button',
          text: 'Delete',
          'aria-label': `Delete note from ${fmtDateTime(note.created_at)}`,
          onclick: () => deleteNote(note),
        }),
      ])
      : null,
  ]);
}

function renderNotes() {
  mount(noteFeed, ...(notes.length
    ? notes.map(noteRow)
    : [el('p', {
      class: 'empty',
      text: 'No notes yet. Write down what was said on the call — in a month it '
          + 'is the only record either of you will have.',
    })]));
}

async function editNote(note) {
  const result = await formModal({
    title: 'Edit note',
    fields: [{
      name: 'body',
      label: 'Note',
      type: 'textarea',
      rows: 5,
      value: note.body || '',
      required: true,
      hint: 'The note will be marked as edited, with the time you changed it.',
    }],
    onSubmit: async (values) => {
      // updated_at is maintained by the client_notes trigger, so the "edited"
      // stamp cannot be dodged by leaving it out of the patch.
      const { error } = await supabase
        .from('client_notes')
        .update({ body: values.body })
        .eq('id', note.id);
      if (error) throw new Error(errorMessage(error));
    },
  });

  if (result) {
    await reload(loadNotes, renderNotes);
    toast('Note updated.', 'ok');
  }
}

async function deleteNote(note) {
  const confirmed = await confirmModal({
    title: `Delete this note from ${fmtDateTime(note.created_at)}?`,
    body: 'This cannot be undone.',
    confirmLabel: 'Delete note',
    tone: 'danger',
  });
  if (!confirmed) return;

  try {
    const { error } = await supabase.from('client_notes').delete().eq('id', note.id);
    if (error) throw error;
  } catch (error) {
    toast(errorMessage(error), 'error');
    return;
  }

  await reload(loadNotes, renderNotes);
  toast('Note deleted.', 'ok');
}

/** Built once and kept, so a reload of the feed below never takes a half-typed
 *  note with it. A box and a button: what was said, saved. */
function buildComposer() {
  const textarea = el('textarea', {
    id: 'note-body',
    rows: 3,
    placeholder: 'What was said, agreed, or promised…',
  });

  const button = el('button', { class: 'btn btn--small', type: 'submit', text: 'Save note' });

  const form = el('form', { class: 'composer' }, [
    el('div', { class: 'form-field' }, [
      el('label', { for: 'note-body', text: 'Add a note' }),
      textarea,
    ]),
    el('div', { class: 'composer__foot' }, [button]),
  ]);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (button.disabled) return;

    const body = textarea.value.trim();
    if (!body) {
      toast('Write something first.', 'error');
      textarea.focus();
      return;
    }

    button.disabled = true;
    button.textContent = 'Saving…';

    try {
      const { error } = await supabase.from('client_notes').insert({
        client_id: client.id,
        author_id: ctx.profile.id,
        body,
      });
      if (error) throw error;

      textarea.value = '';
      await reload(loadNotes, renderNotes);
      textarea.focus();
    } catch (error) {
      // The text stays in the box: retyping a paragraph because of a dropped
      // connection is the fastest way to stop anyone writing notes at all.
      toast(errorMessage(error), 'error');
    } finally {
      button.disabled = false;
      button.textContent = 'Save note';
    }
  });

  return form;
}

// ---------------------------------------------------------------------------

/** The one line under the h1: where they stand and what they owe. */
function lede() {
  const parts = [`${titleCase(client.status || 'active')} client`];
  const count = invoices.length;
  parts.push(count === 1 ? '1 invoice' : `${count} invoices`);
  const owed = outstandingTotal();
  if (owed > 0) parts.push(`${formatMoney(owed)} outstanding`);
  return parts.join(' · ');
}

function renderHead() {
  mount(pageHead,
    el('div', {}, [
      el('h1', { text: client.name }),
      el('p', { text: lede() }),
    ]),
  );
}

async function main() {
  ctx = await bootstrap({ requireAdmin: true });
  if (!ctx) return;

  const id = new URLSearchParams(window.location.search).get('id');
  if (!id || !UUID_RE.test(id)) {
    notFound();
    return;
  }

  try {
    const { data, error } = await supabase
      .from('clients').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    // Null covers both a deleted record and one RLS declined to show, and the
    // page has no business telling those two apart.
    if (!data) {
      notFound();
      return;
    }
    client = data;

    await Promise.all([loadContacts(), loadNotes(), loadInvoices(), loadExpenses()]);
  } catch (error) {
    renderError(error);
    return;
  }

  mount(panels.details,
    panelHead('Details', el('div', { class: 'btn-row' }, [
      el('button', {
        class: 'btn btn--small',
        type: 'button',
        text: 'Edit client',
        onclick: editClient,
      }),
      el('button', {
        class: 'btn btn--ghost btn--small',
        type: 'button',
        text: 'Duplicate',
        'aria-label': `Duplicate ${client.name}`,
        onclick: duplicateClient,
      }),
      el('button', {
        class: 'btn btn--ghost btn--small',
        type: 'button',
        text: 'Delete',
        'aria-label': `Delete ${client.name}`,
        onclick: busy(removeClient),
      }),
    ])),
    detailList,
  );
  mount(panels.invoices,
    panelHead('Invoices', el('div', { class: 'btn-row' }, [
      el('button', {
        class: 'btn btn--small',
        type: 'button',
        text: 'New invoice',
        onclick: busy(newInvoice, { label: 'Raising…' }),
      }),
      el('a', {
        class: 'btn btn--ghost btn--small',
        href: '/portal/invoices/',
        text: 'All invoices',
      }),
    ])),
    invoiceList,
  );
  mount(panels.expenses,
    panelHead('Expenses', el('a', {
      class: 'btn btn--ghost btn--small',
      href: '/portal/expenses/',
      text: 'All expenses',
    }), 'Costs recorded against this client, and whether they have been passed on.'),
    expenseList,
  );
  mount(panels.documents, panelHead('Documents'), documentsHost);
  mount(panels.contacts,
    panelHead('Contacts', el('button', {
      class: 'btn btn--small',
      type: 'button',
      text: 'Add contact',
      onclick: addContact,
    })),
    contactList,
  );
  mount(panels.notes, panelHead('Notes'), buildComposer(), noteFeed);

  mount(byId('portal-root'),
    el('p', { class: 'breadcrumb' }, [
      el('a', { href: '/portal/clients/', text: '← Clients' }),
    ]),
    pageHead,
    // Six panels is past what scrolling serves on a phone. The bar pins under
    // the header and stays put; the section you are reading stays lit. The
    // panels are direct children of #portal-root, which is what the bar's
    // scroll-margin arithmetic assumes.
    sectionNav([
      { id: 'details', label: 'Details', target: panels.details },
      { id: 'invoices', label: 'Invoices', target: panels.invoices },
      { id: 'expenses', label: 'Expenses', target: panels.expenses },
      { id: 'documents', label: 'Documents', target: panels.documents },
      { id: 'contacts', label: 'Contacts', target: panels.contacts },
      { id: 'notes', label: 'Notes', target: panels.notes },
    ]),
    panels.details,
    panels.invoices,
    panels.expenses,
    panels.documents,
    panels.contacts,
    panels.notes,
  );

  renderHead();
  renderDetails();
  renderInvoices();
  renderExpenses();
  renderContacts();
  renderNotes();

  // Loads and manages itself. A failure in it costs that panel, not the
  // record around it.
  renderClientDocuments(documentsHost, ctx, client)
    .catch((error) => toast(errorMessage(error), 'error'));
}

main();
