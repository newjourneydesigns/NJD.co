// ---------------------------------------------------------------------------
// Reordering — the arithmetic behind the drag handle.
//
//   node --test tools/portal/reorder.test.mjs
//
// js/portal/reorder.js keeps its sums in pure functions precisely so they can
// be tested here: reorderPositions() decides which rows get written when a row
// is dragged from one index to another, and getting it wrong corrupts an order
// in the database rather than merely looking wrong.
//
// The last block does use a DOM — a hand-rolled one, about eighty lines at the
// bottom of this file, because the repo has no jsdom and no install step. It is
// there for one reason: after a keyboard move the list re-renders and the grip
// the user was standing on is destroyed, and if focus does not land on the
// moved row's new grip then keyboard reordering stops dead after one press
// without anything failing loudly.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  dropIndex,
  moveAnnouncement,
  moveItem,
  positionWriter,
  reorderList,
  reorderPositions,
  rowShift,
} from '../../js/portal/reorder.js';

const IDS = 'ABCDEFGH'.split('');

/** A list of rows with the given positions, ids A, B, C… in display order.
 *  Coerced the way Postgres would have handed them over: the column is
 *  `integer not null default 0`, so a null in a fixture means zero. */
function rowsOf(positions) {
  return positions.map((position, i) => ({ id: IDS[i], position: Number(position) || 0 }));
}

/**
 * Apply the writes and read the list back the way Postgres would: `order by
 * position, created_at`. Original array index stands in for created_at, which
 * is exactly what it is — the five call sites all select ascending by both, so
 * a row that has not moved keeps its place among equals.
 */
function orderAfter(positions, from, to) {
  const rows = rowsOf(positions);
  for (const { index, position } of reorderPositions(positions, from, to)) {
    rows[index].position = position;
  }
  return rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) => (a.row.position - b.row.position) || (a.i - b.i))
    .map(({ row }) => row.id)
    .join('');
}

/** What the order should be: the plain array move. */
function wanted(positions, from, to) {
  return moveItem(IDS.slice(0, positions.length), from, to).join('');
}

/** Every from→to pair on one shape of list has to land where it was asked to. */
function everyPair(positions, note) {
  const n = positions.length;
  for (let from = 0; from < n; from += 1) {
    for (let to = 0; to < n; to += 1) {
      assert.equal(
        orderAfter(positions, from, to),
        wanted(positions, from, to),
        `${note}: ${JSON.stringify(positions)} moving ${from}→${to}`,
      );
    }
  }
}

/** No write may repeat a number the row already had. */
function noWastedWrites(positions, from, to) {
  const writes = reorderPositions(positions, from, to);
  for (const { index, position } of writes) {
    assert.notEqual(position, positions[index],
      `${JSON.stringify(positions)} ${from}→${to} rewrote index ${index} with its own value`);
  }
  return writes;
}

// The solver
// ---------------------------------------------------------------------------

test('a one-step move onto an equal-position neighbour writes what the old rule wrote', () => {
  // The two lines every one of the seven copies of move() carried:
  //   a === b ? [[row.id, delta < 0 ? b - 1 : b + 1]] : [[row.id, b], [neighbour.id, a]]
  // Seeded rows share a position, and swapping equal numbers changes nothing.
  assert.deepEqual(reorderPositions([0, 0], 1, 0), [{ index: 1, position: -1 }]);
  assert.deepEqual(reorderPositions([0, 0], 0, 1), [{ index: 0, position: 1 }]);

  // And with a third row further down that is not involved.
  assert.deepEqual(reorderPositions([0, 0, 5], 1, 0), [{ index: 1, position: -1 }]);
  assert.deepEqual(reorderPositions([0, 0, 5], 0, 1), [{ index: 0, position: 1 }]);
});

test('a one-step move between distinct positions still ends up swapped', () => {
  // Tier one takes the gap when there is one, so the numbers differ from the
  // old straight swap. The order is what matters, and it is the same order.
  assert.equal(orderAfter([0, 1], 0, 1), 'BA');
  assert.equal(orderAfter([0, 1], 1, 0), 'BA');
  assert.equal(orderAfter([0, 10], 0, 1), 'BA');

  // Packed tight against a third row, there is no gap, and it really is the
  // old swap: the span hands its own two numbers back out.
  assert.deepEqual(reorderPositions([0, 1, 2], 0, 1), [
    { index: 1, position: 0 },
    { index: 0, position: 1 },
  ]);
});

