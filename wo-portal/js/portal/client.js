// ---------------------------------------------------------------------------
// Supabase client + session helpers — Walter Ochenski LLC portal
//
// Everything that talks to Supabase starts here: the one client, the session
// storage it uses, the signed-in person's profile, and the two role questions
// every page asks (is this staff? is this the owner?). Nothing in this file
// renders anything.
// ---------------------------------------------------------------------------

import {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  USERNAME_DOMAIN,
  REMEMBER_KEY,
  isConfigured,
} from './config.js';

export { isConfigured, REMEMBER_KEY };

// The vendored SDK is a classic <script> that sets window.supabase, placed
// before this module on every portal page. Both are deferred and run in
// document order, so by the time this evaluates the global is there. If it is
// not, something is wrong with the page's script tags rather than the network —
// sdkMissing lets the shell say so instead of throwing at import time, which
// would take the whole module graph down and leave a blank page.
const sdk = typeof window !== 'undefined' ? window.supabase : null;

export const sdkMissing = isConfigured && !(sdk && sdk.createClient);

// "Remember me" — the login page writes this flag before signing in, and the
// storage adapter below routes the session token by it: localStorage keeps a
// person signed in across browser restarts (the default), sessionStorage
// forgets when the browser closes. The flag itself always lives in
// localStorage; it is a preference, not a credential. The key is named in
// config.js so a browser that also holds an NJD portal session never mixes
// the two.
function sessionStore() {
  try {
    return window.localStorage.getItem(REMEMBER_KEY) === '0'
      ? window.sessionStorage
      : window.localStorage;
  } catch (err) {
    // Storage blocked entirely. Null means nothing persists; the sign-in
    // still works for the life of the tab, which is all that can be offered.
    return null;
  }
}

/** Whether this browser chose to stay signed in. Absent reads as yes. */
export function rememberedChoice() {
  try {
    return window.localStorage.getItem(REMEMBER_KEY) !== '0';
  } catch (err) {
    return true;
  }
}

export function setRememberMe(remember) {
  try {
    window.localStorage.setItem(REMEMBER_KEY, remember ? '1' : '0');
    // The choice moves where the session lives; leave no token behind in the
    // store that is no longer the active one.
    const inactive = remember ? window.sessionStorage : window.localStorage;
    for (let i = inactive.length - 1; i >= 0; i -= 1) {
      const key = inactive.key(i);
      if (key && key.startsWith('sb-')) inactive.removeItem(key);
    }
  } catch (err) {
    // Storage blocked — nothing to route, nothing to clean.
  }
}

let client = null;

if (isConfigured && !sdkMissing) {
  client = sdk.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      // Sign-in is username and password and the system sends no email, so
      // nothing ever arrives as a callback in the URL. Left on because it
      // costs nothing; turning it off would make any future link-based flow
      // a debugging session rather than a config change.
      detectSessionInUrl: true,
      flowType: 'pkce',
      storage: {
        getItem: (key) => {
          const store = sessionStore();
          return store ? store.getItem(key) : null;
        },
        setItem: (key, value) => {
          // Writes get their own guard: private-mode Safari lets a store be
          // read and then throws on the write, and a sign-in must not die on
          // "could not save the token" — it just will not outlive the tab.
          const store = sessionStore();
          try {
            if (store) store.setItem(key, value);
          } catch (err) { /* quota or lockdown — session stays in memory */ }
        },
        removeItem: (key) => {
          const store = sessionStore();
          try {
            if (store) store.removeItem(key);
          } catch (err) { /* nothing stored, nothing to remove */ }
        },
      },
    },
  });
}

export const supabase = client;

let cachedProfile = null;

export async function getSession() {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session || null;
}

/**
 * The signed-in user's profile row: { id, email, full_name, role, phone }.
 * Returns null when signed out. Cached for the life of the page.
 *
 * The select names only columns that exist in supabase/schema.sql. A select
 * naming a missing column is a PostgREST 400, and because every page starts
 * here that would blank the whole portal.
 */
export async function getProfile() {
  if (cachedProfile) return cachedProfile;
  if (!supabase) return null;

  const session = await getSession();
  if (!session) return null;

  const { data, error } = await supabase
    .from('profiles')
    .select('id, email, full_name, role, phone')
    .eq('id', session.user.id)
    .maybeSingle();

  if (error) throw error;

  // The signup trigger normally creates this row; fall back to a profile with
  // no role so a trigger hiccup shows the no-access screen rather than a
  // stack trace.
  cachedProfile = data || {
    id: session.user.id,
    email: session.user.email,
    full_name: '',
    role: 'none',
    phone: null,
  };

  return cachedProfile;
}

