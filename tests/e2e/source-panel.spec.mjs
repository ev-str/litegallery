import {test, expect} from '@playwright/test';
import {editor, isDesktopBrowserProject, saveJsonProject, startCollage} from './helpers.mjs';

const sourceId = path => `source:${encodeURIComponent(path)}`;
const sessionPhoto = (page, path) => editor(page).locator(`[data-session-source-id="${sourceId(path)}"]`);

test.beforeEach(async ({page}, testInfo) => {
  test.skip(!isDesktopBrowserProject(testInfo), 'Source-panel flows run once per browser engine at desktop size.');
});

test('latest folder activation wins when an older directory request finishes later', async ({page}) => {
  await page.route('**/api/list?**', async route => {
    const path = new URL(route.request().url()).searchParams.get('path');
    if (path === 'Album A') await new Promise(resolve => setTimeout(resolve, 300));
    await route.continue();
  });
  await startCollage(page, 2);

  const panel = editor(page);
  await expect(panel.getByRole('checkbox')).toHaveCount(0);
  await panel.locator('summary').filter({hasText: 'Album A'}).click();
  await panel.locator('summary').filter({hasText: 'Album B'}).click();

  await expect(panel.locator('[data-gallery-folder]')).toHaveText('Album B');
  await expect(panel.locator('summary[aria-current="true"]')).toHaveText('Album B');
  await expect(panel.locator('[data-source-path]')).toHaveCount(4);
  await expect(panel.locator('[data-source-path^="Album B/"]')).toHaveCount(4);
  await page.waitForTimeout(350);
  await expect(panel.locator('[data-gallery-folder]')).toHaveText('Album B');
  await expect(panel.locator('[data-source-path^="Album B/"]')).toHaveCount(4);
});

