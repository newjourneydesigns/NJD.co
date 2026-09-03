// ---------------------------------------------------------------------------
// Clients — the searchable list, and the way in to one record.
//
// This is a finding screen and almost nothing else. Everything you can do
// *to* a client happens on the record behind it (js/portal/client-detail.js):
// the list's job is to get you there in one search and one tap, whether you
// remember the business name, the person you spoke to, or half of an email
// address. Two things can be done from here without opening a record: reach
// somebody — the contact column's emails and numbers are the same tap targets
// the record offers (js/portal/contact-actions.js) — and see who owes money,
// because "who still has to pay us" is asked while looking at the list, not
// while looking at a client.
//
// Staff only.
// ---------------------------------------------------------------------------

import { supabase, errorMessage } from './client.js';
import { bootstrap, renderError } from './shell.js';
import {
  el, mount, byId, toast, statusPill,
  table, filterField,
} from './ui.js';
import { formatMoney } from './money.js';
import { openClientForm, CLIENT_STATUS_OPTIONS } from './client-form.js';
import { tapAction, emailAction, phoneAction } from './contact-actions.js';

const state = {
  clients: [],
  // client_id → cents still owed across their issued and sent invoices.
  outstanding: new Map(),
};

const filters = { query: '', status: '' };

// Loading
// ---------------------------------------------------------------------------

async function loadClients() {
  const { data, error } = await supabase
    .from('clients')
    .select('*')
    .order('name');

  if (error) throw error;
  state.clients = data || [];
}

/**
 * What each client still owes: total less paid, over invoices that are out
 * with them. A local read of `invoices` (client_id, total_cents, paid_cents,
 * status) rather than an import from the invoices modules — three columns
 * and a filter is not worth a dependency on a file mid-rewrite. Drafts are
 * not owed yet, void ones never were, and paid ones are done, so only
 * issued and sent count.
 */
async function loadOutstanding() {
  const { data, error } = await supabase
    .from('invoices')
    .select('client_id, total_cents, paid_cents')
    .in('status', ['issued', 'sent']);

  if (error) throw error;

  const owed = new Map();
  for (const row of data || []) {
    const due = (Number(row.total_cents) || 0) - (Number(row.paid_cents) || 0);
    if (due <= 0) continue;
    owed.set(row.client_id, (owed.get(row.client_id) || 0) + due);
  }
  state.outstanding = owed;
}

async function refresh() {
  try {
    await Promise.all([loadClients(), loadOutstanding()]);
    render();
  } catch (error) {
    toast(errorMessage(error), 'error');
  }
}

// Filtering
// ---------------------------------------------------------------------------
//
// The controls and the node the rows live in are built once and reused.
// Re-mounting the panel on every keystroke would detach the input, and a
// detached input is a blurred one — you would lose focus after the first
// letter.

const search = el('input', {
  type: 'search',
  id: 'client-search',
  placeholder: 'Name, contact, email or phone',
  // Half-typed email addresses are exactly what phone autocorrect mangles.
  autocapitalize: 'none',
  autocorrect: 'off',
  oninput: (event) => {
    filters.query = event.target.value;
    renderRows();
  },
});

const statusPicker = el('select', {
  id: 'client-status',
  onchange: (event) => {
    filters.status = event.target.value;
    renderRows();
  },
}, [
  el('option', { value: '', text: 'All statuses' }),
  ...CLIENT_STATUS_OPTIONS.map((option) => el('option', { value: option.value, text: option.label })),
]);

const rowsHost = el('div');

const count = el('p', { class: 'progress__label' });

function filtersActive() {
  return Boolean(filters.query.trim() || filters.status);
}

function clearFilters() {
  filters.query = '';
  filters.status = '';
  search.value = '';
  statusPicker.value = '';
  renderRows();
}

/** "I remember something about them" is what searching a client list means, so
 *  the business name, the legal name, the person, the email and the phone all
 *  match. */
function matches(client) {
  if (filters.status && (client.status || 'active') !== filters.status) return false;

  const query = filters.query.trim().toLowerCase();
  if (!query) return true;

  return [
    client.name, client.legal_name, client.contact_name,
    client.contact_email, client.contact_phone,
  ].some((field) => String(field || '').toLowerCase().includes(query));
}

// Rendering
// ---------------------------------------------------------------------------

/** How to reach them: the same tap targets the client record shows, opening
 *  the same sheets — an email drafts itself, a number offers the call or the
 *  text — so nothing here needs retyping into a phone. */
