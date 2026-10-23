import {test, expect} from '@playwright/test';
import {clickHeaderControl, editor, galleryView, isDesktopBrowserProject, openAlbum, openCollageLanding, readDownload, saveJsonProject, selectPhotos, startCollage} from './helpers.mjs';

const landing = page => page.locator('#collageSurface');
const createCard = page => page.locator('#collageCreate');
const openCard = page => page.locator('#collageOpenProject');
const landingStatus = page => page.locator('#collageLandingStatus');

// Editor geometry measured on 0d8ea51, before the header changed: the body below
// the header must keep its place and size.
const EDITOR_GEOMETRY = {
  'chromium-desktop': {toolbar: 66, width: 1440, workspace: 889},
  'firefox-desktop': {toolbar: 66, width: 1440, workspace: 889},
  'webkit-desktop': {toolbar: 66, width: 1440, workspace: 889},
  'chromium-tablet': {toolbar: 66, width: 1024, workspace: 734},
  'chromium-mobile': {toolbar: 69, width: 390, workspace: 675},
};

async function saveZipProject(page) {
  await editor(page).locator('[data-save-kind]').selectOption('zip');
  const pending = page.waitForEvent('download');
  await editor(page).locator('[data-command="save-project"]').click();
  await page.locator('[data-save-dialog] [data-command="confirm-save-project"]').click();
  return readDownload(await pending);
}

async function closeCleanEditor(page) {
  await editor(page).locator('[data-command="close"]').click();
  await expect(editor(page)).toBeHidden();
  await expect(landing(page)).toBeVisible();
}

/**
 * Drop files on a target the way a browser does: dragenter, dragover, drop.
 * @returns {Promise<{dragover: boolean, drop: boolean}>} whether each event was cancelled
 */
async function dropFiles(target, files) {
  return target.evaluate((element, payload) => {
    const transfer = new DataTransfer();
    for (const file of payload) transfer.items.add(new File([Uint8Array.from(atob(file.base64), character => character.charCodeAt(0))], file.name, {type: file.type}));
    const fire = type => {
      const event = new DragEvent(type, {bubbles: true, cancelable: true, dataTransfer: transfer});
      element.dispatchEvent(event);
      return event.defaultPrevented;
    };
    fire('dragenter');
    const dragover = fire('dragover');
    return {dragover, drop: fire('drop')};
  }, files.map(file => ({name: file.name, type: file.type, base64: Buffer.from(file.buffer).toString('base64')})));
}

