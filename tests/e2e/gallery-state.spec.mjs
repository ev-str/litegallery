import {test, expect} from '@playwright/test';
import {VIEWS_KEY} from '../../web/gallery-state.js';

const ONE_PIXEL_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const FOLDERS = Array.from({length: 40}, (_, index) => `Folder ${String(index + 1).padStart(2, '0')}`);
const PHOTOS = 60;

const directory = path => ({name: path.split('/').pop(), path, kind: 'directory', modTime: '2026-01-15T12:00:00Z'});
const photo = (folder, index) => {
  const name = `Photo ${String(index).padStart(3, '0')}.png`;
  return {name, path: `${folder}/${name}`, kind: 'image', size: 1000 + index, modTime: '2026-01-15T12:00:00Z', sortTime: 1_760_000_000 + index * 3600};
};

/**
 * Synthetic library: a root of 40 folders with 60 photos each. Listings can be
 * replaced per path; listings whose path matches `hold` wait until released.
 */
async function mockLibrary(page) {
  const overrides = new Map();
  /** @type {{path: string, release: () => Promise<void>}[]} */
  const held = [];
  const library = {overrides, held, hold: (/** @type {string} */ path) => false};
  await page.route(url => url.pathname === '/api/list', route => {
    const path = new URL(route.request().url()).searchParams.get('path') ?? '';
    const entries = overrides.get(path) ?? (path ? Array.from({length: PHOTOS}, (_, index) => photo(path, index + 1)) : FOLDERS.map(directory));
    const fulfill = () => route.fulfill({json: {path: path || '.', title: 'E2E Gallery', entries}});
    if (library.hold(path)) {
      held.push({path, release: fulfill});
      return undefined;
    }
    return fulfill();
  });
  await page.route(url => ['/api/thumb', '/api/cover', '/api/media'].includes(url.pathname), route => route.fulfill({contentType: 'image/png', body: ONE_PIXEL_PNG}));
  return library;
}

const folderCard = (page, name) => page.getByRole('button', {name: `Открыть папку ${name}`});
const tile = (page, path) => page.locator(`#mediaGrid .media-card[data-path="${path}"]`);
const scrollTop = page => page.evaluate(() => Math.round(scrollY));
const historyLength = page => page.evaluate(() => history.length);

async function scrollToCard(page, locator) {
  await locator.evaluate(element => {
    const top = element.getBoundingClientRect().top + scrollY - innerHeight / 2;
    scrollTo({top, behavior: 'instant'});
  });
  return scrollTop(page);
}

async function openFolder(page, name) {
  await folderCard(page, name).click();
  await expect(page.locator('#mediaGrid .media-card')).toHaveCount(PHOTOS);
  await expect(page).toHaveURL(new RegExp(`\\?path=${encodeURIComponent(name)}$`));
}

test('each folder restores its own scroll and focus target', {tag: '@essential'}, async ({page}) => {
  await mockLibrary(page);
  await page.goto('/');
  await expect(page.locator('#folders .folder-card')).toHaveCount(FOLDERS.length);
  const rootScroll = await scrollToCard(page, folderCard(page, 'Folder 05'));
  expect(rootScroll).toBeGreaterThan(200);

  await openFolder(page, 'Folder 05');
  expect(await scrollTop(page)).toBe(0);
  const folderScroll = await scrollToCard(page, tile(page, 'Folder 05/Photo 020.png'));
  expect(folderScroll).toBeGreaterThan(200);
  expect(folderScroll).not.toBe(rootScroll);

  await page.keyboard.press('Escape');
  await expect(page.locator('#folders .folder-card')).toHaveCount(FOLDERS.length);
  await expect.poll(() => scrollTop(page)).toBe(rootScroll);
  await expect(folderCard(page, 'Folder 05')).toBeFocused();

  // A folder visited for the first time starts at the top, not at another folder's offset.
  await openFolder(page, 'Folder 06');
  expect(await scrollTop(page)).toBe(0);
  await page.locator('#breadcrumbs button', {hasText: 'Все фото'}).click();
  await expect.poll(() => scrollTop(page)).toBe(rootScroll);
  await openFolder(page, 'Folder 05');
  await expect.poll(() => scrollTop(page)).toBe(folderScroll);
});

