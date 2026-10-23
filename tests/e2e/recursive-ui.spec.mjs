import {test, expect} from '@playwright/test';
import {clickHeaderControl, directory, enterSelectionMode, listing, mockListings, scrollTop, stubMedia} from './helpers.mjs';

const BASE_TIME = 1_760_000_000;
const RAW = '<b>Raw</b>';

const file = (path, hour, kind = 'image') => ({name: path.split('/').pop(), path, kind, size: 1000 + hour, modTime: '2026-01-15T12:00:00Z', sortTime: BASE_TIME + hour * 3600});

// Trip holds duplicate names in different subfolders, a video, and enough photos to scroll.
const TRIP_FILES = [
  file('Trip/cover.jpg', 1),
  file('Trip/IMG_0003.jpg', 2),
  file('Trip/Day 1/IMG_0001.jpg', 3),
  file('Trip/Day 1/IMG_0002.jpg', 4),
  file('Trip/Day 1/clip.mp4', 5, 'video'),
  file('Trip/Day 2/IMG_0001.jpg', 6),
  file(`Trip/Day 2/${RAW}/IMG_0003.jpg`, 7),
  ...Array.from({length: 60}, (_, index) => file(`Trip/Day 3/Photo ${String(index + 1).padStart(3, '0')}.jpg`, 10 + index)),
];
const LISTINGS = {
  '': [directory('Trip'), directory('Empty'), directory('Broken')],
  Trip: [directory('Trip/Day 1'), directory('Trip/Day 2'), directory('Trip/Day 3'), TRIP_FILES[0], TRIP_FILES[1]],
  'Trip?recursive': TRIP_FILES,
  Empty: [directory('Empty/Sub')],
  'Empty?recursive': [],
  Broken: [file('Broken/one.jpg', 1)],
  Huge: [file('Huge/one.jpg', 1)],
};

/**
 * Synthetic library. Every listing request, folder counts and the collage source panel included, is
 * recorded as `path` or `path?recursive`; requests matching `hold` wait until released.
 */
async function mockLibrary(page) {
  const library = await mockListings(page, (key, path) => (key === 'Broken?recursive' ? {status: 500, body: 'boom'} : key === 'Huge?recursive' ? {status: 413, body: 'too many'} : listing(path, LISTINGS[key] ?? [])));
  await stubMedia(page);
  return library;
}

const toggle = page => page.locator('#recursiveToggle');
const tiles = page => page.locator('#mediaGrid .media-card');
const tile = (page, path) => page.locator(`#mediaGrid .media-card[data-path="${path}"]`);
const tilePaths = page => tiles(page).evaluateAll(cards => cards.map(card => card.getAttribute('data-path')));
const collator = new Intl.Collator('ru', {numeric: true, sensitivity: 'base'});

async function openTrip(page) {
  await page.goto('/');
  await page.getByRole('button', {name: 'Открыть папку Trip'}).click();
  await expect(page.locator('#folders .folder-card')).toHaveCount(3);
  await expect(toggle(page)).toBeVisible();
}

async function switchRecursive(page, on) {
  await toggle(page).focus();
  await toggle(page).press('Enter');
  await expect(toggle(page)).toHaveAttribute('aria-pressed', String(on));
  await expect(tiles(page)).toHaveCount(on ? TRIP_FILES.length : 2);
  await expect(page.locator('#refresh')).not.toHaveAttribute('aria-busy', 'true');
}

test('the toggle is absent at the root, also when the address asks for it', {tag: '@essential'}, async ({page}) => {
  const library = await mockLibrary(page);
  await page.goto('/?recursive=1');
  await expect(page.locator('#folders .folder-card')).toHaveCount(3);
  await expect(toggle(page)).toBeHidden();
  await page.getByRole('button', {name: 'Открыть папку Trip'}).click();
  await expect(toggle(page)).toBeVisible();
  await switchRecursive(page, true);
  await page.getByRole('button', {name: 'Все фото'}).click();
  await expect(page.locator('#folders .folder-card')).toHaveCount(3);
  await expect(toggle(page)).toBeHidden();
  await expect(page).toHaveURL(/\/$/);
  expect(library.requests.filter(key => key.endsWith('?recursive'))).toEqual(['Trip?recursive']);
});

