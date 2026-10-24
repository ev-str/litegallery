// @ts-check

// Grouping of the visible media list by an indexed EXIF or container capture
// time. Files without one stay in the final "Без даты" group. Nothing is read
// from the files here. Inside a group the list keeps its own order, so the flat
// list a viewer gets is exactly the order of the tiles on screen.

/** @typedef {'none'|'year'|'month'|'day'} GroupMode */
/** @typedef {{key: string, label: string, count: number}} DateGroup consecutive items of one date */

/** @type {readonly GroupMode[]} */
export const GROUP_MODES = ['none', 'year', 'month', 'day'];
/** localStorage key of the chosen mode; values are GROUP_MODES, anything else means 'none'. */
export const GROUP_STORAGE_KEY = 'gallery-media-group';
export const UNDATED_LABEL = 'Без даты';

const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const MONTHS_GENITIVE = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

/** @param {unknown} value @returns {GroupMode} */
export const normalizeGroupMode = value => (GROUP_MODES.includes(/** @type {GroupMode} */ (value)) ? /** @type {GroupMode} */ (value) : 'none');

const pad = (/** @type {number} */ value, /** @type {number} */ width) => String(value).padStart(width, '0');

/**
 * Key of the group a Unix time in seconds falls into, in local time: '2026',
 * '2026-09', '2026-09-06'. Keys compare as strings in date order; an item
 * without a date gets '', which sorts as the oldest.
 * @param {number | undefined} seconds @param {GroupMode} mode
 */
export function groupKey(seconds, mode) {
  if (!seconds || mode === 'none') return '';
  const date = new Date(seconds * 1000);
  const year = pad(date.getFullYear(), 4);
  if (mode === 'year') return year;
  const month = `${year}-${pad(date.getMonth() + 1, 2)}`;
  return mode === 'month' ? month : `${month}-${pad(date.getDate(), 2)}`;
}

/** Heading of a group: '2026', 'сентябрь 2026', '6 сентября 2026'. @param {string} key */
export function groupLabel(key) {
  if (!key) return UNDATED_LABEL;
  const [year, month, day] = key.split('-').map(Number);
  if (month === undefined) return String(year);
  if (day === undefined) return `${MONTHS[month - 1]} ${year}`;
  return `${day} ${MONTHS_GENITIVE[month - 1]} ${year}`;
}

/**
 * Consecutive runs of one date in an already grouped list, or null without grouping.
 * @param {{sortTime?: number, captured?: boolean}[]} items @param {GroupMode} mode
 * @returns {DateGroup[] | null}
 */
export function groupRuns(items, mode) {
  if (mode === 'none') return null;
  /** @type {DateGroup[]} */
  const groups = [];
  for (const item of items) {
    const key = groupKey(item.captured ? item.sortTime : 0, mode);
    const last = groups.at(-1);
    if (last?.key === key) last.count++;
    else groups.push({key, label: groupLabel(key), count: 1});
  }
  return groups;
}

/**
 * Group a sorted list: groups in date order, newest first when `descending`;
 * each group keeps the items in the order they came. A list sorted by date is
 * returned in the same order.
 * @template {{sortTime?: number, captured?: boolean}} T
 * @param {T[]} items sorted list @param {GroupMode} mode @param {boolean} descending
 * @returns {{items: T[], groups: DateGroup[] | null}}
 */
export function groupMedia(items, mode, descending) {
  if (mode === 'none') return {items, groups: null};
  /** @type {Map<string, T[]>} */
  const buckets = new Map();
  for (const item of items) {
    const key = groupKey(item.captured ? item.sortTime : 0, mode);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(item);
    else buckets.set(key, [item]);
  }
  const keys = [...buckets.keys()].filter(Boolean).sort();
  if (descending) keys.reverse();
  if (buckets.has('')) keys.push('');
  const ordered = keys.flatMap(key => /** @type {T[]} */ (buckets.get(key)));
  return {items: ordered, groups: groupRuns(ordered, mode)};
}