test.describe('collage landing', () => {
  test.beforeEach(async ({}, testInfo) => {
    test.skip(!isDesktopBrowserProject(testInfo) && !testInfo.project.name.startsWith('chromium-'), 'Landing flows run on desktop engines and Chromium touch viewports.');
  });

  test('Коллаж opens the landing without reloading the gallery or entering selection', {tag: '@essential'}, async ({page}) => {
    await openAlbum(page);
    const listings = [];
    page.on('request', request => { if (request.url().includes('/api/list')) listings.push(request.url()); });
    await openCollageLanding(page);

    await expect(page.locator('#gallerySurface')).toBeHidden();
    await expect(page.locator('#collageSelection')).toBeHidden();
    await expect(page.locator('#collageMode')).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('#galleryMode')).not.toHaveAttribute('aria-current', 'page');
    for (const control of ['#breadcrumbs', '#gridDensity', '#tvMode', '#refresh']) await expect(page.locator(control)).toBeHidden();
    await expect(landing(page).getByRole('heading', {name: 'Коллаж'})).toBeVisible();
    await expect(createCard(page)).toContainText('Создать коллаж');
    await expect(openCard(page)).toContainText('Открыть проект');
    await expect(openCard(page)).toContainText('Перетащите сюда файл проекта или нажмите, чтобы выбрать его');
    // The drop target is the card itself: the landing holds exactly two actions and no other drop block.
    await expect(landing(page).locator('button')).toHaveCount(2);
    await expect(landing(page).getByText('Перетащите сюда файл проекта')).toHaveCount(1);
    for (const panel of ['#searchSurface', '#memoriesSurface', '#statusSurface']) await expect(page.locator(panel)).toBeHidden();
    // Entries are routed from the whole header, including the separate status icon;
    // other header controls keep the current surface.
    await expect(page.locator('#statusMode')).toHaveAttribute('data-surface-entry', 'status');
    await clickHeaderControl(page, '#statusMode');
    await expect(page.locator('body')).toHaveAttribute('data-surface', 'status');
    await expect(page.locator('#statusSurface')).toBeVisible();
    await openCollageLanding(page);

    await page.locator('#galleryMode').click();
    await expect(page.locator('#gallerySurface')).toBeVisible();
    await expect(page.locator('#mediaGrid .media-card.image')).toHaveCount(13);
    await clickHeaderControl(page, '#gridDensity [data-density-step="0"]');
    await page.locator('#tvMode').dispatchEvent('click');
    await page.evaluate(() => document.exitFullscreen());
    await expect(page.locator('#viewer')).not.toHaveAttribute('data-tv');
    await page.keyboard.press('Escape');
    await expect(page.locator('#viewer')).toBeHidden();
    await expect(page.locator('body')).toHaveAttribute('data-surface', 'gallery');
    await expect(page.locator('#gallerySurface')).toBeVisible();
    expect(listings).toEqual([]);
  });

  test('Создать коллаж enters the existing selection flow by keyboard, and closing the editor lands on the collage screen', {tag: '@essential'}, async ({page}) => {
    await openAlbum(page);
    await openCollageLanding(page);
    await createCard(page).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#gallerySurface')).toBeVisible();
    await expect(page.locator('#collageSelection')).toBeVisible();
    await expect(page.locator('#galleryMode')).toHaveAttribute('aria-current', 'page');
    await selectPhotos(page, 2);
    const start = page.getByRole('button', {name: 'Сделать коллаж'});
    await start.evaluate(element => element.focus({preventScroll: true}));
    await start.press('Enter');
    await expect(editor(page)).toBeVisible();
    await expect(editor(page).locator('[data-cell-index]')).toHaveCount(2);

    await closeCleanEditor(page);
    await expect(page.locator('#collageMode')).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('#collageSelection')).toBeHidden();
    await expect(createCard(page)).toBeFocused();

    // Back in the gallery the selection is not switched on by itself.
    await page.locator('#galleryMode').click();
    await expect(page.locator('#collageSelection')).toBeHidden();
    await expect(page.getByRole('button', {name: 'Открыть Photo 01.png'})).toBeVisible();
  });

  test('Открыть проект opens the shared file picker, and a broken file reports an error on the landing', {tag: '@essential'}, async ({page}, testInfo) => {
    test.skip(!isDesktopBrowserProject(testInfo), 'Saving a project needs the desktop save controls.');
    await startCollage(page, 2);
    const project = await saveJsonProject(page);
    await closeCleanEditor(page);

    let chooser = page.waitForEvent('filechooser');
    await openCard(page).click();
    await (await chooser).setFiles({name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from('{not json')});
    await expect(landingStatus(page)).toBeVisible();
    await expect(landingStatus(page)).not.toBeEmpty();
    await expect(editor(page)).toBeHidden();

    chooser = page.waitForEvent('filechooser');
    await openCard(page).click();
    await expect(landingStatus(page)).toBeHidden();
    await (await chooser).setFiles({name: 'project.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(project))});
    await expect(editor(page)).toBeVisible();
    await expect(editor(page).locator('[data-toast]')).toContainText('Проект загружен');
    await expect(editor(page).locator('[data-cell-index]')).toHaveCount(2);

    await closeCleanEditor(page);
    await expect(openCard(page)).toBeFocused();
  });

  test('dropping a JSON or ZIP project on the card opens it; other drops do not', {tag: '@essential'}, async ({page}, testInfo) => {
    test.skip(!isDesktopBrowserProject(testInfo), 'Saving a project needs the desktop save controls.');
    await startCollage(page, 2);
    const json = Buffer.from(JSON.stringify(await saveJsonProject(page)));
    const zip = await saveZipProject(page);
    await closeCleanEditor(page);

    // A file dropped beside the card is refused and does not reach the editor or the browser.
    const beside = await dropFiles(landing(page).getByRole('heading', {name: 'Коллаж'}), [{name: 'project.json', type: 'application/json', buffer: json}]);
    expect(beside).toEqual({dragover: true, drop: true});
    await expect(editor(page)).toBeHidden();
    await expect(landingStatus(page)).toBeHidden();

    await dropFiles(openCard(page), [{name: 'photo.png', type: 'image/png', buffer: Buffer.from('png')}]);
    await expect(landingStatus(page)).toHaveText('Файл «photo.png» не является проектом коллажа. Подойдёт файл .json или .zip');
    await dropFiles(openCard(page), [{name: 'a.json', type: 'application/json', buffer: json}, {name: 'b.json', type: 'application/json', buffer: json}]);
    await expect(landingStatus(page)).toHaveText('Перетащите один файл проекта');
    await expect(editor(page)).toBeHidden();

    const dropped = await dropFiles(openCard(page), [{name: 'project.json', type: 'application/json', buffer: json}]);
    expect(dropped).toEqual({dragover: true, drop: true});
    await expect(editor(page)).toBeVisible();
    await expect(editor(page).locator('[data-toast]')).toContainText('Проект загружен');
    await expect(landingStatus(page)).toBeHidden();
    await closeCleanEditor(page);

    await dropFiles(openCard(page), [{name: 'collage.zip', type: 'application/zip', buffer: zip}]);
    await expect(editor(page)).toBeVisible();
    await expect(editor(page).locator('[data-toast]')).toContainText('ZIP-проект загружен · 2 фотографии');
    await closeCleanEditor(page);
    await expect(openCard(page)).toBeFocused();
  });

  test('the landing cards answer to touch', async ({page}, testInfo) => {
    test.skip(!testInfo.project.use.hasTouch, 'Touch viewports only');
    await openAlbum(page);
    await page.locator('#collageMode').tap();
    await expect(landing(page)).toBeVisible();
    const chooser = page.waitForEvent('filechooser');
    await openCard(page).tap();
    await chooser;
    await createCard(page).tap();
    await expect(page.locator('#collageSelection')).toBeVisible();
    await selectPhotos(page, 2);
    await page.getByRole('button', {name: 'Сделать коллаж'}).tap();
    await expect(editor(page)).toBeVisible();
  });

  test('returning to the gallery keeps folder, recursive scope, filter, sort, density, scroll, and focus', {tag: '@essential'}, async ({page}, testInfo) => {
    test.skip(!isDesktopBrowserProject(testInfo), 'Desktop density steps');
    await openAlbum(page);
    await page.locator('#recursiveToggle').click();
    await expect(page.locator('#recursiveToggle')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('#mediaFilter [data-filter="image"]').click();
    await page.locator('#mediaSort').selectOption('name');
    await page.locator('#mediaDirection').click();
    await clickHeaderControl(page, '#gridDensity [data-density-step="0"]');
    const target = page.getByRole('button', {name: 'Открыть Photo 07.png'});
    await target.evaluate(element => scrollTo({top: element.getBoundingClientRect().top + scrollY - innerHeight / 2, behavior: 'instant'}));
    await target.focus();
    const before = await galleryView(page);
    expect(before.scroll).toBeGreaterThan(200);
    expect(before.focus).toBe('Album A/Photo 07.png');

    const listings = [];
    page.on('request', request => { if (request.url().includes('/api/list')) listings.push(request.url()); });
    await openCollageLanding(page);
    await page.locator('#galleryMode').click();
    await expect(page.locator('#gallerySurface')).toBeVisible();
    const after = await galleryView(page);
    expect({...after, scroll: 0}).toEqual({...before, scroll: 0});
    expect(Math.abs(after.scroll - before.scroll)).toBeLessThanOrEqual(2);

    // The create card returns to the same place, with selection switched on.
    await openCollageLanding(page);
    await createCard(page).click();
    await expect(page.locator('#collageSelection')).toBeVisible();
    const selecting = await galleryView(page);
    expect(Math.abs(selecting.scroll - before.scroll)).toBeLessThanOrEqual(2);
    expect(selecting.focus).toBe(before.focus);
    expect(listings).toEqual([]);
  });

  test('editor body below the header keeps its geometry and the header leads back to projects', {tag: '@essential'}, async ({page}, testInfo) => {
    const expected = EDITOR_GEOMETRY[testInfo.project.name];
    await startCollage(page, 2);
    const back = editor(page).locator('[data-command="close"]');
    await expect(back).toHaveAccessibleName('К проектам');
    const rects = await editor(page).evaluate(dialog => Object.fromEntries(['.collage-toolbar', '.collage-templates', '.collage-workspace'].map(selector => {
      const rect = dialog.querySelector(selector).getBoundingClientRect();
      return [selector, {top: Math.round(rect.top), left: Math.round(rect.left), width: Math.round(rect.width), height: Math.round(rect.height)}];
    })));
    expect(rects['.collage-toolbar']).toEqual({top: 0, left: 0, width: expected.width, height: expected.toolbar});
    expect(rects['.collage-templates']).toEqual({top: expected.toolbar, left: 0, width: expected.width, height: 45});
    expect(rects['.collage-workspace']).toEqual({top: expected.toolbar + 45, left: 0, width: expected.width, height: expected.workspace});
  });
});