test('the toggle asks the real server for the recursive listing of the opened folder', {tag: '@essential'}, async ({page}) => {
  const lists = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/list') lists.push(new URL(request.url()).search);
  });
  await page.goto('/?path=Album%20A');
  await expect(page.locator('#mediaGrid .media-card.image')).toHaveCount(13);
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(toggle(page)).toHaveAccessibleName('Из подпапок');

  await toggle(page).focus();
  await toggle(page).press('Enter');
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(toggle(page)).toBeFocused();
  await expect(page).toHaveURL(/\?path=Album%20A&recursive=1$/);
  await expect(page.locator('#mediaGrid .media-card.image')).toHaveCount(13);
  expect(lists.at(-1)).toBe('?path=Album%20A&recursive=1');

  // The keyboard switches it back without losing focus.
  await page.keyboard.press('Space');
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(toggle(page)).toBeFocused();
  await expect(page).toHaveURL(/\?path=Album%20A$/);
  await expect.poll(() => lists.at(-1)).toBe('?path=Album%20A');
  await expect(page.locator('#mediaGrid .media-card.image')).toHaveCount(13);
});

test('a quick on and off shows the latest mode, not the slower answer', async ({page}) => {
  const library = await mockLibrary(page);
  await openTrip(page);
  library.hold = key => key === 'Trip?recursive';
  await toggle(page).click();
  await expect.poll(() => library.held.length).toBe(1);
  library.hold = () => false;
  await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#folders .folder-card')).toHaveCount(3);
  await expect(tiles(page)).toHaveCount(2);

  await library.held[0].release();
  await page.waitForTimeout(200);
  await expect(page.locator('#folders .folder-card')).toHaveCount(3);
  await expect(tiles(page)).toHaveCount(2);
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(page).toHaveURL(/\?path=Trip$/);
  await expect(page.locator('#refresh')).not.toHaveAttribute('aria-busy', 'true');
});

test('filter, sort, direction, and density survive switching the mode', async ({page}) => {
  await mockLibrary(page);
  await openTrip(page);
  await page.locator('#mediaFilter [data-filter="image"]').click();
  await page.locator('#mediaSort').selectOption('name');
  await page.locator('#mediaDirection').click();
  await clickHeaderControl(page, '#gridDensity [data-density-step="0"]');
  const controls = () => page.evaluate(() => ({
    filter: document.querySelector('#mediaFilter [aria-pressed="true"]')?.getAttribute('data-filter'),
    sort: /** @type {HTMLSelectElement} */ (document.querySelector('#mediaSort')).value,
    direction: document.querySelector('#mediaDirection')?.getAttribute('aria-label'),
    density: document.querySelector('#gridDensity [aria-pressed="true"]')?.getAttribute('data-density-step'),
    columns: document.body.dataset.gridColumns,
    stored: Object.fromEntries(Object.entries(localStorage).filter(([key]) => key.startsWith('gallery-'))),
  }));
  const before = await controls();
  expect(before.filter).toBe('image');
  expect(before.sort).toBe('name');

  await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
  const images = TRIP_FILES.filter(item => item.kind === 'image');
  await expect(tiles(page)).toHaveCount(images.length);
  expect(await controls()).toEqual(before);
  // One click turned the default Z–A into A–Z; equal names keep the backend order.
  const expected = [...images].sort((left, right) => collator.compare(left.name, right.name)).map(item => item.path);
  expect(await tilePaths(page)).toEqual(expected);

  await toggle(page).click();
  await expect(tiles(page)).toHaveCount(2);
  expect(await controls()).toEqual(before);
});

test('refresh and reload keep the recursive mode, scroll, and focus', async ({page}) => {
  const library = await mockLibrary(page);
  await openTrip(page);
  await switchRecursive(page, true);
  const target = tile(page, 'Trip/Day 3/Photo 030.jpg');
  await target.evaluate(element => scrollTo({top: element.getBoundingClientRect().top + scrollY - innerHeight / 2, behavior: 'instant'}));
  await target.focus();
  const before = await scrollTop(page);
  expect(before).toBeGreaterThan(200);

  const tripRequests = () => library.requests.filter(key => key.startsWith('Trip'));
  library.requests.length = 0;
  await clickHeaderControl(page, '#refresh');
  await expect.poll(tripRequests).toEqual(['Trip?recursive']);
  await expect(page.locator('#refresh')).not.toHaveAttribute('aria-busy', 'true');
  await expect(tiles(page)).toHaveCount(TRIP_FILES.length);
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
  expect(Math.abs(await scrollTop(page) - before)).toBeLessThanOrEqual(2);

  library.requests.length = 0;
  await page.reload();
  await expect(tiles(page)).toHaveCount(TRIP_FILES.length);
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
  expect(tripRequests()).toEqual(['Trip?recursive']);
  await expect(target).toBeFocused();
  expect(Math.abs(await scrollTop(page) - before)).toBeLessThanOrEqual(2);
});

