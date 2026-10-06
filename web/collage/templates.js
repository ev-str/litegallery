// @ts-check

import {GEOMETRY_EPSILON, intersectionArea, rectArea} from './geometry.js';

/** @typedef {import('./types.js').CollageTemplate} CollageTemplate */
/** @typedef {import('./types.js').NormalizedRect} NormalizedRect */

/** @param {NormalizedRect} rect */
function orientationFor(rect) {
  const aspect = rect.width / rect.height;
  if (aspect > 1.18) return /** @type {const} */ ('landscape');
  if (aspect < .85) return /** @type {const} */ ('portrait');
  return /** @type {const} */ ('square');
}

/**
 * @param {string} id
 * @param {string} family
 * @param {NormalizedRect[]} rects
 * @returns {CollageTemplate}
 */
function defineTemplate(id, family, rects) {
  const cells = rects.map((rect, index) => Object.freeze({
    id: `cell-${index + 1}`,
    rect: Object.freeze({...rect}),
    preferredOrientation: orientationFor(rect),
  }));
  const template = {id, photoCount: cells.length, family, cells};
  assertTemplatePartition(template);
  Object.freeze(cells);
  return Object.freeze(template);
}

/** @param {number} count @param {number} [offset] @param {number} [span] */
function slices(count, offset = 0, span = 1) {
  return Array.from({length: count}, (_, index) => ({offset: offset + span * index / count, span: span / count}));
}

/** @param {number[]} counts @param {number[]=} widths */
function columns(counts, widths) {
  const columnWidths = widths || counts.map(() => 1 / counts.length);
  if (columnWidths.length !== counts.length) throw new RangeError('Column widths must match column counts');
  const total = columnWidths.reduce((sum, width) => sum + width, 0);
  let x = 0;
  /** @type {NormalizedRect[]} */
  const result = [];
  counts.forEach((count, index) => {
    const width = columnWidths[index] / total;
    for (const row of slices(count)) result.push({x, y: row.offset, width, height: row.span});
    x += width;
  });
  return result;
}

/**
 * Two columns whose cells have independent, deliberately uneven heights.
 * Values are relative weights and are normalized inside each column.
 * @param {number} leftWidth
 * @param {number[]} leftHeights
 * @param {number[]} rightHeights
 */
function staggeredColumns(leftWidth, leftHeights, rightHeights) {
  /** @type {NormalizedRect[]} */
  const result = [];
  /** @param {number} x @param {number} width @param {number[]} heights */
  const append = (x, width, heights) => {
    const total = heights.reduce((sum, height) => sum + height, 0);
    let y = 0;
    for (const height of heights) {
      const normalized = height / total;
      result.push({x, y, width, height: normalized});
      y += normalized;
    }
  };
  append(0, leftWidth, leftHeights);
  append(leftWidth, 1 - leftWidth, rightHeights);
  return result;
}

/** @param {NormalizedRect} rect */
function transformRect(rect, flipX = false, flipY = false) {
  return {
    ...rect,
    x: flipX ? Math.round((1 - rect.x - rect.width) * 1e9) / 1e9 : rect.x,
    y: flipY ? Math.round((1 - rect.y - rect.height) * 1e9) / 1e9 : rect.y,
  };
}

/** @param {CollageTemplate} template @param {boolean} flipX @param {boolean} flipY @param {string} id */
function transformedTemplate(template, flipX, flipY, id) {
  return defineTemplate(id, template.family, template.cells.map(cell => transformRect(cell.rect, flipX, flipY)));
}

/** @param {number} value */
const geometryKey = value => Math.round(value * 1e9) / 1e9;

/** @param {CollageTemplate} template @param {boolean} flipX @param {boolean} flipY */
function templateSignature(template, flipX = false, flipY = false) {
  return template.cells.map(cell => {
    const rect = transformRect(cell.rect, flipX, flipY);
    return [rect.x, rect.y, rect.width, rect.height].map(geometryKey).join(':');
  }).sort().join('|');
}

