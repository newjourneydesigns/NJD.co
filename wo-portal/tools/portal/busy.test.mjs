// ---------------------------------------------------------------------------
// A control that writes to the database cannot be made to write twice.
//
// formModal's submit button has always disabled itself for the round trip.
// Buttons built by hand mostly did not, and this portal is used on a phone on
// a site visit: a second press while the first request is in flight removes a
// payment twice, or stops a timer that is already stopped — and the second
// call's failure is the only thing the person sees of an action that worked.
//
// busy() is the wrapper that closes that window. What is tested here is the
// part that is easy to get subtly wrong and impossible to see in a screenshot:
// the button is read off the event SYNCHRONOUSLY, because the DOM nulls
// `currentTarget` the moment dispatch ends, which is before the first await
// resolves. Read it late and the guard silently does nothing.
// ---------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';

import { busy } from '../../js/portal/ui.js';

/** The half of a button this wrapper touches, plus the DOM's habit of nulling
 *  `currentTarget` once dispatch is over. */
function fakeEvent(button) {
  const event = { currentTarget: button };
  // Mimic the real thing: the property is live only during dispatch.
  queueMicrotask(() => { event.currentTarget = null; });
  return event;
}

const makeButton = (text) => ({ textContent: text, disabled: false, isConnected: true });

test('a second press while the first is in flight does nothing', async () => {
  const button = makeButton('Remove');
  let calls = 0;
  const handler = busy(async () => {
    calls += 1;
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  });

  const first = handler(fakeEvent(button));
  const second = handler(fakeEvent(button));
  const third = handler(fakeEvent(button));
  await Promise.all([first, second, third]);

  assert.equal(calls, 1, 'three presses, one write');
});

test('the button is disabled and re-labelled while the write is in flight', async () => {
  const button = makeButton('Remove');
  let seen = null;
  const handler = busy(async () => {
    seen = { disabled: button.disabled, label: button.textContent };
  }, { label: 'Removing…' });

  await handler(fakeEvent(button));

  assert.deepEqual(seen, { disabled: true, label: 'Removing…' });
  assert.equal(button.disabled, false, 're-enabled afterwards');
  assert.equal(button.textContent, 'Remove', 'original caption restored');
});

test('a failed write puts the button back so it can be retried', async () => {
  const button = makeButton('Post it');
  const handler = busy(async () => { throw new Error('offline'); }, { label: 'Posting…' });

  await assert.rejects(handler(fakeEvent(button)), /offline/);
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, 'Post it');
});

test('the guard reopens after a failure rather than latching shut', async () => {
  const button = makeButton('Post it');
  let calls = 0;
  const handler = busy(async () => {
    calls += 1;
    if (calls === 1) throw new Error('offline');
  });

  await assert.rejects(handler(fakeEvent(button)), /offline/);
  await handler(fakeEvent(button));
  assert.equal(calls, 2, 'the retry actually ran');
});

test('a button removed from the page while the write ran is left alone', async () => {
  // The common success path: the handler closes its dialog or re-renders the
  // row, so this node is gone. Writing a caption back onto it is pointless and
  // resurrecting `disabled` on a detached node has caught people out before.
  const button = makeButton('Remove');
  const handler = busy(async () => { button.isConnected = false; }, { label: 'Removing…' });

  await handler(fakeEvent(button));

  assert.equal(button.disabled, true, 'left as it was');
  assert.equal(button.textContent, 'Removing…', 'caption not restored on a detached node');
});

test('the button is captured before the DOM nulls currentTarget', async () => {
  // The bug this rules out: reading event.currentTarget after the first await
  // yields null, the guard quietly stops disabling anything, and double
  // submission comes back with all the tests still green.
  const button = makeButton('Remove');
  const handler = busy(async () => {
    await new Promise((resolve) => { queueMicrotask(resolve); });
    // By now the event has been "dispatched" and currentTarget is null.
    assert.equal(button.disabled, true, 'still disabled after the event went stale');
  }, { label: 'Removing…' });

  await handler(fakeEvent(button));
  assert.equal(button.disabled, false);
});

test('it survives being wired to something with no button at all', async () => {
  // Called programmatically, or from a non-click event.
  let ran = false;
  const handler = busy(async () => { ran = true; });
  await handler(undefined);
  assert.equal(ran, true);
});

test('the handler’s return value is passed through', async () => {
  const button = makeButton('Go');
  const handler = busy(async () => 'done');
  assert.equal(await handler(fakeEvent(button)), 'done');
});