test('dense positions: every from→to lands where it was asked to', () => {
  everyPair([0, 1, 2, 3, 4], 'dense');
});

test('all-equal positions: every from→to lands where it was asked to', () => {
  everyPair([0, 0, 0, 0, 0], 'all zero');
  everyPair([7, 7, 7, 7, 7], 'all seven');
  everyPair([0, 0], 'a pair of zeroes');
});

test('three rows at the same position: the middle really is the middle', () => {
  // The old rule got this wrong and nothing caught it. Moving the third of
  // three equal rows up one step wrote `0 - 1 = -1`, which sent it past the
  // first row to the top of the list instead of into second place.
  assert.equal(orderAfter([0, 0, 0], 2, 1), 'ACB');
  assert.equal(orderAfter([0, 0, 0], 0, 1), 'BAC');
  assert.equal(orderAfter([0, 0, 0, 0], 3, 1), 'ADBC');
});

test('duplicate positions in the middle of an otherwise numbered list', () => {
  everyPair([0, 1, 1, 3], 'one duplicated pair');
  everyPair([0, 0, 5, 5], 'two duplicated pairs');
  everyPair([2, 2, 2, 9], 'a run of three then a gap');
});

test('positions packed too tight for an integer fall back to a renumber', () => {
  // 0,1,1,2 leaves no room: not between the neighbours, not inside the span,
  // not above it and not below it. The whole list gets 0..n-1 instead.
  everyPair([0, 1, 1, 2], 'no headroom anywhere');

  const writes = reorderPositions([0, 1, 1, 2], 1, 2);
  assert.deepEqual(writes, [{ index: 1, position: 2 }, { index: 3, position: 3 }]);
  assert.equal(orderAfter([0, 1, 1, 2], 1, 2), 'ACBD');
});

test('sparse positions move with a single write', () => {
  everyPair([0, 10, 20, 30], 'sparse');
  assert.deepEqual(reorderPositions([0, 10, 20, 30], 0, 2), [{ index: 0, position: 21 }]);
  assert.deepEqual(reorderPositions([0, 10, 20, 30], 3, 1), [{ index: 3, position: 1 }]);
});

test('a drag from the top to the bottom and back is one write each way', () => {
  // Kept as real rows rather than bare numbers, because the point of the test
  // is the round trip: the second move is made against the list as the first
  // one left it, re-sorted, so the indexes mean different rows by then.
  let rows = [
    { id: 'A', position: 0 }, { id: 'B', position: 1 }, { id: 'C', position: 2 },
    { id: 'D', position: 3 }, { id: 'E', position: 4 },
  ];

  const apply = (from, to) => {
    const writes = reorderPositions(rows.map((row) => row.position), from, to);
    for (const { index, position } of writes) rows[index].position = position;
    rows = rows
      .map((row, i) => ({ row, i }))
      .sort((a, b) => (a.row.position - b.row.position) || (a.i - b.i))
      .map(({ row }) => row);
    return writes;
  };

  assert.deepEqual(apply(0, 4), [{ index: 0, position: 5 }]);
  assert.equal(rows.map((row) => row.id).join(''), 'BCDEA');

  // A is now last, at index 4 with position 5. Drag it back to the top.
  assert.deepEqual(apply(4, 0), [{ index: 4, position: 0 }]);
  assert.equal(rows.map((row) => row.id).join(''), 'ABCDE');
});

test('negatives and missing numbers are positions too', () => {
  everyPair([-3, -1, 4], 'negatives');
  everyPair([null, null, 2], 'nulls coerce to zero');
  everyPair([undefined, 0, 0], 'undefined coerces to zero');
});

test('an out-of-order list is renumbered rather than trusted', () => {
  // Nothing should ever hand this in — every call site selects ascending — but
  // a solver that silently produced a wrong answer here would be worse than one
  // that produced a boring correct one.
  const writes = reorderPositions([5, 3], 0, 1);
  assert.deepEqual(writes, [{ index: 1, position: 0 }, { index: 0, position: 1 }]);
  assert.equal(orderAfter([5, 3], 0, 1), 'BA');
});

