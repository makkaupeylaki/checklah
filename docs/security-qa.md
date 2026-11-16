# CheckLah — security and QA checklist

Run this whole list before every proposed push. "Auto" items are covered by `make check`
(`pytest` + `npm run build` + `node web/tests/ui.mjs`). Results of the latest run are in the
"Last run" section at the end.

## Threat model (short)

| Asset | Threat | Control |
|---|---|---|
| Search terms (who someone looked up) | Leak via URLs, logs, caches, analytics, referrers | POST bodies only; quiet access log (route template only); `no-store`; no analytics/history; `Referrer-Policy: no-referrer` |
| Source records | Unauthenticated scraping; data in public assets | Auth on all `/api/*` data routes when enabled; no export endpoints; no records in bundle; caps + pagination; rate limits |
| Upstream data | Stored XSS / prompt-like text in names, notes, links | DOM via `textContent`; strict CSP (no inline script); URL protocol allowlist; listed URLs defanged and non-clickable |
| Importer | Malicious redirects, huge downloads, bad snapshot wiping data | Host allowlist per hop; size/time limits; validate-then-swap; previous snapshot kept |
| Server | SSRF, local-file reads, SQL/FTS injection | No user-controlled fetching or paths; parameterized SQL; FTS tokens reduced to word characters and quoted |
| People named in data | Namesake harm, guilt by colour | "May refer to a different person" banner; match reason shown; no percentages; coral only on source/topic tags; PEP ≠ wrongdoing |

## Stage 2 additions to the threat model

| Asset | Threat | Control |
|---|---|---|
| Demo/live separation | Live Worker serving demo data | Separate D1 databases/state dirs; `app_meta.mode` stamp checked per request; importer refuses cross-mode sources |
| Auth state | Process memory lost between isolates | Sessions, CSRF tokens, limiter rows in D1; token hashes only; per-user `session_epoch` revocation |
| Hosted exposure | Auth off on a public hostname | Auth off requires loopback hostname + `ALLOW_LOOPBACK_NO_AUTH=true` + no `cf-connecting-ip`; otherwise 503 |
| Import downloads | SSRF via poll-returned URL | HTTPS only; exact allowlisted hosts (ACRA download host unverified → empty list → fail closed); IP literals/localhost rejected |
| Active data | Mixed-generation reads, partial imports | Generation resolved once per request; activation is one batch; chunks commit with their cursor |
| Auth tables | Replaced by an import | Importers write only source tables; tests assert users/sessions survive imports |

## Checklist

### Privacy
- [ ] Auto — Search terms never appear in a URL (search is `POST`; record IDs only in paths).
- [ ] Auto — A search string, DOB and identifier do not appear in captured server logs.
- [ ] Auto — `/api/*` responses carry `Cache-Control: no-store`.
- [ ] Auto — No service worker, no analytics, no third-party requests (CSP `default-src 'self'`).
- [ ] Auto — `robots.txt` disallows all; `X-Robots-Tag: noindex, nofollow`; no sitemap.

### Access
- [ ] Auto — With auth on: unauthenticated `/api/search`, `/api/record/*`, `/api/sources` → 401.
- [ ] Auto — Login wrong password → 401; 6th attempt/minute → 429.
- [ ] Auto — Logout invalidates the session server-side; expired session → 401.
- [ ] Auto — `POST` without CSRF header or with foreign `Origin` → 403.
- [ ] Auto — Server refuses non-loopback bind when auth is off; refuses auth on without users/secret.
- [ ] Auto — No export/bulk-download endpoints exist (`/api/export*` → 404).
- [ ] Manual — No password, key or secret in the repo (`git grep -iE 'password|secret|api[_-]?key'` reviewed).

### Injection and output
- [ ] Auto — FTS operators/quotes (`"`, `*`, `NEAR`, `OR`, `-`, `:`) in queries do not error or broaden.
- [ ] Auto — SQL metacharacters in queries are inert.
- [ ] Auto — Over-long input → 422; control characters stripped.
- [ ] Auto — `javascript:`, `data:`, `vbscript:` and relative links from upstream are not rendered as links.
- [ ] Auto — An upstream name containing `<img onerror>` renders as text (UI test).
- [ ] Auto — Security headers present (CSP, nosniff, frame-ancestors/X-Frame-Options, COOP, Permissions-Policy).

### Import
- [ ] Auto — Changed schema, malformed rows, interrupted download, checksum mismatch, empty or
      shrunken snapshot: all leave `current` untouched and record the error.
- [ ] Auto — Deletion: records absent from the new snapshot disappear; referents resolve; removed IDs 404.
- [ ] Auto — Rollback restores the previous snapshot.
- [ ] Auto — Download helper rejects non-allowlisted hosts, including via redirect, and enforces size limits.

