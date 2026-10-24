import {test, expect} from '@playwright/test';
import {GROUP_STORAGE_KEY} from '../../web/date-groups.js';
import {WINDOW_MIN_ITEMS} from '../../web/media-window.js';
import {clickHeaderControl, directory, listing, mockListings, mockSearch, scrollTop, stubMedia} from './helpers.mjs';

// The browser runs in Europe/Moscow (UTC+3, no DST): a Moscow wall-clock time as Unix seconds.
const moscow = (year, month, day, hour = 12) => Date.UTC(year, month - 1, day, hour - 3) / 1000;
const file = (path, sortTime, kind = 'image') => ({name: path.split('/').pop(), path, kind, size: 2048, modTime: '2026-01-15T12:00:00Z', sortTime});

// Names and dates disagree, so name order and date order differ; the dates cross a year and a month border.
const TRIP_FILES = [
  file('Trip/a.jpg', moscow(2026, 1, 1, 10)),
  file('Trip/b.mp4', moscow(2025, 12, 31, 23), 'video'),
  file('Trip/c.jpg', moscow(2025, 12, 31, 9)),
  file('Trip/d.jpg', moscow(2025, 11, 30)),
  file('Trip/e.jpg', moscow(2026, 9, 6, 8)),
  file('Trip/f.mp4', moscow(2026, 9, 6, 18), 'video'),
  file('Trip/g.jpg', moscow(2026, 9, 5)),
];
const DAY2_FILES = [file('Trip/Day 2/h.jpg', moscow(2026, 9, 7)), file('Trip/Day 2/i.jpg', moscow(2024, 5, 1))];

// The large folder: 5000 photos, seven per day, newest last.
const LARGE = 'Large';
const LARGE_TOTAL = 5000;
const PER_DAY = 7;
const LARGE_FILES = Array.from({length: LARGE_TOTAL}, (_, index) => file(`${LARGE}/IMG_${String(index + 1).padStart(5, '0')}.jpg`, moscow(2012, 1, 1) + Math.floor(index / PER_DAY) * 86_400 + (index % PER_DAY) * 60));

const LISTINGS = {
  '': [directory('Trip'), directory(LARGE)],
  Trip: [directory('Trip/Day 2'), ...TRIP_FILES],
  'Trip?recursive': [...TRIP_FILES, ...DAY2_FILES],
  [LARGE]: LARGE_FILES,
};

async function mockLibrary(page) {
  await mockListings(page, (key, path) => listing(path, LISTINGS[key] ?? []));
  await mockSearch(page, TRIP_FILES);
  await stubMedia(page);
}

const groupSelect = page => page.locator('#mediaGroup');
const tile = (page, path) => page.locator(`#mediaGrid .media-card[data-path="${path}"]`);
const shown = async page => new URL(await page.locator('#viewer a.download').getAttribute('href'), 'http://x').searchParams.get('path');

/** Headings as `# label` and tiles as file names, in DOM order. */
const visual = (page, grid = '#mediaGrid') => page.locator(grid).evaluate(element => [...element.children]
  .filter(child => child.matches('.media-group-heading, .media-card:not(.is-window-pinned)'))
  .map(child => (child.matches('.media-group-heading') ? `# ${child.textContent}` : child.getAttribute('data-path').split('/').pop())));

/** File names of the tiles in DOM order. */
const tileNames = async (page, grid = '#mediaGrid') => (await visual(page, grid)).filter(entry => !entry.startsWith('# '));

async function openTrip(page) {
  await page.goto('/?path=Trip');
  await expect(page.locator('#mediaGrid .media-card')).toHaveCount(TRIP_FILES.length);
}

async function chooseGrouping(page, mode) {
  await groupSelect(page).selectOption(mode);
  await expect(groupSelect(page)).toHaveValue(mode);
}

test.beforeEach(async ({page}, testInfo) => {
  await mockLibrary(page);
});

