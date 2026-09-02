// ---------------------------------------------------------------------------
// Sign in — username and password.
//
// There is no self-serve reset here on purpose, and no email behind the form
// at all: the owner hands out usernames and passwords from Admin → People, a
// signed-in person can change their own password from the header, and anyone
// locked out calls the business — that is the footer line. Supabase still
// thinks in email addresses, so the username is mapped to a synthetic one
// (usernameToEmail in client.js) just before the sign-in call. Nothing on this
// page ever shows that address.
// ---------------------------------------------------------------------------

import {
  supabase, isConfigured, sdkMissing, getSession, safeNext, errorMessage,
  rememberedChoice, setRememberMe, usernameToEmail,
} from './client.js';
import { LAST_USERNAME_KEY, BUSINESS_PHONE } from './config.js';
import { renderSetupNotice, renderSdkMissing } from './shell.js';
import { el, mount, clear, byId, toast } from './ui.js';

const SUBMIT_LABEL = 'Sign in';

const panel = byId('login-panel');
const form = byId('login-form');
const usernameInput = byId('login-username');
const passwordInput = byId('login-password');
const rememberInput = byId('login-remember');
const revealBtn = byId('login-reveal');
const submitBtn = byId('login-submit');
const statusBox = byId('login-status');

/** Show/hide the password. Assigned passwords are long and mixed-case, and on a
 *  phone they are typed blind into a field of dots — which is how a correct
 *  password gets entered wrong three times in a row. */
function toggleReveal() {
  const showing = passwordInput.type === 'text';
  passwordInput.type = showing ? 'password' : 'text';
  revealBtn.textContent = showing ? 'Show' : 'Hide';
  revealBtn.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
  revealBtn.setAttribute('aria-pressed', String(!showing));
  // Keep the caret where it was; retyping from the start is the thing we are
  // trying to avoid.
  passwordInput.focus();
}

let redirecting = false;

/** The ?next= we were sent here with, sanitized to stay inside the portal. */
function nextPath() {
  return safeNext(new URLSearchParams(window.location.search).get('next'));
}

function goToPortal() {
  if (redirecting) return;
  redirecting = true;
  window.location.replace(nextPath());
}

// Notices are divs rather than paragraphs so `.login__panel p` does not win the
// colour back from `.notice--*`.
function showNotice(message, kind) {
  mount(statusBox, el('div', { class: `notice notice--${kind}`, text: message }));
}

function friendlyError(error) {
  const raw = (error && (error.message || error.error_description)) || '';

  // Supabase answers a wrong password and a username with no account with the
  // same "Invalid login credentials", and that is the right behaviour — telling
  // a stranger which usernames exist is free reconnaissance. Keep it.
  if (/invalid login credentials|invalid credentials/i.test(raw)) {
    return `Check your username and password, or call ${BUSINESS_PHONE}.`;
  }
  if (/email not confirmed/i.test(raw)) {
    return `That sign-in is not active yet. Call ${BUSINESS_PHONE} and we will sort it out.`;
  }
  if (/rate limit|too many/i.test(raw)) {
    return 'Too many attempts — wait a minute and try again.';
  }
  return errorMessage(error, 'We could not sign you in. Please try again.');
}

function resetButton() {
  submitBtn.disabled = false;
  submitBtn.textContent = SUBMIT_LABEL;
}

/** Keep — or forget — the username for next time, by the same choice that
 *  places the session. Storage can be blocked; the sign-in already worked, so
 *  failing to remember the name is not worth an error on screen. What is kept
 *  is the handle as typed, never the synthetic address behind it. */
function rememberUsername(username) {
  try {
    if (!rememberInput || rememberInput.checked) {
      window.localStorage.setItem(LAST_USERNAME_KEY, username);
    } else {
      window.localStorage.removeItem(LAST_USERNAME_KEY);
    }
  } catch (err) { /* private-mode lockdown — nothing to do */ }
}

/** Restore the previous visit's choices: the box as it was left, the username
 *  already typed. The password is the one thing this page should ever ask a
 *  returning person for. */
function restoreRemembered() {
  if (rememberInput) rememberInput.checked = rememberedChoice();
  try {
    const last = window.localStorage.getItem(LAST_USERNAME_KEY);
    if (last && !usernameInput.value) usernameInput.value = last;
  } catch (err) { /* storage blocked — the form is simply blank */ }
}

async function onSubmit(event) {
  event.preventDefault();

  const username = usernameInput.value.trim();
  const password = passwordInput.value;

  if (!username) {
    showNotice('Enter your username.', 'error');
    usernameInput.focus();
    return;
  }
  if (!password) {
    showNotice('Enter your password.', 'error');
    passwordInput.focus();
    return;
  }

  clear(statusBox);
  submitBtn.disabled = true;
  submitBtn.textContent = 'Signing in…';

  // The choice decides which store receives the session token, so it has to
  // land before the sign-in call writes one.
  setRememberMe(!rememberInput || rememberInput.checked);

  try {
    const { error } = await supabase.auth.signInWithPassword({
      email: usernameToEmail(username),
      password,
    });
    if (error) throw error;
    rememberUsername(username);
    // onAuthStateChange fires SIGNED_IN and redirects; this is the fallback for
    // the case where the listener has already been torn down.
    goToPortal();
  } catch (error) {
    const message = friendlyError(error);
    // A toast alone is too easy to miss on a screen this quiet, so the message
    // stays put next to the form as well.
    toast(message, 'error');
    showNotice(message, 'error');
    resetButton();
    // Clear only the password. Making them retype the username too is the kind
    // of small rudeness that makes a login feel hostile.
    passwordInput.value = '';
    passwordInput.focus();
  }
}

async function main() {
  if (!isConfigured) {
    renderSetupNotice(panel);
    return;
  }

  if (sdkMissing) {
    renderSdkMissing(panel);
    return;
  }

  supabase.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_IN') goToPortal();
  });

  form.addEventListener('submit', onSubmit);
  if (revealBtn) revealBtn.addEventListener('click', toggleReveal);
  restoreRemembered();

  let session = null;
  try {
    session = await getSession();
  } catch (error) {
    showNotice(friendlyError(error), 'error');
  }

  if (session) goToPortal();
}

main();
