// Snapshot lifecycle on local D1: fault injection, resume, locking, activation, rollback, cleanup.
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import type { Db } from "../src/db.ts";
import { acquireLock, begin, cleanup, finish, ImportRejected, LockHeld, releaseLock, rollback, runImport, writeChunk, type Prepared } from "../src/importer/lifecycle.ts";
import { RowError, type SourceRecord } from "../src/importer/records.ts";
import { record, search } from "../src/search.ts";
import { openTestDb, reset } from "./helpers.ts";

let db: Db, dispose: () => Promise<void>;
before(async () => { ({ db, dispose } = await openTestDb()); });
after(async () => { await dispose(); });
beforeEach(async () => { await reset(db); await db.prepare("INSERT INTO users (username, pw_hash, created_at) VALUES ('keep', 'scrypt$15$8$1$x$y', 'x')").run(); });

const S = "demo-watchlist";
function rec(i: number, extra: Partial<SourceRecord> = {}): SourceRecord {
  return { id: `${S}:R${i}`, kind: "person", schema: "Person", caption: `Person Number ${i}`, names: [{ value: `Person Number ${i}`, type: "primary" }, { value: `Alias ${i}`, type: "alias" }],
    countries: ["sg"], topics: i % 2 ? ["sanction"] : ["role.pep"], datasets: [{ id: "t" }], identifiers: [], dates: [], links: [], properties: {}, provenance: {}, referents: [], ...extra };
}
function prep(records: (SourceRecord | RowError)[], version = "v1"): Prepared {
  return { upstream: { version }, scope: null, async *records() { for (const r of records) yield r instanceof RowError ? r : structuredClone(r); } };
}
const N = (n: number, off = 0) => Array.from({ length: n }, (_, i) => rec(i + off));
const count = async (sql: string, ...a: unknown[]) => (await db.prepare(sql).bind(...a).first<{ n: number }>())!.n;
const Q = (text: string) => ({ text, mode: "name" as const, category: "all", country: "", topic: "any" });

test("import activates a validated generation; FTS and names consistent", async () => {
  const r = await runImport(db, S, prep(N(450)), { chunkSize: 100 });
  assert.equal(r.status, "imported");
  assert.equal(await count("SELECT COUNT(*) AS n FROM entities WHERE gen = ?", r.gen), 450);
  assert.equal(await count("SELECT COUNT(*) AS n FROM names WHERE gen = ?", r.gen), 900);
  assert.equal(await count("SELECT COUNT(*) AS n FROM names_fts WHERE names_fts MATCH ?", `g : "g${r.gen}"`), 900);
  assert.equal((await search(db, "demo", Q("Alias 7"))).results[0].id, `${S}:R7`);
});

test("unchanged upstream: no data writes, only checked_at", async () => {
  const a = await runImport(db, S, prep(N(50)));
  const before = await count("SELECT COUNT(*) AS n FROM entities");
  const b = await runImport(db, S, prep(N(50), "v2-same-content"));
  assert.equal(b.status, "unchanged");
  assert.equal(b.gen, a.gen);
  assert.equal(await count("SELECT COUNT(*) AS n FROM entities"), before);
  assert.equal(await count("SELECT COUNT(*) AS n FROM generations"), 1);
  assert.ok((await db.prepare("SELECT checked_at FROM sources WHERE id = ?").bind(S).first<{ checked_at: string }>())!.checked_at);
});

test("interruption mid-import keeps the active snapshot; retry resumes from the committed cursor", async () => {
  const a = await runImport(db, S, prep(N(100)));
  const next = N(300, 1000);
  await assert.rejects(runImport(db, S, prep(next, "v2"), { chunkSize: 50, failAfterChunks: 3 }), /injected interruption/);
  const st = await db.prepare("SELECT active_gen, lock_token, last_error FROM sources WHERE id = ?").bind(S).first<{ active_gen: number; lock_token: string | null; last_error: string }>();
  assert.equal(st!.active_gen, a.gen, "active untouched");
  assert.equal(st!.lock_token, null, "lock released");
  assert.match(st!.last_error, /injected interruption/);
  assert.equal((await search(db, "demo", Q("Person Number 1050"))).total, 0, "staging rows are invisible");
  const staging = await db.prepare("SELECT id, cursor FROM generations WHERE state = 'staging'").first<{ id: number; cursor: number }>();
  assert.equal(staging!.cursor, 150);
  const r = await runImport(db, S, prep(next, "v2"), { chunkSize: 50 });
  assert.equal(r.status, "resumed");
  assert.equal(r.gen, staging!.id);
  assert.equal(await count("SELECT COUNT(*) AS n FROM entities WHERE gen = ?", r.gen), 300, "no duplicates after resume");
  assert.equal((await search(db, "demo", Q("Person Number 1050"))).total, 1);
});