test('Нет, Год, Месяц, and День group the visible list under compact headings', {tag: '@essential'}, async ({page}) => {
  await openTrip(page);
  // Default: no grouping and no headings.
  await expect(groupSelect(page)).toHaveValue('none');
  expect(await groupSelect(page).locator('option').allTextContents()).toEqual(['Нет', 'Год', 'Месяц', 'День']);
  await expect(groupSelect(page)).toHaveAccessibleName('Группировка по дате');
  expect(await visual(page)).toEqual(['f.mp4', 'e.jpg', 'g.jpg', 'a.jpg', 'b.mp4', 'c.jpg', 'd.jpg']);

  await chooseGrouping(page, 'year');
  expect(await visual(page)).toEqual(['# 2026', 'f.mp4', 'e.jpg', 'g.jpg', 'a.jpg', '# 2025', 'b.mp4', 'c.jpg', 'd.jpg']);
  expect(await page.evaluate(key => localStorage.getItem(key), GROUP_STORAGE_KEY)).toBe('year');

  await chooseGrouping(page, 'month');
  expect(await visual(page)).toEqual(['# сентябрь 2026', 'f.mp4', 'e.jpg', 'g.jpg', '# январь 2026', 'a.jpg', '# декабрь 2025', 'b.mp4', 'c.jpg', '# ноябрь 2025', 'd.jpg']);

  await chooseGrouping(page, 'day');
  expect(await visual(page)).toEqual([
    '# 6 сентября 2026', 'f.mp4', 'e.jpg', '# 5 сентября 2026', 'g.jpg', '# 1 января 2026', 'a.jpg',
    '# 31 декабря 2025', 'b.mp4', 'c.jpg', '# 30 ноября 2025', 'd.jpg',
  ]);
  // Every group starts a new row, and headings stay compact.
  const geometry = await page.locator('#mediaGrid').evaluate(grid => {
    const heading = grid.querySelector('.media-group-heading').getBoundingClientRect();
    const first = grid.querySelector('.media-card[data-path="Trip/g.jpg"]').getBoundingClientRect();
    return {headingHeight: heading.height, gridLeft: grid.getBoundingClientRect().left, firstLeft: first.left};
  });
  expect(geometry.headingHeight).toBeLessThanOrEqual(40);
  expect(Math.abs(geometry.firstLeft - geometry.gridLeft)).toBeLessThanOrEqual(1);

  await chooseGrouping(page, 'none');
  await expect(page.locator('#mediaGrid .media-group-heading')).toHaveCount(0);
  expect(await page.evaluate(key => localStorage.getItem(key), GROUP_STORAGE_KEY)).toBe('none');
});

test('groups follow the sort direction; name order is kept inside each group', {tag: '@essential'}, async ({page}) => {
  await openTrip(page);
  await chooseGrouping(page, 'month');
  await page.locator('#mediaDirection').click();
  expect(await visual(page)).toEqual(['# ноябрь 2025', 'd.jpg', '# декабрь 2025', 'c.jpg', 'b.mp4', '# январь 2026', 'a.jpg', '# сентябрь 2026', 'g.jpg', 'e.jpg', 'f.mp4']);

  await page.locator('#mediaSort').selectOption('name');
  expect(await visual(page)).toEqual(['# ноябрь 2025', 'd.jpg', '# декабрь 2025', 'b.mp4', 'c.jpg', '# январь 2026', 'a.jpg', '# сентябрь 2026', 'e.jpg', 'f.mp4', 'g.jpg']);

  await page.locator('#mediaDirection').click();
  expect(await visual(page)).toEqual(['# сентябрь 2026', 'g.jpg', 'f.mp4', 'e.jpg', '# январь 2026', 'a.jpg', '# декабрь 2025', 'c.jpg', 'b.mp4', '# ноябрь 2025', 'd.jpg']);
});

test('the Фото and Видео filters group only the files of that type', {tag: '@essential'}, async ({page}) => {
  await openTrip(page);
  await chooseGrouping(page, 'month');
  await page.locator('#mediaFilter [data-filter="video"]').click();
  expect(await visual(page)).toEqual(['# сентябрь 2026', 'f.mp4', '# декабрь 2025', 'b.mp4']);
  await page.locator('#mediaFilter [data-filter="image"]').click();
  expect(await visual(page)).toEqual(['# сентябрь 2026', 'e.jpg', 'g.jpg', '# январь 2026', 'a.jpg', '# декабрь 2025', 'c.jpg', '# ноябрь 2025', 'd.jpg']);
});

