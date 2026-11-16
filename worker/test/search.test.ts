// Port of Stage 1 server/tests/test_search.py onto D1 + generation-aware search.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { Db } from "../src/db.ts";
import { record, search, sourcesView, PAGE_SIZE, type Query } from "../src/search.ts";
import { runImport } from "../src/importer/lifecycle.ts";
import { importDemo, openTestDb, reset } from "./helpers.ts";
import type { SourceRecord } from "../src/importer/records.ts";

let db: Db, dispose: () => Promise<void>;
before(async () => { ({ db, dispose } = await openTestDb()); await reset(db); await importDemo(db); });
after(async () => { await dispose(); });

const Q = (text: string, o: Partial<Query> = {}): Query => ({ text, mode: "name", category: "all", country: "", topic: "any", ...o });
const pairs = (r: { results: { id: string; reason: string }[] }) => r.results.map(x => [x.id, x.reason]);
const ids = (r: { results: { id: string }[] }) => new Set(r.results.map(x => x.id));

test("namesake collision returns separate records, no scores", async () => {
  const r = await search(db, "demo", Q("Orlo Vantrell"));
  assert.ok(ids(r).has("demo-watchlist:DEMO-P-0001") && ids(r).has("demo-watchlist:DEMO-P-0002"));
  for (const x of r.results) {
    assert.equal(x.reason, "Name/alias exact match");
    assert.ok(!("score" in x) && !("confidence" in x) && !("_k" in x));
  }
});

test("PEP and sanctions are separate filters", async () => {
  assert.deepEqual(ids(await search(db, "demo", Q("Orlo Vantrell", { topic: "pep" }))), new Set(["demo-watchlist:DEMO-P-0002"]));
  assert.deepEqual(ids(await search(db, "demo", Q("Orlo Vantrell", { topic: "sanction" }))), new Set(["demo-watchlist:DEMO-P-0001"]));
  const both = (await search(db, "demo", Q("Severin Aldaq"))).results[0];
  assert.deepEqual(new Set(both.topics.map(t => t.class)), new Set(["pep", "sanction"]));
});

test("exact UEN, only the registry", async () => {
  assert.deepEqual(pairs(await search(db, "demo", Q("t99dm0001a", { mode: "identifier" }))), [["demo-registry:T99DM0001A", "Exact UEN"]]);
});

test("similar names in different sources are not merged", async () => {
  const r = await search(db, "demo", Q("vantrell trading", { category: "company" }));
  assert.ok(ids(r).has("demo-registry:T99DM0001A") && ids(r).has("demo-watchlist:DEMO-C-0101"));
  assert.deepEqual((await record(db, "demo", "demo-registry:T99DM0001A"))!.topics, []);
});

test("aliases and Unicode", async () => {
  assert.equal((await search(db, "demo", Q("jozefina strelvaq"))).results[0].id, "demo-watchlist:DEMO-P-0003");
  assert.equal((await search(db, "demo", Q("Józefína"))).results[0].id, "demo-watchlist:DEMO-P-0003");
  const cy = await search(db, "demo", Q("Вантрелл"));
  assert.equal(cy.results[0].id, "demo-watchlist:DEMO-P-0001");
  assert.equal(cy.results[0].matched_name, "Орло Вантрелл");
  assert.equal((await search(db, "demo", Q("ananda lotus investments"))).results[0].id, "demo-registry:T99DM0003C");
});

test("prefix tier, then possible-similar tier", async () => {
  const p = await search(db, "demo", Q("vant"));
  assert.ok(p.total >= 4 && p.results.every(x => x.reason === "Name/alias prefix match"));
  const s = await search(db, "demo", Q("Severin Aldak"));
  assert.deepEqual(pairs(s), [["demo-watchlist:DEMO-P-0005", "Possible similar name"]]);
  const none = await search(db, "demo", Q("Qzxv Plorb"));
  assert.equal(none.total, 0);
});

test("country and category filters", async () => {
  assert.deepEqual(ids(await search(db, "demo", Q("orlo", { country: "nz" }))), new Set(["demo-watchlist:DEMO-P-0002"]));
  assert.equal((await search(db, "demo", Q("orlo", { category: "company" }))).total, 0);
});

test("URL listing scope is never widened", async () => {
  assert.deepEqual(pairs(await search(db, "demo", Q("http://login-verify.example/secure/account?id=1", { mode: "identifier" }))), [["demo-webfeed:DEMO-U-0001", "Exact URL listing"]]);
  assert.equal((await search(db, "demo", Q("http://login-verify.example/other", { mode: "identifier" }))).total, 0);
  assert.deepEqual(pairs(await search(db, "demo", Q("login-verify.example", { mode: "identifier" }))), [["demo-webfeed:DEMO-U-0001", "URL on this host (listing covers that URL only)"]]);
  assert.deepEqual(pairs(await search(db, "demo", Q("https://malware-drop.test/any/path", { mode: "identifier" }))), [["demo-webfeed:DEMO-U-0002", "Host listed by source"]]);
});

test("malicious and invalid input is inert", async () => {
  for (const q of ['"', '" OR 1=1 --', "NEAR(orlo vantrell)", "orlo*", "*", "'; DROP TABLE entities; --", "\u0000\u0001", "a".repeat(500), "orlo OR severin", "-orlo", "names_fts:orlo", 'g : "g1"']) {
    const r = await search(db, "demo", Q(q));
    assert.ok(Array.isArray(r.results));
  }
  assert.equal((await search(db, "demo", Q("orlo OR severin"))).results.filter(x => x.reason !== "Possible similar name").length, 0, "OR is literal text");
  assert.ok((await search(db, "demo", Q("not a uen", { mode: "identifier" }))).notice);
  assert.ok((await search(db, "demo", Q("   "))).notice);
  const n = await db.prepare("SELECT COUNT(*) AS n FROM entities").first<{ n: number }>();
  assert.ok(n!.n > 0, "tables intact");
});

