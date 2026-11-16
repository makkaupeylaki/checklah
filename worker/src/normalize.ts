// Text and identifier normalization (port of Stage 1 normalize.py).
// Original Unicode text is always preserved for display; these functions only build search keys.

export const MAX_QUERY_LEN = 200;
export const MAX_TOKENS = 8;
export const MAX_TOKEN_LEN = 64;

const CONTROL = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u2064\\ufeff]", "g");
const EXTRA_FOLD: Record<string, string> = { "ø": "o", "đ": "d", "ł": "l", "ı": "i", "ß": "ss", "æ": "ae", "œ": "oe", "þ": "th" };

/** Strip control/invisible characters and collapse whitespace. Keeps the user's characters. */
export function cleanInput(text: string): string {
  return text.replace(CONTROL, " ").split(/\s+/u).filter(Boolean).join(" ");
}

/** Search key: NFKC, lower-case, remove diacritics, punctuation -> space, collapse whitespace.
 *  Non-Latin scripts are kept (lower-cased), never transliterated. */
export function fold(text: string): string {
  let s = text.normalize("NFKC").toLowerCase();
  s = s.normalize("NFKD").replace(/\p{M}/gu, "");
  s = s.replace(/[øđłıßæœþ]/g, c => EXTRA_FOLD[c] ?? c);
  s = s.normalize("NFC");
  s = s.replace(/[^\p{L}\p{N}]+/gu, " ");
  return s.split(" ").filter(Boolean).join(" ");
}

export function tokens(text: string): string[] {
  return fold(text).split(" ").filter(Boolean).slice(0, MAX_TOKENS).map(t => t.slice(0, MAX_TOKEN_LEN));
}

/** Quote one token for FTS5. Tokens only contain letters/digits after fold(), so no FTS syntax
 *  (quotes, operators, column filters, NEAR, *) from user input can reach the query grammar. */
function ftsToken(t: string): string {
  if (!/^[\p{L}\p{N}]+$/u.test(t)) throw new Error("unsafe FTS token");
  return `"${t}"`;
}

/** FTS5 MATCH expression scoped to one generation: g : "g<N>" AND norm : "a" AND norm : "b"* */
export function ftsQuery(text: string, gen: number, opts: { prefixLast?: boolean; prefixAll?: number } = {}): string | null {
  if (!Number.isSafeInteger(gen) || gen < 0) throw new Error("bad generation");
  let toks = tokens(text);
  if (!toks.length) return null;
  const parts: string[] = [];
  if (opts.prefixAll) {
    // similar-name candidates: OR of short prefixes of each token
    const pre = [...new Set(toks.map(t => [...t].slice(0, opts.prefixAll).join("")).filter(t => [...t].length >= 2))];
    if (!pre.length) return null;
    return `g : "g${gen}" AND (${pre.map(p => `norm : ${ftsToken(p)}*`).join(" OR ")})`;
  }
  toks.forEach((t, i) => {
    const last = i === toks.length - 1;
    const prefix = last && (opts.prefixLast ?? true) && [...t].length >= 2;
    parts.push(`norm : ${ftsToken(t)}${prefix ? "*" : ""}`);
  });
  return `g : "g${gen}" AND ${parts.join(" AND ")}`;
}

// ---------------------------------------------------------------- identifiers

// Singapore UEN formats: 8 digits + check letter (businesses), 9 digits + check letter (local
// companies), and T/S/R + 2-digit year + 2-letter entity type + 4 digits + check letter.
const UEN_RE = /^(?:\d{8}[A-Z]|\d{9}[A-Z]|[TSR]\d{2}[A-Z]{2}\d{4}[A-Z])$/;

export function normalizeUen(text: string): string | null {
  const v = text.replace(/[\s-]/g, "").toUpperCase();
  return UEN_RE.test(v) ? v : null; // leading zeroes are preserved: UENs are text
}

const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/;

export function normalizeHost(host: string): string | null {
  let h = host.trim().replace(/\.$/, "").toLowerCase();
  if (!h || /[\s/@:]/.test(h)) return null;
  try {
    h = new URL(`http://${h}/`).hostname; // IDNA -> punycode
  } catch {
    return null;
  }
  return HOST_RE.test(h) ? h : null;
}

