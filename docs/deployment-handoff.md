# CheckLah — deployment handoff (NOT executed)

Everything below is **instructions only**. Stage 2 ran no remote command: no Cloudflare login, no remote
D1 creation, migration or import, no deploy, no domain or DNS change, no cron. Each step marked
**APPROVAL** needs the owner's explicit "Push" (or a more specific go-ahead) before anyone runs it.

## 0. Go / no-go gates (decide before step 1)

| Gate | Evidence so far | Open question |
|---|---|---|
| Use basis | Personal, non-commercial hobby use (owner, 16 Nov 2026) | Re-confirm the invited users understand it is not for work |
| Plan | D1's storage/write allowances quoted in the packet are **Workers Paid** allowances. Login hashing (scrypt) needs more CPU than the Free plan's per-request budget | Which Cloudflare plan the existing account is on, and whether other apps already use D1 allowances |
| Storage | **Measured locally (synthetic, 2.13M rows): 1.52 GB per ACRA generation incl. FTS and indexes → ≈ 3.0 GB steady state (active + previous) → ≈ 4.6 GB peak during an import** (`stage2-status.md` → *Benchmark*). Remote size not measured | **Likely NO-GO on included storage alone:** 4.6 GB is ~92 % of the 5 GB *included account* storage (shared with other apps), before OpenSanctions. It fits under the 10 GB per-database maximum, so the overage would be billed ($0.75/GB-month, packet [8]). Options: (a) drop the ACRA `previous` generation before a new import, giving a ≈ 3.0 GB peak but no rollback during that window; (b) drop the `names_entity` index (≈ 68 MB/gen) and FTS `docsize` (with `columnsize=0`, ≈ 28 MB/gen) after re-testing; (c) accept billed storage. Owner decision |
| Writes | Estimate in §6 below; local `rows_written` is an approximation | Monthly writes vs 50M included (shared). Remote `rows_written` must be measured on the first real import |
| Refresh runtime | A 2.13M-row CSV plus a multi-GB OpenSanctions export cannot be assumed to finish in one Cron invocation (15 min CPU/wall), and `waitUntil` adds at most 30 s | Run imports from an operator machine with the CLI (manual, monthly ACRA / daily-ish OpenSanctions), or approve an extra runtime (e.g. Queues/Workflows/R2 or an always-on runner). Both are owner decisions; neither was added |
| Source contracts | ACRA download host, status values, metadata endpoint; OpenSanctions metadata and context property names are **unresolved** (`source-contracts.md`) | Run the live contract checks there first |

## 1. Bindings, variables and secrets (names only)

| Name | Kind | Value / note |
|---|---|---|
| `DB` | D1 binding | one database **per mode**: `checklah-live` for the real app. Do not deploy the demo env publicly |
| `ASSETS` | static assets binding | `web/dist` (built by `npm run build` in `web/`) |
| `MODE` | var | `live` |
| `AUTH` | var | `local` (required; anything else fails closed off-loopback) |
| `ALLOW_LOOPBACK_NO_AUTH` | var | **must be absent or `false`** in hosted config |
| `REFRESH_ENABLED` | var | `false` until the refresh runtime decision |
| `LOGIN_PER_MINUTE`, `SEARCH_PER_MINUTE` | vars (optional) | defaults 5 / 30 |
| Secrets | — | none required by the Worker. User password **hashes** live in D1 (`users`). A data.gov.sg API key, if the owner later obtains one, would be an operator-side CLI secret, never in git or chat |

Hosted security behaviour already implemented: `__Host-` cookie prefix, `Secure; HttpOnly;
SameSite=Strict`, CSRF header plus Origin/Sec-Fetch-Site checks, D1-backed sessions with idle (30 min)
and absolute (12 h) expiry and per-user revocation, D1-backed rate limits, strict CSP, `no-store`, no
query strings, POST-only search/detail, no export endpoints, `workers_dev=false`, `preview_urls=false`,
`observability.enabled=false`.

Recommended in addition (owner decision, not configured): put the hostname behind an access layer with
individually allowlisted identities (for example Cloudflare Access) in front of the Worker's own
sign-in. Check the account's included seats before relying on it.

## 2. First deployment (APPROVAL)

```sh
# operator machine, logged in to the owner's Cloudflare account (never in this repo or chat)
cd worker
npx wrangler d1 create checklah-live                  # APPROVAL: creates a remote database
#   -> put the returned database_id into wrangler.jsonc env.live (replace the placeholder)
#   -> in env.live vars set AUTH "local", ALLOW_LOOPBACK_NO_AUTH "false"
npx wrangler d1 migrations apply DB --remote --env live   # APPROVAL
npx wrangler d1 execute DB --remote --env live \
  --command "INSERT INTO app_meta (key, value) VALUES ('mode', 'live')"   # APPROVAL: mode stamp
node tools/cli.ts add-user <name> --env live --print-sql   # prints an INSERT with a scrypt hash only
npx wrangler d1 execute DB --remote --env live --command "<that INSERT>"  # APPROVAL, per user
(cd ../web && npm run build)
npx wrangler deploy --env live                            # APPROVAL: no route/domain yet
```

