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

## Last run — 16 Nov 2026 (build container, demo data)

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
