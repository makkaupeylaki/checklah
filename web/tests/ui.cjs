// UI tests against real local servers (demo, live-empty, demo+auth). Usage: node tests/ui.cjs
// Needs: built frontend (npm run build) and the Python venv at ../.venv.
const { chromium } = require("playwright");
const { spawn, execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "../..");
const PY = path.join(ROOT, ".venv/bin/python");
const SERVER = path.join(ROOT, "server");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "checklah-ui-"));
let failures = 0, passes = 0;
const procs = [];
let browser = null;

function check(name, cond, extra = "") {
  if (cond) { passes++; console.log(`  ok   ${name}`); }
  else { failures++; console.log(`  FAIL ${name} ${extra}`); }
}

async function startServer(port, env) {
  const p = spawn(PY, ["-m", "checklah", "serve"], {
    cwd: SERVER, env: { ...process.env, CHECKLAH_PORT: String(port), CHECKLAH_SEARCH_PER_MINUTE: "1000", ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  p.stdout.on("data", d => (log += d)); p.stderr.on("data", d => (log += d));
  procs.push(p);
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/api/session`); if (r.ok || r.status === 401) return { p, log: () => log }; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error("server did not start:\n" + log);
}

(async () => {
  const demoData = path.join(tmp, "demo-data");
  execFileSync(PY, ["-m", "checklah", "import", "all", "--with-probes"], { cwd: SERVER, env: { ...process.env, CHECKLAH_DATA_DIR: demoData, CHECKLAH_MODE: "demo" } });
  const liveData = path.join(tmp, "live-data");
  fs.mkdirSync(liveData, { recursive: true });
  execFileSync(PY, ["-c", `import sys; sys.path.insert(0, ${JSON.stringify(SERVER)}); from checklah.auth import save_user; from pathlib import Path; save_user(Path(${JSON.stringify(path.join(demoData, "users.json"))}), "alice", "correct horse battery")`]);

  const demo = await startServer(18765, { CHECKLAH_DATA_DIR: demoData, CHECKLAH_MODE: "demo", CHECKLAH_AUTH: "off" });
  const live = await startServer(18766, { CHECKLAH_DATA_DIR: liveData, CHECKLAH_MODE: "live", CHECKLAH_AUTH: "off" });
  const authd = await startServer(18767, { CHECKLAH_DATA_DIR: demoData, CHECKLAH_MODE: "demo", CHECKLAH_AUTH: "local" });

  browser = await chromium.launch();
  const newPage = async (w = 1280) => {
    const ctx = await browser.newContext({ viewport: { width: w, height: 900 } });
    const page = await ctx.newPage();
    const dialogs = [], errors = [], requests = [];
    page.on("dialog", d => { dialogs.push(d.message()); d.dismiss(); });
    page.on("pageerror", e => errors.push(String(e)));
    page.on("console", m => { if (m.type() === "error" && !m.text().includes("status of 500")) errors.push(m.text()); }); // 500s are injected on purpose below
    page.on("request", r => requests.push(r.url()));
    return { ctx, page, dialogs, errors, requests };
  };
  const B = "http://127.0.0.1:18765";

  console.log("demo mode");
  {
    const { ctx, page, dialogs, errors, requests } = await newPage();
    await page.goto(B + "/");
    await page.waitForSelector(".cat");
    check("demo banner visible", await page.isVisible("#demo-banner"));
    check("input has a label", (await page.getByLabel("Name or company").count()) === 1);
    check("theme group labelled", (await page.getByRole("group", { name: "Theme" }).count()) === 1);
    const pr = page.locator('[data-cat="record"]');
    check("public records disabled", await pr.isDisabled());
    check("disabled reason visible", (await page.textContent("#cat-notes")).includes("Not connected: suitable source and reuse terms required"));
    check("reason linked to Sources", (await page.locator('#cat-notes a[href="#/sources"]').count()) >= 1);
    check("no search before submit", !requests.some(u => u.includes("/api/search")));
    await page.fill("#q", "orl");
    await page.waitForTimeout(300);
    check("typing does not search", !requests.some(u => u.includes("/api/search")));

    // keyboard: skip link first, Enter submits
    await page.keyboard.press("Tab");
    await page.goto(B + "/"); await page.waitForSelector(".cat");
    await page.keyboard.press("Tab");
    check("first tab stop is skip link", (await page.evaluate(() => document.activeElement.className)) === "skip");
    await page.focus("#q");
    await page.keyboard.type("Orlo Vantrell");
    await page.keyboard.press("Enter");
    await page.waitForSelector(".res");
    check("enter submits; namesakes both shown", (await page.locator(".res").count()) === 2);
    check("URL has no search terms", !page.url().includes("Orlo") && !page.url().includes("?"));
    check("status announces candidates", (await page.textContent("#status")).includes("A name match is not an identity match"));
    check("no percentages", !/\d+\s?%/.test(await page.textContent("#results")));
    check("reason shown", (await page.textContent(".res")).includes("Name/alias exact match"));
    const btn = page.locator(".res .btn-quiet").first();
    check("review button has accessible name", (await btn.getAttribute("aria-label")).startsWith("Review record: "));
    await btn.focus(); await page.keyboard.press("Enter");
    await page.waitForSelector(".d-sec");
    check("focus moves to detail title", (await page.evaluate(() => document.activeElement.id)) === "d-title");
    check("different-person warning", (await page.textContent("#detail")).includes("This record may refer to a different person. Compare identifiers and the original source."));
    check("passport masked", (await page.textContent("#detail")).includes("masked by CheckLah") && !(await page.textContent("#detail")).includes("DEMO-PX"));
    const links = await page.$$eval("#detail a", as => as.map(a => ({ href: a.href, rel: a.rel, target: a.target, rp: a.getAttribute("referrerpolicy") })));
    check("source links safe", links.length > 0 && links.every(l => /^https?:/.test(l.href) && l.rel.includes("noopener") && l.rel.includes("noreferrer") && l.rp === "no-referrer"));
    await page.keyboard.press("Escape");
    check("escape closes detail", await page.isHidden("#detail"));
    check("focus returns to opener", (await page.evaluate(() => document.activeElement.getAttribute("aria-label") || "")).startsWith("Review record"));

    // clear button
    await page.click("#q-clear");
    check("clear empties input and results", (await page.inputValue("#q")) === "" && (await page.locator(".res").count()) === 0);
    check("focus back in input after clear", (await page.evaluate(() => document.activeElement.id)) === "q");

    // topic filter
    await page.fill("#q", "Orlo Vantrell"); await page.click(".btn-search"); await page.waitForSelector(".res");
    await page.click('[data-topic="pep"]'); await page.waitForTimeout(300);
    check("PEP filter narrows to the PEP record", (await page.locator(".res").count()) === 1 && (await page.textContent(".res")).includes("PEP"));
    await page.click('[data-topic="any"]'); await page.waitForTimeout(300);

    // long name + javascript: link filtered
    await page.fill("#q", "bartholomew"); await page.click(".btn-search"); await page.waitForSelector(".res");
    await page.click(".res .btn-quiet"); await page.waitForSelector(".d-sec");
    check("javascript: link not rendered", (await page.locator('#detail a[href^="javascript"]').count()) === 0);
    check("missing DOB shows Not supplied", (await page.textContent("#detail")).includes("Not supplied"));
    await page.keyboard.press("Escape");

    // stored XSS probe
    await page.fill("#q", "markup probe"); await page.click(".btn-search"); await page.waitForSelector(".res");
    await page.click(".res .btn-quiet"); await page.waitForSelector(".d-sec");
    check("XSS probe rendered as text", (await page.textContent("#results")).includes("<img src=x onerror=alert(1)>"));
    check("no injected elements", (await page.locator("#results img, #detail img, #detail script, #detail b").count()) === 0);
    check("no dialogs fired", dialogs.length === 0, JSON.stringify(dialogs));
    check("data: link dropped", (await page.locator('#detail a[href^="data:"]').count()) === 0);
    await page.keyboard.press("Escape");

    // website listing: defanged, not clickable
    await page.click('[data-mode="identifier"]');
    check("identifier label changes", (await page.textContent("#q-label")) === "UEN, URL or domain");
    await page.fill("#q", "login-verify.example"); await page.click(".btn-search"); await page.waitForSelector(".res");
    check("listed URL defanged", (await page.textContent(".res")).includes("hxxp://login-verify[.]example"));
    check("listed URL is not a link", (await page.locator('a[href*="login-verify"]').count()) === 0);
    check("scope reason shown", (await page.textContent(".res")).includes("listing covers that URL only"));
    check("no 'scam'/'safe' verdict wording", !/\b(scam|safe site|legit|clean record)\b/i.test(await page.textContent("#results")));
    await page.fill("#q", "T99DM0001A"); await page.click(".btn-search"); await page.waitForSelector(".res");
    check("exact UEN reason", (await page.textContent(".res")).includes("Exact UEN"));

    // no-match vs error
    await page.click('[data-mode="name"]');
    await page.fill("#q", "zzqx nobody"); await page.click(".btn-search"); await page.waitForFunction(() => { const s = document.getElementById("state"); return !s.hidden && !s.textContent.includes("Searching"); });
    const empty = await page.textContent("#state");
    check("no-match state wording", empty.includes("No matches in the connected sources.") && empty.includes("This is not proof of a clean record or a safe transaction."));
    await page.route("**/api/search", r => r.fulfill({ status: 500, contentType: "application/json", body: '{"error":"Internal error."}' }));
    await page.click(".btn-search"); await page.waitForSelector(".state-error");
    const err = await page.textContent("#state");
    check("error state distinct from no-match", err.includes("Search failed") && err.includes("not a no-match") && !err.includes("No matches"));
    await page.unroute("**/api/search");

    // stale banner + sources view
    check("stale banner for the stale source only", (await page.locator("#stale .banner").count()) === 1 && (await page.textContent("#stale")).includes("Demo URL Listing Feed"));
    await page.click("#nav-sources"); await page.waitForSelector(".src");
    const src = await page.textContent("#sources-body");
    check("sources: connected and not-connected groups separate", src.includes("Connected") && src.includes("Not connected") && src.includes("OpenSanctions"));
    check("sources: licence + use restriction", src.includes("CC BY-NC 4.0") && src.includes("hobby use only"));
    check("nav aria-current", (await page.getAttribute("#nav-sources", "aria-current")) === "page");

    // themes
    await page.click('[data-theme-set="classic"]');
    check("classic applied", (await page.getAttribute("html", "data-theme")) === "classic");
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    check("classic bg token", bg === "rgb(10, 14, 19)", bg);
    await page.reload();
    check("theme persists across reload (set before first paint)", (await page.getAttribute("html", "data-theme")) === "classic");
    await page.click('[data-theme-set="legacy"]');
    check("legacy bg token", (await page.evaluate(() => getComputedStyle(document.body).backgroundColor)) === "rgb(10, 16, 14)");
    check("aria-pressed tracks theme", (await page.getAttribute('[data-theme-set="legacy"]', "aria-pressed")) === "true");

    check("no third-party requests", requests.every(u => u.startsWith(B) || u.startsWith("data:")), requests.filter(u => !u.startsWith(B)).join(","));
    check("no console errors", errors.length === 0, errors.join(" | "));
    check("no service worker", (await page.evaluate(() => navigator.serviceWorker ? navigator.serviceWorker.getRegistrations().then(r => r.length) : 0)) === 0);
    await ctx.close();
  }

  console.log("phone layout");
  for (const w of [320, 390]) {
    const { ctx, page } = await newPage(w);
    await page.goto(B + "/"); await page.waitForSelector(".cat");
    const noOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    check(`${w}px: no horizontal overflow`, noOverflow);
    const clipped = await page.$$eval(".cat", els => els.some(e => { const r = e.getBoundingClientRect(); return r.right > window.innerWidth || r.left < 0; }));
    check(`${w}px: category filters not clipped`, !clipped);
    await page.fill("#q", "bartholomew"); await page.click(".btn-search"); await page.waitForSelector(".res");
    await page.click(".res .btn-quiet"); await page.waitForSelector(".d-sec");
    const box = await page.locator("#detail").boundingBox();
    check(`${w}px: detail is full screen`, box.x === 0 && Math.round(box.width) === w);
    check(`${w}px: still no overflow with detail`, await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    const fs_ = await page.evaluate(() => parseFloat(getComputedStyle(document.body).fontSize));
    check(`${w}px: body text >= 14px`, fs_ >= 14);
    await ctx.close();
  }

  console.log("live mode (no sources imported)");
  {
    const { ctx, page } = await newPage();
    await page.goto("http://127.0.0.1:18766/"); await page.waitForSelector(".cat");
    check("no demo banner in live mode", await page.isHidden("#demo-banner"));
    check("all categories disabled with reasons", (await page.locator(".cat:disabled").count()) === 4);
    await page.fill("#q", "Orlo Vantrell"); await page.click(".btn-search"); await page.waitForFunction(() => { const s = document.getElementById("state"); return !s.hidden && !s.textContent.includes("Searching"); });
    const t = await page.textContent("#state");
    check("not-connected state, not a no-match", t.includes("No connected source covers this search") && !t.includes("No matches in the connected"));
    check("no demo rows in live mode", (await page.locator(".res").count()) === 0);
    await ctx.close();
  }

  console.log("auth mode");
  {
    const { ctx, page } = await newPage();
    const A = "http://127.0.0.1:18767";
    await page.goto(A + "/"); await page.waitForSelector("#view-login:not([hidden])");
    check("login view shown, search hidden", await page.isHidden("#view-search"));
    const api = await page.evaluate(async () => (await fetch("/api/sources")).status);
    check("direct API call unauthorised", api === 401);
    await page.fill("#login-user", "alice"); await page.fill("#login-pass", "wrong password"); await page.click("#login-form .btn-primary");
    await page.waitForSelector("#login-error:not([hidden])");
    check("wrong password message", (await page.textContent("#login-error")).includes("Wrong username or password"));
    await page.fill("#login-pass", "correct horse battery"); await page.click("#login-form .btn-primary");
    await page.waitForSelector("#view-search:not([hidden])");
    check("signed in shows account", (await page.textContent("#account-user")) === "alice");
    const cookies = await ctx.cookies();
    const sc = cookies.find(c => c.name === "checklah_session");
    check("session cookie HttpOnly + SameSite=Strict", sc && sc.httpOnly && sc.sameSite === "Strict");
    await page.fill("#q", "orlo"); await page.click(".btn-search"); await page.waitForSelector(".res");
    await page.click("#logout"); await page.waitForSelector("#view-login:not([hidden])");
    check("sign out returns to login and clears results", (await page.locator(".res").count()) === 0);
    check("API locked again after logout", (await page.evaluate(async () => (await fetch("/api/sources")).status)) === 401);
    await ctx.close();
  }

  const logs = demo.log() + authd.log();
  check("server logs contain no search terms", !/Orlo|Vantrell|bartholomew|markup|zzqx|T99DM|login-verify/i.test(logs));

  await browser.close();
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exitCode = failures ? 1 : 0;
})().catch(e => { console.error(e); process.exitCode = 1; })
  .finally(async () => { if (browser) await browser.close().catch(() => {}); procs.forEach(p => p.kill()); fs.rmSync(tmp, { recursive: true, force: true }); });
