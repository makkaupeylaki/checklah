// Worker API and security tests. The fetch handler runs in Node; D1 runs in local workerd.
// Port of Stage 1 server/tests/test_security.py plus Workers-specific durability checks.
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Db } from "../src/db.ts";
import { hashPassword, revokeUser } from "../src/auth.ts";
import { runImport } from "../src/importer/lifecycle.ts";
import { demoPrepared } from "../src/importer/demo.ts";
import { Client, envFor, importDemo, migrate, openTestDb, reset } from "./helpers.ts";

let db: Db, dispose: () => Promise<void>;
let HASH = "";
before(async () => { ({ db, dispose } = await openTestDb()); HASH = await hashPassword("correct horse battery"); });
after(async () => { await dispose(); });
beforeEach(async () => {
  await reset(db);
  await importDemo(db);
  await db.prepare("INSERT INTO users (username, pw_hash, created_at) VALUES ('alice', ?, '2026-11-16')").bind(HASH).run();
});

const SEARCH = { q: "Orlo Vantrell", mode: "name" };
const authEnv = () => envFor(db, { AUTH: "local", ALLOW_LOOPBACK_NO_AUTH: "false" });
async function login(c: Client, password = "correct horse battery") {
  await c.session();
  const r = await c.post("/api/login", { username: "alice", password });
  if (r.ok) c.csrf = ((await r.clone().json()) as { csrf: string }).csrf;
  return r;
}

test("security headers, no-store, robots", async () => {
  const c = new Client(envFor(db));
  const r = await c.req("/api/sources");
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("Cache-Control"), "no-store");
  for (const h of ["Content-Security-Policy", "X-Content-Type-Options", "X-Frame-Options", "Referrer-Policy", "Cross-Origin-Opener-Policy", "Permissions-Policy", "X-Robots-Tag"]) assert.ok(r.headers.get(h), h);
  assert.match(r.headers.get("Content-Security-Policy")!, /script-src 'self'/);
  assert.doesNotMatch(r.headers.get("Content-Security-Policy")!, /unsafe-inline/);
  const html = await c.req("/");
  assert.equal(html.headers.get("Cache-Control"), "no-store");
  assert.ok(html.headers.get("Content-Security-Policy"));
  assert.match(await (await c.req("/robots.txt")).text(), /Disallow: \//);
});

test("query strings, methods, export/doc endpoints, body limits", async () => {
  const c = new Client(envFor(db));
  await c.session();
  assert.equal((await c.req("/api/sources?q=Orlo")).status, 400);
  for (const p of ["/api/export", "/api/export.csv", "/api/dump", "/api/records", "/api/openapi.json"]) assert.equal((await c.req(p)).status, 404, p);
  assert.equal((await c.req("/api/search", { method: "PUT" })).status, 405);
  assert.equal((await c.req("/api/record", { method: "DELETE" })).status, 405);
  assert.equal((await c.req("/api/record/demo-watchlist:DEMO-P-0001")).status, 404, "IDs are never accepted in URL paths");
  assert.equal((await c.post("/api/search", { q: "x".repeat(5000) })).status, 413);
  assert.equal((await c.post("/api/search", { q: "SECRETNAME".repeat(30) })).status, 422);
  const r = await c.post("/api/search", { q: "a", country: "sg'--" });
  assert.equal(r.status, 422);
  assert.ok(!(await r.text()).includes("sg'--"), "validation errors do not echo input");
  assert.equal((await c.req("/api/search", { method: "POST", body: "q=x", headers: { "Content-Type": "application/x-www-form-urlencoded", "X-CheckLah-CSRF": c.csrf } })).status, 415);
});

test("CSRF double-submit and same-origin checks (auth off, loopback)", async () => {
  const c = new Client(envFor(db));
  assert.equal((await c.post("/api/search", SEARCH)).status, 403, "no token yet");
  await c.session();
  assert.equal((await c.post("/api/search", SEARCH)).status, 200);
  assert.equal((await c.post("/api/search", SEARCH, { "X-CheckLah-CSRF": "nope" })).status, 403);
  assert.equal((await c.post("/api/search", SEARCH, { Origin: "https://evil.example" })).status, 403);
  assert.equal((await c.post("/api/search", SEARCH, { "Sec-Fetch-Site": "cross-site" })).status, 403);
});