test('a move that is not a move writes nothing', () => {
  assert.deepEqual(reorderPositions([0, 1, 2], 1, 1), []);
  assert.deepEqual(reorderPositions([0, 1, 2], -1, 0), []);
  assert.deepEqual(reorderPositions([0, 1, 2], 3, 0), []);
  assert.deepEqual(reorderPositions([0], 0, 0), []);
  assert.deepEqual(reorderPositions([], 0, 0), []);
  assert.deepEqual(reorderPositions([0, 1], 0, NaN), []);
});

test('a drop past the end of the list is clamped, not refused', () => {
  assert.equal(orderAfter([0, 1, 2], 0, 9), 'BCA');
  assert.equal(orderAfter([0, 1, 2], 2, -4), 'CAB');
  // Clamping onto the row's own index is a no-op, not a write. Both ends:
  // an unclamped index runs the solver off the edge of its own arrays and
  // comes back with a position of `undefined`, which Postgres would take.
  assert.deepEqual(reorderPositions([0, 1, 2], 2, 7), []);
  assert.deepEqual(reorderPositions([0, 1, 2], 0, -1), []);
  assert.deepEqual(reorderPositions([0, 1, 2], 0, -9), []);
});

test('only the rows whose position actually changes are written', () => {
  const shapes = [
    [0, 1, 2, 3, 4], [0, 0, 0, 0, 0], [0, 1, 1, 3], [0, 1, 1, 2],
    [0, 10, 20, 30], [7, 7, 7, 7, 7], [-3, -1, 4], [0, 0, 5, 5],
  ];
  for (const shape of shapes) {
    for (let from = 0; from < shape.length; from += 1) {
      for (let to = 0; to < shape.length; to += 1) noWastedWrites(shape, from, to);
    }
  }
});

test('the numbers never inflate beyond the move that was asked for', () => {
  // Repeatedly dragging the bottom row to the top, a hundred times, on a list
  // that starts dense. If the span rotation ever handed out fresh numbers
  // instead of redealing the list's own, this drifts without bound.
  let positions = [0, 1, 2, 3, 4];
  for (let i = 0; i < 100; i += 1) {
    const writes = reorderPositions(positions, 4, 0);
    const next = positions.slice();
    for (const { index, position } of writes) next[index] = position;
    positions = next
      .map((position, index) => ({ position, index }))
      .sort((a, b) => (a.position - b.position) || (a.index - b.index))
      .map(({ position }) => position);
  }
  assert.ok(Math.max(...positions) - Math.min(...positions) < 200,
    `positions drifted to ${JSON.stringify(positions)}`);
});

// The announcement
// ---------------------------------------------------------------------------

test('the announcement counts from one, the way a person does', () => {
  assert.equal(moveAnnouncement('Kickoff call', 1, 5), 'Moved Kickoff call to position 2 of 5.');
  assert.equal(moveAnnouncement('Kickoff call', 0, 5), 'Moved Kickoff call to position 1 of 5.');
  assert.equal(moveAnnouncement('Kickoff call', 4, 5), 'Moved Kickoff call to position 5 of 5.');
});

test('an unnamed row is still announced as something', () => {
  assert.equal(moveAnnouncement('', 0, 2), 'Moved item to position 1 of 2.');
  assert.equal(moveAnnouncement(null, 0, 2), 'Moved item to position 1 of 2.');
  assert.equal(moveAnnouncement('   ', 1, 2), 'Moved item to position 2 of 2.');
});

test('the announcement never reads out a position the list does not have', () => {
  assert.equal(moveAnnouncement('Row', 9, 3), 'Moved Row to position 3 of 3.');
  assert.equal(moveAnnouncement('Row', -2, 3), 'Moved Row to position 1 of 3.');
  assert.equal(moveAnnouncement('Row', 0, 0), 'Moved Row to position 1 of 1.');
});

// Where a drag drops
// ---------------------------------------------------------------------------

test('a drag drops where its own midpoint has got to', () => {
  const mids = [10, 30, 50, 70];

  // Dragged from the bottom up to between the first and second rows.
  assert.equal(dropIndex(mids, 3, 25), 1);
  // Barely moved: still in its own slot.
  assert.equal(dropIndex(mids, 3, 68), 3);
  // Dragged from the top down past two midpoints.
  assert.equal(dropIndex(mids, 0, 55), 2);
  assert.equal(dropIndex(mids, 0, 12), 0);
});

test('a drag past the ends of the list stops at the ends', () => {
  const mids = [10, 30, 50];
  assert.equal(dropIndex(mids, 1, -500), 0);
  assert.equal(dropIndex(mids, 1, 900), 2);
  assert.equal(dropIndex([], 0, 5), 0);
  assert.equal(dropIndex([10], 0, 500), 0);
});

