// ---------------------------------------------------------------------------
// Every query the Expenses page makes.
//
// Kept apart from the screen for the same reason invoice-data.js is: the
// screen is about its own behaviour, and the shape of what comes back off the
// wire is stated once. Every column named here exists in supabase/schema.sql;
// a select naming a missing column is a PostgREST 400 that blanks the page.
//
// Tables owned here: expenses, expense_receipts, vendors, recurring_expenses,
// and reads of expense_categories. The client record's Expenses panel and the
// invoice editor's "Add unbilled expenses" keep their own small loaders rather
// than importing this file, by agreement.
// ---------------------------------------------------------------------------

import { supabase, errorMessage } from './client.js';
import { RECEIPTS_BUCKET } from './config.js';
import { isoToday } from './doc-common.js';
import {
  MAX_UPLOAD_BYTES, isMissingObject, makeThumbnail, safeName, shrinkImage,
} from './files.js';
import {
  DEFAULT_NEC_THRESHOLD_CENTS, matchVendor, receiptMime, recurringSpentOn,
} from './expenses-model.js';

function unwrap(result) {
  if (result.error) throw new Error(errorMessage(result.error));
  return result.data;
}

function bucket() {
  return supabase.storage.from(RECEIPTS_BUCKET);
}

// Categories
// ---------------------------------------------------------------------------

export const CATEGORY_COLUMNS = `
  id, code, name, schedule_c_line, description, needs_substantiation,
  needs_attendees, half_deductible, position, archived_at
`;

/** The categories in the owner's order. Archived ones are left out unless
 *  asked for: an old expense still needs to name the category it was booked
 *  to, even after that category was retired. */
export async function loadCategories({ includeArchived = false } = {}) {
  let query = supabase
    .from('expense_categories')
    .select(CATEGORY_COLUMNS)
    .order('position')
    .order('name');
  if (!includeArchived) query = query.is('archived_at', null);
  return unwrap(await query) || [];
}

// Vendors
// ---------------------------------------------------------------------------

export const VENDOR_COLUMNS = `
  id, name, email, phone, website, address, files_1099, tax_id_on_file,
  default_category_id, notes, archived_at, created_at
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

/** Archive rather than delete: expenses keep pointing at the vendor, and the
 *  1099 report for a past year still needs its name. */
export async function archiveVendor(id) {
  unwrap(await supabase.from('vendors').update({ archived_at: new Date().toISOString() }).eq('id', id));
}

export async function restoreVendor(id) {
  unwrap(await supabase.from('vendors').update({ archived_at: null }).eq('id', id));
}

/**
 * The vendor a typed name means, adding one where the name is new.
 *
 * Auto-creating is what fills the vendor table: recording an expense is what
 * populates it, so the second Adobe charge is a date and an amount. The match
 * is on lower(name), the same view the unique index in schema.sql takes, and
 * it includes archived vendors — a name that has been retired comes back into
 * use rather than colliding with the index.
 *
 * Nothing here can fail the expense. A name that lost a race with the unique
 * index, or a write refused outright, falls back to vendor_name — the column
 * that exists so that adding a vendor record is a choice rather than a toll
 * gate on recording a receipt.
 *
 * Resolves { vendor_id, vendor_name, created }. Pass `vendors` when the caller
 * already holds the list, to save a round trip.
 */
export async function resolveVendor(typedName, { vendors = null, defaultCategoryId = null } = {}) {
  const typed = String(typedName || '').trim();
  if (!typed) return { vendor_id: null, vendor_name: null, created: false };

  const known = vendors || await loadVendors({ includeArchived: true });
  const existing = matchVendor(known, typed);
  if (existing) {
    const patch = {};
    if (existing.archived_at) patch.archived_at = null;
    // A vendor added from the Vendors panel usually has no category on it.
    // Filling that blank from the first expense booked against it is what
    // makes the next one fill itself. Never overwrites a chosen category.
    if (!existing.default_category_id && defaultCategoryId) {
      patch.default_category_id = defaultCategoryId;
    }
    if (Object.keys(patch).length) {
      try {
        await saveVendor(existing.id, patch);
      } catch {
        // A category that did not stick costs one select next time.
      }
    }
    return { vendor_id: existing.id, vendor_name: null, created: false };
  }

  try {
    const id = await saveVendor(null, { name: typed, default_category_id: defaultCategoryId || null });
    return { vendor_id: id, vendor_name: null, created: true };
  } catch {
    // Most likely a race with the unique index — another tab saved the same
    // name a moment ago. Look once more before giving up on the link.
    try {
      const again = matchVendor(await loadVendors({ includeArchived: true }), typed);
      if (again) return { vendor_id: again.id, vendor_name: null, created: false };
    } catch {
      // Fall through to the free-text column.
    }
    return { vendor_id: null, vendor_name: typed, created: false };
  }
}

// Expenses
// ---------------------------------------------------------------------------

/**
 * Every column of `expenses`, plus the four embeds a row is shown with. The
 * constraint name in the creator embed must match schema.sql exactly
 * (`created_by uuid references profiles (id)` → expenses_created_by_fkey).
 */
export const EXPENSE_COLUMNS = `
  id, spent_on, vendor_id, vendor_name, category_id, amount_cents, description,
  method, reference, client_id, billable, billed_invoice_id,
  place, business_purpose, attendees, created_by, created_at, updated_at,
  category:expense_categories(id, code, name, schedule_c_line,
                              needs_substantiation, needs_attendees, half_deductible),
  vendor:vendors(id, name, files_1099),
  client:clients(id, name),
  creator:profiles!expenses_created_by_fkey(full_name)
