// ---------------------------------------------------------------------------
// Admin — quick links, journeys, and the staff who sign in.
//
// What is left here after Clients and Form Entries moved to pages of their own
// is the setup a studio touches rarely and deliberately: the journey templates
// a project is built from, and the staff accounts.
//
// Quick links are the exception and sit first for that reason: they are the one
// thing on this page somebody opens Admin *for*, several times a week, rather
// than twice a quarter. They own their own loading and reloading (quick-links.js)
// instead of riding loadAll(), so adding one never re-renders the People table
// somebody is halfway through searching.
//
// People here means *staff*. A client's sign-ins live on their own client
// record, in its People panel — one place per company, next to the contacts
// they belong with. The split is the whole navigation story: staff users are
// under Admin, client users are under the client.
//
// The one exception this page still owns out loud: a client-role account with
// no client assigned belongs to no page at all, and would otherwise vanish
// from every list while its owner signs in to an empty portal. Those are
// flagged here, because Admin is where somebody goes when a login "doesn't
// work".
//
// Accounts are created with a password already set, which is why this page
// talks to a Netlify function rather than to Postgres: assigning somebody
// else's password needs the service-role key, and that key can never be in a
// browser. The client page's People panel rides the same plumbing — see
// js/portal/accounts.js and netlify/functions/admin-users.js.
// ---------------------------------------------------------------------------

import { supabase, errorMessage } from './client.js';
import { bootstrap, renderError } from './shell.js';
import {
  el, mount, byId, toast, fmtDate, formModal, panelHead, table, stackedCell,
} from './ui.js';
import { passwordHandoff, welcomeHandoff } from './accounts.js';
import { openPersonForm as openSharedPersonForm } from './person-form.js';
import { filterPeople } from './people-search.js';
import { sectionNav } from './section-nav.js';
import { renderQuickLinks } from './quick-links.js';
import {
  KIND_ORDER, KIND_META, SEND_HOURS, resolvePrefs, prefRow,
} from './notification-prefs.js';

const state = {
  // Only id and name, and only for the person modal's client picker — the
  // clients screen owns the records themselves.
  clients: [],
  people: [],
  journeys: [],
  // profile_clients rows. Managed on each client's People panel; read here
  // only to tell a stray account from one that sees a client through a link.
  memberships: [],
  // notification_preferences rows for everybody. Admins may read and write
  // anyone's, which is the point of the Emails button on each row — somebody
  // who never opens their own settings can still have them set for them.
  emailPrefs: [],
  // A just-assigned password, held only until the next render draws it once.
  passwordNotice: null,
};

// Each panel keeps its own node so one mutation does not rebuild the whole page
// (and steal focus out of a <select> someone is still using).
const panels = {
  quickLinks: el('section', { class: 'panel' }),
  journeys: el('section', { class: 'panel' }),
  people: el('section', { class: 'panel' }),
};

let ctx = null;

// Loading
// ---------------------------------------------------------------------------

async function loadAll() {
  const [clients, people, journeys, memberships, emailPrefs] = await Promise.all([
    supabase.from('clients').select('id, name').order('name'),
    supabase
      .from('profiles')
      .select('id, email, full_name, phone, role, client_id, created_at')
      .order('created_at'),
    supabase
      .from('journeys')
      .select('*, journey_waypoints(count)')
      .order('position'),
    supabase.from('profile_clients').select('profile_id, client_id'),
    supabase
      .from('notification_preferences')
      .select('profile_id, kind, enabled, send_hour'),
  ]);

  for (const result of [clients, people, journeys, memberships, emailPrefs]) {
    if (result.error) throw result.error;
  }

  state.clients = clients.data || [];
  state.people = people.data || [];
  state.journeys = journeys.data || [];
  state.memberships = memberships.data || [];
  state.emailPrefs = emailPrefs.data || [];
}

async function refresh() {
  try {
    await loadAll();
    renderAll();
  } catch (error) {
    toast(errorMessage(error), 'error');
  }
}

// Shared bits
// ---------------------------------------------------------------------------

function waypointCount(journey) {
  const agg = journey.journey_waypoints;
  if (Array.isArray(agg)) return agg.length ? Number(agg[0].count) || 0 : 0;
  if (agg && typeof agg === 'object') return Number(agg.count) || 0;
  return 0;
}

// Journeys
// ---------------------------------------------------------------------------

