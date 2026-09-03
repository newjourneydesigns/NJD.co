// ---------------------------------------------------------------------------
// Account plumbing shared by every screen that touches a sign-in.
//
// Admin → People (add a person, set a password, change a username or role,
// delete) all end at the same place: the admin-users Netlify function, which
// holds the service-role key because assigning somebody else's password needs
// it and it can never be in a browser. The pieces live here rather than in
// admin.js because person-form.js needs them too, and importing a page entry
// module runs its main().
// ---------------------------------------------------------------------------

import { getSession } from './client.js';
import { USERNAME_DOMAIN } from './config.js';
import { el, toast } from './ui.js';

// Long enough that a leaked password is not worth guessing, short enough that
// somebody can read it down the phone. The same number lives in shell.js and
// netlify/functions/admin-users.js; the function is the one that enforces it.
export const MIN_PASSWORD = 10;

// What a username may look like: lower-case letters and digits, with dots,
// underscores and hyphens inside, 2–31 characters. The same rule as parseEmail
// in admin-users.js, which is the one that decides.
export const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,30}$/;

/**
 * The username behind a profile's email. A bare username signs in as
 * <handle>@wo-portal.invalid (client.js usernameToEmail), and that address is
 * never shown to anyone — this is what is shown instead. A real address, if
 * one were ever used, is shown whole.
 */
export function usernameOf(email) {
  const value = String(email || '').trim();
  const at = value.lastIndexOf('@');
  if (at > 0 && value.slice(at + 1).toLowerCase() === USERNAME_DOMAIN) {
    return value.slice(0, at);
  }
  return value;
}

/**
 * Call the admin-users function as the signed-in owner.
 *
 * The access token is the whole authorization story: the function verifies it
 * with Supabase and then checks that the profile behind it is the owner.
 * Sending it is not optional, and a stale one is the likeliest cause of a 401.
 */
export async function callAdminUsers(payload) {
  const session = await getSession();
  const token = session && session.access_token;
  if (!token) throw new Error('Your session has expired. Reload the page and sign in again.');

  let res;
  try {
    res = await fetch('/.netlify/functions/admin-users', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new Error('Could not reach the server. Check your connection and try again.');
  }

  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'That did not work. Please try again.');
  return body;
}

/**
 * A password worth assigning: long, unambiguous, and readable down a phone.
 *
 * The alphabet leaves out the characters people mis-hear or mis-type — no O/0,
 * no l/1/I — because these get dictated in a phone call more often than they
 * get copied and pasted. Randomness comes from crypto.getRandomValues rather
 * than Math.random, and the modulo bias is avoided by rejecting the tail of the
 * byte range instead of wrapping it.
 */
export function generatePassword() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const limit = 256 - (256 % alphabet.length);
  const out = [];
  while (out.length < 16) {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte >= limit) continue;
      out.push(alphabet[byte % alphabet.length]);
      if (out.length === 16) break;
    }
  }
  // Grouped so it can be read aloud without losing your place.
  return `${out.slice(0, 4).join('')}-${out.slice(4, 8).join('')}-${out.slice(8, 12).join('')}-${out.slice(12).join('')}`;
}

/** The password field shared by "Add a person" and the person editor — one
 *  definition, so the two forms cannot drift apart.
 *
 *  `optional` is the editor's mode: an existing account already has a
 *  password, so the box starts blank and blank means "keep it". Nothing is
 *  prefilled there — a generated value quietly submitted along with a name
 *  correction would be a password change nobody asked for. */
export function passwordFields({ optional = false } = {}) {
  return [
    {
      name: 'password',
      label: optional ? 'Set a new password' : 'Password',
      // Deliberately a text input, not a password one: whoever is assigning
      // this has to read it back to the person, and a row of dots cannot be
      // read back or checked for a typo.
      type: 'text',
      autocomplete: 'off',
      // A password autocorrected or capitalised by a phone keyboard is an
      // account that cannot be opened, with nothing on screen to say why.
      autocapitalize: 'none',
      autocorrect: 'off',
      spellcheck: 'false',
      required: !optional,
      value: optional ? '' : generatePassword(),
      action: { label: 'Generate', run: (input) => { input.value = generatePassword(); } },
      hint: optional
        ? 'Leave blank to keep their current password. Type or generate one to '
          + 'replace it — the change takes effect immediately.'
        : `At least ${MIN_PASSWORD} characters. A strong one is filled in for `
          + 'you — replace it if you would rather choose.',
    },
  ];
}

/** A read-only value with a Copy button beside it. */
function copyRow(label, value) {
  const field = el('input', {
    class: 'password-handoff__value',
    type: 'text',
    readonly: true,
    value,
    'aria-label': label,
    onclick: (event) => event.target.select(),
  });

  const copy = el('button', {
    class: 'btn btn--small',
    type: 'button',
    text: `Copy ${label.toLowerCase()}`,
    onclick: async () => {
      try {
        await navigator.clipboard.writeText(value);
        toast(`${label} copied.`, 'ok');
      } catch {
        // Clipboard access is refused in plenty of ordinary situations. Select
        // the text so copying by hand is one keystroke rather than a drag —
        // and say the right thing for the input actually in hand: there is no
        // ⌘C on a phone.
        field.select();
        toast(window.matchMedia('(pointer: coarse)').matches
          ? `Press and hold the ${label.toLowerCase()}, then choose Copy.`
          : 'Press ⌘C or Ctrl+C to copy.');
      }
    },
  });

  return el('div', { class: 'password-handoff' }, [field, copy]);
}

/**
 * Show a username and password once, each with a copy button.
 *
 * The password is never stored anywhere we can read it back — Supabase keeps
 * only a hash — so this panel is the single chance to capture it. Saying so
 * out loud is the difference between "I'll get it later" and actually copying
 * it now. The username travels with it because the two are handed over
 * together, by phone or in person: there is no email to put them in.
 */
export function passwordHandoff(username, password) {
  return el('div', { class: 'notice notice--ok' }, [
    el('strong', { text: `Sign-in details for ${username}` }),
    copyRow('Username', username),
    copyRow('Password', password),
    el('div', {
      class: 'progress__label',
      text: 'Copy the password now — this is the only time it is shown. We store '
          + 'only a hash, so nobody, including us, can read it back. If it is '
          + 'lost, set a new one.',
    }),
  ]);
}
