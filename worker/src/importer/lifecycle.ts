// Generation lifecycle on D1: lock -> begin/resume -> chunks -> validate -> activate -> cleanup.
// Runtime-agnostic: used by the local CLI (getPlatformProxy D1) and testable in-Worker.

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { insertMany, nowIso, type Db, type Stmt } from "../db.ts";
import { ENTITY_COLS, FTS_COLS, IDENT_COLS, NAME_COLS, REF_COLS, RowError, emptyRows, toRows, validateRecord, type SourceRecord } from "./records.ts";

export class ImportRejected extends Error {}
export class LockHeld extends Error {}

export interface Upstream {
  version?: string | null;
  exportAt?: string | null;
  checksum?: string | null; // checksum of the upstream file we read
  contentHash: string;      // hash of the normalized selected records (detects real changes)
}

export interface Policy {
  minRatioVsActive: number;  // reject if rows < ratio * active rows
  allowShrink: boolean;
  minRows: number;
  maxRejectRatio: number;
}
export const DEFAULT_POLICY: Policy = { minRatioVsActive: 0.5, allowShrink: false, minRows: 1, maxRejectRatio: 0.01 };

const LOCK_MS = 30 * 60 * 1000;
export const CLEANUP_GRACE_MS = 10 * 60 * 1000;

interface GenRow { id: number; state: string; import_key: string; cursor: number; rows: number; names: number; counts: string | null; last_changed_at: string | null; imported_at: string | null }

export async function ensureSource(db: Db, source: string): Promise<void> {
  await db.prepare("INSERT OR IGNORE INTO sources (id) VALUES (?)").bind(source).run();
}

export async function acquireLock(db: Db, source: string, now = Date.now()): Promise<string> {
  await ensureSource(db, source);
  const token = crypto.randomUUID();
  const r = await db.prepare("UPDATE sources SET lock_token = ?, lock_expires = ? WHERE id = ? AND (lock_token IS NULL OR lock_expires < ?)")
    .bind(token, now + LOCK_MS, source, now).run();
  if ((r.meta.changes ?? 0) !== 1) throw new LockHeld(`another import holds the lock for ${source}`);
  return token;
}

export async function releaseLock(db: Db, source: string, token: string): Promise<void> {
  await db.prepare("UPDATE sources SET lock_token = NULL, lock_expires = NULL WHERE id = ? AND lock_token = ?").bind(source, token).run();
}

export async function recordError(db: Db, source: string, message: string, now = Date.now()): Promise<void> {
  await ensureSource(db, source);
  await db.prepare("UPDATE sources SET last_error = ?, last_error_at = ?, last_attempt_at = ? WHERE id = ?")
    .bind(message.slice(0, 300), nowIso(now), nowIso(now), source).run();
}

export async function activeGeneration(db: Db, source: string): Promise<GenRow | null> {
  return db.prepare("SELECT g.* FROM sources s JOIN generations g ON g.id = s.active_gen WHERE s.id = ?").bind(source).first<GenRow>();
}

export function importKey(source: string, up: Upstream): string {
  return [source, up.version ?? "-", up.checksum ?? "-", up.contentHash].join("|");
}

export type BeginResult =
  | { status: "unchanged"; gen: number }
  | { status: "started" | "resumed"; gen: number; cursor: number };