function renderJourneys() {
  const rows = state.journeys.map((journey) => el('tr', {}, [
    el('td', {}, [
      el('strong', { text: journey.name }),
      journey.description
        ? el('p', { class: 'progress__label', text: journey.description })
        : null,
    ]),
    el('td', { text: String(waypointCount(journey)) }),
    el('td', {}, [
      journey.archived
        ? el('span', { class: 'pill pill--amber', text: 'Archived' })
        : el('span', { class: 'pill pill--green', text: 'In use' }),
    ]),
    el('td', {}, [
      el('div', { class: 'btn-row' }, [
        el('a', {
          class: 'btn btn--ghost btn--tiny',
          href: `/portal/admin/journey/?id=${encodeURIComponent(journey.id)}`,
          text: 'Waypoints',
        }),
        el('button', {
          class: 'btn btn--ghost btn--tiny',
          type: 'button',
          text: 'Edit',
          onclick: () => openJourneyForm(journey),
        }),
      ]),
    ]),
  ]));

  mount(panels.journeys,
    panelHead('Journeys', el('button', {
      class: 'btn btn--small',
      type: 'button',
      text: 'Add journey',
      onclick: () => openJourneyForm(null),
    })),
    el('p', {
      class: 'notice notice--info',
      text: 'A journey is a template of the waypoints a project usually has. '
          + 'Applying one copies its waypoints onto a project, so editing a '
          + 'journey later never disturbs work already under way.',
    }),
    state.journeys.length
      ? table(['Journey', 'Waypoints', 'Status', ''], rows)
      : el('p', {
        class: 'empty',
        text: 'No journeys yet. Add one and its waypoints become a starting '
            + 'point for every project of that shape.',
      }),
  );
}

async function openJourneyForm(journey) {
  const editing = Boolean(journey);

  const result = await formModal({
    title: editing ? 'Edit journey' : 'Add journey',
    submitLabel: editing ? 'Save journey' : 'Add journey',
    fields: [
      {
        name: 'name',
        label: 'Name',
        type: 'text',
        required: true,
        value: editing ? journey.name : '',
        placeholder: 'The Website Journey',
      },
      {
        name: 'description',
        label: 'Description',
        type: 'textarea',
        rows: 2,
        value: editing ? journey.description || '' : '',
        hint: 'For your eyes only — clients never see the template itself.',
      },
      {
        name: 'archived',
        label: 'Archived (hidden from the picker)',
        type: 'checkbox',
        value: editing ? journey.archived : false,
      },
    ],
    onSubmit: async (values) => {
      const patch = {
        name: values.name,
        description: values.description || null,
        archived: Boolean(values.archived),
      };

      const query = editing
        ? supabase.from('journeys').update(patch).eq('id', journey.id)
        : supabase.from('journeys').insert({
          ...patch,
          position: state.journeys.length,
        });

      const { error } = await query;
      if (error) throw new Error(errorMessage(error));
    },
    onDelete: editing
      ? async () => {
        const { error } = await supabase.from('journeys').delete().eq('id', journey.id);
        if (error) throw new Error(errorMessage(error));
      }
      : null,
    deleteLabel: 'Delete journey',
    // Worth spelling out: waypoints are copied onto projects, never linked,
    // so nothing a client can see disappears with the template.
    // Guarded like onDelete above, and for a reason that is easy to miss: this
    // object is an argument, so the template literal runs at the call, not at
    // the press. Unguarded, `journey.name` threw on Add journey — see the note
    // in person-form.js.
    confirmDelete: editing ? {
      title: `Delete "${journey.name}"?`,
      body: 'Projects already using it keep every waypoint — those are copies. '
          + 'Only the template goes.',
    } : undefined,
  });

  if (!result) return;

  if (result === 'deleted') toast('Journey deleted.', 'ok');
  else toast(editing ? 'Journey saved.' : 'Journey added.', 'ok');

  await refresh();
}

// Accounts
// ---------------------------------------------------------------------------
//
// The plumbing — callAdminUsers, generatePassword, passwordFields — lives in
// accounts.js, shared with the client page's "Give portal access" flow.

// People — the staff
// ---------------------------------------------------------------------------

/** Everybody whose account opens every client. */
function staffMembers() {
  return state.people.filter((person) => person.role === 'admin');
}

/** Client-role accounts that can see nothing: no home client, no membership
 *  rows. They belong on a client page, but no client page will list them —
 *  so this page does, loudly, until somebody assigns the client. */
function strayAccounts() {
  return state.people.filter((person) => person.role === 'client'
    && !person.client_id
    && !state.memberships.some((row) => row.profile_id === person.id));
}

/** The form, wired to this page's data and refreshed afterwards. The form
 *  itself is person-form.js, shared with the client record. Creating from
 *  here presets the role to staff — a client account made on this page would
 *  be on the wrong page. */
