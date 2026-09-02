// ---------------------------------------------------------------------------
// Account plumbing shared by every screen that can create a sign-in.
//
// Admin (Add a person, Set password) and the client page (Give portal access)
// both end at the same place: the admin-users Netlify function, which holds the
// service-role key because assigning somebody else's password needs it and it
// can never be in a browser. These helpers lived in admin.js until the client
// page needed them too; importing a page entry module runs its main(), so the
// shared pieces live here instead.
// ---------------------------------------------------------------------------

import { getSession } from './client.js';
import { el, toast, copyRichText } from './ui.js';
import { welcomeEmail } from './welcome-email.js';
import { welcomeMessage } from './welcome-message.js';
import { PORTAL_LOGIN_URL, SUPPORT_EMAIL } from './config.js';

export const MIN_PASSWORD = 10;

/**
 * Call the admin-users function as the signed-in admin.
 *
 * The access token is the whole authorization story: the function verifies it
 * with Supabase and then checks that the profile behind it is an admin. Sending
 * it is not optional, and a stale one is the likeliest cause of a 401 here.
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

/** The password fields shared by "Add a person", the person editor, and "Give
 *  portal access" — one definition, so the forms cannot drift apart.
 *
 *  `optional` is the editor's mode: an existing account already has a
 *  password, so the box starts blank and blank means "keep it". Nothing is
 *  prefilled there — a generated value quietly submitted along with a name
 *  correction would be a password change nobody asked for. */
export function passwordFields({ optional = false } = {}) {
  return [
    {
      name: 'password',
      label: optional ? 'New password' : 'Password',
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

/**
 * Show a password once, with a copy button.
 *
 * It is never stored anywhere we can read it back — Supabase keeps only a hash
 * — so this panel is the single chance to capture it. Saying so out loud is the
 * difference between "I'll get it later" and actually copying it now.
 */
export function passwordHandoff(email, password) {
  const field = el('input', {
    class: 'password-handoff__value',
    type: 'text',
    readonly: true,
    value: password,
    'aria-label': `Password for ${email}`,
  });

  const copy = el('button', {
    class: 'btn btn--small',
    type: 'button',
    text: 'Copy',
    onclick: async () => {
      try {
        await navigator.clipboard.writeText(password);
        toast('Password copied.', 'ok');
      } catch {
        // Clipboard access is refused in plenty of ordinary situations. Select
        // the text so copying by hand is one keystroke rather than a drag —
        // and say the right thing for the input actually in hand: there is no
        // ⌘C on a phone.
        field.select();
        toast(window.matchMedia('(pointer: coarse)').matches
          ? 'Press and hold the password, then choose Copy.'
          : 'Press ⌘C or Ctrl+C to copy.');
      }
    },
  });

  return el('div', { class: 'notice notice--ok' }, [
    el('strong', { text: `Password set for ${email}` }),
    el('div', { class: 'password-handoff' }, [field, copy]),
    el('div', {
      class: 'progress__label',
      text: 'Copy it now — this is the only time it is shown. We store only a '
          + 'hash, so nobody, including us, can read it back. If it is lost, '
          + 'set a new one.',
    }),
  ]);
}

/**
 * The welcome to send with a brand-new client account: the subject, and the two
 * ways to take the body.
 *
 * Lives here rather than in either dialog because both endings need it and one
 * of them nearly did without. A client's first credentials surface in two
 * places — the person modal's password notice (a new contact, the common case)
 * and the promote flow's message handoff — and a welcome offered in only one of
 * them is a welcome most clients never get.
 *
 * Returns the block, and the built email so a caller can reuse the subject.
 * `plain` is the short note for a text thread (welcome-message.js); the rich
 * copy carries the long plain flavour as its own text/plain sibling.
 */
export function welcomeHandoff({ name, clientName, email, password }) {
  const built = welcomeEmail({
    name,
    clientName,
    email,
    password,
    loginUrl: PORTAL_LOGIN_URL,
    supportEmail: SUPPORT_EMAIL,
  });

  const plain = welcomeMessage({
    name,
    clientName,
    email,
    password,
    loginUrl: PORTAL_LOGIN_URL,
    supportEmail: SUPPORT_EMAIL,
  });

  const subject = el('input', {
    type: 'text',
    id: 'welcome-subject',
    readonly: true,
    spellcheck: 'false',
    value: built.subject,
    onclick: (event) => event.target.select(),
  });

  const copyEmail = el('button', {
    class: 'btn btn--small',
    type: 'button',
    text: 'Copy email',
    onclick: async () => {
      const done = await copyRichText({ html: built.html, text: built.text });
      if (done) toast('Email copied. Paste it into Gmail — it keeps its layout.', 'ok');
      else toast('The browser would not take it. Copy the plain text instead.', 'error');
    },
  });

  const copyPlain = el('button', {
    class: 'btn btn--small btn--ghost',
    type: 'button',
    text: 'Copy plain text',
    onclick: async () => {
      try {
        await navigator.clipboard.writeText(plain);
        toast('Message copied. Paste it into a text or an email.', 'ok');
      } catch {
        toast(window.matchMedia('(pointer: coarse)').matches
          ? 'Press and hold the message, then choose Copy.'
          : 'Press ⌘C or Ctrl+C to copy.');
      }
    },
  });

  const node = el('div', { class: 'form-field' }, [
    el('label', { for: 'welcome-subject', text: 'Their welcome — subject' }),
    subject,
    el('div', { class: 'btn-row' }, [copyEmail, copyPlain]),
    el('span', {
      class: 'progress__label',
      text: 'Copy email puts the branded version on the clipboard — paste it '
          + 'straight into a Gmail compose window and it arrives laid out. The '
          + 'plain text is the short one, for a text message.',
    }),
  ]);

  return { node, built, plain };
}
