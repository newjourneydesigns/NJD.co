// ---------------------------------------------------------------------------
// A value that might be null may not be handed to the raw DOM append().
//
//   node --test tools/portal/nullable-append-guard.test.mjs
//
// A source-level check, like confirm-delete-guard.test.mjs and
// no-browser-dialogs.test.mjs, and it exists for the same reason: the mistake
// shipped.
//
// WHAT HAPPENED (2026-08-27)
//
// install-hint.js built its bar with `bar.append(icon, text, action, close)`,
// where `action` is the Install button — and `action` is deliberately null on
// iOS, because iOS has no install API to point a button at. Node.append()
// accepts strings as well as nodes, so it did not skip the null: it
// stringified it. An iPhone opening the portal was shown the word **"null"**
// sitting beside the sentence asking it to add the portal to its home screen.
//
// It reached production. Nothing caught it:
//
//   - the module parsed, and every unit test passed;
//   - install-model.test.mjs covered the DECISION (`action` is null on iOS)
//     and was right — the bug was in the rendering, which nothing here tests
//     (ARCHITECTURE §9.3);
//   - the UI gate passed, because its fixture is markup transcribed BY HAND
//     from the render function. The fixture described what the function was
//     meant to produce, so it was green about markup the code never emitted.
//     That is the gate's documented way of lying, arriving by a new route: not
//     a fixture gone stale, a fixture that was aspirational from birth.
//
// THE RULE
//
//   el() and mount() both drop null, undefined and false children. The raw
//   .append()/.prepend() do not. So anything that can be null goes through the
//   helpers.
//
// This does not ban raw .append() — there are ~140 uses and nearly all pass
// values that cannot be null. It bans exactly the combination that bit:
// a binding assigned from a ternary whose alternative is `null`, passed
// straight to a raw append. Satisfying it costs one word: `mount(node, …)`
// instead of `node.append(…)`.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PORTAL = join(dirname(fileURLToPath(import.meta.url)), '../../js/portal');

// ui.js is where el() and mount() are defined; its own append() calls are the
// implementation of the rule, not a violation of it.
const EXEMPT = new Set(['ui.js']);

/**
 * Bindings whose value can be null: `const x = cond ? thing : null;`
 *
 * A name bound BOTH ways somewhere in the file is dropped rather than flagged.
 * This is a regex, not a parser (no dependency to parse with), so it cannot see
 * scope — and signing-panel.js legitimately has two different `host` bindings
 * in two functions, one nullable and one an element. Conservative is the right
 * failure direction for a guard: a missed case is a bug that ships, but a false
 * alarm is a rule people start switching off.
 */
function nullableBindings(source) {
  const nullable = new Set();
  const solid = new Set();
  const re = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;]*?);/gs;
  for (const [, name, raw] of source.matchAll(re)) {
    const value = raw.trim();
    if (/\?[\s\S]*:\s*null\s*$/.test(value) || value === 'null') nullable.add(name);
    else solid.add(name);
  }
  for (const name of solid) nullable.delete(name);
  return nullable;
}

/** The argument text of every raw .append(…) / .prepend(…), paren-balanced so
 *  nested calls do not truncate it. */
function rawAppendArgs(source) {
  const out = [];
  const re = /\.(append|prepend)\(/g;
  let match;
  while ((match = re.exec(source))) {
    let depth = 1;
    let i = match.index + match[0].length;
    const start = i;
    while (i < source.length && depth > 0) {
      const c = source[i];
      if (c === '(') depth += 1;
      else if (c === ')') depth -= 1;
      i += 1;
    }
    out.push({ index: match.index, text: source.slice(start, i - 1) });
  }
  return out;
}

/** Split an argument list on top-level commas only. */
function topLevelArgs(text) {
  const args = [];
  let depth = 0;
  let current = '';
  for (const c of text) {
    if ('([{'.includes(c)) depth += 1;
    if (')]}'.includes(c)) depth -= 1;
    if (c === ',' && depth === 0) { args.push(current); current = ''; continue; }
    current += c;
  }
  args.push(current);
  return args.map((a) => a.trim()).filter(Boolean);
}

export function violationsIn(source) {
  const nullable = nullableBindings(source);
  const bad = [];

  for (const call of rawAppendArgs(source)) {
    // `if (whyLine) shell.body.append(whyLine);` is already safe — the guard
    // is for values reaching append UNCHECKED, not for every mention of one.
    const before = source.slice(Math.max(0, call.index - 120), call.index);
    const guarded = /\bif\s*\(\s*([A-Za-z_$][\w$]*)[\s)&]/.exec(before);

    for (const arg of topLevelArgs(call.text)) {
      if (guarded && guarded[1] === arg) continue;
      // A bare identifier only. `cond ? el(…) : null` written INLINE is just as
      // broken, so it is caught too.
      if (nullable.has(arg)) bad.push(arg);
      else if (/^[^?]*\?[\s\S]*:\s*null$/.test(arg)) bad.push(arg.slice(0, 40));
    }
  }
  return bad;
}

test('no portal module hands a possibly-null value to a raw append()', () => {
  const offenders = [];

  for (const file of readdirSync(PORTAL).filter((f) => f.endsWith('.js'))) {
    if (EXEMPT.has(file)) continue;
    const bad = violationsIn(readFileSync(join(PORTAL, file), 'utf8'));
    if (bad.length) offenders.push(`${file}: ${bad.join(', ')}`);
  }

  assert.deepEqual(offenders, [], `
Raw .append()/.prepend() stringifies null into the literal text "null".
Use mount(node, …) or el(tag, {}, [ … ]) — both drop null children.

  ${offenders.join('\n  ')}
`);
});

// The guard's own negative control. A check that cannot fail proves nothing,
// and this one is cheap to prove: the exact code that shipped.
test('the guard catches the bug that shipped', () => {
  const shipped = `
    const action = copy.action ? el('button', {}) : null;
    bar.append(icon('smartphone'), el('p', {}), action, el('button', {}));
  `;
  assert.deepEqual(violationsIn(shipped), ['action']);
});

test('the guard catches the same mistake written inline', () => {
  const inline = "bar.append(icon('x'), copy.action ? el('button', {}) : null);";
  assert.equal(violationsIn(inline).length, 1);
});

test('the guard does not object to the fixed version', () => {
  const fixed = `
    const action = copy.action ? el('button', {}) : null;
    mount(bar, icon('smartphone'), el('p', {}), action, el('button', {}));
  `;
  assert.deepEqual(violationsIn(fixed), []);
});

test('the guard leaves ordinary appends alone', () => {
  const ordinary = `
    const row = el('div', {});
    node.append(row, el('span', {}), document.createTextNode('hi'));
  `;
  assert.deepEqual(violationsIn(ordinary), []);
});
