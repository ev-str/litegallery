import {test, expect} from '@playwright/test';
import {WINDOW_MIN_ITEMS} from '../../web/media-window.js';

const ONE_PIXEL_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const BASE_TIME = 1_760_000_000;

const directory = path => ({name: path.split('/').pop(), path, kind: 'directory', modTime: '2026-01-15T12:00:00Z'});
const file = (path, hour, kind = 'image') => ({name: path.split('/').pop(), path, kind, size: 1000 + hour, modTime: '2026-01-15T12:00:00Z', sortTime: BASE_TIME + hour * 3600});

// "Paris" and "Rome" appear only in subfolder names; "sea" in names at every level.
const TRIP_FILES = [
  file('Trip/Sea Day.JPG', 1),
  file('Trip/notes.jpg', 2),
  file('Trip/Paris/louvre.png', 3),
  file('Trip/Paris/Sea shore.jpg', 4),
  file('Trip/Paris/Night/eiffel.mp4', 5, 'video'),
  file('Trip/Rome/sea clip.mp4', 6, 'video'),
  file('Trip/sea film.mp4', 7, 'video'),
  ...Array.from({length: 60}, (_, index) => file(`Trip/Day 3/Photo ${String(index + 1).padStart(3, '0')}.jpg`, 10 + index)),
];
const LARGE_TOTAL = 5000;
const LARGE_FILES = Array.from({length: LARGE_TOTAL}, (_, index) => file(`Large/IMG_${String(index + 1).padStart(5, '0')}.jpg`, index));
const LISTINGS = {
  '': [directory('Trip'), directory('Large')],
  Trip: [directory('Trip/Paris'), directory('Trip/Rome'), directory('Trip/Day 3'), ...TRIP_FILES.filter(item => item.path.split('/').length === 2)],
  'Trip?recursive': TRIP_FILES,
  Large: LARGE_FILES,
};

/** Synthetic library; every listing request is recorded as `path` or `path?recursive`. */
async function mockLibrary(page) {
  const requests = [];
  await page.route(url => url.pathname === '/api/list', route => {
    const params = new URL(route.request().url()).searchParams;
    const path = params.get('path') ?? '';
    const key = params.has('recursive') ? `${path}?recursive` : path;
    requests.push(key);
    return route.fulfill({json: {path: path || '.', title: 'E2E Gallery', entries: LISTINGS[key] ?? []}}).catch(() => {});
  });
  await page.route(url => ['/api/thumb', '/api/video-poster', '/api/cover', '/api/media', '/api/image-info'].includes(url.pathname), route => {
    if (new URL(route.request().url()).pathname === '/api/image-info') return route.fulfill({json: {width: 640, height: 900}});
    return route.fulfill({contentType: 'image/png', body: ONE_PIXEL_PNG});
  });
  return requests;
}

const field = page => page.getByRole('searchbox', {name: 'Найти'});
const results = page => page.locator('#searchGrid .media-card');
const resultPaths = page => results(page).evaluateAll(cards => cards.map(card => card.getAttribute('data-path')));
const galleryPaths = page => page.locator('#mediaGrid .media-card').evaluateAll(cards => cards.map(card => card.getAttribute('data-path')));
const count = page => page.locator('#searchCount');
const viewer = page => page.locator('#viewer');
const caption = page => viewer(page).locator('.caption');

// From the root, so Back has an in-app page to return to.
async function openTrip(page, {recursive = false} = {}) {
  await page.goto('/');
  await page.getByRole('button', {name: 'Открыть папку Trip'}).click();
  await expect(page.locator('#mediaGrid .media-card')).toHaveCount(3);
  if (recursive) {
    await page.locator('#recursiveToggle').click();
    await expect(page.locator('#mediaGrid .media-card')).toHaveCount(TRIP_FILES.length);
  }
  await expect(page.locator('#refresh')).not.toHaveAttribute('aria-busy', 'true');
}

async function openSearch(page) {
  await page.locator('#searchMode').click();
  await expect(page.locator('#searchSurface')).toBeVisible();
  await expect(field(page)).toBeFocused();
}

const snapshot = page => page.evaluate(() => ({
  url: location.pathname + location.search,
  recursive: document.querySelector('#recursiveToggle')?.getAttribute('aria-pressed'),
  filter: document.querySelector('#mediaFilter [aria-pressed="true"]')?.getAttribute('data-filter'),
  sort: /** @type {HTMLSelectElement} */ (document.querySelector('#mediaSort')).value,
  direction: document.querySelector('#mediaDirection')?.getAttribute('aria-label'),
  columns: document.body.dataset.gridColumns,
  scroll: Math.round(scrollY),
  focus: document.activeElement?.getAttribute('data-path'),
}));

