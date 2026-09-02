// ---------------------------------------------------------------------------
// The portal asks its own questions.
//
//   node --test tools/portal/*.test.mjs
//
// There were 25 window.confirm() calls across 18 modules, and every one put an
// OS alert captioned "newjourneydesigns.com says:" in front of whoever pressed
// the button — a client, on the Approve control, included. They are gone, and
// this is what keeps them gone: the replacement (confirmModal in ui.js) is one
// import away, so the cheap thing and the right thing are the same distance,
// but only if nobody has to remember.
//
// window.alert and window.prompt are covered too. They were never used here,
// and this is a good moment to make that permanent — prompt() in particular is
// a text input with no label, no validation and no cancel semantics worth the
// name, and several browsers now refuse it outright in a cross-origin frame.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const PORTAL = new URL('../../js/portal/', import.meta.url).pathname;

/** Source lines, minus the ones that are only talking about the code. */
function codeLines(file) {
  return readFileSync(join(PORTAL, file), 'utf8')
    .split('\n')
    .map((text, i) => ({ text, line: i + 1 }))
    .filter(({ text }) => !/^\s*(\/\/|\*|\/\*)/.test(text));
}

const MODULES = readdirSync(PORTAL).filter((f) => f.endsWith('.js'));

test('there is something to check', () => {
  // A glob that quietly matches nothing passes every assertion below it.
  assert.ok(MODULES.length > 100, `expected the portal's modules, found ${MODULES.length}`);
});

for (const dialog of ['confirm', 'alert', 'prompt']) {
  // `confirm(` and nothing longer. Because the `(` is part of the pattern,
  // confirmModal( cannot match it — the character after "confirm" is "M".
  // The leading class rules out someone.confirm() and thing_confirm(), while
  // still allowing the window. prefix that is the whole point.
  const CALL = new RegExp(`(^|[^.\\w$])(window\\s*\\.\\s*)?${dialog}\\s*\\(`);

  test(`no module calls window.${dialog}`, () => {
    const found = [];
    for (const file of MODULES) {
      for (const { text, line } of codeLines(file)) {
        if (!CALL.test(text)) continue;
        found.push(`js/portal/${file}:${line}  ${text.trim().slice(0, 72)}`);
      }
    }
    assert.deepEqual(found, [],
      `window.${dialog} is not the portal's dialog. Use confirmModal from ui.js.\n`
      + found.map((f) => `  ${f}`).join('\n'));
  });

  // The guard above is a regex over source text, which is exactly the kind of
  // check that rots into always-passing. This proves it still recognises the
  // thing it is looking for, and still ignores the replacement it is not.
  test(`the window.${dialog} guard recognises a real call`, () => {
    assert.ok(CALL.test(`  if (!window.${dialog}('gone?')) return;`), 'missed window. form');
    assert.ok(CALL.test(`  const ok = ${dialog}('gone?');`), 'missed bare form');
    assert.ok(CALL.test(`  x = window.${dialog}('a') && await ${dialog}Modal({`),
      'missed a call sharing its line with the replacement');
    assert.ok(!CALL.test(`  const ok = await ${dialog}Modal({ title: 'x' });`),
      `${dialog}Modal must not trip it`);
    assert.ok(!CALL.test(`  shell.${dialog}(x);`), 'a method of ours must not trip it');
  });
}

test('confirmModal is always awaited', () => {
  // An un-awaited confirmModal returns a Promise, which is truthy, so the
  // guarded action runs whatever the person answered — and the dialog becomes
  // decoration in front of a delete. Silent, and the tests would not catch it.
  const found = [];
  for (const file of MODULES) {
    for (const { text, line } of codeLines(file)) {
      if (!/\bconfirmModal\s*\(/.test(text)) continue;
      if (/export function confirmModal/.test(text)) continue;
      if (/await\s+confirmModal\s*\(/.test(text)) continue;
      found.push(`js/portal/${file}:${line}  ${text.trim().slice(0, 72)}`);
    }
  }
  assert.deepEqual(found, [],
    'confirmModal returns a Promise; without await the guard always passes.\n'
    + found.map((f) => `  ${f}`).join('\n'));
});