function contactCell(client) {
  const who = {
    name: client.contact_name || '',
    email: client.contact_email || '',
    phone: client.contact_phone || '',
  };

  const taps = [
    who.email
      ? tapAction(who.email, `Email ${who.name || client.name}`, () => emailAction(who))
      : null,
    who.phone
      ? tapAction(who.phone, `Call or text ${who.name || client.name}`, () => phoneAction(who))
      : null,
  ].filter(Boolean);

  if (!taps.length) return ['—'];
  return [el('div', { class: 'contact-stack' }, taps)];
}

/** Money owed, or a dash. Zero is shown as nothing rather than $0.00: a
 *  column of zeros makes the one real figure hard to find. */
function outstandingCell(client) {
  const owed = state.outstanding.get(client.id) || 0;
  return el('td', { class: 'is-numeric', text: owed > 0 ? formatMoney(owed) : '—' });
}

function renderRows() {
  const visible = state.clients.filter(matches);

  // A list you can scan: who, how to reach them, what they owe, where they
  // stand. The name is the way in — that cell is always visible, where the
  // last column is the first thing to slide off the edge of a narrow screen.
  const rows = visible.map((client) => el('tr', {}, [
    el('td', {}, [
      el('a', {
        href: `/portal/client/?id=${encodeURIComponent(client.id)}`,
        text: client.name,
      }),
      client.contact_name
        ? el('div', { class: 'progress__label', text: client.contact_name })
        : null,
    ]),
    el('td', {}, contactCell(client)),
    outstandingCell(client),
    el('td', {}, [statusPill(client.status || 'active')]),
  ]));

  // Both numbers only while a filter is on, so an unfiltered list never reads
  // as though something is being held back.
  count.textContent = filtersActive()
    ? `Showing ${visible.length} of ${state.clients.length} clients`
    : `${visible.length} ${visible.length === 1 ? 'client' : 'clients'}`;

  mount(rowsHost,
    count,
    visible.length
      ? table(['Client', 'Contact', 'Outstanding', 'Status'], rows)
      : el('p', {
        class: 'empty',
        text: 'Nothing matches that search. Try fewer letters, or clear the filters.',
      }),
  );
}

function renderFilters() {
  return el('div', { class: 'filters' }, [
    filterField('client-search', 'Search', search),
    filterField('client-status', 'Status', statusPicker),
    el('div', { class: 'filters__end' }, [
      el('button', {
        class: 'btn btn--ghost btn--tiny',
        type: 'button',
        text: 'Clear',
        onclick: () => clearFilters(),
      }),
    ]),
  ]);
}

// One panel and no heading inside it: the page head already says Clients, and a
// card captioned with the title of the page it is the only thing on is a line
// nobody reads twice.
const panel = el('section', { class: 'panel' });

function render() {
  if (!state.clients.length) {
    mount(panel,
      el('p', {
        class: 'empty',
        text: 'No clients yet. Add one here — an invoice needs a client to bill.',
      }),
    );
    return;
  }

  mount(panel, renderFilters(), rowsHost);
  renderRows();
}

/** The shared form (js/portal/client-form.js) does the editing and the toasts;
 *  a new client is opened straight away, because the next thing after adding
 *  one is almost always filing something under it or raising an invoice. */
async function addClient() {
  const result = await openClientForm(null);
  if (!result) return;
  if (result.id) {
    window.location.href = `/portal/client/?id=${encodeURIComponent(result.id)}`;
    return;
  }
  await refresh();
}

// ---------------------------------------------------------------------------

async function main() {
  const ctx = await bootstrap({ requireAdmin: true });
  if (!ctx) return;

  try {
    await Promise.all([loadClients(), loadOutstanding()]);
  } catch (error) {
    renderError(error);
    return;
  }

  mount(byId('portal-root'),
    el('div', { class: 'page-head' }, [
      el('div', {}, [
        el('h1', { text: 'Clients' }),
        el('p', { text: 'Everyone on the books. Open a name for their record — '
                      + 'invoices, expenses, documents, contacts and notes.' }),
      ]),
      el('div', { class: 'page-head__actions' }, [
        el('button', {
          class: 'btn btn--small',
          type: 'button',
          text: 'Add client',
          onclick: () => addClient(),
        }),
      ]),
    ]),
    panel,
  );

  render();
}

main();
