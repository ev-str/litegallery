import assert from 'node:assert/strict';
import test from 'node:test';

import {createLoadQueue} from '../../web/load-queue.js';
import {
  createMediaWindow, neighbourIndex, rangeCovers, rangePadding, rowLayout, visibleRows, WINDOW_MIN_ITEMS, windowRange,
} from '../../web/media-window.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

// Rows of 100 px tiles with a 10 px gap; date headings are 30 px tall.
const uniform = (total, columns) => rowLayout({total, columns, tile: 100, rowGap: 10});
const grouped = (counts, columns) => rowLayout({total: counts.reduce((sum, count) => sum + count, 0), columns, tile: 100, rowGap: 10, heading: 30, groups: counts.map((count, index) => ({label: `G${index}`, count}))});

test('visible rows follow the band and include partly visible rows', () => {
  // Row r spans [110 r, 110 r + 100).
  const layout = uniform(50, 1);
  const rows = (top, bottom) => visibleRows(layout, top, bottom);
  assert.deepEqual(rows(0, 500), {first: 0, last: 4});
  assert.deepEqual(rows(105, 215), {first: 1, last: 1});
  assert.deepEqual(rows(99, 221), {first: 0, last: 2});
  assert.deepEqual(rows(-800, -100), {first: 0, last: 0});
  assert.deepEqual(rows(10_000, 10_500), {first: 49, last: 49});
});

test('a grouped layout starts every group with a heading row and a new tile row', () => {
  // Groups of 3, 7, and 2 items in 5 columns: H0, [0-2], H1, [3-7], [8-9], H2, [10-11].
  const layout = grouped([3, 7, 2], 5);
  assert.equal(layout.rows, 7);
  assert.deepEqual([...layout.heading], [1, 0, 1, 0, 0, 1, 0]);
  assert.deepEqual([...layout.itemStart], [0, 0, 3, 3, 8, 10, 10, 12]);
  assert.deepEqual([...layout.top], [0, 40, 150, 190, 300, 410, 450]);
  assert.deepEqual([...layout.group], [0, 0, 1, 1, 1, 2, 2]);
  assert.deepEqual([...layout.groupRow], [0, 2, 5]);
  assert.equal(layout.height, 550);
  assert.equal(layout.itemRow[7], 3);
  assert.equal(layout.itemRow[8], 4);
  // A band that starts inside the heading of group 1 sees that heading first.
  assert.deepEqual(visibleRows(layout, 160, 320), {first: 2, last: 4});
  assert.deepEqual(visibleRows(layout, 135, 150), {first: 1, last: 1});
});

test('a short row is as tall as the tracks it fills, not the widest track', () => {
  // Subpixel tracks: the middle column is the widest. Groups of 7 in 3 columns end with a one-tile row.
  const layout = rowLayout({total: 14, columns: 3, tile: 100.5, tracks: [100, 100.5, 100], rowGap: 10, heading: 30, groups: [{label: 'G0', count: 7}, {label: 'G1', count: 7}]});
  assert.deepEqual([...layout.size], [30, 100.5, 100.5, 100, 30, 100.5, 100.5, 100]);
  assert.equal(layout.top[4], 30 + 100.5 + 100.5 + 100 + 4 * 10);
  // Without measured tracks every row is a tile tall.
  assert.deepEqual([...rowLayout({total: 4, columns: 3, tile: 100.5, rowGap: 10}).size], [100.5, 100.5]);
});

test('the window is row-aligned, padded by extra rows, and clamped to the list', () => {
  assert.deepEqual(windowRange({rows: 200, visible: {first: 10, last: 14}, extra: 3}), {start: 7, end: 18});
  assert.deepEqual(windowRange({rows: 200, visible: {first: 1, last: 2}, extra: 3}), {start: 0, end: 6});
  assert.deepEqual(windowRange({rows: 201, visible: {first: 199, last: 200}, extra: 3}), {start: 196, end: 201});
});