/** @param {number[]} counts @param {number[]=} heights */
function rows(counts, heights) {
  const rowHeights = heights || counts.map(() => 1 / counts.length);
  if (rowHeights.length !== counts.length) throw new RangeError('Row heights must match row counts');
  const total = rowHeights.reduce((sum, height) => sum + height, 0);
  let y = 0;
  /** @type {NormalizedRect[]} */
  const result = [];
  counts.forEach((count, index) => {
    const height = rowHeights[index] / total;
    for (const column of slices(count)) result.push({x: column.offset, y, width: column.span, height});
    y += height;
  });
  return result;
}

/** @param {number} count @param {boolean} mirror */
function heroSide(count, mirror) {
  const rects = columns(mirror ? [count - 1, 1] : [1, count - 1], mirror ? [.42, .58] : [.58, .42]);
  return rects;
}

/**
 * A rectangular "sun": the centre column has a dominant middle frame while
 * both side columns hold smaller frames. It remains an exact partition.
 * @param {number} count
 */
function sun(count) {
  const sideTotal = count - 3;
  const left = Math.floor(sideTotal / 2);
  const right = sideTotal - left;
  /** @type {NormalizedRect[]} */
  const rects = [];
  if (left) for (const item of columns([left], [1])) rects.push({...item, width: .25});
  rects.push(
    {x: .25, y: 0, width: .5, height: .2},
    {x: .25, y: .2, width: .5, height: .6},
    {x: .25, y: .8, width: .5, height: .2},
  );
  if (right) {
    for (const item of columns([right], [1])) rects.push({...item, x: .75, width: .25});
  }
  return rects;
}

/** @param {number[]} counts @param {number[]} heights */
function magazineRows(counts, heights) {
  return rows(counts, heights);
}

/**
 * A rectangular pinwheel. Five cells make the recognisable centre-and-arms
 * motif; higher counts split the arms without introducing holes or overlaps.
 * @param {number} count
 */
function pinwheel(count) {
  if (count === 4) return [
    {x: 0, y: 0, width: 1, height: .32},
    {x: .62, y: .32, width: .38, height: .68},
    {x: 0, y: .72, width: .62, height: .28},
    {x: 0, y: .32, width: .62, height: .40},
  ];
  /** @type {NormalizedRect[]} */
  const rects = [
    {x: 0, y: 0, width: .62, height: .38},
    {x: .62, y: 0, width: .38, height: .62},
    {x: .38, y: .62, width: .62, height: .38},
    {x: 0, y: .38, width: .38, height: .62},
    {x: .38, y: .38, width: .24, height: .24},
  ];
  const arms = [0, 1, 2, 3, 0, 1, 2];
  for (let index = 5; index < count; index += 1) {
    const target = arms[index - 5];
    const rect = rects[target];
    const vertical = rect.height > rect.width;
    const first = vertical
      ? {...rect, height: rect.height * .5}
      : {...rect, width: rect.width * .5};
    const second = vertical
      ? {...rect, y: rect.y + first.height, height: rect.height - first.height}
      : {...rect, x: rect.x + first.width, width: rect.width - first.width};
    rects.splice(target, 1, first, second);
    for (let arm = index - 4; arm < arms.length; arm += 1) if (arms[arm] > target) arms[arm] += 1;
  }
  return rects;
}

/** @type {CollageTemplate[]} */
const definitions = [];
/** @param {string} id @param {string} family @param {NormalizedRect[]} rects */
const add = (id, family, rects) => definitions.push(defineTemplate(id, family, rects));

add('2-columns', 'equal', columns([1, 1]));
add('2-rows', 'equal', rows([1, 1]));
add('2-wide-left', 'asymmetric', columns([1, 1], [.64, .36]));
add('2-wide-right', 'asymmetric', columns([1, 1], [.36, .64]));
add('2-wide-top', 'asymmetric', rows([1, 1], [.64, .36]));
add('2-wide-bottom', 'asymmetric', rows([1, 1], [.36, .64]));

add('3-columns', 'equal', columns([1, 1, 1]));
add('3-rows', 'equal', rows([1, 1, 1]));
add('3-hero-left', 'hero', columns([1, 2], [.6, .4]));
add('3-hero-right', 'hero', columns([2, 1], [.4, .6]));
add('3-hero-top', 'hero', rows([1, 2], [.6, .4]));
add('3-hero-bottom', 'hero', rows([2, 1], [.4, .6]));

