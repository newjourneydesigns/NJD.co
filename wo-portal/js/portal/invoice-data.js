// ---------------------------------------------------------------------------
// Every query the invoice screens make.
//
// Kept apart from the two screens so the shape of what comes back off the
// wire is stated once. The writes that have to be all-or-nothing go through
// the RPCs in supabase/schema.sql: create_invoice decides the number, the
// terms and the tax rate; save_invoice rewrites the lines with the header;
// issue_invoice freezes the document; duplicate_invoice copies one.
//
// Column names are the law of supabase/schema.sql. A select that names a
// column that is not there is a PostgREST 400 that blanks the page, so every
// list below is checked against that file rather than remembered.
// ---------------------------------------------------------------------------

import { supabase, errorMessage } from './client.js';
import { filterInvoices } from './invoice-catalog.js';

/** The client as the document needs it: the "Billed to" block, the rate a
 *  "Bill hours" line is priced at, and the terms the due date came from. */
export const CLIENT_COLUMNS = `
  id, name, legal_name, contact_name, contact_email, contact_phone,
  address_line1, address_line2, city, region, postal_code, country,
  hourly_rate_cents, net_days, status
`;

/**
 * Every column of `invoices` except `snapshot`, plus the client embed. The
 * snapshot is the whole frozen document as JSON and belongs to one screen,
 * so loadInvoice() asks for it by name and the list never carries it.
 */
export const INVOICE_COLUMNS = `
  id, client_id, number, status,
  issued_on, due_on, net_days,
  project_name, purchase_order, summary, notes,
  subtotal_cents, tax_rate_bp, tax_cents, paid_cents, total_cents, currency,
  paid_at, issued_at, snapshot_hash,
  created_by, created_at, updated_at,
  client:clients(${CLIENT_COLUMNS})
`;

function unwrap(result) {
  if (result.error) throw new Error(errorMessage(result.error));
  return result.data;
}

// Singletons
// ---------------------------------------------------------------------------

/** The business's own details: the letterhead and the standard hourly rate. */
export async function loadStudio() {
  return unwrap(await supabase.from('studio_settings').select('*').eq('id', true).maybeSingle());
}

/** How invoices are worded: how to pay, the late note, the tax defaults. */
export async function loadInvoiceSettings() {
  return unwrap(await supabase.from('invoice_settings').select('*').eq('id', true).maybeSingle());
}

/** The clients an invoice can be addressed to, for the pickers. */
export async function loadClients() {
  return unwrap(await supabase
    .from('clients')
    .select('id, name, legal_name, net_days, hourly_rate_cents, status')
    .order('name')) || [];
}

// Reading invoices
// ---------------------------------------------------------------------------

/**
 * The list: newest first, with the client name. Status and client narrow the
 * query; the search runs over the rows that come back, because the client
 * name lives in an embed PostgREST cannot filter on with `ilike`, and one
 * rule in invoice-catalog.js is better than one and a half.
 */
export async function loadInvoices({ status = '', clientId = '', search = '' } = {}) {
  let query = supabase
    .from('invoices')
    .select(INVOICE_COLUMNS)
    // Newest first by creation, not by number: the number is text, and
    // '20260901-10' sorts before '20260901-2' as a string.
    .order('created_at', { ascending: false });

  if (status) query = query.eq('status', status);
  if (clientId) query = query.eq('client_id', clientId);

  const rows = unwrap(await query) || [];
  return search ? filterInvoices(rows, { search }) : rows;
}

/** One invoice, its client and its lines in order. Null when it is gone. */
export async function loadInvoice(id) {
  const invoice = unwrap(await supabase
    .from('invoices')
    .select(`${INVOICE_COLUMNS}, snapshot`)
    .eq('id', id)
    .maybeSingle());

  if (!invoice) return null;

  const items = unwrap(await supabase
    .from('invoice_items')
    .select('id, invoice_id, name, description, quantity, unit_cents, amount_cents, taxable, position')
    .eq('invoice_id', id)
    .order('position'));

  return {
    invoice,
    client: invoice.client || null,
    items: items || [],
  };
}

/** Every invoice for one client, for the panel on the client record. */
export async function invoicesForClient(clientId) {
  if (!clientId) return [];
  return unwrap(await supabase
    .from('invoices')
    .select('id, client_id, number, status, issued_on, due_on, total_cents, paid_cents, paid_at, issued_at, project_name')
    .eq('client_id', clientId)
    .order('created_at', { ascending: false })) || [];
}

// Writing invoices
// ---------------------------------------------------------------------------

