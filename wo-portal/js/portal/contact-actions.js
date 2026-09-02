// ---------------------------------------------------------------------------
// Tapping a person: call, text, or email them.
//
// A phone number rendered as text is a number you have to retype into your
// phone, and that is enough friction that the call does not get made. So every
// number and address the studio holds is an action, not a label.
//
// The pieces live here rather than on the client page because a number is a
// number wherever it appears — the same sheet should open from a contact row,
// a project page, or whatever shows a person next.
// ---------------------------------------------------------------------------

import { el, modalShell, fmtDate } from './ui.js';

// A project in one of these states is finished or parked, so it loses to any
// project that is still moving when we guess what an email is about.
const DORMANT_STATUSES = new Set(['launched', 'on_hold']);

/** The name to put on the sheet. Falls back through the address so the dialog
 *  is never titled with an empty string. */
function displayName(contact) {
  const name = String((contact && contact.name) || '').trim();
  if (name) return name;
  const email = String((contact && contact.email) || '').trim();
  return email || 'Contact';
}

/**
 * The first name of the person actually being written to.
 *
 * Their full name's first whitespace-separated token, or the local part of
 * their address if we only have that. Empty when we have neither, and the
 * caller opens with a bare "Hi" rather than "Hi undefined".
 */
function firstName(contact) {
  const name = String((contact && contact.name) || '').trim();
  if (name) return name.split(/\s+/)[0];

  const email = String((contact && contact.email) || '').trim();
  return email ? email.split('@')[0] : '';
}

/**
 * The dialable form of a number people typed for humans: "(555) 010-4477"
 * becomes "5550104477". A leading + survives, because it is the difference
 * between reaching Paris and reaching nobody.
 *
 * Only the URI is normalised — everything on screen stays as it was typed.
 * Exported for the team panel, which builds its own tel:/sms: links from the
 * same rule rather than growing a second opinion about what dials.
 */
export function telNumber(value) {
  const raw = String(value || '').trim();
  const plus = raw.startsWith('+') ? '+' : '';
  return plus + raw.slice(plus.length).replace(/[\s()\-.]/g, '');
}

/** Today, as the plain YYYY-MM-DD that fmtDate expects. Built from local parts
 *  rather than toISOString(), which would show yesterday's date all evening for
 *  anyone west of Greenwich. */
function todayIso() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

/**
 * "Most recently active", with no activity column to read.
 *
 * A project that is neither launched nor on hold outranks one that is; within
 * that, the one that started most recently wins, and a project with no start
 * date is settled by when its record was created. Descending string compares
 * work on both columns: ISO dates sort lexically, and a missing value is '',
 * which sorts last.
 */
function byRecentlyActive(projects) {
  return projects.slice().sort((a, b) => {
    const live = Number(!DORMANT_STATUSES.has(b.status))
      - Number(!DORMANT_STATUSES.has(a.status));
    if (live) return live;

    const starts = String(b.starts_on || '').localeCompare(String(a.starts_on || ''));
    if (starts) return starts;

    return String(b.created_at || '').localeCompare(String(a.created_at || ''));
  });
}

/**
 * The mailto the studio would have typed by hand.
 *
 * Every interpolated part is percent-encoded, including the address: these are
 * free-text columns, and an address containing `&` would otherwise smuggle a
 * second query parameter into the URL.
 */
function mailtoUrl(address, contact, project) {
  const date = fmtDate(todayIso());
  const subject = project && project.name
    ? `Project Update: ${project.name} - ${date}`
    : `Project Update - ${date}`;

  const first = firstName(contact);
  const body = first ? `Hi ${first}` : 'Hi';

  // The address is a free-text column, so it still gets encoded — an unescaped
  // "&" in it would otherwise start a new query parameter. But "@" is put back:
  // it is legal unencoded per RFC 6068, it is the form every mail client is
  // actually tested against, and a few older ones choke on "%40".
  const to = encodeURIComponent(address).replace(/%40/g, '@');

  return `mailto:${to}`
    + `?subject=${encodeURIComponent(subject)}`
    + `&body=${encodeURIComponent(body)}`;
}