test('the rendered range is kept while it covers the visible rows with a margin', () => {
  const covers = (range, visible) => rangeCovers({range, rows: 200, visible, margin: 2});
  assert.equal(covers({start: 7, end: 18}, {first: 10, last: 14}), true);
  assert.equal(covers({start: 7, end: 18}, {first: 8, last: 12}), false);
  assert.equal(covers({start: 7, end: 18}, {first: 13, last: 16}), false);
  assert.equal(covers({start: 0, end: 6}, {first: 0, last: 3}), true);
  assert.equal(covers({start: 190, end: 200}, {first: 197, last: 199}), true);
  assert.equal(covers({start: 0, end: 0}, {first: 0, last: 0}), false);
});

test('padding and rendered rows add up to the height of the whole grid', () => {
  const cases = [[uniform(1000, 5), {start: 7, end: 18}], [uniform(1003, 7), {start: 142, end: 144}], [uniform(400, 3), {start: 0, end: 20}], [grouped([3, 7, 2], 5), {start: 2, end: 5}], [grouped([3, 7, 2], 5), {start: 4, end: 7}]];
  for (const [layout, range] of cases) {
    const {top, bottom} = rangePadding(layout, range);
    let rendered = 0;
    for (let row = range.start; row < range.end; row++) rendered += layout.size[row] + (row > range.start ? 10 : 0);
    assert.equal(top + rendered + bottom, layout.height);
    assert.equal(top, layout.top[range.start]);
  }
  // Uniform rows keep the arithmetic of a plain grid.
  assert.deepEqual(rangePadding(uniform(1000, 5), {start: 7, end: 18}), {top: 7 * 110, bottom: (200 - 18) * 110});
});

test('arrow keys move through the list and stop at the grid edges', () => {
  // 12 items in 5 columns: rows 0-4, 5-9, 10-11.
  const layout = uniform(12, 5);
  const move = (index, key) => neighbourIndex(layout, index, key);
  assert.equal(move(6, 'ArrowRight'), 7);
  assert.equal(move(4, 'ArrowRight'), null);
  assert.equal(move(11, 'ArrowRight'), null);
  assert.equal(move(5, 'ArrowLeft'), null);
  assert.equal(move(6, 'ArrowLeft'), 5);
  assert.equal(move(3, 'ArrowUp'), null);
  assert.equal(move(8, 'ArrowUp'), 3);
  assert.equal(move(6, 'ArrowDown'), 11);
  assert.equal(move(8, 'ArrowDown'), 11);
  assert.equal(move(11, 'ArrowDown'), null);
  assert.equal(move(3, 'Enter'), null);
});

test('arrow keys cross group headings and keep the column where the row allows', () => {
  // H0, [0-2], H1, [3-7], [8-9], H2, [10-11].
  const layout = grouped([3, 7, 2], 5);
  const move = (index, key) => neighbourIndex(layout, index, key);
  assert.equal(move(1, 'ArrowDown'), 4);
  assert.equal(move(2, 'ArrowDown'), 5);
  assert.equal(move(2, 'ArrowRight'), null, 'a group ends its row');
  assert.equal(move(3, 'ArrowLeft'), null);
  assert.equal(move(7, 'ArrowDown'), 9);
  assert.equal(move(9, 'ArrowDown'), 11);
  assert.equal(move(10, 'ArrowUp'), 8);
  assert.equal(move(3, 'ArrowUp'), 0);
  assert.equal(move(4, 'ArrowUp'), 1);
  assert.equal(move(0, 'ArrowUp'), null);
  assert.equal(move(11, 'ArrowDown'), null);
});

test('the load queue bounds concurrency and starts the lowest priority first', async () => {
  const queue = createLoadQueue({concurrency: 2});
  const started = [];
  const finish = new Map();
  let running = 0;
  let peak = 0;
  const task = name => () => new Promise(resolve => {
    started.push(name);
    running++;
    peak = Math.max(peak, running);
    finish.set(name, () => { running--; resolve(undefined); });
  });
  queue.add(task('a'), {priority: () => 1});
  queue.add(task('b'), {priority: () => 1});
  queue.add(task('far'), {priority: () => 5});
  queue.add(task('visible'), {priority: () => 0});
  queue.add(task('near'), {priority: () => 1});
  await tick();
  assert.deepEqual(started, ['a', 'b']);
  assert.equal(queue.queued, 3);
  finish.get('a')();
  await tick();
  finish.get('b')();
  await tick();
  assert.deepEqual(started, ['a', 'b', 'visible', 'near']);
  assert.equal(peak, 2);
});

