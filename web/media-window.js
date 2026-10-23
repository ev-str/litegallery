// Windowed rendering of the media grid. A large folder keeps only the rows near
// the viewport in the DOM; padding above and below the rendered rows gives the
// grid the height of the whole list, so order, scrollbar, and anchors stay
// right. Small folders are rendered whole through the same code path.
//
// A grouped list starts every group with a full-width heading row, so a group
// begins on a new row and its last row may be incomplete. Rows therefore have a
// layout of their own: a heading row is as tall as --date-heading-height, a tile
// row as tall as the widest track it fills (a tile is square), and row tops are
// prefix sums.
//
// DOM contract: grid children are headings and media cards in list order.
// Cards inside the rendered rows flow in the CSS grid; a card outside them (the
// focused card, or one returned by `reveal`) is positioned absolutely at its own
// cell, so it never disappears and never shifts the other cards. Headings exist
// only inside the rendered rows.

/** Folders up to this size are rendered whole. */
export const WINDOW_MIN_ITEMS = 300;

/**
 * @typedef {{label: string, count: number}} ItemGroup consecutive items under one heading
 * @typedef {{columns: number, tile: number, tracks: number[], columnGap: number, rowGap: number, heading: number}} GridGeometry
 *   tile is the widest track, tracks the width of each column once rendered (empty
 *   before), heading the height of a heading row; all in CSS px
 * @typedef {{
 *   rows: number, total: number, height: number,
 *   top: Float64Array, size: Float64Array,
 *   itemStart: Int32Array, group: Int32Array, heading: Uint8Array,
 *   itemRow: Int32Array, groupRow: Int32Array,
 * }} RowLayout
 *   top and size of every row, relative to the grid top; itemStart[r] is the first
 *   item at or after row r, itemStart[rows] = total; heading[r] is 1 for a heading
 *   row; groupRow[g] is the heading row of group g
 * @typedef {{first: number, last: number}} RowSpan inclusive row numbers
 * @typedef {{start: number, end: number}} RowRange row numbers, end exclusive
 */

/**
 * Rows of a list: without groups, full rows of `columns` items; with groups, a
 * heading row and then the rows of each group. Tracks may differ by subpixels: a
 * row of n tiles is as tall as the widest of its first n tracks, so the short last
 * row of a group can be lower than a full one.
 * @param {{total: number, columns: number, tile: number, tracks?: number[], rowGap: number, heading?: number, groups?: ItemGroup[] | null}} options
 * @returns {RowLayout}
 */
export function rowLayout({total, columns, tile, tracks = [], rowGap, heading = 0, groups = null}) {
  const spans = groups ?? [{label: '', count: total}];
  // Height of a row of n tiles, by n.
  const rowHeight = Array.from({length: columns}, (_, n) => (tracks.length === columns ? Math.max(...tracks.slice(0, n + 1)) : tile));
  let rows = 0;
  for (const {count} of spans) rows += (groups ? 1 : 0) + Math.ceil(count / columns);
  const layout = {
    rows,
    total,
    height: 0,
    top: new Float64Array(rows),
    size: new Float64Array(rows),
    itemStart: new Int32Array(rows + 1),
    group: new Int32Array(rows),
    heading: new Uint8Array(rows),
    itemRow: new Int32Array(total),
    groupRow: new Int32Array(groups ? groups.length : 0),
  };
  let row = 0;
  let item = 0;
  let y = 0;
  /** @param {number} height @param {number} group @param {boolean} isHeading */
  const add = (height, group, isHeading) => {
    layout.top[row] = y;
    layout.size[row] = height;
    layout.itemStart[row] = item;
    layout.group[row] = group;
    layout.heading[row] = isHeading ? 1 : 0;
    y += height + rowGap;
    row++;
  };
  spans.forEach(({count}, group) => {
    if (groups) {
      layout.groupRow[group] = row;
      add(heading, group, true);
    }
    for (let left = count; left > 0; left -= columns) {
      const length = Math.min(columns, left);
      layout.itemRow.fill(row, item, item + length);
      add(rowHeight[length - 1], group, false);
      item += length;
    }
  });
  layout.itemStart[rows] = item;
  layout.height = rows ? y - rowGap : 0;
  return layout;
}

