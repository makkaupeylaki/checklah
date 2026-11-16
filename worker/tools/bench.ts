#!/usr/bin/env node
// Reproducible LOCAL benchmark (synthetic ACRA-shaped data -> local D1 via workerd). Not remote D1.
// Usage: node tools/bench.ts [--rows 2133906] [--dir /path/for/state] [--generations 2] [--keep]
// Records: import time, rows_written (local meta), Node + workerd peak memory, on-disk size per
// generation count, cold/warm query latency (p50/p95) and rows_read per query type.

import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { join } from "node:path";
import { applyMigrations, openDb, prepareAcra, stampMode, WORKER_DIR } from "./cli.ts";
import { cleanup, runImport } from "../src/importer/lifecycle.ts";
import { record, search, Snapshot } from "../src/search.ts";
import type { Db } from "../src/db.ts";

const args = process.argv.slice(2);
const arg = (n: string, d: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const ROWS = Number(arg("--rows", "2133906"));
const GENS = Number(arg("--generations", "2"));
const DIR = arg("--dir", join(WORKER_DIR, "..", ".bench"));
const STATE = join(DIR, "state");
const CSV = join(DIR, "acra-synthetic.csv");

const SYL = ["tan", "lim", "ng", "ong", "lee", "goh", "chua", "koh", "teo", "wong", "kumar", "raj", "abdul", "siti", "nur", "wei", "ming",
  "hui", "jia", "xin", "ah", "kim", "seng", "huat", "global", "asia", "pacific", "trading", "logistics", "tech", "capital", "holdings",
  "marine", "food", "design", "consult", "invest", "united", "star", "golden", "lion", "harbour", "east", "west", "orchid", "merlion"];
const TYPES = ["Local Company", "Sole Proprietorship/ Partnership", "Limited Liability Partnership", "Foreign Company", "Limited Partnership"];
const SUFFIX = [" PTE. LTD.", "", " LLP", " LTD.", " ENTERPRISE", " TRADING", " SERVICES"];

function rng(seed: number) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

/** Synthetic rows. UENs use the impossible year 99 (T99xx....) so nothing can collide with a real UEN. */
async function writeCsv(rows: number, variant: number) {
  mkdirSync(DIR, { recursive: true });
  const r = rng(42);
  const out = createWriteStream(CSV);
  const w = (s: string) => new Promise<void>(res => (out.write(s) ? res() : out.once("drain", res)));
  await w("﻿uen,issuance_agency_desc,uen_status_desc,entity_name,entity_type_desc,uen_issue_date,reg_street_name,reg_postal_code\n");
  const L = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  for (let i = 0; i < rows; i++) {
    const n = 1 + Math.floor(r() * 3);
    let name = Array.from({ length: n }, () => SYL[Math.floor(r() * SYL.length)]).join(" ").toUpperCase() + SUFFIX[Math.floor(r() * SUFFIX.length)];
    if (variant && i % 100 === 0) name += " (RENAMED)"; // ~1 % change between generations
    const uen = `T99${L[Math.floor(i / 260000) % 26]}${L[Math.floor(i / 10000) % 26]}${String(i % 10000).padStart(4, "0")}${L[i % 26]}`;
    const status = r() < 0.55 ? "Registered" : "Deregistered";
    const y = 1970 + Math.floor(r() * 56), m = 1 + Math.floor(r() * 12), d = 1 + Math.floor(r() * 28);
    const street = name.includes(",") ? `"${name}"` : `${SYL[Math.floor(r() * SYL.length)].toUpperCase()} ROAD`;
    await w(`${uen},ACRA,${status},"${name.replace(/"/g, '""')}",${TYPES[Math.floor(r() * TYPES.length)]},${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")},${street},${String(Math.floor(r() * 830000)).padStart(6, "0")}\n`);
  }
  await new Promise<void>(res => out.end(res));
  return statSync(CSV).size;
}

function workerdPeakKb(): number {
  let peak = 0;
  for (const pid of readdirSync("/proc").filter(p => /^\d+$/.test(p))) {
    try {
      const st = readFileSync(`/proc/${pid}/status`, "utf8");
      if (!/^Name:\s+workerd/m.test(st)) continue;
      const m = /VmHWM:\s+(\d+) kB/.exec(st);
      if (m) peak = Math.max(peak, Number(m[1]));
    } catch { /* process exited */ }
  }
  return peak;
}

function dirBytes(p: string): number {
  if (!existsSync(p)) return 0;
  let n = 0;
  for (const e of readdirSync(p, { withFileTypes: true })) {
    const f = join(p, e.name);
    n += e.isDirectory() ? dirBytes(f) : statSync(f).size;
  }
  return n;
}

const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))];
const mb = (b: number) => Math.round(b / 1e6);

async function latency(db: Db, label: string, fn: (i: number) => Promise<unknown>, n = 60) {
  const t: number[] = [];
  const cold0 = performance.now();
  await fn(0);
  const cold = performance.now() - cold0;
  for (let i = 1; i <= n; i++) { const s = performance.now(); await fn(i); t.push(performance.now() - s); }
  return { label, cold_ms: +cold.toFixed(1), p50_ms: +pct(t, 0.5).toFixed(1), p95_ms: +pct(t, 0.95).toFixed(1), max_ms: +Math.max(...t).toFixed(1) };
}