test('a recursive listing is grouped as one list', {tag: '@essential'}, async ({page}) => {
  await openTrip(page);
  await chooseGrouping(page, 'year');
  await page.locator('#recursiveToggle').click();
  await expect(page.locator('#mediaGrid .media-card')).toHaveCount(TRIP_FILES.length + DAY2_FILES.length);
  expect(await visual(page)).toEqual(['# 2026', 'h.jpg', 'f.mp4', 'e.jpg', 'g.jpg', 'a.jpg', '# 2025', 'b.mp4', 'c.jpg', 'd.jpg', '# 2024', 'i.jpg']);
  await expect(groupSelect(page)).toHaveValue('year');
});

test('Найти uses the active grouping without a control of its own', {tag: '@essential'}, async ({page}) => {
  await openTrip(page);
  await chooseGrouping(page, 'month');
  await page.locator('#searchMode').click();
  await expect(page.locator('#searchSurface select')).toHaveCount(0);
  await expect(groupSelect(page)).toBeHidden();
  await page.locator('#searchInput').fill('.jpg');
  await expect(page.locator('#searchGrid .media-card')).toHaveCount(5);
  expect(await visual(page, '#searchGrid')).toEqual(['# сентябрь 2026', 'e.jpg', 'g.jpg', '# январь 2026', 'a.jpg', '# декабрь 2025', 'c.jpg', '# ноябрь 2025', 'd.jpg']);

  // Viewer from Найти walks the grouped results.
  const order = await tileNames(page, '#searchGrid');
  await page.locator('#searchGrid .media-card[data-path="Trip/a.jpg"]').click();
  await expect(page.locator('#viewer')).toBeVisible();
  expect(await shown(page)).toBe('Trip/a.jpg');
  await page.locator('#viewer .next').click();
  expect(await shown(page)).toBe(`Trip/${order[order.indexOf('a.jpg') + 1]}`);
  await page.keyboard.press('Escape');
  await expect(page.locator('#searchGrid .media-card[data-path="Trip/a.jpg"]')).toBeFocused();

  await page.locator('#galleryMode').click();
  await expect(groupSelect(page)).toHaveValue('month');
  await expect(page.locator('#mediaGrid .media-group-heading')).toHaveCount(4);
});

test('the viewer and TV get the grouped visual order; focus returns to the opened tile', {tag: '@essential'}, async ({page}) => {
  await page.emulateMedia({reducedMotion: 'reduce'});
  await openTrip(page);
  await page.locator('#mediaSort').selectOption('name');
  await chooseGrouping(page, 'month');
  const order = await tileNames(page);
  expect(order).toEqual(['g.jpg', 'f.mp4', 'e.jpg', 'a.jpg', 'c.jpg', 'b.mp4', 'd.jpg']);

  await tile(page, 'Trip/g.jpg').click();
  await expect(page.locator('#viewer')).toBeVisible();
  for (const [index, name] of order.entries()) {
    expect(await shown(page)).toBe(`Trip/${name}`);
    await expect(page.locator('#viewer .caption')).toContainText(`· ${index + 1}/${order.length}`);
    if (index < order.length - 1) await page.locator('#viewer .next').click();
  }
  await page.keyboard.press('Escape');
  await expect(tile(page, 'Trip/g.jpg')).toBeFocused();

  // A tile in the middle of a group opens at its own position and gets the focus back.
  await tile(page, 'Trip/c.jpg').click();
  await expect(page.locator('#viewer .caption')).toContainText(`c.jpg · 5/${order.length}`);
  await page.keyboard.press('ArrowLeft');
  expect(await shown(page)).toBe('Trip/a.jpg');
  await page.keyboard.press('Escape');
  await expect(tile(page, 'Trip/c.jpg')).toBeFocused();

  // TV starts from the first tile on screen and steps in the same order.
  await clickHeaderControl(page, '#tvMode');
  await expect(page.locator('#viewer')).toHaveAttribute('data-tv', 'true');
  expect(await shown(page)).toBe(`Trip/${order[0]}`);
  await page.keyboard.press('ArrowRight');
  expect(await shown(page)).toBe(`Trip/${order[1]}`);
  await page.keyboard.press('ArrowRight');
  expect(await shown(page)).toBe(`Trip/${order[2]}`);
});

