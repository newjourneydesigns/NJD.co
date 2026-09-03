// ---------------------------------------------------------------------------
// The client add/edit form, shared by the Clients list and the client record.
//
// One form rather than two: a record corrected from the page you read it on
// must be the same record the list adds, or the two screens drift apart a
// field at a time.
//
// Duplicating a client is the same form again, opened empty-handed with an
// existing record poured into it (openClientDuplicateForm below) — a copy you
// read and correct before it exists, rather than a second record created behind
// your back and fixed afterwards.
//
// Resolves to null on cancel, 'deleted' after a delete, or { id, created }
// after a save. Toasts happen here, so the wording exists once; the caller
// only has to re-fetch whatever it is displaying.
// ---------------------------------------------------------------------------

import { supabase, errorMessage } from './client.js';
import { DOCUMENTS_BUCKET } from './config.js';
import { formatMoney, parseMoney } from './money.js';
import { toast, formModal } from './ui.js';

// Where a client sits with the business. Ordered the way a record moves through
// it, not alphabetically. The list's status filter shows the same three.
export const CLIENT_STATUS_OPTIONS = [
  { value: 'lead', label: 'Lead' },
  { value: 'active', label: 'Active' },
  { value: 'past', label: 'Past' },
];

/**
 * People type `acme.com`, so assume https rather than rejecting them — but only
 * after the URL parser has agreed it is a web address. That is what keeps a
 * `javascript:` value out of the column, whether or not this page ever renders
 * it as a link; the record page does.
 *
 * Throws on anything unusable, which formModal shows without closing.
 */
function normalizeWebsite(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;

  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw);
  let url;
  try {
    url = new URL(hasScheme ? raw : `https://${raw}`);
  } catch {
    throw new Error('That website does not look like an address. Try acme.com or https://acme.com.');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('A website has to be an http:// or https:// address.');
  }

  // Drop the slash the parser adds to a bare domain, so re-opening the form
  // shows what was typed rather than a tidied-up variant of it.
  return url.pathname === '/' && !url.search && !url.hash
    ? `${url.protocol}//${url.host}`
    : url.href;
}

/**
 * Payment terms as typed — "15", "Net 30", "" — as a number of days or null.
 *
 * Blank means the standard terms from invoice_settings, and that is the right
 * answer for most clients, so it is not an error. Anything else has to be a
 * whole number of days the database will accept (clients_net_days_range is
 * 0–365); a typo stops the save rather than quietly putting the client back
 * on standard terms.
 */
export function parseNetDays(input) {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) return null;
  const match = /^(?:net\s*)?(\d{1,3})$/i.exec(raw);
  if (!match) throw new Error('Payment terms are a number of days, like 15 or 30. Leave it blank for the standard terms.');
  const days = Number(match[1]);
  if (days > 365) throw new Error('Payment terms cannot be more than 365 days.');
  return days;
}

/**
 * What the delete confirmation says, shared by the form's own Delete button
 * and the Delete action on the record page so the two never disagree.
 *
 * The cascade is worth naming: contacts, notes and every filed document go
 * with the client. Invoices do not — the database refuses to delete a client
 * that has any (invoices.client_id is `on delete restrict`), because an issued
 * invoice is a business record with a seven-year life.
 */
export function clientDeleteWarning(client) {
  return {
    title: `Delete ${client.name}?`,
    body: [
      'This also permanently deletes their contacts, notes and every document '
        + 'filed under them.',
      'A client with invoices cannot be deleted. Mark them Past instead, and '
        + 'the record stays without reading as current.',
    ],
  };
}

/**
 * Delete a client, throwing a sentence a person can act on when the database
 * refuses. The confirmation is the caller's job (see clientDeleteWarning).
 *
 * The row goes first and the files second. The other way round would strip a
 * client's documents out of storage and then find out they have invoices and
 * cannot be deleted at all — a record nobody asked to change, missing its
 * files. Object cleanup after a successful row delete is best-effort: the
 * rows are already gone, so a leftover object is a storage bill, not a
 * broken record.
 */
export async function deleteClient(client) {
  // Ask before trying, so the refusal names the reason rather than arriving
  // as the generic "something else still refers to this".
  const { count, error: countError } = await supabase
    .from('invoices')
    .select('id', { count: 'exact', head: true })
    .eq('client_id', client.id);
  if (countError) throw new Error(errorMessage(countError));
  if (count > 0) {
    throw new Error(
      `${client.name} has ${count === 1 ? 'an invoice' : `${count} invoices`}, so the record `
      + 'cannot be deleted. Mark them Past instead.',
    );
  }

  const { error } = await supabase.from('clients').delete().eq('id', client.id);
  // 23503 — the restrict on invoices or payments, in case one landed between
  // the check above and this — maps to a sentence in errorMessage.
  if (error) throw new Error(errorMessage(error));

  try {
    const folder = String(client.id);
    const listed = await supabase.storage.from(DOCUMENTS_BUCKET).list(folder, { limit: 1000 });
    const names = (listed.data || []).map((entry) => `${folder}/${entry.name}`);
    if (names.length) await supabase.storage.from(DOCUMENTS_BUCKET).remove(names);
  } catch (cleanupError) {
    // The record is gone either way; a stranded object is not worth an error
    // in front of the person who just deleted a client on purpose.
  }
}