test("hosted configuration fails closed without auth", async () => {
  const hosted = new Client(envFor(db), "https://checklah.example.org");
  assert.equal((await hosted.req("/api/session")).status, 503);
  assert.equal((await hosted.req("/")).status, 503, "static assets too");
  const noFlag = new Client(envFor(db, { ALLOW_LOOPBACK_NO_AUTH: "false" }));
  assert.equal((await noFlag.req("/api/sources")).status, 503);
  const spoof = new Client(envFor(db));
  assert.equal((await spoof.req("/api/sources", { headers: { "CF-Connecting-IP": "203.0.113.9" } })).status, 503, "edge traffic is never loopback");
  const bad = new Client(envFor(db, { AUTH: "maybe" }));
  assert.equal((await bad.req("/api/sources")).status, 503);
});

test("auth: unauthenticated API refused; login, secure cookies, logout", async () => {
  const c = new Client(authEnv(), "https://checklah.example.org");
  assert.equal((await c.req("/api/sources")).status, 401);
  assert.equal((await c.req("/api/record", { method: "POST", json: { id: "demo-watchlist:DEMO-P-0001" } })).status, 401);
  assert.equal(((await c.session()) as unknown as { authenticated: boolean }).authenticated, false);
  assert.equal((await c.post("/api/search", SEARCH)).status, 401);
  assert.equal((await login(c, "wrong")).status, 401);
  const r = await login(c);
  assert.equal(r.status, 200);
  const cookie = r.headers.getSetCookie().find(x => x.startsWith("__Host-checklah_session="))!;
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /Path=\//);
  assert.equal((await c.post("/api/search", SEARCH)).status, 200);
  assert.equal((await c.post("/api/record", { id: "demo-watchlist:DEMO-P-0001" })).status, 200);
  const stored = await db.prepare("SELECT token_hash FROM sessions").all<{ token_hash: string }>();
  const raw = c.jar.get("__Host-checklah_session")!;
  assert.ok(!stored.results.some(s => s.token_hash === raw), "only the token hash is stored");
  assert.equal((await c.post("/api/logout", {})).status, 200);
  assert.equal((await c.req("/api/sources")).status, 401);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM sessions").first<{ n: number }>())!.n, 0);
});

test("auth: idle and absolute expiry; per-user revocation; disabled user", async () => {
  const c = new Client(authEnv());
  await login(c);
  await db.prepare("UPDATE sessions SET last_seen = last_seen - 31 * 60 * 1000").run();
  assert.equal((await c.req("/api/sources")).status, 401, "idle expiry");
  await login(c);
  await db.prepare("UPDATE sessions SET expires_at = 1").run();
  assert.equal((await c.req("/api/sources")).status, 401, "absolute expiry");
  await login(c);
  const other = new Client(authEnv());
  await login(other);
  await revokeUser(db, "alice");
  assert.equal((await c.req("/api/sources")).status, 401, "revoked");
  assert.equal((await other.req("/api/sources")).status, 401, "all of the user's sessions revoked");
  await login(c);
  await db.prepare("UPDATE users SET disabled = 1").run();
  assert.equal((await c.req("/api/sources")).status, 401, "disabled user");
});

test("auth: login rate limit and CSRF on login", async () => {
  const c = new Client(authEnv());
  const codes: number[] = [];
  for (let i = 0; i < 6; i++) codes.push((await login(c, "wrong")).status);
  assert.deepEqual(codes, [401, 401, 401, 401, 401, 429]);
  const d = new Client(authEnv());
  assert.equal((await d.req("/api/login", { method: "POST", json: { username: "alice", password: "correct horse battery" } })).status, 403);
});

