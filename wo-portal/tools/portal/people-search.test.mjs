import test from 'node:test';
import assert from 'node:assert/strict';

import { filterPeople, queryTerms } from '../../js/portal/people-search.js';

const PEOPLE = [
  { name: 'Walter Ochenski', username: 'walter', role: 'owner' },
  { name: 'Dana Reid', username: 'dana', role: 'staff' },
  { name: 'José Álvarez', username: 'jose', role: 'staff' },
];

const describe = (p) => [p.name, p.username, p.role === 'owner' ? 'Owner' : 'Bookkeeper'];

test('one character is not a search', () => {
  assert.deepEqual(queryTerms('w'), []);
  assert.equal(filterPeople(PEOPLE, 'w', describe).length, 3);
  assert.equal(filterPeople(PEOPLE, '', describe).length, 3);
  assert.equal(filterPeople(PEOPLE, '   ', describe).length, 3);
});

test('matches on any described field', () => {
  assert.deepEqual(filterPeople(PEOPLE, 'ochenski', describe).map((p) => p.username), ['walter']);
  assert.deepEqual(filterPeople(PEOPLE, 'dana', describe).map((p) => p.username), ['dana']);
  assert.deepEqual(filterPeople(PEOPLE, 'owner', describe).map((p) => p.username), ['walter']);
  assert.deepEqual(
    filterPeople(PEOPLE, 'bookkeeper', describe).map((p) => p.username),
    ['dana', 'jose'],
  );
});

test('every word has to match, in any field and any order', () => {
  assert.deepEqual(filterPeople(PEOPLE, 'walter owner', describe).map((p) => p.username), ['walter']);
  assert.deepEqual(filterPeople(PEOPLE, 'owner walter', describe).map((p) => p.username), ['walter']);
  assert.deepEqual(filterPeople(PEOPLE, 'walter bookkeeper', describe), []);
});

test('accents and case are folded, both ways round', () => {
  assert.deepEqual(filterPeople(PEOPLE, 'jose', describe).map((p) => p.username), ['jose']);
  assert.deepEqual(filterPeople(PEOPLE, 'JOSÉ', describe).map((p) => p.username), ['jose']);
  assert.deepEqual(filterPeople(PEOPLE, 'alvarez', describe).map((p) => p.username), ['jose']);
});

test('a partial word matches — people type the start of a name', () => {
  assert.deepEqual(filterPeople(PEOPLE, 'och', describe).map((p) => p.username), ['walter']);
});

test('no match is an empty list, not everything', () => {
  assert.deepEqual(filterPeople(PEOPLE, 'zzz', describe), []);
});

test('an empty roster survives a query', () => {
  assert.deepEqual(filterPeople([], 'walter', describe), []);
  assert.deepEqual(filterPeople(undefined, 'walter', describe), []);
});

test('a blank field never matches everything', () => {
  const withBlank = [{ name: '', username: 'ghost', role: 'staff' }];
  assert.deepEqual(filterPeople(withBlank, 'ghost', describe).map((p) => p.username), ['ghost']);
  assert.deepEqual(filterPeople(withBlank, 'walter', describe), []);
});
