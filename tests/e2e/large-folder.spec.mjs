import {test, expect} from '@playwright/test';
import {enterSelectionMode} from './helpers.mjs';
import {WINDOW_MIN_ITEMS} from '../../web/media-window.js';

const ONE_PIXEL_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const FOLDER = 'Large';
const TOTAL = 5000;
const VIDEO_EVERY = 10;
const BASE_TIME = 1_700_000_000;
// The gallery runs at most this many thumbnail loads at once (app.js THUMBNAIL_REQUESTS).
const THUMBNAIL_REQUESTS = 6;

// Every tenth entry is a video; dates repeat in pairs so name order breaks ties.
const entry = index => {
  const number = String(index + 1).padStart(5, '0');
  const video = index % VIDEO_EVERY === VIDEO_EVERY - 1;
  const name = `IMG_${number}.${video ? 'mp4' : 'jpg'}`;
  return {name, path: `${FOLDER}/${name}`, kind: video ? 'video' : 'image', size: 1000 + index, modTime: '2026-01-15T12:00:00Z', sortTime: BASE_TIME + Math.floor(index / 2) * 60};
};
const ENTRIES = Array.from({length: TOTAL}, (_, index) => entry(index));
// ENTRIES ascend by date and then by name, so every order the gallery offers is
// ENTRIES or its reverse. The default is newest first.
const NEWEST_FIRST = ENTRIES.map(item => item.path).reverse();
const NAME_ASCENDING = ENTRIES.map(item => item.path);

/**
 * Synthetic library with one large folder. Thumbnails and media answer after
 * `delay` ms so concurrent work is observable; `stats` counts it per route.
 */
async function mockLargeLibrary(page, {delay = 0, broken = () => false} = {}) {
  const stats = {thumbs: 0, thumbsInFlight: 0, thumbsPeak: 0, media: 0, mediaInFlight: 0, mediaPeak: 0};
  await page.route(url => url.pathname === '/api/list', route => {
    const path = new URL(route.request().url()).searchParams.get('path') ?? '';
    const entries = path === FOLDER ? ENTRIES : path ? [] : [{name: FOLDER, path: FOLDER, kind: 'directory', modTime: '2026-01-15T12:00:00Z'}];
    return route.fulfill({json: {path: path || '.', title: 'E2E Gallery', entries}});
  });
  const track = kind => async route => {
    stats[kind]++;
    stats[`${kind}InFlight`]++;
    stats[`${kind}Peak`] = Math.max(stats[`${kind}Peak`], stats[`${kind}InFlight`]);
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    stats[`${kind}InFlight`]--;
    if (broken(new URL(route.request().url()).searchParams.get('path'))) return route.fulfill({status: 404, body: ''}).catch(() => {});
    return route.fulfill({contentType: 'image/png', body: ONE_PIXEL_PNG}).catch(() => {});
  };
  await page.route(url => url.pathname === '/api/thumb' || url.pathname === '/api/video-poster', track('thumbs'));
  await page.route(url => url.pathname === '/api/media', track('media'));
  await page.route(url => url.pathname === '/api/cover', route => route.fulfill({contentType: 'image/png', body: ONE_PIXEL_PNG}));
  // The browser's view, reported with a lag: requests it cancelled fail
  // (Chromium and Firefox report them; WebKit does not).
  Object.assign(stats, {pageInFlight: 0, pagePeak: 0, cancelled: 0});
  const isThumb = request => /\/api\/(thumb|video-poster)\?/.test(request.url());
  page.on('request', request => {
    if (!isThumb(request)) return;
    stats.pageInFlight++;
    stats.pagePeak = Math.max(stats.pagePeak, stats.pageInFlight);
  });
  page.on('requestfinished', request => { if (isThumb(request)) stats.pageInFlight--; });
  page.on('requestfailed', request => {
    if (!isThumb(request)) return;
    stats.pageInFlight--;
    stats.cancelled++;
  });
  return stats;
}

/** Collect page errors and unhandled rejections; each test asserts they stay empty. */
async function watchErrors(page) {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.text().startsWith('unhandledrejection')) errors.push(message.text());
  });
  await page.addInitScript(() => {
    addEventListener('unhandledrejection', event => console.error(`unhandledrejection: ${event.reason}`));
  });
  return errors;
}

const cards = page => page.locator('#mediaGrid .media-card');
const tile = (page, path) => page.locator(`#mediaGrid .media-card[data-path="${path}"]`);
const scrollTop = page => page.evaluate(() => Math.round(scrollY));
const nameOf = path => path.split('/').pop();
const gridColumns = page => page.evaluate(() => getComputedStyle(document.querySelector('#mediaGrid')).gridTemplateColumns.split(' ').length);

