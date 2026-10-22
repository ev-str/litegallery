// Windowed rendering of the media grid. A large folder keeps only the rows near
// the viewport in the DOM; padding above and below the rendered rows gives the
// grid the height of the whole list, so order, scrollbar, and anchors stay
// right. Small folders are rendered whole through the same code path.
//
// DOM contract: grid children are media cards in list order. Cards inside the
// rendered range flow in the CSS grid; a card outside it (the focused card, or
// one returned by `reveal`) is positioned absolutely at its own cell, so it
// never disappears and never shifts the other cards.

/** Folders up to this size are rendered whole. */
export const WINDOW_MIN_ITEMS = 300;

/**
 * @typedef {{columns: number, tile: number, columnGap: number, pitch: number}} GridGeometry
 *   pitch is the distance between row tops: tile edge plus row gap, in CSS px
 * @typedef {{first: number, last: number}} RowSpan inclusive row numbers
 * @typedef {{start: number, end: number}} ItemRange item indices, end exclusive
 */

/**
 * Rows that intersect the band [top, bottom), both relative to the grid top.
 * @param {{rows: number, tile: number, pitch: number, top: number, bottom: number}} options
 * @returns {RowSpan}
 */
export function visibleRows({rows, tile, pitch, top, bottom}) {
  const last = Math.max(0, rows - 1);
  // Row r spans [r * pitch, r * pitch + tile).
  const first = clamp(Math.floor((top - tile) / pitch) + 1, 0, last);
  return {first, last: clamp(Math.ceil(bottom / pitch) - 1, first, last)};
}

/**
 * Item range for the visible rows plus `extra` rows on each side.
 * @param {{total: number, columns: number, visible: RowSpan, extra: number}} options
 * @returns {ItemRange}
 */
export function windowRange({total, columns, visible, extra}) {
  const rows = Math.ceil(total / columns);
  const startRow = Math.max(0, visible.first - extra);
  const endRow = Math.min(rows, visible.last + 1 + extra);
  return {start: startRow * columns, end: Math.min(total, endRow * columns)};
}

/**
 * Whether `range` still covers the visible rows with `margin` rows to spare;
 * the list edges need no margin.
 * @param {{range: ItemRange, total: number, columns: number, visible: RowSpan, margin: number}} options
 */
export function rangeCovers({range, total, columns, visible, margin}) {
  if (range.end <= range.start) return false;
  const rows = Math.ceil(total / columns);
  const startRow = Math.floor(range.start / columns);
  const endRow = Math.ceil(range.end / columns);
  const above = startRow === 0 || visible.first - startRow >= margin;
  const below = endRow === rows || endRow - 1 - visible.last >= margin;
  return above && below;
}

/**
 * Padding that stands in for the rows outside the range.
 * @param {{range: ItemRange, total: number, columns: number, pitch: number}} options
 */
export function rangePadding({range, total, columns, pitch}) {
  const rows = Math.ceil(total / columns);
  const startRow = Math.floor(range.start / columns);
  const endRow = Math.ceil(range.end / columns);
  return {top: startRow * pitch, bottom: (rows - endRow) * pitch};
}

/**
 * Index of the card an arrow key moves to inside the grid, or null at its edge.
 * Down from a row above an incomplete last row lands on the last item.
 * @param {number} index @param {string} key @param {number} columns @param {number} total
 * @returns {number|null}
 */
export function neighbourIndex(index, key, columns, total) {
  const column = index % columns;
  switch (key) {
    case 'ArrowLeft': return column > 0 ? index - 1 : null;
    case 'ArrowRight': return column < columns - 1 && index + 1 < total ? index + 1 : null;
    case 'ArrowUp': return index >= columns ? index - columns : null;
    case 'ArrowDown':
      if (index + columns < total) return index + columns;
      return Math.floor(index / columns) < Math.floor((total - 1) / columns) ? total - 1 : null;
    default: return null;
  }
}

/** @param {number} value @param {number} low @param {number} high */
function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

/**
 * @template {{path: string}} Item
 * @param {{
 *   grid: HTMLElement,
 *   createCard: (item: Item, index: number, context: {signal: AbortSignal, priority: () => number}) => HTMLElement,
 *   viewportTop?: () => number,
 *   onChange?: () => void,
 *   minItems?: number,
 *   overscan?: number,
 * }} options
 *   createCard builds a card; its signal aborts when the card leaves the DOM and
 *   priority() is its distance in rows from the visible rows (Infinity beyond
 *   the preload range). viewportTop is the first viewport pixel not covered by
 *   sticky chrome. onChange runs after the visible rows change. overscan is the
 *   preload range on each side, in viewport heights.
 */
