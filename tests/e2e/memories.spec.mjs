import {test, expect} from '@playwright/test';
import {isDesktopBrowserProject} from './helpers.mjs';
import {DEFAULT_INTERVAL} from '../../web/slideshow.js';
import {formatMemoryPeriod, MEMORIES_SHOWN_LIMIT, MEMORIES_TITLE} from '../../web/memories.js';

// Media order is the backend's, deliberately unlike any gallery sort.
const ORDER = ['Album A/Photo 07.png', 'Album B/Photo 02.png', 'Album A/Photo 01.png', 'Album A/Photo 12.png', 'Album B/Photo 04.png'];
const nameOf = path => path.slice(path.lastIndexOf('/') + 1);

function memoryEvent(year, startDay, endDay, paths = ORDER) {
  const startDate = `${year}-10-${String(startDay).padStart(2, '0')}`;
  const endDate = `${year}-10-${String(endDay).padStart(2, '0')}`;
  return {
    id: `${startDate}_${endDate}`,
    year,
    startDate,
    endDate,
    anchorDate: '2026-10-20',
    mediaCount: paths.length,
    media: paths.map((path, index) => ({path, kind: 'image', sortTime: 1_700_000_000 + index, captured: true})),
  };
}

const EVENTS = Array.from({length: 8}, (_, index) => memoryEvent(2025 - index, 10 + index, 14 + index));
const ready = (events = EVENTS) => ({version: 1, state: 'ready', generatedAt: '2026-10-23T03:00:00Z', revision: 'e2e', shown: Math.min(MEMORIES_SHOWN_LIMIT, events.length), events});
const UNAVAILABLE = {version: 1, state: 'unavailable', shown: 0, events: []};
const periodOf = event => formatMemoryPeriod(event.startDate, event.endDate);

/** Serve `/api/memories` from the test; the returned setter changes later answers. */
async function mockMemories(page, body, status = 200) {
  let answer = {body, status};
  await page.route('**/api/memories*', route => route.fulfill({status: answer.status, contentType: 'application/json', body: JSON.stringify(answer.body)}));
  return (next, nextStatus = 200) => { answer = {body: next, status: nextStatus}; };
}

const surface = page => page.locator('#memoriesSurface');
const entry = page => page.locator('#memoriesMode');
const cards = page => surface(page).locator('.memory-card');
const openButton = (page, event) => surface(page).getByRole('button', {name: `Открыть воспоминание: ${periodOf(event)}, 5 фото`});

async function openMemories(page) {
  await entry(page).click();
  await expect(surface(page)).toBeVisible();
  await expect(surface(page)).toHaveAttribute('data-state', 'ready');
}

test.beforeEach(async ({page}, testInfo) => {
  test.skip(!isDesktopBrowserProject(testInfo), 'Memories flows run once per desktop browser engine; touch is covered by its own context.');
  await page.emulateMedia({reducedMotion: 'reduce'});
});

test('ready memories show six cards and the full list, and the gallery stays as it was', {tag: '@essential'}, async ({page}) => {
  await mockMemories(page, ready());
  await page.goto('/?path=Album%20A');
  await expect(page.locator('#mediaGrid .media-card.image')).toHaveCount(13);
  const tile = page.locator('#mediaGrid .media-card').nth(4);
  const tilePath = await tile.getAttribute('data-path');
  await tile.focus();
  const listings = [];
  page.on('request', request => { if (request.url().includes('/api/list')) listings.push(request.url()); });

  await expect(entry(page)).toBeVisible();
  await openMemories(page);
  await expect(entry(page)).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('#gallerySurface')).toBeHidden();
  await expect(surface(page).getByRole('heading', {level: 1})).toHaveText(MEMORIES_TITLE);
  await expect(cards(page)).toHaveCount(MEMORIES_SHOWN_LIMIT);
  await expect(cards(page).locator('.memory-period')).toHaveText(EVENTS.slice(0, MEMORIES_SHOWN_LIMIT).map(periodOf));
  await expect(cards(page).first().locator('.memory-contents')).toHaveText('5 фото');

  await surface(page).getByRole('button', {name: 'Все воспоминания'}).click();
  await expect(cards(page)).toHaveCount(EVENTS.length);
  await expect(cards(page).locator('.memory-period')).toHaveText(EVENTS.map(periodOf));
  await expect(surface(page).getByRole('heading', {level: 2})).toBeFocused();
  await expect(surface(page).getByRole('button', {name: 'Все воспоминания'})).toBeHidden();

  // Escape leaves the full list for the main surface and lands on its entry action.
  await page.keyboard.press('Escape');
  await expect(cards(page)).toHaveCount(MEMORIES_SHOWN_LIMIT);
  await expect(surface(page).getByRole('button', {name: 'Все воспоминания'})).toBeFocused();

  await page.locator('#galleryMode').click();
  await expect(page.locator('#gallerySurface')).toBeVisible();
  await expect(page.locator(`#mediaGrid .media-card[data-path="${tilePath}"]`)).toBeFocused();
  expect(listings).toEqual([]);
});

