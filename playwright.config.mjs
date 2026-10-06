import {tmpdir} from 'node:os';
import {join} from 'node:path';

const desktop = {width: 1440, height: 1000};
const runtimeRoot = process.env.LITEGALLERY_E2E_RUNTIME || join(tmpdir(), `litegallery-e2e-${process.pid}`);
const fixtureRoot = join(runtimeRoot, 'gallery');
const cacheRoot = join(runtimeRoot, 'cache');
const artifactRoot = join(runtimeRoot, 'artifacts');
const serverBinary = join(runtimeRoot, 'litegallery-e2e');
const goCacheRoot = join(runtimeRoot, 'go-cache');
const docsMode = process.env.LITEGALLERY_DOC_SCREENSHOTS === '1';
const fixtureSetup = docsMode ? 'tests/e2e/setup-doc-fixtures.mjs' : 'tests/e2e/setup-fixtures.mjs';
const galleryTitle = docsMode ? 'Gallery' : 'E2E Gallery';
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;

export default {
  testDir: './tests/e2e',
  timeout: 45_000,
  expect: {timeout: 8_000},
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['line'], ['html', {open: 'never', outputFolder: join(artifactRoot, 'report')}]] : 'line',
  outputDir: join(artifactRoot, 'results'),
  use: {
    baseURL: 'http://127.0.0.1:18090',
    locale: 'ru-RU',
    timezoneId: 'Europe/Moscow',
    acceptDownloads: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: `node ${fixtureSetup} ${shellQuote(fixtureRoot)} && go build -o ${shellQuote(serverBinary)} . && ${shellQuote(serverBinary)} -root ${shellQuote(fixtureRoot)} -cache ${shellQuote(cacheRoot)} -listen 127.0.0.1:18090 -title ${shellQuote(galleryTitle)}`,
    env: {...process.env, GOCACHE: goCacheRoot},
    url: 'http://127.0.0.1:18090/healthz',
    timeout: 120_000,
    reuseExistingServer: false,
  },
  projects: [
    {name: 'chromium-desktop', use: {browserName: 'chromium', viewport: desktop}},
    {name: 'firefox-desktop', use: {browserName: 'firefox', viewport: desktop}},
    {name: 'webkit-desktop', use: {browserName: 'webkit', viewport: desktop}},
    {name: 'chromium-tablet', use: {browserName: 'chromium', viewport: {width: 1024, height: 900}, hasTouch: true}},
    {name: 'chromium-mobile', use: {browserName: 'chromium', viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true}},
  ],
};
