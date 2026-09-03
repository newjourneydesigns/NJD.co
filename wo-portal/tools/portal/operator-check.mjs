// ---------------------------------------------------------------------------
// Is R2 still a real sign-in, and are its limits still real?
//
//   WO_R2_PASSWORD=… node tools/portal/operator-check.mjs
//
// R2 is the portal's AI operator (CLAUDE.md). It is deliberately not
// special-cased: it signs in at the same password endpoint as a person, and
// the same Row Level Security decides what it can see. This check proves both
// halves of that claim against the live project — that the account works, and
// that the two things it must not be able to do are refused by the database
// rather than by a promise in a rulebook.
//
// The password comes from the environment, and the only place to get it is
// Supabase Vault:
//
//   select decrypted_secret from vault.decrypted_secrets
//    where name = 'r2_portal_password';
//
// Read-only apart from one log row, which is the point of the log.
// ---------------------------------------------------------------------------
import { SUPABASE_URL, SUPABASE_ANON_KEY, USERNAME_DOMAIN } from '../../js/portal/config.js';

const password = process.env.WO_R2_PASSWORD;
if (!password) {
  console.error('Set WO_R2_PASSWORD from the Vault secret r2_portal_password.');
  process.exit(2);
}
const email = `r2@${USERNAME_DOMAIN}`;

let failures = 0;
const ok = (cond, what) => {
  console.log(`  ${cond ? 'ok' : 'FAILED'}: ${what}`);
  if (!cond) failures += 1;
};

let token = '';
async function rest(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}

async function main() {
  const login = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const session = await login.json();
  if (!login.ok) {
    console.error('R2 could not sign in:', session.error_description || session.msg || session);
    console.error('If the password was rotated, take the current one from Vault.');
    process.exit(1);
  }
  token = session.access_token;
  ok(Boolean(token), 'R2 signs in at the same endpoint a person does');

  const me = await rest(`profiles?select=id,full_name,role&id=eq.${session.user.id}`);
  const profile = me.data?.[0];
  ok(profile?.full_name === 'R2', `the profile is R2 (${profile?.full_name})`);
  ok(profile?.role === 'owner', `with full rights (${profile?.role})`);

  // It reaches the portal's data the way a page does — not through a back
  // door, and not with a key that bypasses anything.
  const clients = await rest('clients?select=id&limit=1');
  ok(clients.status === 200, `and reads the portal's data under RLS (HTTP ${clients.status})`);

  // The two refusals that make the log worth having.
  const forged = await rest('activity_log', {
    method: 'POST',
    body: { actor_id: '00000000-0000-0000-0000-000000000001', action: 'forged' },
  });
  ok(forged.status >= 400, `cannot log work as somebody else (HTTP ${forged.status})`);

  const wiped = await rest('activity_log?action=eq.create-operator', { method: 'DELETE' });
  ok(wiped.status >= 400, `cannot delete what it has logged (HTTP ${wiped.status})`);

  const edited = await rest('activity_log?action=eq.create-operator', {
    method: 'PATCH', body: { detail: {} },
  });
  ok(edited.status >= 400, `cannot rewrite it either (HTTP ${edited.status})`);

  // And the log works when it is used honestly, which is the whole contract.
  const logged = await rest('activity_log', {
    method: 'POST',
    body: {
      actor_id: session.user.id,
      action: 'operator-check',
      detail: { why: 'proving R2 can sign in and that its limits hold' },
    },
  });
  ok(logged.status === 201, 'and can log its own work, signed as itself');

  const history = await rest('activity_log?select=action,created_at&order=created_at.desc&limit=5');
  ok(history.status === 200 && history.data.length > 0,
    `"what has R2 been doing" is a query (${history.data?.length} recent rows)`);

  console.log(failures ? `\n${failures} FAILED` : '\nOperator check OK — R2 is a real sign-in with real limits.');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
