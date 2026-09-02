// ---------------------------------------------------------------------------
// Filtering the People table.
//
// Admin → People is the staff list you go to when you know who you are
// looking for, and it grows by one row every time somebody joins the studio.
// Six rows fit on a screen; thirty do not.
//
// The matching is the header search's, borrowed rather than reinvented
// (search-index.js): the same typo tolerance, the same accent folding, the
// same "every word has to match, in any field, in any order". A name typed
// half-right finds the person here exactly as it does up there, which is one
// behaviour to learn instead of two.
//
// Pure — no DOM, no Supabase. See tools/portal/people-search.test.mjs.
// ---------------------------------------------------------------------------

import { queryTerms, matchScore } from './search-index.js';

/**
 * The rows still worth showing.
 *
 * `describe` hands back the strings a row can be found by — the caller owns
 * that, because only it knows how a client id becomes a client's name and how
 * a timestamp becomes "Aug 1, 2026". Every column on screen should be in it:
 * a table you can see but not search is a table that lies about what it holds.
 *
 * An empty or one-character query returns everything. One letter matches most
 * of any list and answers nothing, which is queryTerms' rule, not ours.
 */
export function filterPeople(people, query, describe) {
  const terms = queryTerms(query);
  if (!terms.length) return people || [];

  return (people || []).filter((person) => {
    const fields = describe(person).filter(Boolean);
    return terms.every((term) => fields.some((field) => matchScore(term, field) > 0));
  });
}
