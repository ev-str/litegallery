import {test, expect} from '@playwright/test';
import {isDesktopBrowserProject} from './helpers.mjs';
import {DEFAULT_INTERVAL, INTERVAL_KEY, INTERVALS} from '../../web/slideshow.js';

const COUNT = 13;
const STEP_MS = DEFAULT_INTERVAL * 1000;

test.beforeEach(async ({page}, testInfo) => {
  test.skip(!isDesktopBrowserProject(testInfo), 'Slideshow and TV flows run once per desktop browser engine.');
  await page.clock.install();
});

/** Open Album A at its first tile (newest first) with reduced motion. */
async function openAlbumViewer(page) {
  await page.emulateMedia({reducedMotion: 'reduce'});
  await page.goto('/?path=Album%20A');
  await page.locator('#mediaGrid .media-card.image').first().click();
  const viewer = page.locator('#viewer');
  await expect(viewer.locator('.caption')).toContainText(`· 1/${COUNT}`);
  return viewer;
}

/** Position of the shown item, from the caption `name · n/13`. */
async function position(viewer) {
  const text = await viewer.locator('.caption').textContent() ?? '';
  return Number(/· (\d+)\//.exec(text)?.[1]);
}

const nameOf = async viewer => (await viewer.locator('.caption').textContent() ?? '').split(' · ')[0];

test('the slideshow interval is chosen, stored, and times the next transition', {tag: '@essential'}, async ({page}) => {
  let viewer = await openAlbumViewer(page);
  const interval = viewer.locator('.slideshow-interval');
  await expect(interval).toHaveValue(String(DEFAULT_INTERVAL));
  await expect(interval.locator('option')).toHaveText(INTERVALS.map(seconds => `${seconds} с`));

  await interval.selectOption('10');
  expect(await page.evaluate(key => localStorage.getItem(key), INTERVAL_KEY)).toBe('10');
  await page.keyboard.press('Escape');
  await page.reload();
  viewer = await openAlbumViewer(page);
  await expect(interval).toHaveValue('10');

  await viewer.locator('.slideshow').click();
  await page.clock.runFor(9_000);
  expect(await position(viewer)).toBe(1);
  await page.clock.runFor(1_100);
  expect(await position(viewer)).toBe(2);

  // A change while playing times the next transition from now, with no leftover 10 s timer.
  await page.clock.runFor(4_000);
  await interval.selectOption('30');
  await page.clock.runFor(29_000);
  expect(await position(viewer)).toBe(2);
  await page.clock.runFor(1_100);
  expect(await position(viewer)).toBe(3);
});

test('repeated Start and Stop never leave a second autoplay timer', {tag: '@essential'}, async ({page}) => {
  const viewer = await openAlbumViewer(page);
  const slideshow = viewer.locator('.slideshow');
  for (let click = 0; click < 5; click += 1) await slideshow.click();
  await expect(slideshow).toHaveAttribute('aria-pressed', 'true');
  // Space on the dialog surface toggles the same slideshow twice: off, then on again.
  await viewer.evaluate(dialog => dialog.focus());
  await page.keyboard.press('Space');
  await expect(slideshow).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('Space');
  await expect(slideshow).toHaveText('Стоп');

  // One timer advances once per interval; a second one would at least double the steps.
  await page.clock.runFor(STEP_MS * 3 + 100);
  expect(await position(viewer)).toBe(4);

  // A manual Next restarts the interval rather than adding a timer.
  await page.clock.runFor(STEP_MS / 2);
  await viewer.getByRole('button', {name: 'Следующее'}).click();
  expect(await position(viewer)).toBe(5);
  await page.clock.runFor(STEP_MS - 600);
  expect(await position(viewer)).toBe(5);
  await page.clock.runFor(700);
  expect(await position(viewer)).toBe(6);

  await slideshow.click();
  await expect(slideshow).toHaveText('Слайд-шоу');
  await page.clock.runFor(STEP_MS * 4);
  expect(await position(viewer)).toBe(6);
});

test('shuffle keeps a history that Previous retraces and Next replays', {tag: '@essential'}, async ({page}) => {
  // A seeded generator makes the shuffle order repeatable.
  await page.addInitScript(() => {
    let seed = 7;
    Math.random = () => {
      seed = (seed * 16807) % 2147483647;
      return (seed - 1) / 2147483646;
    };
  });
  const viewer = await openAlbumViewer(page);
  const shuffle = viewer.getByRole('button', {name: 'Случайный порядок'});
  await shuffle.click();
  await expect(shuffle).toHaveAttribute('aria-pressed', 'true');
  await viewer.evaluate(dialog => dialog.focus());

  const walk = [await nameOf(viewer)];
  const positions = [await position(viewer)];
  for (let step = 0; step < 4; step += 1) {
    await page.keyboard.press('ArrowRight');
    walk.push(await nameOf(viewer));
    positions.push(await position(viewer));
  }
  expect(new Set(walk).size).toBe(walk.length);
  // Shuffle really leaves the gallery order.
  expect(positions).not.toEqual([1, 2, 3, 4, 5]);

  for (let step = walk.length - 2; step >= 1; step -= 1) {
    await page.keyboard.press('ArrowLeft');
    expect(await nameOf(viewer)).toBe(walk[step]);
  }
  await page.keyboard.press('ArrowRight');
  expect(await nameOf(viewer)).toBe(walk[2]);

  // Autoplay continues along the same history before choosing anything new.
  await viewer.locator('.slideshow').click();
  await page.clock.runFor(STEP_MS + 100);
  expect(await nameOf(viewer)).toBe(walk[3]);
  await page.clock.runFor(STEP_MS);
  expect(await nameOf(viewer)).toBe(walk[4]);
  await page.clock.runFor(STEP_MS);
  const fresh = await nameOf(viewer);
  expect(walk).not.toContain(fresh);
  await viewer.locator('.slideshow').click();
  await viewer.evaluate(dialog => dialog.focus());
  await page.keyboard.press('ArrowLeft');
  expect(await nameOf(viewer)).toBe(walk[4]);

  // Leaving shuffle returns to the gallery order from the current item.
  await shuffle.click();
  await expect(shuffle).toHaveAttribute('aria-pressed', 'false');
  const here = await position(viewer);
  await viewer.evaluate(dialog => dialog.focus());
  await page.keyboard.press('ArrowRight');
  expect(await position(viewer)).toBe(here % COUNT + 1);
});

test('autoplay skips broken media with a quiet notice; opened manually it shows its error', {tag: '@essential'}, async ({page}) => {
  const broken = 'Album A/Photo 12.png';
  await page.route(url => url.pathname === '/api/media' && url.searchParams.get('path') === broken, route => route.fulfill({status: 500, body: 'broken'}));
  const viewer = await openAlbumViewer(page);
  const notice = viewer.locator('.viewer-notice');
  await expect(viewer.locator('.caption')).toContainText('Photo 13.png');

  await viewer.locator('.slideshow').click();
  await page.clock.runFor(STEP_MS + 100);
  await expect(viewer.locator('.caption')).toContainText(`Photo 11.png · 3/${COUNT}`);
  await expect(notice).toBeVisible();
  await expect(notice).toHaveAttribute('role', 'status');
  await expect(notice).toContainText('Photo 12.png');
  await expect(viewer.locator('.slideshow')).toHaveText('Стоп');
  await page.clock.runFor(4_100);
  await expect(notice).toBeHidden();

  // The next transition is a normal one, and the broken file is not retried by autoplay.
  await page.clock.runFor(STEP_MS);
  await expect(viewer.locator('.caption')).toContainText(`· 4/${COUNT}`);

  await viewer.locator('.slideshow').click();
  for (let step = 0; step < 2; step += 1) await viewer.getByRole('button', {name: 'Предыдущее'}).click();
  await expect(viewer.locator('.caption')).toContainText(`Photo 12.png · 2/${COUNT}`);
  await expect(viewer.locator('.stage')).toHaveAttribute('data-error', 'true');
  await expect(viewer.locator('.stage-error')).toHaveText('Не удалось открыть файл');
  await expect(viewer.getByRole('link', {name: 'Скачать оригинал'})).toBeVisible();
});

test('autoplay stops instead of looping when every item is broken', async ({page}) => {
  let requests = 0;
  await page.route(url => url.pathname === '/api/media', route => {
    requests += 1;
    return route.fulfill({status: 500, body: 'broken'});
  });
  const viewer = await openAlbumViewer(page);
  await expect(viewer.locator('.stage-error')).toBeVisible();
  const slideshow = viewer.locator('.slideshow');
  await slideshow.click();
  await page.clock.runFor(STEP_MS + 100);
  await expect(slideshow).toHaveText('Слайд-шоу');
  await expect(viewer.locator('.viewer-notice')).toContainText('остановлено');
  await page.clock.runFor(STEP_MS * 5);
  expect(requests).toBeLessThanOrEqual(COUNT);
  await expect(viewer).toBeVisible();
});

test('TV mode goes fullscreen with large controls and ends when fullscreen exits', {tag: '@essential'}, async ({page}) => {
  const viewer = await openAlbumViewer(page);
  const tv = viewer.getByRole('button', {name: 'Режим TV'});
  const zoomIn = viewer.getByRole('button', {name: 'Увеличить'});
  const slideshow = viewer.locator('.slideshow');
  const ordinary = (await zoomIn.boundingBox())?.width ?? 0;

  await tv.click();
  await expect(viewer).toHaveAttribute('data-tv', 'true');
  expect(await page.evaluate(() => document.fullscreenElement?.className)).toBe('viewer-frame');
  await expect(viewer.getByRole('button', {name: 'Выйти из режима TV'})).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await zoomIn.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(ordinary * 1.4);
  // The remote's arrows act on the viewer surface right away.
  await expect(viewer.locator('.viewer-frame')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  expect(await position(viewer)).toBe(2);

  await page.keyboard.press('Space');
  await expect(slideshow).toHaveAttribute('aria-pressed', 'true');
  await page.evaluate(() => document.exitFullscreen());
  await expect(viewer).not.toHaveAttribute('data-tv');
  await expect(slideshow).toHaveAttribute('aria-pressed', 'false');
  await expect(tv).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(async () => (await zoomIn.boundingBox())?.width ?? 0).toBeCloseTo(ordinary, 0);
  await page.clock.runFor(STEP_MS * 2);
  expect(await position(viewer)).toBe(2);
  await expect(viewer).toBeVisible();

  // The TV button also leaves TV mode itself; moving the pointer first brings the idle chrome back.
  await page.mouse.move(700, 500);
  await tv.click();
  await expect(viewer).toHaveAttribute('data-tv', 'true');
  await viewer.getByRole('button', {name: 'Выйти из режима TV'}).click();
  await expect(viewer).not.toHaveAttribute('data-tv');
  await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBeNull();
});

test('a refused or missing fullscreen keeps the viewer usable and says why', async ({page}) => {
  await page.addInitScript(() => {
    Element.prototype.requestFullscreen = () => Promise.reject(new TypeError('Permissions check failed'));
  });
  const viewer = await openAlbumViewer(page);
  await viewer.getByRole('button', {name: 'Режим TV'}).click();
  await expect(viewer.locator('.viewer-notice')).toContainText('Режим TV недоступен');
  await expect(viewer).not.toHaveAttribute('data-tv');
  await viewer.evaluate(dialog => dialog.focus());
  await page.keyboard.press('ArrowRight');
  expect(await position(viewer)).toBe(2);

  await page.evaluate(() => {
    // @ts-ignore: simulate a browser without the Fullscreen API.
    delete Element.prototype.requestFullscreen;
    // @ts-ignore
    delete Element.prototype.webkitRequestFullscreen;
  });
  await page.clock.runFor(4_100);
  await expect(viewer.locator('.viewer-notice')).toBeHidden();
  await viewer.getByRole('button', {name: 'Режим TV'}).click();
  await expect(viewer.locator('.viewer-notice')).toContainText('не поддерживает');
  await expect(viewer).not.toHaveAttribute('data-tv');
});

test('TV chrome hides when idle, returns on activity, and stays while keyboard focus is inside', {tag: '@essential'}, async ({page}) => {
  const viewer = await openAlbumViewer(page);
  const footer = viewer.locator('footer');
  const close = viewer.getByRole('button', {name: 'Закрыть', exact: true});
  await viewer.getByRole('button', {name: 'Режим TV'}).click();
  await expect(viewer).toHaveAttribute('data-tv', 'true');
  // A pointer resting on the controls keeps them, so it moves to the photo first.
  await page.mouse.move(720, 400);

  await page.clock.runFor(3_000);
  await expect(viewer).toHaveAttribute('data-idle', 'true');
  await expect(footer).toHaveCSS('opacity', '0');
  await page.mouse.move(700, 500);
  await expect(viewer).toHaveAttribute('data-idle', 'false');
  await expect(footer).toHaveCSS('opacity', '1');

  await page.clock.runFor(3_000);
  await expect(viewer).toHaveAttribute('data-idle', 'true');
  await page.keyboard.press('ArrowRight');
  await expect(viewer).toHaveAttribute('data-idle', 'false');

  // With keyboard focus on a control nothing hides, however long the pause.
  const slideshow = viewer.locator('.slideshow');
  for (let step = 0; step < 20 && !(await slideshow.evaluate(element => element === document.activeElement)); step += 1) await page.keyboard.press('Tab');
  if (!(await slideshow.evaluate(element => element === document.activeElement))) {
    // Safari's Tab skips buttons; a key press first makes the scripted focus keyboard focus.
    await page.keyboard.press('Shift');
    await slideshow.focus();
  }
  await page.clock.runFor(10_000);
  await expect(viewer).toHaveAttribute('data-idle', 'false');
  await expect(close).toHaveCSS('opacity', '1');

  await page.evaluate(() => document.exitFullscreen());
  await expect(viewer).not.toHaveAttribute('data-tv');
});

test('keys on focused slideshow controls keep their native meaning', {tag: '@essential'}, async ({page}) => {
  const viewer = await openAlbumViewer(page);
  const slideshow = viewer.locator('.slideshow');
  const shuffle = viewer.getByRole('button', {name: 'Случайный порядок'});
  const interval = viewer.locator('.slideshow-interval');

  // Space activates the focused Shuffle once and does not start the slideshow.
  await shuffle.focus();
  await page.keyboard.press('Space');
  await expect(shuffle).toHaveAttribute('aria-pressed', 'true');
  await expect(slideshow).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('ArrowRight');
  expect(await position(viewer)).toBe(1);

  await interval.focus();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowRight');
  await expect(slideshow).toHaveAttribute('aria-pressed', 'false');
  expect(await position(viewer)).toBe(1);

  // The TV button keeps Enter for itself, and arrows on it do not switch photos.
  const tv = viewer.getByRole('button', {name: 'Режим TV'});
  await tv.focus();
  await page.keyboard.press('ArrowRight');
  expect(await position(viewer)).toBe(1);
  await page.keyboard.press('Enter');
  await expect(viewer).toHaveAttribute('data-tv', 'true');
  await page.evaluate(() => document.exitFullscreen());
  await expect(viewer).not.toHaveAttribute('data-tv');
});

test('the header TV button starts TV on the current filtered and sorted selection', {tag: '@essential'}, async ({page}) => {
  await page.emulateMedia({reducedMotion: 'reduce'});
  await page.goto('/');
  const tvMode = page.locator('#tvMode');
  const album = page.getByRole('button', {name: 'Открыть папку Album A'});
  await expect(album).toBeVisible();
  // The library root holds only folders, so there is nothing to show.
  await expect(tvMode).toBeDisabled();

  await album.click();
  await expect(page.locator('#mediaGrid .media-card.image')).toHaveCount(COUNT);
  await expect(tvMode).toBeEnabled();
  // A non-default order: by name, then the other direction.
  await page.locator('#mediaSort').selectOption('name');
  await page.locator('#mediaDirection').click();
  const first = (await page.locator('#mediaGrid .media-card').first().getAttribute('data-path') ?? '').split('/').pop();

  await tvMode.click();
  const viewer = page.locator('#viewer');
  await expect(viewer).toHaveAttribute('data-tv', 'true');
  await expect(viewer.locator('.caption')).toHaveText(`${first} · 1/${COUNT}`);
  expect(await page.evaluate(() => document.fullscreenElement?.className)).toBe('viewer-frame');
  await expect(viewer.locator('.viewer-frame')).toBeFocused();

  await page.evaluate(() => document.exitFullscreen());
  await expect(viewer).not.toHaveAttribute('data-tv');
  await page.keyboard.press('Escape');
  await expect(viewer).toBeHidden();
  await expect(tvMode).toBeFocused();

  await page.locator('#mediaFilter [data-filter="video"]').click();
  await expect(page.locator('#mediaGrid .media-card')).toHaveCount(0);
  await expect(tvMode).toBeDisabled();
});

test('TV entered from the keyboard hides idle chrome and keeps it while a control has focus', {tag: '@essential'}, async ({page}) => {
  const viewer = await openAlbumViewer(page);
  const footer = viewer.locator('footer');
  const tv = viewer.getByRole('button', {name: 'Режим TV'});
  // A key press first makes the scripted focus keyboard focus in every engine.
  await page.keyboard.press('Shift');
  await tv.focus();
  await page.keyboard.press('Enter');
  await expect(viewer).toHaveAttribute('data-tv', 'true');
  const frame = viewer.locator('.viewer-frame');
  await expect(frame).toBeFocused();
  await page.keyboard.press('ArrowRight');
  expect(await position(viewer)).toBe(2);

  // Focus on the viewer surface does not hold the chrome.
  await page.clock.runFor(3_000);
  await expect(viewer).toHaveAttribute('data-idle', 'true');
  await expect(footer).toHaveCSS('opacity', '0');

  await page.keyboard.press('Tab');
  const onControl = () => page.evaluate(() => Boolean(document.activeElement?.closest('#viewer :is(button, a, select)')));
  if (!(await onControl())) {
    // Safari's Tab skips buttons; fall back to keyboard-initiated focus on one.
    await viewer.locator('.slideshow').focus();
  }
  expect(await onControl()).toBe(true);
  await expect(viewer).toHaveAttribute('data-idle', 'false');
  await page.clock.runFor(10_000);
  await expect(viewer).toHaveAttribute('data-idle', 'false');
  await expect(footer).toHaveCSS('opacity', '1');
  await expect(viewer.getByRole('button', {name: 'Закрыть', exact: true})).toHaveCSS('opacity', '1');

  await page.evaluate(() => document.exitFullscreen());
  await expect(viewer).not.toHaveAttribute('data-tv');
});
