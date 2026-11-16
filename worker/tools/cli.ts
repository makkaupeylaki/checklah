#!/usr/bin/env node
// CheckLah local CLI (Node >= 22.18, runs .ts directly). Writes to LOCAL D1 state only, through
// wrangler's getPlatformProxy(): the same database `wrangler dev --persist-to` serves.
// Never runs anything with --remote. See docs/deployment-handoff.md for the remote plan.

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getPlatformProxy } from "wrangler";
import type { Db } from "../src/db.ts";
import { hashPassword, revokeUser } from "../src/auth.ts";
import { activeGeneration, acquireLock, cleanup, ImportRejected, LockHeld, recordError, releaseLock, rollback, runImport, type Prepared } from "../src/importer/lifecycle.ts";
import { DEMO_SOURCES, demoPrepared } from "../src/importer/demo.ts";
import { acraRecords, acraRequestDownloadUrl, newAcraStats } from "../src/importer/acra.ts";
import { lines, newOsStats, OS_HOSTS, OS_URL, passContext, passResolve, passSelect, SG_FIELDS, toRecord } from "../src/importer/opensanctions.ts";
import { realDeps, safeGet, streamBody } from "../src/importer/fetchpolicy.ts";
import { fetchAllowed } from "../src/refresh.ts";
import { SOURCE_BY_ID, type Mode } from "../src/sources.ts";
import { sourcesView } from "../src/search.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
export const WORKER_DIR = resolve(HERE, "..");
export const CONFIG = join(WORKER_DIR, "wrangler.jsonc");

export function stateDir(env: string, override?: string) {
  return resolve(override ?? join(WORKER_DIR, "..", ".wrangler-state", env));
}

export async function openDb(env: Mode, persist: string | false) {
  const proxy = await getPlatformProxy<{ DB: Db }>({ configPath: CONFIG, environment: env, persist: persist === false ? false : { path: join(persist, "v3") } }); // same layout as wrangler --persist-to
  return { db: proxy.env.DB, dispose: proxy.dispose };
}

export function applyMigrations(env: Mode, persist: string) {
  const r = spawnSync("npx", ["wrangler", "d1", "migrations", "apply", "DB", "--local", "--env", env, "--persist-to", persist],
    { cwd: WORKER_DIR, encoding: "utf8", env: { ...process.env, CI: "1" } });
  if (r.status !== 0) throw new Error(`migrations failed:\n${r.stdout}\n${r.stderr}`);
}

export async function stampMode(db: Db, env: Mode) {
  const cur = await db.prepare("SELECT value FROM app_meta WHERE key = 'mode'").first<{ value: string }>();
  if (cur && cur.value !== env) throw new Error(`database is stamped "${cur.value}", refusing to re-stamp as "${env}"`);
  await db.prepare("INSERT OR IGNORE INTO app_meta (key, value) VALUES ('mode', ?)").bind(env).run();
}

async function assertMode(db: Db, env: Mode) {
  const cur = await db.prepare("SELECT value FROM app_meta WHERE key = 'mode'").first<{ value: string }>().catch(() => null);
  if (!cur) throw new Error("database not initialised: run `cli.ts init --env " + env + "` first");
  if (cur.value !== env) throw new Error(`database is stamped "${cur.value}" but --env is "${env}"`);
}

export async function fileDigests(path: string) {
  const s256 = createHash("sha256"), s1 = createHash("sha1");
  for await (const c of createReadStream(path)) { s256.update(c); s1.update(c); }
  return { sha256: s256.digest("hex"), sha1: s1.digest("hex"), bytes: statSync(path).size };
}

interface Manifest { source?: string; version?: string; exported_at?: string; sha256?: string; sha1?: string; fixture?: string }

async function loadManifest(path: string | undefined, source: string): Promise<Manifest> {
  if (!path) return {};
  const m = JSON.parse(await readFile(path, "utf8")) as Manifest;
  if (m.source && m.source !== source) throw new ImportRejected(`manifest is for "${m.source}", not "${source}"`);
  return m;
}

