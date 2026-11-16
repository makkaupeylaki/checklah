// Minimal structural D1 interface, satisfied by the Workers D1 binding and by wrangler's
// getPlatformProxy() binding used by the local CLI and tests.

export interface D1Meta {
  changes?: number;
  rows_read?: number;
  rows_written?: number;
  duration?: number;
  size_after?: number;
  [k: string]: unknown;
}
export interface Stmt {
  bind(...values: unknown[]): Stmt;
  first<T = Record<string, unknown>>(col?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[]; meta: D1Meta }>;
  run(): Promise<{ meta: D1Meta }>;
}
export interface Db {
  prepare(sql: string): Stmt;
  batch(stmts: Stmt[]): Promise<{ meta: D1Meta; results?: unknown[] }[]>;
}

/** D1 allows at most 100 bound parameters per statement. */
export const MAX_PARAMS = 100;

/** Build multi-row INSERT statements that each stay under the bound-parameter limit. */
export function insertMany(db: Db, table: string, cols: string[], rows: unknown[][], verb = "INSERT"): Stmt[] {
  if (!/^[a-z_]+$/.test(table) || !cols.every(c => /^[a-z_]+$/.test(c))) throw new Error("bad identifier");
  const per = Math.max(1, Math.floor((MAX_PARAMS - 1) / cols.length));
  const out: Stmt[] = [];
  for (let i = 0; i < rows.length; i += per) {
    const slice = rows.slice(i, i + per);
    const ph = `(${cols.map(() => "?").join(",")})`;
    const sql = `${verb} INTO ${table} (${cols.join(",")}) VALUES ${slice.map(() => ph).join(",")}`;
    out.push(db.prepare(sql).bind(...slice.flat()));
  }
  return out;
}

export function nowIso(now = Date.now()): string {
  return new Date(now).toISOString().replace(/\.\d{3}Z$/, "Z");
}
