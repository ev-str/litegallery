import {test, expect} from '@playwright/test';
import {enterSelectionMode} from './helpers.mjs';
import {VIEWS_KEY} from '../../web/gallery-state.js';
import {LIVE_REFRESH_MS} from '../../web/live-refresh.js';

const ONE_PIXEL_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const BASE_TIME = 1_760_000_000;
const PHOTOS = 60;

const directory = path => ({name: path.split('/').pop(), path, kind: 'directory', modTime: '2026-01-15T12:00:00Z'});
const photo = (path, hour) => ({name: path.split('/').pop(), path, kind: 'image', size: 1000 + hour, modTime: '2026-01-15T12:00:00Z', sortTime: BASE_TIME + hour * 3600});
const livePhoto = index => photo(`Live/Photo ${String(index).padStart(3, '0')}.png`, index);

/**
 * Synthetic library whose listings the test edits between checks. Every listing request is
 * recorded as `path` or `path?recursive`; requests matching `hold` wait until released, and
 * requests matching `fail` answer 500.
 */
async function mockLibrary(page) {
  const listings = {
    '': [directory('Live'), directory('Other')],
    Live: [directory('Live/Sub'), ...Array.from({length: PHOTOS}, (_, index) => livePhoto(index + 1))],
    'Live?recursive': [...Array.from({length: PHOTOS}, (_, index) => livePhoto(index + 1)), photo('Live/Sub/Deep.png', 100)],
    'Live/Sub': [photo('Live/Sub/Deep.png', 100)],
    Other: [photo('Other/One.png', 1), photo('Other/Two.png', 2)],
  };
  /** @type {{key: string, release: () => Promise<void>}[]} */
  const held = [];
  const library = {
    listings,
    held,
    requests: /** @type {string[]} */ ([]),
    hold: (/** @type {string} */ key) => false,
    fail: (/** @type {string} */ key) => false,
  };
  await page.route(url => url.pathname === '/api/list', route => {
    const params = new URL(route.request().url()).searchParams;
    const path = params.get('path') ?? '';
    const key = params.has('recursive') ? `${path}?recursive` : path;
    library.requests.push(key);
    const failing = library.fail(key);
    // The answer is read when it is sent, so a held request returns the listing of that moment.
    const fulfill = () => (failing
      ? route.fulfill({status: 500, body: 'unavailable'})
      : route.fulfill({json: {path: path || '.', title: 'E2E Gallery', entries: listings[key] ?? []}})).catch(() => {});
    if (library.hold(key)) {
      held.push({key, release: fulfill});
      return undefined;
    }
    return fulfill();
  });
  await page.route(url => ['/api/thumb', '/api/cover', '/api/media'].includes(url.pathname), route => route.fulfill({contentType: 'image/png', body: ONE_PIXEL_PNG}));
  return library;
}

const tiles = page => page.locator('#mediaGrid .media-card');
const tile = (page, path) => page.locator(`#mediaGrid .media-card[data-path="${path}"]`);
const scrollTop = page => page.evaluate(() => Math.round(scrollY));
const checksOf = (library, key) => library.requests.filter(request => request === key).length;

async function openLive(page, library) {
  await page.clock.install();
  await page.goto('/?path=Live');
  await expect(tiles(page)).toHaveCount(PHOTOS);
  await expect(page.locator('#refresh')).not.toHaveAttribute('aria-busy', 'true');
  expect(checksOf(library, 'Live')).toBe(1);
}

const pause = (page, ms = 200) => page.evaluate(delay => new Promise(resolve => setTimeout(resolve, delay)), ms);

/**
 * Let one interval pass and wait for exactly one background check of `key`; the pause lets
 * it finish, so the next interval is counted from here.
 */
async function nextCheck(page, library, key = 'Live') {
  const before = checksOf(library, key);
  await page.clock.runFor(LIVE_REFRESH_MS);
  await expect.poll(() => checksOf(library, key)).toBe(before + 1);
  await pause(page);
  expect(checksOf(library, key)).toBe(before + 1);
}

/** Path and screen top of the first tile below the sticky header. */
const topTile = page => page.evaluate(() => {
  const headerBottom = document.querySelector('.topbar').getBoundingClientRect().bottom;
  const card = [...document.querySelectorAll('#mediaGrid .media-card')]
    .filter(element => !element.classList.contains('is-window-pinned'))
    .find(element => element.getBoundingClientRect().bottom > headerBottom);
  return {path: card.getAttribute('data-path'), top: Math.round(card.getBoundingClientRect().top)};
});

/** Pretend the tab was hidden or shown; repeating a state repeats the event. */
const setHidden = (page, hidden) => page.evaluate(value => {
  Object.defineProperty(document, 'hidden', {configurable: true, get: () => value});
  Object.defineProperty(document, 'visibilityState', {configurable: true, get: () => (value ? 'hidden' : 'visible')});
  document.dispatchEvent(new Event('visibilitychange'));
}, hidden);