`;

export const RECEIPT_COLUMNS = `
  id, expense_id, storage_path, thumb_path, name, size_bytes, mime_type,
  captured_on, position, uploaded_by, created_at
`;

/**
 * Expenses newest first, with their receipts along for the count and the
 * gallery. `year` is the usual bound; `from`/`to` override it for a report
 * that wants an exact window. A calendar year of a one-person business is a
 * few hundred rows, so no paging.
 */
export async function loadExpenses({
  year = null, from = null, to = null, clientId = null, categoryId = null, vendorId = null,
  limit = 2000,
} = {}) {
  let query = supabase
    .from('expenses')
    .select(`${EXPENSE_COLUMNS}, receipts:expense_receipts(${RECEIPT_COLUMNS})`)
    .order('spent_on', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(limit);

  const start = from || (year ? `${year}-01-01` : null);
  const end = to || (year ? `${year}-12-31` : null);
  if (start) query = query.gte('spent_on', start);
  if (end) query = query.lte('spent_on', end);
  if (clientId) query = query.eq('client_id', clientId);
  if (categoryId) query = query.eq('category_id', categoryId);
  if (vendorId) query = query.eq('vendor_id', vendorId);

  return unwrap(await query) || [];
}

/** The year of the oldest expense on record, for the year filter. Null on an
 *  empty table. */
export async function loadEarliestYear() {
  const row = unwrap(await supabase
    .from('expenses')
    .select('spent_on')
    .order('spent_on', { ascending: true })
    .limit(1)
    .maybeSingle());
  const year = row ? Number(String(row.spent_on).slice(0, 4)) : 0;
  return year > 0 ? year : null;
}

export async function saveExpense(id, patch) {
  if (id) {
    unwrap(await supabase.from('expenses').update(patch).eq('id', id));
    return id;
  }
  const row = unwrap(await supabase.from('expenses').insert(patch).select('id').single());
  return row.id;
}

/**
 * Every object under <expense_id>/ in the bucket, gone.
 *
 * The receipt rows cascade when the expense goes; the objects do not, and an
 * orphaned photograph in a private bucket is storage nobody can find again.
 * Both sources are read — the rows, and a listing of the folder — so a thumb
 * whose row lost its path is still swept. A missing object is not an error:
 * the point is that it is gone. Anything else is, and the expense row stays
 * so the person can try again rather than leave the objects behind.
 */
async function removeReceiptObjects(expenseId) {
  const paths = new Set();

  (await loadReceipts(expenseId)).forEach((receipt) => {
    if (receipt.storage_path) paths.add(receipt.storage_path);
    if (receipt.thumb_path) paths.add(receipt.thumb_path);
  });

  const listed = await bucket().list(expenseId, { limit: 1000 });
  if (!listed.error) {
    (listed.data || []).forEach((object) => {
      if (object && object.name) paths.add(`${expenseId}/${object.name}`);
    });
  }

  if (!paths.size) return;
  const { error } = await bucket().remove(Array.from(paths));
  if (error && !isMissingObject(error)) throw new Error(errorMessage(error));
}

/** Objects first, then the row. See removeReceiptObjects for why. */
export async function deleteExpense(id) {
  await removeReceiptObjects(id);
  unwrap(await supabase.from('expenses').delete().eq('id', id));
}

// Receipts
// ---------------------------------------------------------------------------

export async function loadReceipts(expenseId) {
  return unwrap(await supabase
    .from('expense_receipts')
    .select(RECEIPT_COLUMNS)
    .eq('expense_id', expenseId)
    .order('position')
    .order('created_at')) || [];
}

/** The day a photograph was taken, off the file's own clock. */
function capturedOn(file) {
  if (!file || !file.lastModified) return null;
  const shot = new Date(file.lastModified);
  return Number.isNaN(shot.getTime()) ? null : isoToday(shot);
}

/**
 * Shrink and file one receipt against an expense.
 *
 * Every image is shrunk before it leaves the browser: a phone photograph is
 * 4–8 MB and a legible receipt is about 300 KB. A small thumbnail goes up
 * alongside it so the gallery does not have to download the full-size one to
 * show a postage stamp. A PDF goes up untouched.
 *
 * The object lands at <expense_id>/<uuid>-<safeName> (+ -thumb.jpg). Its
 * contentType comes from the bucket's allow-list, by declared type or by
 * extension, never octet-stream. The row is inserted last, and an insert that
 * fails takes the object back out with it, so the bucket and the table cannot
 * disagree about what is on file.
 *
 * Resolves the new expense_receipts row.
 */
export async function addReceipt(expenseId, file, { position = 0, uploadedBy = null } = {}) {
  if (!file) throw new Error('No file was chosen.');

  const declared = receiptMime(file);
  if (!declared) {
    throw new Error(`${file.name} is not a photo or a PDF, which is all a receipt can be.`);
  }
  if (file.size > MAX_UPLOAD_BYTES * 4) {
    throw new Error(`${file.name} is too large to shrink here. Photograph it again at a lower resolution.`);
  }

  const { file: shrunk } = await shrinkImage(file);
  const thumb = await makeThumbnail(shrunk);

  if (shrunk.size > MAX_UPLOAD_BYTES) {
    throw new Error(`${file.name} is still too large after shrinking. The limit is 25 MB.`);
  }

  // A re-encoded image is a JPEG whatever it started as; the original's type
  // is only right when the file went up untouched.
  const contentType = receiptMime(shrunk) || declared;
  const stem = `${expenseId}/${crypto.randomUUID()}`;
  const path = `${stem}-${safeName(shrunk.name || file.name)}`;

  const upload = await bucket().upload(path, shrunk, { contentType, upsert: false });
  if (upload.error) throw new Error(errorMessage(upload.error));

  let thumbPath = null;
  if (thumb) {
    thumbPath = `${stem}-thumb.jpg`;
    // A missing thumbnail is cosmetic; a failure here must not lose the
    // receipt that already uploaded.
    const thumbUpload = await bucket().upload(thumbPath, thumb, { contentType: 'image/jpeg' });
    if (thumbUpload.error) thumbPath = null;
  }

  const inserted = await supabase
    .from('expense_receipts')
    .insert({
      expense_id: expenseId,
      storage_path: path,
      thumb_path: thumbPath,
      name: file.name,
      size_bytes: shrunk.size,
      mime_type: contentType,
      captured_on: capturedOn(file),
      position,
      uploaded_by: uploadedBy,
    })
    .select(RECEIPT_COLUMNS)
    .single();

  if (inserted.error) {
    try {
      await bucket().remove([path, thumbPath].filter(Boolean));
    } catch {
      // The row is what the portal reads; an object nobody points at is the
      // lesser problem, and deleteExpense's folder sweep catches it later.
    }
    throw new Error(errorMessage(inserted.error));
  }

  return inserted.data;
}

/** Objects first, then the row. A row can outlive its object — the storage
 *  side saying "not found" is tolerated, because gone is the goal. */
export async function deleteReceipt(receipt) {
  const paths = [receipt.storage_path, receipt.thumb_path].filter(Boolean);
  if (paths.length) {
    const { error } = await bucket().remove(paths);
    if (error && !isMissingObject(error)) throw new Error(errorMessage(error));
  }
  unwrap(await supabase.from('expense_receipts').delete().eq('id', receipt.id));
}

/** A short-lived signed URL, the same way every other private file in the
 *  portal is read. The bucket is never public. */
export async function receiptUrl(path, seconds = 300) {
  const { data, error } = await bucket().createSignedUrl(path, seconds);
  if (error) throw new Error(errorMessage(error));
  return data.signedUrl;
}

// Subscriptions
// ---------------------------------------------------------------------------

export const RECURRING_COLUMNS = `
  id, name, vendor_id, vendor_name, category_id, amount_cents, method,
  day_of_month, client_id, billable, active, last_recorded_on, created_by, created_at,
  category:expense_categories(id, code, name, schedule_c_line),
  vendor:vendors(id, name),
  client:clients(id, name)
