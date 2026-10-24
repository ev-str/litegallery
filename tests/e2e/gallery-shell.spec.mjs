import {test, expect} from '@playwright/test';
import {formatBytes, formatFileDetails} from '../../web/format.js';
import {clickHeaderControl, directory, focusWithKeyboard, isDesktopBrowserProject, listing as listingAnswer, mockListings, ONE_PIXEL_PNG, openAlbum, stubMedia} from './helpers.mjs';

const DESKTOP_DENSITY = [3, 5, 7];
const PHONE_DENSITY = [1, 2, 3];
const PHONE_VIEWPORT = {width: 390, height: 844};

// Columns as actually laid out: distinct left edges of the rendered tiles.
const renderedColumns = (page, grid = '#mediaGrid') => page.locator(`${grid} > *`).evaluateAll(cards => new Set(cards.map(card => Math.round(card.getBoundingClientRect().left))).size);

async function listing(page, path) {
  const response = await page.request.get(`/api/list?path=${encodeURIComponent(path)}`);
  expect(response.ok()).toBe(true);
  return response.json();
}

async function expectDensity(page, choices, grid = '#mediaGrid') {
  const density = page.locator('#gridDensity');
  await expect(density.locator('button')).toHaveText(choices.map(String));
  for (const columns of choices) {
    await clickHeaderControl(page, `#gridDensity [data-columns="${columns}"]`);
    await expect(density.locator(`[data-columns="${columns}"]`)).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => renderedColumns(page, grid), `${columns} columns`).toBe(columns);
    const tracks = await page.locator(grid).evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length);
    expect(tracks, `${columns} grid tracks`).toBe(columns);
  }
}

test('fixed grid switches density, keeps it after reload, and per device class', {tag: '@essential'}, async ({page}, testInfo) => {
  test.skip(!isDesktopBrowserProject(testInfo), 'Desktop density contract; the phone class is emulated below.');
  await openAlbum(page);
  await expectDensity(page, DESKTOP_DENSITY);
  await clickHeaderControl(page, '#gridDensity [data-columns="3"]');
  await page.reload();
  await expect(page.locator('#mediaGrid .media-card.image')).toHaveCount(13);
  await expect(page.locator('#gridDensity [data-columns="3"]')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => renderedColumns(page)).toBe(3);

  await page.setViewportSize(PHONE_VIEWPORT);
  await expectDensity(page, PHONE_DENSITY);
  await clickHeaderControl(page, '#gridDensity [data-columns="1"]');
  await page.reload();
  await expect(page.locator('#gridDensity [data-columns="1"]')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => renderedColumns(page)).toBe(1);
  expect(await page.evaluate(() => [localStorage.getItem('gallery-density-desktop'), localStorage.getItem('gallery-density-phone')])).toEqual(['3', '1']);

  await page.setViewportSize({width: 1440, height: 1000});
  await expect(page.locator('#gridDensity [data-columns="3"]')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => renderedColumns(page)).toBe(3);
});

test('phone shows exactly one, two, or three columns', async ({page}, testInfo) => {
  test.skip(testInfo.project.use.viewport.width > 700, 'Phone viewport only');
  await openAlbum(page);
  await expectDensity(page, PHONE_DENSITY);
});

test('folder cards show direct child counts', {tag: '@essential'}, async ({page}) => {
  const root = await listing(page, '');
  await page.goto('/');
  for (const folder of root.entries.filter(entry => entry.kind === 'directory')) {
    const {entries} = await listing(page, folder.path);
    const images = entries.filter(entry => entry.kind === 'image').length;
    const card = page.getByRole('button', {name: `Открыть папку ${folder.name}`});
    // Counts load lazily; phones show folders in a horizontal rail.
    await card.scrollIntoViewIfNeeded();
    await expect(card.locator('.folder-meta')).toContainText(`${images} фото`);
    await expect(card).toHaveAccessibleDescription(new RegExp(`${images} фото`));
  }
});

