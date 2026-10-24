import {test, expect} from '@playwright/test';
import {WINDOW_MIN_ITEMS} from '../../web/media-window.js';
import {SEARCH_DEBOUNCE_MS} from '../../web/search.js';
import {clickHeaderControl, directory, galleryView, listing, mockListings, mockSearch, stubMedia} from './helpers.mjs';

const BASE_TIME = 1_760_000_000;

const file = (path, hour, kind = 'image') => ({name: path.split('/').pop(), path, kind, size: 1000 + hour, modTime: '2026-01-15T12:00:00Z', sortTime: BASE_TIME + hour * 3600, captured: true});

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
// Deep below the root, and a second "Sea Day.JPG" that only its folder tells apart.
const ARCHIVE_FILES = [file('Archive/2019/Summer/Deep/Hidden Gem.jpg', 80), file('Archive/2019/Sea Day.JPG', 81)];
const LIBRARY = [...TRIP_FILES, ...ARCHIVE_FILES];
const SEARCH_LIMIT = 2000;
const LARGE_FILES = Array.from({length: 5000}, (_, index) => file(`Large/IMG_${String(index + 1).padStart(5, '0')}.jpg`, index));
const LISTINGS = {
  '': [directory('Archive'), directory('Trip'), directory('Large')],
  Trip: [directory('Trip/Paris'), directory('Trip/Rome'), directory('Trip/Day 3'), ...TRIP_FILES.filter(item => item.path.split('/').length === 2)],
  'Trip?recursive': TRIP_FILES,
  Large: LARGE_FILES,
};

/** Synthetic library; every listing request is recorded as `path` or `path?recursive`. */
async function mockLibrary(page, library = LIBRARY) {
  const {requests} = await mockListings(page, (key, path) => listing(path, LISTINGS[key] ?? []));
  const search = await mockSearch(page, library, {limit: SEARCH_LIMIT});
  await stubMedia(page);
  return {requests, search};
}

const field = page => page.getByRole('searchbox', {name: 'Найти'});
const results = page => page.locator('#searchGrid .media-card');
const resultPaths = page => results(page).evaluateAll(cards => cards.map(card => card.getAttribute('data-path')));
const count = page => page.locator('#searchCount');
const message = page => page.locator('#searchEmpty strong');
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

