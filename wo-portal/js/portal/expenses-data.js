// ---------------------------------------------------------------------------
// Every query the ledger makes.
//
// Kept apart from the six screens for the same reason sow-data.js and
// invoice-data.js are: the screens are about their own behaviour, and the shape
// of what comes back off the wire is stated once. The writes that have to be
// all-or-nothing — a journal entry and its lines — go through the RPCs in
// supabase/schema.sql, because the balance check is deferred to the end of the
// transaction and two requests are two transactions.
// ---------------------------------------------------------------------------

import { supabase, errorMessage } from './client.js';

export const ACCOUNT_COLUMNS = `
  id, code, name, type, subtype, description, system_key, archived_at,
  needs_substantiation
`;

export const LINE_COLUMNS = `
  id, entry_id, account_id, debit_cents, credit_cents, description,
  client_id, project_id, position, cleared_on, reconciliation_id
`;

function unwrap(result) {
  if (result.error) throw new Error(errorMessage(result.error));
  return result.data;
}

// The chart, and how the books are kept
// ---------------------------------------------------------------------------

export async function loadAccounts({ includeArchived = true } = {}) {
  let query = supabase.from('ledger_accounts').select(ACCOUNT_COLUMNS).order('code');
  if (!includeArchived) query = query.is('archived_at', null);
  return unwrap(await query) || [];
}

export async function createAccount(patch) {
  return unwrap(await supabase.from('ledger_accounts').insert(patch).select('id').single());
}

export async function updateAccount(id, patch) {
  unwrap(await supabase.from('ledger_accounts').update(patch).eq('id', id));
}

export async function loadSettings() {
  return unwrap(await supabase.from('ledger_settings').select('*').limit(1).maybeSingle());
}

export async function saveSettings(patch) {
  unwrap(await supabase.from('ledger_settings').update(patch).eq('id', true));
}

// The journal
// ---------------------------------------------------------------------------

/**
 * Entries with their lines, newest first.
 *
 * Bounded by date rather than by a page count: a ledger grows forever, and
 * "this quarter" is both a smaller query and the question actually being asked.
 */