test('closing the viewer focuses and briefly highlights the tile it was opened from', {tag: '@essential'}, async ({page}) => {
  await mockLibrary(page);
  await page.goto('/?path=Folder%2001');
  const opened = tile(page, 'Folder 01/Photo 030.png');
  const scroll = await scrollToCard(page, opened);
  await opened.click();
  const viewer = page.locator('#viewer');
  await expect(viewer.locator('.caption')).toContainText('Photo 030.png');
  const next = viewer.getByRole('button', {name: 'Следующее'});
  await next.focus();
  await next.press('Enter');
  await expect(viewer.locator('.caption')).toContainText('Photo 029.png');
  const close = viewer.getByRole('button', {name: 'Закрыть', exact: true});
  await close.focus();
  await close.press('Enter');

  await expect(viewer).toBeHidden();
  await expect(opened).toBeFocused();
  await expect(opened).toHaveClass(/is-last-opened/);
  await expect(opened).toHaveCSS('outline-style', 'solid');
  // A visible tile does not move the page.
  expect(await scrollTop(page)).toBe(scroll);
  await expect(opened).not.toHaveClass(/is-last-opened/, {timeout: 4000});
  await expect(opened).toBeFocused();
  await expect(opened).toHaveCSS('outline-style', 'solid');

  // An off-screen tile is scrolled into view; reduced motion still clears the highlight.
  await page.emulateMedia({reducedMotion: 'reduce'});
  await opened.click();
  await expect(viewer).toBeVisible();
  await page.evaluate(() => scrollTo({top: 0, behavior: 'instant'}));
  await page.keyboard.press('Escape');
  await expect(opened).toBeFocused();
  await expect(opened).toBeInViewport();
  const header = await page.locator('.topbar').boundingBox();
  expect((await opened.boundingBox()).y).toBeGreaterThanOrEqual(header.y + header.height);
  await expect(opened).toHaveCSS('animation-name', 'gallery-last-opened-still');
  await expect(opened).not.toHaveClass(/is-last-opened/, {timeout: 4000});
});

test('refresh keeps filter, sorting, direction, density, scroll, and the focused tile', {tag: '@essential'}, async ({page}, testInfo) => {
  await mockLibrary(page);
  await page.goto('/?path=Folder%2002');
  await page.locator('#mediaFilter [data-filter="image"]').click();
  await page.locator('#mediaSort').selectOption('name');
  await page.locator('#mediaDirection').click();
  const columns = testInfo.project.use.viewport.width <= 700 ? 3 : 7;
  await page.locator(`#gridDensity [data-columns="${columns}"]`).click();
  const order = await page.locator('#mediaGrid .media-card').evaluateAll(cards => cards.map(card => card.getAttribute('data-path')));
  expect(order[0]).toBe('Folder 02/Photo 001.png');
  const focused = tile(page, 'Folder 02/Photo 040.png');
  const scroll = await scrollToCard(page, focused);
  await focused.focus();

  // A refresh that is not started from the button (A8) also gives the tile back its focus.
  const refreshed = page.waitForResponse(response => response.url().includes('/api/list?path=Folder%2002'));
  await page.evaluate(() => document.querySelector('#refresh').click());
  await refreshed;
  await expect(page.locator('#refresh')).not.toHaveAttribute('aria-busy', 'true');
  await expect.poll(() => scrollTop(page)).toBe(scroll);
  await expect(focused).toBeFocused();
  expect(await page.locator('#mediaGrid .media-card').evaluateAll(cards => cards.map(card => card.getAttribute('data-path')))).toEqual(order);
  await expect(page.locator('#mediaFilter [data-filter="image"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#mediaSort')).toHaveValue('name');
  await expect(page.locator('#mediaDirection')).toHaveAttribute('title', 'От A к Z');
  await expect(page.locator(`#gridDensity [data-columns="${columns}"]`)).toHaveAttribute('aria-pressed', 'true');

  // The refresh button keeps its own focus.
  const refresh = page.locator('#refresh');
  await refresh.evaluate(element => element.focus({preventScroll: true}));
  await refresh.press('Enter');
  await expect(page.locator('#refresh')).not.toHaveAttribute('aria-busy', 'true');
  await expect.poll(() => scrollTop(page)).toBe(scroll);
  await expect(refresh).toBeFocused();

  // A reload restores the same view from session storage.
  await page.reload();
  await expect(page.locator('#mediaGrid .media-card')).toHaveCount(PHOTOS);
  await expect.poll(() => scrollTop(page)).toBe(scroll);
  const stored = await page.evaluate(key => JSON.parse(sessionStorage.getItem(key))['Folder 02'], VIEWS_KEY);
  expect(stored.focusPath).toBe('Folder 02/Photo 040.png');
  expect(await page.evaluate(() => ['gallery-media-filter', 'gallery-media-sort', 'gallery-media-order'].map(key => localStorage.getItem(key)))).toEqual(['image', 'name', 'asc']);
});