test('the load queue drops aborted work, survives failures, waits on infinite priority, and pauses', async () => {
  const queue = createLoadQueue({concurrency: 1});
  const started = [];
  const controller = new AbortController();
  queue.add(async () => { started.push('fails'); throw new Error('broken tile'); });
  queue.add(() => { started.push('aborted'); }, {signal: controller.signal});
  let eligible = false;
  queue.add(() => { started.push('later'); }, {priority: () => (eligible ? 0 : Infinity)});
  controller.abort();
  queue.add(() => { started.push('next'); });
  await tick();
  await tick();
  assert.deepEqual(started, ['fails', 'next']);
  assert.equal(queue.queued, 1);
  eligible = true;
  queue.setConcurrency(0);
  queue.wake();
  await tick();
  assert.deepEqual(started, ['fails', 'next']);
  queue.setConcurrency(1);
  await tick();
  assert.deepEqual(started, ['fails', 'next', 'later']);
  assert.equal(queue.queued, 0);
  assert.equal(queue.running, 0);
  queue.add(() => { started.push('never'); }, {signal: AbortSignal.abort()});
  assert.equal(queue.queued, 0);
});

// A minimal DOM: a grid with 4 columns of 100 px tiles and 10 px gaps, 500 px tall viewport.
class FakeElement {
  constructor(name = '') {
    this.name = name;
    this.parent = null;
    this.childNodes = [];
    this.attributes = new Map();
    const style = new Map();
    this.style = new Proxy({removeProperty: key => style.delete(key)}, {
      get: (target, key) => (key in target ? target[key] : style.get(key) ?? ''),
      set: (target, key, value) => { if (value === '') style.delete(key); else style.set(key, value); return true; },
    });
    const classes = new Set();
    this.classList = {add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name)};
  }
  get isConnected() { return Boolean(this.parent); }
  insertBefore(node, before) {
    const nodes = node instanceof FakeFragment ? node.childNodes.splice(0) : [node];
    for (const child of nodes) {
      child.parent?.childNodes.splice(child.parent.childNodes.indexOf(child), 1);
      child.parent = this;
      const at = before ? this.childNodes.indexOf(before) : this.childNodes.length;
      assert.ok(at >= 0, 'insertBefore reference must be a child');
      this.childNodes.splice(at, 0, child);
    }
    return node;
  }
  append(...nodes) { for (const node of nodes) this.insertBefore(node, null); }
  remove() {
    if (!this.parent) return;
    this.parent.childNodes.splice(this.parent.childNodes.indexOf(this), 1);
    this.parent = null;
  }
  replaceChildren() {
    for (const child of this.childNodes) child.parent = null;
    this.childNodes = [];
  }
  contains(other) { return other === this; }
  setAttribute(key, value) { this.attributes.set(key, value); }
}
class FakeFragment extends FakeElement {}

function fakePage() {
  const page = {scrollY: 0, gridTop: 200, columns: 4, tileHeight: 100, focused: null};
  const grid = new FakeElement('grid');
  grid.getBoundingClientRect = () => ({top: page.gridTop - page.scrollY, width: page.columns * 110 - 10});
  const listeners = new Map();
  const saved = {};
  const globals = {
    document: {createDocumentFragment: () => new FakeFragment(), createElement: name => new FakeElement(name), get activeElement() { return page.focused; }},
    // An empty grid reports stale track sizes, as WebKit does.
    getComputedStyle: () => {
      const track = grid.childNodes.length ? `${page.tileHeight}px` : '117px';
      return {
        gridTemplateColumns: Array(page.columns).fill(track).join(' '), columnGap: '10px', rowGap: '10px',
        getPropertyValue: name => (name === '--date-heading-height' ? '30px' : ''),
      };
    },
    innerHeight: 500,
    addEventListener: (type, listener) => listeners.set(type, listener),
    scrollBy: ({top}) => { page.scrollY += top; },
  };
  for (const [key, value] of Object.entries(globals)) {
    saved[key] = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, {value, configurable: true, writable: true});
  }
  page.restore = () => {
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  };
  page.scrollTo = top => {
    page.scrollY = top;
    listeners.get('scroll')?.();
  };
  page.grid = grid;
  return page;
}