/**
 * Rows that intersect the band [top, bottom), both relative to the grid top.
 * @param {RowLayout} layout @param {number} top @param {number} bottom
 * @returns {RowSpan}
 */
export function visibleRows(layout, top, bottom) {
  const last = Math.max(0, layout.rows - 1);
  // The first row whose bottom edge is below `top`, then the first row that starts at or below `bottom`.
  const first = Math.min(last, bisect(layout.rows, row => layout.top[row] + layout.size[row] > top));
  const after = bisect(layout.rows, row => layout.top[row] >= bottom);
  return {first, last: clamp(after - 1, first, last)};
}

/**
 * Rows to render: the visible rows plus `extra` rows on each side.
 * @param {{rows: number, visible: RowSpan, extra: number}} options
 * @returns {RowRange}
 */
export function windowRange({rows, visible, extra}) {
  return {start: Math.max(0, visible.first - extra), end: Math.min(rows, visible.last + 1 + extra)};
}

/**
 * Whether `range` still covers the visible rows with `margin` rows to spare;
 * the list edges need no margin.
 * @param {{range: RowRange, rows: number, visible: RowSpan, margin: number}} options
 */
export function rangeCovers({range, rows, visible, margin}) {
  if (range.end <= range.start) return false;
  const above = range.start === 0 || visible.first - range.start >= margin;
  const below = range.end === rows || range.end - 1 - visible.last >= margin;
  return above && below;
}

/**
 * Padding that stands in for the rows outside the range.
 * @param {RowLayout} layout @param {RowRange} range
 */
export function rangePadding(layout, range) {
  if (range.end <= range.start) return {top: 0, bottom: layout.height};
  const last = range.end - 1;
  return {top: layout.top[range.start], bottom: layout.height - layout.top[last] - layout.size[last]};
}

/**
 * Index of the card an arrow key moves to inside the grid, or null at its edge.
 * Up and Down skip heading rows and keep the column, or land on the last item of
 * a shorter row.
 * @param {RowLayout} layout @param {number} index @param {string} key
 * @returns {number|null}
 */
export function neighbourIndex(layout, index, key) {
  if (index < 0 || index >= layout.total) return null;
  const row = layout.itemRow[index];
  const column = index - layout.itemStart[row];
  /** @param {number} step */
  const vertical = step => {
    let next = row + step;
    while (next >= 0 && next < layout.rows && layout.heading[next]) next += step;
    if (next < 0 || next >= layout.rows) return null;
    return Math.min(layout.itemStart[next] + column, layout.itemStart[next + 1] - 1);
  };
  switch (key) {
    case 'ArrowLeft': return column > 0 ? index - 1 : null;
    case 'ArrowRight': return index + 1 < layout.itemStart[row + 1] ? index + 1 : null;
    case 'ArrowUp': return vertical(-1);
    case 'ArrowDown': return vertical(1);
    default: return null;
  }
}

/** First n in [0, length) for which test(n) holds, or length; test must be monotonic. @param {number} length @param {(n: number) => boolean} test */
function bisect(length, test) {
  let low = 0;
  let high = length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (test(middle)) high = middle;
    else low = middle + 1;
  }
  return low;
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
 *   stickyHeading?: HTMLElement | null,
 *   minItems?: number,
 *   overscan?: number,
 * }} options
 *   createCard builds a card; its signal aborts when the card leaves the DOM and
 *   priority() is its distance in rows from the visible rows (Infinity beyond
 *   the preload range). viewportTop is the first viewport pixel not covered by
 *   sticky chrome. onChange runs after the visible rows change. stickyHeading,
 *   when given, names the group at the top of the viewport while the grid is
 *   scrolled under the chrome. overscan is the preload range on each side, in
 *   viewport heights.
 */