async function verifyFile(path: string, m: Manifest) {
  const d = await fileDigests(path);
  if (m.sha256 && m.sha256.toLowerCase() !== d.sha256) throw new ImportRejected("checksum mismatch (sha256)");
  if (m.sha1 && m.sha1.toLowerCase() !== d.sha1) throw new ImportRejected("checksum mismatch (sha1)");
  return d;
}

const fileChunks = (p: string) => () => createReadStream(p, { highWaterMark: 1 << 20 }) as AsyncIterable<Uint8Array>;

export async function prepareAcra(path: string, m: Manifest, digest: string): Promise<Prepared & { stats: ReturnType<typeof newAcraStats> }> {
  const stats = newAcraStats();
  return {
    stats,
    upstream: { version: m.version ?? null, exportAt: m.exported_at ?? null, checksum: digest },
    scope: { dataset: "d_3f960c10fed6145404ca7b821f263b87", rule: "whole register (Registered and Deregistered as supplied)" },
    records: () => { Object.assign(stats, newAcraStats()); return acraRecords(fileChunks(path)(), stats); },
    extraCounts: () => ({ csv_errors: stats.csv_errors, missing_name: stats.missing_name, missing_uen: stats.missing_uen, nonstandard_uen: stats.nonstandard_uen, invalid_dates: stats.invalid_dates }),
  };
}