test("detail masks sensitive identifiers and filters links; never returns raw rows", async () => {
  const d = (await record(db, "demo", "demo-watchlist:DEMO-P-0001"))!;
  const pp = d.identifiers.find(i => i.type === "passport")!;
  assert.ok(pp.masked && pp.value === null);
  assert.ok(!JSON.stringify(d).includes("DEMO-PX-0001"));
  const d4 = (await record(db, "demo", "demo-watchlist:DEMO-P-0004"))!;
  assert.ok(d4.links.every(l => l.url.startsWith("https://")));
  assert.ok(!d4.dates.some(x => x.type === "birth"));
  assert.deepEqual((await record(db, "demo", "demo-watchlist:DEMO-P-0999"))!.links, []);
  assert.equal((await record(db, "demo", "demo-watchlist:DEMO-P-0002"))!.dates[0].precision, "year");
  assert.equal((await record(db, "demo", "demo-watchlist:DEMO-P-0003"))!.dates[0].precision, "month");
});

test("referents resolve; unknown, cross-mode and path-like IDs do not", async () => {
  const d = (await record(db, "demo", "demo-watchlist:DEMO-C-0199"))!;
  assert.equal(d.id, "demo-watchlist:DEMO-C-0102");
  assert.equal(d.resolved_from, "demo-watchlist:DEMO-C-0199");
  assert.equal(await record(db, "demo", "demo-watchlist:NOPE"), null);
  assert.equal(await record(db, "demo", "../../etc/passwd"), null);
  assert.equal(await record(db, "demo", "acra:T99DM0001A"), null);
  assert.equal(await record(db, "live", "demo-watchlist:DEMO-P-0001"), null, "live mode never reads demo sources");
});

test("categories disabled with reason; live connectors listed in demo; staleness per source", async () => {
  const v = await sourcesView(db, "demo");
  const cats = Object.fromEntries(v.categories.map(c => [c.id, c]));
  assert.equal(cats.record.enabled, false);
  assert.match(String(cats.record.reason), /Not connected/);
  const st = Object.fromEntries(v.sources.map(s => [s.id, s.state]));
  assert.equal(st.acra, "not_loaded");
  assert.equal(st.opensanctions, "not_loaded");
  assert.equal(st["demo-webfeed"], "stale");
  assert.equal(st["demo-watchlist"], "connected");
});

test("live mode with no imported source: nothing connected, nothing searched, no demo fallback", async () => {
  const v = await sourcesView(db, "live");
  assert.ok(v.categories.every(c => !c.enabled));
  assert.ok(!v.sources.some(s => String(s.id).startsWith("demo")));
  const st = Object.fromEntries(v.sources.map(s => [s.id, s.state]));
  assert.equal(st.acra, "not_imported", "an empty source is never called connected");
  const r = await search(db, "live", Q("Orlo Vantrell"));
  assert.equal(r.total, 0);
  assert.equal(r.searched.length, 0);
});

test("keyset pagination: stable, complete, no duplicates, bounded", async () => {
  // A dedicated source generation with many namesakes, imported through the real lifecycle.
  const many: SourceRecord[] = Array.from({ length: 57 }, (_, i) => ({
    id: `demo-registry:T99DM${String(9000 + i).padStart(4, "0")}Z`, kind: "company", schema: "Company", caption: `PAGINATION PROBE ${String(i).padStart(2, "0")} PTE. LTD.`,
    names: [], countries: ["sg"], topics: [], datasets: [], identifiers: [], dates: [], links: [], properties: {}, provenance: {}, referents: [],
  }));
  await runImport(db, "demo-registry", { upstream: { version: "p" }, scope: null, async *records() { for (const r of many) yield structuredClone(r); } }, { policy: { allowShrink: true } });
  const seen: string[] = [];
  let cursor: string | null = null, pages = 0;
  do {
    const r = await search(db, "demo", Q("pagination probe", { cursor }));
    assert.ok(r.results.length <= PAGE_SIZE);
    seen.push(...r.results.map(x => x.id));
    cursor = r.next_cursor as string | null;
    pages++;
  } while (cursor && pages < 10);
  assert.equal(pages, 3);
  assert.equal(seen.length, 57);
  assert.equal(new Set(seen).size, 57);
  const again = await search(db, "demo", Q("pagination probe"));
  assert.deepEqual(again.results.map(x => x.id), seen.slice(0, PAGE_SIZE), "stable ordering");
  const bad = await search(db, "demo", Q("pagination probe", { cursor: "not-a-cursor" }));
  assert.deepEqual(bad.results.map(x => x.id), seen.slice(0, PAGE_SIZE), "invalid cursor restarts at page 1");
});

test("active-generation isolation: search and detail ignore staging/previous rows", async () => {
  const gens = await db.prepare("SELECT active_gen, previous_gen FROM sources WHERE id = 'demo-registry'").first<{ active_gen: number; previous_gen: number }>();
  assert.ok(gens!.previous_gen, "previous generation retained");
  // The previous generation still holds the original registry rows, but they are invisible now.
  assert.equal((await search(db, "demo", Q("T99DM0001A", { mode: "identifier" }))).total, 0);
  assert.equal(await record(db, "demo", "demo-registry:T99DM0001A"), null);
  const prevRows = await db.prepare("SELECT COUNT(*) AS n FROM entities WHERE gen = ?").bind(gens!.previous_gen).first<{ n: number }>();
  assert.equal(prevRows!.n, 3);
});
