// ---------------------------------------------------------------------------
// Tapping a person: call, text, or email them.
//
// A phone number rendered as text is a number you have to retype into your
// phone, and that is enough friction that the call does not get made. So every
// number and address the business holds is an action, not a label.
//
// Nothing here sends anything. tel:, sms: and mailto: hand off to the phone's
// own dialler, messages app and mail client — the portal itself has no mail
// of any kind. The pieces live here rather than on the client page because a
// number is a number wherever it appears: the same sheet opens from the
// client list, the record's Details panel, and a contact row.
// ---------------------------------------------------------------------------

import { BUSINESS_NAME } from './config.js';
import { el, modalShell, fmtDate } from './ui.js';

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
 * The mailto the owner would have typed by hand.
 *
 * The subject is generic on purpose — there are no projects to name — and the
 * body is a greeting, so the mail client opens with something to finish
 * rather than something to delete.
 *
 * Every interpolated part is percent-encoded, including the address: these are
 * free-text columns, and an address containing `&` would otherwise smuggle a
 * second query parameter into the URL.
 */
function mailtoUrl(address, contact) {
  const subject = `${BUSINESS_NAME} — ${fmtDate(todayIso())}`;

  const first = firstName(contact);
  const body = first ? `Hi ${first},` : 'Hi,';

  // The address is a free-text column, so it still gets encoded — an unescaped
  // "&" in it would otherwise start a new query parameter. But "@" is put back:
  // it is legal unencoded per RFC 6068, it is the form every mail client is
  // actually tested against, and a few older ones choke on "%40".
  const to = encodeURIComponent(address).replace(/%40/g, '@');

  return `mailto:${to}`
    + `?subject=${encodeURIComponent(subject)}`
    + `&body=${encodeURIComponent(body)}`;
}

function openMail(address, contact) {
  window.location.href = mailtoUrl(address, contact);
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
 * contact  { name, email } — the person tapped, whose first name opens the body.
 */
export function emailAction(contact) {
  const address = String((contact && contact.email) || '').trim();
  // No address, no email affordance — this is a guard against a caller wiring
  // one up by mistake, not a state the UI is meant to reach.
  if (!address) return;

  openMail(address, contact);
}

/**
 * Open the call / text / email sheet for a contact with a phone number.
 *
 * A contact with no number never gets a phone affordance in the first place,
 * so this returns quietly rather than opening an empty sheet.
 */
export function phoneAction(contact) {
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
    // address directly.
    address
      ? el('button', {
        class: 'btn action-sheet__choice',
        type: 'button',
        text: `Email ${address}`,
        onclick: () => {
          shell.close(null);
          emailAction(contact);
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
