import {test, expect} from '@playwright/test';
import {editor, enterSelectionMode, openAlbum, selectPhotos} from './helpers.mjs';

test.beforeEach(async ({page}, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop', 'Deterministic loading-barrier scenarios run once in Chromium desktop.');
});

test('full originals decode sequentially, report N/M, and autofill only after every decode', {tag: '@essential'}, async ({page}) => {
  await prepareSelection(page, 3);
  const selected = photoPaths(3);
  const information = createRouteGates(selected);
  const originals = createRouteGates(selected);
  await installGateRoute(page, /\/api\/image-info\?/, information);
  await installGateRoute(page, /\/api\/media\?/, originals);

  await page.getByRole('button', {name: 'Сделать коллаж'}).click();
  const loading = page.locator('[data-loading-overlay]');
  await expect(editor(page)).toBeVisible();
  await expect(editor(page)).toHaveAttribute('data-ready', 'false');
  await expect(loading).toBeVisible();
  await expect(loading.locator('[data-loading-status]')).toHaveText('Загружаем фотографии · 0 из 3');
  await expect(editor(page).locator('.collage-shell')).toHaveAttribute('inert', '');
  expect(await editor(page).locator('[data-template-id]').first().evaluate(control => control.closest('[inert]') !== null)).toBe(true);
  await expect(editor(page).locator('.collage-cell-hit.is-empty')).toHaveCount(3);

  for (const path of selected) information.get(path).release();
  await originals.get(selected[0]).requested;
  expect(originals.get(selected[1]).wasRequested).toBe(false);
  expect(originals.get(selected[2]).wasRequested).toBe(false);
  originals.get(selected[0]).release();
  await expect(loading.locator('[data-loading-status]')).toHaveText('Загружаем фотографии · 1 из 3');
  await expect(editor(page).locator('.collage-cell-hit.is-empty')).toHaveCount(3);
  await originals.get(selected[1]).requested;
  expect(originals.get(selected[2]).wasRequested).toBe(false);
  originals.get(selected[1]).release();
  await expect(loading.locator('[data-loading-status]')).toHaveText('Загружаем фотографии · 2 из 3');
  await expect(editor(page).locator('.collage-cell-hit.is-empty')).toHaveCount(3);

  await originals.get(selected[2]).requested;
  originals.get(selected[2]).release();
  await expect(editor(page)).toHaveAttribute('data-ready', 'true');
  await expect(loading).toBeHidden();
  await expect(editor(page).locator('.collage-shell')).not.toHaveAttribute('inert', '');
  await expect(editor(page).locator('.collage-cell-hit.is-empty')).toHaveCount(0);
  await expect(editor(page).locator('[data-history-count]')).toHaveText('0 из 20');
  await expect(editor(page).locator('[data-print-format]')).toHaveValue('13x18');
  await expect(editor(page).locator('[data-quality-summary]')).toContainText(/13 × 18 см/);
  await expect(page.locator('[data-preview-busy]')).toBeHidden();
  await expect(page.locator('[data-preview-error]')).toBeHidden();
});

test('broken original names the file, keeps canvas uncommitted, and Retry recovers', async ({page}) => {
  await prepareSelection(page, 3);
  const brokenPath = 'Album A/Photo 03.png';
  let broken = true;
  let attempts = 0;
  await page.route(/\/api\/media\?/, async route => {
    const path = requestPath(route);
    if (path !== brokenPath) return route.continue();
    attempts += 1;
    if (broken) return route.fulfill({status: 503, contentType: 'text/plain', body: 'synthetic broken original'});
    return route.continue();
  });

  await page.getByRole('button', {name: 'Сделать коллаж'}).click();
  const loading = page.locator('[data-loading-overlay]');
  const failure = loading.locator('[data-loading-path]').filter({hasText: 'Photo 03.png'});
  await expect(editor(page)).toHaveAttribute('data-ready', 'false');
  await expect(failure.locator('[data-loading-name]')).toHaveText('Photo 03.png');
  await expect(failure.locator('[data-loading-retry]')).toHaveText('Повторить');
  await expect(failure.locator('[data-loading-remove]')).toHaveText('Убрать');
  await expect(editor(page).locator('.collage-cell-hit.is-empty')).toHaveCount(3);
  await expect(editor(page).locator('[data-preview-error]')).toBeHidden();
  const canvasBeforeRetry = await editor(page).locator('[data-preview]').evaluate(canvas => canvas.toDataURL('image/png'));

  broken = false;
  await failure.locator('[data-loading-retry]').click();
  await expect.poll(() => attempts).toBeGreaterThanOrEqual(2);
  await expect(editor(page)).toHaveAttribute('data-ready', 'true');
  await expect(loading).toBeHidden();
  await expect(editor(page).locator('.collage-cell-hit.is-empty')).toHaveCount(0);
  await expect(page.locator('[data-preview-busy]')).toBeHidden();
  const canvasAfterRetry = await editor(page).locator('[data-preview]').evaluate(canvas => canvas.toDataURL('image/png'));
  expect(canvasAfterRetry).not.toBe(canvasBeforeRetry);
});

test('removing one broken original continues when at least two photos remain', async ({page}) => {
  await prepareSelection(page, 3);
  const brokenPath = 'Album A/Photo 03.png';
  await page.route(/\/api\/media\?/, route => requestPath(route) === brokenPath
    ? route.fulfill({status: 503, contentType: 'text/plain', body: 'synthetic broken original'})
    : route.continue());

  await page.getByRole('button', {name: 'Сделать коллаж'}).click();
  const loading = page.locator('[data-loading-overlay]');
  const failure = loading.locator('[data-loading-path]').filter({hasText: 'Photo 03.png'});
  await expect(failure).toBeVisible();
  await failure.locator('[data-loading-remove]').click();

  await expect(editor(page)).toHaveAttribute('data-ready', 'true');
  await expect(loading).toBeHidden();
  await expect(editor(page).locator('[data-photo-count]')).toHaveText('2');
  await expect(editor(page).locator('[data-cell-index]')).toHaveCount(2);
  await expect(editor(page).locator('.collage-cell-hit.is-empty')).toHaveCount(0);
  await expect(editor(page).locator('.collage-session-photo')).toHaveCount(2);
  await expect(editor(page).locator('.collage-session-photo').filter({hasText: 'Photo 03.png'})).toHaveCount(0);
  await expect(editor(page).locator('[data-print-format]')).toHaveValue('13x18');
});

async function prepareSelection(page, count) {
  await openAlbum(page);
  await enterSelectionMode(page);
  await selectPhotos(page, count);
}

function photoPaths(count) {
  return Array.from({length: count}, (_, index) => `Album A/Photo ${String(index + 1).padStart(2, '0')}.png`);
}

function deferredGate() {
  let release;
  let markRequested;
  let wasRequested = false;
  const promise = new Promise(resolve => { release = resolve; });
  const requested = new Promise(resolve => {
    markRequested = () => {
      wasRequested = true;
      resolve();
    };
  });
  return {promise, requested, release, markRequested, get wasRequested() { return wasRequested; }};
}

function createRouteGates(paths) {
  return new Map(paths.map(path => [path, deferredGate()]));
}

async function installGateRoute(page, pattern, gates) {
  await page.route(pattern, async route => {
    const gate = gates.get(requestPath(route));
    if (!gate) return route.continue();
    gate.markRequested();
    await gate.promise;
    return route.continue();
  });
}

function requestPath(route) {
  return new URL(route.request().url()).searchParams.get('path');
}
