// ---------------------------------------------------------------------------
// Money — pure helpers shared by the invoice editor, the client form, the
// expenses page and the reports. No DOM, no network, no clock, so
// node --test can hold it to account.
//
// Every amount in this portal is integer cents. A float will eventually make
// two numbers that should be equal differ by a hundredth of a cent, and an
// invoice whose lines and total disagree is refused by the database.
// ---------------------------------------------------------------------------

/** Any value as whole cents; garbage as zero. */
export function centsOf(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

/**
 * Dollars as typed by a human — "3,900", "$3,900.50", "3900", "-45" — as cents.
 * Returns null for anything that is not a number, so a caller can tell "empty"
 * from "zero" rather than treating a typo as a free line.
 */
export function parseMoney(input) {
  if (input === null || input === undefined) return null;
  const cleaned = String(input).replace(/[$,\s]/g, '');
  if (cleaned === '') return null;
  if (!/^-?\d*\.?\d*$/.test(cleaned)) return null;
  if (cleaned === '-' || cleaned === '.' || cleaned === '-.') return null;
  const amount = Number(cleaned);
  if (!Number.isFinite(amount)) return null;
  // toFixed rather than multiply-and-round: 19.99 * 100 is 1998.9999999999998.
  return Math.round(Number(amount.toFixed(2)) * 100);
}

/** Cents as "$1,234.56". Negative amounts print with a leading minus. */
export function formatMoney(cents) {
  const value = centsOf(cents) / 100;
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** Cents as "$1,234" when whole, "$1,234.56" otherwise — for figures. */
export function formatMoneyShort(cents) {
  const whole = centsOf(cents) % 100 === 0;
  const value = centsOf(cents) / 100;
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  });
}

/**
 * The hourly rate a "Bill hours" line should use, in cents.
 *
 * `clientRateCents` is `clients.hourly_rate_cents`: null for most clients, a
 * positive number only where a rate was negotiated. When there is one it wins
 * outright. Otherwise the business's standard rate, `studio.hourly_rate_cents`,
 * applies — and when THAT is null too the answer is `missing: true` with zero
 * cents, which the editor must refuse to price a line from rather than print
 * "$0.00 an hour" on an invoice.
 *
 * Zero, negative, empty or NaN client rates mean "nobody negotiated anything".
 */
export function resolveHourlyRate(clientRateCents, studio) {
  const negotiated = Number(clientRateCents);
  if (Number.isFinite(negotiated) && negotiated > 0) {
    return { cents: Math.round(negotiated), negotiated: true, missing: false };
  }
  const standard = Number(studio && studio.hourly_rate_cents);
  if (Number.isFinite(standard) && standard > 0) {
    return { cents: Math.round(standard), negotiated: false, missing: false };
  }
  return { cents: 0, negotiated: false, missing: true };
}

/** Basis points as a percentage string: 825 → "8.25%". */
export function formatRate(bp) {
  const n = centsOf(bp) / 100;
  return `${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;
}

/**
 * Line total for a quantity at a unit price, rounded once. Quantity is a
 * number of hours or units and may be fractional; the unit price is cents.
 */
export function lineAmount(quantity, unitCents) {
  const q = Number(quantity);
  if (!Number.isFinite(q)) return 0;
  return Math.round(q * centsOf(unitCents));
}

/**
 * Subtotal, tax and total for a set of lines, with tax computed once on the
 * taxable subtotal (never per line, so the rounding cannot drift a cent).
 * `taxRateBp` is basis points: 825 is 8.25%.
 */
export function computeTotals(items, taxRateBp) {
  const lines = items || [];
  const subtotal = lines.reduce((sum, item) => sum + centsOf(item.amount_cents), 0);
  const rate = centsOf(taxRateBp);
  const taxable = rate > 0
    ? lines.filter((item) => item.taxable).reduce((sum, item) => sum + centsOf(item.amount_cents), 0)
    : 0;
  const tax = rate > 0 ? Math.round((taxable * rate) / 10000) : 0;
  return {
    subtotal_cents: subtotal,
    taxable_cents: taxable,
    tax_cents: tax,
    total_cents: subtotal + tax,
  };
}