function setup(total, {tileHeight = 100, groups = null} = {}) {
  const page = fakePage();
  page.tileHeight = tileHeight;
  const signals = new Map();
  const sticky = new FakeElement('sticky');
  sticky.hidden = true;
  page.sticky = sticky;
  const view = createMediaWindow({
    grid: page.grid,
    stickyHeading: sticky,
    createCard: (item, index, {signal}) => {
      const card = new FakeElement(item.path);
      card.index = index;
      signals.set(index, signal);
      return card;
    },
  });
  view.setItems(Array.from({length: total}, (_, index) => ({path: `item-${index}`})), groups);
  const indices = () => page.grid.childNodes.filter(node => node.index !== undefined).map(card => card.index);
  return {page, view, signals, indices};
}

function assertSorted(indices) {
  assert.deepEqual(indices, [...indices].sort((left, right) => left - right));
}

test('a large list keeps a bounded, ordered window that follows the scroll position', t => {
  const {page, view, signals, indices} = setup(5000);
  t.after(page.restore);
  assert.equal(view.windowed, true);
  // The grid starts 200 px down a 500 px viewport: rows 0-2 are visible, and 5 extra
  // rows (one viewport) follow them.
  assert.deepEqual(indices(), Array.from({length: 32}, (_, index) => index));
  assert.equal(page.grid.style.paddingTop, '');
  assert.equal(page.grid.style.paddingBottom, `${(1250 - 8) * 110}px`);

  page.scrollTo(200 + 600 * 110);
  const middle = indices();
  assertSorted(middle);
  assert.ok(middle.length <= 4 * 16, `window of ${middle.length} cards`);
  assert.ok(middle.includes(2400) && middle.includes(2419));
  assert.equal(page.grid.style.paddingTop, `${(middle[0] / 4) * 110}px`);
  assert.equal(signals.get(0).aborted, true);
  assert.equal(signals.get(2400).aborted, false);

  page.scrollTo(200 + 1250 * 110);
  assert.equal(indices().at(-1), 4999);
  assert.equal(page.grid.style.paddingBottom, '');
});

test('a small scroll inside the margin keeps the same cards', t => {
  const {page, indices} = setup(5000);
  t.after(page.restore);
  page.scrollTo(200 + 600 * 110);
  const before = page.grid.childNodes.slice();
  page.scrollTo(200 + 601 * 110);
  assert.deepEqual(page.grid.childNodes, before);
  assertSorted(indices());
});

test('the focused card outside the window stays in the DOM at its own cell', t => {
  const {page, view, indices} = setup(5000);
  t.after(page.restore);
  const focused = page.grid.childNodes[6];
  page.focused = focused;
  page.scrollTo(200 + 900 * 110);
  assert.equal(focused.isConnected, true);
  assert.equal(focused.classList.contains('is-window-pinned'), true);
  assert.equal(focused.style.top, `${1 * 110}px`);
  assert.equal(focused.style.left, `${2 * 110}px`);
  assert.equal(focused.style.width, '100px');
  assert.equal(indices()[0], 6);
  assertSorted(indices());

  // Back in the window it flows in the grid again without being moved.
  page.scrollTo(0);
  assert.equal(focused.classList.contains('is-window-pinned'), false);
  assert.equal(focused.style.top, '');
  assert.equal(page.grid.childNodes[6], focused);
  page.focused = null;
  page.scrollTo(200 + 900 * 110);
  assert.equal(focused.isConnected, false);
  assert.equal(view.reveal('item-6')?.index, 6);
});

test('reveal and arrow navigation reach items outside the window', t => {
  const {page, view, indices} = setup(5000);
  t.after(page.restore);
  const far = view.reveal('item-3000');
  assert.equal(far.index, 3000);
  assert.equal(far.classList.contains('is-window-pinned'), true);
  assertSorted(indices());
  assert.equal(view.reveal('missing'), null);

  // The last rendered row is 7; Down from it creates row 8 on demand.
  const edge = page.grid.childNodes.find(card => card.index === 29);
  assert.equal(view.neighbour(edge, 'ArrowDown').index, 33);
  assertSorted(indices());
  assert.equal(view.neighbour(edge, 'ArrowUp').index, 25);
  assert.equal(view.neighbour(new FakeElement(), 'ArrowUp'), null);
});

