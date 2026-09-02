// ---------------------------------------------------------------------------
// Portal configuration — Walter Ochenski LLC
//
// Both Supabase values are safe to commit: the publishable key only ever
// grants what Row Level Security allows, and every table in
// supabase/schema.sql has RLS enabled.
//
// NEVER put the secret (service-role) key in this file. It bypasses RLS
// entirely and belongs only in Netlify environment variables (see
// netlify/functions/admin-users.js).
// ---------------------------------------------------------------------------

export const SUPABASE_URL = 'https://gkzhspoqokjjnvhziivt.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_DGoS4FOHO34UgsAEz5KGCQ_2_cu-bc4';

// The Supabase client is vendored into js/vendor/ and loaded by a plain
// <script> tag on each portal page, not fetched from a CDN — see
// js/vendor/README.md for why. The <script src> in every portal page has to
// match this version.
export const SUPABASE_SDK_VERSION = '2.111.0';

// Private buckets. Policies are in supabase/schema.sql.
export const DOCUMENTS_BUCKET = 'client-documents';
export const RECEIPTS_BUCKET = 'expense-receipts';

// Sign-in is by username. Supabase identifies accounts by email address, so
// a bare handle is mapped to <handle>@<USERNAME_DOMAIN> before it reaches
// Supabase. The domain is reserved by RFC 2606 and never resolves; nothing
// is ever mailed to it. A value typed with an @ in it is passed through.
export const USERNAME_DOMAIN = 'wo-portal.invalid';

// Printed on the login page and wherever the portal has to say "ask the
// owner". The letterhead itself comes from studio_settings in the database.
export const BUSINESS_NAME = 'Walter Ochenski LLC';
export const BUSINESS_PHONE = '(972) 467-5988';

// Session storage keys. Named for this portal so a browser that also holds
// an NJD portal session never mixes the two.
export const REMEMBER_KEY = 'wo-portal-remember';
export const LAST_USERNAME_KEY = 'wo-portal-last-username';

export const isConfigured =
  /^https:\/\/[a-z0-9-]+\.supabase\.(co|in)$/.test(SUPABASE_URL) &&
  SUPABASE_ANON_KEY.length > 20 &&
  !SUPABASE_ANON_KEY.startsWith('YOUR-');