/** Raise a blank draft. The database decides the number, copies the terms and
 *  the tax rate as they stand today, and returns the new id. */
export async function createInvoice(clientId, issuedOn = null) {
  const args = { p_client_id: clientId };
  if (issuedOn) args.p_issued_on = String(issuedOn).slice(0, 10);
  return unwrap(await supabase.rpc('create_invoice', args));
}

/** Copy an invoice into a new draft with today's number. */
export async function duplicateInvoice(id) {
  return unwrap(await supabase.rpc('duplicate_invoice', { p_id: id }));
}

/** The header and every line, as one statement. */
export async function saveInvoice({ id, invoice, items }) {
  return unwrap(await supabase.rpc('save_invoice', {
    p_id: id,
    p_invoice: invoice,
    p_items: items,
  }));
}

/** Freeze it. Returns the issued_at timestamp the database stamped. */
export async function issueInvoice({ id, snapshot, hash }) {
  return unwrap(await supabase.rpc('issue_invoice', {
    p_id: id,
    p_snapshot: snapshot,
    p_hash: hash,
  }));
}

/**
 * The two statuses a person sets by hand. Anything else is refused here,
 * before it reaches a database that would refuse it too: 'paid' follows the
 * payments, and 'issued' follows issuing.
 */
export async function setStatus(id, status) {
  if (!['sent', 'void'].includes(status)) {
    throw new Error('Only "sent" and "void" are set by hand. Paid follows the payments.');
  }
  unwrap(await supabase.from('invoices').update({ status }).eq('id', id));
}

/**
 * Delete a draft. The `issued_at is null` clause is the belt to the screens'
 * braces: an issued invoice is a business record, and a request that slips
 * past the buttons deletes nothing rather than something.
 */
export async function deleteInvoice(id) {
  const rows = unwrap(await supabase
    .from('invoices')
    .delete()
    .eq('id', id)
    .is('issued_at', null)
    .select('id'));

  if (!rows || !rows.length) {
    throw new Error('Only a draft can be deleted. An issued invoice is voided instead.');
  }
}

// Payments
// ---------------------------------------------------------------------------

/** What has been recorded against one invoice, latest first. */
export async function paymentsForInvoice(invoiceId) {
  if (!invoiceId) return [];
  return unwrap(await supabase
    .from('payments')
    .select('id, invoice_id, client_id, received_on, amount_cents, method, reference, notes, created_at')
    .eq('invoice_id', invoiceId)
    .order('received_on', { ascending: false })
    .order('created_at', { ascending: false })) || [];
}

/**
 * Money in. client_id is deliberately not sent: the trigger copies it from
 * the invoice, refuses a draft, and recomputes the invoice's paid_cents,
 * paid_at and status. Never write those three from here.
 */
export async function recordPayment({
  invoice_id: invoiceId, received_on: receivedOn, amount_cents: amountCents,
  method, reference = null, notes = null,
}) {
  unwrap(await supabase.from('payments').insert({
    invoice_id: invoiceId,
    received_on: receivedOn,
    amount_cents: amountCents,
    method,
    reference: reference || null,
    notes: notes || null,
  }));
}

export async function deletePayment(id) {
  unwrap(await supabase.from('payments').delete().eq('id', id));
}

// Expenses billed back to a client
// ---------------------------------------------------------------------------
//
// The expenses table belongs to the Expenses page; this is the one small read
// and the one small write the invoice editor needs from it. Columns read:
// id, spent_on, vendor_id, vendor_name, category_id, amount_cents,
// description, client_id, billable, billed_invoice_id, plus the names off
// expense_categories and vendors. Column written: billed_invoice_id.

/** The costs marked billable to this client that no invoice has picked up. */
export async function unbilledExpenses(clientId) {
  if (!clientId) return [];
  return unwrap(await supabase
    .from('expenses')
    .select(`
      id, spent_on, vendor_id, vendor_name, category_id, amount_cents,
      description, client_id, billable, billed_invoice_id,
      category:expense_categories(name),
      vendor:vendors(name)
    `)
    .eq('client_id', clientId)
    .eq('billable', true)
    .is('billed_invoice_id', null)
    .order('spent_on')) || [];
}

/** Stamp the invoice on the expenses whose lines it now carries, so none of
 *  them can be passed on twice. Called only after the save that added the
 *  lines has succeeded. */
export async function markExpensesBilled(expenseIds, invoiceId) {
  const ids = (expenseIds || []).filter(Boolean);
  if (!ids.length) return;
  unwrap(await supabase
    .from('expenses')
    .update({ billed_invoice_id: invoiceId })
    .in('id', ids));
}