async function openPersonForm(person) {
  const result = await openSharedPersonForm({
    person,
    clients: state.clients,
    selfId: ctx.profile.id,
    presetRole: 'admin',
  });
  if (!result) return;

  if (result.deleted) {
    toast('Account deleted.', 'ok');
    await refresh();
    return;
  }

  if (result.handoff) state.passwordNotice = result.handoff;
  // The save stood but a side write did not — say so, or the refresh below
  // quietly shows fewer clients than were ticked.
  if (result.warning) toast(result.warning, 'error');
  // An account that was added rather than created announced itself as it went;
  // there is no new account here to report.
  if (!result.linkedExisting) toast(result.editing ? 'Person saved.' : 'Account created.', 'ok');
  await refresh();
}

// The search box is built once and kept. Rebuilding it on every keystroke
// would take the focus and the caret with it.
// Which emails a person gets
//
// Rendered from notification-prefs.js rather than a list written here, so
// adding a kind is one edit in one file and this screen picks it up. Somebody
// with no saved rows is not shown a blank form: resolvePrefs() fills in the
// defaults they are silently already on, because a settings screen showing
// everything off while email keeps arriving is a bug report waiting to happen.
async function openEmailPrefsForm(person) {
  const isAdmin = person.role === 'admin';
  const who = person.full_name || person.email || 'this person';
  const current = resolvePrefs(
    state.emailPrefs.filter((row) => row.profile_id === person.id),
    { isAdmin },
  );

  // The staff-only kinds are absent for a client rather than shown disabled:
  // the sender refuses them regardless, and a switch that does nothing is
  // worse than no switch at all.
  const kinds = KIND_ORDER.filter((kind) => current[kind].available);

  const fields = [];
  for (const kind of kinds) {
    const meta = KIND_META[kind];
    fields.push({
      name: `${kind}__on`,
      label: meta.title,
      type: 'checkbox',
      value: current[kind].enabled,
      hint: meta.blurb,
    });
    if (meta.scheduled) {
      fields.push({
        name: `${kind}__hour`,
        label: `${meta.title} — when`,
        type: 'select',
        value: String(current[kind].send_hour),
        options: SEND_HOURS.map((option) => ({
          value: String(option.value), label: option.label,
        })),
        hint: 'Central time. Nothing goes out when there is nothing to say.',
      });
    }
  }

  await formModal({
    title: `Emails for ${who}`,
    submitLabel: 'Save preferences',
    intro: 'The two reports go out at the time you pick. The rest arrive when '
      + 'the thing happens. Anything untouched here is the default they are '
      + 'already on.',
    fields,
    onSubmit: async (values) => {
      const rows = kinds.map((kind) => prefRow(person.id, kind, {
        enabled: values[`${kind}__on`],
        send_hour: Number(values[`${kind}__hour`]),
      }));

      const { error } = await supabase
        .from('notification_preferences')
        .upsert(rows, { onConflict: 'profile_id,kind' });
      if (error) throw error;

      toast(`Email preferences saved for ${who}.`, 'ok');
    },
  });

  await refresh();
}

const peopleSearch = el('input', {
  type: 'search',
  id: 'people-search',
  class: 'panel-search',
  placeholder: 'Search people…',
  'aria-label': 'Search people',
  autocomplete: 'off',
  autocapitalize: 'none',
  autocorrect: 'off',
  spellcheck: 'false',
});

const peopleNotice = el('div');
const strayNotice = el('div');
const peopleRows = el('div');
let peopleMounted = false;

/** What a row can be found by: every column the table shows, so the box never
 *  says "no such person" about somebody sitting in plain sight. */
function personFields(person) {
  return [
    person.full_name,
    person.email,
    person.phone,
    fmtDate(person.created_at),
  ];
}

function renderPeopleRows() {
  const staff = staffMembers();
  const query = peopleSearch.value;
  const shown = filterPeople(staff, query, personFields);

  if (!staff.length) {
    mount(peopleRows, el('p', {
      class: 'empty',
      text: 'No staff accounts yet. Use “Add a person” to create one — you '
          + 'set their password at the same time.',
    }));
    return;
  }

  if (!shown.length) {
    mount(peopleRows, el('p', {
      class: 'empty',
      text: `Nobody matches “${query.trim()}”.`,
    }));
    return;
  }

  mount(peopleRows,
    table(
      ['Person', 'Contact', 'Joined', 'Emails'],
      shown.map(personRow),
      { className: 'table--people' },
    ),
    // Only worth saying while the list is being narrowed.
    shown.length === staff.length
      ? null
      : el('p', {
        class: 'progress__label',
        text: `${shown.length} of ${staff.length} shown`,
      }),
  );
}

/** The accounts nobody's page will claim, each with its one-click way out of
 *  limbo — the modal, where assigning a client (or making them staff) moves
 *  them onto the right list. */
