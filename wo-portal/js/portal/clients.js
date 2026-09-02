// ---------------------------------------------------------------------------
// Clients — the searchable list, and the way in to one record.
//
// This is a finding screen and almost nothing else. Everything you can do
// *to* a client happens on the record behind it (js/portal/client-detail.js):
// the list's job is to get you there in one search and one tap, whether you
// remember the business name, the person you spoke to, or half of an email
// address. The one thing you can do from here is reach somebody — the contact
// column's emails and numbers are the same tap targets the record offers
// (js/portal/contact-actions.js), because a call is not a reason to open a
// record first.
//
// It used to be a panel on Admin, under the form entries and above the
// journeys. That put the most-visited table on the site three scrolls down a
// page about accounts and templates. Its own nav item and its own URL is the
// difference between "where was that" and going straight there.
//
// Staff only.
// ---------------------------------------------------------------------------

import { supabase, errorMessage } from './client.js';
import { bootstrap, renderError } from './shell.js';
import {
  el, mount, byId, toast, titleCase,
  table, filterField,
} from './ui.js';
import { openClientForm, openClientDuplicateForm } from './client-form.js';
import { tapAction, emailAction, phoneAction } from './contact-actions.js';

// Where a client sits with the studio, in the order a record moves through it.
// Matches the options on the client form (js/portal/client-form.js).
const STATUS_OPTIONS = [
  { value: 'lead', label: 'Lead' },
  { value: 'active', label: 'Active' },
  { value: 'past', label: 'Past' },
];

const state = { clients: [] };

const filters = { query: '', status: '' };

// Loading
// ---------------------------------------------------------------------------

async function loadClients() {
  // Still one query. The embedded projects serve two columns at once: their
  // count, and the names the contact column's email action offers when it
  // asks which project a mail is about (js/portal/contact-actions.js).
  const { data, error } = await supabase
    .from('clients')
    .select('*, projects(id, name, status, starts_on, created_at)')
    .order('name');

  if (error) throw error;
  state.clients = data || [];
}

async function refresh() {
  try {
    await loadClients();
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
  ...STATUS_OPTIONS.map((option) => el('option', { value: option.value, text: option.label })),
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
 *  the business name, the person, the email and the phone all match. */
function matches(client) {
  if (filters.status && (client.status || 'active') !== filters.status) return false;

  const query = filters.query.trim().toLowerCase();
  if (!query) return true;

  return [client.name, client.contact_name, client.contact_email, client.contact_phone]
    .some((field) => String(field || '').toLowerCase().includes(query));
}

// Rendering
// ---------------------------------------------------------------------------

function statusPill(status) {
  const tone = { active: 'green', lead: 'amber' }[status] || '';
  return el('span', {
    class: tone ? `pill pill--${tone}` : 'pill',
    text: titleCase(status || 'active'),
  });
}

/** The embedded projects, as an array even for a client that has none. */
function clientProjects(client) {
  return Array.isArray(client.projects) ? client.projects : [];
}

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
      ? tapAction(who.email, `Email ${who.name || client.name}`,
        () => emailAction(who, client, clientProjects(client)))
      : null,
    who.phone
      ? tapAction(who.phone, `Call or text ${who.name || client.name}`,
        () => phoneAction(who, client, clientProjects(client)))
      : null,
  ].filter(Boolean);

  if (!taps.length) return ['—'];
  return [el('div', { class: 'contact-stack' }, taps)];
}

function renderRows() {
  const visible = state.clients.filter(matches);

  // The record carries the whole CRM now, but the table stays a list you can
  // scan: who, how to reach them, where they stand. The name is the way in —
  // that cell is always visible, where the actions column is the first thing
  // to slide off the edge of a narrow screen.
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
    el('td', {}, [statusPill(client.status)]),
    el('td', { text: String(clientProjects(client).length) }),
    // Two actions in one cell, so each one says whose row it is: "Edit" read
    // out on its own, forty times down a list, tells a screen reader nothing.
    el('td', {}, [
      el('div', { class: 'btn-row' }, [
        el('button', {
          class: 'btn btn--ghost btn--tiny',
          type: 'button',
          text: 'Edit',
          'aria-label': `Edit ${client.name}`,
          onclick: () => showClientForm(client),
        }),
        el('button', {
          class: 'btn btn--ghost btn--tiny',
          type: 'button',
          text: 'Duplicate',
          'aria-label': `Duplicate ${client.name}`,
          onclick: () => duplicateClient(client),
        }),
      ]),
    ]),
  ]));

  // Both numbers only while a filter is on, so an unfiltered list never reads
  // as though something is being held back.
  count.textContent = filtersActive()
    ? `Showing ${visible.length} of ${state.clients.length} clients`
    : `${visible.length} ${visible.length === 1 ? 'client' : 'clients'}`;

  mount(rowsHost,
    count,
    visible.length
      ? table(['Client', 'Contact', 'Status', 'Projects', ''], rows)
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
        text: 'No clients yet. Add one here — or start a project from Projects '
            + 'and create the client on the same form.',
      }),
    );
    return;
  }

  mount(panel, renderFilters(), rowsHost);
  renderRows();
}

/** The shared form (js/portal/client-form.js) does the editing and the toasts;
 *  this page only has to redraw its table afterwards. */
async function showClientForm(client) {
  const result = await openClientForm(client);
  if (result) await refresh();
  return result;
}

/** Start a new client from an existing one — the second location, the sister
 *  company, the landlord who sends four buildings' worth of work under four
 *  names. The same form, prefilled; the copy is created only when it is
 *  submitted, and lands next to its original once the list re-sorts by name. */
async function duplicateClient(client) {
  const result = await openClientDuplicateForm(client);
  if (result) await refresh();
}

// ---------------------------------------------------------------------------

async function main() {
  const ctx = await bootstrap({ requireAdmin: true });
  if (!ctx) return;

  try {
    await loadClients();
  } catch (error) {
    renderError(error);
    return;
  }

  mount(byId('portal-root'),
    el('div', { class: 'page-head' }, [
      el('div', {}, [
        el('h1', { text: 'Clients' }),
        el('p', { text: 'Everyone on the books. Open a name for their record — '
                      + 'projects, contacts, documents and notes.' }),
      ]),
      el('div', { class: 'page-head__actions' }, [
        el('button', {
          class: 'btn btn--small',
          type: 'button',
          text: 'Add client',
          onclick: () => showClientForm(null),
        }),
      ]),
    ]),
    panel,
  );

  render();
}

main();