test('an event opens the viewer in backend order and returns to its card', {tag: '@essential'}, async ({page}) => {
  await mockMemories(page, ready());
  await page.goto('/');
  await openMemories(page);
  const card = openButton(page, EVENTS[1]);
  await card.click();
  const viewer = page.locator('#viewer');
  const caption = viewer.locator('.caption');
  await expect(viewer).toBeVisible();
  for (const [index, path] of ORDER.entries()) {
    await expect(caption).toHaveText(`${nameOf(path)} · ${index + 1}/${ORDER.length}`);
    await expect(viewer.locator('.stage img')).toHaveAttribute('src', new RegExp(`path=${encodeURIComponent(path).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    if (index < ORDER.length - 1) await page.keyboard.press('ArrowRight');
  }
  await page.keyboard.press('Escape');
  await expect(viewer).toBeHidden();
  await expect(card).toBeFocused();
  await expect(surface(page)).toBeVisible();
});

test('slideshow and TV mode play an event', async ({page}) => {
  await page.clock.install();
  await mockMemories(page, ready());
  await page.goto('/');
  await openMemories(page);
  await openButton(page, EVENTS[0]).click();
  const viewer = page.locator('#viewer');
  const caption = viewer.locator('.caption');
  await expect(caption).toHaveText(`${nameOf(ORDER[0])} · 1/${ORDER.length}`);
  await viewer.locator('.slideshow').click();
  await page.clock.runFor(DEFAULT_INTERVAL * 1000 + 100);
  await expect(caption).toHaveText(`${nameOf(ORDER[1])} · 2/${ORDER.length}`);
  await page.keyboard.press('Escape');
  await expect(viewer).toBeHidden();

  const tvButton = surface(page).getByRole('button', {name: `Показать в режиме TV: ${periodOf(EVENTS[0])}`});
  await tvButton.click();
  await expect(viewer).toHaveAttribute('data-tv', 'true');
  await expect(caption).toHaveText(`${nameOf(ORDER[0])} · 1/${ORDER.length}`);
  expect(await page.evaluate(() => document.fullscreenElement?.className)).toBe('viewer-frame');
  // As with the header TV button: leave fullscreen first, then close the viewer.
  await page.evaluate(() => document.exitFullscreen());
  await expect(viewer).not.toHaveAttribute('data-tv');
  await page.keyboard.press('Escape');
  await expect(viewer).toBeHidden();
  await expect(tvButton).toBeFocused();
});

for (const [name, body, status, state, text] of [
  ['an empty artifact', ready([]), 200, 'empty', 'Сейчас воспоминаний нет'],
  ['an unavailable artifact', UNAVAILABLE, 200, 'unavailable', 'Подборка ещё готовится'],
  ['a failing endpoint', {error: 'boom'}, 500, 'error', 'Не удалось загрузить воспоминания'],
  ['a malformed answer', {state: 'ready', events: 'oops'}, 200, 'unavailable', 'Подборка ещё готовится'],
]) {
  test(`${name} keeps the entry, shows its state in the section, and leaves the gallery working`, async ({page}) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await mockMemories(page, body, status);
    const answered = page.waitForResponse(response => response.url().includes('/api/memories'));
    await page.goto('/');
    await answered;
    await expect(page.getByRole('button', {name: 'Открыть папку Album A'})).toBeVisible();
    await expect(page.locator('#collageMode')).toBeVisible();
    await entry(page).click();
    await expect(surface(page)).toHaveAttribute('data-state', state);
    await expect(surface(page).getByText(text)).toBeVisible();
    await expect(cards(page)).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

test('the entry is shown while memories are still loading', async ({page}) => {
  await page.route('**/api/memories*', () => {});
  await page.goto('/');
  await entry(page).click();
  await expect(surface(page)).toHaveAttribute('data-state', 'loading');
  await expect(surface(page).locator('.memories-note')).toHaveText('Загрузка воспоминаний…');
});

test('a failed update keeps the last list; an unavailable answer shows its state', async ({page}) => {
  const answer = await mockMemories(page, ready());
  await page.goto('/');
  await openMemories(page);
  await expect(cards(page)).toHaveCount(MEMORIES_SHOWN_LIMIT);

  answer({error: 'boom'}, 500);
  const failed = page.waitForResponse(response => response.url().includes('/api/memories'));
  await page.locator('#galleryMode').click();
  await entry(page).click();
  await failed;
  await expect(surface(page)).toHaveAttribute('data-state', 'error');
  await expect(cards(page)).toHaveCount(MEMORIES_SHOWN_LIMIT);
  await expect(surface(page).locator('.memories-note')).toHaveText('Не удалось обновить воспоминания. Показаны последние загруженные.');
  await expect(entry(page)).toBeVisible();

  answer(UNAVAILABLE);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(surface(page)).toHaveAttribute('data-state', 'unavailable');
  await expect(surface(page).getByText('Воспоминания пока недоступны')).toBeVisible();
  await expect(cards(page)).toHaveCount(0);
  await expect(entry(page)).toBeVisible();

  answer(ready([]));
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(surface(page)).toHaveAttribute('data-state', 'empty');
  await expect(surface(page).getByText('Сейчас воспоминаний нет')).toBeVisible();
});

test('missing previews fall back and the event still opens', async ({page}) => {
  // The cover takes media 1, 2, 4, and 5; the first and the fourth do not exist.
  const paths = ['Album A/Missing 1.png', 'Album A/Photo 02.png', 'Album A/Photo 03.png', 'Album A/Missing 2.png', 'Album A/Photo 05.png'];
  const event = memoryEvent(2024, 3, 6, paths);
  await mockMemories(page, ready([event]));
  await page.goto('/');
  await openMemories(page);
  await expect(cards(page)).toHaveCount(1);
  await expect(surface(page).getByRole('button', {name: 'Все воспоминания'})).toBeHidden();
  const cells = cards(page).locator('.memory-cover-cell');
  await expect(cells).toHaveCount(4);
  await expect(cards(page).locator('.memory-cover-cell.is-broken')).toHaveCount(2);
  await expect(cards(page).locator('.memory-cover-cell.is-loaded')).toHaveCount(2);
  await openButton(page, event).click();
  await expect(page.locator('#viewer')).toBeVisible();
  await expect(page.locator('#viewer .caption')).toContainText(`/${paths.length}`);
});

test('cards are a labelled list that arrow keys and Enter can drive', async ({page}) => {
  await mockMemories(page, ready());
  await page.goto('/');
  await openMemories(page);
  const region = page.getByRole('region', {name: MEMORIES_TITLE});
  await expect(region).toBeVisible();
  await expect(region.getByRole('list')).toBeVisible();
  await expect(region.getByRole('listitem')).toHaveCount(MEMORIES_SHOWN_LIMIT);

  const first = openButton(page, EVENTS[0]);
  const second = openButton(page, EVENTS[1]);
  await first.focus();
  await page.keyboard.press('ArrowRight');
  await expect(second).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(first).toBeFocused();
  await page.keyboard.press('Tab');
  const firstTV = region.getByRole('button', {name: `Показать в режиме TV: ${periodOf(EVENTS[0])}`});
  if (!(await firstTV.evaluate(element => element === document.activeElement))) {
    // Safari skips buttons during Tab navigation unless full keyboard access is enabled.
    await page.keyboard.press('ArrowDown');
    await firstTV.focus();
  }
  await expect(firstTV).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  if (!(await first.evaluate(element => element === document.activeElement))) {
    await page.keyboard.press('ArrowDown');
    await first.focus();
  }
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await expect(page.locator('#viewer')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(second).toBeFocused();

  // Leaving for the gallery and coming back restores the same card.
  await page.locator('#galleryMode').click();
  await entry(page).click();
  await expect(second).toBeFocused();
});

test('touch opens memories and an event', async ({browser, baseURL}) => {
  const context = await browser.newContext({baseURL, hasTouch: true, viewport: {width: 390, height: 844}, locale: 'ru-RU', timezoneId: 'Europe/Moscow'});
  const page = await context.newPage();
  await mockMemories(page, ready());
  await page.goto('/');
  await entry(page).tap();
  await expect(surface(page)).toHaveAttribute('data-state', 'ready');
  await expect(cards(page)).toHaveCount(MEMORIES_SHOWN_LIMIT);
  const box = await openButton(page, EVENTS[0]).boundingBox();
  expect(box?.width).toBeLessThanOrEqual(390);
  const tvBox = await surface(page).locator('.memory-tv').first().boundingBox();
  expect(Math.min(tvBox?.width ?? 0, tvBox?.height ?? 0)).toBeGreaterThanOrEqual(44);
  await surface(page).getByRole('button', {name: 'Все воспоминания'}).tap();
  await expect(cards(page)).toHaveCount(EVENTS.length);
  await openButton(page, EVENTS[7]).tap();
  await expect(page.locator('#viewer .caption')).toHaveText(`${nameOf(ORDER[0])} · 1/${ORDER.length}`);
  await context.close();
});
