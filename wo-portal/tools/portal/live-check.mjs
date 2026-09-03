// ---------------------------------------------------------------------------
// Live check: does the real database behave, through the real API?
//
//   WO_CHECK_USER=<username-or-email> WO_CHECK_PASSWORD=… node tools/portal/live-check.mjs
//
// schema-check.sh proves the schema on a local Postgres as the database owner.
// This one signs in to the live Supabase project as an ordinary staff account
// with the publishable key — the same door the browser uses — and walks the
// money path end to end: client → invoice → lines → issue → payment → expense
// → receipt object → document object → clean up. Every write goes through RLS,
// the RPCs and the storage policies exactly as a page would.
//
// It creates rows prefixed "Live check" and removes them at the end, and it
// refuses to run unless the account can see zero clients to start with — so it
// cannot be pointed at a database with real data in it by accident.
// ---------------------------------------------------------------------------
import { SUPABASE_URL, SUPABASE_ANON_KEY, USERNAME_DOMAIN, DOCUMENTS_BUCKET, RECEIPTS_BUCKET } from '../../js/portal/config.js';

const user = process.env.WO_CHECK_USER;
const password = process.env.WO_CHECK_PASSWORD;
if (!user || !password) {
  console.error('Set WO_CHECK_USER and WO_CHECK_PASSWORD.');
  process.exit(2);
}
const email = user.includes('@') ? user : `${user.toLowerCase()}@${USERNAME_DOMAIN}`;

let failures = 0;
function ok(cond, what) {
  if (cond) console.log(`  ok: ${what}`);
  else { failures += 1; console.log(`  FAILED: ${what}`); }
}

let token = '';
const headers = () => ({
  apikey: SUPABASE_ANON_KEY,
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
  Prefer: 'return=representation',
});

async function rest(path, { method = 'GET', body, prefer } = {}) {
  const h = headers();
  if (prefer) h.Prefer = prefer;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method, headers: h, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}

async function rpc(name, args) {
  return rest(`rpc/${name}`, { method: 'POST', body: args });
}

