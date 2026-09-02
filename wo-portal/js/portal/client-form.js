// ---------------------------------------------------------------------------
// The client add/edit form, shared by Admin and the client record page.
//
// One form rather than two: a record corrected from the page you read it on
// must be the same record Admin edits, or the two screens drift apart a field
// at a time. Admin opens it from the clients table and from "convert this form
// entry"; the client record page opens it from its Details panel.
//
// Duplicating a client is the same form again, opened empty-handed with an
// existing record poured into it (openClientDuplicateForm below) — a copy you
// read and correct before it exists, rather than a second record created behind
// your back and fixed afterwards.
//
// Resolves to null on cancel, 'deleted' after a delete, or { id, created }
// after a save — id so the convert-a-lead flow can link the entry to the
// client it just made. Toasts happen here, so the wording exists once; the
// caller only has to re-fetch whatever it is displaying.
// ---------------------------------------------------------------------------

import { supabase, errorMessage } from './client.js';
import { formatMoney, parseMoney } from './sow-fees.js';
import { toast, formModal } from './ui.js';

// Where a client sits with the studio. Ordered the way a record moves through
// it, not alphabetically.
const CLIENT_STATUS_OPTIONS = [
  { value: 'lead', label: 'Lead' },
  { value: 'active', label: 'Active' },
  { value: 'past', label: 'Past' },
];