/** Start or resume a staging generation. Unchanged content -> no data writes (only checked_at). */
export async function begin(db: Db, source: string, token: string, up: Upstream, scope: unknown, now = Date.now()): Promise<BeginResult> {
  const key = importKey(source, up);
  const active = await activeGeneration(db, source);
  const activeHash = active?.counts ? (JSON.parse(active.counts).content_hash as string | undefined) : undefined;
  if (active && (active.import_key === key || activeHash === up.contentHash)) {
    await db.prepare("UPDATE sources SET checked_at = ?, last_attempt_at = ? WHERE id = ? AND lock_token = ?")
      .bind(nowIso(now), nowIso(now), source, token).run();
    return { status: "unchanged", gen: active.id };
  }
  const staging = await db.prepare("SELECT * FROM generations WHERE source = ? AND state = 'staging' ORDER BY id DESC").bind(source).all<GenRow>();
  for (const g of staging.results) {
    if (g.import_key === key) {
      await db.prepare("UPDATE sources SET last_attempt_at = ? WHERE id = ?").bind(nowIso(now), source).run();
      return { status: "resumed", gen: g.id, cursor: g.cursor };
    }
  }
  // Abandoned staging generations for other upstream versions are failed; cleanup removes them.
  const stmts: Stmt[] = [
    db.prepare("UPDATE generations SET state = 'failed', retired_at = ? WHERE source = ? AND state = 'staging'").bind(now, source),
    db.prepare("INSERT INTO generations (source, state, import_key, upstream_version, upstream_export_at, upstream_checksum, created_at, scope) VALUES (?, 'staging', ?, ?, ?, ?, ?, ?)")
      .bind(source, key, up.version ?? null, up.exportAt ?? null, up.checksum ?? null, nowIso(now), JSON.stringify(scope ?? null)),
    db.prepare("UPDATE sources SET last_attempt_at = ? WHERE id = ?").bind(nowIso(now), source),
  ];
  const res = await db.batch(stmts);
  const gen = Number((res[1].meta as { last_row_id?: number }).last_row_id);
  if (!Number.isSafeInteger(gen) || gen <= 0) throw new Error("could not create generation");
  return { status: "started", gen, cursor: 0 };
}

/** Write one chunk and advance the cursor in the same transaction (batch). Idempotent on retry:
 *  deterministic keys make a replayed chunk fail on primary keys, and the cursor guard below makes a
 *  chunk written against a stale cursor fail as a whole. */
export async function writeChunk(db: Db, source: string, token: string, gen: number, startIndex: number, records: SourceRecord[], now = Date.now()): Promise<{ written: number; meta: { rows_written: number } }> {
  const rows = emptyRows();
  records.forEach((r, i) => toRows(gen, r, startIndex + i, rows));
  const stmts: Stmt[] = [
    // Guard: fails the whole batch (NOT NULL violation) unless we hold the lock and the cursor matches.
    db.prepare("INSERT INTO app_meta (key, value) SELECT 'chunk_guard', NULL WHERE NOT EXISTS (SELECT 1 FROM sources s JOIN generations g ON g.id = ? WHERE s.id = ? AND s.lock_token = ? AND g.state = 'staging' AND g.cursor = ?)")
      .bind(gen, source, token, startIndex),
    ...insertMany(db, "entities", ENTITY_COLS, rows.entities),
    ...insertMany(db, "names", NAME_COLS, rows.names),
    ...insertMany(db, "names_fts", FTS_COLS, rows.fts),
    ...insertMany(db, "identifiers", IDENT_COLS, rows.identifiers),
    ...insertMany(db, "referents", REF_COLS, rows.referents, "INSERT OR IGNORE"),
    db.prepare("UPDATE generations SET cursor = ?, rows = rows + ?, names = names + ? WHERE id = ?").bind(startIndex + records.length, rows.entities.length, rows.names.length, gen),
    db.prepare("UPDATE sources SET lock_expires = ? WHERE id = ? AND lock_token = ?").bind(now + LOCK_MS, source, token),
  ];
  const res = await db.batch(stmts);
  const rowsWritten = res.reduce((n, r) => n + Number(r.meta.rows_written ?? 0), 0);
  return { written: records.length, meta: { rows_written: rowsWritten } };
}

export interface FinishInput { expectedRows: number; counts: Record<string, number | string>; policy?: Partial<Policy>; contentHash: string }

/** Validate the staging generation, then activate it in one batch. On validation failure the
 *  generation is marked failed and the active generation is untouched. */
