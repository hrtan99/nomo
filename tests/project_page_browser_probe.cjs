const assert = require('node:assert/strict');
const {pathToFileURL} = require('node:url');
const {chromium} = require('playwright');

(async () => {
  const browser = await chromium.launch({headless:true, executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
  try {
    const page = await browser.newPage({viewport:{width:390,height:844}});
    const errors = [], external = [];
    page.on('pageerror', error => errors.push(String(error)));
    page.on('request', request => { if (/^https?:/.test(request.url())) external.push(request.url()); });
    await page.goto(pathToFileURL(process.argv[2]).href);
    await page.waitForTimeout(250);
    const states = () => page.evaluate(() => document.getAnimations().filter(item => item instanceof CSSAnimation).map(item => item.playState));
    const running = await states();
    assert(running.length > 0 && running.some(value => value === 'running'), 'CSS animation is running');
    const button = page.getByRole('button').first();
    assert.match(await button.innerText(), /暂停|pause/i);
    await button.click();
    await page.waitForTimeout(250);
    const paused = await states();
    assert(paused.length > 0 && paused.every(value => value === 'paused'), 'button pauses the animation');
    await button.click();
    await page.waitForTimeout(250);
    assert((await states()).some(value => value === 'running'), 'button resumes animation');
    assert(await page.locator('svg').count() > 0, 'inline SVG exists');
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'mobile layout has no horizontal overflow');
    assert.equal(errors.length, 0, 'no JavaScript errors');
    assert.equal(external.length, 0, 'no external requests');
    if (process.argv[3]) await page.screenshot({path:process.argv[3],fullPage:true});
    console.log(JSON.stringify({status:'passed',animations:running.length,paused:true,resumed:true,mobileWidth:390,errors,external}));
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode=1; });
