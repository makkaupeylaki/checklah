// Screenshots at 320/390/768/1280 in both themes. Usage: node tests/shots.cjs [baseURL] [outDir]
const { chromium } = require("playwright");
const path = require("path");
const BASE = process.argv[2] || "http://127.0.0.1:8765";
const OUT = process.argv[3] || path.join(__dirname, "../../docs/screenshots");
const SCALE = Number(process.env.SCALE || 1);

(async () => {
  const browser = await chromium.launch();
  for (const theme of ["legacy", "classic"]) {
    for (const w of [320, 390, 768, 1280]) {
      const ctx = await browser.newContext({ viewport: { width: w, height: 900 }, deviceScaleFactor: SCALE });
      await ctx.addInitScript(t => { try { localStorage.setItem("checklah-theme", t); } catch (e) {} }, theme);
      const page = await ctx.newPage();
      // Detail is a fixed full-screen view below 960px: capture the viewport there, not the full page.
      const shot = async (name, full = true) => page.screenshot({ path: path.join(OUT, `${theme}-${w}-${name}.png`), fullPage: full });
      await page.goto(BASE + "/");
      await page.waitForSelector(".cat");
      await shot("1-home");
      await page.fill("#q", "vantrell");
      await page.click(".btn-search");
      await page.waitForSelector(".res");
      await shot("2-results");
      await page.click(".res .btn-quiet");
      await page.waitForSelector(".d-sec");
      await shot("3-detail", w > 960);
      await page.keyboard.press("Escape");
      await page.fill("#q", "bartholomew");
      await page.click(".btn-search");
      await page.waitForSelector(".res");
      await page.click(".res .btn-quiet");
      await page.waitForSelector(".d-sec");
      await shot("4-long-detail", w > 960);
      await page.keyboard.press("Escape");
      await page.fill("#q", "zzqx nobody");
      await page.click(".btn-search");
      await page.waitForFunction(() => { const s = document.getElementById("state"); return !s.hidden && !s.textContent.includes("Searching"); });
      await shot("5-empty");
      await page.click('[data-mode="identifier"]');
      await page.fill("#q", "login-verify.example");
      await page.click(".btn-search");
      await page.waitForSelector(".res");
      await page.click(".res .btn-quiet");
      await page.waitForSelector(".d-sec");
      await shot("6-website", w > 960);
      await page.goto(BASE + "/#/sources");
      await page.waitForSelector(".src");
      await shot("7-sources");
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      if (overflow) console.log(`OVERFLOW ${theme} ${w}`);
      await ctx.close();
    }
  }
  await browser.close();
  console.log("done");
})().catch(e => { console.error(e); process.exit(1); });
