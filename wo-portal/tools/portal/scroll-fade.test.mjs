// ---------------------------------------------------------------------------
// The edge hint on a sideways scroller tells the truth about both ends.
//
// .tabs and .section-nav scroll horizontally on a narrow screen and gave no
// sign of it — .tabs hides its scrollbar outright, and a phone's overlay
// scrollbar has faded by the time anyone looks. scroll-fade.js draws a fade at
// whichever edge has content past it.
//
// The arithmetic is what is tested here rather than the pixels, because the
// two ways this feature can lie are both arithmetic:
//
//   - a fade at an edge with nothing beyond it says "there is more over there"
//     when there is not, which is worse than no hint at all; and
//   - a fade that never switches off at the end of the travel says it forever.
//
// The end of the travel is the case that needs a tolerance and therefore the
// case a screenshot would not catch: scrollLeft is fractional under a device
// pixel ratio, so `scrollLeft + clientWidth` lands a hair short of scrollWidth
// at the hard stop on every zoom level that is not 100%.
// ---------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';

import { fadeState } from '../../js/portal/scroll-fade.js';

test('a bar whose content fits shows no fade at either end', () => {
  assert.deepEqual(fadeState({ scrollLeft: 0, scrollWidth: 308, clientWidth: 308 }),
    { start: false, end: false });
});

test('a sub-pixel overflow is not an overflow', () => {
  // Measured: .tabs at 390px reports scrollWidth === clientWidth. Rounding
  // elsewhere can leave a fraction, and a fade for half a pixel of content is
  // a lie with a rounding error behind it.
  assert.deepEqual(fadeState({ scrollLeft: 0, scrollWidth: 308.4, clientWidth: 308 }),
    { start: false, end: false });
});

test('a bar that fits shows nothing even if scrollLeft is somehow non-zero', () => {
  // Restoring a scroll position onto a bar that has since been widened.
  assert.deepEqual(fadeState({ scrollLeft: 40, scrollWidth: 300, clientWidth: 300 }),
    { start: false, end: false });
});

test('at the left of a scrollable bar only the end fades', () => {
  // The real measurement: the client record's section nav at 320px.
  assert.deepEqual(fadeState({ scrollLeft: 0, scrollWidth: 520, clientWidth: 238 }),
    { start: false, end: true });
});

test('mid-scroll both edges fade', () => {
  assert.deepEqual(fadeState({ scrollLeft: 120, scrollWidth: 520, clientWidth: 238 }),
    { start: true, end: true });
});

test('at the hard right-hand end the end fade switches off', () => {
  assert.deepEqual(fadeState({ scrollLeft: 282, scrollWidth: 520, clientWidth: 238 }),
    { start: true, end: false });
});

test('a fractional scrollLeft at the end still counts as the end', () => {
  // 520 - 238 = 282. A device pixel ratio of 2 can leave this at 281.5, and
  // without the tolerance the end fade never goes out.
  assert.deepEqual(fadeState({ scrollLeft: 281.5, scrollWidth: 520, clientWidth: 238 }),
    { start: true, end: false });
});

test('a fractional scrollLeft at the start still counts as the start', () => {
  assert.deepEqual(fadeState({ scrollLeft: 0.5, scrollWidth: 520, clientWidth: 238 }),
    { start: false, end: true });
});

test('one pixel in from either end is genuinely mid-scroll', () => {
  // The tolerance must not be so wide that it eats real travel: 4px from the
  // end is somewhere, and the hint has to say so at both edges.
  const mid = fadeState({ scrollLeft: 4, scrollWidth: 520, clientWidth: 238 });
  assert.deepEqual(mid, { start: true, end: true });
  const nearEnd = fadeState({ scrollLeft: 278, scrollWidth: 520, clientWidth: 238 });
  assert.deepEqual(nearEnd, { start: true, end: true });
});

test('a bar that has not been laid out yet shows nothing', () => {
  // scrollFade() may be attached before the node is in the document — project.js
  // does exactly that, building the tablist and filling it afterwards. Zeroes
  // must not produce a fade.
  assert.deepEqual(fadeState({ scrollLeft: 0, scrollWidth: 0, clientWidth: 0 }),
    { start: false, end: false });
});
