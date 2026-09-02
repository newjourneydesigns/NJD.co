// Every icon a portal module asks for exists in icons.js.
//
// icon() THROWS on a name it does not know — the right behaviour for
// catching typos in development, and a landmine in production: on 2026-08-25
// a `icon('check')` with no matching entry crashed the whiteboard mount for
// exactly the person who had just won the pen, blanking the whole canvas.
// The call sites are string literals, so this is checkable without a DOM:
// read the sources, collect every icon('...') name, and hold icons.js to it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const PORTAL_DIR = new URL('../../js/portal/', import.meta.url).pathname;

test('every icon(name) used by a portal module exists in icons.js', () => {
  const iconsSource = readFileSync(join(PORTAL_DIR, 'icons.js'), 'utf8');
  const defined = new Set();
  // Map keys come in both spellings: bare identifiers and quoted kebab-case.
  for (const match of iconsSource.matchAll(/^ {2}(?:'([a-z0-9-]+)'|([a-z][a-zA-Z0-9]*)):\s*\[/gm)) {
    defined.add(match[1] || match[2]);
  }
  assert.ok(defined.size > 10, `parsed only ${defined.size} icons — the map regex has gone stale`);

  const missing = [];
  for (const file of readdirSync(PORTAL_DIR).filter((f) => f.endsWith('.js'))) {
    const source = readFileSync(join(PORTAL_DIR, file), 'utf8');
    // The whole argument list, not just a leading literal — the call that
    // crashed production was icon(isEditing ? 'check' : 'square-pen'), and a
    // scanner that only reads icon('...') looks straight past a ternary.
    for (const call of source.matchAll(/\bicon\(([^)]*)\)/g)) {
      for (const name of call[1].matchAll(/'([a-z0-9-]+)'/g)) {
        if (!defined.has(name[1])) missing.push(`${file}: icon('${name[1]}')`);
      }
    }
  }
  assert.deepEqual(missing, [],
    `icon names with no entry in icons.js — add them from lucide.dev:\n  ${missing.join('\n  ')}`);
});