test('filter, sort, and density changes keep the controls and the top tile in place', async ({page}, testInfo) => {
  await mockLibrary(page);
  await page.goto('/?path=Folder%2003');
  const heading = page.locator('#mediaSection .section-heading');
  await page.evaluate(() => scrollTo({top: 120, behavior: 'instant'}));
  const headingY = (await heading.boundingBox()).y;
  await page.locator('#mediaSort').selectOption('name');
  expect((await heading.boundingBox()).y).toBe(headingY);
  await page.locator('#mediaDirection').click();
  expect((await heading.boundingBox()).y).toBe(headingY);
  expect(await scrollTop(page)).toBe(120);

  // Stay clear of the document's lower scroll limit in both density modes.
  const anchorIndex = testInfo.project.use.viewport.width <= 700 ? 12 : 10;
  const top = page.locator('#mediaGrid .media-card').nth(anchorIndex);
  const headerBottom = await page.locator('.topbar').evaluate(element => element.getBoundingClientRect().bottom);
  await top.evaluate((element, offset) => scrollTo({top: element.getBoundingClientRect().top + scrollY - offset, behavior: 'instant'}), headerBottom + 6);
  const before = (await top.boundingBox()).y;
  const columns = testInfo.project.use.viewport.width <= 700 ? 3 : 7;
  await page.locator(`#gridDensity [data-columns="${columns}"]`).click();
  expect(Math.round((await top.boundingBox()).y)).toBe(Math.round(before));
});

test('back and forward restore folder, address, scroll, and focus without new entries', {tag: '@essential'}, async ({page}) => {
  await mockLibrary(page);
  await page.goto('/');
  await expect(page.locator('#folders .folder-card')).toHaveCount(FOLDERS.length);
  const rootScroll = await scrollToCard(page, folderCard(page, 'Folder 04'));
  await openFolder(page, 'Folder 04');
  const folderScroll = await scrollToCard(page, tile(page, 'Folder 04/Photo 025.png'));
  const entries = await historyLength(page);

  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator('#breadcrumbs button')).toHaveText(['Все фото']);
  await expect.poll(() => scrollTop(page)).toBe(rootScroll);
  await expect(folderCard(page, 'Folder 04')).toBeFocused();

  await page.goForward();
  await expect(page).toHaveURL(/\?path=Folder%2004$/);
  await expect(page.locator('#breadcrumbs button')).toHaveText(['Все фото', 'Folder 04']);
  await expect.poll(() => scrollTop(page)).toBe(folderScroll);
  expect(await historyLength(page)).toBe(entries);
});