test('arrow keys cross date headings in the grid', {tag: '@essential'}, async ({page}) => {
  await openTrip(page);
  await chooseGrouping(page, 'month');
  // сентябрь 2026: f e g; январь 2026: a. Down from any column of a short group row lands in the next group.
  await tile(page, 'Trip/g.jpg').focus();
  await page.keyboard.press('ArrowDown');
  await expect(tile(page, 'Trip/a.jpg')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(tile(page, 'Trip/b.mp4')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(tile(page, 'Trip/c.jpg')).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(tile(page, 'Trip/a.jpg')).toBeFocused();

  // The control is in the tab order right after the sort direction.
  await page.locator('#mediaDirection').focus();
  await page.keyboard.press('Tab');
  await expect(groupSelect(page)).toBeFocused();
});

test('switching sections keeps the grouping, and a refresh or reload keeps it with scroll and focus', {tag: '@essential'}, async ({page}) => {
  await page.goto(`/?path=${LARGE}`);
  await expect(page.locator('#mediaGrid .media-card').first()).toBeVisible();
  await chooseGrouping(page, 'day');

  for (const entry of ['#searchMode', '#collageMode', '#statusMode']) {
    await clickHeaderControl(page, entry);
    await page.locator('#galleryMode').click();
    await expect(groupSelect(page)).toHaveValue('day');
  }

  // Scroll deep into the list and focus a tile there.
  await page.evaluate(() => scrollTo({top: document.documentElement.scrollHeight / 2, behavior: 'instant'}));
  // The window follows the scroll on its event; wait for a tile below the chrome.
  let target = null;
  await expect.poll(async () => {
    target = await page.evaluate(() => {
      const top = document.querySelector('.topbar').getBoundingClientRect().bottom + 80;
      const card = [...document.querySelectorAll('#mediaGrid .media-card')].find(element => element.getBoundingClientRect().top > top && element.getBoundingClientRect().bottom < innerHeight);
      return card?.getAttribute('data-path') ?? null;
    });
    return target;
  }).not.toBeNull();
  await tile(page, target).focus();
  const scroll = await scrollTop(page);

  // A refresh started outside the button keeps mode, scroll, and focus.
  const refreshed = page.waitForResponse(response => response.url().includes(`/api/list?path=${LARGE}`));
  await page.evaluate(() => document.querySelector('#refresh').click());
  await refreshed;
  await expect(page.locator('#refresh')).not.toHaveAttribute('aria-busy', 'true');
  await expect.poll(() => scrollTop(page)).toBe(scroll);
  await expect(tile(page, target)).toBeFocused();

  await page.reload();
  await expect(groupSelect(page)).toHaveValue('day');
  await expect(tile(page, target)).toBeFocused();
  await expect.poll(() => scrollTop(page)).toBe(scroll);
  await expect(page.locator('#mediaGrid .media-group-heading').first()).toBeAttached();
});

test('a large grouped folder keeps a bounded DOM and a sticky heading for the top group', {tag: '@essential'}, async ({page}) => {
  await page.goto(`/?path=${LARGE}`);
  await expect(page.locator('#mediaGrid .media-card').first()).toBeVisible();
  await chooseGrouping(page, 'day');

  const counts = () => page.evaluate(() => ({
    cards: document.querySelectorAll('#mediaGrid .media-card').length,
    headings: document.querySelectorAll('#mediaGrid .media-group-heading').length,
  }));
  const bounded = async () => {
    const {cards, headings} = await counts();
    expect(cards).toBeGreaterThan(0);
    expect(cards).toBeLessThanOrEqual(WINDOW_MIN_ITEMS);
    expect(headings).toBeLessThanOrEqual(Math.ceil(WINDOW_MIN_ITEMS / PER_DAY) + 2);
  };
  await bounded();
  await expect(page.locator('#mediaGroupHeading')).toBeHidden();

  for (const fraction of [0.37, 0.81, 0.12]) {
    await page.evaluate(share => scrollTo({top: document.documentElement.scrollHeight * share, behavior: 'instant'}), fraction);
    await bounded();
    // The sticky copy names the group of the first heading or tile below it.
    await expect.poll(() => page.evaluate(async perDay => {
      const {groupKey, groupLabel} = await import('/date-groups.js');
      const sticky = /** @type {HTMLElement} */ (document.querySelector('#mediaGroupHeading'));
      if (sticky.hidden) return 'hidden';
      const line = sticky.getBoundingClientRect().bottom;
      const below = [...document.querySelectorAll('#mediaGrid > .media-group-heading, #mediaGrid > .media-card:not(.is-window-pinned)')]
        .find(element => element.getBoundingClientRect().bottom > line);
      if (!below) return 'not rendered yet';
      if (below.matches('.media-group-heading')) return sticky.textContent === below.textContent || `${sticky.textContent} ≠ ${below.textContent}`;
      const index = Number(below.getAttribute('data-path').match(/IMG_(\d+)/)[1]) - 1;
      const expected = groupLabel(groupKey(Date.UTC(2012, 0, 1, 9) / 1000 + Math.floor(index / perDay) * 86_400, 'day'));
      return sticky.textContent === expected || `${sticky.textContent} ≠ ${expected}`;
    }, PER_DAY)).toBe(true);
  }
  // The newest day comes first: 5000 photos make 715 days from 1 January 2012.
  await page.evaluate(() => scrollTo({top: 0, behavior: 'instant'}));
  await expect(page.locator('#mediaGrid .media-group-heading').first()).toHaveText('15 декабря 2013');
});

/** Page errors and unhandled rejections; the test asserts they stay empty. */
async function watchErrors(page) {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.text().startsWith('unhandledrejection')) errors.push(message.text());
  });
  await page.addInitScript(() => {
    addEventListener('unhandledrejection', event => console.error(`unhandledrejection: ${event.reason}`));
  });
  return errors;
}

