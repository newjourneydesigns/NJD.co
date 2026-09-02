// ---------------------------------------------------------------------------
// Reordering a list — one grip, three ways to drive it
//
// This replaces the Move up / Move down pair that used to sit in seven row
// toolbars, each with its own copy of the same move() body. What the buttons
// did well was be obvious and be reachable from a keyboard; what they did badly
// was take two controls, two labels and two disabled states out of every row to
// express one idea. A single grip at the row's leading edge says "this list has
// an order and you may change it" once, and then gets out of the way.
//
// Three input paths, one model:
//
//   - Pointer. Mouse, touch and pen through Pointer Events and
//     setPointerCapture, deliberately NOT the HTML5 drag-and-drop API: that one
//     does not fire on touch at all and cannot be styled. `touch-action: none`
//     is set on the grip and only on the grip, so a finger anywhere else on the
//     row still scrolls the page.
//   - Keyboard. With the grip focused, ArrowUp / ArrowDown move the row one
//     step and Home / End send it to an end — immediately, on the keystroke.
//     There is no pick-up-then-drop mode, because a mode is a state a user can
//     be stranded in, and because moving on the keystroke is exactly the
//     capability the two buttons had.
//   - Screen reader. Every move writes a sentence into an aria-live region:
//     "Moved Kickoff call to position 2 of 5." One region per list, made here,
//     parked on <body> so a re-render cannot take it away mid-announcement.
//
// After a keyboard move the list re-renders and the grip the user was standing
// on is destroyed. Focus has to land on the moved row's NEW grip or keyboard
// reordering silently stops working after one press — see restoreFocus(), and
// the test that holds it down.
//
// The arithmetic is deliberately kept out of the DOM half: reorderPositions(),
// moveAnnouncement(), dropIndex(), rowShift() and moveItem() are pure and are
// tested in tools/portal/reorder.test.mjs with no browser anywhere near them.
// ---------------------------------------------------------------------------

import { el } from './ui.js';
import { icon } from './icons.js';

// The arithmetic
// ---------------------------------------------------------------------------

/** The coercion every one of the old move() bodies used: `Number(x) || 0`. */
function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function clamp(value, low, high) {
  return Math.min(Math.max(value, low), high);
}

/** A copy of `list` with the item at `from` lifted out and dropped in at `to`. */
export function moveItem(list, from, to) {
  const next = Array.from(list || []);
  const n = next.length;
  if (n < 2) return next;
  if (!Number.isFinite(from) || !Number.isFinite(to)) return next;
  const src = Math.trunc(from);
  if (src < 0 || src >= n) return next;
  const dest = clamp(Math.trunc(to), 0, n - 1);
  if (dest === src) return next;
  const [row] = next.splice(src, 1);
  next.splice(dest, 0, row);
  return next;
}

/**
 * The smallest integer strictly between two positions, or null when the two are
 * packed tight enough that no integer fits. A null bound means "no neighbour on
 * that side", which is unbounded.
 */
function slotBetween(left, right) {
  if (left === null && right === null) return null;
  if (left === null) {
    const x = Math.ceil(right) - 1;
    return x < right ? x : null;
  }
  if (right === null) {
    const x = Math.floor(left) + 1;
    return x > left ? x : null;
  }
  const x = Math.floor(left) + 1;
  return x > left && x < right ? x : null;
}

/** Is this list already in the ascending order every caller selects it in? */
function ascending(p) {
  for (let i = 1; i < p.length; i += 1) if (p[i] < p[i - 1]) return false;
  return true;
}

/**
 * Hand out `pool` (ascending, possibly with repeats) as a strictly ascending
 * run that fits in the open interval (before, after). Returns null when integer
 * arithmetic has nowhere to put them.
 */
function spread(pool, before, after) {
  const up = pool.slice();
  if (before !== null && up[0] <= before) up[0] = Math.floor(before) + 1;
  for (let i = 1; i < up.length; i += 1) {
    if (up[i] <= up[i - 1]) up[i] = Math.floor(up[i - 1]) + 1;
  }
  if (after === null || up[up.length - 1] < after) return up;

  // No headroom above; try the same walk downwards from the ceiling.
  const down = pool.slice();
  const last = down.length - 1;
  if (down[last] >= after) down[last] = Math.ceil(after) - 1;
  for (let i = last - 1; i >= 0; i -= 1) {
    if (down[i] >= down[i + 1]) down[i] = Math.ceil(down[i + 1]) - 1;
  }
  if (before === null || down[0] > before) return down;
  return null;
}

/** The last resort: 0..n-1 down the list in its new order. Always correct. */
function renumber(p, src, dest) {
  const order = p.map((_, i) => i);
  const [moving] = order.splice(src, 1);
  order.splice(dest, 0, moving);

  const out = [];
  order.forEach((index, rank) => {
    if (p[index] !== rank) out.push({ index, position: rank });
  });
  return out;
}