test('resting exactly on a neighbour midpoint is not yet past it', () => {
  const mids = [10, 30, 50];
  assert.equal(dropIndex(mids, 0, 30), 0);
  assert.equal(dropIndex(mids, 2, 30), 2);
});

// The gap that opens up under a drag
// ---------------------------------------------------------------------------

test('only the rows the drag has passed over slide, and by one slot', () => {
  const mids = [10, 30, 50, 70];

  // Dragging row 0 down to index 2: rows 1 and 2 come up one slot, 3 sits still.
  assert.equal(rowShift(mids, 0, 2, 0), 0);
  assert.equal(rowShift(mids, 0, 2, 1), -20);
  assert.equal(rowShift(mids, 0, 2, 2), -20);
  assert.equal(rowShift(mids, 0, 2, 3), 0);

  // Dragging row 3 up to index 1: rows 1 and 2 go down one slot.
  assert.equal(rowShift(mids, 3, 1, 0), 0);
  assert.equal(rowShift(mids, 3, 1, 1), 20);
  assert.equal(rowShift(mids, 3, 1, 2), 20);
  assert.equal(rowShift(mids, 3, 1, 3), 0);

  // Not dragged anywhere yet: nothing moves.
  for (let i = 0; i < 4; i += 1) assert.equal(rowShift(mids, 2, 2, i), 0);
});

// The plain array move
// ---------------------------------------------------------------------------

test('moveItem lifts one out and drops it in', () => {
  assert.deepEqual(moveItem([1, 2, 3, 4], 0, 2), [2, 3, 1, 4]);
  assert.deepEqual(moveItem([1, 2, 3, 4], 3, 0), [4, 1, 2, 3]);
  assert.deepEqual(moveItem([1, 2, 3, 4], 1, 1), [1, 2, 3, 4]);
  assert.deepEqual(moveItem([1, 2, 3, 4], 0, 99), [2, 3, 4, 1]);
  assert.deepEqual(moveItem([1, 2, 3, 4], 9, 0), [1, 2, 3, 4]);
  assert.deepEqual(moveItem([1], 0, 0), [1]);

  // Array.splice reads a negative index from the end, so an unclamped -1 puts
  // the row second-to-last rather than leaving it where it already was.
  assert.deepEqual(moveItem([1, 2, 3, 4], 0, -1), [1, 2, 3, 4]);
  assert.deepEqual(moveItem([1, 2, 3, 4], 2, -1), [3, 1, 2, 4]);
});

test('moveItem does not touch the array it was given', () => {
  const before = [1, 2, 3];
  const after = moveItem(before, 0, 2);
  assert.deepEqual(before, [1, 2, 3]);
  assert.notEqual(before, after);
});

// Writing the order back
// ---------------------------------------------------------------------------

/** A Supabase-shaped stub: records every update it is asked to make. */
function stubClient(fail = null) {
  const calls = [];
  return {
    calls,
    from(table) {
      return {
        update(patch) {
          return {
            eq(column, value) {
              calls.push({ table, patch, column, value });
              const error = typeof fail === 'function' ? fail(calls.length) : null;
              return Promise.resolve({ error });
            },
          };
        },
      };
    },
  };
}

test('positionWriter writes the right ids, not the right indexes', () => {
  const client = stubClient();
  const rows = [
    { id: 'ida', position: 0 },
    { id: 'idb', position: 0 },
    { id: 'idc', position: 0 },
  ];
  let reloaded = 0;

  const write = positionWriter({
    client,
    table: 'client_contacts',
    rows: () => rows,
    after: () => { reloaded += 1; },
  });

  return write(2, 1).then((moved) => {
    assert.equal(moved, true);
    assert.equal(reloaded, 1);
    assert.deepEqual(client.calls, [
      { table: 'client_contacts', patch: { position: 1 }, column: 'id', value: 'idc' },
      { table: 'client_contacts', patch: { position: 2 }, column: 'id', value: 'idb' },
    ]);
  });
});

