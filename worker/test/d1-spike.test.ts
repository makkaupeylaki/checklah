// D1 compatibility spike (LOCAL D1 via workerd/Miniflare only). Remote D1 verification is pending
// the approved deployment check. Results are recorded in docs/stage2-status.md.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { Db } from "../src/db.ts";
import { ftsQuery, fold } from "../src/normalize.ts";
import { migrate, openTestDb } from "./helpers.ts";

let db: Db, dispose: () => Promise<void>;
before(async () => { ({ db, dispose } = await openTestDb()); await migrate(db, "demo"); });
after(async () => { await dispose(); });

const ins = (nid: number, gen: number, name: string) => [
  db.prepare("INSERT INTO names (nid, gen, entity_id, name, norm, type) VALUES (?,?,?,?,?,?)").bind(nid, gen, `t:${nid}`, name, fold(name), "primary"),
  db.prepare("INSERT INTO names_fts (rowid, norm, g) VALUES (?,?,?)").bind(nid, fold(name), `g${gen}`),
];
const match = async (expr: string) => (await db.prepare("SELECT rowid FROM names_fts WHERE names_fts MATCH ? ORDER BY rowid").bind(expr).all<{ rowid: number }>()).results.map(r => r.rowid);

test("schema migration applies: FTS5 virtual table with unicode61 remove_diacritics 2", async () => {
  const r = await db.prepare("SELECT sql FROM sqlite_master WHERE name = 'names_fts'").first<{ sql: string }>();
  assert.match(r!.sql, /fts5/i);
  assert.match(r!.sql, /remove_diacritics 2/);
});

test("insert / MATCH / prefix / generation column filter", async () => {
  await db.batch([...ins(1, 1, "Orlo Vantrell"), ...ins(2, 2, "Orlo Vantrell"), ...ins(3, 1, "Józefína Ŝtrelvaq"), ...ins(4, 1, "Орло Вантрелл"),
    ...ins(5, 1, "O'Neil-Tan & Co. (Pte.) Ltd."), ...ins(6, 1, "陈大文")]);
  assert.deepEqual(await match(ftsQuery("orlo", 1)!), [1]);
  assert.deepEqual(await match(ftsQuery("orlo", 2)!), [2], "generation is enforced inside MATCH");
  assert.deepEqual(await match(ftsQuery("vant", 1)!), [1], "prefix");
  assert.deepEqual(await match(ftsQuery("jozefina", 1)!), [3], "diacritics folded");
  assert.deepEqual(await match(ftsQuery("Józefína", 1)!), [3]);
  assert.deepEqual(await match(ftsQuery("вантрелл", 1)!), [4], "Cyrillic tokens");
  assert.deepEqual(await match(ftsQuery("oneil", 1)!), [], "punctuation splits tokens; no join");
  assert.deepEqual(await match(ftsQuery("o neil tan", 1)!), [5]);
  assert.deepEqual(await match(ftsQuery("陈大文", 1)!), [6], "CJK run is one unicode61 token (no segmentation)");
  assert.deepEqual(await match(ftsQuery("大文", 1)!), [], "documented limitation: no CJK word segmentation");
});

test("hostile input never reaches FTS grammar (bound literal-token expression)", async () => {
  for (const q of ['"', 'orlo" OR "x', "NEAR(orlo vantrell)", "orlo*", "*", "-orlo", "g:g2", "norm:orlo OR g:g2", "^orlo", "orlo AND", "a".repeat(400), "", "   ", "😀"]) {
    const e = ftsQuery(q, 1);
    if (e === null) continue;
    const rows = await match(e); // must not throw
    assert.ok(rows.every(r => r !== 2), `generation 2 must never leak (${q})`);
  }
});

test("raw MATCH grammar errors are possible, which is why it is never exposed", async () => {
  await assert.rejects(db.prepare("SELECT rowid FROM names_fts WHERE names_fts MATCH ?").bind('orlo" OR').all());
});

test("ranking: bm25() is available", async () => {
  const r = await db.prepare("SELECT rowid, bm25(names_fts) AS s FROM names_fts WHERE names_fts MATCH ? ORDER BY s").bind(ftsQuery("orlo", 1)).all<{ s: number }>();
  assert.equal(typeof r.results[0].s, "number");
});

test("update and delete by rowid keep FTS consistent", async () => {
  await db.prepare("UPDATE names_fts SET norm = ? WHERE rowid = ?").bind("orla vantrell", 1).run();
  assert.deepEqual(await match(ftsQuery("orla", 1)!), [1]);
  await db.prepare("DELETE FROM names_fts WHERE rowid = ?").bind(1).run();
  assert.deepEqual(await match(ftsQuery("orla", 1)!), []);
  const n = await db.prepare("SELECT COUNT(*) AS n FROM names_fts").first<{ n: number }>();
  assert.equal(n!.n, 5);
});

test("FTS rebuild and integrity-check commands work locally", async () => {
  await db.prepare("INSERT INTO names_fts(names_fts) VALUES ('rebuild')").run();
  await db.prepare("INSERT INTO names_fts(names_fts) VALUES ('integrity-check')").run();
  await db.prepare("INSERT INTO names_fts(names_fts) VALUES ('optimize')").run();
  assert.deepEqual(await match(ftsQuery("orlo", 2)!), [2]);
});