export async function signOut() {
  if (supabase) await supabase.auth.signOut();
  cachedProfile = null;
  window.location.replace('/portal/');
}

/** Only ever redirect within the portal — never to an attacker-supplied host.
 *  The default is the Dashboard: the figures first, everything else one menu
 *  tap away. */
export function safeNext(value) {
  if (typeof value !== 'string') return '/portal/dashboard/';
  if (!value.startsWith('/portal/') || value.startsWith('//')) {
    return '/portal/dashboard/';
  }
  return value;
}

/** Staff: the owner or the bookkeeper. Everything but accounts and business
 *  settings. Matches is_admin() in the schema, which is what the policies ask. */
export function isAdmin(profile) {
  return Boolean(profile && (profile.role === 'owner' || profile.role === 'staff'));
}

/** The owner alone: sign-ins and the business details. */
export function isOwner(profile) {
  return Boolean(profile && profile.role === 'owner');
}

/**
 * What the login box holds, as the address Supabase knows the account by.
 *
 * Supabase identifies accounts by email, so a bare username is an email in
 * disguise: `walter` signs in as walter@wo-portal.invalid. The domain is
 * reserved by RFC 2606, never resolves, and nothing is ever mailed to it. A
 * value typed with an @ in it is somebody's real address and passes through.
 * Lower-cased and trimmed either way, because GoTrue compares addresses
 * case-insensitively and a phone keyboard capitalises the first letter.
 */
export function usernameToEmail(handle) {
  const value = String(handle == null ? '' : handle).trim().toLowerCase();
  if (!value) return '';
  return value.includes('@') ? value : `${value}@${USERNAME_DOMAIN}`;
}

// The shapes Postgres and PostgREST use when they are talking to a developer
// rather than to a person: constraint names, relation names, SQLSTATE prose.
// Anything matching these must never reach a screen — see errorMessage.
const DATABASE_SHAPED = new RegExp([
  'violates .*constraint',
  'duplicate key value',
  'null value in column',
  'relation "', 'column "', 'function .* does not exist',
  'permission denied for',
  'syntax error at or near',
  'invalid input syntax for',
  'value too long for type',
].join('|'), 'i');

/** Turns a Supabase/PostgREST error into something worth showing a human.
 *
 *  Two things make this less obvious than it looks.
 *
 *  First, it is applied twice on most paths: a caller does
 *  `throw new Error(errorMessage(err))` and something above it catches and
 *  calls `errorMessage` again on the Error it just made. So an already-human
 *  message has to survive a second pass untouched — which rules out "return
 *  the fallback for anything unrecognised", because every hand-written
 *  validation line ("That is not a number of days.") comes through here and
 *  would collapse into "Something went wrong."
 *
 *  Second, the raw string is the only other thing on offer, and unmapped raw
 *  strings are Postgres talking: constraint names in front of a person. So the
 *  rule is neither "always raw" nor "never raw" — it is: recognise the database
 *  errors that actually occur, translate those, and pass anything through only
 *  when it does not look like the database wrote it. A `raise exception` from
 *  one of the schema's own triggers ("This invoice has been issued. Void it
 *  and raise a new one instead of editing it.") is written for a person and
 *  passes through on purpose.
 */
export function errorMessage(error, fallback = 'Something went wrong.') {
  if (!error) return fallback;
  const raw = error.message || error.error_description || '';

  // SQLSTATE first: it is exact where a message match is a guess. PostgREST
  // puts the five-character class in `code`.
  switch (error.code) {
    case '23505': return 'Something with those details already exists.';
    case '23503': return 'Something else still refers to this. Remove that first.';
    case '23502': return 'A required field was left empty.';
    case '23514': return 'Those details are not a combination we can save.';
    case '22001': return 'That is longer than the field allows.';
    case '22P02': return 'One of those values is not the right kind of value.';
    case '42501': return 'You do not have permission to do that.';
    case 'PGRST116': return 'That record was not found. Reload and try again.';
    default: break;
  }

  if (/row-level security|violates row-level/i.test(raw)) {
    return 'You do not have permission to do that.';
  }
  if (/JWT|token is expired/i.test(raw)) {
    return 'Your session expired. Please sign in again.';
  }
  if (/Failed to fetch|NetworkError/i.test(raw)) {
    return 'Could not reach the server. Check your connection and try again.';
  }

  // Unmapped and database-shaped: keep it out of the interface, but do not
  // lose it — whoever is debugging still needs the constraint name.
  if (DATABASE_SHAPED.test(raw)) {
    if (typeof console !== 'undefined') console.error('Unmapped database error:', raw);
    return fallback;
  }

  return raw || fallback;
}