test('positionWriter stops at the first failed write and does not reload', async () => {
  const client = stubClient((n) => (n === 2 ? { message: 'nope' } : null));
  const rows = [
    { id: 'ida', position: 0 },
    { id: 'idb', position: 0 },
    { id: 'idc', position: 0 },
  ];
  let reloaded = 0;
  const seen = [];

  const write = positionWriter({
    client,
    table: 'waypoints',
    rows: () => rows,
    after: () => { reloaded += 1; },
    onError: (error) => seen.push(error.message),
  });

  assert.equal(await write(2, 1), false);
  assert.equal(reloaded, 0);
  assert.deepEqual(seen, ['nope']);
  assert.equal(client.calls.length, 2);
});

test('positionWriter reports a move it did not need to make as no move', async () => {
  const client = stubClient();
  let reloaded = 0;
  const write = positionWriter({
    client,
    table: 'quick_links',
    rows: () => [{ id: 'ida', position: 0 }, { id: 'idb', position: 1 }],
    after: () => { reloaded += 1; },
  });

  assert.equal(await write(1, 1), false);
  assert.equal(client.calls.length, 0);
  assert.equal(reloaded, 0);
});

// The grip, on a hand-rolled DOM
// ---------------------------------------------------------------------------

class FakeNode {
  constructor(tag, ns = null) {
    this.tagName = String(tag).toUpperCase();
    this.namespaceURI = ns;
    this.childNodes = [];
    this.parentElement = null;
    this.dataset = {};
    this.style = {};
    this.attributes = {};
    this.listeners = new Map();
    this.rect = { top: 0, height: 0 };
    this._text = '';
    this._class = '';
  }

  get children() { return this.childNodes.filter((node) => node instanceof FakeNode); }

  get className() { return this._class; }

  set className(value) { this._class = String(value); }

  get classList() {
    const names = () => this._class.split(/\s+/).filter(Boolean);
    return {
      add: (...add) => { this._class = [...new Set([...names(), ...add])].join(' '); },
      remove: (...drop) => { this._class = names().filter((n) => !drop.includes(n)).join(' '); },
      contains: (name) => names().includes(name),
    };
  }

  get textContent() {
    if (!this.childNodes.length) return this._text;
    return this.childNodes.map((node) => node.textContent).join('');
  }

  set textContent(value) { this._text = String(value); this.childNodes = []; }

  setAttribute(key, value) { this.attributes[key] = String(value); }

  getAttribute(key) { return key in this.attributes ? this.attributes[key] : null; }

  append(...kids) {
    for (const kid of kids) {
      if (kid instanceof FakeNode) kid.parentElement = this;
      this.childNodes.push(kid);
    }
  }

  /** What mount()/clear() do, plus the bit browsers do that matters here:
   *  removing the focused element drops focus back to the body. */
  empty() {
    const drop = (node) => {
      if (node === doc.activeElement) doc.activeElement = doc.body;
      node.children.forEach(drop);
    };
    this.children.forEach(drop);
    this.childNodes = [];
  }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }

  removeEventListener(type, fn) {
    const all = this.listeners.get(type) || [];
    const at = all.indexOf(fn);
    if (at >= 0) all.splice(at, 1);
  }

  focus() { doc.activeElement = this; }

  getBoundingClientRect() { return this.rect; }
}

class FakeText {
  constructor(data) { this.data = String(data); }

  get textContent() { return this.data; }
}

const doc = {
  body: new FakeNode('body'),
  documentElement: new FakeNode('html'),
  activeElement: null,
  createElement: (tag) => new FakeNode(tag),
  createElementNS: (ns, tag) => new FakeNode(tag, ns),
  createTextNode: (data) => new FakeText(data),
};
doc.activeElement = doc.body;

globalThis.document = doc;
globalThis.Node = FakeNode;
globalThis.window = { addEventListener() {}, removeEventListener() {} };