/**
 * Columns and row pitch of the rendered media grid. A row is as tall as its
 * widest square tile; tracks are exact where card rects far down are not.
 * Runs in the page.
 */
function gridLayout() {
  const grid = /** @type {HTMLElement} */ (document.querySelector('#mediaGrid'));
  const style = getComputedStyle(grid);
  const tracks = style.gridTemplateColumns.split(' ').map(parseFloat);
  const rowHeight = Math.max(...tracks);
  return {grid, columns: tracks.length, rowHeight, rowGap: parseFloat(style.rowGap), pitch: rowHeight + parseFloat(style.rowGap)};
}

async function openLarge(page) {
  await page.goto(`/?path=${FOLDER}`);
  await expect(cards(page).first()).toBeVisible();
}

/**
 * The cards that flow in the grid are one contiguous, row-aligned run of
 * `expected`, and the first of them sits at its own row.
 */
async function expectWindowOf(page, expected) {
  const paths = await cards(page).evaluateAll(elements => elements
    .filter(element => !element.classList.contains('is-window-pinned'))
    .map(element => element.getAttribute('data-path')));
  expect(paths.length).toBeGreaterThan(0);
  expect(paths.length).toBeLessThanOrEqual(WINDOW_MIN_ITEMS);
  const start = expected.indexOf(paths[0]);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(paths).toEqual(expected.slice(start, start + paths.length));
  const layout = await page.evaluate(([source, path]) => {
    const {grid, columns, pitch} = new Function(`return (${source})()`)();
    const first = grid.querySelector(`.media-card[data-path="${CSS.escape(path)}"]`);
    return {columns, pitch, offset: first.getBoundingClientRect().top - grid.getBoundingClientRect().top};
  }, [gridLayout.toString(), paths[0]]);
  expect(start % layout.columns).toBe(0);
  expect(Math.abs(layout.offset - (start / layout.columns) * layout.pitch)).toBeLessThan(2);
  return {start, count: paths.length, columns: layout.columns};
}

/** Scroll to `top` and wait for the frame that handles the scroll event. */
const scrollToTop = (page, top) => page.evaluate(async top => {
  scrollTo({top, behavior: 'instant'});
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}, top);

/** Scroll so that the row of `index` is in the middle of the viewport. */
async function scrollToIndex(page, index) {
  const top = await page.evaluate(([source, index]) => {
    const {grid, columns, pitch} = new Function(`return (${source})()`)();
    return grid.getBoundingClientRect().top + scrollY + Math.floor(index / columns) * pitch - innerHeight / 2;
  }, [gridLayout.toString(), index]);
  await scrollToTop(page, top);
  return scrollTop(page);
}

test('a 5 000-item folder keeps a bounded window and reaches the first, middle, and last tiles', {tag: '@essential'}, async ({page}) => {
  const errors = await watchErrors(page);
  await mockLargeLibrary(page);
  await openLarge(page);
  expect(await cards(page).count()).toBeLessThanOrEqual(WINDOW_MIN_ITEMS);
  await expect(cards(page).first()).toHaveAttribute('data-path', NEWEST_FIRST[0]);
  await expect(cards(page).first()).toHaveAttribute('aria-label', `Открыть ${nameOf(NEWEST_FIRST[0])}`);
  await expectWindowOf(page, NEWEST_FIRST);

  // The grid is as tall as all 5 000 tiles would be.
  const height = await page.evaluate(([source, total]) => {
    const {grid, columns, rowHeight, rowGap} = new Function(`return (${source})()`)();
    const rows = Math.ceil(total / columns);
    return {actual: grid.getBoundingClientRect().height, expected: rows * rowHeight + (rows - 1) * rowGap};
  }, [gridLayout.toString(), TOTAL]);
  expect(Math.abs(height.actual - height.expected)).toBeLessThan(2);

  await scrollToIndex(page, 2500);
  await expect(tile(page, NEWEST_FIRST[2500])).toBeInViewport();
  await expectWindowOf(page, NEWEST_FIRST);

  await scrollToTop(page, await page.evaluate(() => document.scrollingElement.scrollHeight));
  await expect(tile(page, NEWEST_FIRST.at(-1))).toBeInViewport();
  await expectWindowOf(page, NEWEST_FIRST);

  await scrollToTop(page, 0);
  await expect(tile(page, NEWEST_FIRST[0])).toBeInViewport();
  expect(await cards(page).count()).toBeLessThanOrEqual(WINDOW_MIN_ITEMS);
  expect(errors).toEqual([]);
});