`;

export async function loadRecurring() {
  return unwrap(await supabase
    .from('recurring_expenses')
    .select(RECURRING_COLUMNS)
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

/**
 * Record one month of a template as an ordinary expense, dated the day the
 * charge lands in that month (clamped, so "the 31st" bills February on its
 * last day), then move last_recorded_on forward. One month per call, on
 * purpose: a lapse backfills as a visible walk rather than a silent burst.
 *
 * Resolves the new expense's id.
 */
export async function recordRecurring(template, forDateIso, { createdBy = null } = {}) {
  const spentOn = recurringSpentOn(template, forDateIso);

  const id = await saveExpense(null, {
    spent_on: spentOn,
    vendor_id: template.vendor_id || null,
    vendor_name: template.vendor_id ? null : (template.vendor_name || null),
    category_id: template.category_id,
    amount_cents: template.amount_cents,
    description: template.name,
    method: template.method || 'card',
    client_id: template.client_id || null,
    billable: Boolean(template.billable) && Boolean(template.client_id),
    created_by: createdBy,
  });

  await saveRecurring(template.id, { last_recorded_on: spentOn });
  return id;
}

// Shared lookups
// ---------------------------------------------------------------------------

export async function loadClients() {
  return unwrap(await supabase.from('clients').select('id, name').order('name')) || [];
}

/** The 1099-NEC threshold the owner set in Admin, in cents. Reads one column
 *  of the studio_settings singleton; the default stands in for a missing row. */
export async function loadNecThreshold() {
  const row = unwrap(await supabase
    .from('studio_settings')
    .select('nec_threshold_cents')
    .eq('id', true)
    .maybeSingle());
  const cents = row ? Number(row.nec_threshold_cents) : 0;
  return cents > 0 ? cents : DEFAULT_NEC_THRESHOLD_CENTS;
}
