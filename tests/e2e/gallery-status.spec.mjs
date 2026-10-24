import {test, expect} from '@playwright/test';
import {STATUS_POLL_MS} from '../../web/gallery-status.js';
import {clickHeaderControl, galleryView, isDesktopBrowserProject, openAlbum} from './helpers.mjs';

// Europe/Moscow (playwright.config) is UTC+3: 07:00Z reads as 10:00.
const NOW = new Date('2026-10-23T10:30:00Z');

const RUNNING = {
  version: 1,
  state: 'running',
  run: {state: 'running', phase: 'thumbnails', startedAt: '2026-10-23T07:00:00Z', updatedAt: '2026-10-23T10:29:58Z', scanned: 400, processed: 120, generated: 30, skipped: 89, errors: 2, total: 400, progress: 0.3},
  cache: {mediaFiles: 400, images: 380, videos: 20, readyThumbnails: 390, missingThumbnails: 8, unavailableThumbnails: 2, sizeBytes: 1288490189, lastFullScanAt: '2026-10-22T00:05:00Z'},
  recentErrors: [
    {at: '2026-10-23T07:01:00Z', operation: 'thumbnail', path: '2024/Лето/broken.jpg', error: 'decode: unexpected EOF'},
    {at: '2026-10-23T07:02:00Z', operation: 'walk', path: 'locked', error: 'open: permission denied'},
  ],
  recentErrorsLimit: 20,
  memories: {state: 'ready', updatedAt: '2026-10-23T00:06:00Z', readyVersion: '0123456789abcdef', readyAt: '2026-10-23T00:06:00Z', periods: 147, memories: 12, shown: 6, errors: 0},
};
const READY = {...RUNNING, state: 'ready', run: {...RUNNING.run, state: 'succeeded', phase: undefined, processed: 400, progress: 1, finishedAt: '2026-10-23T10:31:00Z'}};

