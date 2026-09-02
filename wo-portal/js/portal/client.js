// ---------------------------------------------------------------------------
// Supabase client + session helpers
// ---------------------------------------------------------------------------

import {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  isConfigured,
} from './config.js';

export { isConfigured };

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
// person signed in across browser restarts (the default, and what every
// session before the flag existed already did), sessionStorage forgets when
// the browser closes. The flag itself always lives in localStorage; it is a
// preference, not a credential. Same design as njdboards/lib/supabase.ts,
// which had it first.
export const REMEMBER_KEY = 'njd-portal-remember';

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

/** Whether this browser chose to stay signed in. Absent reads as yes — that
 *  is what the portal always did before the choice existed. */
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
      // Sign-in is email and password, so nothing currently arrives as a
      // callback in the URL. Both settings stay on because they cost nothing
      // and are what any emailed link — a future password reset, or OAuth —
      // would need to complete. Turning them off would make that a debugging
      // session rather than a config change.
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
 * The signed-in user's profile row: { id, email, full_name, role, client_id }.
 * Returns null when signed out. Cached for the life of the page.
 */
export async function getProfile() {
  if (cachedProfile) return cachedProfile;
  if (!supabase) return null;

  const session = await getSession();
  if (!session) return null;

  const { data, error } = await supabase
    .from('profiles')
    .select('id, email, full_name, role, client_id, email_mentions')
    .eq('id', session.user.id)
    .maybeSingle();

  if (error) throw error;

  // The signup trigger normally creates this row; fall back to a minimal
  // client-shaped profile so a trigger hiccup shows the no-access screen
  // rather than a stack trace.
  cachedProfile = data || {
    id: session.user.id,
    email: session.user.email,
    full_name: '',
    role: 'client',
    client_id: null,
  };

  return cachedProfile;
}

export async function signOut() {
  if (supabase) await supabase.auth.signOut();
  cachedProfile = null;
  // An installed app's icon badge outlives the session that set it; a count
  // belonging to nobody signed in is just wrong on the home screen.
  if (typeof navigator.clearAppBadge === 'function') {
    const call = navigator.clearAppBadge();
    if (call && call.catch) call.catch(() => {});
  }
  window.location.replace('/portal/');
}

/** Only ever redirect within the portal — never to an attacker-supplied host.
 *  The default is home: staff land on Focus — the day first, the business
 *  chase-downs under it — and Focus itself bounces a client on to their
 *  projects, so one address serves both roles. (The Dashboard held this job
 *  until 2026-08-23; it keeps the full picture, one nav tap away.) */
export function safeNext(value) {
  if (typeof value !== 'string') return '/portal/focus/';
  if (!value.startsWith('/portal/') || value.startsWith('//')) {
    return '/portal/focus/';
  }
  return value;
}

export function isAdmin(profile) {
  return Boolean(profile && profile.role === 'admin');
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
 *  calls `errorMessage` again on the Error it just made. There are 72 of those.
 *  So an already-human message has to survive a second pass untouched — which
 *  rules out "return the fallback for anything unrecognised", because roughly
 *  forty hand-written validation lines ("The stop time has to be after the
 *  start time.") come through here and would all collapse into
 *  "Something went wrong."
 *
 *  Second, the raw string is the only other thing on offer, and unmapped raw
 *  strings are Postgres talking: constraint names in front of a client. So the
 *  rule is neither "always raw" nor "never raw" — it is: recognise the database
 *  errors that actually occur, translate those, and pass anything through only
 *  when it does not look like the database wrote it.
 */
export function errorMessage(error, fallback = 'Something went wrong.') {
  if (!error) return fallback;
  const raw = error.message || error.error_description || '';

  // SQLSTATE first: it is exact where a message match is a guess. PostgREST
  // puts the five-character class in `code`.
  switch (error.code) {
    case '23505': return 'Something with those details is already on file.';
    case '23503': return 'Something else still refers to this. Remove that first.';
    case '23502': return 'A required field was left empty.';
    case '23514': return 'Those details are not a combination we can save.';
    case '22001': return 'That is longer than the field allows.';
    case '22P02': return 'One of those values is not the right kind of value.';
    case '42501': return 'You do not have permission to do that.';
    case 'PGRST116': return 'That record is no longer there. Reload and try again.';
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
  // sows.client_id is the one `on delete restrict` in the schema, deliberately:
  // a client with a scope of work on file is not a record anyone should be
  // able to delete sideways. Postgres says so in constraint names; say it in
  // English instead.
  if (/sows_client_id_fkey/i.test(raw)) {
    return 'This client has scopes of work on file, and those are kept as '
         + 'business records. Delete or void them first.';
  }
  if (/sow_credits_pkey/i.test(raw)) {
    return 'The one-page credit for this client has already been used. '
         + 'Reload the list to see where.';
  }

  // Unmapped and database-shaped: keep it out of the interface, but do not
  // lose it — whoever is debugging still needs the constraint name.
  if (DATABASE_SHAPED.test(raw)) {
    if (typeof console !== 'undefined') console.error('Unmapped database error:', raw);
    return fallback;
  }

  return raw || fallback;
}
