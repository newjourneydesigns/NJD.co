// ---------------------------------------------------------------------------
// confirmPlan — how a confirmation dialog decides its own shape.
//
//   node --test tools/portal/*.test.mjs
//
// confirmModal itself builds DOM and so is not tested here; this repo tests
// logic and leaves rendering to the browser. confirmPlan is the branching half
// and is pure for exactly that reason.
//
// The rule worth defending is the focus one. A destructive dialog opens with
// Cancel focused, so that Return — pressed reflexively at a dialog that
// appeared under someone's finger — does not delete a client's record.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { confirmPlan } from '../../js/portal/ui.js';

test('a plain confirmation focuses the confirm button', () => {
  const plan = confirmPlan({
    title: 'Send this to the client?',
    body: 'They will get an email with a link to sign.',
    confirmLabel: 'Send',
  });
  assert.equal(plan.focus, 'confirm');
  assert.equal(plan.danger, false);
  assert.equal(plan.confirmLabel, 'Send');
  assert.deepEqual(plan.paragraphs, ['They will get an email with a link to sign.']);
});

test('a destructive confirmation focuses cancel instead', () => {
  const plan = confirmPlan({
    title: 'Delete this client?',
    body: 'Everything filed against them goes too. This cannot be undone.',
    confirmLabel: 'Delete client',
    tone: 'danger',
  });
  assert.equal(plan.focus, 'cancel', 'Return must not fall on the destructive button');
  assert.equal(plan.danger, true);
});

test('body accepts one string or several, and drops the blanks', () => {
  assert.deepEqual(confirmPlan({ body: 'One line.' }).paragraphs, ['One line.']);
  assert.deepEqual(
    confirmPlan({ body: ['First.', 'Second.'] }).paragraphs,
    ['First.', 'Second.']);
  // Callers build these conditionally; a falsy branch should not leave a gap.
  assert.deepEqual(
    confirmPlan({ body: ['Kept.', '', null, undefined, false, '   ', 'Also kept.'] }).paragraphs,
    ['Kept.', 'Also kept.']);
  assert.deepEqual(confirmPlan({}).paragraphs, []);
  assert.deepEqual(confirmPlan().paragraphs, []);
});

test('the defaults are neutral — a forgotten label never reads as a verb', () => {
  const plan = confirmPlan({});
  assert.equal(plan.title, 'Are you sure?');
  assert.equal(plan.confirmLabel, 'Continue');
  assert.equal(plan.cancelLabel, 'Cancel');
  assert.equal(plan.danger, false);
  assert.equal(plan.focus, 'confirm');
});

test('whitespace-only options fall back rather than rendering blank buttons', () => {
  const plan = confirmPlan({ title: '   ', confirmLabel: '  ', cancelLabel: '\t' });
  assert.equal(plan.title, 'Are you sure?');
  assert.equal(plan.confirmLabel, 'Continue');
  assert.equal(plan.cancelLabel, 'Cancel');
});

test('only the danger tone is destructive — an unknown tone is not', () => {
  for (const tone of [undefined, 'default', 'warning', 'DANGER', '', null]) {
    const plan = confirmPlan({ tone });
    assert.equal(plan.danger, false, `tone ${JSON.stringify(tone)} should not be destructive`);
    assert.equal(plan.focus, 'confirm');
  }
  assert.equal(confirmPlan({ tone: 'danger' }).danger, true);
});

test('a non-string title or label is ignored rather than stringified', () => {
  // el() would happily render "[object Object]" into a button.
  const plan = confirmPlan({ title: {}, confirmLabel: 42, cancelLabel: [] });
  assert.equal(plan.title, 'Are you sure?');
  assert.equal(plan.confirmLabel, 'Continue');
  assert.equal(plan.cancelLabel, 'Cancel');
});