function openMail(address, contact, project) {
  window.location.href = mailtoUrl(address, contact, project);
}

/**
 * Which project is this about? Only asked when there is genuinely a choice.
 *
 * The most recently active one is preselected and sits at the top, so the
 * common case is Enter without reading the list.
 */
function openProjectPicker(address, contact, client, projects) {
  const ordered = byRecentlyActive(projects);
  const select = el('select', { id: 'ca-project', name: 'project' });

  ordered.forEach((project, index) => select.append(el('option', {
    value: project.id,
    text: project.name,
    selected: index === 0,
  })));

  const shell = modalShell({ title: `Email ${displayName(contact)}` });

  shell.body.append(el('div', { class: 'form-field' }, [
    el('label', { for: 'ca-project', text: 'Which project is this about?' }),
    select,
    el('span', {
      class: 'progress__label',
      text: `${(client && client.name) || 'This client'} has ${ordered.length} projects. `
          + 'The one you pick names the subject line.',
    }),
  ]));

  const send = el('button', {
    class: 'btn',
    type: 'button',
    text: 'Send',
    onclick: () => {
      const picked = ordered.find((project) => String(project.id) === select.value)
        || ordered[0];
      shell.close(null);
      openMail(address, contact, picked);
    },
  });

  shell.foot.append(send, el('button', {
    class: 'btn btn--ghost',
    type: 'button',
    text: 'Cancel',
    onclick: () => shell.close(null),
  }));

  shell.open();
  // Desktop only: focusing a <select> on iOS opens the native picker wheel
  // over the sheet before the person has read what they are choosing.
  if (!window.matchMedia('(pointer: coarse)').matches) {
    window.setTimeout(() => select.focus(), 50);
  }
}

/** A value you act on rather than read: sized for a thumb, and labelled with
 *  what the tap will do rather than just repeating the number. The button any
 *  screen shows before opening one of the actions below. */
export function tapAction(text, label, onclick) {
  return el('button', {
    class: 'btn btn--ghost tap-action',
    type: 'button',
    text,
    'aria-label': label,
    onclick,
  });
}

/**
 * Open a pre-addressed email to this contact.
 *
 * contact  { name, email }  — the person tapped, whose first name opens the body
 * client   the client record, for the picker's wording
 * projects every project for that client
 */
export function emailAction(contact, client, projects) {
  const address = String((contact && contact.email) || '').trim();
  // No address, no email affordance — this is a guard against a caller wiring
  // one up by mistake, not a state the UI is meant to reach.
  if (!address) return;

  const list = (Array.isArray(projects) ? projects : []).filter(Boolean);

  // One project is not a decision, and none means there is nothing to name.
  if (list.length < 2) {
    openMail(address, contact, list[0] || null);
    return;
  }

  openProjectPicker(address, contact, client, list);
}

/**
 * Everyone reachable about one client, in a single sheet.
 *
 * The client page has room for a column of contact rows. The top of a project
 * page does not, and the question asked there is narrower — "get me whoever I
 * need on this, now" — so one button opens one sheet. Each person offers only
 * the actions their details support: no number means no Call button, rather
 * than a button that dials nothing.
 *
 * client    the client record, for the title and the email flow
 * contacts  the people to list — { name, title, email, phone }
 * project   the project being viewed, passed through as the only project in
 *           scope. That is what stops the email flow opening its "which project
 *           is this about?" picker on a page that is already showing one.
 * onEdit    optional. Adds the button that makes the details editable from
 *           here, so a wrong number is fixed at the moment it is discovered
 *           rather than written down to fix later.
 */