export async function finish(db: Db, source: string, token: string, gen: number, input: FinishInput, now = Date.now()): Promise<{ activated: number; previous: number | null }> {
  const policy = { ...DEFAULT_POLICY, ...input.policy };
  const g = await db.prepare("SELECT * FROM generations WHERE id = ? AND source = ?").bind(gen, source).first<GenRow>();
  if (!g || g.state !== "staging") throw new ImportRejected("generation is not staging");
  const fail = async (msg: string): Promise<never> => {
    await db.batch([
      db.prepare("UPDATE generations SET state = 'failed', retired_at = ? WHERE id = ? AND state = 'staging'").bind(now, gen),
      db.prepare("UPDATE sources SET last_error = ?, last_error_at = ? WHERE id = ?").bind(`ImportRejected: ${msg}`.slice(0, 300), nowIso(now), source),
    ]);
    throw new ImportRejected(msg);
  };
  const ent = await db.prepare("SELECT COUNT(*) AS n FROM entities WHERE gen = ?").bind(gen).first<{ n: number }>();
  const nm = await db.prepare("SELECT COUNT(*) AS n FROM names WHERE gen = ?").bind(gen).first<{ n: number }>();
  const fts = await db.prepare("SELECT COUNT(*) AS n FROM names_fts WHERE names_fts MATCH ?").bind(`g : "g${gen}"`).first<{ n: number }>();
  const rows = ent?.n ?? 0;
  if (rows !== input.expectedRows || rows !== g.rows || g.cursor !== input.expectedRows) await fail(`row count mismatch: ${rows} stored, ${input.expectedRows} expected`);
  if ((nm?.n ?? 0) !== (fts?.n ?? 0) || (nm?.n ?? 0) !== g.names) await fail("name/FTS index count mismatch");
  if (rows < policy.minRows) await fail(`empty snapshot (${rows} rows)`);
  const rejected = Number(input.counts.rejected ?? 0), read = Number(input.counts.read ?? 0);
  if (read && rejected / read > policy.maxRejectRatio) await fail(`too many rejected rows: ${rejected} of ${read}`);
  const active = await activeGeneration(db, source);
  if (active && !policy.allowShrink && rows < active.rows * policy.minRatioVsActive) await fail(`unexpectedly small snapshot: ${rows} rows vs ${active.rows} active`);

  const activeHash = active?.counts ? JSON.parse(active.counts).content_hash : null;
  const lastChanged = activeHash && activeHash === input.contentHash ? active!.last_changed_at : nowIso(now);
  const prev = await db.prepare("SELECT previous_gen FROM sources WHERE id = ?").bind(source).first<{ previous_gen: number | null }>();
  const oldActive = active?.id ?? null, oldPrev = prev?.previous_gen ?? null;
  const counts = JSON.stringify({ ...input.counts, content_hash: input.contentHash });
  await db.batch([
    // Guard: abort the whole activation unless we still hold the lock and nothing moved underneath us.
    db.prepare("INSERT INTO app_meta (key, value) SELECT 'activation_guard', NULL WHERE NOT EXISTS (SELECT 1 FROM sources WHERE id = ? AND lock_token = ? AND active_gen IS ? AND previous_gen IS ?)")
      .bind(source, token, oldActive, oldPrev),
    db.prepare("UPDATE generations SET state = 'retired', retired_at = ? WHERE id = ? AND state = 'previous'").bind(now, oldPrev),
    db.prepare("UPDATE generations SET state = 'previous' WHERE id = ? AND state = 'active'").bind(oldActive),
    db.prepare("UPDATE generations SET state = 'active', imported_at = ?, counts = ?, last_changed_at = ? WHERE id = ? AND state = 'staging'")
      .bind(nowIso(now), counts, lastChanged, gen),
    db.prepare("UPDATE sources SET active_gen = ?, previous_gen = ?, last_success_at = ?, checked_at = ?, last_error = NULL, last_error_at = NULL WHERE id = ?")
      .bind(gen, oldActive, nowIso(now), nowIso(now), source),
  ]);
  return { activated: gen, previous: oldActive };
}