test("batch() is atomic: a failing statement rolls back FTS and base rows", async () => {
  const before = await db.prepare("SELECT COUNT(*) AS n FROM names_fts").first<{ n: number }>();
  await assert.rejects(db.batch([...ins(100, 9, "Rollback Probe"), db.prepare("INSERT INTO app_meta (key, value) VALUES ('x', NULL)")]));
  const afterN = await db.prepare("SELECT COUNT(*) AS n FROM names_fts").first<{ n: number }>();
  assert.equal(afterN!.n, before!.n);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM names WHERE nid = 100").first<{ n: number }>())!.n, 0);
});

test("restore path: FTS is recreated from base rows (no reliance on an FTS dump)", async () => {
  await db.prepare("DROP TABLE names_fts").run();
  await db.prepare("CREATE VIRTUAL TABLE names_fts USING fts5(norm, g, tokenize = 'unicode61 remove_diacritics 2')").run();
  await db.prepare("INSERT INTO names_fts (rowid, norm, g) SELECT nid, norm, 'g' || gen FROM names").run();
  assert.deepEqual(await match(ftsQuery("orlo", 2)!), [2]);
  assert.deepEqual(await match(ftsQuery("jozefina", 1)!), [3]);
});

test("D1 limits: 100 bound parameters per statement", async () => {
  const ok = Array.from({ length: 99 }, (_, i) => i);
  await db.prepare(`SELECT ${ok.map(() => "?").join("+")} AS s`).bind(...ok).first();
  const bad = Array.from({ length: 101 }, (_, i) => i);
  await assert.rejects(db.prepare(`SELECT ${bad.map(() => "?").join("+")} AS s`).bind(...bad).first());
});

test("D1 refuses some SQLite functions/pragmas (do not depend on them)", async () => {
  await assert.rejects(db.prepare("SELECT sqlite_version()").first());
  const refusedOrAllowed: Record<string, boolean> = {};
  for (const sql of ["PRAGMA table_list", "PRAGMA optimize", "SELECT load_extension('x')", "ATTACH DATABASE 'x' AS y"]) {
    refusedOrAllowed[sql] = await db.prepare(sql).all().then(() => true, () => false);
  }
  assert.equal(refusedOrAllowed["SELECT load_extension('x')"], false);
  assert.equal(refusedOrAllowed["ATTACH DATABASE 'x' AS y"], false);
});

test("EXPLAIN QUERY PLAN: hot queries use indexes, no full scans of base tables", async () => {
  const plan = async (sql: string, ...args: unknown[]) => (await db.prepare("EXPLAIN QUERY PLAN " + sql).bind(...args).all<{ detail: string }>()).results.map(r => r.detail).join(" | ");
  const exact = await plan("SELECT e.id FROM names n JOIN entities e ON e.gen = n.gen AND e.id = n.entity_id WHERE n.gen = ? AND n.norm = ?", 1, "x");
  assert.match(exact, /USING (COVERING )?INDEX names_norm/);
  assert.doesNotMatch(exact, /\bSCAN\b/);
  const ident = await plan("SELECT e.id FROM identifiers i JOIN entities e ON e.gen = i.gen AND e.id = i.entity_id WHERE i.type = ? AND i.norm = ? AND i.gen = ?", "uen", "x", 1);
  assert.match(ident, /USING (COVERING )?INDEX identifiers_lookup/);
  assert.doesNotMatch(ident, /\bSCAN\b/);
  const fts = await plan("SELECT e.id FROM names_fts f CROSS JOIN names n ON n.nid = f.rowid JOIN entities e ON e.gen = n.gen AND e.id = n.entity_id WHERE names_fts MATCH ? AND n.gen = ?", 'g : "g1"', 1);
  assert.match(fts, /VIRTUAL TABLE INDEX/);
  assert.match(fts, /SEARCH n USING INTEGER PRIMARY KEY/);
  assert.doesNotMatch(fts.replace(/SCAN f VIRTUAL TABLE INDEX[^|]*/, ""), /\bSCAN\b/);
  const detail = await plan("SELECT * FROM entities WHERE gen = ? AND id = ?", 1, "x");
  assert.match(detail, /USING INDEX sqlite_autoindex_entities_1|USING PRIMARY KEY/);
  assert.doesNotMatch(detail, /\bSCAN\b/);
  // Finding recorded in stage2-status.md: "nid IN (SELECT ... ORDER BY nid LIMIT n)" planned as
  // SCAN names; cleanup therefore deletes by nid range, and other tables by unordered rowid subquery.
  const cleanup = await plan("DELETE FROM names WHERE nid >= ? AND nid <= ?", 1, 10);
  assert.match(cleanup, /SEARCH names USING INTEGER PRIMARY KEY \(rowid[<>]/);
  const ftsDel = await plan("DELETE FROM names_fts WHERE rowid >= ? AND rowid <= ?", 1, 10);
  assert.match(ftsDel, /VIRTUAL TABLE INDEX 0:></);
  for (const t of ["entities", "identifiers"]) {
    const p = await plan(`DELETE FROM ${t} WHERE rowid IN (SELECT rowid FROM ${t} WHERE gen = ? LIMIT ?)`, 1, 10);
    assert.doesNotMatch(p, /\bSCAN\b/, `${t}: ${p}`);
  }
  console.log(JSON.stringify({ exact, ident, fts, detail, cleanup }, null, 1));
});
