// ---------------------------------------------------------------------------
// Filtering the People table.
//
// Admin → People is the list of who can sign in. Today that is two rows — the
// owner and the bookkeeper — and the box exists so it stays usable if that
// ever becomes ten.
//
// The matching is deliberately plain: fold accents and case, split what was
// typed into words, and keep a row when every word appears somewhere in it.
// The portal this was lifted from ran a typo-tolerant fuzzy scorer here,
// which is four hundred lines of machinery for a table you can see all of.
// A substring match over a handful of rows is not worse; it is the same
// answer, arrived at by something a reader can hold in their head.
//
// Pure — no DOM, no Supabase. See tools/portal/people-search.test.mjs.
// ---------------------------------------------------------------------------

/** Case-folded and accent-stripped, so "José" is found by typing "jose". */
function fold(value) {
  return String(value === null || value === undefined ? '' : value)
    .normalize('NFKD')
    // The combining marks NFKD just split off, by code point rather than as
    // literal characters — a source file is the wrong place to store those.
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

/** The words somebody typed. Two characters is the floor: one letter matches
 *  most of any list and so answers nothing. */
export function queryTerms(query) {
  const raw = fold(query);
  if (raw.length < 2) return [];
  return raw.split(/\s+/).filter(Boolean);
}

/**
 * The rows still worth showing.
 *
 * `describe` hands back the strings a row can be found by — the caller owns
 * that, because only it knows how a role becomes "Bookkeeper" and how an
 * address becomes a username. Every column on screen should be in it: a table
 * you can see but not search is a table that lies about what it holds.
 *
 * An empty or one-character query returns everything.
 */
export function filterPeople(people, query, describe) {
  const terms = queryTerms(query);
  if (!terms.length) return people || [];

  return (people || []).filter((person) => {
    const haystack = describe(person).filter(Boolean).map(fold).join(' ');
    return terms.every((term) => haystack.includes(term));
  });
}