function renderStrays() {
  const strays = strayAccounts();
  if (!strays.length) {
    mount(strayNotice);
    return;
  }

  mount(strayNotice, el('div', { class: 'notice notice--error' }, [
    el('strong', {
      text: strays.length === 1
        ? 'One account can see nothing'
        : `${strays.length} accounts can see nothing`,
    }),
    el('p', {
      class: 'progress__label',
      text: 'These sign in as clients but have no client assigned, so their '
          + 'portal is empty — and no client page lists them. Assign the '
          + 'client and they move to that client\'s People panel.',
    }),
    ...strays.map((person) => el('div', { class: 'btn-row' }, [
      el('span', { text: person.full_name || person.email || 'Unnamed' }),
      person.email && person.full_name
        ? el('span', { class: 'progress__label', text: person.email })
        : null,
      el('button', {
        class: 'btn btn--ghost btn--tiny',
        type: 'button',
        text: 'Assign a client',
        'aria-label': `Assign a client to ${person.full_name || person.email || 'this account'}`,
        onclick: () => openPersonForm(person),
      }),
    ])),
  ]));
}

function renderPeople() {
  if (!peopleMounted) {
    peopleMounted = true;
    peopleSearch.addEventListener('input', renderPeopleRows);
    mount(panels.people,
      panelHead('People', el('div', { class: 'panel__tools' }, [
        peopleSearch,
        el('button', {
          class: 'btn btn--small',
          type: 'button',
          text: 'Add a person',
          onclick: () => openPersonForm(null),
        }),
      ])),
      el('p', {
        class: 'progress__label',
        text: 'The staff — accounts that open every client. Click a person to '
            + 'edit anything about them, including a new password. A client\'s '
            + 'own sign-ins live on their client page, under People.',
      }),
      peopleNotice,
      strayNotice,
      peopleRows,
    );
  }

  // The one-time password panel, shown until the next render. It sits above the
  // table because it is the only thing on this page that cannot be recovered by
  // looking again.
  if (state.passwordNotice) {
    const notice = state.passwordNotice;
    // This page presets new accounts to staff, but the Role select is free to
    // change and the Client picker is right there — so a client account can be
    // born here too, and when one is it gets the same welcome the client
    // record hands over. Same rule in both places, or it is not a rule.
    const company = notice.role !== 'admin' && notice.client_id
      ? (state.clients.find((row) => row.id === notice.client_id) || {}).name
      : null;

    mount(peopleNotice,
      passwordHandoff(notice.email, notice.password),
      notice.created && company
        ? welcomeHandoff({
          name: notice.full_name,
          clientName: company,
          email: notice.email,
          password: notice.password,
        }).node
        : null);
    state.passwordNotice = null;
  } else {
    mount(peopleNotice);
  }

  renderStrays();
  renderPeopleRows();
}

function personRow(person) {
  const who = person.full_name || person.email || 'Unnamed';

  return el('tr', {}, [
    el('td', {}, [
      el('button', {
        class: 'link-button',
        type: 'button',
        text: who,
        'aria-label': `Edit ${who}`,
        onclick: () => openPersonForm(person),
      }),
    ]),
    // Email above phone, one column: the phone is what a client's Call and
    // Text buttons dial, so it belongs where the studio checks its people.
    el('td', { class: 'is-tight' }, stackedCell([person.email || '—', person.phone])),
    el('td', { class: 'is-tight', text: fmtDate(person.created_at) }),
    el('td', { class: 'is-tight' }, [
      el('button', {
        class: 'link-button',
        type: 'button',
        text: 'Emails',
        'aria-label': `Email preferences for ${who}`,
        onclick: () => openEmailPrefsForm(person),
      }),
    ]),
  ]);
}

// ---------------------------------------------------------------------------

function renderAll() {
  renderJourneys();
  renderPeople();
}

async function main() {
  ctx = await bootstrap({ requireAdmin: true });
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
        el('h1', { text: 'Admin' }),
        el('p', {
          text: 'Shared links, journey templates and staff accounts. A '
              + 'client\'s sign-ins live on their client page, under People.',
        }),
      ]),
    ]),
    // Three panels is more than enough to lose the one you came for on a
    // phone, and the client record already taught everyone where this bar lives.
    sectionNav([
      { id: 'quick-links', label: 'Quick links', target: panels.quickLinks },
      { id: 'journeys', label: 'Journeys', target: panels.journeys },
      { id: 'people', label: 'People', target: panels.people },
    ]),
    panels.quickLinks,
    panels.journeys,
    panels.people,
  );

  renderAll();

  // After the page is standing, and allowed to fail on its own: a shortcut list
  // that will not load is not a reason for Admin to render as an error page.
  renderQuickLinks(panels.quickLinks, ctx.profile.id).catch((error) => {
    mount(panels.quickLinks, el('p', { class: 'notice notice--error', text: errorMessage(error) }));
  });
}

main();