test('tiles always show the date and reveal format and size on hover and keyboard focus', {tag: '@essential'}, async ({page}, testInfo) => {
  test.skip(!isDesktopBrowserProject(testInfo), 'Hover and keyboard focus are desktop interactions');
  const {entries} = await listing(page, 'Album A');
  await openAlbum(page);
  const first = page.locator('#mediaGrid .media-card').first();
  const path = await first.getAttribute('data-path');
  const entry = entries.find(candidate => candidate.path === path);
  expect(entry).toBeTruthy();

  await expect(first.locator('.media-meta')).toBeVisible();
  await expect(first.locator('.media-meta')).not.toBeEmpty();
  const details = first.locator('.media-details');
  await expect(details).toHaveText(formatFileDetails(entry));
  expect(formatFileDetails(entry)).toBe(`PNG · ${formatBytes(entry.size)}`);
  await page.mouse.move(2, 2);
  await expect(details).toHaveCSS('opacity', '0');

  await first.hover();
  await expect(details).toHaveCSS('opacity', '1');
  await page.mouse.move(2, 2);
  await expect(details).toHaveCSS('opacity', '0');

  await focusWithKeyboard(page, first);
  await expect(first).toBeFocused();
  await expect(details).toHaveCSS('opacity', '1');
  await expect(first).toHaveAccessibleDescription(new RegExp(formatFileDetails(entry).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('one broken thumbnail does not break the other tiles', {tag: '@essential'}, async ({page}) => {
  await page.route('**/api/thumb?**', route => {
    const path = new URL(route.request().url()).searchParams.get('path');
    return path === 'Album A/Photo 03.png' ? route.fulfill({status: 500, body: 'broken'}) : route.continue();
  });
  await openAlbum(page);
  const broken = page.locator('#mediaGrid .media-card.is-broken');
  await expect(broken).toHaveCount(1);
  await expect(broken).toHaveAttribute('data-path', 'Album A/Photo 03.png');
  await expect(broken.locator('.thumb-fallback')).toBeVisible();
  await expect(broken.locator('.media-meta')).toBeVisible();
  const healthy = page.locator('#mediaGrid .media-card[data-path="Album A/Photo 01.png"] img');
  await expect.poll(() => healthy.evaluate(image => /** @type {HTMLImageElement} */ (image).naturalWidth)).toBeGreaterThan(0);

  await broken.click();
  await expect(page.locator('#viewer .caption')).toContainText('Photo 03.png');
});

test('loading skeletons keep the final tile geometry', async ({page}, testInfo) => {
  test.skip(!isDesktopBrowserProject(testInfo), 'Layout timing contract');
  let release = () => {};
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/api/list?path=Album%20A', async route => {
    await gate;
    await route.continue();
  });
  await page.goto('/');
  await page.getByRole('button', {name: 'Открыть папку Album A'}).click();
  const skeletons = page.locator('#mediaGrid .media-skeleton');
  await expect(skeletons).toHaveCount(5 * 2);
  const skeletonBox = await skeletons.first().boundingBox();
  release();
  const tile = page.locator('#mediaGrid .media-card').first();
  await expect(page.locator('#mediaGrid .media-card')).toHaveCount(13);
  const tileBox = await tile.boundingBox();
  expect(Math.round(tileBox.width)).toBe(Math.round(skeletonBox.width));
  expect(Math.round(tileBox.height)).toBe(Math.round(skeletonBox.height));
});

test('an empty folder shows an explicit empty state', async ({page}) => {
  await page.route('**/api/list?path=Empty', route => route.fulfill({json: {path: 'Empty', title: 'E2E Gallery', entries: []}}));
  await page.goto('/?path=Empty');
  await expect(page.locator('#emptyState')).toBeVisible();
  await expect(page.locator('#mediaSection')).toBeHidden();
  await expect(page.locator('#foldersSection')).toBeHidden();
});

test('video tiles show a date until the duration is known, and file details', async ({page}) => {
  const sortTime = Date.UTC(2026, 0, 15, 12) / 1000;
  const video = {name: 'Clip.mp4', path: 'Videos/Clip.mp4', kind: 'video', size: 68_000_000, modTime: '2026-01-15T12:00:00Z', sortTime};
  await page.route('**/api/list?path=Videos', route => route.fulfill({json: {path: 'Videos', title: 'E2E Gallery', entries: [video]}}));
  await page.goto('/?path=Videos');
  const card = page.locator('#mediaGrid .media-card.video');
  await expect(card.locator('.media-meta')).toHaveText(new Intl.DateTimeFormat('ru', {day: 'numeric', month: 'short', year: 'numeric'}).format(new Date(sortTime * 1000)));
  await expect(card.locator('.media-details')).toHaveText(formatFileDetails(video));
  expect(formatFileDetails(video)).toMatch(/^Видео · /);
});

test('header keeps refresh, filters, sorting, and the EXIF panel shows format and size', {tag: '@essential'}, async ({page}, testInfo) => {
  test.skip(!isDesktopBrowserProject(testInfo), 'Desktop shell contract');
  const {entries} = await listing(page, 'Album A');
  await openAlbum(page);
  const header = page.locator('.topbar');
  await expect(header).toHaveCSS('position', 'sticky');
  const heights = await header.locator('#gridDensity, #collageMode, #refresh').evaluateAll(elements => elements.map(element => Math.round(element.getBoundingClientRect().height)));
  expect(new Set(heights).size).toBe(1);

  const listRequest = page.waitForRequest(request => request.url().includes('/api/list?path=Album%20A'));
  await clickHeaderControl(page, '#refresh');
  await listRequest;
  await expect(page.locator('#mediaGrid .media-card.image')).toHaveCount(13);
  await expect(page.locator('#refresh')).not.toHaveAttribute('aria-busy', 'true');

  await page.locator('#mediaFilter [data-filter="video"]').click();
  await expect(page.locator('#mediaGrid .media-empty')).toBeVisible();
  await page.locator('#mediaFilter [data-filter="all"]').click();
  await page.locator('#mediaSort').selectOption('name');
  await page.locator('#mediaDirection').click();
  const ascending = await page.locator('#mediaGrid .media-card').first().getAttribute('data-path');
  await page.locator('#mediaDirection').click();
  await expect(page.locator('#mediaGrid .media-card').first()).not.toHaveAttribute('data-path', ascending);

  const first = page.locator('#mediaGrid .media-card').first();
  const path = await first.getAttribute('data-path');
  const item = entries.find(candidate => candidate.path === path);
  await first.click();
  const viewer = page.locator('#viewer');
  await viewer.getByRole('button', {name: 'Информация о фотографии'}).click();
  const panel = viewer.locator('.exif-panel');
  await expect(panel.locator('.exif-row').filter({hasText: 'Формат'})).toContainText('PNG');
  await expect(panel.locator('.exif-row').filter({hasText: 'Файл'})).toContainText(formatBytes(item.size));
});

const isPhone = testInfo => testInfo.project.use.viewport.width <= 700;

/** Serve fixed listings for the given paths; other listings reach the server. */
async function routeListings(page, listings) {
  await page.route(url => url.pathname === '/api/list', route => {
    const path = new URL(route.request().url()).searchParams.get('path') ?? '';
    const entries = listings[path];
    return entries ? route.fulfill({json: {path, title: 'E2E Gallery', entries}}) : route.continue();
  });
}

const video = (path, sortTime) => ({name: path.split('/').pop(), path, kind: 'video', size: 5_000_000, modTime: '2026-01-15T12:00:00Z', sortTime});
const dateLabel = seconds => new Intl.DateTimeFormat('ru', {day: 'numeric', month: 'short', year: 'numeric'}).format(new Date(seconds * 1000));

test('folder cards follow the same fixed density on the root page', {tag: '@essential'}, async ({page}, testInfo) => {
  await routeListings(page, {'': Array.from({length: 8}, (_, index) => directory(`Folder ${index + 1}`))});
  await page.goto('/');
  await expect(page.locator('#folders .folder-card')).toHaveCount(8);
  await expectDensity(page, isPhone(testInfo) ? PHONE_DENSITY : DESKTOP_DENSITY, '#folders');
});

test('refresh during navigation repeats the requested path and the latest response wins', {tag: '@essential'}, async ({page}) => {
  await page.goto('/');
  const albumA = page.getByRole('button', {name: 'Открыть папку Album A'});
  await albumA.scrollIntoViewIfNeeded();
  await expect(albumA.locator('.folder-meta')).toContainText('фото');

  /** @type {import('@playwright/test').Route[]} */
  const held = [];
  await page.route(url => url.pathname === '/api/list', route => { held.push(route); });
  await albumA.click();
  await expect.poll(() => held.length).toBe(1);
  await clickHeaderControl(page, '#refresh');
  await expect.poll(() => held.length).toBe(2);
  const [stale, latest] = held;
  expect(held.map(route => new URL(route.request().url()).searchParams.get('path'))).toEqual(['Album A', 'Album A']);

  await latest.continue();
  const cards = page.locator('#mediaGrid .media-card.image');
  await expect(cards).toHaveCount(13);
  await expect(page.locator('#breadcrumbs button')).toHaveText(['Все фото', 'Album A']);
  await expect(page.locator('#refresh')).not.toHaveAttribute('aria-busy', 'true');
  await expect(page).toHaveURL(/\?path=Album%20A$/);
  const firstCard = await cards.first().elementHandle();
  const historyLength = await page.evaluate(() => history.length);

  await stale.continue().catch(() => {});
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 300)));

  expect(await firstCard.evaluate(card => card.isConnected)).toBe(true);
  await expect(cards).toHaveCount(13);
  await expect(page.locator('#breadcrumbs button')).toHaveText(['Все фото', 'Album A']);
  await expect(page.locator('#refresh')).not.toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('#refresh')).not.toHaveClass(/is-busy/);
  await expect(page).toHaveURL(/\?path=Album%20A$/);
  expect(await page.evaluate(() => history.length)).toBe(historyLength);
});