/**
 * Which rows have to be written to move the row at `from` to index `to`.
 *
 * `positions` is the list's `position` column in display order — that is, the
 * ascending order every call site selects it in. Returns
 * `[{ index, position }]`, where `index` is an index into `positions`, and only
 * for the rows whose number actually changes.
 *
 * This is the generalisation of the two-line rule the seven copies of move()
 * all carried:
 *
 *     const writes = a === b
 *       ? [[row.id, delta < 0 ? b - 1 : b + 1]]
 *       : [[row.id, b], [neighbour.id, a]];
 *
 * That rule only knows how to trade places with an adjacent row, and a drag
 * moves several places at once. Two tiers replace it:
 *
 *   1. **Nudge.** Look at the two rows the moved row will land between and take
 *      an integer strictly between them. One write, and for a one-step move
 *      onto an equal-position neighbour it produces exactly the `b - 1` /
 *      `b + 1` the old rule did. Strictly between matters: rows sharing a
 *      position fall back to the created_at tiebreak, which we do not control,
 *      so landing ON a neighbour's number is not landing anywhere.
 *   2. **Rotate the span.** When the neighbours are packed tight (0 and 1, or
 *      the equal numbers seeded rows carry), hand the span's own numbers back
 *      out in ascending order to the span's new order. For a two-row span that
 *      is the old swap, exactly; for a longer one it is the same idea, and
 *      because it only ever redeals numbers the list already had, positions
 *      never inflate. Repeats inside the span get spread apart, which is the
 *      "nudge, not swap" property applied to more than two rows.
 *
 * If integer arithmetic cannot fit the span between its neighbours — positions
 * 0,1,1,2 leave no room anywhere — the whole list is renumbered 0..n-1. That is
 * also what an out-of-order input gets, so the function is total.
 *
 * Note this fixes a bug the old rule had beyond two rows: three rows all at
 * position 0, third moved up one step, wrote `0 - 1 = -1` and sent the row to
 * the TOP rather than the middle. Nothing had noticed, because nothing tested
 * a third equal row.
 */
export function reorderPositions(positions, from, to) {
  const p = (positions || []).map(num);
  const n = p.length;
  if (n < 2) return [];
  if (!Number.isFinite(from) || !Number.isFinite(to)) return [];

  const src = Math.trunc(from);
  if (src < 0 || src >= n) return [];
  const dest = clamp(Math.trunc(to), 0, n - 1);
  if (dest === src) return [];

  if (!ascending(p)) return renumber(p, src, dest);

  // Tier 1 — nudge into the gap between the new neighbours.
  const rest = p.slice(0, src).concat(p.slice(src + 1));
  const left = dest > 0 ? rest[dest - 1] : null;
  const right = dest < n - 1 ? rest[dest] : null;
  const slot = slotBetween(left, right);
  if (slot !== null) return slot === p[src] ? [] : [{ index: src, position: slot }];

  // Tier 2 — redeal the moving span's own numbers.
  const lo = Math.min(src, dest);
  const hi = Math.max(src, dest);

  const span = [];
  for (let i = lo; i <= hi; i += 1) span.push(i);
  const [moving] = span.splice(src - lo, 1);
  span.splice(dest - lo, 0, moving);

  const pool = p.slice(lo, hi + 1).sort((a, b) => a - b);
  const before = lo > 0 ? p[lo - 1] : null;
  const after = hi < n - 1 ? p[hi + 1] : null;
  const q = spread(pool, before, after);

  if (!q) return renumber(p, src, dest);

  const out = [];
  for (let j = 0; j < span.length; j += 1) {
    if (q[j] !== p[span[j]]) out.push({ index: span[j], position: q[j] });
  }
  return out;
}

/** What the live region says after a move. 1-based, because a person is. */
export function moveAnnouncement(label, to, total) {
  const name = String(label == null ? '' : label).trim() || 'item';
  const size = Math.max(Number(total) || 0, 1);
  const place = clamp(Math.trunc(Number(to) || 0), 0, size - 1) + 1;
  return `Moved ${name} to position ${place} of ${size}.`;
}

/**
 * Where a drag would drop.
 *
 * `mids` is every row's vertical midpoint in display order, measured once when
 * the drag starts — nothing reflows during a drag, so they stay true. `y` is
 * the dragged row's own projected midpoint, not the pointer's: grabbing a tall
 * row near its bottom edge should not mean it is already halfway into the next
 * slot.
 */
export function dropIndex(mids, from, y) {
  const n = (mids || []).length;
  if (!n) return 0;
  let to = clamp(Math.trunc(Number(from) || 0), 0, n - 1);
  while (to > 0 && y < mids[to - 1]) to -= 1;
  while (to < n - 1 && y > mids[to + 1]) to += 1;
  return to;
}