/**
 * Add or edit a client.
 *
 * `prefill` seeds the fields when adding — it is how a duplicate starts life
 * as a copy. `chrome` overrides the modal's own words for a caller doing
 * something other than the two things the default wording describes.
 */
export async function openClientForm(client, prefill = null, chrome = {}) {
  const editing = Boolean(client);
  const source = editing ? client : (prefill || {});
  const current = (name, fallback = '') => (
    source[name] == null ? fallback : source[name]
  );

  let createdId = null;

  // Only `name` is required, so a client captured in thirty seconds still
  // saves. The order does the grouping — who they are, how to reach them,
  // where they are, how they are billed, then notes. Sub-headings would read
  // better, but formModal takes a flat field list and a bare <h3> in a dialog
  // lands at the same size as the dialog's own title, which reads worse than
  // no heading at all.
  const result = await formModal({
    title: chrome.title || (editing ? 'Edit client' : 'Add client'),
    submitLabel: chrome.submitLabel || (editing ? 'Save client' : 'Add client'),
    intro: chrome.intro
         || 'Only the name is required. Everything else can be filled in as you '
          + 'learn it.',
    fields: [
      {
        name: 'name',
        label: 'Business name',
        type: 'text',
        required: true,
        value: current('name'),
        placeholder: 'Acme Roofing',
      },
      {
        name: 'legal_name',
        label: 'Legal name',
        type: 'text',
        value: current('legal_name'),
        placeholder: 'Acme Roofing LLC',
        hint: 'What goes in the "Billed to" block of an invoice, when it differs '
            + 'from what you call them. Blank means the business name above is used.',
      },
      {
        name: 'contact_name',
        label: 'Contact name',
        type: 'text',
        value: current('contact_name'),
        placeholder: 'Dana Whitfield',
        hint: 'The person you actually talk to.',
      },
      {
        name: 'contact_email',
        label: 'Contact email',
        type: 'email',
        value: current('contact_email'),
        hint: 'Tap it on the record to open a mail to them. Nothing is ever sent from here.',
      },
      {
        name: 'contact_phone',
        label: 'Phone',
        type: 'tel',
        value: current('contact_phone'),
        placeholder: '(555) 010-4477',
      },
      {
        name: 'website',
        label: 'Website',
        // type stays text so a bare domain submits; inputmode brings up the
        // URL keyboard, and the rest stops a phone typing "Acme.com".
        type: 'text',
        inputmode: 'url',
        autocapitalize: 'none',
        autocorrect: 'off',
        spellcheck: 'false',
        value: current('website'),
        placeholder: 'acme.com',
        hint: 'A bare domain is fine — it is saved as https://acme.com.',
      },
      {
        name: 'address_line1',
        label: 'Street address',
        type: 'text',
        value: current('address_line1'),
        placeholder: '1400 Harbor Way',
      },
      {
        name: 'address_line2',
        label: 'Suite or unit',
        type: 'text',
        value: current('address_line2'),
      },
      { name: 'city', label: 'City', type: 'text', value: current('city') },
      {
        name: 'region',
        label: 'State or region',
        type: 'text',
        value: current('region'),
      },
      {
        name: 'postal_code',
        label: 'ZIP or postal code',
        type: 'text',
        value: current('postal_code'),
      },
      { name: 'country', label: 'Country', type: 'text', value: current('country') },
      {
        name: 'status',
        label: 'Status',
        type: 'select',
        value: current('status', prefill ? 'lead' : 'active'),
        options: CLIENT_STATUS_OPTIONS,
        hint: 'Lead while you are still winning the work. Past keeps the record '
            + 'without them reading as current.',
      },
      {
        name: 'hourly_rate',
        label: 'Negotiated hourly rate',
        // Text with a decimal keypad, the same as every other money field in
        // the portal: `number` refuses a typed "$" and a comma outright, and
        // parseMoney already understands both.
        type: 'text',
        inputmode: 'decimal',
        value: source.hourly_rate_cents
          ? formatMoney(source.hourly_rate_cents).replace(/^\$/, '')
          : '',
        placeholder: '90.00',
        hint: 'Leave blank unless this client negotiated their own rate. Blank '
            + 'means the standard rate from Admin — whatever it is at the time. '
            + 'A number here is what "Bill hours" on their invoices will use '
            + 'instead, and it does not move when the standard rate does.',
      },
      {
        name: 'net_days',
        label: 'Payment terms',
        type: 'text',
        inputmode: 'numeric',
        value: source.net_days == null ? '' : String(source.net_days),
        placeholder: '15',
        hint: 'Days until an invoice falls due. Blank means the standard terms '
            + 'from Admin; 30 makes this a Net 30 client. Copied onto each '
            + 'invoice when it is raised, so changing it later never moves a '
            + 'due date already printed.',
      },
      {
        name: 'notes',
        label: 'Notes',
        type: 'textarea',
        rows: 3,
        value: current('notes'),
        hint: 'Background on the record itself. Dated notes go on the record page.',
      },
    ],
    onSubmit: async (values) => {
      // Blank and a typo both come back from parseMoney as null, and they mean
      // opposite things: blank is "the standard rate, deliberately", a typo is
      // "somebody meant to negotiate something". So the difference is decided on
      // the raw string before parseMoney is consulted, and a typo stops the save
      // rather than quietly putting the client back on the standard rate. Zero
      // and negatives are refused here as well as by the database
      // (clients_hourly_rate_positive), because the message a person can act on
      // is the one shown next to the field.
      const rateTyped = String(values.hourly_rate || '').trim();
      const rateCents = rateTyped ? parseMoney(rateTyped) : null;
      if (rateTyped && (rateCents === null || rateCents <= 0)) {
        throw new Error('That hourly rate is not an amount. Leave it blank for the standard rate.');
      }

      const patch = {
        name: values.name,
        legal_name: values.legal_name || null,
        contact_name: values.contact_name || null,
        contact_email: values.contact_email || null,
        contact_phone: values.contact_phone || null,
        // Throws on a non-web address, which keeps the modal open with the
        // reason rather than saving something nobody can click.
        website: normalizeWebsite(values.website),
        address_line1: values.address_line1 || null,
        address_line2: values.address_line2 || null,
        city: values.city || null,
        region: values.region || null,
        postal_code: values.postal_code || null,
        country: values.country || null,
        status: values.status,
        hourly_rate_cents: rateCents,
        // Throws on anything that is not a number of days.
        net_days: parseNetDays(values.net_days),
        notes: values.notes || null,
      };

      if (editing) {
        const { error } = await supabase.from('clients').update(patch).eq('id', client.id);
        if (error) throw new Error(errorMessage(error));
        return;
      }

      const { data, error } = await supabase
        .from('clients').insert(patch).select('id').single();
      if (error) throw new Error(errorMessage(error));
      createdId = data.id;
    },
    deleteLabel: 'Delete client',
    // Guarded: an argument's template literal runs at the call, so unguarded
    // this would throw on every path that creates a client.
    confirmDelete: editing ? clientDeleteWarning(client) : undefined,
    onDelete: editing ? () => deleteClient(client) : null,
  });

  if (!result) return null;

  if (result === 'deleted') {
    toast('Client deleted.', 'ok');
    return 'deleted';
  }

  toast(chrome.savedToast || (editing ? 'Client saved.' : 'Client added.'), 'ok');
  return { id: editing ? client.id : createdId, created: !editing };
}