test('refresh after a failed navigation retries the failed path', async ({page}) => {
  await page.goto('/');
  const albumB = page.getByRole('button', {name: 'Открыть папку Album B'});
  await albumB.scrollIntoViewIfNeeded();
  await expect(albumB.locator('.folder-meta')).toContainText('фото');

  const requested = [];
  let failNext = true;
  await page.route(url => url.pathname === '/api/list', route => {
    requested.push(new URL(route.request().url()).searchParams.get('path'));
    if (!failNext) return route.continue();
    failNext = false;
    return route.fulfill({status: 500, body: 'unavailable'});
  });
  await albumB.click();
  await expect(page.locator('#status')).toHaveText('Каталог недоступен');
  await expect(page).not.toHaveURL(/path=/);

  await clickHeaderControl(page, '#refresh');
  await expect(page.locator('#mediaGrid .media-card.image')).toHaveCount(4);
  expect(requested).toEqual(['Album B', 'Album B']);
  await expect(page.locator('#breadcrumbs button')).toHaveText(['Все фото', 'Album B']);
  await expect(page).toHaveURL(/\?path=Album%20B$/);
});

test('video durations replace the date and stale renders cannot start or apply reads', async ({page}, testInfo) => {
  test.skip(!isDesktopBrowserProject(testInfo), 'Media-element mock runs once per desktop engine');
  // Controlled metadata: duration probes (preload="metadata") never touch the network.
  await page.addInitScript(() => {
    const requests = [];
    const source = /** @type {PropertyDescriptor} */ (Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src'));
    Object.defineProperty(HTMLMediaElement.prototype, 'src', {
      configurable: true,
      get() { return this.fakeSource ?? source.get?.call(this); },
      set(value) {
        if (this.preload !== 'metadata') return source.set?.call(this, value);
        this.fakeSource = value;
        requests.push({path: new URL(value, location.href).searchParams.get('path'), element: this});
      },
    });
    Object.defineProperty(HTMLMediaElement.prototype, 'duration', {configurable: true, get() { return this.fakeDuration ?? Number.NaN; }});
    Object.assign(window, {
      metadataPaths: () => requests.map(request => request.path),
      releaseMetadata: (path, seconds) => {
        const request = requests.find(candidate => candidate.path === path);
        request.element.fakeDuration = seconds;
        request.element.dispatchEvent(new Event('loadedmetadata'));
      },
    });
  });
  await page.route('**/api/video-poster?**', route => route.fulfill({contentType: 'image/png', body: ONE_PIXEL_PNG}));
  const older = Date.UTC(2026, 0, 10, 12) / 1000;
  const newer = Date.UTC(2026, 0, 20, 12) / 1000;
  await routeListings(page, {
    Library: [directory('Library/Next'), video('Library/One.mp4', newer), video('Library/Two.mp4', older)],
    'Library/Next': [video('Library/Next/Clip.mp4', older)],
  });

  await page.goto('/?path=Library');
  await expect(page.locator('#mediaGrid .media-card.video')).toHaveCount(2);
  await expect.poll(() => page.evaluate(() => window.metadataPaths())).toHaveLength(1);
  const [started] = await page.evaluate(() => window.metadataPaths());
  const staleCard = await page.locator(`#mediaGrid .media-card[data-path="${started}"]`).elementHandle();
  const staleDate = started === 'Library/One.mp4' ? dateLabel(newer) : dateLabel(older);
  expect(await staleCard.evaluate(card => card.querySelector('.media-meta')?.textContent)).toBe(staleDate);

  await page.getByRole('button', {name: 'Открыть папку Next'}).click();
  const clip = page.locator('#mediaGrid .media-card[data-path="Library/Next/Clip.mp4"]');
  await expect(clip.locator('.media-meta')).toHaveText(dateLabel(older));
  await expect.poll(() => page.evaluate(() => window.metadataPaths())).toContain('Library/Next/Clip.mp4');

  await page.evaluate(path => window.releaseMetadata(path, 75), started);
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 100)));
  expect(await staleCard.evaluate(card => [card.isConnected, card.querySelector('.media-meta')?.textContent, card.classList.contains('has-duration')])).toEqual([false, staleDate, false]);
  expect(await page.evaluate(() => window.metadataPaths())).toEqual([started, 'Library/Next/Clip.mp4']);
  await expect(clip.locator('.media-meta')).toHaveText(dateLabel(older));

  await page.evaluate(() => window.releaseMetadata('Library/Next/Clip.mp4', 3729));
  await expect(clip.locator('.media-meta')).toHaveText('1:02:09');
  await expect(clip).toHaveClass(/has-duration/);
});