/** Press a key on a node, the way a browser would. */
function press(node, key) {
  const event = { key, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  for (const fn of node.listeners.get('keydown') || []) fn(event);
  return event;
}

/** Let the async run() settle. */
const settle = () => new Promise((resolve) => { setTimeout(resolve, 0); });

/** A list of labelled rows wired to a reorderList, re-rendering on every move. */
function scenario(labels) {
  const model = labels.slice();
  const listEl = doc.createElement('div');
  doc.body.append(listEl);

  const dnd = reorderList({
    noun: 'row',
    onReorder: (from, to) => {
      model.splice(0, model.length, ...moveItem(model, from, to));
      render();
      return true;
    },
  });

  function render() {
    listEl.empty();
    model.forEach((label, index) => {
      const row = doc.createElement('div');
      row.append(dnd.handle(index, label));
      listEl.append(row);
    });
    dnd.attach(listEl);
  }

  render();
  const grip = (index) => listEl.children[index].children[0];
  return { model, listEl, grip };
}

test('the grip is a labelled button carrying the Lucide grip', () => {
  const { grip } = scenario(['Kickoff call', 'Design review']);
  const node = grip(0);

  assert.equal(node.tagName, 'BUTTON');
  assert.equal(node.getAttribute('type'), 'button');
  assert.equal(node.getAttribute('aria-label'), 'Reorder Kickoff call');
  assert.equal(node.className, 'reorder-handle');
  assert.equal(node.dataset.reorderIndex, '0');
  assert.ok(node.getAttribute('aria-describedby'));

  // One <svg> of six circles — grip-vertical, from js/portal/icons.js.
  const svg = node.children[0];
  assert.equal(svg.tagName, 'SVG');
  assert.equal(svg.getAttribute('aria-hidden'), 'true');
  assert.equal(svg.children.length, 6);
});

test('attach marks each row so the CSS can reserve the grip its lane', () => {
  const { listEl } = scenario(['One', 'Two', 'Three']);
  for (const row of listEl.children) {
    assert.ok(row.classList.contains('is-reorderable'), 'row should be marked reorderable');
  }
});

test('ArrowUp moves the row and focus follows it to its new grip', async () => {
  const { model, grip } = scenario(['One', 'Two', 'Three', 'Four']);

  const before = grip(2);
  before.focus();
  const event = press(before, 'ArrowUp');
  await settle();

  assert.equal(event.defaultPrevented, true, 'the page must not scroll');
  assert.deepEqual(model, ['One', 'Three', 'Two', 'Four']);

  // The grip the user was standing on no longer exists — the list re-rendered.
  const after = grip(1);
  assert.notEqual(after, before, 'the re-render should have built a new grip');
  assert.equal(doc.activeElement, after, 'focus must land on the moved row');
  assert.equal(after.getAttribute('aria-label'), 'Reorder Three');
});

test('ArrowDown, Home and End all keep the focus with the row', async () => {
  const { model, grip } = scenario(['One', 'Two', 'Three', 'Four']);

  grip(0).focus();
  press(grip(0), 'ArrowDown');
  await settle();
  assert.deepEqual(model, ['Two', 'One', 'Three', 'Four']);
  assert.equal(doc.activeElement, grip(1));

  press(grip(1), 'End');
  await settle();
  assert.deepEqual(model, ['Two', 'Three', 'Four', 'One']);
  assert.equal(doc.activeElement, grip(3));

  press(grip(3), 'Home');
  await settle();
  assert.deepEqual(model, ['One', 'Two', 'Three', 'Four']);
  assert.equal(doc.activeElement, grip(0));
});

test('an arrow key at the end of the list still swallows the scroll', async () => {
  const { model, grip } = scenario(['One', 'Two']);

  const top = press(grip(0), 'ArrowUp');
  const bottom = press(grip(1), 'ArrowDown');
  const home = press(grip(0), 'Home');
  await settle();

  assert.equal(top.defaultPrevented, true);
  assert.equal(bottom.defaultPrevented, true);
  assert.equal(home.defaultPrevented, true);
  assert.deepEqual(model, ['One', 'Two'], 'nothing should have moved');
});

test('a key the grip does not own is left alone', async () => {
  const { model, grip } = scenario(['One', 'Two']);
  const event = press(grip(0), 'Tab');
  await settle();
  assert.equal(event.defaultPrevented, false);
  assert.deepEqual(model, ['One', 'Two']);
});

test('every move is spoken into a polite live region', async () => {
  const { grip } = scenario(['Kickoff call', 'Design review', 'Handover']);

  grip(0).focus();
  press(grip(0), 'End');
  await settle();

  const regions = [];
  const walk = (node) => {
    if (node.getAttribute && node.getAttribute('aria-live')) regions.push(node);
    (node.children || []).forEach(walk);
  };
  walk(doc.body);

  assert.ok(regions.length, 'the module should have made a live region');
  const live = regions[regions.length - 1];
  assert.equal(live.getAttribute('aria-live'), 'polite');
  assert.equal(live.textContent, 'Moved Kickoff call to position 3 of 3.');
});

test('reorderList refuses to be built without somewhere to send the move', () => {
  assert.throws(() => reorderList({ noun: 'row' }), /onReorder/);
});
