// ---------------------------------------------------------------------------
// Section nav — the sticky "on this page" bar for long stacked pages.
//
// The client record grew to eight panels, and finding Notes meant scrolling
// past all of them. This pins a row of jump links under the sticky portal
// header: click to land on a section, and the link for wherever you are stays
// highlighted so the bar doubles as a "where am I".
//
// Offsets are measured, not hard-coded — the header wraps taller on a phone —
// and land on the targets as scroll-margin-top, so both a click here and a
// hand-typed #hash arrive below the two sticky bars rather than under them.
// The links are real anchors: with JavaScript half-loaded they still work as
// plain in-page jumps.
// ---------------------------------------------------------------------------

import { el } from './ui.js';
import { scrollFade } from './scroll-fade.js';

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

/**
 * Build the bar. `entries` is [{ id, label, target }] in page order; each
 * target element is given its id here, so the caller cannot forget one.
 * Mount the returned nav once, above the first section.
 */
export function sectionNav(entries) {
  const links = new Map();

  const nav = el('nav', { class: 'section-nav', 'aria-label': 'On this page' },
    entries.map(({ id, label, target }) => {
      target.id = id;
      const link = el('a', {
        class: 'section-nav__link',
        href: `#${id}`,
        text: label,
        onclick: (event) => {
          // Let the browser handle modified clicks (new tab, etc.).
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          jumpTo(id, { smooth: true });
        },
      });
      links.set(id, link);
      return link;
    }));

  function jumpTo(id, { smooth = false } = {}) {
    const entry = entries.find((candidate) => candidate.id === id);
    if (!entry) return;
    const behavior = smooth && !window.matchMedia(REDUCED_MOTION).matches ? 'smooth' : 'auto';
    entry.target.scrollIntoView({ behavior, block: 'start' });
    // Keep the address shareable without adding a history entry per click.
    history.replaceState(null, '', `#${id}`);
  }

  // The two sticky bars a jump has to clear — the portal header (whose height
  // the CSS var from shell.js tracks; the bar's own `top` uses it) and this
  // bar itself. scroll-margin-top on the targets is what makes an anchor land
  // below both rather than under them.
  let clearance = 0;

  function measure() {
    const header = document.querySelector('.portal-header');
    const headerH = header ? Math.ceil(header.getBoundingClientRect().height) : 0;
    clearance = headerH + Math.ceil(nav.getBoundingClientRect().height);
    for (const { target } of entries) {
      target.style.scrollMarginTop = `${clearance + 8}px`;
    }
  }

  // Which section the reader is in: the last one whose top has passed the
  // bars. At the very bottom the final section wins outright, so a short
  // last panel can still light up.
  let ticking = false;

  function highlight() {
    ticking = false;

    const atBottom = window.innerHeight + window.scrollY
      >= document.documentElement.scrollHeight - 2;

    let current = entries[0];
    if (atBottom) {
      current = entries[entries.length - 1];
    } else {
      for (const entry of entries) {
        if (entry.target.getBoundingClientRect().top <= clearance + 16) current = entry;
      }
    }

    for (const [id, link] of links) {
      const on = current && current.id === id;
      link.classList.toggle('is-on', on);
      if (on) link.setAttribute('aria-current', 'true');
      else link.removeAttribute('aria-current');
      // Keep the lit link in view when the bar itself scrolls sideways — by
      // moving the bar's own scrollLeft and nothing else. scrollIntoView
      // variants are off limits here: they are allowed to scroll every
      // ancestor, and on WebKit they resolve a sticky bar against its layout
      // position near the top of the page — so the spy firing mid-jump would
      // yank the reader straight back up. That bug shipped once.
      if (on) revealLink(link);
    }
  }

  function revealLink(link) {
    const left = link.offsetLeft;
    const right = left + link.offsetWidth;
    if (left < nav.scrollLeft) nav.scrollLeft = Math.max(0, left - 16);
    else if (right > nav.scrollLeft + nav.clientWidth) {
      nav.scrollLeft = right - nav.clientWidth + 16;
    }
  }

  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(highlight);
  }

  function onResize() {
    measure();
    onScroll();
  }

  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onResize);

  // Eight sections do not fit in 320px and the bar gave no sign of it. The
  // fade has to be attached here rather than by the caller, because this
  // module is the only thing that knows the bar exists.
  scrollFade(nav);

  // Measure once the bar is actually in the document — offsetHeight of a
  // detached node is 0 and the margins would all be wrong.
  requestAnimationFrame(() => {
    measure();
    // A shared link or a reload arrives with a #hash the browser already tried
    // to honour before the panels had content. Do it again, properly, now.
    const wanted = window.location.hash.replace('#', '');
    if (wanted && links.has(wanted)) jumpTo(wanted);
    highlight();
  });

  return nav;
}
