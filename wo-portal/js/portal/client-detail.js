// ---------------------------------------------------------------------------
// One client, end to end: who they are, what we are building, who to call, and
// everything that has been said.
//
// Clients (js/portal/clients.js) lists them; this is the record behind a row.
// It is a page rather than a wider table because it is read on a phone between
// jobs — a number to tap, the state of their projects, and what was agreed last
// time. Editing the record happens here too: the Details panel opens the same
// form the list uses (js/portal/client-form.js), so the two cannot drift.
//
// The master agreement also lives here: the signed copy is uploaded, replaced
// and downloaded from the Details row, in the private client-agreements
// bucket. The signed date stays the authoritative fact — the file is the
// evidence for it, and either can exist without the other.
//
// Below the details sits the Documents panel (client-documents.js): every PDF
// filed for this client, whether attached to the client record itself or to
// one of their projects, uploaded and found in the one place.
//
// Portal access starts here too: Give portal access on the primary contact or
// any contact row creates that person's sign-in, already linked to this client,
// and hands back the welcome message to send (js/portal/promote-contact.js).
// Contacts whose email matches an account linked to this client wear a Portal
// user pill instead of the button.
//
// The People panel is the roster those flows feed: every account that can
// sign in to this client's portal — home accounts and logins linked here from
// another company alike — edited, added to, and unlinked in the one place.
// Staff accounts are the other half of the split and live under Admin.
//
// Staff-only, and the schema agrees: client_contacts and client_notes have no
// select policy for clients at all, so their query returns zero rows rather
// than an error.
// ---------------------------------------------------------------------------

import { supabase, errorMessage } from './client.js';
import { bootstrap, renderError } from './shell.js';
import {
  el, mount, byId, toast, formModal, modalShell, panelHead,
  fmtBytes, fmtDate, fmtDateTime, titleCase, progressBar, statusPill, confirmModal,
} from './ui.js';
import { tapAction, phoneAction, emailAction } from './contact-actions.js';
import {
  mentionHandle, mentionSuggestions, mentionedIds, splitMentions,
} from './mentions.js';
import { sectionNav } from './section-nav.js';
import { reorderList, positionWriter } from './reorder.js';
import { promoteToPortalUser, findProfileByEmail } from './promote-contact.js';
import { openPersonForm } from './person-form.js';
import {
  passwordHandoff, welcomeHandoff, callAdminUsers, generatePassword,
} from './accounts.js';
import { driveLinkBar } from './drive-link.js';
import { openClientForm, openClientDuplicateForm } from './client-form.js';
import { renderClientDocuments } from './client-documents.js';
import { renderClientPaperwork } from './client-paperwork.js';
import { loadPaperworkRequests } from './signature-data.js';
import { renderSignaturePanel } from './signature-panel.js';
import { safeName, isMissingObject, MAX_UPLOAD_BYTES } from './files.js';
import { setQuickAddContext, NOTE_ADDED_EVENT } from './quick-add.js';
import { markProjectVisit, signalWork } from './timer-nudge.js';
import { attachAiRewrite } from './ai-rewrite.js';
import { AGREEMENTS_BUCKET } from './config.js';
import { sowLabel } from './sow-catalog.js';
import { formatMoney } from './sow-fees.js';
import { invoiceLabel, overdueDays, stageLabel } from './invoice-catalog.js';
import { invoicesForClient } from './invoice-data.js';
import { loadSettings } from './sow-data.js';
import { assembleMsa, msaFilename } from './msa-doc.js';
import { printMsa } from './msa-print.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PROJECT_SELECT =
  'id, name, status, starts_on, target_on, summary, waypoints(id, status)';

// now() is transaction-time, so both defaults land identical on insert. The
// window is defensive: an "edited" stamp that appears on a note nobody touched
// is worse than one that takes a couple of seconds to become true.
const EDIT_GRACE_MS = 2000;

let ctx = null;
let client = null;
let projects = [];
let contacts = [];
let notes = [];
let sows = [];
let invoices = [];
// What the signing layer says about this client's paperwork, in the five
// columns the trail needs. The Signatures panel loads the full rows itself.
let paperworkRequests = [];
let portalUsers = [];
let staff = [];
// For portal users who are here through a profile_clients link rather than
// their home client_id: profile id → their home client's name. Membership in
// this map is what marks a row "linked" and earns it an Unlink button.
let linkedHomes = new Map();

// Replaced once the Paperwork panel has drawn itself. Editing the client — the
// master agreement's signed date above all — changes what one of its steps
// says, and the panel has no way of knowing that on its own.
let redrawPaperwork = () => {};

// The list nodes each render into. Module-level, so re-rendering the contacts
// after a reorder never rebuilds the page head — or throws away a half-typed
// note sitting in the composer above the feed. The head has its own node for
// the same reason in reverse: saving the edit form redraws the name up top
// without touching anything below it.
const pageHead = el('div', { class: 'page-head' });
const detailList = el('dl', { class: 'detail-list' });
const documentsHost = el('div');
const projectList = el('div', { class: 'record-list' });
const contactList = el('div', { class: 'record-list' });
const peopleList = el('div', { class: 'record-list' });
const sowList = el('div', { class: 'record-list' });
const invoiceList = el('div', { class: 'record-list' });
const noteFeed = el('div', { class: 'note-feed' });