async function main() {
  if (!args.includes("--keep")) rmSync(STATE, { recursive: true, force: true });
  mkdirSync(STATE, { recursive: true });
  const env = {
    host: { cpus: cpus().length, cpu: cpus()[0]?.model, ram_gb: Math.round(totalmem() / 2 ** 30), node: process.version },
    rows: ROWS, note: "Local workerd/Miniflare D1 on this machine. Not remote D1; not a capacity promise.",
  };
  console.log(JSON.stringify(env));
  applyMigrations("live", STATE);
  const { db, dispose } = await openDb("live", join(STATE));
  const result: Record<string, unknown> = { ...env, imports: [] as unknown[] };
  let peakW = 0;
  const sampler = setInterval(() => { peakW = Math.max(peakW, workerdPeakKb()); }, 2000);
  try {
    await stampMode(db, "live");
    for (let g = 0; g < GENS; g++) {
      const csvBytes = await writeCsv(ROWS, g);
      const prep = await prepareAcra(CSV, { version: `bench-${g}` }, `bench-${g}`);
      const t0 = performance.now();
      const r = await runImport(db, "acra", prep, { chunkSize: Number(arg("--chunk", "400")), onProgress: n => { if (n % 200_000 < 400) process.stdout.write(`\r  gen ${g}: ${n} written`); } });
      const secs = (performance.now() - t0) / 1000;
      const imp = { generation: g, status: r.status, csv_mb: mb(csvBytes), seconds: +secs.toFixed(1), rows_per_s: Math.round(ROWS / secs),
        rows_written_local_meta: (r as { rowsWritten?: number }).rowsWritten ?? null, state_mb_after: mb(dirBytes(STATE)),
        node_peak_rss_mb: Math.round(process.resourceUsage().maxRSS / 1024), workerd_peak_rss_mb: Math.round(Math.max(peakW, workerdPeakKb()) / 1024) };
      (result.imports as unknown[]).push(imp);
      console.log("\n" + JSON.stringify(imp));
    }
    // Latency on the active generation (warm = repeated after the first "cold" call in this process).
    const snap = await Snapshot.load(db, "live");
    const r = rng(7);
    const word = () => SYL[Math.floor(r() * SYL.length)];
    const Q = (text: string, o: Record<string, string> = {}) => ({ text, mode: "name" as const, category: "all", country: "", topic: "any", ...o });
    const lat = [
      await latency(db, "exact UEN", i => search(db, "live", { ...Q(`T99AA${String(i * 37 % 10000).padStart(4, "0")}${"ABCDEFGHIJKLMNOPQRSTUVWXYZ"[(i * 37 % 10000) % 26]}`), mode: "identifier" }, snap)),
      await latency(db, "exact name (2 tokens + suffix)", () => search(db, "live", Q(`${word()} ${word()} pte ltd`), snap)),
      await latency(db, "token + prefix (2 tokens)", () => search(db, "live", Q(`${word()} ${word().slice(0, 3)}`), snap)),
      await latency(db, "common single token (capped)", () => search(db, "live", Q(word()), snap)),
      await latency(db, "typo -> possible similar name", () => search(db, "live", Q(`${word()}x${word()}q`), snap)),
      await latency(db, "record detail", i => record(db, "live", `acra:T99AA${String(i % 10000).padStart(4, "0")}${"ABCDEFGHIJKLMNOPQRSTUVWXYZ"[i % 26]}`, snap)),
    ];
    result.latency = lat;
    lat.forEach(l => console.log(JSON.stringify(l)));
    // rows_read per query type (local meta; remote values may differ).
    const gen = snap.gen("acra")!;
    const meta = async (sql: string, ...a: unknown[]) => (await db.prepare(sql).bind(...a).all()).meta.rows_read;
    result.rows_read_local = {
      exact_uen: await meta("SELECT e.id FROM identifiers i JOIN entities e ON e.gen = i.gen AND e.id = i.entity_id WHERE i.type='uen' AND i.norm=? AND i.gen=?", "T99AA0001B", gen),
      exact_name: await meta("SELECT e.id FROM names n JOIN entities e ON e.gen = n.gen AND e.id = n.entity_id WHERE n.gen=? AND n.norm=? LIMIT 201", gen, "tan lim pte ltd"),
      fts_common_token_cap2000: await meta(`SELECT e.id FROM names_fts f CROSS JOIN names n ON n.nid = f.rowid JOIN entities e ON e.gen = n.gen AND e.id = n.entity_id WHERE names_fts MATCH ? AND n.gen = ? LIMIT 2000`, `g : "g${gen}" AND norm : "tan"`, gen),
      fts_two_tokens: await meta(`SELECT e.id FROM names_fts f CROSS JOIN names n ON n.nid = f.rowid JOIN entities e ON e.gen = n.gen AND e.id = n.entity_id WHERE names_fts MATCH ? AND n.gen = ? LIMIT 2000`, `g : "g${gen}" AND norm : "tan" AND norm : "marine"`, gen),
    };
    console.log(JSON.stringify(result.rows_read_local));
    result.state_mb_active_plus_previous = mb(dirBytes(STATE));
    const t0 = performance.now();
    let total = 0, rounds = 0, last;
    do { last = await cleanup(db, { graceMs: 0, maxBatches: 400, batchRows: 2000 }); total += last.deletedRows; rounds++; } while (!last.done && rounds < 200);
    result.cleanup = { note: "retired generations only (none if <3 generations); active/previous kept", deleted_rows: total, seconds: +((performance.now() - t0) / 1000).toFixed(1) };
    result.workerd_peak_rss_mb = Math.round(Math.max(peakW, workerdPeakKb()) / 1024);
    result.node_peak_rss_mb = Math.round(process.resourceUsage().maxRSS / 1024);
  } finally {
    clearInterval(sampler);
    await dispose();
  }
  const out = join(DIR, `bench-${ROWS}.json`);
  writeFileSync(out, JSON.stringify(result, null, 1));
  console.log(`\nwritten ${out}`);
}

main().catch(e => { console.error(e); process.exit(1); });