test.describe('Найти', () => {
  test('searches file names of the shown listing, ignoring case and spaces, without a request', {tag: '@essential'}, async ({page}) => {
    const requests = await mockLibrary(page);
    await openTrip(page);
    const gallery = await galleryPaths(page);
    requests.length = 0;
    await openSearch(page);

    await expect(page.locator('#searchMode')).toHaveAttribute('aria-current', 'page');
    await expect(field(page)).toHaveAttribute('placeholder', 'Найти');
    await expect(count(page)).toHaveText('3 файла');
    await expect(page.locator('#searchScope')).toHaveText('По именам файлов в папке «Trip»');
    expect(await resultPaths(page)).toEqual(gallery);

    await field(page).fill('  SEA ');
    await expect(count(page)).toHaveText('Найдено: 2 файла');
    // Newest first, as in the gallery.
    expect(await resultPaths(page)).toEqual(['Trip/sea film.mp4', 'Trip/Sea Day.JPG']);

    // Subfolder names are not searched in a plain listing.
    await field(page).fill('paris');
    await expect(page.locator('#searchEmpty')).toBeVisible();
    await expect(page.locator('#searchEmpty strong')).toHaveText('Ничего не найдено');
    await expect(page.locator('#searchEmpty')).toContainText('Включите «Из подпапок»');
    await expect(results(page)).toHaveCount(0);
    await expect(count(page)).toHaveText('Найдено: 0 файлов');

    await page.getByRole('button', {name: 'Очистить запрос'}).click();
    await expect(field(page)).toHaveValue('');
    await expect(field(page)).toBeFocused();
    await expect(page.locator('#searchEmpty')).toBeHidden();
    await expect(page.getByRole('button', {name: 'Очистить запрос'})).toBeHidden();
    expect(await resultPaths(page)).toEqual(gallery);
    expect(requests).toEqual([]);
  });

  test('keyboard: arrows move through the results and the viewer returns focus to the opened one', {tag: '@essential'}, async ({page}) => {
    await mockLibrary(page);
    await openTrip(page);
    await openSearch(page);
    await page.keyboard.type('sea');
    await expect(results(page)).toHaveCount(2);
    await results(page).first().focus();
    await page.keyboard.press('ArrowRight');
    await expect(results(page).nth(1)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(viewer(page)).toBeVisible();
    await expect(caption(page)).toHaveText('Sea Day.JPG · 2/2');
    await page.keyboard.press('Escape');
    await expect(viewer(page)).toBeHidden();
    await expect(results(page).nth(1)).toBeFocused();
    await expect(page.locator('#searchSurface')).toBeVisible();
  });

  test('recursive search matches relative paths, keeps filter and sort, and hands the viewer exactly the results', {tag: '@essential'}, async ({page}) => {
    const requests = await mockLibrary(page);
    await openTrip(page, {recursive: true});
    await page.locator('#mediaFilter [data-filter="image"]').click();
    await page.locator('#mediaSort').selectOption('name');
    await page.locator('#mediaDirection').click();
    requests.length = 0;
    await openSearch(page);
    await expect(page.locator('#searchScope')).toHaveText('По именам и путям в папке «Trip» и её подпапках · только фото');

    await field(page).fill('Sea');
    // Name order, A to Z, photos only; every recursive result names its subfolder.
    expect(await resultPaths(page)).toEqual(['Trip/Sea Day.JPG', 'Trip/Paris/Sea shore.jpg']);
    await expect(results(page).locator('.media-folder')).toHaveText(['Эта папка', 'Paris']);
    await expect(page.getByRole('button', {name: 'Открыть Paris/Sea shore.jpg'})).toBeVisible();

    // A subfolder name finds its files; the opened folder's own name does not.
    await field(page).fill('PARIS/');
    expect(await resultPaths(page)).toEqual(['Trip/Paris/louvre.png', 'Trip/Paris/Sea shore.jpg']);
    await field(page).fill('trip');
    await expect(results(page)).toHaveCount(0);
    await expect(page.locator('#searchEmpty')).toContainText('Фильтр «Фото» тоже действует');
    await field(page).fill('paris');

    await results(page).nth(1).click();
    await expect(caption(page)).toHaveText('Sea shore.jpg · 2/2');
    await page.keyboard.press('ArrowRight');
    await expect(caption(page)).toHaveText('louvre.png · 1/2');
    await page.keyboard.press('Escape');
    await expect(viewer(page)).toBeHidden();
    await expect(results(page).nth(1)).toBeFocused();

    // Header TV plays the results from the first one.
    await expect(page.locator('#tvMode')).toBeEnabled();
    await page.locator('#tvMode').click();
    await expect(caption(page)).toHaveText('louvre.png · 1/2');
    await page.evaluate(() => document.exitFullscreen());
    await expect(viewer(page)).not.toHaveAttribute('data-tv');
    await page.keyboard.press('Escape');
    await expect(viewer(page)).toBeHidden();
    expect(requests).toEqual([]);
  });

  test('TV follows the list of the current section: gallery media there, results in Найти', {tag: '@essential'}, async ({page}) => {
    await mockLibrary(page);
    await openTrip(page);
    const tv = page.locator('#tvMode');
    const playFromTV = async expected => {
      await tv.click();
      await expect(viewer(page)).toBeVisible();
      await expect(caption(page)).toHaveText(expected);
      await page.evaluate(() => document.exitFullscreen());
      await expect(viewer(page)).not.toHaveAttribute('data-tv');
      await page.keyboard.press('Escape');
      await expect(viewer(page)).toBeHidden();
    };

    await openSearch(page);
    await field(page).fill('zzz');
    await expect(results(page)).toHaveCount(0);
    await expect(tv).toBeDisabled();

    // A saved empty search does not reach the gallery: filter and refresh keep TV on the media.
    await page.locator('#galleryMode').click();
    await expect(tv).toBeEnabled();
    await page.locator('#mediaFilter [data-filter="image"]').click();
    await expect(page.locator('#mediaGrid .media-card')).toHaveCount(2);
    await expect(tv).toBeEnabled();
    await page.locator('#refresh').click();
    await expect(page.locator('#refresh')).not.toHaveAttribute('aria-busy', 'true');
    await expect(page.locator('#mediaGrid .media-card')).toHaveCount(2);
    await expect(tv).toBeEnabled();
    await playFromTV('notes.jpg · 1/2');

    // The unchanged empty search is not rebuilt on entry, yet TV follows it.
    await openSearch(page);
    await expect(field(page)).toHaveValue('zzz');
    await expect(tv).toBeDisabled();
    await page.getByRole('button', {name: 'Очистить запрос'}).click();
    await expect(results(page)).toHaveCount(2);
    await expect(tv).toBeEnabled();
    await playFromTV('notes.jpg · 1/2');
    await expect(page.locator('#searchSurface')).toBeVisible();
    await field(page).fill('sea');
    await playFromTV('Sea Day.JPG · 1/1');
  });

  test('returning to Галерея and Back/Forward keep the gallery state and the query', {tag: '@essential'}, async ({page}) => {
    const requests = await mockLibrary(page);
    await openTrip(page, {recursive: true});
    await page.locator('#mediaFilter [data-filter="image"]').click();
    await page.locator('#mediaSort').selectOption('name');
    await page.locator('#gridDensity [data-density-step="0"]').click();
    const target = page.locator('#mediaGrid .media-card[data-path="Trip/Day 3/Photo 030.jpg"]');
    await target.evaluate(element => scrollTo({top: element.getBoundingClientRect().top + scrollY - innerHeight / 2, behavior: 'instant'}));
    await target.focus();
    const before = await snapshot(page);
    expect(before.scroll).toBeGreaterThan(200);
    requests.length = 0;

    await openSearch(page);
    await field(page).fill('photo 01');
    await expect(results(page)).toHaveCount(10);
    await page.locator('#galleryMode').click();
    await expect(page.locator('#gallerySurface')).toBeVisible();
    const after = await snapshot(page);
    expect({...after, scroll: 0}).toEqual({...before, scroll: 0});
    expect(Math.abs(after.scroll - before.scroll)).toBeLessThanOrEqual(2);
    expect(requests).toEqual([]);

    // Back leaves the folder from Найти as from the gallery; Forward brings it back as it was.
    await openSearch(page);
    await page.goBack();
    await expect(page.locator('body')).toHaveAttribute('data-surface', 'gallery');
    await expect(page.getByRole('button', {name: 'Открыть папку Trip'})).toBeVisible();
    await page.goForward();
    await expect(page.locator('#mediaGrid .media-card')).toHaveCount(TRIP_FILES.length - 3);
    const forward = await snapshot(page);
    expect({...forward, scroll: 0}).toEqual({...before, scroll: 0});
    await openSearch(page);
    await expect(field(page)).toHaveValue('photo 01');
    await expect(results(page)).toHaveCount(10);
  });

  test('a large listing keeps a bounded number of result tiles', {tag: '@essential'}, async ({page}) => {
    await mockLibrary(page);
    await page.goto('/?path=Large');
    await expect(page.locator('#mediaGrid .media-card').first()).toBeVisible();
    await openSearch(page);
    await expect(count(page)).toHaveText(`${LARGE_TOTAL} файлов`);
    expect(await results(page).count()).toBeLessThanOrEqual(WINDOW_MIN_ITEMS);

    await field(page).fill('img_01');
    await expect(count(page)).toHaveText('Найдено: 1000 файлов');
    expect(await results(page).count()).toBeLessThanOrEqual(WINDOW_MIN_ITEMS);
    await expect(results(page).first()).toHaveAttribute('data-path', 'Large/IMG_01999.jpg');
    await page.evaluate(() => scrollTo({top: document.documentElement.scrollHeight, behavior: 'instant'}));
    await expect(page.locator('#searchGrid .media-card[data-path="Large/IMG_01000.jpg"]')).toBeInViewport();
    expect(await results(page).count()).toBeLessThanOrEqual(WINDOW_MIN_ITEMS);
  });

  test('touch opens the section and a result', async ({page}, testInfo) => {
    test.skip(!testInfo.project.use.hasTouch, 'Touch viewports only');
    await mockLibrary(page);
    await openTrip(page);
    await page.locator('#searchMode').tap();
    await field(page).fill('sea');
    await results(page).first().tap();
    await expect(caption(page)).toHaveText('sea film.mp4 · 1/2');
  });
});
