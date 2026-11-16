// Durable auth state on D1: password hashes (scrypt, @noble/hashes), hashed session tokens with
// idle + absolute expiry and per-user revocation, CSRF tokens, and a fixed-window rate limiter.
// No process memory is relied on: any isolate/instance sees the same state.

import { scryptAsync } from "@noble/hashes/scrypt.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, randomBytes } from "@noble/hashes/utils.js";
import type { Db } from "./db.ts";

export const SCRYPT = { N: 2 ** 15, r: 8, p: 1, dkLen: 32 };
export const USERNAME_MAX = 64;
export const PASSWORD_MAX = 256;
export const IDLE_MS = 30 * 60 * 1000;
export const MAX_MS = 12 * 3600 * 1000;

const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));

export function randomToken(bytes = 32): string { return b64u(randomBytes(bytes)); }
export function hashToken(token: string): string { return bytesToHex(sha256(new TextEncoder().encode(token))); }

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const dk = await scryptAsync(new TextEncoder().encode(password), salt, SCRYPT);
  return `scrypt$${Math.log2(SCRYPT.N)}$${SCRYPT.r}$${SCRYPT.p}$${b64u(salt)}$${b64u(dk)}`;
}

function ctEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

export function tokensEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const e = new TextEncoder();
  return ctEqual(e.encode(a), e.encode(b));
}

export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  const p = stored.split("$");
  if (p.length !== 6 || p[0] !== "scrypt") return false;
  const [logN, r, pp] = [Number(p[1]), Number(p[2]), Number(p[3])];
  if (logN < 14 || logN > 17 || r !== 8 || pp !== 1) return false; // bounded cost; reject odd parameters
  const dk = await scryptAsync(new TextEncoder().encode(password), unb64u(p[4]), { N: 2 ** logN, r, p: pp, dkLen: 32 });
  return ctEqual(dk, unb64u(p[5]));
}

// A fixed dummy hash so unknown usernames cost the same as known ones.
const DUMMY = "scrypt$15$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

export async function checkLogin(db: Db, username: string, password: string): Promise<boolean> {
  if (username.length > USERNAME_MAX || password.length > PASSWORD_MAX) { await verifyPassword(DUMMY, "x"); return false; }
  const u = await db.prepare("SELECT pw_hash FROM users WHERE username = ? AND disabled = 0").bind(username).first<{ pw_hash: string }>();
  const ok = await verifyPassword(u?.pw_hash ?? DUMMY, password);
  return !!u && ok;
}

export interface Session { username: string; csrf: string }

export async function createSession(db: Db, username: string, now = Date.now()): Promise<{ token: string; session: Session }> {
  const token = randomToken(32);
  const csrf = randomToken(32);
  const u = await db.prepare("SELECT session_epoch FROM users WHERE username = ?").bind(username).first<{ session_epoch: number }>();
  await db.prepare("INSERT INTO sessions (token_hash, username, csrf, epoch, created_at, last_seen, expires_at) VALUES (?,?,?,?,?,?,?)")
    .bind(hashToken(token), username, csrf, u?.session_epoch ?? 0, now, now, now + MAX_MS).run();
  return { token, session: { username, csrf } };
}

export async function getSession(db: Db, token: string | null | undefined, now = Date.now()): Promise<Session | null> {
  if (!token || token.length > 100) return null;
  const th = hashToken(token);
  const s = await db.prepare(
    "SELECT s.username, s.csrf, s.last_seen FROM sessions s JOIN users u ON u.username = s.username " +
    "WHERE s.token_hash = ? AND s.expires_at > ? AND s.last_seen > ? AND s.epoch = u.session_epoch AND u.disabled = 0")
    .bind(th, now, now - IDLE_MS).first<{ username: string; csrf: string; last_seen: number }>();
  if (!s) return null;
  if (now - s.last_seen > 60_000) { // bounded writes: refresh idle timer at most once a minute
    await db.prepare("UPDATE sessions SET last_seen = ? WHERE token_hash = ?").bind(now, th).run();
  }
  return { username: s.username, csrf: s.csrf };
}

export async function destroySession(db: Db, token: string | null | undefined): Promise<void> {
  if (token && token.length <= 100) await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(hashToken(token)).run();
}

/** Per-user revocation: every existing session of this user stops working immediately. */
export async function revokeUser(db: Db, username: string): Promise<void> {
  await db.batch([
    db.prepare("UPDATE users SET session_epoch = session_epoch + 1 WHERE username = ?").bind(username),
    db.prepare("DELETE FROM sessions WHERE username = ?").bind(username),
  ]);
}

/** Fixed one-minute window counter in D1. Returns false once `limit` is exceeded. */
export async function rateLimit(db: Db, bucket: string, limit: number, now = Date.now()): Promise<boolean> {
  const window = Math.floor(now / 60_000);
  const r = await db.prepare(
    "INSERT INTO rate_limits (bucket, window, count) VALUES (?, ?, 1) ON CONFLICT(bucket, window) DO UPDATE SET count = count + 1 RETURNING count")
    .bind(bucket.slice(0, 120), window).first<{ count: number }>();
  if (Math.random() < 0.02) { // occasional bounded pruning
    await db.prepare("DELETE FROM rate_limits WHERE (bucket, window) IN (SELECT bucket, window FROM rate_limits WHERE window < ? LIMIT 200)").bind(window - 2).run();
  }
  return (r?.count ?? limit + 1) <= limit;
}

export function clientKey(ip: string | null): string {
  return bytesToHex(sha256(new TextEncoder().encode("checklah-client:" + (ip ?? "local")))).slice(0, 32);
}