Add a route or custom domain only as a separate approval.

## 3. First real import (APPROVAL, after the live contract checks)

The CLI writes to **local** D1. Remote writes need one of the following, chosen by the owner:

- **A. SQL-file path.** Import locally, then generate chunked SQL for the new generation's base rows
  (entities/names/identifiers/referents plus FTS inserts) and apply it with
  `wrangler d1 execute --remote --file`, keeping each statement under 100 KB and 100 parameters, with
  no transaction wrappers. Finish with the activation batch. *Not implemented yet*: the exporter is the
  next build step if this path is chosen.
- **B. D1 HTTP API path.** Point the same lifecycle code at the D1 HTTP API with an API token held by
  the operator. Needs a token-scoped credential; *not implemented*.
- **C. Worker-run chunks.** A bounded, checkpointed Worker job (Queues/Workflows) using the same
  `lifecycle.ts`. Needs paid add-ons and R2 for staging the files; *not implemented*.

Whichever is chosen: import ACRA first, then OpenSanctions; check `status`; then smoke test.

Do **not** restore FTS from a D1 export: the 12 Nov 2026 changelog says virtual-table exports (sqlite3
CLI compatibility mode) cannot be imported back into D1. Restore = base rows + `INSERT INTO names_fts
(rowid, norm, g) SELECT nid, norm, 'g' || gen FROM names` (tested locally in `d1-spike.test.ts`).

## 4. Smoke test (after deploy + import)

1. Unauthenticated `GET /api/sources` → 401; `/` loads the sign-in view; any `?q=` on `/api/*` → 400.
2. Sign in; the session cookie has `__Host-`, `Secure`, `HttpOnly`, `SameSite=Strict`.
3. Search a known UEN from the ACRA register → "Exact UEN", registry status as supplied, no topics.
4. Search a Singapore-linked OpenSanctions name → topics shown separately (Sanctions / PEP / other),
   "Singapore link (field)" shown, no passport/ID numbers anywhere.
5. Search nonsense → "No match in the selected sources and scope."
6. Sources view: both live sources connected, upstream/import/check timestamps, licences, scope note.
7. Sign out → API returns 401; `wrangler tail` (if used) shows only route templates, no names or IDs.
8. Record remote `rows_read`/`rows_written`/`size_after` from D1 metrics and compare with §6.

## 5. Rollback

- **Data:** `rollback` swaps the active and previous generation in one batch. Remote equivalent is the
  same three `UPDATE`s, run as one `wrangler d1 execute --remote --file` with the guard statement.
- **Code:** `wrangler rollback` to the previous Worker version (APPROVAL).
- **Users:** `revoke-user` equivalent: `UPDATE users SET session_epoch = session_epoch + 1 WHERE
  username = ?; DELETE FROM sessions WHERE username = ?`.
- **Database time travel** (D1 feature) as a last resort; check its retention on the plan first.

## 6. Rows-written estimate (conservative range; replace with remote measurements)

Basis: local D1 reported **19,215,824 rows written for one 2,133,906-row ACRA import ≈ 9.0 per entity**
(base rows plus index entries; FTS shadow-table writes may not be counted the same way remotely). Deletion of a retired
generation is assumed to cost about the same again. Exact local figures are in `stage2-status.md`.

| Item | Per event | Frequency | Monthly |
|---|---|---|---|
| ACRA import (2.13M rows) | ≈ 19M | 1 new release/month | ≈ 19M |
| ACRA cleanup of the retired generation | ≈ 19M | 1/month | ≈ 19M |
| ACRA unchanged daily check | 1 row (`checked_at`) | daily | ≈ 30 |
| OpenSanctions SG subset, 5k–30k entities × ~25 rows | 0.1M–0.75M | daily if content changed | 3M–23M |
| OpenSanctions cleanup | same | daily | 3M–23M |
| Sessions + limiter + idle refresh | ~1 per search/login, ≤1/min per active user | few users | < 0.1M |
| Retries / a failed staging generation | +50 % margin | — | — |
| **Total** | | | **≈ 45M – 125M rows/month** |

That range straddles the 50M rows/month included with Workers Paid (shared with other apps). Above it
D1 charges $1 per million rows written (packet [8]), i.e. up to roughly $75/month at the top of the
range, before storage. Options to stay low: refresh OpenSanctions weekly instead of daily; skip
generations whose substantive content is unchanged (already implemented, but processing timestamps
change often); keep the ACRA previous generation only until the smoke test passes. **Do not deploy
until remote measurements confirm the range.**

## 7. Approval points (in order)

1. Plan/allowance check and storage go/no-go (§0).
2. Live contract checks (`source-contracts.md`), then add the verified ACRA download host.
3. Remote import path A/B/C (§3).
4. `wrangler d1 create` + migrations + mode stamp + users.
5. `wrangler deploy` (no route), then route/custom domain and optional access layer.
6. First real imports + smoke test (§4).
7. Enabling any schedule (`REFRESH_ENABLED=true` + a cron trigger) only after a refresh runtime is
   approved. A cron that only checks versions is not "daily automatic refresh".