export function createMediaWindow({grid, createCard, viewportTop = () => 0, onChange = () => {}, stickyHeading = null, minItems = WINDOW_MIN_ITEMS, overscan = 1}) {
  /** @type {Item[]} */
  let items = [];
  /** @type {ItemGroup[] | null} */
  let groups = null;
  /** @type {Map<string, number>} */
  let indexByPath = new Map();
  /** @type {Map<number, {card: HTMLElement, controller: AbortController}>} */
  const live = new Map();
  /** Rendered heading elements by group. @type {Map<number, HTMLElement>} */
  const headings = new Map();
  /** @type {WeakMap<Element, number>} */
  const cardIndex = new WeakMap();
  /** @type {GridGeometry} */
  let geometry = {columns: 1, tile: 0, tracks: [], columnGap: 0, rowGap: 0, heading: 0};
  let layout = rowLayout({total: 0, columns: 1, tile: 0, rowGap: 0});
  let measuredWidth = 0;
  let calibrated = false;
  /** @type {RowRange} */
  let range = {start: 0, end: 0};
  /** @type {RowSpan} */
  let visible = {first: 0, last: 0};
  let extra = 0;
  let windowed = false;

  function build() {
    layout = rowLayout({total: items.length, columns: geometry.columns, tile: geometry.tile, tracks: geometry.tracks, rowGap: geometry.rowGap, heading: geometry.heading, groups});
  }

  // The tracks give the column count only: WebKit reports stale track sizes for an
  // empty grid. The equal tracks share the grid width, and a tile is square;
  // calibrate() corrects the row height once cards are rendered.
  function measure() {
    const style = getComputedStyle(grid);
    const columns = style.gridTemplateColumns.split(' ').filter(track => parseFloat(track) > 0).length || 1;
    const columnGap = parseFloat(style.columnGap) || 0;
    const rowGap = parseFloat(style.rowGap) || 0;
    const heading = groups ? parseFloat(style.getPropertyValue('--date-heading-height')) || 0 : 0;
    measuredWidth = grid.getBoundingClientRect().width;
    const tile = Math.max(0, (measuredWidth - (columns - 1) * columnGap) / columns);
    geometry = {columns, tile, tracks: [], columnGap, rowGap, heading};
    calibrated = false;
    build();
  }

  // Track widths differ by subpixels and a row is as tall as its widest square
  // tile; over thousands of rows the estimate would drift. The tracks of a
  // non-empty grid are exact, unlike card rects far down the page (WebKit rounds
  // them in single precision). Returns true when the row heights changed.
  function calibrate() {
    if (calibrated || !live.size) return false;
    calibrated = true;
    const tracks = getComputedStyle(grid).gridTemplateColumns.split(' ').map(parseFloat).filter(value => value > 0);
    if (tracks.length !== geometry.columns || tracks.every((track, column) => track === geometry.tracks[column])) return false;
    geometry = {...geometry, tile: Math.max(...tracks), tracks};
    build();
    return true;
  }

  function updateVisible() {
    const top = grid.getBoundingClientRect().top;
    const pitch = geometry.tile + geometry.rowGap;
    extra = geometry.tile > 0 ? Math.ceil(innerHeight * overscan / pitch) : layout.rows;
    visible = geometry.tile > 0
      ? visibleRows(layout, viewportTop() - top, innerHeight - top)
      : {first: 0, last: Math.max(0, layout.rows - 1)};
  }

  /** @param {number} index */
  function priorityOf(index) {
    const row = layout.itemRow[index];
    const distance = row < visible.first ? visible.first - row : row > visible.last ? row - visible.last : 0;
    return distance > extra ? Infinity : distance;
  }

  // Headings and cards share one order: a heading comes before the items of its group.
  /** @param {number} index */
  const itemOrder = index => index + (groups ? layout.group[layout.itemRow[index]] + 1 : 0);
  /** @param {number} group */
  const headingOrder = group => layout.itemStart[layout.groupRow[group]] + group;

  /** @param {number} index */
  function createEntry(index) {
    const controller = new AbortController();
    const card = createCard(items[index], index, {signal: controller.signal, priority: () => priorityOf(index)});
    cardIndex.set(card, index);
    const entry = {card, controller};
    live.set(index, entry);
    return entry;
  }

  /** @param {number} group */
  function createHeading(group) {
    const heading = document.createElement('h2');
    heading.className = 'media-group-heading';
    heading.textContent = groups?.[group].label ?? '';
    headings.set(group, heading);
    return heading;
  }

  /** @param {number} index */
  function drop(index) {
    const entry = live.get(index);
    if (!entry) return;
    live.delete(index);
    entry.controller.abort();
    entry.card.remove();
  }

  /** @param {number} index @param {HTMLElement} card @param {boolean} [parked] */
  function pin(index, card, parked = false) {
    const {tile, columnGap} = geometry;
    const row = layout.itemRow[index];
    card.classList.add('is-window-pinned');
    if (parked) card.classList.add('is-window-parked');
    else card.classList.remove('is-window-parked');
    card.style.top = parked ? '0' : `${layout.top[row]}px`;
    card.style.left = parked ? '0' : `${(index - layout.itemStart[row]) * (tile + columnGap)}px`;
    card.style.width = `${tile}px`;
  }

  /** @param {HTMLElement} card */
  function unpin(card) {
    if (!card.classList.contains('is-window-pinned')) return;
    card.classList.remove('is-window-pinned');
    card.classList.remove('is-window-parked');
    card.style.removeProperty('top');
    card.style.removeProperty('left');
    card.style.removeProperty('width');
  }

  /** @param {number} row */
  const rowInRange = row => row >= range.start && row < range.end;

  /** Rendered nodes in DOM order. */
  function rendered() {
    return [
      ...[...live].map(([index, {card}]) => ({order: itemOrder(index), node: card})),
      ...[...headings].map(([group, node]) => ({order: headingOrder(group), node})),
    ].sort((left, right) => left.order - right.order);
  }

  // Existing cards are never moved, only removed: moving a node would drop its
  // focus and restart its animations. New nodes are inserted around them.
  /** @param {RowRange} next */
  function render(next) {
    range = next;
    const active = document.activeElement;
    for (const [index, {card}] of live) {
      if (rowInRange(layout.itemRow[index])) unpin(card);
      // Park the focused card outside the viewport. Keeping it at its logical,
      // absolutely positioned cell makes WebKit pull the document back to it.
      else if (active && card.contains(active)) pin(index, card, true);
      else drop(index);
    }
    for (const [group, heading] of headings) {
      if (rowInRange(layout.groupRow[group])) continue;
      heading.remove();
      headings.delete(group);
    }
    const existing = rendered();
    let following = 0;
    const fragment = document.createDocumentFragment();
    const flush = () => {
      if (!fragment.childNodes.length) return;
      grid.insertBefore(fragment, existing[following]?.node ?? null);
    };
    /** @param {number} order @param {() => HTMLElement} create */
    const place = (order, create) => {
      while (following < existing.length && existing[following].order < order) following++;
      if (existing[following]?.order === order) {
        flush();
        following++;
        return;
      }
      fragment.append(create());
    };
    for (let row = range.start; row < range.end; row++) {
      if (layout.heading[row]) {
        const group = layout.group[row];
        place(headingOrder(group), () => createHeading(group));
        continue;
      }
      for (let index = layout.itemStart[row]; index < layout.itemStart[row + 1]; index++) place(itemOrder(index), () => createEntry(index).card);
    }
    flush();
    const padding = windowed ? rangePadding(layout, range) : {top: 0, bottom: 0};
    grid.style.paddingTop = padding.top ? `${padding.top}px` : '';
    grid.style.paddingBottom = padding.bottom ? `${padding.bottom}px` : '';
  }

  /** The rows a windowed grid wants for the current scroll position. */
  function wantedRange() {
    if (!windowed) return {start: 0, end: layout.rows};
    if (geometry.tile <= 0) return {start: 0, end: layout.itemRow[Math.min(items.length, minItems) - 1] + 1};
    return windowRange({rows: layout.rows, visible, extra});
  }

  // The sticky copy of a heading shows once the grid top is under the chrome; it
  // names the group of the first row below itself.
  function updateStickyHeading() {
    if (!stickyHeading) return;
    const top = grid.getBoundingClientRect().top;
    const show = Boolean(groups) && layout.rows > 0 && geometry.tile > 0 && top < viewportTop();
    if (show) {
      const line = viewportTop() - top + geometry.heading;
      stickyHeading.textContent = groups?.[layout.group[visibleRows(layout, line, line + 1).first]].label ?? '';
    }
    stickyHeading.hidden = !show;
  }

  /** Follow the scroll position; cheap when the rendered rows still cover it. */
  function follow() {
    updateVisible();
    const covered = live.size > 0 && (!windowed || rangeCovers({range, rows: layout.rows, visible, margin: Math.ceil(extra / 2)}));
    if (!covered) render(wantedRange());
    if (calibrate()) {
      updateVisible();
      render(wantedRange());
    }
    updateStickyHeading();
    onChange();
  }

  // A width change (window resize, a scrollbar that the new height brought) is
  // caught here, synchronously, so no frame is painted with stale padding. A grid
  // in a hidden application section has no width and keeps its last geometry.
  function sync() {
    if (!items.length) return;
    const width = grid.getBoundingClientRect().width;
    if (!width) return;
    if (width !== measuredWidth) relayout();
    else follow();
  }

  /**
   * Re-measure after the column count or tile size changed. The first item at
   * the top of the viewport keeps its row's offset on screen.
   */
  function relayout() {
    if (!items.length) return;
    if (!windowed) {
      measure();
      follow();
      return;
    }
    updateVisible();
    const anchor = Math.min(layout.itemStart[visible.first], items.length - 1);
    const anchorTop = grid.getBoundingClientRect().top + layout.top[layout.itemRow[anchor]];
    measure();
    const row = layout.itemRow[anchor];
    extra = geometry.tile > 0 ? Math.ceil(innerHeight * overscan / (geometry.tile + geometry.rowGap)) : layout.rows;
    visible = {first: row, last: row};
    render(wantedRange());
    if (calibrate()) render(wantedRange());
    const shift = grid.getBoundingClientRect().top + layout.top[layout.itemRow[anchor]] - anchorTop;
    if (shift) scrollBy({top: shift, behavior: 'instant'});
    follow();
  }

  /**
   * Make sure the card of an item exists and return it. A card outside the
   * rendered rows is pinned at its cell until the next range change that it
   * does not hold focus through.
   * @param {number} index
   */
  function revealIndex(index) {
    if (index < 0 || index >= items.length) return null;
    const known = live.get(index);
    if (known) return known.card;
    const {card} = createEntry(index);
    const order = itemOrder(index);
    const before = rendered().find(entry => entry.order > order)?.node ?? null;
    grid.insertBefore(card, before);
    pin(index, card);
    return card;
  }

  function clear() {
    for (const index of [...live.keys()]) drop(index);
    headings.clear();
    items = [];
    groups = null;
    indexByPath = new Map();
    range = {start: 0, end: 0};
    build();
    grid.replaceChildren();
    grid.style.paddingTop = '';
    grid.style.paddingBottom = '';
    grid.classList.remove('is-grouped');
    grid.setAttribute('aria-live', 'polite');
    if (stickyHeading) stickyHeading.hidden = true;
  }

  addEventListener('scroll', sync, {passive: true});
  addEventListener('resize', sync);

  return {
    /**
     * Replace the list; cards of the previous list are dropped. Groups, when given,
     * split the list into consecutive runs that each start with a heading; groups
     * that do not add up to the list are ignored.
     * @param {Item[]} list @param {ItemGroup[] | null} [groupList]
     */
    setItems(list, groupList = null) {
      clear();
      items = list;
      groups = groupList && groupList.reduce((sum, group) => sum + group.count, 0) === list.length ? groupList : null;
      if (groups) grid.classList.add('is-grouped');
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
      const target = neighbourIndex(layout, index, key);
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
