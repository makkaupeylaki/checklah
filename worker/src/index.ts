// CheckLah Worker: same-origin JSON API + static frontend (env.ASSETS), backed by D1.

import { checkLogin, clientKey, createSession, destroySession, getSession, rateLimit, randomToken, tokensEqual, type Session } from "./auth.ts";
import type { Db } from "./db.ts";
import { cleanup } from "./importer/lifecycle.ts";
import { dueChecks } from "./refresh.ts";
import { MAX_QUERY_LEN } from "./normalize.ts";
import { record, search, Snapshot, sourcesView } from "./search.ts";
import type { Mode } from "./sources.ts";

export interface Env {
  DB: Db;
  ASSETS: { fetch(req: Request): Promise<Response> };
  MODE: string;
  AUTH: string;                    // "off" | "local"
  ALLOW_LOOPBACK_NO_AUTH?: string; // "true" only in local dev config
  REFRESH_ENABLED?: string;        // "true" only after deployment approval
  LOGIN_PER_MINUTE?: string;
  SEARCH_PER_MINUTE?: string;
}

const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; " +
  "manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'";
const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": CSP,
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
};
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const MAX_BODY = 4096;

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, msg: string) { super(msg); this.status = status; }
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...headers } });
}

function withHeaders(resp: Response, api: boolean): Response {
  const r = new Response(resp.body, resp);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!r.headers.has(k)) r.headers.set(k, v);
  if (api) r.headers.set("Cache-Control", "no-store");
  return r;
}

