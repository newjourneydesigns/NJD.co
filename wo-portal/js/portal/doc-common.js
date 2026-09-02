// ---------------------------------------------------------------------------
// Document helpers — pure. The parties on an invoice, date formatting for a
// printed document, and the canonical form a frozen snapshot is hashed from.
// ---------------------------------------------------------------------------

const DATE_FMT = new Intl.DateTimeFormat('en-US', {
  month: 'long', day: 'numeric', year: 'numeric',
});

/** Date-only columns are plain YYYY-MM-DD. Parsing one as UTC would shift the
 *  printed day for anyone west of Greenwich, which on an invoice matters. */
export function longDate(value) {
  if (!value) return '';
  const parts = String(value).slice(0, 10).split('-');
  if (parts.length !== 3) return '';
  const date = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  if (Number.isNaN(date.getTime())) return '';
  return DATE_FMT.format(date);
}

/** Today as YYYY-MM-DD in the browser's own calendar, not UTC's. */
export function isoToday(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Add whole days to a YYYY-MM-DD string, in local calendar terms. */
export function addDays(iso, days) {
  const parts = String(iso || '').slice(0, 10).split('-');
  if (parts.length !== 3) return '';
  const date = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]) + Number(days || 0));
  return isoToday(date);
}

export function text(value) {
  const trimmed = String(value === null || value === undefined ? '' : value).trim();
  return trimmed || null;
}

/** Free-text blocks are written as paragraphs and one-per-line lists alike, so
 *  split on newlines and let the renderer decide. */
export function lines(value) {
  const body = text(value);
  if (!body) return [];
  return body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

/** The party the invoice is billed to. Legal name where one is recorded, the
 *  working name otherwise — never a blank. */
export function clientParty(client) {
  if (!client) return null;
  const name = text(client.legal_name) || text(client.name);
  const locality = [text(client.city), text(client.region)].filter(Boolean).join(', ');

  return {
    name,
    workingName: text(client.name),
    address: [
      text(client.address_line1),
      text(client.address_line2),
      [locality, text(client.postal_code)].filter(Boolean).join(' ').trim() || null,
      text(client.country),
    ].filter(Boolean),
    contactName: text(client.contact_name),
    contactEmail: text(client.contact_email),
    contactPhone: text(client.contact_phone),
  };
}

/** The business, from the studio_settings row. The letterhead. */
export function studioParty(studio) {
  const s = studio || {};
  const locality = [text(s.city), text(s.region)].filter(Boolean).join(', ');
  return {
    name: text(s.business_name) || 'Walter Ochenski LLC',
    entityLine: text(s.entity_line),
    address: [
      text(s.address_line1),
      text(s.address_line2),
      [locality, text(s.postal_code)].filter(Boolean).join(' ').trim() || null,
    ].filter(Boolean),
    phone: text(s.phone),
    email: text(s.email),
    website: text(s.website),
    payeeName: text(s.payee_name) || text(s.business_name) || 'Walter Ochenski LLC',
  };
}

/**
 * A filename-safe slug of a client name. Anything that is not a letter or a
 * digit becomes a hyphen, so a legal name with a comma, an ampersand or an
 * accent in it cannot produce a filename a Windows machine refuses to save.
 */
export function clientSlug(name) {
  return String(name || 'client')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'client';
}

/** Deterministic JSON: keys sorted, no whitespace. What the hash is taken of. */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

/** SHA-256 of the canonical form, hex. Stored beside the frozen snapshot. */
export async function digest(snapshot) {
  const bytes = new TextEncoder().encode(canonical(snapshot));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