/**
 * How far a row that is NOT being dragged should slide while the dragged row
 * hovers over index `to` — the gap opening up ahead of the drop. Zero for every
 * row outside the span, and for the dragged row itself.
 */
export function rowShift(mids, from, to, index) {
  if (index === from) return 0;
  if (to > from && index > from && index <= to) return mids[index - 1] - mids[index];
  if (to < from && index >= to && index < from) return mids[index + 1] - mids[index];
  return 0;
}

// The grip
// ---------------------------------------------------------------------------

/** How long after a move we will still put focus back on the moved row. */
const FOCUS_WINDOW_MS = 1500;

let seq = 0;

/**
 * One reorderable list.
 *
 *     const dnd = reorderList({ noun: 'contact', onReorder });
 *     children.unshift(dnd.handle(index, row.name));   // building each row
 *     dnd.attach(listEl);                              // at the end of render
 *
 * `attach()` belongs at the end of every render, not just the first: it is what
 * pairs this render's grips with their rows, and what puts focus back after a
 * keyboard move. `onReorder(from, to)` may be async, and may return false to
 * say the move did not happen (a failed write) — in which case nothing is
 * announced. It owns its own error reporting; the five database call sites
 * toast through positionWriter's onError.
 *
 * The rows are assumed to be the list element's own children, one grip each.
 * Every call site renders either all rows with grips or none at all, which is
 * what makes that safe.
 */