test('density changes in a deep grouped list keep the focused tile, its group, and the viewer position', {tag: '@essential'}, async ({page}, testInfo) => {
  test.skip(Boolean(testInfo.project.use.isMobile), 'Desktop densities 3, 5, and 7; the phone density has its own test.');
  const errors = await watchErrors(page);
  await page.emulateMedia({reducedMotion: 'reduce'});
  await page.goto(`/?path=${LARGE}`);
  await expect(page.locator('#mediaGrid .media-card').first()).toBeVisible();
  await expect(page.locator('#gridDensity [data-columns="5"]')).toHaveAttribute('aria-pressed', 'true');
  await chooseGrouping(page, 'day');

  // Deep in the list, take a tile that starts a row and put its top just below the header:
  // it is then the first visible tile, the anchor a density change keeps in place.
  await page.evaluate(() => scrollTo({top: document.documentElement.scrollHeight * 0.6, behavior: 'instant'}));
  let path = null;
  await expect.poll(async () => {
    path = await page.evaluate(() => {
      const grid = document.querySelector('#mediaGrid');
      const left = grid.getBoundingClientRect().left;
      const card = [...grid.querySelectorAll('.media-card:not(.is-window-pinned)')]
        .find(element => Math.abs(element.getBoundingClientRect().left - left) < 1 && element.getBoundingClientRect().top > innerHeight * 0.3);
      return card?.getAttribute('data-path') ?? null;
    });
    return path;
  }).not.toBeNull();
  const target = tile(page, path);
  await target.focus();
  // Top just below the header: the tile is the first visible one, so it is the anchor.
  const align = () => target.evaluate(element => {
    const header = document.querySelector('.topbar').getBoundingClientRect().bottom;
    scrollBy({top: Math.round(element.getBoundingClientRect().top - header - 4), behavior: 'instant'});
  });

  // Position of the tile, the label of its day, and what the window shows around it; runs in the page.
  const probe = () => target.evaluate(async (element, perDay) => {
    const {groupKey, groupLabel} = await import('/date-groups.js');
    const index = Number(element.getAttribute('data-path').match(/IMG_(\d+)/)[1]) - 1;
    const day = groupLabel(groupKey(Date.UTC(2012, 0, 1, 9) / 1000 + Math.floor(index / perDay) * 86_400, 'day'));
    const grid = document.querySelector('#mediaGrid');
    const flowing = [...grid.querySelectorAll('.media-card:not(.is-window-pinned)')];
    const at = flowing.indexOf(element);
    // Newest first: the next tile in the window is the previous file of the list.
    const next = flowing[at + 1]?.getAttribute('data-path') ?? null;
    const sticky = /** @type {HTMLElement} */ (document.querySelector('#mediaGroupHeading'));
    return {
      top: element.getBoundingClientRect().top,
      focused: document.activeElement === element,
      pinned: element.classList.contains('is-window-pinned'),
      inWindow: at >= 0,
      nextIndex: next === null ? null : Number(next.match(/IMG_(\d+)/)[1]) - 1,
      index,
      day,
      sticky: sticky.hidden ? null : sticky.textContent,
      cards: grid.querySelectorAll('.media-card').length,
      headings: grid.querySelectorAll('.media-group-heading').length,
      columns: getComputedStyle(grid).gridTemplateColumns.split(' ').length,
    };
  }, PER_DAY);

  for (const columns of [3, 7]) {
    await align();
    // The sticky label follows the scroll event; it settles on the tile's day.
    await expect.poll(async () => {
      const {sticky, day} = await probe();
      return sticky === day;
    }).toBe(true);
    const before = await probe();
    expect(before.focused).toBe(true);

    await page.locator(`#gridDensity [data-columns="${columns}"]`).evaluate(button => /** @type {HTMLElement} */ (button).click());
    await expect(page.locator(`#gridDensity [data-columns="${columns}"]`)).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(async () => (await probe()).columns).toBe(columns);
    await expect.poll(async () => (await probe()).sticky, `sticky label at ${columns} columns`).toBe(before.day);
    const after = await probe();
    expect(after.focused, `focus stays on ${path} at ${columns} columns`).toBe(true);
    expect(after.pinned, `the window renders the row of ${path} at ${columns} columns`).toBe(false);
    expect(after.inWindow).toBe(true);
    expect(Math.abs(after.top - before.top), `${path} keeps its place at ${columns} columns`).toBeLessThan(2);
    expect(after.sticky, `sticky label at ${columns} columns`).toBe(before.day);
    // Newest first, also across day headings: the next tile on screen is the previous file.
    expect(after.nextIndex).toBe(after.index - 1);
    expect(after.cards).toBeLessThanOrEqual(WINDOW_MIN_ITEMS);
    expect(after.headings).toBeLessThanOrEqual(Math.ceil(WINDOW_MIN_ITEMS / PER_DAY) + 2);

    // The viewer opens at the tile's place in the newest-first list and gives the focus back.
    await page.keyboard.press('Enter');
    await expect(page.locator('#viewer .caption')).toHaveText(`${path.split('/').pop()} · ${LARGE_TOTAL - after.index}/${LARGE_TOTAL}`);
    await page.keyboard.press('ArrowRight');
    expect(await shown(page)).toBe(LARGE_FILES[after.index - 1].path);
    await page.keyboard.press('Escape');
    await expect(page.locator('#viewer')).toBeHidden();
    await expect(target).toBeFocused();
  }
  expect(errors).toEqual([]);
});

