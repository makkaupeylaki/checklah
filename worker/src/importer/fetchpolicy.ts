// Outbound HTTP for importers only. Never used with user input, entity websites or sourceUrl values.

export class FetchRejected extends Error {}

export interface FetchDeps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}
export const realDeps: FetchDeps = { fetch: (...a) => fetch(...a), sleep: ms => new Promise(r => setTimeout(r, ms)), now: () => Date.now() };

const PRIVATE_HOST = /^(localhost|.*\.localhost|.*\.local|.*\.internal|metadata\.google\.internal)$/i;
const IP_LITERAL = /^(\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:.]+\])$/i;

/** Exact-host allowlist; https only; no credentials/ports; no IP literals or private names. */
export function checkUrl(raw: string, allowedHosts: readonly string[]): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new FetchRejected("invalid URL"); }
  if (u.protocol !== "https:") throw new FetchRejected("only https URLs are allowed");
  if (u.username || u.password) throw new FetchRejected("credentials in URL are not allowed");
  if (u.port && u.port !== "443") throw new FetchRejected("non-default port is not allowed");
  const host = u.hostname.toLowerCase();
  if (IP_LITERAL.test(host) || PRIVATE_HOST.test(host)) throw new FetchRejected("private or literal-address host is not allowed");
  if (!allowedHosts.includes(host)) throw new FetchRejected(`host not on the verified allowlist: ${host}`);
  return u;
}

/** Spaces requests to one API (e.g. data.gov.sg: at most 5 requests/minute -> >= 12 s apart). */
export class Pacer {
  private last = -Infinity;
  private readonly minGapMs: number;
  private readonly deps: FetchDeps;
  constructor(minGapMs: number, deps: FetchDeps) { this.minGapMs = minGapMs; this.deps = deps; }
  async wait(): Promise<void> {
    const gap = this.last + this.minGapMs - this.deps.now();
    if (gap > 0) await this.deps.sleep(gap);
    this.last = this.deps.now();
  }
}

export function retryAfterMs(h: string | null, now: number): number | null {
  if (!h) return null;
  if (/^\d+$/.test(h.trim())) return Math.min(Number(h) * 1000, 15 * 60 * 1000);
  const t = Date.parse(h);
  return Number.isNaN(t) ? null : Math.max(0, Math.min(t - now, 15 * 60 * 1000));
}

export interface RequestOpts {
  allowedHosts: readonly string[];
  timeoutMs: number;
  maxRetries?: number;          // for 429/5xx/network errors only
  pacer?: Pacer;
  accept?: string;
  maxRedirects?: number;
}

/** GET with manual redirects (each hop re-checked), timeout, bounded retries + backoff + Retry-After.
 *  401/403/404 are not retried. */
export async function safeGet(url: string, opts: RequestOpts, deps: FetchDeps = realDeps): Promise<Response> {
  const maxRetries = opts.maxRetries ?? 3;
  let attempt = 0;
  for (;;) {
    let current = checkUrl(url, opts.allowedHosts).toString();
    let resp: Response | null = null;
    try {
      for (let hop = 0; hop <= (opts.maxRedirects ?? 3); hop++) {
        await opts.pacer?.wait();
        resp = await deps.fetch(current, { method: "GET", redirect: "manual", headers: { Accept: opts.accept ?? "*/*", "User-Agent": "checklah-importer/0.2" }, signal: AbortSignal.timeout(opts.timeoutMs) });
        if ([301, 302, 303, 307, 308].includes(resp.status)) {
          const loc = resp.headers.get("Location");
          await resp.body?.cancel();
          if (!loc) throw new FetchRejected("redirect without Location");
          current = checkUrl(new URL(loc, current).toString(), opts.allowedHosts).toString();
          resp = null;
          continue;
        }
        break;
      }
      if (!resp) throw new FetchRejected("too many redirects");
    } catch (e) {
      if (e instanceof FetchRejected) throw e;
      if (attempt++ >= maxRetries) throw new FetchRejected(`network error after ${attempt} attempts: ${(e as Error).name}`);
      await deps.sleep(backoff(attempt));
      continue;
    }
    if (resp.status === 429 || resp.status >= 500) {
      const ra = retryAfterMs(resp.headers.get("Retry-After"), deps.now());
      await resp.body?.cancel();
      if (attempt++ >= maxRetries) throw new FetchRejected(`HTTP ${resp.status} after ${attempt} attempts`);
      await deps.sleep(ra ?? backoff(attempt));
      continue;
    }
    if (resp.status === 401 || resp.status === 403) { await resp.body?.cancel(); throw new FetchRejected(`HTTP ${resp.status}: access refused (not retried)`); }
    if (!resp.ok) { await resp.body?.cancel(); throw new FetchRejected(`HTTP ${resp.status}`); }
    return resp;
  }
}

function backoff(attempt: number): number { return Math.min(2 ** attempt * 2000, 60_000); }

/** Read a small JSON API response with a byte cap (never for bulk files). */
export async function readSmallJson(resp: Response, maxBytes = 256 * 1024): Promise<unknown> {
  const ct = resp.headers.get("Content-Type") ?? "";
  if (!ct.includes("json")) throw new FetchRejected(`unexpected content type for API response: ${ct.split(";")[0] || "none"}`);
  const reader = resp.body!.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > maxBytes) { await reader.cancel(); throw new FetchRejected("API response too large"); }
    chunks.push(value);
  }
  const buf = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) { buf.set(c, o); o += c.length; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buf)); } catch { throw new FetchRejected("API response is not valid JSON"); }
}

/** Stream a bulk response into a sink with byte/time limits and truncation detection. */
export async function streamBody(resp: Response, sink: (chunk: Uint8Array) => Promise<void> | void, opts: { maxBytes: number; deadlineMs: number; now: () => number; rejectTypes?: string[] }): Promise<number> {
  const ct = (resp.headers.get("Content-Type") ?? "").split(";")[0].trim().toLowerCase();
  if ((opts.rejectTypes ?? ["text/html", "application/json"]).includes(ct)) { await resp.body?.cancel(); throw new FetchRejected(`unexpected content type for bulk file: ${ct}`); }
  const declared = resp.headers.get("Content-Length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > opts.maxBytes) { await resp.body?.cancel(); throw new FetchRejected("declared size exceeds limit"); }
  const reader = resp.body!.getReader();
  let n = 0;
  for (;;) {
    let r;
    try { r = await reader.read(); } catch (e) { throw new FetchRejected(`transfer interrupted: ${(e as Error).name}`); }
    if (r.done) break;
    n += r.value.length;
    if (n > opts.maxBytes) { await reader.cancel(); throw new FetchRejected("size limit exceeded"); }
    if (opts.now() > opts.deadlineMs) { await reader.cancel(); throw new FetchRejected("time limit exceeded"); }
    await sink(r.value);
  }
  if (declared && /^\d+$/.test(declared) && n !== Number(declared)) throw new FetchRejected(`truncated transfer: ${n} of ${declared} bytes`);
  return n;
}
