import {test, expect} from '@playwright/test';
import {isDesktopBrowserProject, openAlbum} from './helpers.mjs';

test.beforeEach(async ({page}, testInfo) => {
  test.skip(!isDesktopBrowserProject(testInfo), 'Viewer flows run once per desktop browser engine.');
  await page.clock.install();
});

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