test('the viewer walks the visible recursive order and returns to the same mode', {tag: '@essential'}, async ({page}) => {
  const library = await mockLibrary(page);
  await openTrip(page);
  await page.locator('#mediaSort').selectOption('name');
  await switchRecursive(page, true);
  const order = (await tilePaths(page)).slice(0, 8);
  const shown = async () => new URL(await page.locator('#viewer a.download').getAttribute('href'), 'http://x').searchParams.get('path');

  await tile(page, order[0]).click();
  await expect(page.locator('#viewer')).toBeVisible();
  for (const [index, path] of order.entries()) {
    expect(await shown()).toBe(path);
    if (index < order.length - 1) await page.locator('#viewer .next').click();
  }
  await page.locator('#viewer .prev').click();
  expect(await shown()).toBe(order.at(-2));

  const requests = library.requests.length;
  await page.keyboard.press('Escape');
  await expect(page.locator('#viewer')).toBeHidden();
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(tile(page, order[0])).toBeFocused();
  await expect(page).toHaveURL(/\?path=Trip&recursive=1$/);
  expect(library.requests.length).toBe(requests);
});

test('duplicate names show their subfolder and open their own files', {tag: '@essential'}, async ({page}) => {
  await mockLibrary(page);
  await openTrip(page);
  await switchRecursive(page, true);
  const folder = path => tile(page, path).locator('.media-folder');
  await expect(folder('Trip/Day 1/IMG_0001.jpg')).toHaveText('Day 1');
  await expect(folder('Trip/Day 2/IMG_0001.jpg')).toHaveText('Day 2');
  await expect(folder('Trip/IMG_0003.jpg')).toHaveText('Эта папка');
  // A folder name is text, never markup.
  await expect(folder(`Trip/Day 2/${RAW}/IMG_0003.jpg`)).toHaveText(`Day 2/${RAW}`);
  await expect(page.locator('#mediaGrid .media-folder b')).toHaveCount(0);
  // Unique names keep the ordinary caption; the full relative path stays in title and name.
  await expect(folder('Trip/Day 1/IMG_0002.jpg')).toHaveCount(0);
  await expect(page.locator('#mediaGrid .media-folder')).toHaveCount(4);
  await expect(tile(page, 'Trip/Day 1/IMG_0002.jpg')).toHaveAttribute('title', 'Day 1/IMG_0002.jpg');
  await expect(tile(page, 'Trip/Day 2/IMG_0001.jpg')).toHaveAccessibleName('Открыть Day 2/IMG_0001.jpg');
  await expect(tile(page, 'Trip/Day 2/IMG_0001.jpg')).toHaveAccessibleDescription(/Day 2/);

  for (const path of ['Trip/Day 1/IMG_0001.jpg', 'Trip/Day 2/IMG_0001.jpg']) {
    await tile(page, path).click();
    await expect(page.locator('#viewer')).toBeVisible();
    await expect(page.locator('#viewer a.download')).toHaveAttribute('href', new RegExp(`path=${encodeURIComponent(path)}&`));
    await page.keyboard.press('Escape');
    await expect(page.locator('#viewer')).toBeHidden();
  }
});

