// Test helpers: real local D1 (workerd via wrangler getPlatformProxy), schema from the real migration.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getPlatformProxy } from "wrangler";
import type { Db } from "../src/db.ts";
import worker, { type Env } from "../src/index.ts";
import { runImport } from "../src/importer/lifecycle.ts";
import { DEMO_SOURCES, demoPrepared } from "../src/importer/demo.ts";
import { CONFIG, WORKER_DIR } from "../tools/cli.ts";

export function migrationStatements(): string[] {
  const dir = join(WORKER_DIR, "migrations");
  const out: string[] = [];
  for (const f of readdirSync(dir).filter(f => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(join(dir, f), "utf8").split("\n").map(l => l.replace(/--.*$/, "")).join("\n");
    out.push(...sql.split(/;\s*\n/).map(s => s.trim()).filter(Boolean));
  }
  return out;
}

export async function openTestDb(mode: "demo" | "live" = "demo", persist: string | false = false) {
  const proxy = await getPlatformProxy<{ DB: Db }>({ configPath: CONFIG, environment: mode, persist: persist === false ? false : { path: persist } });
  const db = proxy.env.DB;
  return { db, dispose: proxy.dispose };
}

export async function migrate(db: Db, mode: "demo" | "live") {
  for (const s of migrationStatements()) await db.prepare(s).run();
  await db.prepare("INSERT OR IGNORE INTO app_meta (key, value) VALUES ('mode', ?)").bind(mode).run();
}

const TABLES = ["entities", "names", "identifiers", "referents", "generations", "sources", "users", "sessions", "rate_limits"];

export async function reset(db: Db, mode: "demo" | "live" = "demo") {
  const exists = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='app_meta'").first().catch(() => null);
  if (!exists) { await migrate(db, mode); return; }
  await db.batch([...TABLES.map(t => db.prepare(`DELETE FROM ${t}`)), db.prepare("DELETE FROM names_fts"), db.prepare("DELETE FROM app_meta"),
    db.prepare("INSERT INTO app_meta (key, value) VALUES ('mode', ?)").bind(mode)]);
}

export async function importDemo(db: Db, withProbes = true) {
  for (const s of DEMO_SOURCES) await runImport(db, s, demoPrepared(s, { withProbes }));
}

export function envFor(db: Db, over: Partial<Env> = {}): Env {
  return {
    DB: db,
    ASSETS: { fetch: async () => new Response("<!doctype html><title>CheckLah</title>", { headers: { "Content-Type": "text/html" } }) },
    MODE: "demo", AUTH: "off", ALLOW_LOOPBACK_NO_AUTH: "true", REFRESH_ENABLED: "false",
    ...over,
  };
}

/** Minimal cookie-jar client around the Worker's fetch handler (handler runs in Node, D1 in workerd). */
export class Client {
  jar = new Map<string, string>();
  csrf = "";
  env: Env;
  base: string;
  constructor(env: Env, base = "http://127.0.0.1:8787") { this.env = env; this.base = base; }
  async req(path: string, init: RequestInit & { json?: unknown } = {}) {
    const headers = new Headers(init.headers);
    if (this.jar.size) headers.set("Cookie", [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "));
    if (init.json !== undefined) { headers.set("Content-Type", "application/json"); init.body = JSON.stringify(init.json); init.method ??= "POST"; }
    const r = await worker.fetch(new Request(this.base + path, { ...init, headers }), this.env);
    for (const c of r.headers.getSetCookie()) {
      const [kv] = c.split(";");
      const i = kv.indexOf("=");
      const k = kv.slice(0, i), v = kv.slice(i + 1);
      if (/Max-Age=0/.test(c) || v === "") this.jar.delete(k); else this.jar.set(k, v);
    }
    return r;
  }
  async session() { const r = await this.req("/api/session"); const j = await r.json() as { csrf: string }; this.csrf = j.csrf; return j; }
  post(path: string, json: unknown, headers: Record<string, string> = {}) {
    return this.req(path, { method: "POST", json, headers: { "X-CheckLah-CSRF": this.csrf, ...headers } });
  }
}