add('4-grid', 'equal', rows([2, 2]));
add('4-columns', 'equal', columns([1, 1, 1, 1]));
add('4-rows', 'equal', rows([1, 1, 1, 1]));
add('4-hero-left', 'hero', columns([1, 3], [.58, .42]));
add('4-hero-right', 'hero', columns([3, 1], [.42, .58]));
add('4-hero-top', 'hero', rows([1, 3], [.58, .42]));
add('4-hero-bottom', 'hero', rows([3, 1], [.42, .58]));
add('4-wide-left-grid', 'asymmetric', columns([2, 2], [.62, .38]));
add('4-wide-right-grid', 'asymmetric', columns([2, 2], [.38, .62]));
add('4-magazine-corner', 'magazine', [
  {x: 0, y: 0, width: 1, height: .38},
  {x: 0, y: .38, width: .62, height: .62},
  {x: .62, y: .38, width: .38, height: .31},
  {x: .62, y: .69, width: .38, height: .31},
]);
add('4-staggered-1', 'staggered', staggeredColumns(.44, [45, 55], [55, 45]));
add('4-staggered-2', 'staggered', staggeredColumns(.56, [55, 45], [45, 55]));
add('4-staggered-6', 'staggered', staggeredColumns(.54, [65, 35], [48, 52]));
add('4-staggered-11', 'staggered', staggeredColumns(.38, [55, 45], [45, 55]));
add('4-staggered-12', 'staggered', staggeredColumns(.62, [45, 55], [55, 45]));

add('5-rows-2-3', 'rows', rows([2, 3]));
add('5-rows-3-2', 'rows', rows([3, 2]));
add('5-columns-2-3', 'columns', columns([2, 3], [.5, .5]));
add('5-columns-3-2', 'columns', columns([3, 2], [.5, .5]));
add('5-columns-2-3-wide', 'columns', columns([2, 3], [.64, .36]));
add('5-columns-3-2-wide', 'columns', columns([3, 2], [.36, .64]));
add('5-rows-2-3-wide', 'rows', rows([2, 3], [.64, .36]));
add('5-rows-3-2-wide', 'rows', rows([3, 2], [.36, .64]));
add('5-hero-left', 'hero', heroSide(5, false));
add('5-hero-right', 'hero', heroSide(5, true));
add('5-hero-top', 'hero', rows([1, 4], [.58, .42]));
add('5-hero-bottom', 'hero', rows([4, 1], [.42, .58]));
add('5-sun', 'sun', sun(5));
add('5-magazine-bands', 'magazine', magazineRows([2, 1, 2], [.29, .42, .29]));
add('5-magazine-lower-corner', 'magazine', [
  {x: 0, y: 0, width: .5, height: .38}, {x: .5, y: 0, width: .5, height: .38},
  {x: 0, y: .38, width: .62, height: .62},
  {x: .62, y: .38, width: .38, height: .31}, {x: .62, y: .69, width: .38, height: .31},
]);
add('5-staggered-1', 'staggered', staggeredColumns(.44, [46, 54], [28, 34, 38]));
add('5-staggered-2', 'staggered', staggeredColumns(.56, [56, 44], [38, 34, 28]));
add('5-staggered-3', 'staggered', staggeredColumns(.40, [38, 62], [30, 42, 28]));
add('5-staggered-4', 'staggered', staggeredColumns(.60, [62, 38], [28, 42, 30]));