const controls = page => page.evaluate(() => ({
  filter: document.querySelector('#mediaFilter [aria-pressed="true"]')?.getAttribute('data-filter'),
  sort: /** @type {HTMLSelectElement} */ (document.querySelector('#mediaSort')).value,
  direction: document.querySelector('#mediaDirection')?.getAttribute('aria-label'),
  columns: document.body.dataset.gridColumns,
  stored: {...localStorage},
}));

test('a new file appears in place: scroll, focus, controls, address, and saved view stay', {tag: '@essential'}, async ({page}) => {
  const library = await mockLibrary(page);
  await openLive(page, library);
  // Photos only, oldest first, the densest grid: none of them is the default.
  await page.locator('#mediaFilter [data-filter="image"]').click();
  await page.locator('#mediaDirection').click();
  await page.locator('#gridDensity [data-density-step="2"]').click();
  await expect(tiles(page).first()).toHaveAttribute('data-path', 'Live/Photo 001.png');

  const focused = tile(page, 'Live/Photo 030.png');
  await focused.evaluate(card => {
    scrollTo({top: card.getBoundingClientRect().top + scrollY - innerHeight / 2, behavior: 'instant'});
    card.focus();
  });
  const scrolled = await scrollTop(page);
  expect(scrolled).toBeGreaterThan(200);
  const anchor = await topTile(page);
  const settings = await controls(page);
  const saved = await page.evaluate(key => sessionStorage.getItem(key), VIEWS_KEY);
  const historyLength = await page.evaluate(() => history.length);
  const url = page.url();

  // The new photo is the oldest, so it lands above everything on screen.
  library.listings.Live.push(photo('Live/Older.png', -5));
  await nextCheck(page, library);
  await expect(tiles(page)).toHaveCount(PHOTOS + 1);
  await expect(tiles(page).first()).toHaveAttribute('data-path', 'Live/Older.png');

  await expect(page.locator('.media-skeleton')).toHaveCount(0);
  await expect(focused).toBeFocused();
  const moved = await page.evaluate(path => Math.round(document.querySelector(`#mediaGrid .media-card[data-path="${CSS.escape(path)}"]`).getBoundingClientRect().top), anchor.path);
  expect(Math.abs(moved - anchor.top)).toBeLessThanOrEqual(1);
  expect(await scrollTop(page)).toBeGreaterThan(200);
  expect(await controls(page)).toEqual(settings);
  expect(page.url()).toBe(url);
  expect(await page.evaluate(() => history.length)).toBe(historyLength);
  expect(await page.evaluate(key => sessionStorage.getItem(key), VIEWS_KEY)).toBe(saved);
  await expect(page.locator('#status')).toHaveText('62 элемента');
});

test('a deleted file disappears and its focus passes to the tile that took its place', {tag: '@essential'}, async ({page}) => {
  const library = await mockLibrary(page);
  await openLive(page, library);
  const doomed = 'Live/Photo 050.png';
  // Newest first: Photo 050 is the eleventh tile, Photo 049 takes its place.
  await tile(page, doomed).focus();
  library.listings.Live = library.listings.Live.filter(entry => entry.path !== doomed);
  await nextCheck(page, library);
  await expect(tiles(page)).toHaveCount(PHOTOS - 1);
  await expect(tile(page, doomed)).toHaveCount(0);
  await expect(tile(page, 'Live/Photo 049.png')).toBeFocused();
});

test('the open viewer stays on its file, even one that was deleted, and focus returns safely', {tag: '@essential'}, async ({page}) => {
  const library = await mockLibrary(page);
  await openLive(page, library);
  const viewer = page.locator('#viewer');
  const caption = viewer.locator('.caption');

  await tile(page, 'Live/Photo 058.png').click();
  await expect(caption).toHaveText(`Photo 058.png · 3/${PHOTOS}`);
  library.listings.Live.push(photo('Live/Newest.png', 500));
  await nextCheck(page, library);
  await expect(tile(page, 'Live/Newest.png')).toHaveCount(1);
  await expect(viewer).toBeVisible();
  await expect(caption).toHaveText(`Photo 058.png · 3/${PHOTOS}`);
  await expect(viewer.locator('.stage img')).toHaveAttribute('alt', 'Photo 058.png');
  await page.keyboard.press('Escape');
  await expect(tile(page, 'Live/Photo 058.png')).toBeFocused();

  // The shown file goes away: the viewer keeps showing it, and closing falls back to the
  // tile now at its former place.
  await tile(page, 'Live/Photo 040.png').click();
  await expect(caption).toHaveText(`Photo 040.png · 22/${PHOTOS + 1}`);
  library.listings.Live = library.listings.Live.filter(entry => entry.path !== 'Live/Photo 040.png');
  await nextCheck(page, library);
  await expect(tile(page, 'Live/Photo 040.png')).toHaveCount(0);
  await expect(caption).toHaveText(`Photo 040.png · 22/${PHOTOS + 1}`);
  await page.keyboard.press('Escape');
  await expect(viewer).toBeHidden();
  await expect(tile(page, 'Live/Photo 039.png')).toBeFocused();
});