export async function loadEntries({ from = null, to = null, limit = 500 } = {}) {
  let query = supabase
    .from('ledger_entries')
    .select(`
      id, entry_date, memo, reference, source, source_id, reverses_id, created_at,
      ledger_lines(${LINE_COLUMNS}, ledger_accounts(id, code, name, type, subtype),
                   clients(name))
    `)
    .order('entry_date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(limit);

  if (from) query = query.gte('entry_date', from);
  if (to) query = query.lte('entry_date', to);

  return unwrap(await query) || [];
}

export async function loadEntry(id) {
  return unwrap(await supabase
    .from('ledger_entries')
    .select(`
      id, entry_date, memo, reference, source, source_id, reverses_id,
      ledger_lines(${LINE_COLUMNS}, ledger_accounts(id, code, name, type, subtype))
    `)
    .eq('id', id)
    .maybeSingle());
}

/** One account's transactions, which is what a register is. */
export async function loadRegister(accountId, { from = null, to = null } = {}) {
  let query = supabase
    .from('ledger_lines')
    .select(`
      ${LINE_COLUMNS},
      ledger_entries!inner(id, entry_date, memo, reference, source, reverses_id),
      clients(name)
    `)
    .eq('account_id', accountId)
    .order('entry_date', { referencedTable: 'ledger_entries', ascending: true });

  if (from) query = query.gte('ledger_entries.entry_date', from);
  if (to) query = query.lte('ledger_entries.entry_date', to);

  return unwrap(await query) || [];
}

export async function saveEntry({ id = null, entry, lines }) {
  return unwrap(await supabase.rpc('save_journal_entry', {
    p_id: id,
    p_entry: entry,
    p_lines: lines,
  }));
}

export async function deleteEntry(id) {
  unwrap(await supabase.from('ledger_entries').delete().eq('id', id));
}

// Reports
// ---------------------------------------------------------------------------

/** Every account with what moved through it in a window. Null bounds mean
 *  "since the books opened" and "up to now". */
export async function loadBalances({ from = null, to = null } = {}) {
  return unwrap(await supabase.rpc('ledger_balances', { p_from: from, p_to: to })) || [];
}

/** Revenue as the money actually arrived, for the cash-basis view. */
export async function loadCashIncome({ from = null, to = null } = {}) {
  return unwrap(await supabase.rpc('ledger_cash_income', { p_from: from, p_to: to })) || [];
}

/** Income and expense lines with their client, for "what was this one worth". */
export async function loadClientLines({ from = null, to = null } = {}) {
  let query = supabase
    .from('ledger_lines')
    .select(`
      debit_cents, credit_cents, client_id,
      ledger_accounts!inner(type),
      ledger_entries!inner(entry_date),
      clients(name)
    `)
    .in('ledger_accounts.type', ['income', 'expense']);

  if (from) query = query.gte('ledger_entries.entry_date', from);
  if (to) query = query.lte('ledger_entries.entry_date', to);

  return unwrap(await query) || [];
}

/** Every invoice that could still be owed, for the ageing report. */
export async function loadOpenInvoices() {
  return unwrap(await supabase
    .from('invoices')
    .select(`id, client_id, number, status, issued_on, due_on,
             total_cents, paid_cents, project_name, sow_label, clients(name, legal_name)`)
    .not('status', 'in', '(draft,void)')
    .order('due_on')) || [];
}

// Payments
// ---------------------------------------------------------------------------

export const PAYMENT_COLUMNS = `
  id, invoice_id, client_id, received_on, amount_cents, method,
  deposit_account_id, reference, notes, created_at
`;

export async function paymentsForInvoice(invoiceId) {
  if (!invoiceId) return [];
  return unwrap(await supabase
    .from('payments')
    .select(`${PAYMENT_COLUMNS}, ledger_accounts(code, name)`)
    .eq('invoice_id', invoiceId)
    .order('received_on')) || [];
}

export async function loadPayments({ from = null, to = null, limit = 300 } = {}) {
  let query = supabase
    .from('payments')
    .select(`${PAYMENT_COLUMNS}, clients(name), invoices(number),
             ledger_accounts(code, name)`)
    .order('received_on', { ascending: false })
    .limit(limit);

  if (from) query = query.gte('received_on', from);
  if (to) query = query.lte('received_on', to);

  return unwrap(await query) || [];
}

/** Recording one is a plain insert: the trigger in schema.sql is what posts it
 *  to the ledger and moves the invoice's own columns. */
export async function recordPayment(patch) {
  return unwrap(await supabase.from('payments').insert(patch).select('id').single());
}

export async function deletePayment(id) {
  unwrap(await supabase.from('payments').delete().eq('id', id));
}

// Vendors and expenses
// ---------------------------------------------------------------------------

export const VENDOR_COLUMNS = `
  id, name, email, phone, website, address, files_1099, tax_id_on_file,
  default_account_id, notes, archived_at
`;

export async function loadVendors({ includeArchived = false } = {}) {
  let query = supabase.from('vendors').select(VENDOR_COLUMNS).order('name');
  if (!includeArchived) query = query.is('archived_at', null);
  return unwrap(await query) || [];
}

export async function saveVendor(id, patch) {
  if (id) {
    unwrap(await supabase.from('vendors').update(patch).eq('id', id));
    return id;
  }
  const row = unwrap(await supabase.from('vendors').insert(patch).select('id').single());
  return row.id;
}

export const EXPENSE_COLUMNS = `
  id, spent_on, vendor_id, vendor_name, account_id, paid_from_account_id,
  amount_cents, description, method, reference,
  client_id, project_id, billable, billed_invoice_id,
  place, business_purpose, attendees, miles, created_by, created_at
`;

export const RECEIPT_COLUMNS = `
  id, expense_id, storage_path, thumb_path, name, size_bytes, mime_type,
  captured_on, position, created_at
`;

export async function loadExpenses({ from = null, to = null, limit = 500 } = {}) {
  let query = supabase
    .from('expenses')
    .select(`${EXPENSE_COLUMNS}, vendors(name), clients(name),
             account:ledger_accounts!expenses_account_id_fkey(code, name, needs_substantiation),
             paid_from:ledger_accounts!expenses_paid_from_account_id_fkey(code, name),
             creator:profiles!expenses_created_by_fkey(full_name, email),
             expense_receipts(${RECEIPT_COLUMNS})`)
    .order('spent_on', { ascending: false })
    .limit(limit);

  if (from) query = query.gte('spent_on', from);
  if (to) query = query.lte('spent_on', to);

  return unwrap(await query) || [];
}

export async function saveExpense(id, patch) {
  if (id) {
    unwrap(await supabase.from('expenses').update(patch).eq('id', id));
    return id;
  }
  const row = unwrap(await supabase.from('expenses').insert(patch).select('id').single());
  return row.id;
}

export async function deleteExpense(id) {
  unwrap(await supabase.from('expenses').delete().eq('id', id));
}

// Recurring expenses
// ---------------------------------------------------------------------------

export const RECURRING_COLUMNS = `
  id, name, vendor_id, vendor_name, account_id, paid_from_account_id,
  amount_cents, method, day_of_month, client_id, billable, active,
  last_recorded_on, created_at
`;

export async function loadRecurring() {
  return unwrap(await supabase
    .from('recurring_expenses')
    .select(`${RECURRING_COLUMNS}, vendors(name), clients(name)`)
    .order('name')) || [];
}

export async function saveRecurring(id, patch) {
  if (id) {
    unwrap(await supabase.from('recurring_expenses').update(patch).eq('id', id));
    return id;
  }
  const row = unwrap(await supabase
    .from('recurring_expenses').insert(patch).select('id').single());
  return row.id;
}

export async function deleteRecurring(id) {
  unwrap(await supabase.from('recurring_expenses').delete().eq('id', id));
}

// Receipts
// ---------------------------------------------------------------------------

export async function addReceipt(patch) {
  return unwrap(await supabase
    .from('expense_receipts').insert(patch).select(RECEIPT_COLUMNS).single());
}

export async function deleteReceipt(id) {
  unwrap(await supabase.from('expense_receipts').delete().eq('id', id));
}

/** Every receipt in a window, for the year-end pack's completeness check and
 *  for "find me that lunch in March". */
export async function loadReceipts({ from = null, to = null } = {}) {
  let query = supabase
    .from('expense_receipts')
    .select(`${RECEIPT_COLUMNS}, expenses!inner(spent_on, description, amount_cents)`)
    .order('created_at', { ascending: false });

  if (from) query = query.gte('expenses.spent_on', from);
  if (to) query = query.lte('expenses.spent_on', to);

  return unwrap(await query) || [];
}

// The members
// ---------------------------------------------------------------------------

export const OWNER_COLUMNS = `
  profile_id, ownership_bp, legal_name, contributions_account_id,
  draws_account_id, position, ended_on
`;

/** Who owns the studio, with the name a tax document goes to and the two
 *  capital accounts that are theirs. Ordered the way the capital report reads. */
export async function loadOwners({ includeFormer = false } = {}) {
  let query = supabase
    .from('owner_members')
    .select(`${OWNER_COLUMNS}, profiles(full_name, email)`)
    .order('position');
  if (!includeFormer) query = query.is('ended_on', null);
  return unwrap(await query) || [];
}

export async function saveOwner(profileId, patch) {
  unwrap(await supabase.from('owner_members').update(patch).eq('profile_id', profileId));
}

// The drive tracker
// ---------------------------------------------------------------------------

export const DRIVE_COLUMNS = `
  id, started_at, ended_at, arrived_at, start_lat, start_lng, start_accuracy_m,
  end_lat, end_lng, end_accuracy_m, start_label, end_label,
  start_odometer, end_odometer,
  path_miles, miles, rate_cents, purpose, client_id, expense_id,
  created_by, created_at
`;

/**
 * Finished and active drives, newest first.
 *
 * The date bounds are widened a day each way on the wire and applied exactly
 * by the caller against local dates: `started_at` is a moment and the filter
 * is a day, and 11 pm in Texas is tomorrow in UTC. An active drive is always
 * returned — a person must always be able to see, and end, the drive they
 * are on, whatever the filters say.
 *
 * `createdBy` narrows to one person's drives. Every owner drives their own
 * car and claims their own miles, so this is how the log stays one person's
 * log; passing nothing is the deliberate "show me everyone's" case.
 */
export async function loadDrives({
  from = null, to = null, createdBy = null, limit = 1000,
} = {}) {
  let query = supabase
    .from('drives')
    .select(`${DRIVE_COLUMNS}, clients(name),
             driver:profiles!drives_created_by_fkey(full_name, email)`)
    .order('started_at', { ascending: false })
    .limit(limit);

  if (createdBy) query = query.eq('created_by', createdBy);

  if (from) {
    const wide = new Date(`${from}T00:00:00Z`);
    wide.setUTCDate(wide.getUTCDate() - 1);
    query = query.or(`started_at.gte.${wide.toISOString()},ended_at.is.null`);
  }
  if (to) {
    const wide = new Date(`${to}T00:00:00Z`);
    wide.setUTCDate(wide.getUTCDate() + 2);
    query = query.or(`started_at.lt.${wide.toISOString()},ended_at.is.null`);
  }

  return unwrap(await query) || [];
}

const DRIVE_SELECT = `${DRIVE_COLUMNS}, clients(name),
  driver:profiles!drives_created_by_fkey(full_name, email)`;

export async function saveDrive(id, patch) {
  if (id) {
    return unwrap(await supabase
      .from('drives').update(patch).eq('id', id)
      .select(DRIVE_SELECT).single());
  }
  return unwrap(await supabase
    .from('drives').insert(patch)
    .select(DRIVE_SELECT).single());
}

export async function deleteDrive(id) {
  unwrap(await supabase.from('drives').delete().eq('id', id));
}

export async function loadPlaces() {
  return unwrap(await supabase
    .from('saved_places')
    .select('id, label, address, lat, lng')
    .order('label')) || [];
}

export async function savePlace(id, patch) {
  if (id) {
    unwrap(await supabase.from('saved_places').update(patch).eq('id', id));
    return id;
  }
  const row = unwrap(await supabase
    .from('saved_places').insert(patch).select('id').single());
  return row.id;
}

export async function deletePlace(id) {
  unwrap(await supabase.from('saved_places').delete().eq('id', id));
}

// Reconciliation
// ---------------------------------------------------------------------------

export async function loadReconciliations(accountId) {
  let query = supabase
    .from('bank_reconciliations')
    .select('*, ledger_accounts(code, name)')
    .order('statement_on', { ascending: false })
    .limit(24);
  if (accountId) query = query.eq('account_id', accountId);
  return unwrap(await query) || [];
}

export async function startReconciliation(patch) {
  return unwrap(await supabase
    .from('bank_reconciliations').insert(patch).select('*').single());
}

export async function updateReconciliation(id, patch) {
  unwrap(await supabase.from('bank_reconciliations').update(patch).eq('id', id));
}

export async function deleteReconciliation(id) {
  unwrap(await supabase.from('bank_reconciliations').delete().eq('id', id));
}

/**
 * Everything in one account that a statement might cover: still un-ticked, or
 * ticked by this reconciliation.
 *
 * The second half is what makes the screen resumable — reopening a half-done
 * reconciliation has to show the lines it has already claimed, or they would
 * look like they had gone missing.
 */
export async function loadReconcilable(accountId, reconciliationId, { to = null } = {}) {
  let query = supabase
    .from('ledger_lines')
    .select(`
      ${LINE_COLUMNS},
      ledger_entries!inner(id, entry_date, memo, reference, source)
    `)
    .eq('account_id', accountId)
    .order('entry_date', { referencedTable: 'ledger_entries', ascending: true });

  if (to) query = query.lte('ledger_entries.entry_date', to);

  const rows = unwrap(await query) || [];
  return rows.filter((line) => (
    !line.reconciliation_id || line.reconciliation_id === reconciliationId
  ));
}

export async function setCleared(lineId, { clearedOn, reconciliationId }) {
  unwrap(await supabase
    .from('ledger_lines')
    .update({ cleared_on: clearedOn, reconciliation_id: reconciliationId })
    .eq('id', lineId));
}

// Shared lookups
// ---------------------------------------------------------------------------

export async function loadClients() {
  return unwrap(await supabase.from('clients').select('id, name').order('name')) || [];
}

export async function loadProjects() {
  return unwrap(await supabase
    .from('projects').select('id, name, client_id').order('name')) || [];
}
