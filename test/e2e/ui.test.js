'use strict';

/**
 * Browser tests: drive the real app in Chromium to catch UI regressions.
 * Run with `npm run test:e2e`. Needs a Chromium build for Playwright
 * (`npx playwright-core install chromium` once, or set CHROMIUM_PATH).
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const { openDb } = require('../../src/db');
const { createApp } = require('../../src/app');
const { seedIfEmpty, DEMO_PASSWORD } = require('../../src/seed');

let server;
let base;
let browser;

before(async () => {
  const db = openDb(':memory:');
  seedIfEmpty(db, { log: false });
  server = createApp(db).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
});

after(async () => {
  await browser?.close();
  server?.close();
});

/** A fresh page that fails the test on any console error or uncaught exception. */
async function newPage(t, options = {}) {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  t.after(async () => {
    await context.close();
    assert.deepEqual(errors, [], 'no console errors');
  });
  return page;
}

async function login(page, email) {
  await page.goto(`${base}/#/login`);
  await page.fill('input[name=email]', email);
  await page.fill('input[name=password]', DEMO_PASSWORD);
  await page.click('button[type=submit]');
  await page.waitForSelector('#nav >> text=Log out');
}

test('home: search narrows the university cards and opens a university', async (t) => {
  const page = await newPage(t);
  await page.goto(base);
  await page.waitForSelector('.uni-card');
  assert.ok((await page.locator('.uni-card').count()) >= 10);
  assert.equal(await page.locator('.uni-card', { hasText: 'University of Toronto' }).locator('.active-flag').count(), 1);

  await page.fill('input[name=q]', 'toronto');
  await page.press('input[name=q]', 'Enter');
  await page.waitForSelector('text=1 result for “toronto”');
  assert.equal(await page.locator('.uni-card').count(), 1);

  await page.click('.uni-card');
  await page.waitForSelector('h2#board');
  assert.equal(await page.locator('h1').textContent(), 'University of Toronto');
  assert.match(await page.locator('.fact-big').textContent(), /62,000/);
});

test('question: the official answer shows the university name with a verified check', async (t) => {
  const page = await newPage(t);
  await page.goto(`${base}/#/q/1`);
  const official = page.locator('.answer.official');
  await official.waitFor();
  assert.match(await official.locator('.byline .name').textContent(), /University of Toronto/);
  assert.equal(await official.locator('svg[aria-label="Verified university account"]').count(), 1);
  assert.equal(await page.locator('.answer .student', { hasText: 'Current student' }).count(), 1);
  // Logged-out visitors can read but are asked to log in to answer.
  assert.equal(await page.locator('.reply >> text=Log in').count(), 1);
});

test('signed in: ask a question, then message a connection', async (t) => {
  const page = await newPage(t);
  await login(page, 'priya@example.com');

  await page.goto(`${base}/#/u/2`);
  await page.fill('input[name=title]', 'Is there a buddy program for new international students?');
  await page.fill('textarea[name=body]', 'Wondering about orientation.');
  await page.click('form.ask button[type=submit]');
  await page.waitForSelector('h1 >> text=buddy program');

  await page.goto(`${base}/#/connections`);
  await page.click('.convo >> text=Maria');
  await page.fill('textarea[name=body]', 'Hello from the browser test');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.msg.mine >> text=Hello from the browser test');
});

test('network requires a profile and lists people for signed-in students', async (t) => {
  const page = await newPage(t);
  await page.goto(`${base}/#/network`);
  await page.waitForSelector('text=Log in to');
  await login(page, 'priya@example.com');
  await page.goto(`${base}/#/network`);
  await page.waitForSelector('.person');
  assert.ok((await page.locator('.person').count()) >= 3);
  assert.equal(await page.locator('.request', { hasText: 'Arjun wants to connect' }).count(), 1);
});

test('mobile and dark mode: pages fit the screen without sideways scrolling', async (t) => {
  const page = await newPage(t, { viewport: { width: 390, height: 844 }, colorScheme: 'dark' });
  for (const hash of ['#/', '#/u/1', '#/q/1', '#/login']) {
    await page.goto(`${base}/${hash}`);
    await page.waitForSelector('main#app > *');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 0, `${hash} overflows by ${overflow}px`);
  }
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  assert.equal(bg, 'rgb(23, 17, 13)');
});