add('6-grid-3x2', 'equal', rows([3, 3]));
add('6-grid-2x3', 'equal', columns([3, 3]));
add('6-columns-2-4', 'columns', columns([2, 4], [.54, .46]));
add('6-columns-4-2', 'columns', columns([4, 2], [.46, .54]));
add('6-columns-2-4-wide', 'columns', columns([2, 4], [.66, .34]));
add('6-columns-4-2-wide', 'columns', columns([4, 2], [.34, .66]));
add('6-hero-left', 'hero', heroSide(6, false));
add('6-hero-right', 'hero', heroSide(6, true));
add('6-hero-top', 'hero', rows([1, 5], [.58, .42]));
add('6-hero-bottom', 'hero', rows([5, 1], [.42, .58]));
add('6-sun', 'sun', sun(6));
add('6-magazine-corner', 'magazine', [
  {x: 0, y: 0, width: 1, height: .36},
  {x: 0, y: .36, width: .58, height: .64},
  {x: .58, y: .36, width: .42, height: .32},
  {x: .58, y: .68, width: .14, height: .32}, {x: .72, y: .68, width: .14, height: .32}, {x: .86, y: .68, width: .14, height: .32},
]);
add('6-magazine-bands', 'magazine', magazineRows([2, 1, 3], [.3, .4, .3]));
add('6-staggered-1', 'staggered', staggeredColumns(.45, [42, 58], [20, 27, 23, 30]));
add('6-staggered-2', 'staggered', staggeredColumns(.55, [58, 42], [30, 23, 27, 20]));
add('6-staggered-3', 'staggered', staggeredColumns(.41, [36, 64], [24, 32, 18, 26]));
add('6-staggered-4', 'staggered', staggeredColumns(.59, [64, 36], [26, 18, 32, 24]));
add('6-staggered-5', 'staggered', staggeredColumns(.46, [26, 34, 40], [38, 34, 28]));

add('7-rows-3-4', 'rows', rows([3, 4]));
add('7-columns-2-5', 'columns', columns([2, 5], [.56, .44]));
add('7-columns-5-2', 'columns', columns([5, 2], [.44, .56]));
add('7-columns-2-5-equal', 'columns', columns([2, 5]));
add('7-columns-5-2-equal', 'columns', columns([5, 2]));
add('7-columns-2-5-wide', 'columns', columns([2, 5], [.68, .32]));
add('7-columns-5-2-wide', 'columns', columns([5, 2], [.32, .68]));
add('7-rows-2-5', 'rows', rows([2, 5], [.55, .45]));
add('7-hero-left', 'hero', heroSide(7, false));
add('7-hero-right', 'hero', heroSide(7, true));
add('7-hero-top', 'hero', rows([1, 6], [.58, .42]));
add('7-hero-bottom', 'hero', rows([6, 1], [.42, .58]));
add('7-sun', 'sun', sun(7));
add('7-magazine-bands', 'magazine', magazineRows([3, 1, 3], [.28, .44, .28]));
add('7-magazine-columns', 'magazine', staggeredColumns(.63, [37, 63], [16, 19, 24, 18, 23]));
add('7-staggered-1', 'staggered', staggeredColumns(.46, [45, 55], [16, 20, 18, 24, 22]));
add('7-staggered-2', 'staggered', staggeredColumns(.54, [55, 45], [22, 24, 18, 20, 16]));
add('7-staggered-3', 'staggered', staggeredColumns(.41, [38, 62], [18, 14, 24, 20, 24]));
add('7-staggered-4', 'staggered', staggeredColumns(.59, [62, 38], [24, 20, 24, 14, 18]));
add('7-staggered-5', 'staggered', staggeredColumns(.47, [25, 34, 41], [28, 22, 26, 24]));
add('7-staggered-6', 'staggered', staggeredColumns(.53, [41, 34, 25], [24, 26, 22, 28]));