test('a video whose poster cannot be generated shows no-preview and still opens', async ({page}) => {
  await routeListings(page, {Broken: [video('Broken/Missing.mp4', Date.UTC(2026, 0, 15, 12) / 1000)]});
  await page.goto('/?path=Broken');
  const card = page.locator('#mediaGrid .media-card.video');
  await expect(card).toHaveClass(/is-broken/);
  await expect(card.locator('.thumb-fallback')).toBeVisible();
  await expect(card.locator('.thumb-fallback')).toHaveText('Нет превью');
  await card.click();
  await expect(page.locator('#viewer')).toBeVisible();
  await expect(page.locator('#viewer .caption')).toContainText('Missing.mp4');
});

test('on a phone the header fits and the gallery controls sit in the ⋯ menu', async ({page}, testInfo) => {
  test.skip(!testInfo.project.use.isMobile, 'Phone header.');
  await openAlbum(page);
  const actions = page.locator('.topbar-actions');
  expect(await actions.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  const more = page.getByRole('button', {name: 'Ещё'});
  await expect(page.locator('#refresh')).toBeHidden();

  await more.click();
  await expect(more).toHaveAttribute('aria-expanded', 'true');
  for (const control of ['#gridDensity', '#tvMode', '#refresh', '#statusMode']) await expect(page.locator(control)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  await expect(more).toBeFocused();
  await expect(page).toHaveURL(/path=Album(\+|%20)A/);

  await more.click();
  await page.locator('#refresh').click();
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#refresh')).not.toHaveAttribute('aria-busy', 'true');

  // A section entry in the menu opens its section and closes the menu.
  await more.click();
  await page.locator('#statusMode').click();
  await expect(page.locator('#statusSurface')).toBeVisible();
  await expect(page.locator('body')).toHaveAttribute('data-surface', 'status');
  await expect(page.locator('#topbarMenu')).toBeHidden();
  await expect(more).toHaveAttribute('aria-expanded', 'false');

  // Back in Галерея the menu opens again with the gallery controls.
  await page.locator('#galleryMode').click();
  await expect(page.locator('body')).toHaveAttribute('data-surface', 'gallery');
  await more.click();
  await expect(more).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#refresh')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#refresh')).toBeHidden();
});

test('Backspace on a focused select keeps the nested folder', async ({page}) => {
  const photo = path => ({name: path.split('/').pop(), path, kind: 'image', size: 1000, modTime: '2026-01-15T12:00:00Z', sortTime: 1_760_000_000});
  await routeListings(page, {Trip: [directory('Trip/Day 1')], 'Trip/Day 1': [photo('Trip/Day 1/a.jpg'), photo('Trip/Day 1/b.jpg')]});
  await stubMedia(page);
  await page.goto('/?path=Trip%2FDay%201');
  await expect(page.locator('#mediaGrid .media-card')).toHaveCount(2);
  await expect(page.locator('#refresh')).not.toHaveAttribute('aria-busy', 'true');
  const url = page.url();
  const crumbs = await page.locator('#breadcrumbs').textContent();
  const listings = [];
  page.on('request', request => { if (request.url().includes('/api/list')) listings.push(request.url()); });

  await page.locator('#mediaSort').focus();
  await page.keyboard.press('Backspace');
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 300)));
  expect(page.url()).toBe(url);
  await expect(page.locator('#breadcrumbs')).toHaveText(crumbs);
  await expect(page.locator('#mediaGrid .media-card')).toHaveCount(2);
  await expect(page.locator('#mediaSort')).toBeFocused();
  expect(listings).toEqual([]);
});