test.describe('on a phone', () => {
  test.use({viewport: {width: 360, height: 780}, hasTouch: true});

  test('the control fits the toolbar, works by touch, and leaves the header as it was', {tag: '@essential'}, async ({page}) => {
    await openTrip(page);
    const headerHeight = () => page.locator('.topbar').evaluate(element => element.getBoundingClientRect().height);
    const before = await headerHeight();
    const box = await groupSelect(page).boundingBox();
    const sort = await page.locator('#mediaSort').boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(360);
    // As tall as the sort control on its row; the filter keeps a row of its own.
    expect(Math.abs(box.height - sort.height)).toBeLessThan(1);
    expect(Math.abs(box.y - sort.y)).toBeLessThan(1);
    expect(await page.locator('.media-tools').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);

    await groupSelect(page).tap();
    await expect(groupSelect(page)).toBeFocused();
    await chooseGrouping(page, 'year');
    expect(await visual(page)).toEqual(['# 2026', 'f.mp4', 'e.jpg', 'g.jpg', 'a.jpg', '# 2025', 'b.mp4', 'c.jpg', 'd.jpg']);
    expect(await headerHeight()).toBe(before);
    await tile(page, 'Trip/e.jpg').tap();
    await expect(page.locator('#viewer')).toBeVisible();
    expect(await shown(page)).toBe('Trip/e.jpg');
  });
});