/**
 * People type `acme.com`, so assume https rather than rejecting them — but only
 * after the URL parser has agreed it is a web address. That is what keeps a
 * `javascript:` value out of the column, whether or not this page ever renders
 * it as a link; the project page might.
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
 * Add or edit a client.
 *
 * `prefill` seeds the fields when adding — it is how an form entry becomes a
 * client without anyone retyping it, and how a duplicate starts life as a copy.
 * `chrome` overrides the modal's own words for a caller doing neither of the
 * two things the default wording describes.
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
  // where they are, then notes. Sub-headings would read better, but formModal
  // takes a flat field list and a bare <h3> in a dialog lands at the same size
  // as the dialog's own title, which reads worse than no heading at all.
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
        name: 'contact_name',
        label: 'Contact name',
        type: 'text',
        value: current('contact_name'),
        placeholder: 'Dana Whitfield',
        hint: 'The person you actually talk to.',
      },
      {
        name: 'industry',
        label: 'Industry',
        type: 'text',
        value: current('industry'),
        placeholder: 'Roofing & exteriors',
      },
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
        name: 'source',
        label: 'How they found you',
        type: 'text',
        value: current('source'),
        placeholder: 'Referral from the Hendersons',
        hint: 'The only record you will have of what is actually bringing work in.',
      },
      {
        name: 'contact_email',
        label: 'Contact email',
        type: 'email',
        value: current('contact_email'),
        hint: 'Where message notifications go until someone on their team has an account.',
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
      // The contracting half of the record. Everything below here exists for the
      // SOW builder: it is what a document has to say that a CRM never needed.
      {
        name: 'legal_name',
        label: 'Legal name',
        type: 'text',
        value: current('legal_name'),
        placeholder: 'Acme Roofing LLC',
        hint: 'What goes on a contract, when it differs from what you call them. '
            + 'Blank means the business name above is used.',
      },
      {
        name: 'entity_type',
        label: 'Entity type',
        type: 'text',
        value: current('entity_type'),
        placeholder: 'a Texas limited liability company',
      },
      {
        name: 'contact_title',
        label: 'Contact title',
        type: 'text',
        value: current('contact_title'),
        placeholder: 'Owner',
        hint: 'Printed under their name on the signature block.',
      },
      {
        name: 'msa_signed_on',
        label: 'MSA signed on',
        type: 'date',
        value: current('msa_signed_on'),
        hint: 'The date the master agreement was signed. Every scope of work '
            + 'incorporates it by this date, and one issued without it has no effect. '
            + 'The signed copy itself is uploaded on the client record page.',
      },
      {
        name: 'msa_version',
        label: 'MSA version',
        type: 'text',
        value: current('msa_version'),
        placeholder: 'v1',
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
        hint: 'Leave blank unless this client negotiated their own rate for '
            + 'out-of-scope work. Blank means the studio rate — whatever it is '
            + 'at the time — which is right for almost everybody. A number here '
            + 'is what their scopes of work and invoices will quote instead, and '
            + 'it does not move when the studio rate does.',
      },
      {
        name: 'nonprofit',
        label: 'Nonprofit or church',
        type: 'checkbox',
        value: Boolean(source.nonprofit),
      },
      {
        name: 'notes',
        label: 'Notes',
        type: 'textarea',
        rows: 3,
        value: current('notes'),
        hint: 'Staff-only. Clients never see this.',
      },
    ],
    onSubmit: async (values) => {
      // Blank and a typo both come back from parseMoney as null, and they mean
      // opposite things: blank is "the studio rate, deliberately", a typo is
      // "somebody meant to negotiate something". So the difference is decided on
      // the raw string before parseMoney is consulted, and a typo stops the save
      // rather than quietly putting the client back on the studio rate. Zero and
      // negatives are refused here as well as by the database, because the
      // message a person can act on is the one shown next to the field.
      const rateTyped = String(values.hourly_rate || '').trim();
      const rateCents = rateTyped ? parseMoney(rateTyped) : null;
      if (rateTyped && (rateCents === null || rateCents <= 0)) {
        throw new Error('That hourly rate is not an amount. Leave it blank for the studio rate.');
      }

      const patch = {
        name: values.name,
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
        industry: values.industry || null,
        source: values.source || null,
        status: values.status,
        legal_name: values.legal_name || null,
        entity_type: values.entity_type || null,
        contact_title: values.contact_title || null,
        msa_signed_on: values.msa_signed_on || null,
        msa_version: values.msa_version || null,
        hourly_rate_cents: rateCents,
        nonprofit: values.nonprofit,
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
    // The generic wording cannot name the cascade, and the cascade is the
    // whole reason this one deserves a second thought.
    // Guarded: an argument's template literal runs at the call, so unguarded
    // this threw on every path that creates a client — including converting a
    // lead from Form Entries. See the note in person-form.js.
    confirmDelete: editing ? {
      title: `Delete ${client.name}?`,
      body: [
        'This also permanently deletes every project for this client, along '
          + 'with all of their waypoints, board cards, documents and messages.',
        'Their sign-in accounts stay, but will have nothing to see.',
      ],
    } : undefined,
    onDelete: editing
      ? async () => {
        const { error } = await supabase.from('clients').delete().eq('id', client.id);
        if (error) throw error;
      }
      : null,
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
 * What a copy carries over: the CRM half of the record, plus the contracting
 * details that describe the same kind of company rather than one signature.
 *
 * The master agreement is deliberately not on the list. `msa_signed_on`,
 * `msa_version` and the uploaded copy say that *this* client signed *that*
 * agreement on that day — a claim a second record cannot inherit by being
 * typed from the first, and one every scope of work leans on. The new client
 * starts with no MSA on file, which is the truth until they sign one. `id`,
 * `created_at` and `updated_at` belong to the database, and the storage
 * columns are not on the form at all, so neither can ride along.
 *
 * `hourly_rate_cents` is off the list for the same reason and it is the sharper
 * case, because this one is a price. A negotiated rate is the record of a
 * conversation with one client; copied onto a second record it becomes a
 * discount nobody agreed to, printed in a contract, and traceable to nothing
 * but a duplicate button. The copy starts on the studio rate — the truth until
 * somebody negotiates otherwise — and the form is right there to set it if they
 * have.
 */
const DUPLICATED_FIELDS = [
  'contact_name', 'contact_email', 'contact_phone', 'website',
  'address_line1', 'address_line2', 'city', 'region', 'postal_code', 'country',
  'industry', 'source', 'status',
  'legal_name', 'entity_type', 'contact_title', 'nonprofit',
  'notes',
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
         + 'it exists. Only what is on this form comes across: their projects, '
         + 'contacts, documents, notes, scopes of work, invoices and master '
         + 'agreement all stay where they are.',
    savedToast: 'Client duplicated.',
  });
}