/** Swap active and previous generations in one batch. */
export async function rollback(db: Db, source: string, token: string, now = Date.now()): Promise<number> {
  const s = await db.prepare("SELECT active_gen, previous_gen FROM sources WHERE id = ?").bind(source).first<{ active_gen: number | null; previous_gen: number | null }>();
  if (!s?.previous_gen) throw new ImportRejected("no previous generation to roll back to");
  await db.batch([
    db.prepare("INSERT INTO app_meta (key, value) SELECT 'rollback_guard', NULL WHERE NOT EXISTS (SELECT 1 FROM sources WHERE id = ? AND lock_token = ? AND active_gen IS ? AND previous_gen = ?)")
      .bind(source, token, s.active_gen, s.previous_gen),
    db.prepare("UPDATE generations SET state = 'previous' WHERE id = ?").bind(s.active_gen),
    db.prepare("UPDATE generations SET state = 'active' WHERE id = ?").bind(s.previous_gen),
    db.prepare("UPDATE sources SET active_gen = ?, previous_gen = ?, last_success_at = ? WHERE id = ?").bind(s.previous_gen, s.active_gen, nowIso(now), source),
  ]);
  return s.previous_gen;
}

/** Delete retired/failed generations in bounded batches. Never touches active or previous
 *  generations, and waits CLEANUP_GRACE_MS after retirement so in-flight reads can finish. */
export async function cleanup(db: Db, opts: { now?: number; graceMs?: number; maxBatches?: number; batchRows?: number } = {}): Promise<{ deletedRows: number; generationsRemoved: number; done: boolean }> {
  const now = opts.now ?? Date.now(), grace = opts.graceMs ?? CLEANUP_GRACE_MS;
  const per = Math.min(opts.batchRows ?? 1000, 5000);
  let batches = opts.maxBatches ?? 20, deleted = 0, removed = 0;
  const gens = await db.prepare(
    "SELECT g.id FROM generations g WHERE g.state IN ('retired','failed') AND g.retired_at IS NOT NULL AND g.retired_at < ? " +
    "AND NOT EXISTS (SELECT 1 FROM sources s WHERE s.active_gen = g.id OR s.previous_gen = g.id) ORDER BY g.id LIMIT 10").bind(now - grace).all<{ id: number }>();
  for (const { id } of gens.results) {
    // Name rows of generation `id` occupy nid range [id*2^32, (id+1)*2^32): delete by rowid range
    // (index seek on names and on the FTS rowid), never "ORDER BY ... LIMIT" subqueries (full scan).
    let lo = id * 2 ** 32;
    const end = (id + 1) * 2 ** 32;
    while (batches > 0) {
      batches--;
      const hiRow = await db.prepare("SELECT nid FROM names WHERE nid >= ? AND nid < ? ORDER BY nid LIMIT 1 OFFSET ?").bind(lo, end, per - 1).first<{ nid: number }>();
      const hi = hiRow?.nid ?? end - 1;
      const res = await db.batch([
        db.prepare("DELETE FROM names_fts WHERE rowid >= ? AND rowid <= ?").bind(lo, hi),
        db.prepare("DELETE FROM names WHERE nid >= ? AND nid <= ?").bind(lo, hi),
        db.prepare("DELETE FROM entities WHERE rowid IN (SELECT rowid FROM entities WHERE gen = ? LIMIT ?)").bind(id, per),
        db.prepare("DELETE FROM identifiers WHERE rowid IN (SELECT rowid FROM identifiers WHERE gen = ? LIMIT ?)").bind(id, per),
        db.prepare("DELETE FROM referents WHERE gen = ? AND old_id IN (SELECT old_id FROM referents WHERE gen = ? LIMIT ?)").bind(id, id, per),
      ]);
      lo = hi + 1;
      const n = res.reduce((a, r) => a + Number(r.meta.changes ?? 0), 0);
      deleted += n;
      if (n === 0) {
        await db.prepare("DELETE FROM generations WHERE id = ? AND state IN ('retired','failed')").bind(id).run();
        removed++;
        break;
      }
    }
    if (batches <= 0) break;
  }
  // Expired sessions and old limiter windows (bounded).
  await db.batch([
    db.prepare("DELETE FROM sessions WHERE token_hash IN (SELECT token_hash FROM sessions WHERE expires_at < ? LIMIT 500)").bind(now),
    db.prepare("DELETE FROM rate_limits WHERE (bucket, window) IN (SELECT bucket, window FROM rate_limits WHERE window < ? LIMIT 500)").bind(Math.floor(now / 60000) - 2),
  ]);
  const remaining = await db.prepare("SELECT COUNT(*) AS n FROM generations WHERE state IN ('retired','failed')").first<{ n: number }>();
  return { deletedRows: deleted, generationsRemoved: removed, done: (remaining?.n ?? 0) === 0 };
}