/** Canonical form for exact URL matching. Never fetched. */
export function normalizeUrl(text: string): string | null {
  const t = text.trim();
  if (!t.includes("://")) return null;
  let u: URL;
  try { u = new URL(t); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = normalizeHost(u.hostname);
  if (!host) return null;
  const port = u.port ? `:${u.port}` : ""; // URL() already drops default ports
  const path = u.pathname || "/";
  return `${u.protocol}//${host}${port}${path}${u.search}`;
}

export interface Identifier { type: "uen" | "url" | "domain"; value: string }

export function classifyIdentifier(text: string): Identifier | null {
  const t = cleanInput(text);
  if (!t) return null;
  const uen = normalizeUen(t);
  if (uen) return { type: "uen", value: uen };
  const url = normalizeUrl(t);
  if (url) return { type: "url", value: url };
  if (!t.includes(" ") && !t.includes("/")) {
    const host = normalizeHost(t);
    if (host) return { type: "domain", value: host };
  }
  return null;
}

export function urlHost(url: string): string | null {
  try { return new URL(url).hostname; } catch { return null; }
}

// ---------------------------------------------------------------- dates

const DATE_RE = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/;

/** 'year' | 'month' | 'day' for ISO-8601 prefixes; null if not a recognised date. Never pads. */
export function datePrecision(value: string): "year" | "month" | "day" | null {
  const m = DATE_RE.exec(value.trim());
  if (!m) return null;
  return m[3] ? "day" : m[2] ? "month" : "year";
}

// ---------------------------------------------------------------- links

/** Absolute http(s) link to a real host, else null. Used only to *render* links, never to fetch. */
export function safeLink(url: unknown): string | null {
  if (typeof url !== "string" || url.length > 2048) return null;
  const t = url.trim();
  if (new RegExp(CONTROL.source).test(t)) return null;
  if (!/^https?:\/\/[^/]/i.test(t)) return null;
  let u: URL;
  try { u = new URL(t); } catch { return null; }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || !normalizeHost(u.hostname)) return null;
  return t;
}

/** Display form of a listed (possibly dangerous) URL: not clickable, not auto-linkable. */
export function defang(url: string): string {
  return url.replaceAll("http://", "hxxp://").replaceAll("https://", "hxxps://").replaceAll(".", "[.]");
}

// ---------------------------------------------------------------- similarity (bounded)

/** Optimal-string-alignment distance with an early cut-off. O(len_a * len_b), callers cap lengths. */
export function editDistance(a: string, b: string, max: number): number {
  const A = [...a], B = [...b];
  if (Math.abs(A.length - B.length) > max) return max + 1;
  let prev2: number[] = [];
  let prev = Array.from({ length: B.length + 1 }, (_, j) => j);
  for (let i = 1; i <= A.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= B.length; j++) {
      const cost = A[i - 1] === B[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && A[i - 1] === B[j - 2] && A[i - 2] === B[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev2 = prev; prev = cur;
  }
  return prev[B.length];
}

/** Token-wise similar-name test: every query token must be within a small edit distance of a
 *  distinct candidate token (1 edit for 4–7 chars, 2 for 8+; shorter tokens must match exactly). */
export function similarName(queryNorm: string, candNorm: string): boolean {
  const q = queryNorm.split(" ").filter(Boolean);
  const c = candNorm.split(" ").filter(Boolean).slice(0, 12);
  if (!q.length || q.length > 6) return false;
  const used = new Set<number>();
  let edits = 0;
  for (const t of q) {
    const len = [...t].length;
    // Numbers (dates, registration numbers, list numbers) are never fuzzed: they must match exactly.
    const allowed = /\p{N}/u.test(t) ? 0 : len >= 8 ? 2 : len >= 4 ? 1 : 0;
    let best = -1, bestD = allowed + 1;
    c.forEach((ct, i) => {
      if (used.has(i)) return;
      const d = editDistance(t, ct, allowed);
      if (d < bestD) { bestD = d; best = i; }
    });
    if (best < 0) return false;
    used.add(best);
    edits += bestD;
  }
  return edits > 0; // exact token matches are reported by earlier tiers, not as "similar"
}
