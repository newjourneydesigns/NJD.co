// ---------------------------------------------------------------------------
// The edge hint on a sideways scroller.
//
// .section-nav scrolls horizontally on a narrow screen and gives no sign that
// anything is out there: it hides its scrollbar on a phone, and an overlay
// scrollbar there has faded away by the time anyone looks. This
// turns on a fade at whichever edge actually has content past it — see the
// `.scroll-fade` rules in portal.css for why it is a pseudo-element and not a
// mask.
//
// `scroll-timeline` would do this with no script at all, and support is not
// broad enough to rely on yet. So: one passive scroll listener, a ResizeObserver
// for the width changing under it, and no work at all when nothing overflows.
// ---------------------------------------------------------------------------

/**
 * Which edges have content beyond them.
 *
 * Split out from the DOM so the arithmetic can be tested without a browser —
 * the off-by-one at the end of the travel is the whole point of this function,
 * and it is not something a screenshot would catch.
 *
 * The 1px tolerance is not slack: a scroller's scrollLeft is fractional under
 * a device pixel ratio, and `scrollLeft + clientWidth` lands a fraction short
 * of scrollWidth at the hard end of the travel on every zoom level that is not
 * 100%. Without it the end fade never switches off, which is precisely the
 * "there is more over there" lie this exists to stop telling.
 */
export function fadeState({ scrollLeft, scrollWidth, clientWidth }) {
  // Nothing overflows: no hint at either end, whatever scrollLeft claims.
  if (scrollWidth - clientWidth <= 1) return { start: false, end: false };
  const max = scrollWidth - clientWidth;
  return {
    start: scrollLeft > 1,
    end: scrollLeft < max - 1,
  };
}

/**
 * Attach the hint to a scroller. Adds the `.scroll-fade` class itself, so a
 * caller cannot wire the script and forget the styling.
 *
 * Returns a teardown function. Every current caller lives for the life of its
 * page render, but a bar that is re-rendered must not leave its observer
 * watching a detached node.
 */
export function scrollFade(node) {
  if (!node) return () => {};
  node.classList.add('scroll-fade');

  let frame = 0;

  function apply() {
    frame = 0;
    const { start, end } = fadeState(node);
    node.classList.toggle('is-fade-start', start);
    node.classList.toggle('is-fade-end', end);
  }

  // Scroll fires far faster than the screen repaints, and all this does is
  // toggle two classes — so coalesce to one read per frame and never read
  // layout inside the event itself.
  function schedule() {
    if (frame) return;
    frame = requestAnimationFrame(apply);
  }

  node.addEventListener('scroll', schedule, { passive: true });

  // Two different things change the answer and only one of them is a resize.
  //
  // ResizeObserver catches the viewport narrowing, and also the 0 → laid-out
  // transition when a bar built detached is finally inserted — which is why a
  // caller may attach this before appending anything.
  //
  // It does NOT catch a tab being added: the bar's border box is set by its
  // parent's width, so its content growing past that width changes scrollWidth
  // and resizes nothing. A childList MutationObserver is what covers that, and
  // it costs nothing until the structure actually changes.
  let resize = null;
  if (typeof ResizeObserver === 'function') {
    resize = new ResizeObserver(schedule);
    resize.observe(node);
  }

  let mutations = null;
  if (typeof MutationObserver === 'function') {
    mutations = new MutationObserver(schedule);
    mutations.observe(node, { childList: true, subtree: true, characterData: true });
  }

  apply();

  return () => {
    if (frame) cancelAnimationFrame(frame);
    node.removeEventListener('scroll', schedule);
    if (resize) resize.disconnect();
    if (mutations) mutations.disconnect();
  };
}
