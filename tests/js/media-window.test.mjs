import assert from 'node:assert/strict';
import test from 'node:test';

import {createLoadQueue} from '../../web/load-queue.js';
import {
  createMediaWindow, neighbourIndex, rangeCovers, rangePadding, visibleRows, WINDOW_MIN_ITEMS, windowRange,
} from '../../web/media-window.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('visible rows follow the band and include partly visible rows', () => {
  // Rows of 100 px with a 10 px gap: row r spans [110 r, 110 r + 100).
  const rows = (top, bottom) => visibleRows({rows: 50, tile: 100, pitch: 110, top, bottom});
  assert.deepEqual(rows(0, 500), {first: 0, last: 4});
  assert.deepEqual(rows(105, 215), {first: 1, last: 1});
  assert.deepEqual(rows(99, 221), {first: 0, last: 2});
  assert.deepEqual(rows(-800, -100), {first: 0, last: 0});
  assert.deepEqual(rows(10_000, 10_500), {first: 49, last: 49});
});

test('the window is row-aligned, padded by extra rows, and clamped to the list', () => {
  assert.deepEqual(windowRange({total: 1000, columns: 5, visible: {first: 10, last: 14}, extra: 3}), {start: 35, end: 90});
  assert.deepEqual(windowRange({total: 1000, columns: 5, visible: {first: 1, last: 2}, extra: 3}), {start: 0, end: 30});
  assert.deepEqual(windowRange({total: 1003, columns: 5, visible: {first: 199, last: 200}, extra: 3}), {start: 980, end: 1003});
});

test('the rendered range is kept while it covers the visible rows with a margin', () => {
  const covers = (range, visible) => rangeCovers({range, total: 1000, columns: 5, visible, margin: 2});
  assert.equal(covers({start: 35, end: 90}, {first: 10, last: 14}), true);
  assert.equal(covers({start: 35, end: 90}, {first: 8, last: 12}), false);
  assert.equal(covers({start: 35, end: 90}, {first: 13, last: 16}), false);
  assert.equal(covers({start: 0, end: 30}, {first: 0, last: 3}), true);
  assert.equal(covers({start: 950, end: 1000}, {first: 197, last: 199}), true);
  assert.equal(covers({start: 0, end: 0}, {first: 0, last: 0}), false);
});

test('padding and rendered rows add up to the height of the whole grid', () => {
  for (const [total, columns, range] of [[1000, 5, {start: 35, end: 90}], [1003, 7, {start: 994, end: 1003}], [400, 3, {start: 0, end: 60}]]) {
    const {top, bottom} = rangePadding({range, total, columns, pitch: 110});
    const renderedRows = Math.ceil(range.end / columns) - Math.floor(range.start / columns);
    assert.equal(top + renderedRows * 110 + bottom, Math.ceil(total / columns) * 110);
  }
});

test('arrow keys move through the list and stop at the grid edges', () => {
  // 12 items in 5 columns: rows 0-4, 5-9, 10-11.
  assert.equal(neighbourIndex(6, 'ArrowRight', 5, 12), 7);
  assert.equal(neighbourIndex(4, 'ArrowRight', 5, 12), null);
  assert.equal(neighbourIndex(11, 'ArrowRight', 5, 12), null);
  assert.equal(neighbourIndex(5, 'ArrowLeft', 5, 12), null);
  assert.equal(neighbourIndex(6, 'ArrowLeft', 5, 12), 5);
  assert.equal(neighbourIndex(3, 'ArrowUp', 5, 12), null);
  assert.equal(neighbourIndex(8, 'ArrowUp', 5, 12), 3);
  assert.equal(neighbourIndex(6, 'ArrowDown', 5, 12), 11);
  assert.equal(neighbourIndex(8, 'ArrowDown', 5, 12), 11);
  assert.equal(neighbourIndex(11, 'ArrowDown', 5, 12), null);
  assert.equal(neighbourIndex(3, 'Enter', 5, 12), null);
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
    document: {createDocumentFragment: () => new FakeFragment(), get activeElement() { return page.focused; }},
    // An empty grid reports stale track sizes, as WebKit does.
    getComputedStyle: () => {
      const track = grid.childNodes.length ? `${page.tileHeight}px` : '117px';
      return {gridTemplateColumns: Array(page.columns).fill(track).join(' '), columnGap: '10px', rowGap: '10px'};
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

function setup(total, {tileHeight = 100} = {}) {
  const page = fakePage();
  page.tileHeight = tileHeight;
  const signals = new Map();
  const view = createMediaWindow({
    grid: page.grid,
    createCard: (item, index, {signal}) => {
      const card = new FakeElement(item.path);
      card.index = index;
      signals.set(index, signal);
      return card;
    },
  });
  view.setItems(Array.from({length: total}, (_, index) => ({path: `item-${index}`})));
  const indices = () => page.grid.childNodes.map(card => card.index);
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