### Content and UX
- [ ] Auto — Demo banner always visible in demo mode; live mode cannot load the demo connector.
- [ ] Auto — Disconnected categories are disabled with a reason, not zero results.
- [ ] Auto — No-match, source-error and not-connected states are distinct.
- [ ] Auto — Keyboard: tab order reaches search, filters, results, detail close; Escape closes detail; focus returns.
- [ ] Auto — Both themes render; theme persists without flash.
- [ ] Manual — Screenshots at 320/390/768/1280 inspected: no clipped filters, overflow or tiny text.
- [ ] Manual — Copy review: no "safe", "legit", "clean", "scam", "criminal", no confidence %.

## Stage 2 checklist additions

- [x] Auto — Hosted (non-loopback, or edge `CF-Connecting-IP`) requests fail closed (503) unless `AUTH=local`, for API **and** static assets.
- [x] Auto — Hosted cookies use `__Host-` prefix, `Secure; HttpOnly; SameSite=Strict; Path=/`.
- [x] Auto — Sessions are D1 rows keyed by SHA-256 of a 256-bit token; idle (30 min) and absolute (12 h) expiry; per-user revocation via `session_epoch`; disabled users refused.
- [x] Auto — Session created on one runtime is valid on another sharing the database; logout on one is seen by the other.
- [x] Auto — Login (5/min per hashed client address) and search (30/min) limits are D1 rows shared across handler instances; limiter keys hold no search text or raw address.
- [x] Auto — Live Worker on a demo-stamped (or unstamped) database refuses to serve; demo sources cannot be imported into live; live sources cannot be imported into demo.
- [x] Auto — Record detail is `POST /api/record {id}`; IDs in URL paths → 404; platform request logs contain no names or IDs (checked on `wrangler dev` output).
- [x] Auto — Every query is bound to one active generation resolved per request; staging/previous rows are invisible; FTS `MATCH` is generation-scoped and built from quoted word tokens only.
- [x] Auto — Request body ≤ 4 KB, JSON only (415 otherwise), query ≤ 200 chars, ≤ 8 tokens, cursor ≤ 600 chars, ≤ 200 candidates per source, 20 per page.
- [x] Auto — Imports never write account tables; activation/rollback/chunk writes are guarded so a lost lock or moved pointer aborts the whole batch.
- [x] Auto — Download policy: https only, exact host allowlist per redirect hop, no IP literals/localhost/private names, no credentials/ports, size/time caps, Content-Length truncation check, 429/5xx bounded retries with Retry-After, 401/403 not retried; ACRA download host list empty → fail closed.
- [x] Auto — OpenSanctions identity-document numbers never stored; unsafe `sourceUrl` values (javascript:, data:, relative) never rendered as links; source HTML shown as text.
- [ ] Manual — Remote: none of the above has been checked on Cloudflare (pending deployment approval).

## Last run — Stage 2, 16 Nov 2026 (build container)

| Suite | Result |
|---|---|
| Worker tests (`npm test`, local D1 via workerd) | 83 passed, 0 failed |
| UI (`node web/tests/ui.cjs`, 4 `wrangler dev` runtimes) | 92 passed, 0 failed |
| Retired Python suite (`make legacy-test`) | 49 passed (run before the port; server code unchanged since) |
| TypeScript (`tsc` strict, worker + web) | clean |
| Secret scan (`git grep` for key/secret/password/token literals) | nothing outside tests |
| Screenshots (Stage 2) | demo 56 + live-fixture 12, both themes; inspected |

## Last run — Stage 1, 16 Nov 2026 (build container, demo data)

| Suite | Result |
|---|---|
| `pytest` (server/tests) | 49 passed |
| `node web/tests/ui.cjs` (real servers: demo, live-empty, demo+auth) | 72 passed (run twice, stable) |
| `npm run build` (tsc strict + Vite) | OK |
| Screenshots 320/390/768/1280 × Legacy/Classic × 7 states | 56 taken and inspected; curated set in `docs/screenshots/` |
| Contrast (token pairs on `--panel`) | muted 7.4:1 (Legacy) / 6.2:1 (Classic); text on accent 12.7 / 10.1; coral 8.1 / 6.2; `--faint` (3.8 / 3.2) is used only on disabled controls |
| Secrets in repo | none (`users.json`, `data/` are git-ignored) |

Known gaps (not covered by this run):
- Live connectors untested: no real data imported (docs unreachable; gate not passed).
- Self-hosted Plex Mono is the Latin subset: characters such as Ŝ, Ā or Cyrillic fall back to the
  system monospace font (readable, slightly different glyphs).
- Screen-reader check was structural (labels, roles, live region, focus) via Playwright, not a manual
  VoiceOver/NVDA pass.
- Rate limits and sessions are in-memory: they reset on restart, and a multi-process deployment would
  need a shared store.