test('a background answer for a page left behind never touches the new page', {tag: '@essential'}, async ({page}) => {
  const library = await mockLibrary(page);
  await openLive(page, library);
  library.hold = key => key === 'Live';
  await page.clock.runFor(LIVE_REFRESH_MS);
  await expect.poll(() => library.held.length).toBe(1);

  library.hold = () => false;
  await page.locator('#breadcrumbs button', {hasText: 'Все фото'}).click();
  await expect(page.locator('#folders .folder-card')).toHaveCount(2);
  await expect(page).toHaveURL(/\/$/);
  const historyLength = await page.evaluate(() => history.length);

  library.listings.Live.push(photo('Live/Late.png', 900));
  await library.held[0].release();
  await pause(page);
  await expect(page.locator('#folders .folder-card')).toHaveCount(2);
  await expect(page.locator('#mediaSection')).toBeHidden();
  await expect(page.locator('#breadcrumbs button')).toHaveText(['Все фото']);
  await expect(page).toHaveURL(/\/$/);
  expect(await page.evaluate(() => history.length)).toBe(historyLength);

  // The next check is for the page now on screen.
  await nextCheck(page, library, '');
});

test('a failed background check keeps the grid and waits a full interval', {tag: '@essential'}, async ({page}) => {
  const library = await mockLibrary(page);
  await openLive(page, library);
  const first = await tiles(page).first().elementHandle();
  library.fail = key => key === 'Live';
  await nextCheck(page, library);
  await pause(page);
  await expect(tiles(page)).toHaveCount(PHOTOS);
  expect(await first.evaluate(card => card.isConnected)).toBe(true);
  await expect(page.locator('#mediaSection')).toBeVisible();
  await expect(page.locator('#status')).toHaveText('61 элемент');

  await page.clock.runFor(LIVE_REFRESH_MS - 1_000);
  expect(checksOf(library, 'Live')).toBe(2);
  library.fail = () => false;
  library.listings.Live.push(photo('Live/Back.png', 700));
  await page.clock.runFor(1_000);
  await expect(tile(page, 'Live/Back.png')).toHaveCount(1);
  expect(checksOf(library, 'Live')).toBe(3);
});

test('a hidden tab is never checked; showing it again checks once and the cadence resumes', {tag: '@essential'}, async ({page}) => {
  const library = await mockLibrary(page);
  await openLive(page, library);
  await setHidden(page, true);
  await page.clock.runFor(LIVE_REFRESH_MS * 3);
  await pause(page);
  expect(checksOf(library, 'Live')).toBe(1);

  await setHidden(page, false);
  await setHidden(page, false);
  await expect.poll(() => checksOf(library, 'Live')).toBe(2);
  await pause(page);
  await page.clock.runFor(LIVE_REFRESH_MS - 1_000);
  expect(checksOf(library, 'Live')).toBe(2);
  await page.clock.runFor(1_000);
  await expect.poll(() => checksOf(library, 'Live')).toBe(3);
});

test('a check running when the tab hides changes nothing; returning starts exactly one new check', {tag: '@essential'}, async ({page}) => {
  const library = await mockLibrary(page);
  await openLive(page, library);
  const first = await tiles(page).first().elementHandle();
  library.hold = key => key === 'Live';
  await page.clock.runFor(LIVE_REFRESH_MS);
  await expect.poll(() => library.held.length).toBe(1);

  // Hidden and back before the answer, with a repeated event: the old check is aborted, and
  // the one new check starts as soon as it has settled.
  await setHidden(page, true);
  await setHidden(page, false);
  await setHidden(page, false);
  await expect.poll(() => library.held.length).toBe(2);
  await pause(page);
  expect(library.held.length).toBe(2);
  expect(checksOf(library, 'Live')).toBe(3);

  // The old answer carries a change; it must not reach the page.
  library.listings.Live.push(photo('Live/Stale.png', 900));
  await library.held[0].release();
  await pause(page);
  await expect(tile(page, 'Live/Stale.png')).toHaveCount(0);
  expect(await first.evaluate(card => card.isConnected)).toBe(true);

  library.listings.Live = library.listings.Live.filter(entry => entry.path !== 'Live/Stale.png');
  library.listings.Live.push(photo('Live/Fresh.png', 950));
  library.hold = () => false;
  await library.held[1].release();
  await expect(tile(page, 'Live/Fresh.png')).toHaveCount(1);
  await pause(page);
  expect(checksOf(library, 'Live')).toBe(3);

  // Back to the plain cadence: nothing before a full interval, then one check. The clock is
  // frozen first: a runFor that races the clock's own natural flow can be lost. With page
  // timers frozen, waits below run on the test side.
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1_000));
  await page.clock.runFor(LIVE_REFRESH_MS - 2_000);
  await page.waitForTimeout(200);
  expect(checksOf(library, 'Live')).toBe(3);
  // A few virtual seconds of margin absorb a timer armed slightly late; a lost or re-armed
  // full interval still needs far more.
  await page.clock.runFor(5_000);
  await expect.poll(() => checksOf(library, 'Live')).toBe(4);
  await page.waitForTimeout(200);
  expect(checksOf(library, 'Live')).toBe(4);
});