test.describe('Найти', () => {
  test('searches the whole gallery from the root; equal names differ by their folder; an empty query sends nothing', {tag: '@essential'}, async ({page}) => {
    const {requests, search} = await mockLibrary(page);
    await page.goto('/');
    await expect(page.getByRole('button', {name: 'Открыть папку Trip'})).toBeVisible();
    requests.length = 0;
    await openSearch(page);

    await expect(page.locator('#searchMode')).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('#searchScope')).toHaveText('По именам файлов и папок во всей галерее');
    await expect(message(page)).toHaveText('Что найти?');
    await expect(results(page)).toHaveCount(0);
    await field(page).fill('   ');
    await page.waitForTimeout(SEARCH_DEBOUNCE_MS * 3);
    expect(search.queries).toEqual([]);

    await field(page).fill('hidden GEM');
    await expect(results(page)).toHaveCount(1);
    expect(await resultPaths(page)).toEqual(['Archive/2019/Summer/Deep/Hidden Gem.jpg']);
    await expect(results(page).locator('.media-folder')).toHaveText(['Archive/2019/Summer/Deep']);
    await expect(count(page)).toHaveText('Найдено: 1 файл');

    // A part of the path finds the files below it.
    await field(page).fill('paris/');
    await expect(results(page)).toHaveCount(3);
    expect(await resultPaths(page).then(paths => paths.sort())).toEqual(['Trip/Paris/Night/eiffel.mp4', 'Trip/Paris/Sea shore.jpg', 'Trip/Paris/louvre.png']);

    await field(page).fill('sea day');
    await expect(results(page)).toHaveCount(2);
    // Newest first, as in the gallery.
    expect(await resultPaths(page)).toEqual(['Archive/2019/Sea Day.JPG', 'Trip/Sea Day.JPG']);
    await expect(results(page).locator('.media-folder')).toHaveText(['Archive/2019', 'Trip']);
    await expect(page.getByRole('button', {name: 'Открыть Trip/Sea Day.JPG'})).toBeVisible();
    await expect(page.getByRole('button', {name: 'Открыть Archive/2019/Sea Day.JPG'})).toBeVisible();

    await field(page).fill('zzz');
    await expect(message(page)).toHaveText('Ничего не найдено');
    await expect(results(page)).toHaveCount(0);

    await page.getByRole('button', {name: 'Очистить запрос'}).click();
    await expect(field(page)).toHaveValue('');
    await expect(field(page)).toBeFocused();
    await expect(message(page)).toHaveText('Что найти?');
    await expect(results(page)).toHaveCount(0);
    await page.waitForTimeout(SEARCH_DEBOUNCE_MS * 2);
    expect(search.queries).toEqual(['hidden gem', 'paris/', 'sea day', 'zzz']);
    expect(requests).toEqual([]);
  });

  test('a slow answer of an older query does not replace the newer results', {tag: '@essential'}, async ({page}) => {
    const {search} = await mockLibrary(page);
    await page.goto('/');
    await openSearch(page);
    search.hold = true;
    await field(page).fill('sea');
    await expect.poll(() => search.held.length).toBe(1);
    await expect(count(page)).toHaveText('Поиск…');
    await field(page).fill('louvre');
    await expect.poll(() => search.held.length).toBe(2);
    const [stale, latest] = search.held;
    expect([stale.query, latest.query]).toEqual(['sea', 'louvre']);

    await latest.release();
    await expect(results(page)).toHaveCount(1);
    await stale.release();
    await page.waitForTimeout(SEARCH_DEBOUNCE_MS);
    expect(await resultPaths(page)).toEqual(['Trip/Paris/louvre.png']);
    await expect(count(page)).toHaveText('Найдено: 1 файл');
  });

  test('a search index that is not ready yet, and a failed search that the next input retries', {tag: '@essential'}, async ({page}) => {
    const {search} = await mockLibrary(page);
    await page.goto('/');
    await openSearch(page);
    search.status = 503;
    await field(page).fill('sea');
    await expect(message(page)).toHaveText('Поиск пока готовится');
    await expect(results(page)).toHaveCount(0);
    await expect(page.locator('#tvMode')).toBeDisabled();

    // Coming back to the section asks again.
    search.status = 200;
    await page.locator('#galleryMode').click();
    await openSearch(page);
    await expect(results(page)).toHaveCount(5);
    await expect(page.locator('#searchEmpty')).toBeHidden();

    search.status = 500;
    await field(page).fill('louvre');
    await expect(message(page)).toHaveText('Не удалось выполнить поиск');
    await expect(results(page)).toHaveCount(0);
    search.status = 200;
    await field(page).press('End');
    await page.keyboard.type(' ');
    await expect(results(page)).toHaveCount(1);
    expect(search.queries).toEqual(['sea', 'sea', 'louvre', 'louvre']);
  });

  test('keyboard: arrows move through the results and the viewer returns focus to the opened one', {tag: '@essential'}, async ({page}) => {
    await mockLibrary(page);
    await openTrip(page);
    await openSearch(page);
    await page.keyboard.type('sea');
    await expect(results(page)).toHaveCount(5);
    await results(page).first().focus();
    await page.keyboard.press('ArrowRight');
    await expect(results(page).nth(1)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(viewer(page)).toBeVisible();
    await expect(caption(page)).toHaveText('sea film.mp4 · 2/5');
    await page.keyboard.press('Escape');
    await expect(viewer(page)).toBeHidden();
    await expect(results(page).nth(1)).toBeFocused();
    await expect(page.locator('#searchSurface')).toBeVisible();
  });

  test('filter, sort, and grouping apply to the results, and the viewer and TV get exactly them', {tag: '@essential'}, async ({page}) => {
    await mockLibrary(page);
    await openTrip(page);
    await page.locator('#mediaFilter [data-filter="image"]').click();
    await page.locator('#mediaSort').selectOption('name');
    await page.locator('#mediaDirection').click();
    await openSearch(page);
    await expect(page.locator('#searchScope')).toHaveText('По именам файлов и папок во всей галерее · только фото');

    await field(page).fill('paris');
    // Name order, A to Z, photos only.
    await expect(results(page)).toHaveCount(2);
    expect(await resultPaths(page)).toEqual(['Trip/Paris/louvre.png', 'Trip/Paris/Sea shore.jpg']);

    await results(page).nth(1).click();
    await expect(caption(page)).toHaveText('Sea shore.jpg · 2/2');
    await page.keyboard.press('ArrowRight');
    await expect(caption(page)).toHaveText('louvre.png · 1/2');
    await page.keyboard.press('Escape');
    await expect(viewer(page)).toBeHidden();
    await expect(results(page).nth(1)).toBeFocused();

    // Header TV plays the results from the first one.
    await expect(page.locator('#tvMode')).toBeEnabled();
    await clickHeaderControl(page, '#tvMode');
    await expect(caption(page)).toHaveText('louvre.png · 1/2');
    await page.evaluate(() => document.exitFullscreen());
    await expect(viewer(page)).not.toHaveAttribute('data-tv');
    await page.keyboard.press('Escape');
    await expect(viewer(page)).toBeHidden();

    // A change in the gallery applies to the saved results.
    await page.locator('#galleryMode').click();
    await page.locator('#mediaFilter [data-filter="all"]').click();
    await page.locator('#mediaGroup').selectOption('year');
    await openSearch(page);
    await expect(results(page)).toHaveCount(3);
    expect(await resultPaths(page)).toEqual(['Trip/Paris/Night/eiffel.mp4', 'Trip/Paris/louvre.png', 'Trip/Paris/Sea shore.jpg']);
    await expect(page.locator('#searchGrid .media-group-heading')).toHaveCount(1);
    await expect(page.locator('#searchGrid .media-group-heading')).toHaveText('2025');
  });

  test('TV follows the list of the current section: gallery media there, results in Найти', {tag: '@essential'}, async ({page}) => {
    await mockLibrary(page);
    await openTrip(page);
    const tv = page.locator('#tvMode');
    const playFromTV = async expected => {
      await clickHeaderControl(page, '#tvMode');
      await expect(viewer(page)).toBeVisible();
      await expect(caption(page)).toHaveText(expected);
      await page.evaluate(() => document.exitFullscreen());
      await expect(viewer(page)).not.toHaveAttribute('data-tv');
      await page.keyboard.press('Escape');
      await expect(viewer(page)).toBeHidden();
    };

    await openSearch(page);
    await expect(tv).toBeDisabled();
    await field(page).fill('zzz');
    await expect(message(page)).toHaveText('Ничего не найдено');
    await expect(tv).toBeDisabled();

    // An empty search does not reach the gallery: filter and refresh keep TV on the media.
    await page.locator('#galleryMode').click();
    await expect(tv).toBeEnabled();
    await page.locator('#mediaFilter [data-filter="image"]').click();
    await expect(page.locator('#mediaGrid .media-card')).toHaveCount(2);
    await expect(tv).toBeEnabled();
    await clickHeaderControl(page, '#refresh');
    await expect(page.locator('#refresh')).not.toHaveAttribute('aria-busy', 'true');
    await expect(page.locator('#mediaGrid .media-card')).toHaveCount(2);
    await expect(tv).toBeEnabled();
    await playFromTV('notes.jpg · 1/2');

    await openSearch(page);
    await expect(field(page)).toHaveValue('zzz');
    await expect(tv).toBeDisabled();
    await field(page).fill('sea');
    await expect(results(page)).toHaveCount(3);
    await expect(tv).toBeEnabled();
    await playFromTV('Sea Day.JPG · 1/3');
    await expect(page.locator('#searchSurface')).toBeVisible();
  });

  test('returning to Галерея and Back/Forward keep the gallery state and the query', {tag: '@essential'}, async ({page}) => {
    const {requests} = await mockLibrary(page);
    await openTrip(page, {recursive: true});
    await page.locator('#mediaFilter [data-filter="image"]').click();
    await page.locator('#mediaSort').selectOption('name');
    await clickHeaderControl(page, '#gridDensity [data-density-step="0"]');
    const target = page.locator('#mediaGrid .media-card[data-path="Trip/Day 3/Photo 030.jpg"]');
    await target.evaluate(element => scrollTo({top: element.getBoundingClientRect().top + scrollY - innerHeight / 2, behavior: 'instant'}));
    await target.focus();
    const before = await galleryView(page);
    expect(before.scroll).toBeGreaterThan(200);
    requests.length = 0;

    await openSearch(page);
    await field(page).fill('photo 01');
    await expect(results(page)).toHaveCount(10);
    await page.locator('#galleryMode').click();
    await expect(page.locator('#gallerySurface')).toBeVisible();
    const after = await galleryView(page);
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
    const forward = await galleryView(page);
    expect({...forward, scroll: 0}).toEqual({...before, scroll: 0});
    await openSearch(page);
    await expect(field(page)).toHaveValue('photo 01');
    await expect(results(page)).toHaveCount(10);
  });

  test('a truncated answer says so and keeps a bounded number of result tiles', {tag: '@essential'}, async ({page}) => {
    await mockLibrary(page, LARGE_FILES);
    await page.goto('/');
    await openSearch(page);
    await field(page).fill('img_');
    await expect(count(page)).toHaveText(`Найдено: ${SEARCH_LIMIT} файлов · показаны не все, уточните запрос`);
    expect(await results(page).count()).toBeLessThanOrEqual(WINDOW_MIN_ITEMS);
    await expect(results(page).first()).toHaveAttribute('data-path', `Large/IMG_0${SEARCH_LIMIT}.jpg`);
    await page.evaluate(() => scrollTo({top: document.documentElement.scrollHeight, behavior: 'instant'}));
    await expect(page.locator('#searchGrid .media-card[data-path="Large/IMG_00001.jpg"]')).toBeInViewport();
    expect(await results(page).count()).toBeLessThanOrEqual(WINDOW_MIN_ITEMS);
  });

  test('touch opens the section and a result', async ({page}, testInfo) => {
    test.skip(!testInfo.project.use.hasTouch, 'Touch viewports only');
    await mockLibrary(page);
    await openTrip(page);
    await page.locator('#searchMode').tap();
    await field(page).fill('hidden gem');
    await results(page).first().tap();
    await expect(caption(page)).toHaveText('Hidden Gem.jpg · 1/1');
  });
});