add('8-grid-4x2', 'equal', rows([4, 4]));
add('8-grid-2x4', 'equal', columns([4, 4]));
add('8-columns-2-6', 'columns', columns([2, 6], [.58, .42]));
add('8-columns-6-2', 'columns', columns([6, 2], [.42, .58]));
add('8-columns-6-2-equal', 'columns', columns([6, 2]));
add('8-columns-2-6-wide', 'columns', columns([2, 6], [.68, .32]));
add('8-columns-6-2-wide', 'columns', columns([6, 2], [.32, .68]));
add('8-rows-2-6', 'rows', rows([2, 6], [.58, .42]));
add('8-rows-6-2', 'rows', rows([6, 2], [.42, .58]));
add('8-rows-3-5', 'rows', rows([3, 5]));
add('8-hero-left', 'hero', heroSide(8, false));
add('8-hero-right', 'hero', heroSide(8, true));
add('8-sun', 'sun', sun(8));
add('8-staggered-1', 'staggered', staggeredColumns(.47, [44, 56], [14, 18, 16, 20, 17, 15]));
add('8-staggered-2', 'staggered', staggeredColumns(.53, [56, 44], [15, 17, 20, 16, 18, 14]));
add('8-staggered-3', 'staggered', staggeredColumns(.42, [36, 64], [17, 13, 19, 15, 21, 15]));
add('8-staggered-5', 'staggered', staggeredColumns(.46, [24, 32, 44], [14, 18, 22, 20, 26]));
add('8-staggered-6', 'staggered', staggeredColumns(.54, [44, 32, 24], [26, 20, 22, 18, 14]));

add('9-grid', 'equal', rows([3, 3, 3]));
add('9-columns-3-6', 'columns', columns([3, 6], [.55, .45]));
add('9-columns-6-3', 'columns', columns([6, 3], [.45, .55]));
add('9-rows-3-6', 'rows', rows([3, 6], [.55, .45]));
add('9-rows-6-3', 'rows', rows([6, 3], [.45, .55]));
add('9-columns-3-6-wide', 'columns', columns([3, 6], [.65, .35]));
add('9-columns-6-3-wide', 'columns', columns([6, 3], [.35, .65]));
add('9-columns-4-5', 'columns', columns([4, 5]));
add('9-hero-left', 'hero', heroSide(9, false));
add('9-hero-right', 'hero', heroSide(9, true));
add('9-sun', 'sun', sun(9));
add('9-centre-hero', 'magazine', [
  ...rows([3], [1]).map(rect => ({...rect, height: .22})),
  {x: 0, y: .22, width: .22, height: .56},
  {x: .22, y: .22, width: .56, height: .56},
  {x: .78, y: .22, width: .22, height: .56},
  ...rows([3], [1]).map(rect => ({...rect, y: .78, height: .22})),
]);

add('10-rows-four', 'rows', rows([3, 3, 2, 2]));
add('10-rows-four-mirror', 'rows', rows([2, 2, 3, 3]));
add('10-columns-3-7', 'columns', columns([3, 7], [.57, .43]));
add('10-columns-7-3', 'columns', columns([7, 3], [.43, .57]));
add('10-columns-5-5', 'equal', columns([5, 5]));
add('10-columns-4-6', 'columns', columns([4, 6], [.55, .45]));
add('10-columns-6-4', 'columns', columns([6, 4], [.45, .55]));
add('10-rows-4-6', 'rows', rows([4, 6], [.55, .45]));
add('10-rows-6-4', 'rows', rows([6, 4], [.45, .55]));
add('10-hero-left', 'hero', heroSide(10, false));
add('10-hero-right', 'hero', heroSide(10, true));
add('10-sun', 'sun', sun(10));
add('10-magazine-3-2-1-4', 'magazine', magazineRows([3, 2, 1, 4], [.22, .24, .32, .22]));

add('11-rows-four', 'rows', rows([3, 3, 3, 2]));
add('11-rows-four-mirror', 'rows', rows([2, 3, 3, 3]));
add('11-columns-4-7', 'columns', columns([4, 7], [.56, .44]));
add('11-columns-7-4', 'columns', columns([7, 4], [.44, .56]));
add('11-columns-5-6', 'columns', columns([5, 6]));
add('11-columns-6-5', 'columns', columns([6, 5]));
add('11-columns-4-7-wide', 'columns', columns([4, 7], [.64, .36]));
add('11-columns-7-4-wide', 'columns', columns([7, 4], [.36, .64]));
add('11-rows-5-6', 'rows', rows([5, 6]));
add('11-rows-6-5', 'rows', rows([6, 5]));
add('11-hero-left', 'hero', heroSide(11, false));
add('11-hero-right', 'hero', heroSide(11, true));
add('11-sun', 'sun', sun(11));