test('gallery and session accordions preserve 75/25 layout, state, and never both collapse', async ({page}) => {
  await startCollage(page, 2);
  const panel = editor(page);
  const sourceRail = panel.locator('.collage-sources-panel');
  const gallery = panel.locator('[data-source-accordion="gallery"]');
  const session = panel.locator('[data-source-accordion="session"]');
  const galleryToggle = panel.locator('[data-source-accordion-toggle="gallery"]');
  const sessionToggle = panel.locator('[data-source-accordion-toggle="session"]');

  await expect(galleryToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(sessionToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(panel.locator('#collage-gallery-content')).toBeVisible();
  await expect(panel.locator('#collage-session-content')).toBeVisible();
  const initial = await panel.evaluate(() => {
    const box = selector => document.querySelector(selector).getBoundingClientRect();
    const rail = box('.collage-sources-panel');
    const gallery = box('[data-source-accordion="gallery"]');
    const session = box('[data-source-accordion="session"]');
    return {
      rail: rail.height,
      gallery: gallery.height,
      session: session.height,
      galleryGrow: getComputedStyle(document.querySelector('[data-source-accordion="gallery"]')).flexGrow,
      sessionGrow: getComputedStyle(document.querySelector('[data-source-accordion="session"]')).flexGrow,
    };
  });
  expect(initial.galleryGrow).toBe('3');
  expect(initial.sessionGrow).toBe('1');
  expect(initial.gallery / initial.session).toBeGreaterThan(2);
  expect(initial.gallery / initial.session).toBeLessThan(3.5);

  await panel.locator('summary').filter({hasText: 'Album B'}).click();
  await expect(panel.locator('[data-gallery-folder]')).toHaveText('Album B');
  const sessionCount = await panel.locator('[data-session-count]').textContent();

  await galleryToggle.click();
  await expect(galleryToggle).toHaveAttribute('aria-expanded', 'false');
  await expect(panel.locator('#collage-gallery-content')).toBeHidden();
  await expect(sessionToggle).toBeDisabled();
  const sessionOnly = await session.boundingBox();
  const railBox = await sourceRail.boundingBox();
  expect(sessionOnly.height).toBeGreaterThan(railBox.height * .8);
  await sessionToggle.click({force: true});
  await expect(sessionToggle).toHaveAttribute('aria-expanded', 'true');

  await galleryToggle.click();
  await expect(galleryToggle).toHaveAttribute('aria-expanded', 'true');
  await sessionToggle.click();
  await expect(sessionToggle).toHaveAttribute('aria-expanded', 'false');
  await expect(panel.locator('#collage-session-content')).toBeHidden();
  await expect(galleryToggle).toBeDisabled();
  const galleryOnly = await gallery.boundingBox();
  expect(galleryOnly.height).toBeGreaterThan(railBox.height * .8);
  await galleryToggle.click({force: true});
  await expect(galleryToggle).toHaveAttribute('aria-expanded', 'true');

  await sessionToggle.click();
  await expect(sessionToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(panel.locator('[data-gallery-folder]')).toHaveText('Album B');
  await expect(panel.locator('[data-session-count]')).toHaveText(sessionCount || '2');
  const restored = await panel.evaluate(() => {
    const gallery = document.querySelector('[data-source-accordion="gallery"]').getBoundingClientRect();
    const session = document.querySelector('[data-source-accordion="session"]').getBoundingClientRect();
    return gallery.height / session.height;
  });
  expect(restored).toBeGreaterThan(2);
  expect(restored).toBeLessThan(3.5);

  const document = await saveJsonProject(page);
  const serialized = JSON.stringify(document);
  expect(serialized).not.toMatch(/accordion|galleryPanelOpen|sessionPanelOpen|collapsed/i);
});

test('session tray keeps unique tried sources, counts placements, cycles cells, and rearms unused photos', async ({page}) => {
  await startCollage(page, 2);
  const panel = editor(page);
  const first = sessionPhoto(page, 'Album A/Photo 01.png');

  await expect(panel.locator('[data-session-count]')).toHaveText('2');
  await expect(panel.locator('[data-session-source-id]')).toHaveCount(2);
  await panel.locator('[data-count="1"]').click();
  await first.click();
  await panel.getByRole('button', {name: 'Пустая ячейка 3'}).click();
  await expect(first.locator('.collage-session-usage')).toHaveText('×2');
  await expect(panel.locator('[data-session-count]')).toHaveText('2');

  await first.click();
  await expect(panel.locator('[data-cell-index="0"]')).toHaveClass(/is-selected/);
  await first.click();
  await expect(panel.locator('[data-cell-index="2"]')).toHaveClass(/is-selected/);

  await panel.locator('[data-command="remove"]').click();
  await expect(first).toBeVisible();
  await expect(first.locator('.collage-session-usage')).toHaveCount(0);
  await first.click();
  await expect(panel.locator('[data-cell-index="0"]')).toHaveClass(/is-selected/);
  await panel.locator('[data-command="remove"]').click();
  await expect(first).toBeVisible();
  await expect(panel.locator('[data-session-count]')).toHaveText('2');

  await first.click();
  await panel.getByRole('button', {name: 'Пустая ячейка 1'}).click();
  await expect(panel.locator('[data-cell-index="0"]')).not.toHaveClass(/is-empty/);
  await expect(first).toBeVisible();
});

test('save, size estimate, ZIP originals, and project load ignore unused tray photos', async ({page}) => {
  await startCollage(page, 2);
  const panel = editor(page);
  const zipOption = panel.locator('[data-save-kind] option[value="zip"]');
  const beforeSize = await zipOption.textContent();

  await panel.locator('summary').filter({hasText: 'Album B'}).click();
  await expect(panel.locator('[data-gallery-folder]')).toHaveText('Album B');
  await panel.locator('[data-source-path="Album B/Photo 01.png"]').click();
  await expect(panel.locator('[data-session-count]')).toHaveText('3');
  await expect(zipOption).toHaveText(beforeSize || '');

  const document = await saveJsonProject(page);
  expect(Object.keys(document.project.sources).sort()).toEqual([
    sourceId('Album A/Photo 01.png'),
    sourceId('Album A/Photo 02.png'),
  ].sort());
  expect(new Set(Object.values(document.project.placements).map(placement => placement.sourceId))).toEqual(
    new Set(Object.keys(document.project.sources)),
  );

  const requestedOriginals = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname === '/api/media') requestedOriginals.push(url.searchParams.get('path'));
  });
  await panel.locator('[data-save-kind]').selectOption('zip');
  const pendingZip = page.waitForEvent('download');
  await panel.locator('[data-command="save-project"]').click();
  await page.locator('[data-save-dialog] [data-command="confirm-save-project"]').click();
  await pendingZip;
  expect(requestedOriginals.sort()).toEqual([
    'Album A/Photo 01.png',
    'Album A/Photo 02.png',
  ]);

  await page.locator('#collageProjectInput').setInputFiles({
    name: 'project.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(document)),
  });
  await expect(panel.locator('[data-toast]')).toContainText('Проект загружен');
  await expect(panel.locator('[data-session-count]')).toHaveText('2');
  await expect(panel.locator('[data-session-source-id]')).toHaveCount(2);
  await expect(sessionPhoto(page, 'Album B/Photo 01.png')).toHaveCount(0);
});