test('relayout keeps the item at the top of the viewport in place', t => {
  const {page, view, indices} = setup(5000);
  t.after(page.restore);
  page.scrollTo(200 + 300 * 110);
  // Row 300 of 4 columns starts with item 1200; with 7 columns it is row 171.
  page.columns = 7;
  view.relayout();
  assert.equal(page.scrollY, 200 + 171 * 110);
  assert.ok(indices().includes(1200));
  assert.equal(page.grid.style.paddingTop, `${(indices()[0] / 7) * 110}px`);
  assertSorted(indices());
});

test('a width change seen on scroll re-measures and keeps the top item', t => {
  const {page, indices} = setup(5000);
  t.after(page.restore);
  page.scrollTo(200 + 300 * 110);
  // A narrower grid (say, a scrollbar appeared) now fits 3 columns: item 1200 is on row 400.
  page.columns = 3;
  page.scrollTo(page.scrollY);
  assert.equal(page.scrollY, 200 + 400 * 110);
  assert.ok(indices().includes(1200));
  assert.equal(page.grid.style.paddingTop, `${(indices()[0] / 3) * 110}px`);
  assertSorted(indices());
});

test('the row pitch comes from the rendered tracks, not the width estimate', t => {
  // Subpixel tracks make rows a little taller than the width estimate.
  const {page, indices} = setup(5000, {tileHeight: 100.5});
  t.after(page.restore);
  const rows = Math.ceil(indices().length / 4);
  assert.equal(page.grid.style.paddingBottom, `${(1250 - rows) * 110.5}px`);
  page.scrollTo(200 + 600 * 110.5);
  assert.equal(page.grid.style.paddingTop, `${(indices()[0] / 4) * 110.5}px`);
  assert.ok(indices().includes(2400));
});

test('lists up to the threshold render whole; clear drops every card', t => {
  const {page, view, signals, indices} = setup(WINDOW_MIN_ITEMS);
  t.after(page.restore);
  assert.equal(view.windowed, false);
  assert.equal(indices().length, WINDOW_MIN_ITEMS);
  assert.equal(page.grid.style.paddingBottom, '');
  assert.equal(page.grid.attributes.get('aria-live'), 'polite');
  view.setItems(Array.from({length: WINDOW_MIN_ITEMS + 1}, (_, index) => ({path: `next-${index}`})));
  assert.equal(signals.get(WINDOW_MIN_ITEMS - 1).aborted, true, 'cards of the previous list are dropped');
  assert.equal(page.grid.attributes.get('aria-live'), 'off');
  view.clear();
  assert.equal(page.grid.childNodes.length, 0);
  assert.equal(signals.get(0).aborted, true);
  assert.equal(page.grid.attributes.get('aria-live'), 'polite');
});

// Groups of 7 items in 4 columns: a 30 px heading, a full row, and a row of 3.
// Every group takes 30 + 10 + 2 * 110 = 260 px.
const GROUP_SIZE = 7;
const sevens = total => Array.from({length: Math.ceil(total / GROUP_SIZE)}, (_, index) => ({label: `G${index}`, count: Math.min(GROUP_SIZE, total - index * GROUP_SIZE)}));
const GROUP_PITCH = 260;

/** Item indices of the cards in DOM order. */
const indices = page => page.grid.childNodes.filter(node => node.index !== undefined).map(card => card.index);

/** Headings and cards of the grid in DOM order, as 'H<group>' and item indices. */
const sequence = page => page.grid.childNodes.map(node => (node.index === undefined ? node.textContent : node.index));