test("replaying a committed chunk fails as a whole (idempotent chunks)", async () => {
  const token = await acquireLock(db, S);
  const b = await begin(db, S, token, { version: "x", contentHash: "h" }, null);
  assert.equal(b.status, "started");
  await writeChunk(db, S, token, b.gen, 0, N(10));
  await assert.rejects(writeChunk(db, S, token, b.gen, 0, N(10)), "stale cursor -> guard fails the batch");
  assert.equal(await count("SELECT COUNT(*) AS n FROM entities WHERE gen = ?", b.gen), 10);
  await releaseLock(db, S, token);
  await assert.rejects(writeChunk(db, S, token, b.gen, 10, N(5, 10)), "no lock -> guard fails the batch");
  assert.equal(await count("SELECT COUNT(*) AS n FROM entities WHERE gen = ?", b.gen), 10);
});

test("concurrent imports: lock contention", async () => {
  const t = await acquireLock(db, S);
  await assert.rejects(runImport(db, S, prep(N(5))), LockHeld);
  await releaseLock(db, S, t);
  assert.equal((await runImport(db, S, prep(N(5)))).status, "imported");
  const stale = await acquireLock(db, S, Date.now() - 31 * 60_000); // expired lock is taken over
  assert.ok(stale);
  assert.ok(await acquireLock(db, S));
});

test("activation guard: if pointers moved underneath, the whole activation rolls back", async () => {
  const a = await runImport(db, S, prep(N(20)));
  const token = await acquireLock(db, S);
  const b = await begin(db, S, token, { version: "v9", contentHash: "other" }, null);
  assert.equal(b.status, "started");
  await writeChunk(db, S, token, b.gen, 0, N(20, 500));
  await db.prepare("UPDATE sources SET lock_token = 'someone-else' WHERE id = ?").bind(S).run(); // lock lost before activation
  await assert.rejects(finish(db, S, token, b.gen, { expectedRows: 20, counts: {}, contentHash: "other" }));
  const st = await db.prepare("SELECT active_gen FROM sources WHERE id = ?").bind(S).first<{ active_gen: number }>();
  assert.equal(st!.active_gen, a.gen);
  assert.equal(await count("SELECT COUNT(*) AS n FROM generations WHERE state = 'active'"), 1);
  assert.equal((await db.prepare("SELECT state FROM generations WHERE id = ?").bind(b.gen).first<{ state: string }>())!.state, "staging");
});

test("validation failures keep the current snapshot: empty, shrunk, rejected rows, count mismatch", async () => {
  await assert.rejects(runImport(db, S, prep([])), ImportRejected);
  assert.equal(await count("SELECT COUNT(*) AS n FROM generations"), 0, "initial empty source is never connected");
  const a = await runImport(db, S, prep(N(100)));
  await assert.rejects(runImport(db, S, prep(N(10, 7000), "small")), /unexpectedly small/);
  await assert.rejects(runImport(db, S, prep([...N(50, 9000), ...Array.from({ length: 5 }, () => new RowError("bad"))], "bad")), /rejected/);
  const dupes = [...N(60, 3000), rec(3000), rec(3001)];
  const r = await runImport(db, S, prep(dupes, "dupes"), { policy: { maxRejectRatio: 0.05 } });
  assert.equal((r.counts as { duplicates: number }).duplicates, 2);
  assert.equal(await count("SELECT COUNT(*) AS n FROM entities WHERE gen = ?", r.gen), 60);
  const st = await db.prepare("SELECT previous_gen FROM sources WHERE id = ?").bind(S).first<{ previous_gen: number }>();
  assert.equal(st!.previous_gen, a.gen);
  // Count mismatch: a staging generation with fewer rows than expected is rejected and marked failed.
  const token = await acquireLock(db, S);
  const b = await begin(db, S, token, { version: "short", contentHash: "short" }, null);
  await writeChunk(db, S, token, b.gen, 0, N(70, 100));
  await assert.rejects(finish(db, S, token, b.gen, { expectedRows: 80, counts: {}, contentHash: "short" }), /row count mismatch/);
  assert.equal((await db.prepare("SELECT state FROM generations WHERE id = ?").bind(b.gen).first<{ state: string }>())!.state, "failed");
  await releaseLock(db, S, token);
  assert.equal((await db.prepare("SELECT active_gen FROM sources WHERE id = ?").bind(S).first<{ active_gen: number }>())!.active_gen, r.gen);
});