// Duplicating
// ---------------------------------------------------------------------------

/**
 * What a copy carries over: who they are and how to reach them, which is what
 * the second location, the sister company and the landlord's fourth building
 * have in common with the first.
 *
 * `hourly_rate_cents` and `net_days` are deliberately off the list, and the
 * rate is the sharper case because it is a price. A negotiated rate is the
 * record of a conversation with one client; copied onto a second record it
 * becomes a discount nobody agreed to, printed on an invoice, and traceable to
 * nothing but a duplicate button. The copy starts on the standard rate and
 * standard terms — the truth until somebody negotiates otherwise — and the
 * form is right there to set them if they have. `id`, `created_at` and
 * `updated_at` belong to the database.
 */
const DUPLICATED_FIELDS = [
  'legal_name', 'contact_name', 'contact_email', 'contact_phone', 'website',
  'address_line1', 'address_line2', 'city', 'region', 'postal_code', 'country',
  'status', 'notes',
];

/** A copy of `client` shaped for the Add form. The name is suffixed rather
 *  than blanked: a required field arriving empty makes you retype the one
 *  thing you were looking at, and "(copy)" is easier to correct than to
 *  remember. */
function duplicatePrefill(client) {
  const prefill = { name: `${client.name} (copy)` };

  for (const field of DUPLICATED_FIELDS) {
    if (client[field] !== null && client[field] !== undefined) {
      prefill[field] = client[field];
    }
  }

  return prefill;
}

/**
 * Duplicate a client: the Add form, prefilled from an existing record.
 *
 * Nothing is written until the form is submitted, so the copy can be corrected
 * — renamed, re-addressed, moved back to Lead — while it is still only a form.
 * Resolves like openClientForm: null on cancel, { id, created: true } on save.
 */
export async function openClientDuplicateForm(client) {
  return openClientForm(null, duplicatePrefill(client), {
    title: 'Duplicate client',
    submitLabel: 'Create client',
    intro: `A new client, prefilled from ${client.name} and yours to change before `
         + 'it exists. Only what is on this form comes across: their contacts, '
         + 'documents, notes, invoices and expenses all stay where they are, and '
         + 'the copy starts on the standard rate and terms.',
    savedToast: 'Client duplicated.',
  });
}