add('12-grid-4x3', 'equal', rows([4, 4, 4]));
add('12-grid-3x4', 'equal', columns([4, 4, 4]));
add('12-columns-5-7', 'columns', columns([5, 7], [.55, .45]));
add('12-columns-7-5', 'columns', columns([7, 5], [.45, .55]));
add('12-columns-6-6', 'equal', columns([6, 6]));
add('12-columns-4-8', 'columns', columns([4, 8], [.58, .42]));
add('12-columns-8-4', 'columns', columns([8, 4], [.42, .58]));
add('12-rows-5-7', 'rows', rows([5, 7], [.55, .45]));
add('12-rows-7-5', 'rows', rows([7, 5], [.45, .55]));
add('12-hero-left', 'hero', heroSide(12, false));
add('12-hero-right', 'hero', heroSide(12, true));
add('12-sun', 'sun', sun(12));

for (let count = 4; count <= 12; count += 1) add(`${count}-pinwheel`, 'pinwheel', pinwheel(count));

// Portrait-first partitions: every column contains at most three stacked
// frames, so these stay readable on tall print formats without empty areas.
add('3-portrait-centre', 'portrait', columns([1, 1, 1], [.27, .46, .27]));
add('3-portrait-left', 'portrait', columns([1, 1, 1], [.46, .27, .27]));
add('3-portrait-right', 'portrait', columns([1, 1, 1], [.27, .27, .46]));
add('4-portrait-left', 'portrait', columns([1, 1, 2]));
add('4-portrait-right', 'portrait', columns([2, 1, 1]));
add('5-portrait-left', 'portrait', columns([1, 2, 2]));
add('5-portrait-right', 'portrait', columns([2, 2, 1]));
add('6-portrait', 'portrait', columns([2, 2, 2]));
add('7-portrait-left', 'portrait', columns([2, 2, 3]));
add('7-portrait-right', 'portrait', columns([3, 2, 2]));
add('8-portrait-left', 'portrait', columns([2, 3, 3]));
add('8-portrait-right', 'portrait', columns([3, 3, 2]));
add('9-portrait', 'portrait', columns([3, 3, 3]));
add('10-portrait-left', 'portrait', columns([2, 2, 3, 3]));
add('10-portrait-right', 'portrait', columns([3, 3, 2, 2]));
add('11-portrait-left', 'portrait', columns([2, 3, 3, 3]));
add('11-portrait-right', 'portrait', columns([3, 3, 3, 2]));
add('12-portrait', 'portrait', columns([3, 3, 3, 3]));

/** @type {ReadonlyArray<CollageTemplate>} */
export const COLLAGE_TEMPLATES = Object.freeze(definitions);

/** @param {number} photoCount */
export function getTemplatesForCount(photoCount) {
  return COLLAGE_TEMPLATES.filter(template => template.photoCount === photoCount);
}

/**
 * Templates shown in the chooser. Horizontal mirror duplicates stay available
 * to old projects and getTemplate(), but occupy only one chooser slot.
 * @param {number} photoCount
 */
export function getVisibleTemplatesForCount(photoCount) {
  const templates = getTemplatesForCount(photoCount);
  const seen = new Set();
  return templates.filter(template => {
    const canonical = [
      templateSignature(template),
      templateSignature(template, true, false),
      templateSignature(template, false, true),
      templateSignature(template, true, true),
    ].sort()[0];
    if (seen.has(canonical)) return false;
    seen.add(canonical);
    return true;
  });
}

/** @param {string} templateId */
export function getTemplate(templateId) {
  const template = COLLAGE_TEMPLATES.find(item => item.id === templateId);
  if (template) return template;
  for (const suffix of ['--flip-xy', '--flip-x', '--flip-y']) {
    if (!templateId.endsWith(suffix)) continue;
    const source = COLLAGE_TEMPLATES.find(item => item.id === templateId.slice(0, -suffix.length));
    if (source) return transformedTemplate(source, suffix !== '--flip-y', suffix !== '--flip-x', templateId);
  }
  if (templateId.endsWith('--mirror')) {
    const source = COLLAGE_TEMPLATES.find(item => item.id === templateId.slice(0, -'--mirror'.length));
    if (source) return transformedTemplate(source, true, false, templateId);
  }
  throw new RangeError(`Unknown collage template: ${templateId}`);
}

