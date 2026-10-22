import {test, expect} from '@playwright/test';
import {isDesktopBrowserProject, openAlbum, readDownload} from './helpers.mjs';
import {fitScale, MAX_SCALE, ZOOM_STEP} from '../../web/viewer-transform.js';

test.beforeEach(async ({page}, testInfo) => {
  test.skip(!isDesktopBrowserProject(testInfo), 'Viewer flows run once per desktop browser engine.');
  await page.clock.install();
});

// Reach a control with real Tab presses. Safari's Tab skips buttons by default,
// so WebKit falls back to focus after a key press, which it treats as keyboard
// focus; Chromium and Firefox take the Tab path.
async function focusWithKeyboard(page, locator) {
  for (let step = 0; step < 12; step += 1) {
    if (await locator.evaluate(element => element === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  await page.keyboard.press('ArrowDown');
  await locator.focus();
}

async function openFirstPhoto(page) {
  await openAlbum(page);
  await page.locator('#mediaGrid .media-card.image').first().click();
  const viewer = page.locator('#viewer');
  await expect(viewer).toBeVisible();
  await expect(viewer.locator('.stage img')).toBeVisible();
  return viewer;
}

test('viewer navigates with icons and keys, and runs a slideshow', {tag: '@essential'}, async ({page}) => {
  const viewer = await openFirstPhoto(page);
  const caption = viewer.locator('.caption');
  await expect(caption).toContainText('· 1/13');
  await expect(viewer.locator('.close use')).toHaveAttribute('href', '#icon-x');
  await expect(viewer.locator('.next use')).toHaveAttribute('href', '#icon-chevron-right');

  await page.keyboard.press('ArrowRight');
  await expect(caption).toContainText('· 2/13');
  await viewer.getByRole('button', {name: 'Предыдущее'}).click();
  await expect(caption).toContainText('· 1/13');

  const slideshow = viewer.locator('.slideshow');
  await expect(slideshow).toHaveText('Слайд-шоу');
  await slideshow.click();
  await expect(slideshow).toHaveText('Стоп');
  await expect(slideshow).toHaveAttribute('aria-pressed', 'true');
  await expect(slideshow.locator('use')).toHaveAttribute('href', '#icon-pause');
  await page.clock.runFor(5_100);
  await expect(caption).toContainText('· 2/13');
  await slideshow.click();
  await expect(slideshow).toHaveText('Слайд-шоу');

  await page.keyboard.press('Escape');
  await expect(viewer).toBeHidden();
});

test('viewer controls hide after inactivity and return on input', async ({page}) => {
  const viewer = await openFirstPhoto(page);
  const close = viewer.getByRole('button', {name: 'Закрыть', exact: true});
  await page.mouse.move(700, 500);
  await expect(viewer).toHaveAttribute('data-idle', 'false');

  await page.clock.runFor(3_000);
  await expect(viewer).toHaveAttribute('data-idle', 'true');
  await expect(close).toHaveCSS('opacity', '0');

  await page.mouse.move(720, 520);
  await expect(viewer).toHaveAttribute('data-idle', 'false');
  await page.clock.runFor(3_000);
  await expect(viewer).toHaveAttribute('data-idle', 'true');
  await page.keyboard.press('ArrowRight');
  await expect(viewer).toHaveAttribute('data-idle', 'false');
});

test('the keyboard-focused control stays visible while other controls hide', async ({page}) => {
  const viewer = await openFirstPhoto(page);
  const next = viewer.getByRole('button', {name: 'Следующее'});
  const close = viewer.getByRole('button', {name: 'Закрыть', exact: true});
  const slideshow = viewer.locator('.slideshow');

  await focusWithKeyboard(page, next);
  await expect(next).toBeFocused();
  await expect(next).toHaveCSS('outline-style', 'solid');
  await page.clock.runFor(3_000);
  await expect(viewer).toHaveAttribute('data-idle', 'true');
  await expect(next).toHaveCSS('opacity', '1');
  await expect(close).toHaveCSS('opacity', '0');

  await focusWithKeyboard(page, slideshow);
  await expect(slideshow).toBeFocused();
  await page.clock.runFor(3_000);
  await expect(viewer).toHaveAttribute('data-idle', 'true');
  await expect(viewer.locator('footer')).toHaveCSS('opacity', '1');
  await expect(next).toHaveCSS('opacity', '0');
});

test('viewer controls stay visible while EXIF details are open', async ({page}) => {
  const viewer = await openFirstPhoto(page);
  await viewer.getByRole('button', {name: 'Информация о фотографии'}).click();
  await expect(viewer.locator('.exif-panel')).toBeVisible();
  await page.mouse.move(700, 500);
  await page.clock.runFor(6_000);
  await expect(viewer).toHaveAttribute('data-idle', 'false');

  await viewer.getByRole('button', {name: 'Закрыть информацию'}).click();
  await expect(viewer.locator('.exif-panel')).toBeHidden();
  await page.mouse.move(710, 510);
  await page.clock.runFor(3_000);
  await expect(viewer).toHaveAttribute('data-idle', 'true');
});

// Fixture photos: Album A holds 640×900 portrait PNGs, Album C/Orientation 1.jpg is 160×120 landscape.
const PORTRAIT = {width: 640, height: 900};

/** Photo, stage, and stage content-box rectangles plus the viewer's view state. */
function photoBox(viewer) {
  return viewer.locator('.stage').evaluate(stage => {
    const style = getComputedStyle(stage);
    const outer = stage.getBoundingClientRect();
    const image = stage.querySelector('img').getBoundingClientRect();
    const rect = ({left, top, right, bottom, width, height}) => ({left, top, right, bottom, width, height});
    const content = {
      left: outer.left + parseFloat(style.paddingLeft),
      right: outer.right - parseFloat(style.paddingRight),
      top: outer.top + parseFloat(style.paddingTop),
      bottom: outer.bottom - parseFloat(style.paddingBottom),
    };
    return {
      stage: rect(outer),
      content: {...content, width: content.right - content.left, height: content.bottom - content.top},
      photo: rect(image),
      view: stage.dataset.view,
      rotation: stage.dataset.rotation,
    };
  });
}

/** Fit: nothing is cropped and the photo meets the content box on one axis. */
function expectFitted(box) {
  const {photo, content} = box;
  expect(box.view).toBe('fit');
  expect(photo.left).toBeGreaterThanOrEqual(content.left - 1);
  expect(photo.right).toBeLessThanOrEqual(content.right + 1);
  expect(photo.top).toBeGreaterThanOrEqual(content.top - 1);
  expect(photo.bottom).toBeLessThanOrEqual(content.bottom + 1);
  const fillsWidth = Math.abs(photo.width - content.width) <= 1;
  const fillsHeight = Math.abs(photo.height - content.height) <= 1;
  expect(fillsWidth || fillsHeight).toBe(true);
}

const frameOf = (box, image) => ({image, fit: box.content, stage: box.stage});

async function openPhoto(page, path) {
  await page.emulateMedia({reducedMotion: 'reduce'});
  const folder = path.split('/').slice(0, -1).join('/');
  await page.goto(`/?path=${encodeURIComponent(folder)}`);
  await page.locator(`#mediaGrid .media-card[data-path="${path}"]`).click();
  const viewer = page.locator('#viewer');
  await expect(viewer.locator('.stage')).toHaveAttribute('data-photo', 'ready');
  return viewer;
}

/** Non-GET requests would mean the viewer tried to change something on the server. */
function trackWrites(page) {
  const writes = [];
  page.on('request', request => { if (request.method() !== 'GET') writes.push(`${request.method()} ${request.url()}`); });
  return writes;
}

test('portrait and landscape photos open in Fit without cropping and refit on resize', {tag: '@essential'}, async ({page}) => {
  let viewer = await openPhoto(page, 'Album A/Photo 01.png');
  expectFitted(await photoBox(viewer));
  await expect(viewer.locator('.fit')).toHaveAttribute('aria-pressed', 'true');

  await page.setViewportSize({width: 900, height: 1100});
  await expect.poll(async () => (await photoBox(viewer)).photo.width).toBeLessThan(900);
  expectFitted(await photoBox(viewer));
  await page.keyboard.press('Escape');

  await page.setViewportSize({width: 1440, height: 1000});
  viewer = await openPhoto(page, 'Album C/Orientation 1.jpg');
  const box = await photoBox(viewer);
  expectFitted(box);
  expect(box.photo.width / box.photo.height).toBeCloseTo(160 / 120, 2);
});

test('zoom buttons, keys, and the wheel stay in range and keep the cursor point', {tag: '@essential'}, async ({page}) => {
  const viewer = await openPhoto(page, 'Album A/Photo 01.png');
  const zoomIn = viewer.getByRole('button', {name: 'Увеличить'});
  const zoomOut = viewer.getByRole('button', {name: 'Уменьшить'});
  const level = viewer.locator('.zoom-level');
  const captionText = await viewer.locator('.caption').textContent();
  const fit = fitScale(frameOf(await photoBox(viewer), PORTRAIT), 0);
  await expect(level).toHaveText(`${Math.round(fit * 100)}%`);

  await zoomIn.click();
  await expect(viewer.locator('.stage')).toHaveAttribute('data-view', 'zoom');
  await viewer.getByRole('button', {name: 'Исходный размер'}).click();
  await expect(viewer.locator('.original')).toHaveAttribute('aria-pressed', 'true');
  let box = await photoBox(viewer);
  expect(box.photo.width).toBeCloseTo(PORTRAIT.width, 0);
  expect(box.photo.height).toBeCloseTo(PORTRAIT.height, 0);
  await viewer.getByRole('button', {name: 'Вписать в экран'}).click();
  expectFitted(await photoBox(viewer));

  // A clicked button keeps focus and its own keys; shortcuts go to the dialog surface.
  await viewer.evaluate(dialog => dialog.focus());
  for (let step = 0; step < 14; step += 1) await page.keyboard.press('+');
  await expect(level).toHaveText(`${MAX_SCALE * 100}%`);
  await expect(zoomIn).toHaveAttribute('aria-disabled', 'true');
  for (let step = 0; step < 20; step += 1) await page.keyboard.press('-');
  // A photo smaller than the stage may shrink to 1:1 but never below.
  await expect(level).toHaveText(`${Math.round(Math.min(fit, 1) * 100)}%`);
  await expect(zoomOut).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('0');
  expectFitted(await photoBox(viewer));

  const point = {x: 780, y: 450};
  const share = ({photo}) => [(point.x - photo.left) / photo.width, (point.y - photo.top) / photo.height];
  const before = share(await photoBox(viewer));
  await page.mouse.move(point.x, point.y);
  await page.mouse.wheel(0, -500);
  // The browser may deliver one wheel step as several events.
  await expect.poll(async () => (await photoBox(viewer)).photo.width).toBeGreaterThan(PORTRAIT.width * fit * 1.5);
  await expect(viewer.locator('.stage')).toHaveAttribute('data-view', 'zoom');
  box = await photoBox(viewer);
  const after = share(box);
  expect(after[0]).toBeCloseTo(before[0], 2);
  expect(after[1]).toBeCloseTo(before[1], 2);
  await expect(viewer.locator('.caption')).toHaveText(captionText ?? '');
});

test('dragging a zoomed photo pans within bounds and never switches photos', {tag: '@essential'}, async ({page}) => {
  const viewer = await openPhoto(page, 'Album A/Photo 01.png');
  const caption = viewer.locator('.caption');
  const captionText = await caption.textContent();
  const stage = viewer.locator('.stage');

  const point = {x: 720, y: 300};
  const before = await photoBox(viewer);
  await page.mouse.dblclick(point.x, point.y);
  await expect(stage).toHaveAttribute('data-view', 'zoom');
  await expect(stage).toHaveAttribute('data-pannable', 'true');
  const zoomed = await photoBox(viewer);
  expect(zoomed.photo.height).toBeGreaterThan(zoomed.stage.height);
  expect((point.y - zoomed.photo.top) / zoomed.photo.height).toBeCloseTo((point.y - before.photo.top) / before.photo.height, 2);

  // Drags stay inside the viewport; Firefox drops pointer moves outside it.
  const drag = async (from, to) => {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, {steps: 4});
    await page.mouse.move(to.x, to.y, {steps: 4});
    await page.mouse.up();
  };
  for (let step = 0; step < 3; step += 1) await drag({x: 820, y: 120}, {x: 520, y: 900});
  let box = await photoBox(viewer);
  expect(box.photo.top).toBeCloseTo(box.stage.top, 0);
  // Narrower than the stage, so it stays centred horizontally.
  expect((box.photo.left + box.photo.right) / 2).toBeCloseTo((box.stage.left + box.stage.right) / 2, 0);
  for (let step = 0; step < 4; step += 1) await drag({x: 520, y: 900}, {x: 820, y: 120});
  box = await photoBox(viewer);
  expect(box.photo.bottom).toBeCloseTo(box.stage.bottom, 0);
  // A sideways drag on the zoomed photo would be a swipe in Fit; here it only pans.
  await drag({x: 1000, y: 500}, {x: 500, y: 520});
  await expect(stage).toHaveAttribute('data-view', 'zoom');
  await expect(caption).toHaveText(captionText ?? '');

  await page.mouse.dblclick(720, 500);
  expectFitted(await photoBox(viewer));
  // In Fit the same drag is a swipe again.
  await drag({x: 900, y: 500}, {x: 600, y: 500});
  await expect(caption).not.toHaveText(captionText ?? '');
});

test('rotation is display-only, refits, and R rotates right', {tag: '@essential'}, async ({page}) => {
  const writes = trackWrites(page);
  const viewer = await openPhoto(page, 'Album A/Photo 01.png');
  const stage = viewer.locator('.stage');
  const src = await stage.locator('img').getAttribute('src');

  await viewer.getByRole('button', {name: 'Повернуть вправо'}).click();
  await expect(stage).toHaveAttribute('data-rotation', '90');
  let box = await photoBox(viewer);
  expectFitted(box);
  expect(box.photo.width / box.photo.height).toBeCloseTo(PORTRAIT.height / PORTRAIT.width, 2);
  expect(box.photo.width).toBeCloseTo(PORTRAIT.height * fitScale(frameOf(box, PORTRAIT), 90), 0);
  await viewer.evaluate(dialog => dialog.focus());

  await page.keyboard.press('r');
  await expect(stage).toHaveAttribute('data-rotation', '180');
  await page.keyboard.press('Shift+R');
  await expect(stage).toHaveAttribute('data-rotation', '90');
  await viewer.getByRole('button', {name: 'Повернуть влево'}).click();
  await expect(stage).toHaveAttribute('data-rotation', '0');
  box = await photoBox(viewer);
  expectFitted(box);
  expect(box.photo.width / box.photo.height).toBeCloseTo(PORTRAIT.width / PORTRAIT.height, 2);

  await viewer.evaluate(dialog => dialog.focus());
  await page.keyboard.press('1');
  await page.keyboard.press('r');
  await expect(stage).toHaveAttribute('data-view', 'original');
  box = await photoBox(viewer);
  expect(box.photo.width).toBeCloseTo(PORTRAIT.height, 0);
  await expect(stage.locator('img')).toHaveAttribute('src', src ?? '');
  expect(writes).toEqual([]);
});

test('Previous and Next after zoom and rotation open the next photo in Fit', {tag: '@essential'}, async ({page}) => {
  const viewer = await openPhoto(page, 'Album A/Photo 01.png');
  const stage = viewer.locator('.stage');
  const caption = viewer.locator('.caption');
  await page.keyboard.press('+');
  await page.keyboard.press('+');
  await page.keyboard.press('r');
  await expect(stage).toHaveAttribute('data-rotation', '90');

  const opened = await caption.textContent();
  await page.keyboard.press('ArrowRight');
  await expect(caption).not.toHaveText(opened ?? '');
  await expect(stage).toHaveAttribute('data-photo', 'ready');
  await expect(stage).toHaveAttribute('data-rotation', '0');
  expectFitted(await photoBox(viewer));

  await viewer.getByRole('button', {name: 'Исходный размер'}).click();
  await viewer.getByRole('button', {name: 'Предыдущее'}).click();
  await expect(caption).toHaveText(opened ?? '');
  await expect(stage).toHaveAttribute('data-photo', 'ready');
  expectFitted(await photoBox(viewer));
  await expect(viewer.locator('.zoom-out')).toHaveAttribute('aria-disabled', 'false');
});

test('the download button saves the original file, not a thumbnail', {tag: '@essential'}, async ({page}) => {
  const writes = trackWrites(page);
  const viewer = await openPhoto(page, 'Album A/Photo 01.png');
  const pending = page.waitForEvent('download');
  await viewer.getByRole('link', {name: 'Скачать оригинал'}).click();
  const download = await pending;
  expect(download.suggestedFilename()).toBe('Photo 01.png');
  expect(new URL(download.url()).pathname).toBe('/api/media');
  const bytes = await readDownload(download);
  const original = await (await page.request.get(`/api/media?path=${encodeURIComponent('Album A/Photo 01.png')}`)).body();
  expect(bytes.equals(original)).toBe(true);
  // PNG IHDR: full 640×900 pixels.
  expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([PORTRAIT.width, PORTRAIT.height]);
  await expect(viewer).toBeVisible();
  expect(writes).toEqual([]);
});

/** A folder with one real photo followed by a stub video; opens the video in the viewer. */
async function openMixedVideo(page) {
  const sortTime = Date.UTC(2026, 0, 15, 12) / 1000;
  const photo = {name: 'Photo 01.png', path: 'Album A/Photo 01.png', kind: 'image', size: 1000, modTime: '2026-01-15T12:00:00Z', sortTime};
  const clip = {name: 'Clip.mp4', path: 'Mixed/Clip.mp4', kind: 'video', size: 5_000_000, modTime: '2026-01-15T12:00:00Z', sortTime: sortTime - 60};
  await page.route(url => url.pathname === '/api/list' && url.searchParams.get('path') === 'Mixed', route => route.fulfill({json: {path: 'Mixed', title: 'E2E Gallery', entries: [photo, clip]}}));
  await page.route(url => url.pathname === '/api/media' && url.searchParams.get('path') === clip.path, route => route.fulfill({contentType: 'video/mp4', body: Buffer.alloc(0)}));
  await page.route('**/api/video-poster?**', route => route.fulfill({status: 404}));
  await page.goto('/?path=Mixed');
  await page.locator('#mediaGrid .media-card.video').click();
  return clip;
}

test('videos keep native controls and hide the photo tools', {tag: '@essential'}, async ({page}) => {
  const clip = await openMixedVideo(page);

  const viewer = page.locator('#viewer');
  const stage = viewer.locator('.stage');
  await expect(stage.locator('video')).toHaveAttribute('controls', '');
  await expect(stage).toHaveAttribute('data-kind', 'video');
  await expect(viewer.locator('.photo-tools')).toBeHidden();
  await expect(viewer.getByRole('button', {name: 'Информация о фотографии'})).toBeHidden();
  const download = viewer.getByRole('link', {name: 'Скачать оригинал'});
  await expect(download).toBeVisible();
  expect(new URL(await download.getAttribute('href') ?? '', page.url()).searchParams.get('path')).toBe(clip.path);
  await expect(stage.locator('video')).toHaveCSS('object-fit', 'contain');
  await page.keyboard.press('+');
  await page.keyboard.press('r');
  await expect(stage).toHaveAttribute('data-rotation', '0');

  await page.keyboard.press('ArrowLeft');
  await expect(viewer.locator('.caption')).toContainText('Photo 01.png');
  await expect(stage).toHaveAttribute('data-photo', 'ready');
  await expect(viewer.locator('.photo-tools')).toBeVisible();
});

test('closing after zoom and rotation returns focus to the opened tile', {tag: '@essential'}, async ({page}) => {
  const viewer = await openPhoto(page, 'Album A/Photo 03.png');
  await page.keyboard.press('+');
  await page.keyboard.press('r');
  await page.keyboard.press('Escape');
  await expect(viewer).toBeHidden();
  await expect(page.locator('#mediaGrid .media-card[data-path="Album A/Photo 03.png"]')).toBeFocused();
});

test('photo tools animate discrete steps unless reduced motion is requested', async ({page}) => {
  const viewer = await openPhoto(page, 'Album A/Photo 01.png');
  const image = viewer.locator('.stage img');
  await page.emulateMedia({reducedMotion: 'no-preference'});
  await viewer.getByRole('button', {name: 'Увеличить'}).click();
  await expect(image).toHaveClass(/is-animated/);
  await expect(image).toHaveCSS('transition-duration', '0.2s');
  await page.emulateMedia({reducedMotion: 'reduce'});
  await expect(image).toHaveCSS('transition-property', 'none');
  // Wheel zoom follows the input directly.
  await page.mouse.move(720, 500);
  await page.mouse.wheel(0, -100);
  await expect(image).not.toHaveClass(/is-animated/);
});

test('photo tools are reachable by keyboard and stay visible while focused', async ({page}) => {
  const viewer = await openPhoto(page, 'Album A/Photo 01.png');
  const rotate = viewer.getByRole('button', {name: 'Повернуть вправо'});
  await focusWithKeyboard(page, rotate);
  await expect(rotate).toHaveCSS('outline-style', 'solid');
  await page.keyboard.press('Enter');
  await expect(viewer.locator('.stage')).toHaveAttribute('data-rotation', '90');
  await page.clock.runFor(3_000);
  await expect(viewer).toHaveAttribute('data-idle', 'true');
  await expect(viewer.locator('footer')).toHaveCSS('opacity', '1');
  await expect(rotate).toBeFocused();
});

test('keys on a focused control or video keep their native meaning', {tag: '@essential'}, async ({page}) => {
  const viewer = await openPhoto(page, 'Album A/Photo 01.png');
  const caption = viewer.locator('.caption');
  const level = viewer.locator('.zoom-level');
  const slideshow = viewer.locator('.slideshow');
  const opened = await caption.textContent();
  const fit = fitScale(frameOf(await photoBox(viewer), PORTRAIT), 0);

  // Space activates the focused zoom-in button once and does not start the slideshow.
  const zoomIn = viewer.getByRole('button', {name: 'Увеличить'});
  await zoomIn.focus();
  await page.keyboard.press('Space');
  await expect(level).toHaveText(`${Math.round(fit * ZOOM_STEP * 100)}%`);
  await expect(slideshow).toHaveText('Слайд-шоу');
  // Arrows and shortcuts on a control neither switch photos nor zoom again.
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('+');
  await expect(caption).toHaveText(opened ?? '');
  await expect(level).toHaveText(`${Math.round(fit * ZOOM_STEP * 100)}%`);

  // Space on the slideshow button toggles it exactly once in each direction.
  await slideshow.focus();
  await page.keyboard.press('Space');
  await expect(slideshow).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Space');
  await expect(slideshow).toHaveAttribute('aria-pressed', 'false');

  // With focus back on the dialog surface the global arrow shortcut still works.
  await viewer.evaluate(dialog => dialog.focus());
  await expect(viewer).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(caption).not.toHaveText(opened ?? '');
  await page.keyboard.press('Escape');
  await expect(viewer).toBeHidden();
});

test('arrow keys and Space on a focused video do not change the item', {tag: '@essential'}, async ({page}) => {
  await openMixedVideo(page);
  const viewer = page.locator('#viewer');
  const caption = viewer.locator('.caption');
  await expect(caption).toContainText('Clip.mp4');
  const video = viewer.locator('.stage video');
  await video.focus();
  await expect(video).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowLeft');
  await expect(caption).toContainText('Clip.mp4');
  await expect(viewer.locator('.slideshow')).toHaveText('Слайд-шоу');
  await page.keyboard.press('Escape');
  await expect(viewer).toBeHidden();
});