test('a grouped large list keeps a bounded window of headings and cards in list order', t => {
  const {page, view, signals} = setup(5000, {groups: sevens(5000)});
  t.after(page.restore);
  assert.equal(view.windowed, true);
  assert.equal(page.grid.classList.contains('is-grouped'), true);
  const first = sequence(page);
  assert.deepEqual(first.slice(0, 9), ['G0', 0, 1, 2, 3, 4, 5, 6, 'G1']);

  page.scrollTo(200 + 400 * GROUP_PITCH);
  const nodes = sequence(page);
  assert.ok(nodes.length <= 4 * 20, `window of ${nodes.length} nodes`);
  // Every heading directly precedes the first item of its group, items ascend without gaps.
  const items = nodes.filter(node => typeof node === 'number');
  assert.deepEqual(items, Array.from({length: items.length}, (_, index) => items[0] + index));
  nodes.forEach((node, at) => {
    if (typeof node === 'number') return;
    assert.equal(nodes[at + 1], Number(node.slice(1)) * GROUP_SIZE, `${node} precedes its first item`);
  });
  assert.ok(items.includes(400 * GROUP_SIZE));
  // The padding stands in for whole groups above the rendered rows.
  const firstRendered = page.grid.childNodes[0];
  const firstGroup = firstRendered.index === undefined ? Number(firstRendered.textContent.slice(1)) : Math.floor(firstRendered.index / GROUP_SIZE);
  const offset = firstRendered.index === undefined ? 0 : firstRendered.index % GROUP_SIZE < 4 ? 40 : 150;
  assert.equal(page.grid.style.paddingTop, `${firstGroup * GROUP_PITCH + offset}px`);
  assert.equal(signals.get(0).aborted, true);

  page.scrollTo(200 + 714 * GROUP_PITCH + 500);
  assert.equal(indices(page).at(-1), 4999);
  assert.equal(page.grid.style.paddingBottom, '');
});

test('the sticky heading names the group at the top of the viewport and hides above the grid', t => {
  const {page} = setup(5000, {groups: sevens(5000)});
  t.after(page.restore);
  assert.equal(page.sticky.hidden, true, 'the grid top is below the chrome');
  // Scrolled into the second row of group 12.
  page.scrollTo(200 + 12 * GROUP_PITCH + 160);
  assert.equal(page.sticky.hidden, false);
  assert.equal(page.sticky.textContent, 'G12');
  // The heading of group 13 reaches the top.
  page.scrollTo(200 + 13 * GROUP_PITCH + 5);
  assert.equal(page.sticky.textContent, 'G13');
  page.scrollTo(0);
  assert.equal(page.sticky.hidden, true);
});

test('a grouped list pins a far card at its own cell and moves across headings', t => {
  const {page, view} = setup(5000, {groups: sevens(5000)});
  t.after(page.restore);
  // Item 7 * 300 + 5 is in group 300, second row, column 1.
  const far = view.reveal(`item-${300 * GROUP_SIZE + 5}`);
  assert.equal(far.classList.contains('is-window-pinned'), true);
  assert.equal(far.style.top, `${300 * GROUP_PITCH + 150}px`);
  assert.equal(far.style.left, '110px');
  const nodes = sequence(page);
  assert.equal(nodes.at(-1), 300 * GROUP_SIZE + 5, 'a pinned card follows the rendered rows in DOM order');
  // Down from the short row of a group lands in the next group's first row.
  assert.equal(view.neighbour(far, 'ArrowDown').index, 301 * GROUP_SIZE + 1);
  assert.equal(view.neighbour(far, 'ArrowUp').index, 300 * GROUP_SIZE + 1);
});

test('relayout keeps the first item of a grouped top row in place', t => {
  const {page, view} = setup(5000, {groups: sevens(5000)});
  t.after(page.restore);
  // The top row is the second row of group 100: items 704-706.
  page.scrollTo(200 + 100 * GROUP_PITCH + 150);
  page.columns = 7;
  view.relayout();
  // With 7 columns a group is a heading and one row: 30 + 10 + 110 = 150 px; item 704 is in group 100's row.
  assert.equal(page.scrollY, 200 + 100 * 150 + 40);
  assert.ok(indices(page).includes(704));
});

test('a small grouped list renders whole with every heading; groups that miss items are ignored', t => {
  const {page, view} = setup(20, {groups: sevens(20)});
  t.after(page.restore);
  assert.deepEqual(sequence(page), ['G0', 0, 1, 2, 3, 4, 5, 6, 'G1', 7, 8, 9, 10, 11, 12, 13, 'G2', 14, 15, 16, 17, 18, 19]);
  view.setItems(Array.from({length: 5}, (_, index) => ({path: `next-${index}`})), [{label: 'G0', count: 4}]);
  assert.deepEqual(sequence(page), [0, 1, 2, 3, 4]);
  assert.equal(page.grid.classList.contains('is-grouped'), false);
  view.clear();
  assert.equal(page.sticky.hidden, true);
});