export function reorderList({ noun = 'item', onReorder } = {}) {
  if (typeof onReorder !== 'function') {
    throw new Error('reorderList needs an onReorder(from, to) function.');
  }

  const hintId = `reorder-hint-${(seq += 1)}`;

  let listEl = null;
  let handles = [];
  let building = [];
  let liveEl = null;
  let busy = false;
  let pending = null;

  /** The live region and the shared keyboard hint, made once, kept on <body>
   *  so a re-render of the list cannot delete them out from under a reader. */
  function region() {
    if (liveEl) return liveEl;
    liveEl = el('div', { 'aria-live': 'polite', 'aria-atomic': 'true' });
    document.body.append(el('div', { class: 'visually-hidden' }, [
      el('span', {
        id: hintId,
        text: 'Press the up and down arrow keys to move it, Home or End to send it to an end.',
      }),
      liveEl,
    ]));
    return liveEl;
  }

  function announce(text) {
    const live = region();
    // Blank it first: a reader may skip a live region whose text has not
    // changed, and pressing End twice produces the same sentence twice.
    live.textContent = '';
    live.textContent = text;
  }

  /** The row a grip belongs to: whichever ancestor is the list's own child. */
  function rowOf(node) {
    if (!listEl) return null;
    let cur = node;
    while (cur && cur.parentElement && cur.parentElement !== listEl) cur = cur.parentElement;
    return cur && cur.parentElement === listEl ? cur : null;
  }

  function handleAt(index) {
    return handles.find((node) => Number(node.dataset.reorderIndex) === index) || null;
  }

  function restoreFocus() {
    if (!pending) return;
    if (Date.now() > pending.until) { pending = null; return; }

    // Only step in when the focused element was destroyed by the re-render —
    // if the user has moved on to something else, leave them alone. Not
    // clearing `pending` on the way out is deliberate: a second render (the
    // realtime channel echoing our own write back) has to be caught too.
    const active = document.activeElement;
    if (active && active !== document.body
      && active !== document.documentElement && active !== listEl) return;

    const next = handleAt(pending.index);
    if (next) next.focus();
  }

  async function run(from, to, label) {
    if (busy) return;
    busy = true;

    const total = handles.length;
    pending = { index: to, until: Date.now() + FOCUS_WINDOW_MS };

    let moved = false;
    try {
      moved = (await onReorder(from, to)) !== false;
    } catch {
      // onReorder reports its own failures; all this end has to do is not
      // claim a move that did not happen.
      moved = false;
    } finally {
      busy = false;
    }

    if (!moved) { pending = null; return; }
    announce(moveAnnouncement(label, to, total));
    restoreFocus();
  }

  function onKeydown(event, index, label) {
    let to = null;
    if (event.key === 'ArrowUp') to = index - 1;
    else if (event.key === 'ArrowDown') to = index + 1;
    else if (event.key === 'Home') to = 0;
    else if (event.key === 'End') to = handles.length - 1;
    else return;

    // Always, even when the move is a no-op: these four keys scroll the page,
    // and a grip at the top of a list that scrolls away when you press Up is
    // worse than one that does nothing.
    event.preventDefault();

    if (to === index || to < 0 || to > handles.length - 1) return;
    run(index, to, label);
  }

  function beginDrag(event, node, index, label) {
    if (busy) return;
    if (typeof event.button === 'number' && event.button > 0) return;
    if (!listEl || handles.length < 2) return;

    const rows = handles.map(rowOf);
    if (rows.some((row) => !row)) return;

    const mids = rows.map((row) => {
      const box = row.getBoundingClientRect();
      return box.top + box.height / 2;
    });
    const startY = event.clientY;
    const dragged = rows[index];
    let to = index;

    try { node.setPointerCapture(event.pointerId); } catch { /* not captured; still works */ }
    event.preventDefault();
    // The pointer path leaves the grip focused, so a drag can be finished off
    // with the arrow keys without hunting for it again.
    node.focus();
    listEl.classList.add('is-reordering');
    dragged.classList.add('reorder-row--dragging');

    const onMove = (moveEvent) => {
      const dy = moveEvent.clientY - startY;
      dragged.style.transform = `translateY(${dy}px)`;
      const next = dropIndex(mids, index, mids[index] + dy);
      if (next === to) return;
      to = next;
      rows.forEach((row, i) => {
        if (i === index) return;
        const shift = rowShift(mids, index, to, i);
        row.style.transform = shift ? `translateY(${shift}px)` : '';
      });
    };

    const finish = (commit) => {
      node.removeEventListener('pointermove', onMove);
      node.removeEventListener('pointerup', onUp);
      node.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onEscape, true);
      try { node.releasePointerCapture(event.pointerId); } catch { /* already gone */ }

      rows.forEach((row) => { row.style.transform = ''; });
      dragged.classList.remove('reorder-row--dragging');
      listEl.classList.remove('is-reordering');

      if (commit && to !== index) run(index, to, label);
    };

    const onUp = () => finish(true);
    const onCancel = () => finish(false);
    const onEscape = (keyEvent) => {
      if (keyEvent.key !== 'Escape') return;
      keyEvent.preventDefault();
      finish(false);
    };

    node.addEventListener('pointermove', onMove);
    node.addEventListener('pointerup', onUp);
    node.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onEscape, true);
  }

  /**
   * The grip for one row. `label` is what the row is called — a contact's name,
   * a waypoint's title — and is both the accessible name of the control and the
   * subject of the announcement, so it is worth passing something real.
   */
  function handle(index, label) {
    const name = String(label == null ? '' : label).trim() || noun;

    const node = el('button', {
      class: 'reorder-handle',
      type: 'button',
      draggable: 'false',
      'aria-label': `Reorder ${name}`,
      'aria-describedby': hintId,
      dataset: { reorderIndex: String(index) },
    }, [icon('grip-vertical', { size: 18 })]);

    node.addEventListener('keydown', (event) => onKeydown(event, index, name));
    node.addEventListener('pointerdown', (event) => beginDrag(event, node, index, name));

    building.push(node);
    return node;
  }

  /**
   * Call at the end of every render, once the rows are in the document —
   * including the render that draws an empty state, which is how the grips of
   * the render before get forgotten. `null` is allowed and means exactly that:
   * this render drew no list.
   */
  function attach(node) {
    listEl = node || null;
    handles = building;
    building = [];

    for (const grip of handles) {
      const row = rowOf(grip);
      // The class is what reserves the grip's lane in css/portal.css, so it has
      // to go on whichever element is actually the list's child — which differs
      // per call site, and is not something the row builders should have to
      // know about.
      if (row) row.classList.add('is-reorderable');
    }

    restoreFocus();
  }

  return { handle, attach };
}

// Persisting an order
// ---------------------------------------------------------------------------

/**
 * An `onReorder` that writes the new order to a `position` column.
 *
 * Five of the seven lists are this shape and used to carry a byte-identical
 * copy of it each:
 *
 *     onReorder: positionWriter({
 *       client: supabase,
 *       table: 'client_contacts',
 *       rows: () => contacts,
 *       after: () => reload(loadContacts, renderContacts),
 *       onError: (error) => toast(errorMessage(error), 'error'),
 *     })
 *
 * `client` is the Supabase client, passed in rather than imported so that this
 * module stays importable by the tests without a browser or a session. `rows`
 * may be an array or a function returning one — a function, at every call site,
 * because the array is replaced wholesale on every reload.
 */
export function positionWriter({ client, table, rows, after, onError }) {
  return async (from, to) => {
    const list = typeof rows === 'function' ? rows() : rows;
    const writes = reorderPositions((list || []).map((row) => row.position), from, to);
    if (!writes.length) return false;

    try {
      for (const { index, position } of writes) {
        const { error } = await client.from(table).update({ position }).eq('id', list[index].id);
        if (error) throw error;
      }
    } catch (error) {
      if (onError) onError(error);
      return false;
    }

    if (after) await after();
    return true;
  };
}