test('fast scrolling keeps thumbnail and video work bounded', async ({page}) => {
  const errors = await watchErrors(page);
  const stats = await mockLargeLibrary(page, {delay: 40});
  await page.addInitScript(() => {
    const metrics = {longTasks: [], firstTiles: 0, listed: 0, imageLoads: 0, imagePeak: 0};
    Object.assign(window, {__metrics: metrics});
    // Thumbnail loads the page has started and neither finished nor cancelled.
    const pending = new WeakSet();
    let inFlight = 0;
    const release = image => {
      if (pending.delete(image)) inFlight--;
    };
    const src = /** @type {PropertyDescriptor} */ (Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src'));
    Object.defineProperty(HTMLImageElement.prototype, 'src', {
      ...src,
      set(value) {
        release(this);
        if (/\/api\/(thumb|video-poster)\?/.test(value)) {
          pending.add(this);
          metrics.imageLoads++;
          metrics.imagePeak = Math.max(metrics.imagePeak, ++inFlight);
        }
        src.set.call(this, value);
      },
    });
    // Capture on the document runs before the queue's own listeners on the image;
    // load events of elements do not reach window.
    for (const type of ['load', 'error']) {
      document.addEventListener(type, event => {
        if (event.target instanceof HTMLImageElement) release(event.target);
      }, true);
    }
    const removeAttribute = Element.prototype.removeAttribute;
    Element.prototype.removeAttribute = function (name) {
      if (this instanceof HTMLImageElement && name === 'src') release(this);
      return removeAttribute.call(this, name);
    };
    new PerformanceObserver(list => {
      for (const item of list.getEntries()) metrics.longTasks.push(item.duration);
    }).observe({type: 'longtask', buffered: true});
    const fetchOriginal = window.fetch;
    window.fetch = async (...args) => {
      const response = await fetchOriginal(...args);
      if (String(args[0]).includes('/api/list?path=Large')) metrics.listed = performance.now();
      return response;
    };
    // The module script may render before DOMContentLoaded, so watch from the start.
    const observer = new MutationObserver(() => {
      if (!document.querySelector('#mediaGrid .media-card')) return;
      observer.disconnect();
      requestAnimationFrame(() => setTimeout(() => { metrics.firstTiles = performance.now(); }));
    });
    observer.observe(document, {childList: true, subtree: true});
  });
  await openLarge(page);
  await expect.poll(() => page.evaluate(() => window.__metrics.firstTiles)).toBeGreaterThan(0);
  const load = await page.evaluate(() => ({
    renderMs: Math.round(window.__metrics.firstTiles - window.__metrics.listed),
    longTaskMs: Math.round(window.__metrics.longTasks.reduce((sum, duration) => sum + duration, 0)),
  }));
  const tilesAfterLoad = await cards(page).count();

  // 40 jumps to the bottom, one frame each.
  const scroll = await page.evaluate(async () => {
    const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
    const before = window.__metrics.longTasks.length;
    const start = performance.now();
    const gaps = [];
    let last = start;
    let maxTiles = 0;
    const height = document.documentElement.scrollHeight - innerHeight;
    for (let step = 1; step <= 40; step++) {
      scrollTo({top: height * step / 40, behavior: 'instant'});
      await frame();
      const now = performance.now();
      gaps.push(now - last);
      last = now;
      maxTiles = Math.max(maxTiles, document.querySelectorAll('#mediaGrid .media-card').length);
    }
    return {
      totalMs: Math.round(performance.now() - start),
      maxFrameMs: Math.round(Math.max(...gaps)),
      longTaskMs: Math.round(window.__metrics.longTasks.slice(before).reduce((sum, duration) => sum + duration, 0)),
      maxTiles,
    };
  });
  const tilesAfterScroll = await cards(page).count();
  const images = await page.evaluate(() => ({loads: window.__metrics.imageLoads, peak: window.__metrics.imagePeak}));
  // The visible tiles at the bottom finish loading once the queue drains.
  await expect(page.locator('#mediaGrid .media-card.is-loading').filter({visible: true})).toHaveCount(0, {timeout: 15_000});
  await expect.poll(() => stats.thumbsInFlight + stats.mediaInFlight).toBe(0);
  if (process.env.LITEGALLERY_METRICS === '1') console.log(JSON.stringify({tilesAfterLoad, tilesAfterScroll, load, scroll, images, stats}));

  expect(scroll.maxTiles).toBeLessThanOrEqual(WINDOW_MIN_ITEMS);
  expect(images.peak).toBeLessThanOrEqual(THUMBNAIL_REQUESTS);
  // One duration read and one poster render at most.
  expect(stats.mediaPeak).toBeLessThanOrEqual(2);
  // Only tiles that stayed near the viewport are fetched, not the whole folder.
  expect(stats.thumbs).toBeLessThan(TOTAL / 5);
  await expectWindowOf(page, NEWEST_FIRST);
  expect(errors).toEqual([]);
});

test('sort, filter, and density work on the whole folder and keep the position', async ({page}, testInfo) => {
  const errors = await watchErrors(page);
  await mockLargeLibrary(page);
  await openLarge(page);
  await scrollToIndex(page, 1500);

  // Name order, then A–Z: the window shows the new order at the same offset.
  await page.locator('#mediaSort').selectOption('name');
  await expectWindowOf(page, [...NAME_ASCENDING].reverse());
  await page.locator('#mediaDirection').click();
  await expectWindowOf(page, NAME_ASCENDING);

  // Only videos: 500 entries, still windowed, last one reachable.
  await page.locator('#mediaFilter [data-filter="video"]').click();
  const videos = NAME_ASCENDING.filter(path => path.endsWith('.mp4'));
  await scrollToTop(page, 0);
  await expect(cards(page).first()).toHaveAttribute('data-path', videos[0]);
  await expectWindowOf(page, videos);
  await scrollToTop(page, await page.evaluate(() => document.scrollingElement.scrollHeight));
  await expect(tile(page, videos.at(-1))).toBeInViewport();
  await expectWindowOf(page, videos);

  // Density keeps the top tile where it was.
  await page.locator('#mediaFilter [data-filter="all"]').click();
  await scrollToIndex(page, 3000);
  const top = await page.evaluate(() => {
    const header = document.querySelector('.topbar').getBoundingClientRect().bottom;
    const first = [...document.querySelectorAll('#mediaGrid .media-card')].find(card => card.getBoundingClientRect().bottom > header);
    return {path: first.getAttribute('data-path'), y: first.getBoundingClientRect().top};
  });
  const columns = testInfo.project.use.viewport.width <= 700 ? 3 : 7;
  await page.locator(`#gridDensity [data-columns="${columns}"]`).click();
  await expect(page.locator(`#gridDensity [data-columns="${columns}"]`)).toHaveAttribute('aria-pressed', 'true');
  const after = await tile(page, top.path).boundingBox();
  expect(Math.abs(after.y - top.y)).toBeLessThan(2);
  expect(await scrollTop(page)).toBeGreaterThan(1000);
  expect((await expectWindowOf(page, NAME_ASCENDING)).columns).toBe(columns);
  expect(errors).toEqual([]);
});

test('back, forward, and reload restore a deep position and the focused tile', {tag: '@essential'}, async ({page}) => {
  const errors = await watchErrors(page);
  await mockLargeLibrary(page);
  await page.goto('/');
  await page.getByRole('button', {name: `Открыть папку ${FOLDER}`}).click();
  await expect(cards(page).first()).toBeVisible();
  const scroll = await scrollToIndex(page, 2500);
  const focused = tile(page, NEWEST_FIRST[2500]);
  await focused.focus();
  expect(await scrollTop(page)).toBe(scroll);

  await page.goBack();
  await expect(page.getByRole('button', {name: `Открыть папку ${FOLDER}`})).toBeFocused();
  await page.goForward();
  await expect.poll(() => scrollTop(page)).toBe(scroll);
  await expect(focused).toBeFocused();
  await expect(focused).toBeInViewport();
  await expectWindowOf(page, NEWEST_FIRST);

  await page.reload();
  await expect.poll(() => scrollTop(page)).toBe(scroll);
  await expect(focused).toBeFocused();
  await expectWindowOf(page, NEWEST_FIRST);
  expect(await cards(page).count()).toBeLessThanOrEqual(WINDOW_MIN_ITEMS);
  expect(errors).toEqual([]);
});

test('the viewer and collage selection get the right items after scrolling', async ({page}) => {
  const errors = await watchErrors(page);
  await mockLargeLibrary(page);
  // Record the collage hand-off instead of opening the editor.
  await page.addInitScript(() => {
    addEventListener('litegallery:open-collage', event => {
      event.stopImmediatePropagation();
      Object.assign(window, {__collage: event.detail.photos.map(photo => photo.path)});
    });
  });
  await openLarge(page);
  await scrollToIndex(page, 2500);
  const opened = tile(page, NEWEST_FIRST[2500]);
  await opened.click();
  const viewer = page.locator('#viewer');
  await expect(viewer.locator('.caption')).toContainText(`${nameOf(NEWEST_FIRST[2500])} · 2501/${TOTAL}`);
  await viewer.getByRole('button', {name: 'Следующее'}).click();
  await expect(viewer.locator('.caption')).toContainText(`${nameOf(NEWEST_FIRST[2501])} · 2502/${TOTAL}`);
  // Scrolling away behind the viewer drops the tile from the window; closing brings it back.
  await scrollToTop(page, 0);
  await page.keyboard.press('Escape');
  await expect(viewer).toBeHidden();
  await expect(opened).toBeFocused();
  await expect(opened).toBeInViewport();

  await enterSelectionMode(page);
  const first = NEWEST_FIRST.find((path, index) => index > 2600 && path.endsWith('.jpg'));
  const second = NEWEST_FIRST.find((path, index) => index > 4500 && path.endsWith('.jpg'));
  await scrollToIndex(page, NEWEST_FIRST.indexOf(first));
  await page.getByRole('button', {name: `Выбрать ${nameOf(first)} для коллажа`}).click();
  await scrollToIndex(page, NEWEST_FIRST.indexOf(second));
  await page.getByRole('button', {name: `Выбрать ${nameOf(second)} для коллажа`}).click();
  await expect(page.locator('#collageSelectionCount')).toHaveText('2');
  // A tile created again after scrolling back still shows its selection.
  await scrollToTop(page, 0);
  await scrollToIndex(page, NEWEST_FIRST.indexOf(first));
  await expect(tile(page, first)).toHaveClass(/is-collage-selected/);
  await expect(tile(page, first)).toHaveAttribute('aria-pressed', 'true');
  const video = NEWEST_FIRST.find((path, index) => index > 2600 && path.endsWith('.mp4'));
  await expect(tile(page, video)).not.toHaveAttribute('aria-pressed');
  await page.getByRole('button', {name: 'Сделать коллаж'}).click();
  await expect.poll(() => page.evaluate(() => window.__collage)).toEqual([first, second]);
  expect(errors).toEqual([]);
});

test('arrow keys cross the window and the focused tile survives scrolling away', async ({page}) => {
  const errors = await watchErrors(page);
  await mockLargeLibrary(page);
  await openLarge(page);
  await cards(page).first().focus();
  const columns = await gridColumns(page);
  const steps = 40;
  for (let step = 0; step < steps; step++) await page.keyboard.press('ArrowDown');
  const target = tile(page, NEWEST_FIRST[steps * columns]);
  await expect(target).toBeFocused();
  await expect(target).toBeInViewport();
  expect(await cards(page).count()).toBeLessThanOrEqual(WINDOW_MIN_ITEMS);
  await page.keyboard.press('ArrowRight');
  const right = tile(page, NEWEST_FIRST[steps * columns + 1]);
  await expect(right).toBeFocused();

  // A real keyboard scroll keeps the focused tile parked in the DOM.
  await page.keyboard.press('End');
  await expect(tile(page, NEWEST_FIRST.at(-1))).toBeInViewport();
  await expect(right).toBeFocused();
  await expect(right).toHaveClass(/is-window-pinned/);
  await page.keyboard.press('ArrowUp');
  const up = tile(page, NEWEST_FIRST[(steps - 1) * columns + 1]);
  await expect(up).toBeFocused();
  await expect(up).toBeInViewport();
  await expect(up).not.toHaveClass(/is-window-pinned/);
  await expectWindowOf(page, NEWEST_FIRST);
  expect(errors).toEqual([]);
});

test('a broken thumbnail deep in the folder keeps its fallback and label', async ({page}) => {
  const errors = await watchErrors(page);
  const broken = NEWEST_FIRST.find((path, index) => index > 3000 && path.endsWith('.jpg'));
  await mockLargeLibrary(page, {broken: path => path === broken});
  await openLarge(page);
  await scrollToIndex(page, NEWEST_FIRST.indexOf(broken));
  const card = tile(page, broken);
  await expect(card).toHaveClass(/is-broken/);
  await expect(card.locator('.thumb-fallback')).toContainText('Нет превью');
  await expect(card).toHaveAttribute('aria-label', `Открыть ${nameOf(broken)}`);
  await expect(card.locator('.media-details')).not.toBeEmpty();
  const next = tile(page, NEWEST_FIRST[NEWEST_FIRST.indexOf(broken) + 1]);
  await expect(next).not.toHaveClass(/is-loading|is-broken/);
  expect(errors).toEqual([]);
});