function cookies(req: Request): Map<string, string> {
  const m = new Map<string, string>();
  for (const part of (req.headers.get("Cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) m.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  return m;
}

interface Ctx { env: Env; req: Request; url: URL; mode: Mode; secure: boolean; names: { session: string; csrf: string } }

function cookieHeader(ctx: Ctx, name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${ctx.secure ? "; Secure" : ""}`;
}

/** Hosted (non-loopback) access requires real authentication. Fails closed. */
function hostingAllowed(env: Env, req: Request, url: URL): string | null {
  if (env.MODE !== "demo" && env.MODE !== "live") return "Server misconfigured: MODE must be demo or live.";
  if (env.AUTH === "local") return null;
  if (env.AUTH !== "off") return "Server misconfigured: AUTH must be off or local.";
  // wrangler dev sets CF-Connecting-IP to a loopback address; on Cloudflare it is the client's public IP.
  const cip = req.headers.get("cf-connecting-ip");
  const loopback = LOOPBACK.has(url.hostname) && (cip === null || cip === "127.0.0.1" || cip === "::1");
  if (loopback && env.ALLOW_LOOPBACK_NO_AUTH === "true") return null;
  return "Authentication is required for non-loopback access. Configure AUTH=local.";
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  const ct = req.headers.get("Content-Type") ?? "";
  if (!ct.startsWith("application/json")) throw new HttpError(415, "Expected application/json.");
  const len = Number(req.headers.get("Content-Length") ?? "0");
  if (len > MAX_BODY) throw new HttpError(413, "Request too large.");
  const text = await req.text();
  if (text.length > MAX_BODY) throw new HttpError(413, "Request too large.");
  try {
    const v = JSON.parse(text);
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch { /* fall through */ }
  throw new HttpError(422, "Invalid request.");
}

const enumOf = <T extends string>(v: unknown, allowed: readonly T[], dflt: T): T => {
  if (v === undefined) return dflt;
  if (typeof v === "string" && (allowed as readonly string[]).includes(v)) return v as T;
  throw new HttpError(422, "Invalid request.");
};

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const start = Date.now();
    const url = new URL(req.url);
    const api = url.pathname.startsWith("/api/");
    let template = api ? "/api/(unknown)" : "(static)";
    let resp: Response;
    try {
      const block = hostingAllowed(env, req, url);
      if (block) throw new HttpError(503, block);
      const secure = url.protocol === "https:" || !LOOPBACK.has(url.hostname);
      const ctx: Ctx = { env, req, url, mode: env.MODE as Mode, secure,
        names: secure ? { session: "__Host-checklah_session", csrf: "__Host-checklah_csrf" } : { session: "checklah_session", csrf: "checklah_csrf" } };
      if (!api) {
        if (url.pathname === "/robots.txt") resp = new Response("User-agent: *\nDisallow: /\n", { headers: { "Content-Type": "text/plain" } });
        else resp = await env.ASSETS.fetch(req);
      } else {
        const routed = await routeApi(ctx, t => (template = t));
        resp = routed;
      }
    } catch (e) {
      if (e instanceof HttpError) resp = json({ error: e.message }, e.status);
      else {
        console.error(`unhandled ${(e as Error)?.name ?? "error"}`); // never the message: it may contain user input
        resp = json({ error: "Internal error." }, 500);
      }
    }
    // Quiet log: method, route template (never IDs, bodies or query strings), status, time.
    console.log(`${req.method} ${template} ${resp.status} ${Date.now() - start}ms`);
    return withHeaders(resp, api || url.pathname === "/" || url.pathname === "/index.html");
  },

  async scheduled(_event: unknown, env: Env): Promise<void> {
    if (env.REFRESH_ENABLED !== "true") {
      console.log("scheduled: refresh disabled (REFRESH_ENABLED is not true)");
      return;
    }
    // Bounded maintenance only. Full imports run through the CLI path until an execution runtime
    // for multi-GB streams is approved (docs/deployment-handoff.md).
    const r = await cleanup(env.DB, { maxBatches: 50 });
    const due = await dueChecks(env.DB, env.MODE as Mode);
    console.log(`scheduled: cleanup removed ${r.generationsRemoved} generations; checks due: ${due.map(d => d.source).join(",") || "none"}`);
  },
};

async function routeApi(ctx: Ctx, setTemplate: (t: string) => void): Promise<Response> {
  const { req, url, env } = ctx;
  if (url.search) throw new HttpError(400, "Query strings are not accepted.");
  if (!["GET", "HEAD", "POST"].includes(req.method)) throw new HttpError(405, "Method not allowed.");
  const db = env.DB;
  const ck = cookies(req);
  const sessionToken = ck.get(ctx.names.session);

  // Database must be stamped with this Worker's mode: no demo/live fallback.
  const stamp = await db.prepare("SELECT value FROM app_meta WHERE key = 'mode'").first<{ value: string }>().catch(() => null);
  if (!stamp) throw new HttpError(503, "Database not initialised for this mode. Run the CLI init step.");
  if (stamp.value !== ctx.mode) throw new HttpError(503, "Database mode does not match this server's mode. Refusing to serve.");

  let session: Session | null = null;
  if (env.AUTH === "local") session = await getSession(db, sessionToken);

  if (req.method === "POST") {
    const origin = req.headers.get("Origin");
    const site = req.headers.get("Sec-Fetch-Site");
    if ((origin && origin !== url.origin) || (site && site !== "same-origin" && site !== "none")) throw new HttpError(403, "Cross-origin request refused.");
    const sent = req.headers.get("X-CheckLah-CSRF");
    let expected: string | null | undefined;
    if (env.AUTH === "local" && url.pathname !== "/api/login") {
      if (!session) throw new HttpError(401, "Sign in required.");
      expected = session.csrf;
    } else {
      expected = ck.get(ctx.names.csrf); // double-submit token (pre-login or auth off)
    }
    if (!tokensEqual(sent, expected)) throw new HttpError(403, "Missing or invalid CSRF token.");
  }
  const publicRoute = url.pathname === "/api/session" || url.pathname === "/api/login";
  if (env.AUTH === "local" && !publicRoute && !session) throw new HttpError(401, "Sign in required.");

  const path = url.pathname;
  if (path === "/api/session" && req.method === "GET") {
    setTemplate("/api/session");
    const body = { mode: ctx.mode, auth: env.AUTH };
    if (session) return json({ ...body, authenticated: true, user: session.username, csrf: session.csrf });
    const csrf = randomToken(32);
    return json({ ...body, authenticated: env.AUTH !== "local", user: null, csrf }, 200,
      { "Set-Cookie": cookieHeader(ctx, ctx.names.csrf, csrf, 3600) });
  }
  if (path === "/api/login" && req.method === "POST") {
    setTemplate("/api/login");
    if (env.AUTH !== "local") throw new HttpError(400, "Authentication is not enabled.");
    const ipKey = clientKey(req.headers.get("cf-connecting-ip"));
    if (!(await rateLimit(db, `login:${ipKey}`, Number(env.LOGIN_PER_MINUTE ?? 5)))) throw new HttpError(429, "Too many sign-in attempts. Wait a minute.");
    const body = await readJson(req);
    const username = typeof body.username === "string" ? body.username : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!(await checkLogin(db, username, password))) throw new HttpError(401, "Wrong username or password.");
    await destroySession(db, sessionToken);
    const { token, session: s } = await createSession(db, username);
    const headers = new Headers({ "Content-Type": "application/json; charset=utf-8" });
    headers.append("Set-Cookie", cookieHeader(ctx, ctx.names.session, token, 12 * 3600));
    headers.append("Set-Cookie", cookieHeader(ctx, ctx.names.csrf, "", 0));
    return new Response(JSON.stringify({ mode: ctx.mode, auth: env.AUTH, authenticated: true, user: s.username, csrf: s.csrf }), { headers });
  }
  if (path === "/api/logout" && req.method === "POST") {
    setTemplate("/api/logout");
    await destroySession(db, sessionToken);
    const headers = new Headers({ "Content-Type": "application/json; charset=utf-8" });
    headers.append("Set-Cookie", cookieHeader(ctx, ctx.names.session, "", 0));
    headers.append("Set-Cookie", cookieHeader(ctx, ctx.names.csrf, "", 0));
    return new Response(JSON.stringify({ ok: true }), { headers });
  }
  if (path === "/api/search" && req.method === "POST") {
    setTemplate("/api/search");
    const key = session ? `search:u:${session.username}` : `search:${clientKey(req.headers.get("cf-connecting-ip"))}`;
    if (!(await rateLimit(db, key, Number(env.SEARCH_PER_MINUTE ?? 30)))) throw new HttpError(429, "Too many searches. Wait a minute.");
    const b = await readJson(req);
    if (typeof b.q !== "string" || b.q.length > MAX_QUERY_LEN) throw new HttpError(422, "Invalid request.");
    const country = b.country ?? "";
    if (typeof country !== "string" || !/^([a-z]{2})?$/.test(country)) throw new HttpError(422, "Invalid request.");
    if (b.cursor !== undefined && b.cursor !== null && (typeof b.cursor !== "string" || b.cursor.length > 600)) throw new HttpError(422, "Invalid request.");
    const q = {
      text: b.q, mode: enumOf(b.mode, ["name", "identifier"] as const, "name"),
      category: enumOf(b.category, ["all", "person", "company", "website", "record"] as const, "all"),
      country, topic: enumOf(b.topic, ["any", "sanction", "pep"] as const, "any"), cursor: (b.cursor as string | null | undefined) ?? null,
    };
    const snap = await Snapshot.load(db, ctx.mode);
    return json(await search(db, ctx.mode, q, snap));
  }
  if (path === "/api/record" && req.method === "POST") {
    // POST body, not a URL path: record IDs identify who was looked up and URL paths end up in
    // platform request logs (observed in wrangler dev; Cloudflare request logs/tail behave alike).
    setTemplate("/api/record");
    const b = await readJson(req);
    if (typeof b.id !== "string" || b.id.length > 200) throw new HttpError(422, "Invalid request.");
    const id = b.id;
    const r = await record(db, ctx.mode, id);
    if (!r) return json({ error: "Record not found in the current snapshot. It may have been removed by the source in the latest import." }, 404);
    return json(r);
  }
  if (path === "/api/sources" && req.method === "GET") {
    setTemplate("/api/sources");
    return json(await sourcesView(db, ctx.mode));
  }
  throw new HttpError(404, "Not found.");
}
