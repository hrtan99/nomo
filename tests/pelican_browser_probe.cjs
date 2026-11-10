const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright-core');

(async () => {
  const file = path.resolve(process.argv[2]);
  const evidence = path.resolve(process.argv[3]);
  const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const errors = [], external = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url())) external.push(request.url()); });
  const frame = () => page.locator('svg').evaluate(svg => [...svg.querySelectorAll('*')].map(node => [node.getAttribute('transform'), getComputedStyle(node).transform]));
  try {
    await page.goto(pathToFileURL(file).href);
    assert.ok(await page.locator('svg').count());
    assert.match(await page.locator('body').innerText(), /鹈鹕/);
    const start = await frame();
    await page.waitForTimeout(350);
    assert.notDeepEqual(await frame(), start, 'SVG animation must advance');
    await page.getByRole('button', { name: /暂停/ }).click();
    await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState === 'paused'));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const paused = await frame();
    await page.waitForTimeout(350);
    assert.deepEqual(await frame(), paused, 'pause must stop SVG animation');
    await page.getByRole('button', { name: /继续/ }).click();
    await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState === 'running'));
    await page.waitForTimeout(350);
    assert.notDeepEqual(await frame(), paused, 'resume must restart animation');
    await page.screenshot({ path: path.join(evidence, 'desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'mobile viewport must not overflow');
    await page.screenshot({ path: path.join(evidence, 'mobile.png'), fullPage: true });
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    const result = { status: 'passed', file, bytes: fs.statSync(file).size, animation: true, pause_resume: true, mobile: true, page_errors: errors, external_requests: external };
    fs.writeFileSync(path.join(evidence, 'browser-result.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