test('collage selection keeps same-named photos from different subfolders apart', async ({page}) => {
  await mockLibrary(page);
  await openTrip(page);
  await switchRecursive(page, true);
  await expect(page.locator('#collageMode')).toBeVisible();
  await enterSelectionMode(page);
  const first = tile(page, 'Trip/Day 1/IMG_0001.jpg');
  const second = tile(page, 'Trip/Day 2/IMG_0001.jpg');
  await first.click();
  await second.click();
  await expect(page.locator('#collageSelectionCount')).toHaveText('2');
  await expect(first).toHaveAttribute('aria-pressed', 'true');
  await expect(second).toHaveAttribute('aria-pressed', 'true');

  await second.click();
  await expect(page.locator('#collageSelectionCount')).toHaveText('1');
  await expect(first).toHaveAttribute('aria-pressed', 'true');
  await expect(second).toHaveAttribute('aria-pressed', 'false');
  await second.click();

  await page.evaluate(() => addEventListener('litegallery:open-collage', event => {
    /** @type {any} */ (window).collagePhotos = /** @type {CustomEvent} */ (event).detail.photos.map(photo => photo.path);
  }, {once: true}));
  await page.getByRole('button', {name: 'Сделать коллаж'}).click();
  expect(await page.evaluate(() => /** @type {any} */ (window).collagePhotos)).toEqual(['Trip/Day 1/IMG_0001.jpg', 'Trip/Day 2/IMG_0001.jpg']);
});

test('Back and Forward restore each entry\'s mode; a folder reopens in its last mode', {tag: '@essential'}, async ({page}) => {
  const library = await mockLibrary(page);
  await openTrip(page);
  await switchRecursive(page, true);
  await page.getByRole('button', {name: 'Все фото'}).click();
  await expect(toggle(page)).toBeHidden();
  await page.getByRole('button', {name: 'Открыть папку Empty'}).click();
  await expect(page.locator('#folders .folder-card')).toHaveCount(1);
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');

  await page.goBack();
  await expect(page.locator('#folders .folder-card')).toHaveCount(3);
  await expect(toggle(page)).toBeHidden();
  await page.goBack();
  await expect(page).toHaveURL(/\?path=Trip&recursive=1$/);
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(tiles(page)).toHaveCount(TRIP_FILES.length);
  await page.goForward();
  await expect(toggle(page)).toBeHidden();
  await page.goForward();
  await expect(page).toHaveURL(/\?path=Empty$/);
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#folders .folder-card')).toHaveCount(1);

  await page.getByRole('button', {name: 'Все фото'}).click();
  await page.getByRole('button', {name: 'Открыть папку Trip'}).click();
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(tiles(page)).toHaveCount(TRIP_FILES.length);
  expect(library.requests.filter(key => key === '?recursive')).toEqual([]);
});

test('an empty subtree and a failed recursive listing leave the page usable', {tag: '@essential'}, async ({page}) => {
  await mockLibrary(page);
  await page.goto('/?path=Empty');
  await expect(page.locator('#folders .folder-card')).toHaveCount(1);
  await toggle(page).focus();
  await toggle(page).press('Enter');
  await expect(page.locator('#emptyState')).toBeVisible();
  await expect(page.locator('#emptyState')).toContainText('В этой папке и её подпапках нет фотографий и видео');
  await expect(page.locator('#foldersSection')).toBeHidden();
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#refresh')).not.toHaveAttribute('aria-busy', 'true');

  await page.goto('/?path=Broken');
  await expect(tiles(page)).toHaveCount(1);
  await toggle(page).focus();
  await toggle(page).press('Enter');
  await expect(page.locator('#status')).toHaveText('Каталог недоступен');
  await expect(page.locator('#refresh')).not.toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('#mediaSection')).toBeHidden();
  const header = await page.locator('#topbarMore').isVisible() ? ['#topbarMore'] : ['#refresh', '#gridDensity'];
  for (const control of ['#recursiveToggle', '#collageMode', '#breadcrumbs', ...header]) await expect(page.locator(control)).toBeVisible();
  await expect(toggle(page)).toBeFocused();
  await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(tiles(page)).toHaveCount(1);
  await expect(page.locator('#status')).toHaveText('1 элемент');
});

test('a subtree above the server limit says so instead of a generic error', async ({page}) => {
  await mockLibrary(page);
  await page.goto('/?path=Huge');
  await expect(tiles(page)).toHaveCount(1);
  await toggle(page).click();
  await expect(page.locator('#status')).toHaveText('Слишком много файлов, чтобы показать их вместе с подпапками');
  await expect(page.locator('#mediaSection')).toBeHidden();
  await toggle(page).click();
  await expect(tiles(page)).toHaveCount(1);
});