/** @param {CollageTemplate} template */
export function isTemplateMirrorable(template) {
  return templateSignature(template) !== templateSignature(template, true, false);
}

/**
 * Resolve a horizontal mirror without ever borrowing another template's cell
 * order. Canonical templates use a deterministic virtual mirror whose cells
 * are reflected one by one. Legacy hidden mirror IDs return to their visible
 * canonical template, so imported projects also get a reliable "Вернуть".
 * @param {string} templateId
 */
export function getMirroredTemplateId(templateId) {
  return getTransformedTemplateId(templateId, 'x');
}

/** @param {string} templateId */
export function getCanonicalTemplateId(templateId) {
  const template = getTemplate(templateId);
  return getVisibleTemplatesForCount(template.photoCount).find(candidate => {
    const signature = templateSignature(template);
    return [
      templateSignature(candidate),
      templateSignature(candidate, true, false),
      templateSignature(candidate, false, true),
      templateSignature(candidate, true, true),
    ].includes(signature);
  })?.id || template.id;
}

/** @param {string} templateId */
export function getTemplateTransformState(templateId) {
  if (templateId.endsWith('--flip-xy')) return {flipX: true, flipY: true};
  if (templateId.endsWith('--flip-x') || templateId.endsWith('--mirror')) return {flipX: true, flipY: false};
  if (templateId.endsWith('--flip-y')) return {flipX: false, flipY: true};
  const template = getTemplate(templateId);
  const canonical = getTemplate(getCanonicalTemplateId(templateId));
  const signature = templateSignature(template);
  for (const state of [
    {flipX: false, flipY: false},
    {flipX: true, flipY: false},
    {flipX: false, flipY: true},
    {flipX: true, flipY: true},
  ]) {
    if (templateSignature(canonical, state.flipX, state.flipY) === signature) return state;
  }
  return {flipX: false, flipY: false};
}

/** @param {string} templateId @param {'x'|'y'} axis */
export function getTransformedTemplateId(templateId, axis) {
  const canonicalId = getCanonicalTemplateId(templateId);
  const state = getTemplateTransformState(templateId);
  const flipX = axis === 'x' ? !state.flipX : state.flipX;
  const flipY = axis === 'y' ? !state.flipY : state.flipY;
  if (!flipX && !flipY) return canonicalId;
  return `${canonicalId}${flipX && flipY ? '--flip-xy' : flipX ? '--flip-x' : '--flip-y'}`;
}

/** @param {string} templateId @param {'x'|'y'} axis */
export function isTemplateAxisSymmetric(templateId, axis) {
  const canonical = getTemplate(getCanonicalTemplateId(templateId));
  return templateSignature(canonical) === templateSignature(canonical, axis === 'x', axis === 'y');
}

/** @param {number} photoCount */
export function getDefaultTemplate(photoCount) {
  const template = getTemplatesForCount(photoCount)[0];
  if (!template) throw new RangeError(`Templates support 2 to 12 photos, received ${photoCount}`);
  return template;
}

/** @param {CollageTemplate} template */
export function assertTemplatePartition(template) {
  const totalArea = template.cells.reduce((sum, cell) => sum + rectArea(cell.rect), 0);
  if (Math.abs(totalArea - 1) > GEOMETRY_EPSILON) throw new Error(`Template ${template.id} does not fill the canvas`);
  for (let left = 0; left < template.cells.length; left += 1) {
    const rect = template.cells[left].rect;
    if (rect.x < 0 || rect.y < 0 || rect.width <= 0 || rect.height <= 0 || rect.x + rect.width > 1 + GEOMETRY_EPSILON || rect.y + rect.height > 1 + GEOMETRY_EPSILON) {
      throw new Error(`Template ${template.id} contains an invalid cell`);
    }
    for (let right = left + 1; right < template.cells.length; right += 1) {
      if (intersectionArea(rect, template.cells[right].rect) > GEOMETRY_EPSILON) throw new Error(`Template ${template.id} contains overlapping cells`);
    }
  }
  return template;
}