test('an answer that arrives while the tab is hidden is dropped; showing the tab checks once', async ({page}) => {
  const library = await mockLibrary(page);
  await openLive(page, library);
  library.hold = key => key === 'Live';
  await page.clock.runFor(LIVE_REFRESH_MS);
  await expect.poll(() => library.held.length).toBe(1);
  await setHidden(page, true);
  library.listings.Live.push(photo('Live/Unseen.png', 900));
  await library.held[0].release();
  await pause(page);
  await expect(tile(page, 'Live/Unseen.png')).toHaveCount(0);
  await page.clock.runFor(LIVE_REFRESH_MS * 2);
  await pause(page);
  expect(checksOf(library, 'Live')).toBe(2);

  library.hold = () => false;
  await setHidden(page, false);
  await expect(tile(page, 'Live/Unseen.png')).toHaveCount(1);
  await pause(page);
  expect(checksOf(library, 'Live')).toBe(3);
});

test('at most one background check runs, and a manual refresh replaces it without a second cadence', {tag: '@essential'}, async ({page}) => {
  const library = await mockLibrary(page);
  await openLive(page, library);
  library.hold = key => key === 'Live';
  await page.clock.runFor(LIVE_REFRESH_MS);
  await expect.poll(() => library.held.length).toBe(1);
  await page.clock.runFor(LIVE_REFRESH_MS * 4);
  expect(library.held.length).toBe(1);

  // Manual refresh stays the explicit full load and aborts the background check.
  library.hold = () => false;
  await page.locator('#refresh').click();
  await expect(page.locator('#refresh')).not.toHaveAttribute('aria-busy', 'true');
  expect(checksOf(library, 'Live')).toBe(3);
  await library.held[0].release();

  await nextCheck(page, library);
  await nextCheck(page, library);
  expect(checksOf(library, 'Live')).toBe(5);
});

test('background checks keep the recursive mode of the page', {tag: '@essential'}, async ({page}) => {
  const library = await mockLibrary(page);
  await openLive(page, library);
  await page.locator('#recursiveToggle').click();
  await expect(tiles(page)).toHaveCount(PHOTOS + 1);
  await expect(page).toHaveURL(/recursive=1$/);
  await nextCheck(page, library, 'Live?recursive');
  expect(checksOf(library, 'Live')).toBe(1);

  library.listings['Live?recursive'].push(photo('Live/Sub/Deeper.png', 800));
  await nextCheck(page, library, 'Live?recursive');
  await expect(tile(page, 'Live/Sub/Deeper.png')).toHaveCount(1);
  await expect(page.locator('#recursiveToggle')).toHaveAttribute('aria-pressed', 'true');
});

test('an unchanged listing keeps every tile element, and collage selection pauses checks', {tag: '@essential'}, async ({page}) => {
  const library = await mockLibrary(page);
  await openLive(page, library);
  const first = await tiles(page).first().elementHandle();
  const folder = await page.locator('#folders .folder-card').first().elementHandle();
  await nextCheck(page, library);
  await pause(page);
  expect(await first.evaluate(card => card.isConnected)).toBe(true);
  expect(await folder.evaluate(card => card.isConnected)).toBe(true);

  await enterSelectionMode(page);
  await page.getByRole('button', {name: 'Выбрать Photo 060.png для коллажа'}).click();
  library.listings.Live.push(photo('Live/During.png', 600));
  await page.clock.runFor(LIVE_REFRESH_MS * 2);
  expect(checksOf(library, 'Live')).toBe(2);
  await expect(tile(page, 'Live/Photo 060.png')).toHaveAttribute('aria-pressed', 'true');

  await page.locator('#collageSelectionCancel').click();
  await nextCheck(page, library);
  await expect(tile(page, 'Live/During.png')).toHaveCount(1);
});