test("search rate limit is durable (D1) and shared across handler instances", async () => {
  const e1 = envFor(db, { SEARCH_PER_MINUTE: "3" });
  const a = new Client(e1), b = new Client(envFor(db, { SEARCH_PER_MINUTE: "3" }));
  await a.session(); await b.session();
  const codes = [(await a.post("/api/search", SEARCH)).status, (await b.post("/api/search", SEARCH)).status, (await a.post("/api/search", SEARCH)).status, (await b.post("/api/search", SEARCH)).status];
  assert.deepEqual(codes, [200, 200, 200, 429]);
  const rows = await db.prepare("SELECT bucket FROM rate_limits").all<{ bucket: string }>();
  assert.ok(rows.results.every(r => !/Orlo|127\.0\.0\.1/.test(r.bucket)), "limiter keys hold no search text or raw address");
});

test("cross-instance sessions: two separate local runtimes sharing one persisted D1", async () => {
  const dir = mkdtempSync(join(tmpdir(), "checklah-x-"));
  const A = await openTestDb("demo", dir), B = await openTestDb("demo", dir);
  try {
    await migrate(A.db, "demo");
    await A.db.prepare("INSERT INTO users (username, pw_hash, created_at) VALUES ('alice', ?, 'x')").bind(HASH).run();
    await runImport(A.db, "demo-registry", demoPrepared("demo-registry"));
    const onA = new Client(envFor(A.db, { AUTH: "local", ALLOW_LOOPBACK_NO_AUTH: "false" }));
    await onA.session();
    const r = await onA.post("/api/login", { username: "alice", password: "correct horse battery" });
    onA.csrf = ((await r.json()) as { csrf: string }).csrf;
    const onB = new Client(envFor(B.db, { AUTH: "local", ALLOW_LOOPBACK_NO_AUTH: "false" }));
    onB.jar = new Map(onA.jar); onB.csrf = onA.csrf;
    assert.equal((await onB.req("/api/sources")).status, 200, "session created on A is valid on B");
    assert.equal((await onB.post("/api/logout", {})).status, 200);
    assert.equal((await onA.req("/api/sources")).status, 401, "logout on B is seen by A");
  } finally {
    await A.dispose(); await B.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("demo/live isolation is enforced by the database stamp, even on direct API calls", async () => {
  const live = new Client(envFor(db, { MODE: "live" }));
  const r = await live.req("/api/sources");
  assert.equal(r.status, 503);
  assert.match(await r.text(), /mode does not match/);
  await db.prepare("DELETE FROM app_meta").run();
  assert.equal((await new Client(envFor(db)).req("/api/sources")).status, 503, "unstamped database refuses to serve");
});

test("no query, identifier or record-ID text in logs", async () => {
  const logs: string[] = [];
  const orig = { log: console.log, error: console.error };
  console.log = (...a: unknown[]) => { logs.push(a.join(" ")); };
  console.error = (...a: unknown[]) => { logs.push(a.join(" ")); };
  try {
    const c = new Client(envFor(db));
    await c.session();
    await c.post("/api/search", { q: "Severin Aldaq 1959-01-01 S1234567D" });
    await c.post("/api/search", { q: "x".repeat(500) });
    await c.post("/api/record", { id: "demo-watchlist:DEMO-P-0001" });
    await c.req("/api/sources?q=Severin");
  } finally { console.log = orig.log; console.error = orig.error; }
  const text = logs.join("\n");
  assert.match(text, /POST \/api\/search 200/);
  assert.match(text, /POST \/api\/record 200/);
  for (const leak of ["Severin", "Aldaq", "1959", "S1234567D", "DEMO-P-0001", "xxxxx"]) assert.ok(!text.includes(leak), leak);
});

test("API responses never contain secrets or raw rows; XSS probe is plain data", async () => {
  const c = new Client(authEnv());
  await login(c);
  const s = await (await c.req("/api/session")).text();
  assert.ok(!/pw_hash|scrypt\$|token_hash/.test(s));
  const r = await (await c.post("/api/record", { id: "demo-watchlist:DEMO-P-0999" })).json() as { caption: string; links: unknown[] };
  assert.equal(r.caption, "Markup Probe <img src=x onerror=alert(1)>");
  assert.deepEqual(r.links, []);
  const body = await (await c.post("/api/record", { id: "demo-watchlist:DEMO-P-0001" })).text();
  assert.ok(!body.includes("DEMO-PX-0001") && !body.includes('"raw"'));
});