export function contactSheet({ client, contacts, project, onEdit }) {
  const shell = modalShell({ title: (client && client.name) || 'Contact' });
  const scope = project ? [project] : [];

  const items = [];

  (Array.isArray(contacts) ? contacts : []).forEach((person) => {
    if (!person) return;

    const phone = String(person.phone || '').trim();
    const email = String(person.email || '').trim();
    // Somebody with neither is a name we cannot act on, and a heading with no
    // buttons under it reads as a bug.
    if (!phone && !email) return;

    const dial = telNumber(phone);
    const who = displayName(person);

    items.push(el('p', {
      class: 'progress__label',
      text: person.title ? `${who} — ${person.title}` : who,
    }));

    if (phone) {
      items.push(el('a', {
        class: 'btn action-sheet__choice',
        href: `tel:${dial}`,
        text: `Call ${phone}`,
        onclick: () => shell.close(null),
      }));
      items.push(el('a', {
        class: 'btn action-sheet__choice',
        href: `sms:${dial}`,
        text: `Text ${phone}`,
        onclick: () => shell.close(null),
      }));
    }

    if (email) {
      items.push(el('button', {
        class: 'btn action-sheet__choice',
        type: 'button',
        text: `Email ${email}`,
        onclick: () => {
          shell.close(null);
          emailAction(person, client, scope);
        },
      }));
    }
  });

  // No details on file is a normal state for a client added from a lead, and
  // the Edit button below is the way out of it — so say so plainly.
  if (!items.length) {
    items.push(el('p', {
      class: 'empty',
      text: onEdit
        ? 'No phone or email on file yet. Add them below and they will be here next time.'
        : 'No phone or email on file yet.',
    }));
  }

  shell.body.append(el('div', { class: 'action-sheet' }, items));

  const buttons = [];
  if (onEdit) {
    buttons.push(el('button', {
      class: 'btn',
      type: 'button',
      text: 'Edit contact details',
      onclick: () => {
        shell.close(null);
        onEdit();
      },
    }));
  }
  buttons.push(el('button', {
    class: 'btn btn--ghost',
    type: 'button',
    text: 'Close',
    onclick: () => shell.close(null),
  }));
  shell.foot.append(...buttons);

  shell.open();

  // Escape and the backdrop come from modalShell; the opening focus does not.
  window.setTimeout(() => {
    const first = shell.body.querySelector('.action-sheet__choice');
    (first || buttons[0]).focus();
  }, 50);
}

/**
 * Open the call / text / email sheet for a contact with a phone number.
 *
 * A contact with no number never gets a phone affordance in the first place,
 * so this returns quietly rather than opening an empty sheet.
 */
export function phoneAction(contact, client, projects) {
  const phone = String((contact && contact.phone) || '').trim();
  if (!phone) return;

  const name = displayName(contact);
  const dial = telNumber(phone);
  const address = String((contact && contact.email) || '').trim();

  const shell = modalShell({ title: name });

  const choices = [
    el('a', {
      class: 'btn action-sheet__choice',
      href: `tel:${dial}`,
      text: `Call ${phone}`,
      onclick: () => shell.close(null),
    }),
    el('a', {
      class: 'btn action-sheet__choice',
      href: `sms:${dial}`,
      text: `Text ${phone}`,
      onclick: () => shell.close(null),
    }),
    // Only offered when there is somewhere to send it. Same flow as tapping the
    // address directly, project picker and all.
    address
      ? el('button', {
        class: 'btn action-sheet__choice',
        type: 'button',
        text: `Email ${address}`,
        onclick: () => {
          shell.close(null);
          emailAction(contact, client, projects);
        },
      })
      : null,
  ].filter(Boolean);

  shell.body.append(el('div', { class: 'action-sheet' }, choices));

  shell.foot.append(el('button', {
    class: 'btn btn--ghost',
    type: 'button',
    text: 'Cancel',
    onclick: () => shell.close(null),
  }));

  shell.open();

  // Escape and the backdrop come from modalShell; the opening focus does not.
  window.setTimeout(() => choices[0].focus(), 50);
}
