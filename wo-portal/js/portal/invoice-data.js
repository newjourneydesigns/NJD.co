// ---------------------------------------------------------------------------
// Every query the invoice builder makes.
//
// Kept apart from the two screens for the same reason sow-data.js is: the
// editor and the list are about their own behaviour, and the shape of what
// comes back off the wire is stated once. The writes that have to be
// all-or-nothing go through the RPCs in supabase/schema.sql.
// ---------------------------------------------------------------------------

import { supabase, errorMessage } from './client.js';
import { CLIENT_COLUMNS } from './sow-data.js';

export const INVOICE_COLUMNS = `
  id, client_id, project_id, sow_id, number, stage, status,
  issued_on, due_on, sow_label, project_name, purchase_order,
  summary, notes,
  subtotal_cents, tax_rate_bp, tax_cents, paid_cents, total_cents, currency,
  paid_at, issued_at, snapshot_hash, created_at, updated_at
`;

function unwrap(result) {
  if (result.error) throw new Error(errorMessage(result.error));
  return result.data;
}

export async function loadTerms() {
  return unwrap(await supabase.from('invoice_settings').select('*').limit(1).maybeSingle());
}

export async function saveTerms(patch) {
  unwrap(await supabase.from('invoice_settings').update(patch).eq('id', true));
}

/** The list view: every invoice with the client name, newest number first. */
export async function loadInvoices() {
  return unwrap(await supabase
    .from('invoices')
    .select(`${INVOICE_COLUMNS}, clients(name, legal_name)`)
    .order('number', { ascending: false })) || [];
}

/** One invoice and its lines, in a single round trip. */
export async function loadInvoice(id) {
  const invoice = unwrap(await supabase
    .from('invoices')
    .select(`${INVOICE_COLUMNS}, snapshot, clients(${CLIENT_COLUMNS})`)
    .eq('id', id)
    .maybeSingle());

  if (!invoice) return null;

  const items = unwrap(await supabase
    .from('invoice_items').select('*').eq('invoice_id', id).order('position'));

  // The scope of work behind it, where there is one. Only the columns the
  // builder's checks read: this is for "has it been signed, and what was it
  // worth", not for re-reading the document.
  let sow = null;
  if (invoice.sow_id) {
    sow = unwrap(await supabase
      .from('sows')
      .select('id, number, revision, status, exported_at, adjusted_fee_cents, deposit_cents, balance_cents')
      .eq('id', invoice.sow_id)
      .maybeSingle());
  }

  return {
    invoice,
    client: invoice.clients || null,
    items: items || [],
    sow,
  };
}

/** What a scope of work has already been billed. Voids excluded — see the
 *  function's comment in schema.sql for why this advises rather than forbids. */
export async function billedAgainstSow(sowId) {
  if (!sowId) return 0;
  const value = unwrap(await supabase.rpc('sow_billed_cents', { p_sow_id: sowId }));
  return Number(value) || 0;
}

/** Every invoice raised against one scope of work, for the panel on the SOW. */
export async function invoicesForSow(sowId) {
  if (!sowId) return [];
  return unwrap(await supabase
    .from('invoices')
    .select('id, number, stage, status, issued_on, due_on, total_cents, paid_cents, issued_at')
    .eq('sow_id', sowId)
    .order('number')) || [];
}

/** Every invoice for one client, for the two panels on the client record: the
 *  ledger, and the paperwork trail — which needs paid_at, because "Paid" with a
 *  date on it is the answer and "Paid" on its own is only half of one. */
export async function invoicesForClient(clientId) {
  if (!clientId) return [];
  return unwrap(await supabase
    .from('invoices')
    .select('id, number, stage, status, issued_on, due_on, total_cents, paid_cents, paid_at, sow_label, project_name')
    .eq('client_id', clientId)
    .order('number', { ascending: false })) || [];
}

/** Raise one from a frozen scope of work. The RPC is what decides whether the
 *  SOW is in a state that can be billed. */
export async function createInvoiceFromSow({ sowId, stage, issuedOn = null, dueOn = null }) {
  return unwrap(await supabase.rpc('create_invoice_from_sow', {
    p_sow_id: sowId,
    p_stage: stage,
    p_issued_on: issuedOn,
    p_due_on: dueOn,
  }));
}

/** One that did not come from a scope of work: out-of-scope hours, an ad-hoc
 *  job, a Support Plan year. Inserted directly, because there is no document to
 *  copy figures out of and therefore nothing for an RPC to keep consistent. */
export async function createBlankInvoice({
  clientId, projectId = null, issuedOn, dueOn, taxRateBp = 0,
}) {
  const rows = unwrap(await supabase
    .from('invoices').select('number').order('number', { ascending: false }).limit(1));
  const highest = Array.isArray(rows) ? rows[0] : rows;
  const number = (highest && Number(highest.number) ? Number(highest.number) : 0) + 1;

  const row = unwrap(await supabase.from('invoices').insert({
    client_id: clientId,
    project_id: projectId,
    number,
    stage: 'other',
    issued_on: issuedOn || null,
    due_on: dueOn || null,
    // The standing rate travels with the invoice, exactly as create_invoice_from_sow
    // does it — so a rate change next April cannot restate a document already sent.
    // No line is taxable yet, so it charges nothing until one is ticked.
    tax_rate_bp: taxRateBp || 0,
  }).select('id').single());

  return row.id;
}

export async function saveInvoice({ id, invoice, items }) {
  return unwrap(await supabase.rpc('save_invoice', {
    p_id: id,
    p_invoice: invoice,
    p_items: items,
  }));
}

export async function issueInvoice({ id, snapshot, hash }) {
  return unwrap(await supabase.rpc('issue_invoice', {
    p_id: id,
    p_snapshot: snapshot,
    p_hash: hash,
  }));
}

export async function deleteInvoice(id) {
  unwrap(await supabase.from('invoices').delete().eq('id', id));
}

/**
 * Move an invoice's status by hand, and record the payment when it is marked
 * paid. Those two belong together: an invoice marked Paid with no paid_at is a
 * row that cannot answer "when did the money arrive", which is the question the
 * status was set to answer.
 */
export async function setStatus(id, status, { paidCents = null, paidOn = null } = {}) {
  const patch = { status };

  if (status === 'paid') {
    patch.paid_at = paidOn ? `${String(paidOn).slice(0, 10)}T12:00:00Z` : new Date().toISOString();
    if (paidCents !== null) patch.paid_cents = paidCents;
  }

  unwrap(await supabase.from('invoices').update(patch).eq('id', id));
}

export async function loadClients() {
  return unwrap(await supabase.from('clients').select(CLIENT_COLUMNS).order('name')) || [];
}

export async function loadProjects(clientId) {
  if (!clientId) return [];
  return unwrap(await supabase
    .from('projects').select('id, name')
    .eq('client_id', clientId)
    .order('created_at', { ascending: false })) || [];
}

/** The frozen scopes of work a client has, for the "bill against" picker. */
export async function billableSows(clientId) {
  if (!clientId) return [];
  return unwrap(await supabase
    .from('sows')
    .select('id, number, revision, status, project_name, adjusted_fee_cents, deposit_cents, balance_cents')
    .eq('client_id', clientId)
    .not('exported_at', 'is', null)
    .neq('status', 'void')
    .order('number', { ascending: false })) || [];
}