test('a tile that disappears while the viewer is open falls back safely', async ({page}) => {
  const library = await mockLibrary(page);
  const errors = [];
  page.on('pageerror', error => errors.push(error));
  await page.goto('/?path=Folder%2007');
  const removed = 'Folder 07/Photo 030.png';
  const removedIndex = await page.locator('#mediaGrid .media-card').evaluateAll((cards, path) => cards.findIndex(card => card.getAttribute('data-path') === path), removed);
  await tile(page, removed).click();
  await expect(page.locator('#viewer')).toBeVisible();

  // Refresh while the viewer is open (as A8 will) and drop the opened file.
  library.overrides.set('Folder 07', Array.from({length: PHOTOS}, (_, index) => photo('Folder 07', index + 1)).filter(item => item.path !== removed));
  await page.evaluate(() => document.querySelector('#refresh').click());
  await expect(page.locator('#mediaGrid .media-card')).toHaveCount(PHOTOS - 1);
  await page.keyboard.press('Escape');
  await expect(page.locator('#viewer')).toBeHidden();
  const neighbour = page.locator('#mediaGrid .media-card').nth(removedIndex);
  await expect(neighbour).toBeFocused();
  await expect(neighbour).not.toHaveClass(/is-last-opened/);

  // No tile left: focus goes to the refresh button, visibly and without scrolling.
  await neighbour.click();
  await expect(page.locator('#viewer')).toBeVisible();
  library.overrides.set('Folder 07', []);
  await page.evaluate(() => document.querySelector('#refresh').click());
  await expect(page.locator('#emptyState')).toBeVisible();
  const scroll = await scrollTop(page);
  const closeEmpty = page.locator('#viewer').getByRole('button', {name: 'Закрыть', exact: true});
  await closeEmpty.focus();
  await closeEmpty.press('Enter');
  await expect(page.locator('#viewer')).toBeHidden();
  const refresh = page.locator('#refresh');
  await expect(refresh).toBeFocused();
  await expect(refresh).toHaveCSS('outline-style', 'solid');
  expect(await refresh.evaluate(element => parseFloat(getComputedStyle(element).outlineWidth))).toBeGreaterThan(0);
  expect(await scrollTop(page)).toBe(scroll);
  expect(errors).toEqual([]);
});

test('state restore keeps latest-request-wins for navigation and refresh', {tag: '@essential'}, async ({page}) => {
  const library = await mockLibrary(page);
  await page.goto('/');
  await expect(page.locator('#folders .folder-card')).toHaveCount(FOLDERS.length);
  const rootScroll = await scrollToCard(page, folderCard(page, 'Folder 08'));
  // Folder counts also use /api/list; let the visible ones finish first.
  await expect(folderCard(page, 'Folder 08').locator('.folder-meta')).toContainText('фото');
  const entries = await historyLength(page);

  library.hold = path => path === 'Folder 08' || path === '';
  await folderCard(page, 'Folder 08').click();
  await expect.poll(() => library.held.length).toBe(1);
  await page.locator('#breadcrumbs button', {hasText: 'Все фото'}).click();
  await expect.poll(() => library.held.length).toBe(2);
  const [stale, latest] = library.held.splice(0);
  expect([stale.path, latest.path]).toEqual(['Folder 08', '']);

  await latest.release();
  await expect(page.locator('#folders .folder-card')).toHaveCount(FOLDERS.length);
  await expect.poll(() => scrollTop(page)).toBe(rootScroll);
  await expect(folderCard(page, 'Folder 08')).toBeFocused();
  const firstCard = await page.locator('#folders .folder-card').first().elementHandle();

  await stale.release().catch(() => {});
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 300)));
  expect(await firstCard.evaluate(card => card.isConnected)).toBe(true);
  expect(await scrollTop(page)).toBe(rootScroll);
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator('#breadcrumbs button')).toHaveText(['Все фото']);
  await expect(page.locator('#refresh')).not.toHaveAttribute('aria-busy', 'true');
  expect(await historyLength(page)).toBe(entries);

  // Two refreshes: the interrupted one must not overwrite the remembered scroll.
  library.hold = path => path === '';
  await page.locator('#refresh').click();
  await page.locator('#refresh').click();
  await expect.poll(() => library.held.length).toBe(2);
  const [first, second] = library.held.splice(0);
  await second.release();
  await expect(page.locator('#refresh')).not.toHaveAttribute('aria-busy', 'true');
  await expect.poll(() => scrollTop(page)).toBe(rootScroll);
  await first.release().catch(() => {});
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 300)));
  expect(await scrollTop(page)).toBe(rootScroll);
  expect(await page.evaluate(key => JSON.parse(sessionStorage.getItem(key))[''].scrollY, VIEWS_KEY)).toBe(rootScroll);
});