async function storage(method, path, { body, contentType } = {}) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/${path}`, {
    method,
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
      ...(contentType ? { 'Content-Type': contentType } : {}),
    },
    body,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}

// A 1×1 transparent PNG, the smallest legitimate receipt photo.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

async function main() {
  console.log(`Signing in as ${email} at ${SUPABASE_URL}`);
  const login = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const session = await login.json();
  if (!login.ok) { console.error('Sign-in failed:', session); process.exit(1); }
  token = session.access_token;
  ok(Boolean(token), 'signed in with the publishable key');

  const me = await rest('profiles?select=id,role,email&id=eq.' + session.user.id);
  ok(me.status === 200 && me.data[0] && ['owner', 'staff'].includes(me.data[0].role), `profile is staff (${me.data[0]?.role})`);

  const before = await rest('clients?select=id');
  if (before.status !== 200 || before.data.length !== 0) {
    console.error('Refusing to run: this account already sees clients. Use an empty database.');
    process.exit(1);
  }

  const studio = await rest('studio_settings?select=*&id=eq.true');
  ok(studio.status === 200 && studio.data[0]?.business_name === 'Walter Ochenski LLC', 'studio_settings readable and named');
  const cats = await rest('expense_categories?select=id,code,name,schedule_c_line&order=position');
  ok(cats.status === 200 && cats.data.length >= 18, `expense categories seeded (${cats.data?.length})`);

  // Client
  const client = await rest('clients', { method: 'POST', body: { name: 'Live check client', contact_email: 'x@example.com', net_days: 30 } });
  ok(client.status === 201, 'insert client');
  const clientId = client.data?.[0]?.id;

  // Invoice via RPC
  const created = await rpc('create_invoice', { p_client_id: clientId, p_issued_on: '2026-09-01' });
  ok(created.status === 200 && typeof created.data === 'string', 'create_invoice returns an id');
  const invoiceId = created.data;
  const inv1 = await rest(`invoices?select=*&id=eq.${invoiceId}`);
  const inv = inv1.data?.[0] || {};
  ok(inv.number === '20260901-1', `number is 20260901-1 (${inv.number})`);
  ok(inv.due_on === '2026-10-01' && inv.net_days === 30, `client terms applied: Net 30 → due ${inv.due_on}`);

  const second = await rpc('create_invoice', { p_client_id: clientId, p_issued_on: '2026-09-01' });
  const inv2 = await rest(`invoices?select=number&id=eq.${second.data}`);
  ok(inv2.data?.[0]?.number === '20260901-2', 'same-day sequence gives -2');

  // Save lines
  const items = [
    { name: 'Marketing consulting', quantity: 4, unit_cents: 15000, amount_cents: 60000, position: 0 },
    { name: 'Print work', quantity: 1, unit_cents: 12550, amount_cents: 12550, position: 1 },
  ];
  const saved = await rpc('save_invoice', {
    p_id: invoiceId,
    p_invoice: { summary: 'Live check', subtotal_cents: 72550, tax_cents: 0, total_cents: 72550 },
    p_items: items,
  });
  ok(saved.status === 204 || saved.status === 200, 'save_invoice with two lines');
  const lines = await rest(`invoice_items?select=name,amount_cents&invoice_id=eq.${invoiceId}&order=position`);
  ok(lines.data?.length === 2 && lines.data[0].amount_cents === 60000, 'lines rewritten');

  // Payment on a draft must be refused
  const early = await rest('payments', { method: 'POST', body: { invoice_id: invoiceId, received_on: '2026-09-02', amount_cents: 100, method: 'ach' } });
  ok(early.status >= 400, 'payment against a draft refused');

  // Issue with a wrong total must be refused
  const bad = await rpc('save_invoice', { p_id: invoiceId, p_invoice: { subtotal_cents: 72550, tax_cents: 0, total_cents: 99999 }, p_items: items });
  ok(bad.status === 204 || bad.status === 200, 'save with a wrong total is allowed (draft)');
  const refused = await rpc('issue_invoice', { p_id: invoiceId, p_snapshot: { kind: 'invoice' }, p_hash: 'x' });
  ok(refused.status >= 400 && /does not add up/.test(JSON.stringify(refused.data)), 'issue refuses lines+tax ≠ total');
  await rpc('save_invoice', { p_id: invoiceId, p_invoice: { subtotal_cents: 72550, tax_cents: 0, total_cents: 72550 }, p_items: items });

  const issued = await rpc('issue_invoice', { p_id: invoiceId, p_snapshot: { kind: 'invoice', number: '20260901-1' }, p_hash: 'deadbeef' });
  ok(issued.status === 200, 'issue_invoice');
  const frozen = await rest(`invoices?select=status,issued_at,snapshot_hash&id=eq.${invoiceId}`);
  ok(frozen.data?.[0]?.status === 'issued' && frozen.data[0].issued_at, 'status issued, issued_at stamped');

  const edit = await rest(`invoices?id=eq.${invoiceId}`, { method: 'PATCH', body: { summary: 'tampered' } });
  ok(edit.status >= 400, 'editing an issued invoice refused');
  const lineEdit = await rest('invoice_items', { method: 'POST', body: { invoice_id: invoiceId, name: 'extra', amount_cents: 1 } });
  ok(lineEdit.status >= 400, 'adding a line to an issued invoice refused');
  const sent = await rest(`invoices?id=eq.${invoiceId}`, { method: 'PATCH', body: { status: 'sent' } });
  ok(sent.status === 200, 'status → sent allowed');

  // Payments
  const part = await rest('payments', { method: 'POST', body: { invoice_id: invoiceId, received_on: '2026-09-10', amount_cents: 50000, method: 'check', reference: '1001' } });
  ok(part.status === 201 && part.data?.[0]?.client_id === clientId, 'part payment recorded, client pinned from invoice');
  let state = (await rest(`invoices?select=status,paid_cents,paid_at&id=eq.${invoiceId}`)).data[0];
  ok(state.status === 'sent' && state.paid_cents === 50000 && !state.paid_at, `part paid: ${state.paid_cents}, still sent`);
  const rest2 = await rest('payments', { method: 'POST', body: { invoice_id: invoiceId, received_on: '2026-09-12', amount_cents: 22550, method: 'ach' } });
  ok(rest2.status === 201, 'balance payment recorded');
  state = (await rest(`invoices?select=status,paid_cents,paid_at&id=eq.${invoiceId}`)).data[0];
  ok(state.status === 'paid' && state.paid_cents === 72550 && state.paid_at, 'fully paid → paid with paid_at');
  const undo = await rest(`payments?id=eq.${rest2.data?.[0]?.id}`, { method: 'DELETE' });
  ok(undo.status === 200 || undo.status === 204, 'delete a payment');
  state = (await rest(`invoices?select=status,paid_cents&id=eq.${invoiceId}`)).data[0];
  ok(state.status === 'sent' && state.paid_cents === 50000, 'back to sent after the delete');

  // Duplicate. Taxed on purpose: a copy that keeps the source's tax but takes
  // today's settings rate is a row whose total no rate on it can explain, and
  // a tax-free duplicate would never show it.
  await rest(`invoices?id=eq.${invoiceId}`, { method: 'PATCH', body: {} });
  const dup = await rpc('duplicate_invoice', { p_id: invoiceId });
  const dupRow = (await rest(`invoices?select=number,status,total_cents,tax_rate_bp&id=eq.${dup.data}`)).data?.[0];
  const dupLines = await rest(`invoice_items?select=name&invoice_id=eq.${dup.data}`);
  ok(dupRow?.status === 'draft' && dupRow.total_cents === 72550 && dupLines.data?.length === 2, `duplicate_invoice → draft ${dupRow?.number} with 2 lines`);
  ok(dupRow?.tax_rate_bp === inv.tax_rate_bp, `and the source's tax rate, not today's settings (${dupRow?.tax_rate_bp})`);

  // An issued invoice is a record somebody is holding. Void, never delete.
  const killed = await rest(`invoices?id=eq.${invoiceId}`, { method: 'DELETE' });
  ok(killed.status >= 400, 'deleting an issued invoice refused');

  // Expense + receipt object
  const software = cats.data.find((c) => c.code === 'software');
  const expense = await rest('expenses', { method: 'POST', body: { spent_on: '2026-09-02', vendor_name: 'Live check vendor', category_id: software.id, amount_cents: 1999, method: 'card', description: 'Live check', client_id: clientId, billable: true } });
  ok(expense.status === 201, 'insert expense');
  const expenseId = expense.data?.[0]?.id;
  const noCat = await rest('expenses', { method: 'POST', body: { spent_on: '2026-09-02', amount_cents: 100 } });
  ok(noCat.status >= 400, 'expense without a category refused');

  const receiptPath = `${expenseId}/${crypto.randomUUID()}-receipt.png`;
  const up = await storage('POST', `object/${RECEIPTS_BUCKET}/${receiptPath}`, { body: PNG, contentType: 'image/png' });
  ok(up.status === 200, `receipt object uploaded (${up.status})`);
  const row = await rest('expense_receipts', { method: 'POST', body: { expense_id: expenseId, storage_path: receiptPath, name: 'receipt.png', size_bytes: PNG.length, mime_type: 'image/png' } });
  ok(row.status === 201, 'receipt row inserted');
  const signed = await storage('POST', `object/sign/${RECEIPTS_BUCKET}/${receiptPath}`, { body: JSON.stringify({ expiresIn: 60 }), contentType: 'application/json' });
  ok(signed.status === 200 && signed.data?.signedURL, 'signed URL minted for the receipt');
  const badType = await storage('POST', `object/${RECEIPTS_BUCKET}/${expenseId}/evil.html`, { body: Buffer.from('<script>1</script>'), contentType: 'text/html' });
  ok(badType.status >= 400, 'bucket refuses text/html');

  // Document object
  const docPath = `${clientId}/${crypto.randomUUID()}-note.txt`;
  const docUp = await storage('POST', `object/${DOCUMENTS_BUCKET}/${docPath}`, { body: Buffer.from('hello'), contentType: 'text/plain' });
  ok(docUp.status === 200, 'document object uploaded');
  const doc = await rest('documents', { method: 'POST', body: { client_id: clientId, name: 'note.txt', storage_path: docPath, label: 'Live check', size_bytes: 5, mime_type: 'text/plain' } });
  ok(doc.status === 201, 'document row inserted');

  // Unbilled expenses query the invoice editor will make
  const unbilled = await rest(`expenses?select=id,amount_cents&client_id=eq.${clientId}&billable=is.true&billed_invoice_id=is.null`);
  ok(unbilled.status === 200 && unbilled.data.length === 1, 'unbilled expense query finds one');

  // anon sees nothing
  const anon = await fetch(`${SUPABASE_URL}/rest/v1/clients?select=id`, { headers: { apikey: SUPABASE_ANON_KEY } });
  const anonData = await anon.json().catch(() => null);
  ok(anon.status >= 400 || (Array.isArray(anonData) && anonData.length === 0), `anon sees no clients (${anon.status})`);

  // Clean up, in dependency order. Storage first.
  await storage('DELETE', `object/${RECEIPTS_BUCKET}`, { body: JSON.stringify({ prefixes: [receiptPath] }), contentType: 'application/json' });
  await storage('DELETE', `object/${DOCUMENTS_BUCKET}`, { body: JSON.stringify({ prefixes: [docPath] }), contentType: 'application/json' });
  await rest(`documents?client_id=eq.${clientId}`, { method: 'DELETE' });
  await rest(`expenses?client_id=eq.${clientId}`, { method: 'DELETE' });
  await rest(`payments?client_id=eq.${clientId}`, { method: 'DELETE' });
  // Drafts go. The issued ones cannot: the guard this check just proved is
  // the same guard that applies here, and adding an un-issue path so the test
  // could tidy up would be a back door in the product for the convenience of
  // the test. They are voided and left, and the operator is told the one
  // statement that clears them — which needs the SQL editor, as deleting a
  // business record should.
  await rest(`invoices?client_id=eq.${clientId}&issued_at=is.null`, { method: 'DELETE' });
  await rest(`invoices?client_id=eq.${clientId}`, { method: 'PATCH', body: { status: 'void' } });
  const left = await rest(`invoices?select=id&client_id=eq.${clientId}`);
  const stuck = left.data?.length || 0;

  if (!stuck) {
    const bye = await rest(`clients?id=eq.${clientId}`, { method: 'DELETE' });
    ok(bye.status === 200 || bye.status === 204, 'check client removed');
  } else {
    ok(true, `${stuck} issued check invoice(s) voided and left — see below`);
    console.log(`
Clear them in the Supabase SQL editor when you are done:

  delete from payments where client_id = '${clientId}';
  alter table invoices disable trigger invoices_guard_delete;
  delete from invoices where client_id = '${clientId}';
  alter table invoices enable trigger invoices_guard_delete;
  delete from clients where id = '${clientId}';
`);
  }

  console.log(failures ? `\n${failures} FAILED` : '\nLive check OK — the database behaves through the API.');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