export async function prepareOpenSanctions(path: string, m: Manifest, digest: string, tmpDir: string, opts: { maxMalformedRatio?: number } = {}): Promise<Prepared & { stats: ReturnType<typeof newOsStats> }> {
  const stats = newOsStats();
  mkdirSync(tmpDir, { recursive: true });
  const spillPath = join(tmpDir, `os-subjects-${process.pid}.ndjson`);
  const out = createWriteStream(spillPath);
  const selected = await passSelect(fileChunks(path), stats, line => new Promise<void>((res, rej) => out.write(line + "\n", e => (e ? rej(e) : res()))));
  await new Promise<void>(r => out.end(r));
  if (stats.lines && stats.malformed / stats.lines > (opts.maxMalformedRatio ?? 0.01)) throw new ImportRejected(`too many malformed lines: ${stats.malformed} of ${stats.lines}`);
  const { ctx, needed } = await passContext(fileChunks(path), selected, stats);
  const resolved = await passResolve(fileChunks(path), needed);
  return {
    stats,
    upstream: { version: m.version ?? null, exportAt: m.exported_at ?? null, checksum: digest },
    scope: { rule: "entity's own property contains country code sg", fields: SG_FIELDS, note: "CheckLah scope choice; not an official OpenSanctions Singapore feed" },
    async *records() {
      for await (const line of lines(fileChunks(spillPath)())) {
        const id = /"id"\s*:\s*"([^"]+)"/.exec(line)?.[1] ?? "";
        yield toRecord(line, ctx.get(id) ?? [], resolved, selected);
      }
    },
    extraCounts: () => ({ lines: stats.lines, malformed: stats.malformed, selected: stats.selected, excluded_not_sg: stats.excluded_not_sg,
      unsupported: stats.unsupported, context_kept: stats.context_kept, context_truncated: stats.context_truncated }),
  };
}

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function downloadTo(url: string, hosts: string[], dest: string, maxBytes: number, minutes: number) {
  mkdirSync(dirname(dest), { recursive: true });
  const part = dest + ".part";
  const resp = await safeGet(url, { allowedHosts: hosts, timeoutMs: minutes * 60_000, maxRetries: 2 });
  const ws = createWriteStream(part);
  try {
    await streamBody(resp, c => new Promise<void>((res, rej) => ws.write(c, e => (e ? rej(e) : res()))), { maxBytes, deadlineMs: Date.now() + minutes * 60_000, now: Date.now });
    await new Promise<void>(r => ws.end(r));
    rmSync(dest, { force: true });
    await import("node:fs/promises").then(f => f.rename(part, dest));
  } finally {
    ws.destroy();
    rmSync(part, { force: true });
  }
  return dest;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...args] = argv;
  const env = (arg(args, "--env") ?? "demo") as Mode;
  if (env !== "demo" && env !== "live") { console.error("--env must be demo or live"); return 2; }
  const persist = stateDir(env, arg(args, "--persist-to"));
  if (!cmd || cmd === "help") {
    console.log("usage: cli.ts <init|import|rollback|cleanup|status|add-user|revoke-user> [--env demo|live] [--persist-to DIR] ...");
    return 0;
  }
  if (cmd === "init") {
    mkdirSync(persist, { recursive: true });
    applyMigrations(env, persist);
    const { db, dispose } = await openDb(env, persist);
    try { await stampMode(db, env); console.log(`initialised ${env} database at ${persist}`); } finally { await dispose(); }
    return 0;
  }
  const { db, dispose } = await openDb(env, persist);
  try {
    await assertMode(db, env);
    if (cmd === "import") {
      const source = args[0];
      if (source === "demo") {
        if (env !== "demo") throw new Error("demo sources can only be imported into the demo database");
        for (const s of DEMO_SOURCES) {
          const r = await runImport(db, s, demoPrepared(s, { withProbes: args.includes("--with-probes") }));
          console.log(`${s}: ${r.status} gen ${r.gen} (${JSON.stringify(r.counts)})`);
        }
        return 0;
      }
      const def = SOURCE_BY_ID.get(source);
      if (!def) throw new Error(`unknown source ${source}`);
      if (def.mode !== env) throw new Error(`${source} is a ${def.mode} source; refusing to import into the ${env} database`);
      if (!def.adapter) { console.log(`${source}: not available — ${def.blockedReason}`); return 1; }
      const tmp = resolve(arg(args, "--tmp") ?? join(WORKER_DIR, ".import-tmp"));
      let file = arg(args, "--file");
      const manifest = await loadManifest(arg(args, "--manifest"), source);
      try {
        if (!file && args.includes("--download")) {
          if (source === "opensanctions") {
            const row = await db.prepare("SELECT last_attempt_at FROM sources WHERE id = ?").bind(source).first<{ last_attempt_at: string | null }>();
            if (!fetchAllowed(source, row?.last_attempt_at ?? null)) throw new ImportRejected("refusing to refetch OpenSanctions within 6 hours of the last attempt");
            file = await downloadTo(OS_URL, OS_HOSTS, join(tmp, "entities.ftm.json"), 12 * 2 ** 30, 90);
          } else {
            const hosts = args.flatMap((a, i) => (a === "--trust-download-host" ? [String(args[i + 1]).toLowerCase()] : []));
            const { url, host, observations } = await acraRequestDownloadUrl(realDeps, { downloadHosts: hosts });
            console.log(`poll observations: ${JSON.stringify(observations)}`);
            file = await downloadTo(url, [host], join(tmp, "acra.csv"), 2 ** 30, 20);
          }
        }
        if (!file) throw new Error("--file <path> (with optional --manifest) or --download is required");
        const d = await verifyFile(file, manifest);
        // Defaults are strict (1 %); fixtures with deliberately bad rows need an explicit, logged override.
        const ratio = arg(args, "--max-reject-ratio");
        if (ratio !== undefined) console.log(`note: reject ratio ceiling overridden to ${Number(ratio)}`);
        const policy = { allowShrink: args.includes("--allow-shrink"), ...(ratio !== undefined ? { maxRejectRatio: Number(ratio) } : {}) };
        const prep = source === "acra" ? await prepareAcra(file, manifest, d.sha256)
          : await prepareOpenSanctions(file, manifest, d.sha256, tmp, ratio !== undefined ? { maxMalformedRatio: Number(ratio) } : {});
        const t0 = Date.now();
        const r = await runImport(db, source, prep, { policy, chunkSize: Number(arg(args, "--chunk") ?? 200), onProgress: n => { if (n % 50_000 < 200) process.stdout.write(`\r  ${n} records written`); } });
        console.log(`\n${source}: ${r.status} gen ${r.gen} in ${((Date.now() - t0) / 1000).toFixed(1)}s ${JSON.stringify(r.counts)}`);
        if ("stats" in prep) console.log(`stats: ${JSON.stringify(prep.stats)}`);
        return 0;
      } catch (e) {
        if (e instanceof ImportRejected) await recordError(db, source, `ImportRejected: ${e.message}`);
        else if (!(e instanceof LockHeld)) await recordError(db, source, `${(e as Error).name}: ${(e as Error).message}`);
        console.error(`${source}: rejected — ${(e as Error).message}`);
        return 1;
      }
    }
    if (cmd === "rollback") {
      const source = args[0];
      const token = await acquireLock(db, source);
      try { console.log(`${source}: now using generation ${await rollback(db, source, token)}`); } finally { await releaseLock(db, source, token); }
      return 0;
    }
    if (cmd === "cleanup") {
      const r = await cleanup(db, { maxBatches: Number(arg(args, "--batches") ?? 200), graceMs: args.includes("--no-grace") ? 0 : undefined });
      console.log(JSON.stringify(r));
      return 0;
    }
    if (cmd === "status") {
      console.log(JSON.stringify((await sourcesView(db, env)).sources, null, 1));
      for (const s of ["acra", "opensanctions", ...DEMO_SOURCES]) {
        const g = await activeGeneration(db, s);
        if (g) console.log(`${s}: active gen ${g.id} rows ${g.rows}`);
      }
      return 0;
    }
    if (cmd === "add-user") {
      const username = args[0];
      if (!username || username.startsWith("--") || username.length > 64) throw new Error("usage: add-user <username>");
      const pw = await readPassword();
      if (pw.length < 12) throw new Error("use at least 12 characters");
      const h = await hashPassword(pw);
      if (args.includes("--print-sql")) {
        // For the approved remote step only; contains a hash, never the password.
        console.log(`INSERT INTO users (username, pw_hash, created_at) VALUES ('${username.replace(/'/g, "''")}', '${h}', '${new Date().toISOString()}') ON CONFLICT(username) DO UPDATE SET pw_hash = excluded.pw_hash;`);
        return 0;
      }
      await db.prepare("INSERT INTO users (username, pw_hash, created_at) VALUES (?,?,?) ON CONFLICT(username) DO UPDATE SET pw_hash = excluded.pw_hash, session_epoch = session_epoch + 1")
        .bind(username, h, new Date().toISOString()).run();
      console.log(`saved ${username} (scrypt hash) in the local ${env} database`);
      return 0;
    }
    if (cmd === "revoke-user") {
      await revokeUser(db, args[0]);
      console.log(`revoked all sessions for ${args[0]}`);
      return 0;
    }
    console.error(`unknown command ${cmd}`);
    return 2;
  } finally {
    await dispose();
  }
}

async function readPassword(): Promise<string> {
  if (process.env.CHECKLAH_PASSWORD_FILE) return (await readFile(process.env.CHECKLAH_PASSWORD_FILE, "utf8")).replace(/\r?\n$/, "");
  if (!process.stdin.isTTY) {
    let s = "";
    for await (const c of process.stdin) s += c;
    return s.replace(/\r?\n$/, "");
  }
  process.stdout.write("Password: ");
  process.stdin.setRawMode(true);
  let pw = "";
  for await (const c of process.stdin) {
    const ch = String(c);
    if (ch === "\r" || ch === "\n") break;
    if (ch === "\u0003") process.exit(130);
    if (ch === "\u007f") pw = pw.slice(0, -1); else pw += ch;
  }
  process.stdin.setRawMode(false);
  process.stdout.write("\n");
  return pw;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then(code => process.exit(code), e => { console.error(String((e as Error).message ?? e)); process.exit(1); });
}

export { main, writeFile, existsSync };