// ---------------------------------------------------------------- driver

export interface Prepared {
  upstream: Omit<Upstream, "contentHash">;
  scope: unknown;
  /** Iterate validated records in a deterministic order. Called twice (hash pass, write pass). */
  records(): AsyncIterable<SourceRecord | RowError>;
  extraCounts?: () => Record<string, number>;
}

export interface RunOptions { chunkSize?: number; policy?: Partial<Policy>; now?: () => number; onProgress?: (n: number) => void; failAfterChunks?: number }

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const buf = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const h = await crypto.subtle.digest("SHA-256", buf as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, "0")).join("");
}

/** Full import: count+hash pass, unchanged check, chunked write pass (resumable), finish. */
export async function runImport(db: Db, source: string, prep: Prepared, opts: RunOptions = {}) {
  const now = opts.now ?? Date.now;
  const chunkSize = opts.chunkSize ?? 200;
  // Pass A: count, validate, hash (no writes). Content hash = rolling hash of record digests.
  let read = 0, valid = 0, rejected = 0, duplicates = 0;
  const seen = new Set<string>();
  const hasher = sha256.create();
  const enc = new TextEncoder();
  for await (const r of prep.records()) {
    read++;
    if (r instanceof RowError) { rejected++; continue; }
    try { validateRecord(r, source); } catch { rejected++; continue; }
    if (seen.has(r.id)) { rejected++; duplicates++; continue; } // duplicate ID/UEN: later rows rejected
    seen.add(r.id);
    valid++;
    hasher.update(enc.encode(JSON.stringify(r) + "\n"));
  }
  const contentHash = bytesToHex(hasher.digest());
  seen.clear();
  const counts = { read, valid, rejected, duplicates, ...(prep.extraCounts?.() ?? {}) };
  const up: Upstream = { ...prep.upstream, contentHash };
  const token = await acquireLock(db, source, now());
  try {
    if (valid === 0) {
      await recordError(db, source, "ImportRejected: empty snapshot (0 valid rows)", now());
      throw new ImportRejected("empty snapshot (0 valid rows)");
    }
    const b = await begin(db, source, token, up, prep.scope, now());
    if (b.status === "unchanged") return { status: "unchanged" as const, gen: b.gen, counts };
    // Pass B: write chunks from the cursor.
    let index = 0, chunk: SourceRecord[] = [], chunkStart = b.cursor, chunks = 0, rowsWritten = 0;
    const seen2 = new Set<string>();
    for await (const r of prep.records()) {
      if (r instanceof RowError) continue;
      try { validateRecord(r, source); } catch { continue; }
      if (seen2.has(r.id)) continue;
      seen2.add(r.id);
      if (index++ < b.cursor) continue;
      chunk.push(r);
      if (chunk.length >= chunkSize) {
        if (opts.failAfterChunks !== undefined && chunks >= opts.failAfterChunks) throw new Error("injected interruption");
        rowsWritten += (await writeChunk(db, source, token, b.gen, chunkStart, chunk, now())).meta.rows_written;
        chunkStart += chunk.length; chunk = []; chunks++;
        opts.onProgress?.(chunkStart);
      }
    }
    if (chunk.length) {
      if (opts.failAfterChunks !== undefined && chunks >= opts.failAfterChunks) throw new Error("injected interruption");
      rowsWritten += (await writeChunk(db, source, token, b.gen, chunkStart, chunk, now())).meta.rows_written;
      chunkStart += chunk.length;
    }
    const fin = await finish(db, source, token, b.gen, { expectedRows: valid, counts, policy: opts.policy, contentHash }, now());
    return { status: b.status === "resumed" ? "resumed" as const : "imported" as const, gen: fin.activated, previous: fin.previous, counts, rowsWritten };
  } catch (e) {
    if (!(e instanceof ImportRejected)) await recordError(db, source, `${(e as Error).name}: ${(e as Error).message}`, now());
    throw e;
  } finally {
    await releaseLock(db, source, token);
  }
}