const surface = page => page.locator('#statusSurface');
const section = (page, name) => surface(page).locator(`[data-status-section="${name}"]`);
const metrics = locator => locator.locator('.gallery-status-metrics li');
// Mirrors the one-column breakpoint in style.css (#statusSurface, max-width: 1099px).
const STACKED_MAX_WIDTH = 1099;
const isStacked = page => (page.viewportSize()?.width ?? 0) <= STACKED_MAX_WIDTH;
// Enough entries to overflow the error card in every viewport.
const MANY_ERRORS = Array.from({length: 20}, (_, index) => ({
  at: `2026-10-23T07:${String(index).padStart(2, '0')}:00Z`,
  operation: 'thumbnail',
  path: `2024/Лето/broken-${String(index).padStart(2, '0')}.jpg`,
  error: 'decode: unexpected EOF',
}));
const errorList = page => section(page, 'errors').getByRole('list', {name: 'Список последних ошибок'});
const boxes = locators => Promise.all(locators.map(async locator => {
  const box = await locator.boundingBox();
  if (!box) throw new Error('element has no box');
  return box;
}));
/** Each metric list is a set of tiles: the number on top, larger than its label. */
async function expectTiles(list, count) {
  await expect(list.locator(':scope > li.gallery-status-tile')).toHaveCount(count);
  const listBox = await list.boundingBox();
  for (const tile of await list.locator(':scope > li').all()) {
    const [box, value, label] = await boxes([tile, tile.locator('.gallery-status-value'), tile.locator('.gallery-status-label')]);
    expect(value.y + value.height).toBeLessThanOrEqual(label.y + 1);
    expect(box.x).toBeGreaterThanOrEqual((listBox?.x ?? 0) - 1);
    expect(box.x + box.width).toBeLessThanOrEqual((listBox?.x ?? 0) + (listBox?.width ?? 0) + 1);
    const [valueSize, labelSize] = await Promise.all([value, label].map((_, index) => tile
      .locator(index ? '.gallery-status-label' : '.gallery-status-value')
      .evaluate(element => parseFloat(getComputedStyle(element).fontSize))));
    expect(valueSize).toBeGreaterThan(labelSize);
  }
}
/** Distinct tile rows of one metric list. */
const tileRows = list => list.locator(':scope > li').evaluateAll(items => new Set(items.map(item => Math.round(item.getBoundingClientRect().top))).size);
/** The error list scrolls inside its card and leaves the page where it was. */
async function expectErrorsScrollInside(page) {
  const list = errorList(page);
  const metrics = await list.evaluate(element => ({overflowY: getComputedStyle(element).overflowY, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight}));
  expect(metrics.overflowY).toBe('auto');
  expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
  const [card, listBox] = await boxes([section(page, 'errors'), list]);
  expect(listBox.y + listBox.height).toBeLessThanOrEqual(card.y + card.height + 1);
  await list.focus();
  await expect(list).toBeFocused();
  const pageScroll = await page.evaluate(() => scrollY);
  await page.keyboard.press('End');
  await expect.poll(() => list.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  expect(await page.evaluate(() => scrollY)).toBe(pageScroll);
}

/** Serve /api/status from `state.body` (or fail with `state.code`) and count requests. */
async function mockStatus(page, body) {
  const state = {body, code: 200, requests: 0};
  await page.route(url => url.pathname === '/api/status', route => {
    state.requests += 1;
    return state.code === 200 ? route.fulfill({json: state.body}) : route.fulfill({status: state.code, body: 'boom'});
  });
  return state;
}

async function openStatus(page) {
  await clickHeaderControl(page, '#statusMode');
  await expect(surface(page)).toBeVisible();
  await expect(surface(page)).not.toHaveAttribute('aria-busy', 'true');
}

test.describe('gallery status', () => {
  test.beforeEach(async ({page}) => {
    await page.clock.install({time: NOW});
  });

  test('running warm shows the accepted hierarchy and polls with one timer until ready', {tag: '@essential'}, async ({page}) => {
    const status = await mockStatus(page, RUNNING);
    await page.goto('/');
    await expect(page.locator('#statusMode')).toHaveJSProperty('hidden', false);
    expect(status.requests).toBe(0);
    await openStatus(page);

    await expect(page.locator('#statusMode')).toHaveAttribute('aria-current', 'page');
    await expect(surface(page).getByRole('heading', {level: 1})).toHaveText('Состояние галереи');
    await expect(surface(page).getByRole('heading', {level: 2})).toHaveText(['Кэш', 'Последние ошибки', 'Воспоминания']);
    await expect(section(page, 'cache').getByRole('heading', {level: 3})).toHaveText('Весь кэш');

    const cache = section(page, 'cache');
    await expect(cache.locator('.gallery-status-run .gallery-status-line')).toHaveText('Текущий запуск — Выполняется');
    await expect(cache.locator('.gallery-status-run > .gallery-status-sub')).toHaveText('Запущен: сегодня в 10:00');
    await expect(cache.locator('.gallery-status-progress-row')).toHaveText('120 / 400 · 30%');
    await expect(cache.locator('progress')).toHaveAttribute('max', '400');
    await expect(metrics(cache.locator('.gallery-status-run'))).toHaveText(['120 обработано', '30 создано', '89 пропущено', '2 ошибки']);
    const whole = section(page, 'whole-cache');
    await expect(metrics(whole)).toHaveText(['400 медиафайлов', '390 миниатюр готово', '8 миниатюр отсутствует', '2 миниатюры недоступны', '1.2 ГБ размер кэша']);
    await expect(whole.locator('.gallery-status-sub')).toHaveText(['Последний полный обход: вчера в 03:05']);

    await expect(section(page, 'errors').locator('.gallery-status-path')).toHaveText(['locked', '2024/Лето/broken.jpg']);
    await expect(section(page, 'errors').locator('li .gallery-status-sub')).toHaveText(['open: permission denied', 'decode: unexpected EOF']);

    const memories = section(page, 'memories');
    await expect(memories.locator('.gallery-status-line')).toHaveText('Готово');
    await expect(memories.locator('.gallery-status-sub')).toHaveText('Последняя готовая версия: сегодня в 03:06');
    await expect(metrics(memories)).toHaveText(['147 периодов', '12 воспоминаний', '6 показано', '0 ошибок']);
    await expect(memories.locator('.gallery-status-value')).toHaveText(['147', '12', '6', '0']);
    await expect(memories.locator('.gallery-status-label')).toHaveText(['периодов', 'воспоминаний', 'показано', 'ошибок']);

    // Strictly read-only: no controls, no explanations, no gallery-only controls.
    await expect(surface(page).locator('button, input, select, a, [role="button"]')).toHaveCount(0);
    await expect(surface(page)).not.toContainText(/Только чтение|Запустить|Остановить|Start|Stop/);
    await expect(page.locator('#recursiveToggle')).toBeHidden();
    await expect(page.getByText('Из подпапок')).toBeHidden();

    // One request in flight, one timer: the next request comes after one interval.
    expect(status.requests).toBe(1);
    await page.clock.runFor(STATUS_POLL_MS - 500);
    expect(status.requests).toBe(1);
    status.body = READY;
    await page.clock.runFor(1000);
    await expect(cache.locator('.gallery-status-run .gallery-status-line')).toHaveText('Текущий запуск — Готово');
    await expect(cache.locator('.gallery-status-progress-row')).toHaveText('400 / 400 · 100%');
    expect(status.requests).toBe(2);
    await page.clock.runFor(STATUS_POLL_MS * 4);
    expect(status.requests).toBe(2);
  });

  test('polling is not duplicated by reopening and stops after leaving the surface', {tag: '@essential'}, async ({page}) => {
    const status = await mockStatus(page, RUNNING);
    await page.goto('/');
    await openStatus(page);
    await page.locator('#galleryMode').click();
    await openStatus(page);
    await page.locator('#galleryMode').click();
    await openStatus(page);
    expect(status.requests).toBe(3);
    await page.clock.runFor(STATUS_POLL_MS + 100);
    await expect.poll(() => status.requests).toBe(4);
    await page.clock.runFor(STATUS_POLL_MS + 100);
    await expect.poll(() => status.requests).toBe(5);

    await page.locator('#galleryMode').click();
    await expect(page.locator('#gallerySurface')).toBeVisible();
    await page.clock.runFor(STATUS_POLL_MS * 5);
    expect(status.requests).toBe(5);
  });

  test('a failing /api/status shows Статус недоступен and leaves the app working', {tag: '@essential'}, async ({page}) => {
    const status = await mockStatus(page, RUNNING);
    status.code = 500;
    await openAlbum(page);
    await openStatus(page);
    await expect(section(page, 'cache').locator('.gallery-status-line')).toHaveText('Текущий запуск — Статус недоступен');
    await expect(section(page, 'whole-cache').locator('.gallery-status-sub')).toHaveText('Статус недоступен');
    await expect(section(page, 'errors')).toContainText('Ошибок нет');
    await expect(section(page, 'memories').locator('.gallery-status-line')).toHaveText('Статус недоступен');
    await page.clock.runFor(STATUS_POLL_MS * 3);
    expect(status.requests).toBe(1);

    await page.locator('#galleryMode').click();
    await expect(page.locator('#mediaGrid .media-card.image')).toHaveCount(13);
  });

  test('the real server without warm artifacts reports unavailable without a cache block', async ({page}) => {
    const responses = [];
    page.on('response', response => { if (new URL(response.url()).pathname === '/api/status') responses.push(response); });
    await page.goto('/');
    await openStatus(page);
    expect(await responses[0].json()).toMatchObject({version: 1, state: 'unavailable', recentErrors: [], memories: {state: 'unavailable'}});
    await expect(section(page, 'cache').locator('.gallery-status-run .gallery-status-line')).toHaveText('Текущий запуск — Статус недоступен');
    await expect(section(page, 'cache').locator('.gallery-status-run .gallery-status-sub')).toHaveCount(0);
    await expect(section(page, 'whole-cache').locator('.gallery-status-sub')).toHaveText('Статус недоступен');
    await expect(section(page, 'memories').locator('.gallery-status-line')).toHaveText('Статус недоступен');
  });

  test('unavailable memories keep the last known good version; an empty error list says so', async ({page}) => {
    await mockStatus(page, {
      ...READY,
      recentErrors: [],
      memories: {state: 'unavailable', updatedAt: '2026-10-23T01:00:00Z', readyVersion: '0123456789abcdef', readyAt: '2026-10-22T00:06:00Z', periods: 147, memories: 12, shown: 6, errors: 1},
    });
    await page.goto('/');
    await openStatus(page);
    await expect(section(page, 'cache').locator('.gallery-status-run .gallery-status-line')).toHaveText('Текущий запуск — Готово');
    await expect(section(page, 'errors').locator('li')).toHaveCount(0);
    await expect(section(page, 'errors')).toContainText('Ошибок нет');
    const memories = section(page, 'memories');
    await expect(memories.locator('.gallery-status-line')).toHaveText('Статус недоступен');
    await expect(memories.locator('.gallery-status-sub')).toHaveText('Последняя готовая версия: вчера в 03:06');
    await expect(metrics(memories)).toHaveText(['147 периодов', '12 воспоминаний', '6 показано', '1 ошибка']);
  });

  test('absolute NAS paths are never shown', async ({page}) => {
    await mockStatus(page, {
      ...RUNNING,
      recentErrors: [
        ...RUNNING.recentErrors,
        {at: '2026-10-23T07:03:00Z', operation: 'thumbnail', path: '/volume1/photo/secret.jpg', error: 'open: permission denied'},
        {at: '2026-10-23T07:04:00Z', operation: 'walk', path: '../escape.jpg', error: 'open: permission denied'},
      ],
    });
    await page.goto('/');
    await openStatus(page);
    await expect(section(page, 'errors').locator('.gallery-status-path')).toHaveText(['locked', '2024/Лето/broken.jpg']);
    await expect(surface(page)).not.toContainText('/volume1');
    await expect(surface(page)).not.toContainText('escape.jpg');
  });

  test('service errors without a path are listed by a neutral name; unsafe paths stay hidden', {tag: '@essential'}, async ({page}) => {
    const status = await mockStatus(page, {
      ...READY,
      recentErrors: [
        {at: '2026-10-23T07:01:00Z', operation: 'thumbnail', path: '/volume1/photo/secret.jpg', error: 'open: permission denied'},
        {at: '2026-10-23T07:02:00Z', operation: 'date-index', path: '', error: 'write date index: permission denied'},
        {at: '2026-10-23T07:03:00Z', operation: 'memories', path: '', error: 'write memories: permission denied'},
      ],
    });
    await page.goto('/');
    await openStatus(page);
    const errors = section(page, 'errors');
    await expect(errors.locator('.gallery-status-path')).toHaveText(['Сборка воспоминаний', 'Индекс дат']);
    await expect(errors.locator('li .gallery-status-sub')).toHaveText(['write memories: permission denied', 'write date index: permission denied']);
    await expect(errors).not.toContainText('Ошибок нет');
    await expect(errors).not.toContainText('/volume1');
    await expect(errors).not.toContainText(/date-index|memories(?!\S)/);

    // Only unsafe entries left: the safe list is empty.
    status.body = {...READY, recentErrors: [{at: '2026-10-23T07:01:00Z', operation: 'thumbnail', path: '/volume1/photo/secret.jpg', error: 'x'}]};
    await page.locator('#galleryMode').click();
    await openStatus(page);
    await expect(errors.locator('li')).toHaveCount(0);
    await expect(errors).toContainText('Ошибок нет');
  });

  test('returning to the gallery keeps its state without reloading the listing', {tag: '@essential'}, async ({page}, testInfo) => {
    test.skip(!isDesktopBrowserProject(testInfo), 'Desktop density steps');
    await mockStatus(page, RUNNING);
    await openAlbum(page);
    await page.locator('#mediaFilter [data-filter="image"]').click();
    await page.locator('#mediaSort').selectOption('name');
    await clickHeaderControl(page, '#gridDensity [data-density-step="0"]');
    const target = page.getByRole('button', {name: 'Открыть Photo 07.png'});
    await target.evaluate(element => scrollTo({top: element.getBoundingClientRect().top + scrollY - innerHeight / 2, behavior: 'instant'}));
    await target.focus();
    const before = await galleryView(page);
    expect(before.scroll).toBeGreaterThan(200);
    const listings = [];
    page.on('request', request => { if (request.url().includes('/api/list')) listings.push(request.url()); });

    await openStatus(page);
    await page.locator('#galleryMode').click();
    await expect(page.locator('#gallerySurface')).toBeVisible();
    const after = await galleryView(page);
    expect({...after, scroll: 0}).toEqual({...before, scroll: 0});
    expect(Math.abs(after.scroll - before.scroll)).toBeLessThanOrEqual(2);
    expect(listings).toEqual([]);
  });

  test('keyboard and screen reader: the icon opens by Enter, focus lands on the heading, state is announced', {tag: '@essential'}, async ({page}) => {
    await mockStatus(page, RUNNING);
    await page.goto('/');
    const entry = page.getByRole('button', {name: 'Состояние галереи'});
    if (await page.locator('#topbarMore').isVisible()) await page.locator('#topbarMore').click();
    await entry.focus();
    await page.keyboard.press('Enter');
    await expect(surface(page)).toBeVisible();
    await expect(page.getByRole('region', {name: 'Состояние галереи'})).toBeVisible();
    await expect(surface(page).getByRole('heading', {level: 1})).toBeFocused();
    await expect(surface(page).getByRole('status')).toHaveText('Кэш: Выполняется. Воспоминания: Готово.');
    await expect(page.getByRole('region', {name: 'Кэш'})).toBeVisible();
    await expect(page.getByRole('region', {name: 'Воспоминания'})).toBeVisible();
    await expect(page.getByRole('progressbar', {name: 'Прогресс текущего запуска'})).toBeVisible();
    await expect(section(page, 'memories').getByRole('listitem')).toHaveText(['147 периодов', '12 воспоминаний', '6 показано', '0 ошибок']);

    const gallery = page.locator('#galleryMode');
    await gallery.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#gallerySurface')).toBeVisible();
    await expect(surface(page)).toBeHidden();
  });

  test('desktop: errors sit right of the whole cache block, memories span below, metrics are tiles', {tag: '@essential'}, async ({page}) => {
    test.skip(isStacked(page), 'Two-column layout');
    await mockStatus(page, {...RUNNING, recentErrors: MANY_ERRORS});
    await page.goto('/');
    await openStatus(page);

    const [cache, errors, memories] = await boxes([section(page, 'cache'), section(page, 'errors'), section(page, 'memories')]);
    expect(errors.x).toBeGreaterThanOrEqual(cache.x + cache.width);
    expect(Math.abs(errors.y - cache.y)).toBeLessThanOrEqual(1);
    // Twenty errors do not stretch the row: the card ends with the cache block.
    expect(errors.y + errors.height).toBeLessThanOrEqual(cache.y + cache.height + 1);
    expect(memories.y).toBeGreaterThanOrEqual(cache.y + cache.height);
    expect(Math.abs(memories.x - cache.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(memories.x + memories.width - (errors.x + errors.width))).toBeLessThanOrEqual(1);

    // From the focused heading, Tab reaches the error list first.
    await expect(surface(page).getByRole('heading', {level: 1})).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(errorList(page)).toBeFocused();
    await expectErrorsScrollInside(page);

    const run = section(page, 'cache').locator('.gallery-status-run .gallery-status-metrics');
    const whole = section(page, 'whole-cache').locator('.gallery-status-metrics');
    const memoryTiles = section(page, 'memories').locator('.gallery-status-metrics');
    await expectTiles(run, 4);
    await expectTiles(whole, 5);
    await expectTiles(memoryTiles, 4);
    for (const list of [run, whole, memoryTiles]) expect(await tileRows(list)).toBe(1);
  });

  test('phone and tablet: Кэш, Последние ошибки, Воспоминания stack without horizontal overflow', async ({page}) => {
    test.skip(!isStacked(page), 'One-column layout');
    await mockStatus(page, {...RUNNING, recentErrors: MANY_ERRORS});
    await page.goto('/');
    await openStatus(page);

    const [cache, errors, memories] = await boxes([section(page, 'cache'), section(page, 'errors'), section(page, 'memories')]);
    expect(errors.y).toBeGreaterThanOrEqual(cache.y + cache.height);
    expect(memories.y).toBeGreaterThanOrEqual(errors.y + errors.height);
    for (const box of [errors, memories]) {
      expect(Math.abs(box.x - cache.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(box.width - cache.width)).toBeLessThanOrEqual(1);
    }
    const viewport = page.viewportSize();
    expect(errors.height).toBeLessThanOrEqual(Math.min(360, (viewport?.height ?? 0) * 0.6) + 1);
    const overflow = await page.evaluate(() => [document.documentElement, document.querySelector('#statusSurface')]
      .map(element => element.scrollWidth - element.clientWidth));
    expect(Math.max(...overflow)).toBeLessThanOrEqual(0);

    await expectErrorsScrollInside(page);

    const whole = section(page, 'whole-cache').locator('.gallery-status-metrics');
    await expectTiles(section(page, 'cache').locator('.gallery-status-run .gallery-status-metrics'), 4);
    await expectTiles(whole, 5);
    await expectTiles(section(page, 'memories').locator('.gallery-status-metrics'), 4);
    // A phone has no room for five tiles in a row: they wrap.
    if ((viewport?.width ?? 0) <= 700) expect(await tileRows(whole)).toBeGreaterThan(1);
  });

  test('touch: tapping the icon opens the status and tapping Галерея returns', async ({page}, testInfo) => {
    test.skip(!testInfo.project.use.hasTouch, 'Touch viewports');
    await mockStatus(page, RUNNING);
    await page.goto('/');
    if (await page.locator('#topbarMore').isVisible()) await page.locator('#topbarMore').tap();
    await page.locator('#statusMode').tap();
    await expect(surface(page)).toBeVisible();
    await expect(section(page, 'memories').locator('.gallery-status-metrics li')).toHaveText(['147 периодов', '12 воспоминаний', '6 показано', '0 ошибок']);
    const box = await page.locator(await page.locator('#topbarMore').isVisible() ? '#topbarMore' : '#statusMode').boundingBox();
    expect(Math.min(box?.width ?? 0, box?.height ?? 0)).toBeGreaterThanOrEqual(32);
    const overflow = await surface(page).evaluate(element => element.scrollWidth - element.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await page.locator('#galleryMode').tap();
    await expect(page.locator('#gallerySurface')).toBeVisible();
  });
});