test('filter, sort, and grouping sit above the folders and media in every scope', {tag: '@essential'}, async ({page}, testInfo) => {
  const mediaFile = (path, hour, kind = 'image') => ({name: path.split('/').pop(), path, kind, size: 2048, modTime: '2026-01-15T12:00:00Z', sortTime: 1_760_000_000 + hour * 3600});
  const files = [mediaFile('Trip/b.jpg', 1), mediaFile('Trip/a.mp4', 2, 'video'), mediaFile('Trip/Day 1/c.jpg', 3), mediaFile('Trip/Day 2/d.jpg', 4)];
  const listings = {
    '': [directory('Archive'), directory('Misc'), directory('Trip'), directory('Zoo')],
    Trip: [directory('Trip/Day 1'), directory('Trip/Day 2'), ...files.slice(0, 2)],
    'Trip?recursive': files,
  };
  await mockListings(page, (key, path) => (key === 'Broken' ? {status: 500, body: 'boom'} : listingAnswer(path, listings[key] ?? [])));
  await stubMedia(page);
  const tools = page.locator('#mediaTools');
  const box = async locator => /** @type {{x: number, y: number, width: number, height: number}} */ (await locator.boundingBox());
  const expectAbove = async locator => {
    const [panel, below] = [await box(tools), await box(locator)];
    expect(panel.y + panel.height).toBeLessThanOrEqual(below.y);
  };
  const expectNoOverflow = async () => expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);

  // The root has folders only, yet the controls are there, above the first folder.
  await page.goto('/');
  await expect(page.locator('#folders .folder-card')).toHaveCount(4);
  await expect(tools).toBeVisible();
  await expect(page.locator('#mediaSection')).toBeHidden();
  await expectAbove(page.locator('#folders .folder-card').first());
  const status = await box(page.locator('.gallery-toolbar'));
  expect(status.y + status.height).toBeLessThanOrEqual((await box(tools)).y);
  await expectNoOverflow();
  await tools.evaluate(element => { element.dataset.marker = 'same node'; });

  await page.getByRole('button', {name: 'Открыть папку Trip'}).click();
  await expect(page.locator('#mediaGrid .media-card')).toHaveCount(2);
  await expectAbove(page.locator('#folders .folder-card').first());
  await expectAbove(page.locator('#mediaSection h1'));
  const top = (await box(tools)).y;

  // Switching the scope hides the folders; the same controls stay at the same place.
  await page.locator('#recursiveToggle').click();
  await expect(page.locator('#mediaGrid .media-card')).toHaveCount(files.length);
  await expect(page.locator('#foldersSection')).toBeHidden();
  await expect(tools).toHaveAttribute('data-marker', 'same node');
  expect((await box(tools)).y).toBe(top);
  await expectAbove(page.locator('#mediaGrid .media-card').first());
  await page.locator('#recursiveToggle').click();
  await expect(page.locator('#foldersSection')).toBeVisible();
  await expect(tools).toHaveAttribute('data-marker', 'same node');
  expect((await box(tools)).y).toBe(top);
  await expect(page.locator('#gallerySurface #mediaTools')).toHaveCount(1);

  // The controls still drive the grid.
  await page.locator('#mediaFilter [data-filter="video"]').click();
  await expect(page.locator('#mediaGrid .media-card')).toHaveCount(1);
  await page.locator('#mediaFilter [data-filter="all"]').click();
  await page.locator('#mediaSort').selectOption('name');
  await page.locator('#mediaDirection').click();
  await expect(page.locator('#mediaGrid .media-card')).toHaveCount(2);
  expect(await page.locator('#mediaGrid .media-card').evaluateAll(cards => cards.map(card => card.dataset.path))).toEqual(['Trip/a.mp4', 'Trip/b.jpg']);
  await page.locator('#mediaGroup').selectOption('day');
  await expect(page.locator('#mediaGrid .media-group-heading')).toHaveCount(1);
  await expectNoOverflow();
  if (isDesktopBrowserProject(testInfo)) {
    await page.setViewportSize({width: 1920, height: 1080});
    await expectNoOverflow();
  }

  // A failed load hides them.
  await page.goto('/?path=Broken');
  await expect(page.locator('#status')).toHaveText('Каталог недоступен');
  await expect(tools).toBeHidden();
});
