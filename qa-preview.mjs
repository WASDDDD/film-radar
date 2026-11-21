import { chromium } from '/root/workspace/run/film-radar-qa/node_modules/playwright/index.mjs';

const base = process.env.BASE || 'http://127.0.0.1:18880';
const browser = await chromium.launch();
const out = { base, errors: [], checks: {} };
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
page.on('pageerror', e => out.errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') out.errors.push('console: ' + m.text().slice(0, 200)); });

await page.goto(base, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(2500);
out.checks.homeCards = await page.locator('#home-grid .card, #home-grid article, #home-grid > *').count();
out.checks.scrapeTitle = await page.locator('#scrape-title').innerText().catch(() => '');
out.checks.toggleHidden = await page.locator('#scrape-toggle').evaluate(el => el.hidden).catch(() => null);
out.checks.overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
out.checks.catChips = await page.locator('#home-filters [data-action="filter"], #home-filters button').count().catch(() => 0);
await page.screenshot({ path: '/storage/emulated/0/Download/DSH-Go/2026-11-21_影视雷达/netlify-home.png', fullPage: false });

// 分类筛选
const chip = page.locator('#home-filters >> text=动漫').first();
if (await chip.count()) {
  await chip.click();
  await page.waitForTimeout(3000);
  out.checks.afterCategory = await page.locator('#home-grid > *').count();
}

// 检索
await page.goto(base + '/#search?q=' + encodeURIComponent('让子弹飞'), { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(9000);
out.checks.searchCards = await page.locator('#search-results > *, .search-grid > *').count().catch(() => -1);
await page.screenshot({ path: '/storage/emulated/0/Download/DSH-Go/2026-11-21_影视雷达/netlify-search.png' });

await browser.close();
console.log(JSON.stringify(out, null, 2));