test("upstream removal disappears after activation; referents resolve; rollback restores", async () => {
  const v1 = [rec(1), rec(2), rec(3)];
  await runImport(db, S, prep(v1));
  assert.ok(await record(db, "demo", `${S}:R1`));
  const v2 = [rec(2), { ...rec(30), referents: [`${S}:R3`] }];
  await runImport(db, S, prep(v2, "v2"), { policy: { allowShrink: true } });
  assert.equal(await record(db, "demo", `${S}:R1`), null, "removed record gone");
  assert.equal((await search(db, "demo", Q("Person Number 1"))).results.filter(x => x.id === `${S}:R1`).length, 0);
  const d = (await record(db, "demo", `${S}:R3`))!;
  assert.equal(d.id, `${S}:R30`);
  assert.equal(d.resolved_from, `${S}:R3`);
  const t = await acquireLock(db, S);
  await rollback(db, S, t);
  await releaseLock(db, S, t);
  assert.ok(await record(db, "demo", `${S}:R1`), "rollback restores the previous snapshot");
  assert.equal((await record(db, "demo", `${S}:R3`))!.id, `${S}:R3`);
});

test("no mixed-generation reads: search and detail use one resolved generation", async () => {
  const a = await runImport(db, S, prep(N(5)));
  const b = await runImport(db, S, prep(N(5).map(r => ({ ...r, caption: r.caption + " Updated", names: [{ value: r.caption + " Updated", type: "primary" as const }] })), "v2"));
  assert.notEqual(a.gen, b.gen);
  const r = await search(db, "demo", Q("Person Number 1"));
  for (const x of r.results) assert.match(x.caption, /Updated$/);
  const d = (await record(db, "demo", `${S}:R1`))!;
  assert.match(d.caption, /Updated$/);
  assert.ok(d.names.every(n => n.value.endsWith("Updated")), "names come from the same generation as the entity");
});

test("cleanup: bounded, skips active/previous, honours grace period, removes FTS rows", async () => {
  const g1 = await runImport(db, S, prep(N(120)));
  const g2 = await runImport(db, S, prep(N(120, 200), "v2"));
  const g3 = await runImport(db, S, prep(N(120, 400), "v3"));
  const state = async (g: number) => (await db.prepare("SELECT state FROM generations WHERE id = ?").bind(g).first<{ state: string }>())?.state;
  assert.equal(await state(g1.gen), "retired");
  assert.equal(await state(g2.gen), "previous");
  const early = await cleanup(db, { batchRows: 50 });
  assert.equal(early.generationsRemoved, 0, "grace period protects in-flight reads");
  const partial = await cleanup(db, { now: Date.now() + 11 * 60_000, batchRows: 50, maxBatches: 2 });
  assert.equal(partial.generationsRemoved, 0, "bounded: stops after maxBatches");
  assert.ok(partial.deletedRows > 0);
  let done = await cleanup(db, { now: Date.now() + 11 * 60_000, batchRows: 50, maxBatches: 100 });
  assert.equal(done.generationsRemoved, 1);
  assert.equal(await count("SELECT COUNT(*) AS n FROM entities WHERE gen = ?", g1.gen), 0);
  assert.equal(await count("SELECT COUNT(*) AS n FROM names WHERE gen = ?", g1.gen), 0);
  assert.equal(await count("SELECT COUNT(*) AS n FROM names_fts WHERE names_fts MATCH ?", `g : "g${g1.gen}"`), 0);
  assert.equal(await count("SELECT COUNT(*) AS n FROM entities WHERE gen = ?", g2.gen), 120, "previous kept");
  assert.equal(await count("SELECT COUNT(*) AS n FROM entities WHERE gen = ?", g3.gen), 120, "active kept");
  done = await cleanup(db, { now: Date.now() + 11 * 60_000 });
  assert.equal(done.generationsRemoved, 0);
});

test("imports never touch account tables", async () => {
  await runImport(db, S, prep(N(10)));
  await runImport(db, S, prep(N(10, 50), "v2"));
  await cleanup(db, { now: Date.now() + 11 * 60_000, graceMs: 0 });
  assert.equal(await count("SELECT COUNT(*) AS n FROM users WHERE username = 'keep'"), 1);
});

test("records outside the source namespace are rejected", async () => {
  const bad = { ...rec(1), id: "acra:T99DM0001A" };
  await assert.rejects(runImport(db, S, prep([bad])), ImportRejected);
});