const panels = {
  details: el('section', { class: 'panel' }),
  paperwork: el('section', { class: 'panel' }),
  signatures: el('section', { class: 'panel' }),
  documents: el('section', { class: 'panel' }),
  projects: el('section', { class: 'panel' }),
  sows: el('section', { class: 'panel' }),
  invoices: el('section', { class: 'panel' }),
  contacts: el('section', { class: 'panel' }),
  people: el('section', { class: 'panel' }),
  notes: el('section', { class: 'panel' }),
  // Deliberately not .panel, unlike every sibling above: whiteboard.js draws
  // its own panel into whatever host it is given, the way the project page's
  // sections do, and nesting one inside another draws a card inside a card.
  whiteboard: el('section'),
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

async function loadProjects() {
  const { data, error } = await supabase
    .from('projects')
    .select(PROJECT_SELECT)
    .eq('client_id', client.id)
    .order('created_at', { ascending: false });

  if (error) throw error;
  projects = data || [];
}

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

/** Who can already sign in for this client — the People panel's roster, and
 *  what the Portal user pills and Give portal access buttons consult. Two
 *  sources, one list: profiles whose home is this client, and logins linked
 *  here through profile_clients. Both embeds name their constraint. The outer
 *  one must because profile_clients has a second foreign key into profiles
 *  (added_by). The nested one must because profile_clients is itself a
 *  junction table between profiles and clients — its two foreign keys are its
 *  primary key — so PostgREST offers a many-to-many path alongside the plain
 *  profiles.client_id one and refuses to choose. That ride-along is the linked
 *  login's home company, named on its row so "who is this person really" never
 *  needs a second page, and it is the direct foreign key we want. */
async function loadPortalUsers() {
  const [home, members] = await Promise.all([
    supabase
      .from('profiles')
      // Everything the person modal edits, because the People panel opens it
      // straight from this list rather than re-reading the row.
      .select('id, email, full_name, phone, role, client_id, created_at')
      .eq('client_id', client.id),
    supabase
      .from('profile_clients')
      .select('profile:profiles!profile_clients_profile_id_fkey('
        + 'id, email, full_name, phone, role, client_id, created_at, '
        + 'home:clients!profiles_client_id_fkey(name))')
      .eq('client_id', client.id),
  ]);

  if (home.error) throw home.error;
  if (members.error) throw members.error;

  const byId = new Map();
  const linked = new Map();
  (home.data || []).forEach((person) => byId.set(person.id, person));
  (members.data || []).forEach((row) => {
    if (!row.profile || byId.has(row.profile.id)) return;
    byId.set(row.profile.id, row.profile);
    linked.set(row.profile.id, (row.profile.home && row.profile.home.name) || null);
  });

  // Home accounts first — they are this client's own people — then the
  // borrowed logins, each group alphabetical.
  portalUsers = [...byId.values()].sort((a, b) => {
    const aLinked = linked.has(a.id) ? 1 : 0;
    const bLinked = linked.has(b.id) ? 1 : 0;
    if (aLinked !== bLinked) return aLinked - bLinked;
    return String(a.full_name || a.email || '')
      .localeCompare(String(b.full_name || b.email || ''));
  });
  linkedHomes = linked;
}

/** What they have bought, and what is out with them right now. This is also the
 *  history the one-page credit is detected from, so it is worth being able to
 *  see it rather than only having software believe it. */
async function loadSows() {
  const { data, error } = await supabase
    .from('sows')
    // snapshot_hash, not just exported_at: the signature rail's "is there a
    // frozen copy to sign" test reads the hash, because the hash is what the
    // send form loads and what a signature binds to. The two came apart once
    // already — SOW 001-1 carries a date and no hash, from before hashes were
    // stored — and without this column every scope of work on this page reads
    // as unfrozen and silently loses its Send button.
    .select('id, number, revision, status, project_name, effective_on, '
          + 'adjusted_fee_cents, exported_at, snapshot_hash')
    .eq('client_id', client.id)
    .order('number', { ascending: false })
    .order('revision', { ascending: false });

  if (error) throw error;
  sows = data || [];
}

/** What they have been billed, and what is still outstanding. Beside the scopes
 *  of work rather than buried on the Invoices page, because "what do they owe
 *  us" is a question asked while looking at the client, not while looking at a
 *  ledger. */
async function loadInvoices() {
  invoices = await invoicesForClient(client.id);
}

/** The signing layer's view of the paperwork steps. Its own loader rather than
 *  a second read of the Signatures panel's rows, because those carry a frozen
 *  document each and this needs a status and a date. */
async function loadPaperwork() {
  paperworkRequests = await loadPaperworkRequests(client.id);
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

/** Who a note can pull in by name. Notes are staff-only reading, so the
 *  roster is the studio — the same staff-only rule notify-mention enforces
 *  again before any email leaves. A failure here costs the frill, not the
 *  notes: they still save, mentions just render as plain text. */
async function loadStaff() {
  const { data } = await supabase
    .from('profiles')
    .select('id, full_name, email')
    .eq('role', 'admin')
    .order('full_name', { ascending: true });
  staff = data || [];
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

// Portal access
// ---------------------------------------------------------------------------

/** The portal account behind an email address, if there is one. */
function portalUserFor(email) {
  const needle = String(email || '').trim().toLowerCase();
  if (!needle) return null;
  return portalUsers.find(
    (person) => String(person.email || '').trim().toLowerCase() === needle,
  ) || null;
}

/**
 * Promote someone to a portal user, then bring the page up to date.
 *
 * onCreated runs after the account exists and before the reload; the two
 * callers use it to write the account's email back onto a record that had
 * none, so the new Portal user pill has a match to stand on. Its failure is
 * surfaced but not fatal — the account is real either way.
 */
async function promote(person, onCreated) {
  const created = await promoteToPortalUser({ contact: person, client, ctx });
  if (!created) return;

  if (onCreated) {
    try {
      await onCreated(created);
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  try {
    await Promise.all([loadPortalUsers(), loadContacts(), loadClient()]);
  } catch (error) {
    toast(errorMessage(error), 'error');
    return;
  }
  renderDetails();
  renderContacts();
  renderPeople();
}

/** Every client in the picker. Only fetched when the person modal opens —
 *  this page otherwise has no reason to know about anyone else's clients. */
let allClients = null;

async function clientsForPicker() {
  if (allClients) return allClients;
  const { data, error } = await supabase.from('clients').select('id, name').order('name');
  if (error) throw new Error(errorMessage(error));
  allClients = data || [];
  return allClients;
}

/** Bring the page back in line after an account changed. */
async function refreshAfterAccount() {
  try {
    await Promise.all([loadPortalUsers(), loadContacts(), loadClient()]);
  } catch (error) {
    toast(errorMessage(error), 'error');
    return;
  }
  renderDetails();
  renderContacts();
  renderPeople();
}

/**
 * A password can be read back from nowhere, so it gets a dialog of its own
 * rather than a toast that clears itself after four seconds.
 *
 * A brand-new client account gets the welcome to send alongside it. Both
 * conditions matter: a staff account has no client portal to be welcomed to,
 * and a reset is not a welcome — the person has been signing in for a year and
 * only needs the new password. Everything else still gets the bare panel.
 */
function passwordNotice({ email, password, role, full_name: fullName, created }) {
  const shell = modalShell({ title: created ? 'Account created' : 'Account password' });
  shell.body.append(passwordHandoff(email, password));

  if (created && role !== 'admin') {
    shell.body.append(welcomeHandoff({
      name: fullName,
      clientName: client.name,
      email,
      password,
    }).node);
  }
  shell.foot.append(el('button', {
    class: 'btn',
    type: 'button',
    text: 'Done',
    onclick: () => shell.close(null),
  }));
  shell.open();
}

/**
 * The person modal, from this page — the same one Admin → People opens.
 *
 * `person` is the existing account behind a Portal user pill, or null to
 * create one from a contact row. Creating presets the client to this record,
 * because that is the only reason to be doing it from here.
 */
async function openAccountModal(person, prefill) {
  let clients;
  try {
    clients = await clientsForPicker();
  } catch (error) {
    toast(errorMessage(error), 'error');
    return;
  }

  const result = await openPersonForm({
    person,
    prefill,
    clients,
    selfId: ctx.profile.id,
    presetClientId: client.id,
    // A borrowed login — home somewhere else, linked in here — is not this
    // page's to destroy. Unlink on their row takes them off this client and
    // leaves the account whole, which is what "remove them" means from here.
    allowDelete: !(person && linkedHomes.has(person.id)),
  });
  if (!result) return;

  if (result.deleted) {
    toast('Account deleted.', 'ok');
    await refreshAfterAccount();
    return;
  }

  if (result.handoff) {
    // Nowhere on this page holds a one-time panel, so the password goes where
    // it can be read and copied: the same handoff the promote flow shows.
    passwordNotice(result.handoff);
  }
  // The save stood but a side write did not — say so, or the refresh below
  // quietly shows fewer clients than were ticked.
  if (result.warning) toast(result.warning, 'error');
  // The link ending has already said its piece — and announcing an account
  // that was not created is the confusing part of it, not the helpful part.
  if (!result.linkedExisting) toast(result.editing ? 'Person saved.' : 'Account created.', 'ok');
  await refreshAfterAccount();
}

/**
 * The welcome email for somebody who already has an account — the answer to
 * "can we send that again?", which is most of the time: a client from before
 * the email existed, one who lost the original, one who never saw it.
 *
 * The password is the whole difficulty. We cannot re-send the original — only
 * a hash is kept — so the dialog offers the two honest versions instead of
 * inventing a third: the email without a password, for somebody who can
 * already sign in, or a new password set now and carried in it. Setting one is
 * a real change to their account, so it is its own button with its own
 * confirmation, never a side effect of copying.
 */
async function welcomeEmailFor(person) {
  const shell = modalShell({ title: `Welcome email — ${person.full_name || person.email}` });
  const slot = el('div');

  // Rebuilt rather than mutated when a password arrives: welcomeHandoff owns
  // the whole block, and half-updating it is how the subject and the body
  // drift apart.
  function paint(password) {
    mount(slot, welcomeHandoff({
      name: person.full_name,
      clientName: client.name,
      email: person.email,
      password: password || '',
    }).node);
  }

  const setAndInclude = el('button', {
    class: 'btn btn--ghost',
    type: 'button',
    text: 'Set a new password & include it',
    onclick: async () => {
      const ok = await confirmModal({
        title: `Set ${person.full_name || person.email} a new password?`,
        body: 'Their current one stops working immediately, on every device. The '
            + 'new one goes into the email, and this is the only time it is shown.',
        confirmLabel: 'Set a new password',
        tone: 'danger',
      });
      if (!ok) return;

      setAndInclude.disabled = true;
      setAndInclude.textContent = 'Setting…';
      const password = generatePassword();
      try {
        await callAdminUsers({ action: 'set-password', user_id: person.id, password });
      } catch (error) {
        toast(errorMessage(error), 'error');
        setAndInclude.disabled = false;
        setAndInclude.textContent = 'Set a new password & include it';
        return;
      }

      paint(password);
      setAndInclude.remove();
      shell.body.append(passwordHandoff(person.email, password));
      toast('New password set. It is in the email below.', 'ok');
    },
  });

  paint('');

  shell.body.append(
    el('p', {
      class: 'progress__label',
      text: 'The email below carries no password — it tells them to sign in with '
          + 'the one they have. If they never had one, or it is gone, set a new '
          + 'one and it will be included.',
    }),
    slot,
  );

  shell.foot.append(setAndInclude, el('button', {
    class: 'btn',
    type: 'button',
    text: 'Done',
    onclick: () => shell.close(null),
  }));

  shell.open();
}

/**
 * Give a contact portal access.
 *
 * An address that already has an account takes the link flow, which asks
 * before joining somebody to a second company — creating a duplicate account
 * for a consultant who works for two clients is the failure this avoids.
 * Everything else opens the person modal, prefilled from the contact.
 */
async function givePortalAccess(row, onCreated) {
  let existing = null;
  try {
    existing = row.email ? await findProfileByEmail(row.email) : null;
  } catch (error) {
    toast(errorMessage(error), 'error');
    return;
  }

  if (existing) {
    await promote(row, onCreated);
    return;
  }

  await openAccountModal(null, { name: row.name, email: row.email || '' });
}

async function promotePrimary() {
  await givePortalAccess(primaryContact(), async (created) => {
    if (client.contact_email) return;
    const { error } = await supabase
      .from('clients').update({ contact_email: created.email }).eq('id', client.id);
    if (error) throw new Error(errorMessage(error));
  });
}

async function promoteContactRow(row) {
  await givePortalAccess(row, async (created) => {
    if (row.email) return;
    const { error } = await supabase
      .from('client_contacts').update({ email: created.email }).eq('id', row.id);
    if (error) throw new Error(errorMessage(error));
  });
}

/** Whether the person on the record can sign in yet, and the way in when they
 *  cannot. Only the primary contact's email is consulted — other accounts for
 *  this client show on their own contact rows, and the People panel below
 *  has the full roster. */
function portalAccessCell() {
  const account = portalUserFor(client.contact_email);
  if (account) {
    return el('button', {
      class: 'pill pill--green pill--button',
      type: 'button',
      text: 'Portal user',
      'aria-label': `Edit ${account.full_name || account.email}'s account`,
      onclick: () => openAccountModal(account),
    });
  }

  return el('button', {
    class: 'btn btn--ghost btn--tiny',
    type: 'button',
    text: 'Give portal access',
    'aria-label': `Give ${client.contact_name || client.name} portal access`,
    onclick: promotePrimary,
  });
}

/** Same tones Admin uses for a client's standing, so a status means the same
 *  thing on both screens. */
function clientStatusPill(status) {
  const tone = { active: 'green', lead: 'amber' }[status] || '';
  return el('span', {
    class: tone ? `pill pill--${tone}` : 'pill',
    text: titleCase(status || 'active'),
  });
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
      () => emailAction(who, client, projects),
    )));
  }

  if (client.contact_phone) {
    rows.push(detailRow('Phone', tapAction(
      client.contact_phone,
      `Call or text ${who.name || client.name}`,
      () => phoneAction(who, client, projects),
    )));
  }

  // The contact block closes with whether that person can sign in — promoting
  // them is usually the next thing that happens to a fresh client record.
  if (client.contact_name || client.contact_email) {
    rows.push(detailRow('Portal access', portalAccessCell()));
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

  if (client.industry) rows.push(detailRow('Industry', el('span', { text: client.industry })));
  if (client.source) rows.push(detailRow('Source', el('span', { text: client.source })));

  // Status is never null in the schema, so it is the one row always worth a
  // line — and the one an empty record still tells you something with.
  rows.push(detailRow('Status', clientStatusPill(client.status)));

  // Always a row, present or absent, because "no MSA" is the answer that
  // actually matters: a scope of work issued without one has no effect,
  // and a missing row would read as a field nobody filled in.
  rows.push(detailRow('Master agreement', msaCell()));

  if (client.nonprofit) {
    rows.push(detailRow('Nonprofit', el('span', { text: 'Yes — fee adjustments are noted per SOW' })));
  }

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
    redrawPaperwork();
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

// Master agreement
// ---------------------------------------------------------------------------
//
// The signed copy, kept where the "None on file" warning is. Files live in the
// private client-agreements bucket under <client_id>/<uuid>-<filename>;
// downloads go through short-lived signed URLs minted on click, like the
// Documents tab. The date is what a SOW incorporates; the file is the evidence
// — so removing the file keeps the date, and uploading one asks for it.

function msaCell() {
  // A detached input still opens the picker, but Safari has been known to
  // garbage-collect the pending change event with it — so it rides along in
  // the cell, hidden.
  const input = el('input', { type: 'file', hidden: true, tabindex: '-1', 'aria-hidden': 'true' });
  input.addEventListener('change', () => {
    const file = input.files && input.files[0];
    // Cleared straight away so choosing the same file twice still fires
    // change. The File object already in hand stays readable.
    input.value = '';
    if (!file) return;

    if (file.size > MAX_UPLOAD_BYTES) {
      toast(
        `${file.name} is ${fmtBytes(file.size)} — the limit is ${fmtBytes(MAX_UPLOAD_BYTES)}.`,
        'error',
      );
      return;
    }

    uploadMsa(file);
  });

  const pick = (text) => el('button', {
    class: 'btn btn--ghost btn--tiny',
    type: 'button',
    text,
    onclick: () => input.click(),
  });

  return el('div', { class: 'detail-block' }, [
    client.msa_signed_on
      ? el('span', {
        text: `Signed ${fmtDate(client.msa_signed_on)}`
            + (client.msa_version ? ` · ${client.msa_version}` : ''),
      })
      : el('span', { class: 'notice notice--error', text: 'None on file' }),
    client.msa_storage_path && client.msa_file_name
      ? el('div', { class: 'progress__label', text: client.msa_file_name })
      : null,
    // Two different things, deliberately worded apart. "Generate PDF" makes the
    // agreement from this record — the copy you send a new client to sign, or a
    // reprint of the one the date names. "Download" hands back the signed copy
    // somebody uploaded. Calling them both Download would be a coin toss.
    el('div', { class: 'btn-row' }, [
      generateMsaButton(),
      ...(client.msa_storage_path
        ? [downloadMsaButton(), pick('Replace file'), removeMsaButton()]
        : [pick('Upload signed copy')]),
    ]),
    input,
  ]);
}

/** The date is asked for at upload time because the two facts arrive together:
 *  the copy in your hand is what tells you when it was signed. Prefilled when
 *  the record already knows. */
async function uploadMsa(file) {
  const previous = client.msa_storage_path;

  const result = await formModal({
    title: previous ? 'Replace master agreement' : 'Upload master agreement',
    submitLabel: 'Upload',
    intro: `Attaching ${file.name} (${fmtBytes(file.size)}). The date is the one every `
         + 'scope of work incorporates — the day the agreement was signed.',
    fields: [
      {
        name: 'msa_signed_on',
        label: 'Signed on',
        type: 'date',
        required: true,
        value: client.msa_signed_on || '',
      },
      {
        name: 'msa_version',
        label: 'Version',
        type: 'text',
        value: client.msa_version || '',
        placeholder: 'v1',
      },
    ],
    onSubmit: async (values) => {
      const path = `${client.id}/${crypto.randomUUID()}-${safeName(file.name)}`;

      const upload = await supabase.storage
        .from(AGREEMENTS_BUCKET)
        .upload(path, file, { contentType: file.type || 'application/octet-stream' });
      if (upload.error) throw new Error(errorMessage(upload.error));

      const { error } = await supabase.from('clients').update({
        msa_storage_path: path,
        msa_file_name: file.name,
        msa_signed_on: values.msa_signed_on,
        msa_version: values.msa_version || null,
      }).eq('id', client.id);

      // An object no row points at is invisible in the UI but still bills for
      // storage forever, so clean up before surfacing the failure.
      if (error) {
        try {
          await supabase.storage.from(AGREEMENTS_BUCKET).remove([path]);
        } catch (cleanupError) {
          // The update error is the story.
        }
        throw new Error(errorMessage(error));
      }

      // The file this one replaces, deleted only now that nothing references
      // it. Best-effort: a stranded object costs cents, failing a completed
      // upload over it costs the afternoon.
      if (previous) {
        try {
          await supabase.storage.from(AGREEMENTS_BUCKET).remove([previous]);
        } catch (cleanupError) {
          // Same story.
        }
      }
    },
  });

  if (result) {
    toast(previous ? 'Master agreement replaced.' : 'Master agreement uploaded.', 'ok');
    await reload(loadClient, () => {
      renderDetails();
      redrawPaperwork();
    });
  }
}

/** The agreement built from this record and sow_settings rather than fetched
 *  from storage, so a new client can be sent one before anything is signed. It
 *  goes through the same print pipeline the SOW uses — the dialog's Save as PDF
 *  is the download. Settings are fetched at the click rather than at page load,
 *  because this is the only row on the page that wants them.
 *
 *  The document reads the record's state: with no date on file it is effective
 *  on the last signature; with one, it is a reprint of the agreement that date
 *  names. */
function generateMsaButton() {
  return el('button', {
    class: 'btn btn--ghost btn--tiny',
    type: 'button',
    text: 'Generate PDF',
    'aria-label': 'Generate the master agreement as a PDF, filled from this record',
    onclick: (event) => generateMsa(event.currentTarget),
  });
}

async function generateMsa(button) {
  button.disabled = true;
  button.textContent = 'Building…';
  try {
    const settings = await loadSettings();
    const today = todayIso();
    const snapshot = assembleMsa({ client, settings, today });
    await printMsa(snapshot,
      msaFilename(client.legal_name || client.name, today, client.msa_version));
  } catch (error) {
    toast(errorMessage(error), 'error');
  } finally {
    button.disabled = false;
    button.textContent = 'Generate PDF';
  }
}

function downloadMsaButton() {
  const name = client.msa_file_name || 'master-agreement';

  const button = el('button', {
    class: 'btn btn--ghost btn--tiny',
    type: 'button',
    text: 'Download',
    'aria-label': `Download ${name}`,
  });

  button.addEventListener('click', async () => {
    button.disabled = true;
    button.textContent = 'Opening…';
    try {
      // `download` makes storage answer with Content-Disposition: attachment,
      // which keeps the original filename and stops the file rendering on our
      // storage origin.
      const { data, error } = await supabase.storage
        .from(AGREEMENTS_BUCKET)
        .createSignedUrl(client.msa_storage_path, 60, { download: name });
      if (error) throw error;

      const link = el('a', { href: data.signedUrl, download: name, rel: 'noopener' });
      document.body.append(link);
      link.click();
      link.remove();
    } catch (error) {
      toast(
        isMissingObject(error)
          ? `${name} is no longer in storage. Upload it again.`
          : errorMessage(error),
        'error',
      );
    } finally {
      button.disabled = false;
      button.textContent = 'Download';
    }
  });

  return button;
}

function removeMsaButton() {
  return el('button', {
    class: 'btn btn--ghost btn--tiny',
    type: 'button',
    text: 'Remove file',
    'aria-label': `Remove ${client.msa_file_name || 'the master agreement file'}`,
    onclick: removeMsa,
  });
}

async function removeMsa() {
  const confirmed = await confirmModal({
    title: `Remove ${client.msa_file_name || 'the master agreement file'}?`,
    body: 'Only the file goes. The signed date and version stay on the record — '
        + 'detaching the copy does not un-sign the agreement.',
    confirmLabel: 'Remove file',
    tone: 'danger',
  });
  if (!confirmed) return;

  try {
    // Object first — the row holds the only copy of the path. A file already
    // gone must not strand a record that claims to have one.
    const removal = await supabase.storage
      .from(AGREEMENTS_BUCKET).remove([client.msa_storage_path]);
    if (removal.error && !isMissingObject(removal.error)) throw removal.error;

    const { error } = await supabase
      .from('clients')
      .update({ msa_storage_path: null, msa_file_name: null })
      .eq('id', client.id);
    if (error) throw error;
  } catch (error) {
    toast(errorMessage(error), 'error');
    return;
  }

  toast('Master agreement file removed.', 'ok');
  await reload(loadClient, renderDetails);
}

// Projects
// ---------------------------------------------------------------------------

function projectRow(project) {
  const waypoints = project.waypoints || [];
  const done = waypoints.filter((waypoint) => waypoint.status === 'complete').length;

  return el('div', { class: 'record-row' }, [
    el('a', {
      class: 'record-row__name',
      href: `/portal/project/?id=${encodeURIComponent(project.id)}`,
      text: project.name,
    }),
    project.summary ? el('p', { class: 'record-row__desc', text: project.summary }) : null,
    el('div', { class: 'tag-row' }, [
      statusPill(project.status),
      project.starts_on
        ? el('span', { class: 'tag', text: `Started ${fmtDate(project.starts_on)}` })
        : null,
      project.target_on
        ? el('span', { class: 'tag tag--due', text: `Target ${fmtDate(project.target_on)}` })
        : null,
    ]),
    progressBar(done, waypoints.length),
  ]);
}

function renderProjects() {
  mount(projectList, ...(projects.length
    ? projects.map(projectRow)
    : [el('p', {
      class: 'empty',
      text: 'No projects for this client yet. Start one from Projects — '
          + 'it is what gives them something to sign in to.',
    })]));
}

// Scopes of work
// ---------------------------------------------------------------------------

function sowRow(row) {
  return el('div', { class: 'record-row' }, [
    el('a', {
      class: 'record-row__name',
      href: `/portal/admin/sow/?id=${encodeURIComponent(row.id)}`,
      text: `SOW ${sowLabel(row.number, row.revision)}`,
    }),
    row.project_name ? el('p', { class: 'record-row__desc', text: row.project_name }) : null,
    el('div', { class: 'tag-row' }, [
      el('span', { class: 'tag', text: titleCase(row.status) }),
      el('span', { class: 'tag', text: formatMoney(row.adjusted_fee_cents) }),
      row.effective_on ? el('span', { class: 'tag', text: fmtDate(row.effective_on) }) : null,
    ]),
  ]);
}

function renderSows() {
  mount(sowList, ...(sows.length
    ? sows.map(sowRow)
    : [el('p', {
      class: 'empty',
      text: 'No scopes of work for this client yet.',
    })]));
}

// Invoices
// ---------------------------------------------------------------------------

function todayIso() {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
}

function invoiceRow(row) {
  const late = overdueDays(row, todayIso());
  const due = (Number(row.total_cents) || 0) - (Number(row.paid_cents) || 0);

  return el('div', { class: 'record-row' }, [
    el('a', {
      class: 'record-row__name',
      href: `/portal/admin/invoice/?id=${encodeURIComponent(row.id)}`,
      text: `INV ${invoiceLabel(row.number)}`,
    }),
    el('p', {
      class: 'record-row__desc',
      text: [stageLabel(row.stage), row.sow_label, row.project_name]
        .filter(Boolean).join(' · '),
    }),
    el('div', { class: 'tag-row' }, [
      // The overdue tag replaces the status one rather than sitting beside it:
      // "Sent" and "31 days overdue" say the same thing twice, and only one of
      // them is the thing to act on.
      late
        ? el('span', {
          class: 'tag tag--overdue',
          text: `${late} day${late === 1 ? '' : 's'} overdue`,
        })
        : el('span', { class: 'tag', text: titleCase(row.status) }),
      el('span', { class: 'tag', text: formatMoney(row.total_cents) }),
      row.status !== 'paid' && row.status !== 'void' && due > 0 && due !== row.total_cents
        ? el('span', { class: 'tag', text: `${formatMoney(due)} outstanding` })
        : null,
      row.issued_on ? el('span', { class: 'tag', text: fmtDate(row.issued_on) }) : null,
    ]),
  ]);
}

function renderInvoices() {
  if (!invoices.length) {
    mount(invoiceList, el('p', {
      class: 'empty',
      text: 'Nothing invoiced to this client yet.',
    }));
    return;
  }

  const live = invoices.filter((row) => !['draft', 'void', 'paid'].includes(row.status));
  const outstanding = live.reduce((sum, row) => (
    sum + ((Number(row.total_cents) || 0) - (Number(row.paid_cents) || 0))
  ), 0);

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
  const account = portalUserFor(row.email);

  const taps = [
    row.phone
      ? tapAction(row.phone, `Call or text ${row.name}`, () => phoneAction(row, client, projects))
      : null,
    row.email
      ? tapAction(row.email, `Email ${row.name}`, () => emailAction(row, client, projects))
      : null,
  ].filter(Boolean);

  return el('div', { class: 'record-row' }, [
    contactOrder.handle(index, row.name),
    el('p', { class: 'record-row__name' }, [
      row.name,
      account ? ' ' : null,
      account ? el('button', {
        class: 'pill pill--green pill--button',
        type: 'button',
        text: 'Portal user',
        'aria-label': `Edit ${row.name}'s account`,
        onclick: () => openAccountModal(account),
      }) : null,
    ]),
    row.title ? el('p', { class: 'record-row__desc', text: row.title }) : null,
    taps.length ? el('div', { class: 'btn-row' }, taps) : null,
    // The page is behind requireAdmin, so there is no non-staff branch to guard:
    // anyone who can see this row can edit it.
    el('div', { class: 'btn-row' }, [
      // First in the row: the one action here with business meaning. The rest
      // is housekeeping.
      account ? null : el('button', {
        class: 'btn btn--ghost btn--tiny',
        type: 'button',
        text: 'Give portal access',
        'aria-label': `Give ${row.name} portal access`,
        onclick: () => promoteContactRow(row),
      }),
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
      text: 'No other contacts yet. Add the office manager, whoever owns the '
          + 'copy, whoever signs off on invoices — in the order you would try them.',
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

// People — this client's portal users
// ---------------------------------------------------------------------------
//
// The other half of the Admin → People split: staff live there, a client's
// sign-ins live here. Same modal, same admin-users plumbing — this panel is
// where the accounts are *seen*, next to the company they belong to.

function personRow(person) {
  const who = person.full_name || person.email || 'Unnamed';
  const homeName = linkedHomes.get(person.id);
  const isLinked = linkedHomes.has(person.id);

  return el('div', { class: 'record-row' }, [
    el('p', { class: 'record-row__name' }, [
      el('button', {
        class: 'link-button',
        type: 'button',
        text: who,
        'aria-label': `Edit ${who}'s account`,
        onclick: () => openAccountModal(person),
      }),
      // Staff rarely appear here (their home is no client), but when one
      // does, saying so beats a row that looks like a client user and is not.
      person.role === 'admin' ? ' ' : null,
      person.role === 'admin' ? el('span', { class: 'pill', text: 'Staff' }) : null,
    ]),
    person.email ? el('p', { class: 'record-row__desc', text: person.email }) : null,
    el('div', { class: 'tag-row' }, [
      person.created_at
        ? el('span', { class: 'tag', text: `Joined ${fmtDate(person.created_at)}` })
        : null,
      isLinked
        ? el('span', {
          class: 'tag',
          text: homeName ? `Linked — home: ${homeName}` : 'Linked from another client',
        })
        : null,
    ]),
    el('div', { class: 'btn-row' }, [
      // Staff have no client portal to be welcomed to, so the button that
      // builds one does not appear on their row.
      person.role === 'admin' ? null : el('button', {
        class: 'btn btn--ghost btn--tiny',
        type: 'button',
        text: 'Welcome email',
        'aria-label': `Build ${who}'s welcome email`,
        onclick: () => welcomeEmailFor(person),
      }),
      isLinked ? el('button', {
        class: 'btn btn--ghost btn--tiny',
        type: 'button',
        text: 'Unlink',
        'aria-label': `Unlink ${who} from ${client.name}`,
        onclick: () => unlinkPerson(person),
      }) : null,
    ]),
  ]);
}

function renderPeople() {
  mount(peopleList, ...(portalUsers.length
    ? portalUsers.map(personRow)
    : [el('p', {
      class: 'empty',
      text: 'Nobody here can sign in yet. Give portal access on a contact '
          + 'below, or use Add a person — either way the account arrives '
          + 'already linked to this client.',
    })]));
}

/** Undo a profile_clients link from the page that shows it. Only this extra
 *  company goes — the login and its home client are untouched, which is the
 *  difference between unlinking someone and deleting them. */
async function unlinkPerson(person) {
  const who = person.full_name || person.email || 'this account';

  const ok = await confirmModal({
    title: `Unlink ${who} from ${client.name}?`,
    body: 'Only this extra company goes. The login stays, along with its home '
        + 'client — relink any time with Give portal access.',
    confirmLabel: 'Unlink',
    // Not danger: the login survives and Give portal access puts it back.
  });
  if (!ok) return;

  const { error } = await supabase
    .from('profile_clients')
    .delete()
    .eq('profile_id', person.id)
    .eq('client_id', client.id);

  if (error) {
    toast(errorMessage(error), 'error');
    return;
  }

  toast(`${who} unlinked from ${client.name}.`, 'ok');
  await refreshAfterAccount();
}

// Notes
// ---------------------------------------------------------------------------

/** profiles is readable to staff, so the embed normally resolves. It comes back
 *  null for a note whose author has since been deleted — say so rather than
 *  leaving the byline blank. */
function authorName(note) {
  const author = note.author;
  if (author && author.full_name) return author.full_name;
  if (author && author.email) return author.email.split('@')[0];
  if (note.author_id && ctx && note.author_id === ctx.profile.id) return 'You';
  return note.author_id ? 'New Journey Designs' : 'Someone';
}

function wasEdited(note) {
  if (!note.created_at || !note.updated_at) return false;
  return new Date(note.updated_at) - new Date(note.created_at) > EDIT_GRACE_MS;
}

function personLabel(person) {
  if (!person) return 'Someone';
  if (person.full_name) return person.full_name;
  return person.email ? person.email.split('@')[0] : 'Someone';
}

/** The body walked as pieces rather than set as HTML, the same as messages
 *  and card comments: a note containing something that looks like markup
 *  stays text, and a resolved @handle becomes a chip. */
function noteBody(note) {
  const body = el('p', { class: 'note__body' });
  for (const part of splitMentions(note.body, staff)) {
    if (part.type === 'mention') {
      body.append(el('span', {
        class: 'mention',
        text: part.value,
        title: personLabel(part.person),
      }));
    } else {
      body.append(document.createTextNode(part.value));
    }
  }
  return body;
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
    noteBody(note),
    el('div', { class: 'btn-row' }, [
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
    ]),
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

/** Resolve who a note names and write the rows the inbox trigger and the
 *  email webhook fire from. Resolved once, at save, and stored — who was
 *  told must not change when the roster does. On an edit only newly named
 *  people land (the primary key plus ignoreDuplicates), and nobody already
 *  told is ever untold. The note is saved either way; a failed mention row
 *  is worth saying out loud but not worth losing the note over. */
async function saveNoteMentions(noteId, body) {
  const ids = mentionedIds(body, staff);
  if (!ids.length) return;
  const { error } = await supabase
    .from('client_note_mentions')
    .upsert(
      ids.map((profileId) => ({ note_id: noteId, profile_id: profileId })),
      { onConflict: 'note_id,profile_id', ignoreDuplicates: true },
    );
  if (error) toast('Note saved, but the mention did not send.', 'error');
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
      // A typed @handle works in an edit too — pulling somebody in late is
      // still pulling them in.
      await saveNoteMentions(note.id, values.body);
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
 *  note with it. */
function buildComposer() {
  const textarea = el('textarea', {
    id: 'note-body',
    rows: 3,
    placeholder: 'What was said, agreed, or promised… Use @ to pull somebody in.',
  });
  attachAiRewrite(textarea, { isAdmin: ctx.isAdmin, surface: 'client-note' });

  const button = el('button', { class: 'btn btn--small', type: 'submit', text: 'Save note' });

  // The @-picker, the same small one the card dialog carries: a list under
  // the box, arrow keys and Enter, Escape to dismiss.
  const suggestionHost = el('div', { class: 'mention-picker', hidden: true });
  let suggestions = [];
  let highlighted = 0;

  /** The roster without the author — a list for suggesting, not for
   *  resolving. Nobody needs help mentioning themselves. */
  function suggestable() {
    return staff.filter((person) => person.id !== ctx.profile.id);
  }

  /** The @word the caret is sitting in, or null. */
  function activeToken() {
    const upto = textarea.value.slice(0, textarea.selectionStart);
    const match = /(^|\s)@([a-z0-9._-]*)$/i.exec(upto);
    return match ? { query: match[2], start: textarea.selectionStart - match[2].length - 1 } : null;
  }

  function closePicker() {
    suggestionHost.hidden = true;
    suggestions = [];
  }

  function refreshSuggestions() {
    const token = activeToken();
    if (!token) {
      closePicker();
      return;
    }

    suggestions = mentionSuggestions(token.query, suggestable());
    highlighted = 0;

    if (!suggestions.length) {
      closePicker();
      return;
    }

    renderSuggestions();
    suggestionHost.hidden = false;
  }

  function renderSuggestions() {
    mount(suggestionHost, ...suggestions.map((person, index) => el('button', {
      class: index === highlighted ? 'mention-picker__item is-on' : 'mention-picker__item',
      type: 'button',
      text: `${personLabel(person)}  @${mentionHandle(person)}`,
      onclick: () => insertMention(person),
    })));
  }

  function insertMention(person) {
    const token = activeToken();
    if (!token) return;

    const before = textarea.value.slice(0, token.start);
    const after = textarea.value.slice(textarea.selectionStart);
    const inserted = `@${mentionHandle(person)} `;

    textarea.value = `${before}${inserted}${after}`;
    const caret = before.length + inserted.length;
    textarea.setSelectionRange(caret, caret);

    closePicker();
    textarea.focus();
  }

  function onComposerKey(event) {
    if (!suggestions.length || suggestionHost.hidden) return;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      highlighted = (highlighted + 1) % suggestions.length;
      renderSuggestions();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      highlighted = (highlighted - 1 + suggestions.length) % suggestions.length;
      renderSuggestions();
    } else if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      insertMention(suggestions[highlighted]);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closePicker();
    }
  }

  textarea.addEventListener('input', refreshSuggestions);
  textarea.addEventListener('keydown', onComposerKey);

  const form = el('form', { class: 'composer' }, [
    el('div', { class: 'form-field' }, [
      el('label', { for: 'note-body', text: 'Add a note' }),
      textarea,
    ]),
    suggestionHost,
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
      const { data, error } = await supabase.from('client_notes').insert({
        client_id: client.id,
        author_id: ctx.profile.id,
        body,
      }).select('id').maybeSingle();
      if (error) throw error;

      // Who the note names, resolved once and stored — the rows the inbox
      // trigger and the mention email fire from.
      if (data) await saveNoteMentions(data.id, body);

      // Unmistakable work on a client — but the timer bills a *project*, so
      // this only speaks when there is exactly one live project to mean. With
      // two, the prompt would have to ask which, and a prompt that asks a
      // second question at the moment of interruption is one people close.
      const live = projects.filter((row) => row.status !== 'launched');
      if (live.length === 1) {
        markProjectVisit(live[0].id);
        signalWork({ projectId: live[0].id, projectName: live[0].name });
      }

      textarea.value = '';
      closePicker();
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

/** The one line under the h1: where they stand and how much work is on. */
function lede() {
  const count = projects.length;
  const work = count === 1 ? '1 project' : `${count} projects`;
  return `${titleCase(client.status || 'active')} client · ${work}`;
}

/**
 * The client's whiteboards.
 *
 * Lazy, like the project page's: the editor is 1.24 MB and most visits to a
 * client record are not here to draw. A failure costs this panel and nothing
 * else — ten other panels are already on the page.
 */
function renderWhiteboardSection() {
  import('./whiteboard.js')
    .then((m) => m.renderWhiteboards(panels.whiteboard, ctx, { clientId: client.id }))
    .catch((error) => {
      console.error(error);
      mount(panels.whiteboard, el('div', { class: 'panel' }, [
        panelHead('Whiteboard'),
        el('p', { class: 'empty', text: 'The whiteboards could not be loaded.' }),
      ]));
    });
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

    // The quick-add button is in the corner of this page too. Told whose
    // record is open, its note form arrives with the client already chosen.
    setQuickAddContext({ clientId: client.id });

    await Promise.all([
      loadProjects(), loadContacts(), loadNotes(), loadSows(), loadInvoices(),
      loadPortalUsers(), loadStaff(), loadPaperwork(),
    ]);
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
    ])),
    detailList,
  );
  // The Drive button rides the panel head so the folder is one click from the
  // documents it feeds. This page is staff-only; the client's own way in is
  // the same button on their project's Documents tab.
  mount(panels.documents, panelHead('Documents', driveLinkBar({
    url: client.drive_url,
    canEdit: true,
    subject: client.name,
    intro: `The shared folder for ${client.name}. The button shows on this `
         + 'staff-only page — to hand the client a button too, add the link '
         + 'on their project, and share the folder with them in Drive first.',
    save: async (url) => {
      const { error } = await supabase
        .from('clients').update({ drive_url: url }).eq('id', client.id);
      if (error) throw new Error(errorMessage(error));
      client.drive_url = url;
    },
  })), documentsHost);
  mount(panels.projects, panelHead('Projects'), projectList);
  mount(panels.sows,
    panelHead('Scopes of work', el('a', {
      class: 'btn btn--small',
      href: '/portal/admin/sows/',
      text: 'All SOWs',
    })),
    sowList,
  );
  mount(panels.invoices,
    panelHead('Invoices', el('a', {
      class: 'btn btn--small',
      href: '/portal/admin/invoices/',
      text: 'All invoices',
    })),
    invoiceList,
  );
  mount(panels.contacts,
    panelHead('Contacts', el('button', {
      class: 'btn btn--small',
      type: 'button',
      text: 'Add contact',
      onclick: addContact,
    })),
    contactList,
  );
  mount(panels.people,
    panelHead('People', el('button', {
      class: 'btn btn--small',
      type: 'button',
      text: 'Add a person',
      onclick: () => openAccountModal(null),
    })),
    el('p', {
      class: 'progress__label',
      text: `Everyone who can sign in to ${client.name}'s portal. Click a `
          + 'person to edit their account — name, email, or a new password. '
          + 'Add a person makes a new sign-in, or adds an address that already '
          + 'has one. Staff accounts live under Admin.',
    }),
    peopleList,
  );
  mount(panels.notes, panelHead('Notes'), buildComposer(), noteFeed);

  mount(byId('portal-root'),
    el('p', { class: 'breadcrumb' }, [
      el('a', { href: '/portal/clients/', text: '← Clients' }),
    ]),
    pageHead,
    // Ten panels is past what scrolling serves. The bar pins under the
    // header and stays put; the section you are reading stays lit.
    sectionNav([
      { id: 'details', label: 'Details', target: panels.details },
      { id: 'paperwork', label: 'Paperwork', target: panels.paperwork },
      { id: 'signatures', label: 'Signatures', target: panels.signatures },
      { id: 'documents', label: 'Documents', target: panels.documents },
      { id: 'projects', label: 'Projects', target: panels.projects },
      { id: 'sows', label: 'SOWs', target: panels.sows },
      { id: 'invoices', label: 'Invoices', target: panels.invoices },
      { id: 'contacts', label: 'Contacts', target: panels.contacts },
      { id: 'people', label: 'People', target: panels.people },
      { id: 'notes', label: 'Notes', target: panels.notes },
      { id: 'whiteboard', label: 'Whiteboard', target: panels.whiteboard },
    ]),
    panels.details,
    panels.paperwork,
    panels.signatures,
    panels.documents,
    panels.projects,
    panels.sows,
    panels.invoices,
    panels.contacts,
    panels.people,
    panels.notes,
    panels.whiteboard,
  );

  renderHead();
  renderDetails();
  renderProjects();
  renderSows();
  renderInvoices();
  renderContacts();
  renderPeople();
  renderNotes();
  renderWhiteboardSection();

  // A note written from the quick-add button in the corner belongs in the feed
  // below, not behind a reload. Only this client's — the button can file a note
  // on anyone from here.
  document.addEventListener(NOTE_ADDED_EVENT, (event) => {
    if (event.detail && event.detail.clientId === client.id) {
      reload(loadNotes, renderNotes);
    }
  });

  // Both load and manage themselves, like the project page's Documents tab. A
  // failure in either costs that panel, not the record around it.
  //
  // Paperwork is handed the scopes of work and invoices this page has already
  // read rather than fetching its own: half the trail is those rows, and asking
  // for them twice would be two chances to disagree about what is signed.
  renderClientPaperwork(panels.paperwork, ctx,
    () => ({ client, sows, invoices, projects, requests: paperworkRequests }))
    .then((paperwork) => { redrawPaperwork = paperwork.redraw; })
    .catch((error) => {
      mount(panels.paperwork,
        panelHead('Paperwork'),
        el('p', { class: 'empty', text: 'Could not load the paperwork. Please reload the page.' }));
      toast(errorMessage(error), 'error');
    });

  // The signing control rail, and the read-through of the client's own panel
  // inside it. Same contract as Paperwork above: it loads and manages itself,
  // it is handed the scopes of work this page has already read rather than
  // fetching its own, and a failure in it costs the panel rather than the
  // record around it.
  renderSignaturePanel(panels.signatures, ctx, () => ({ client, sows }))
    .catch((error) => {
      mount(panels.signatures,
        panelHead('Signatures'),
        el('p', { class: 'empty', text: 'Could not load the signing panel. Please reload the page.' }));
      toast(errorMessage(error), 'error');
    });

  renderClientDocuments(documentsHost, ctx, client, projects)
    .catch((error) => toast(errorMessage(error), 'error'));
}

main();