export function createMediaWindow({grid, createCard, viewportTop = () => 0, onChange = () => {}, minItems = WINDOW_MIN_ITEMS, overscan = 1}) {
  /** @type {Item[]} */
  let items = [];
  /** @type {Map<string, number>} */
  let indexByPath = new Map();
  /** @type {Map<number, {card: HTMLElement, controller: AbortController}>} */
  const live = new Map();
  /** @type {WeakMap<Element, number>} */
  const cardIndex = new WeakMap();
  /** @type {GridGeometry} */
  let geometry = {columns: 1, tile: 0, columnGap: 0, pitch: 0};
  let rowGap = 0;
  let measuredWidth = 0;
  let calibrated = false;
  /** @type {ItemRange} */
  let range = {start: 0, end: 0};
  /** @type {RowSpan} */
  let visible = {first: 0, last: 0};
  let extra = 0;
  let windowed = false;

  // The tracks give the column count only: WebKit reports stale track sizes for an
  // empty grid. The equal tracks share the grid width, and a tile is square;
  // calibrate() corrects the row height once cards are rendered.
  function measure() {
    const style = getComputedStyle(grid);
    const columns = style.gridTemplateColumns.split(' ').filter(track => parseFloat(track) > 0).length || 1;
    const columnGap = parseFloat(style.columnGap) || 0;
    rowGap = parseFloat(style.rowGap) || 0;
    measuredWidth = grid.getBoundingClientRect().width;
    const tile = Math.max(0, (measuredWidth - (columns - 1) * columnGap) / columns);
    geometry = {columns, tile, columnGap, pitch: tile + rowGap};
    calibrated = false;
  }

  // Track widths differ by subpixels and a row is as tall as its widest square
  // tile; over thousands of rows the estimate would drift. The tracks of a
  // non-empty grid are exact, unlike card rects far down the page (WebKit rounds
  // them in single precision). Returns true when the pitch changed.
  function calibrate() {
    if (calibrated || !windowed || !live.size) return false;
    calibrated = true;
    const tracks = getComputedStyle(grid).gridTemplateColumns.split(' ').map(parseFloat).filter(value => value > 0);
    const tile = tracks.length === geometry.columns ? Math.max(...tracks) : 0;
    if (!tile || tile === geometry.tile) return false;
    geometry = {...geometry, tile, pitch: tile + rowGap};
    return true;
  }

  const rowCount = () => Math.ceil(items.length / geometry.columns);

  function updateVisible() {
    const top = grid.getBoundingClientRect().top;
    extra = geometry.pitch > 0 ? Math.ceil(innerHeight * overscan / geometry.pitch) : rowCount();
    visible = geometry.pitch > 0
      ? visibleRows({rows: rowCount(), tile: geometry.tile, pitch: geometry.pitch, top: viewportTop() - top, bottom: innerHeight - top})
      : {first: 0, last: Math.max(0, rowCount() - 1)};
  }

  /** @param {number} index */
  function priorityOf(index) {
    const row = Math.floor(index / geometry.columns);
    const distance = row < visible.first ? visible.first - row : row > visible.last ? row - visible.last : 0;
    return distance > extra ? Infinity : distance;
  }

  /** @param {number} index */
  function createEntry(index) {
    const controller = new AbortController();
    const card = createCard(items[index], index, {signal: controller.signal, priority: () => priorityOf(index)});
    cardIndex.set(card, index);
    const entry = {card, controller};
    live.set(index, entry);
    return entry;
  }

  /** @param {number} index */
  function drop(index) {
    const entry = live.get(index);
    if (!entry) return;
    live.delete(index);
    entry.controller.abort();
    entry.card.remove();
  }

  /** @param {number} index @param {HTMLElement} card */
  function pin(index, card) {
    const {columns, tile, columnGap, pitch} = geometry;
    card.classList.add('is-window-pinned');
    card.style.top = `${Math.floor(index / columns) * pitch}px`;
    card.style.left = `${(index % columns) * (tile + columnGap)}px`;
    card.style.width = `${tile}px`;
  }

  /** @param {HTMLElement} card */
  function unpin(card) {
    if (!card.classList.contains('is-window-pinned')) return;
    card.classList.remove('is-window-pinned');
    card.style.removeProperty('top');
    card.style.removeProperty('left');
    card.style.removeProperty('width');
  }

  /** @param {number} index */
  const inRange = index => index >= range.start && index < range.end;

  // Existing cards are never moved, only removed: moving a node would drop its
  // focus and restart its animations. New cards are inserted around them.
  /** @param {ItemRange} next */
  function render(next) {
    range = next;
    const active = document.activeElement;
    for (const [index, {card}] of live) {
      if (inRange(index)) unpin(card);
      else if (active && card.contains(active)) pin(index, card);
      else drop(index);
    }
    const existing = [...live.keys()].sort((left, right) => left - right);
    let following = 0;
    const fragment = document.createDocumentFragment();
    const flush = () => {
      if (!fragment.childNodes.length) return;
      const before = following < existing.length ? live.get(existing[following])?.card ?? null : null;
      grid.insertBefore(fragment, before);
    };
    for (let index = range.start; index < range.end; index++) {
      while (following < existing.length && existing[following] < index) following++;
      if (existing[following] === index) {
        flush();
        following++;
        continue;
      }
      fragment.append(createEntry(index).card);
    }
    flush();
    const padding = windowed ? rangePadding({range, total: items.length, columns: geometry.columns, pitch: geometry.pitch}) : {top: 0, bottom: 0};
    grid.style.paddingTop = padding.top ? `${padding.top}px` : '';
    grid.style.paddingBottom = padding.bottom ? `${padding.bottom}px` : '';
  }

  /** The range a windowed grid wants for the current scroll position. */
  function wantedRange() {
    if (!windowed) return {start: 0, end: items.length};
    if (geometry.pitch <= 0) return {start: 0, end: Math.min(items.length, minItems)};
    return windowRange({total: items.length, columns: geometry.columns, visible, extra});
  }

  /** Follow the scroll position; cheap when the rendered rows still cover it. */
  function follow() {
    updateVisible();
    const covered = live.size > 0 && (!windowed || rangeCovers({range, total: items.length, columns: geometry.columns, visible, margin: Math.ceil(extra / 2)}));
    if (!covered) render(wantedRange());
    if (calibrate()) {
      updateVisible();
      render(wantedRange());
    }
    onChange();
  }

  // A width change (window resize, a scrollbar that the new height brought) is
  // caught here, synchronously, so no frame is painted with stale padding.
  function sync() {
    if (!items.length) return;
    if (grid.getBoundingClientRect().width !== measuredWidth) relayout();
    else follow();
  }

  /**
   * Re-measure after the column count or tile size changed. The row at the top
   * of the viewport keeps its first item and its offset on screen.
   */
  function relayout() {
    if (!items.length) return;
    const before = geometry;
    if (!windowed) {
      measure();
      follow();
      return;
    }
    updateVisible();
    const anchor = visible.first * before.columns;
    const anchorTop = grid.getBoundingClientRect().top + visible.first * before.pitch;
    measure();
    const row = Math.floor(anchor / geometry.columns);
    extra = geometry.pitch > 0 ? Math.ceil(innerHeight * overscan / geometry.pitch) : rowCount();
    visible = {first: row, last: row};
    render(wantedRange());
    if (calibrate()) render(wantedRange());
    const shift = grid.getBoundingClientRect().top + row * geometry.pitch - anchorTop;
    if (shift) scrollBy({top: shift, behavior: 'instant'});
    follow();
  }

  /**
   * Make sure the card of an item exists and return it. A card outside the
   * rendered range is pinned at its cell until the next range change that it
   * does not hold focus through.
   * @param {number} index
   */
  function revealIndex(index) {
    if (index < 0 || index >= items.length) return null;
    const known = live.get(index);
    if (known) return known.card;
    const {card} = createEntry(index);
    const after = [...live.keys()].filter(other => other > index).sort((left, right) => left - right)[0];
    grid.insertBefore(card, after === undefined ? null : live.get(after)?.card ?? null);
    pin(index, card);
    return card;
  }

  function clear() {
    for (const index of [...live.keys()]) drop(index);
    items = [];
    indexByPath = new Map();
    range = {start: 0, end: 0};
    grid.replaceChildren();
    grid.style.paddingTop = '';
    grid.style.paddingBottom = '';
    grid.setAttribute('aria-live', 'polite');
  }

  addEventListener('scroll', sync, {passive: true});
  addEventListener('resize', sync);

  return {
    /** Replace the list; cards of the previous list are dropped. @param {Item[]} list */
    setItems(list) {
      clear();
      items = list;
      indexByPath = new Map(list.map((item, index) => [item.path, index]));
      windowed = list.length > minItems;
      grid.setAttribute('aria-live', windowed ? 'off' : 'polite');
      measure();
      follow();
      sync();
    },
    /** Drop every card and anything else in the grid. */
    clear,
    sync,
    relayout,
    revealIndex,
    /** @param {string|null|undefined} path */
    reveal(path) {
      const index = path ? indexByPath.get(path) : undefined;
      return index === undefined ? null : revealIndex(index);
    },
    /** The card an arrow key moves to from `card`, or null at the grid edge. @param {Element} card @param {string} key */
    neighbour(card, key) {
      const index = cardIndex.get(card);
      if (index === undefined) return null;
      const target = neighbourIndex(index, key, geometry.columns, items.length);
      return target === null ? null : revealIndex(target);
    },
    get size() {
      return items.length;
    },
    get windowed() {
      return windowed;
    },
  };
}
