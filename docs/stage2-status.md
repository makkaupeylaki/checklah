# CheckLah — Stage 2 status

Date: 16 Nov 2026. Branch `claude/new-session-vodaq2`. **Nothing deployed. No remote D1. No real
upstream call completed** (the build container's egress policy refused `data.opensanctions.org`,
`api-open.data.gov.sg`, `data.gov.sg` and `www.opensanctions.org`).

## Verification levels used below

| Level | Meaning |
|---|---|
| **Fixture-tested** | Code run against synthetic contract fixtures in Node + local D1 |
| **Local-runtime-tested** | Exercised through `wrangler dev` (workerd + local D1) or `getPlatformProxy` |
| **Live-source-tested** | Run against the real ACRA / OpenSanctions downloads. **None yet** |
| **Remote-D1-tested** | Run against a Cloudflare-hosted D1 database. **None yet** |

## Plain-language change list

- The app now runs as a Cloudflare Worker with a D1 database, **on this machine only** (`make serve`).
  The old Python server is retired; nothing starts it any more.
- Demo and live are two separate databases. Each is stamped with its mode, and a live app refuses to
  open a demo database.
- Real importers exist for the ACRA register and for OpenSanctions (Singapore-linked people and
  companies only). They have only been tried on hand-made test files, not on the real downloads.
- Imports build a complete new copy, check it, then switch over in one step. A failed or odd import
  leaves the current data alone, and the previous copy is kept for rollback.
- Search adds a clearly labelled "Possible similar name" tier for small typos, with numbers never fuzzed.
- Opening a record now sends its ID in the request body, so names and IDs never appear in web addresses
  or server logs.
- Sign-in sessions and rate limits are stored in the database, so they work across server instances.
  Any public (non-local) address is refused unless sign-in is switched on.
- A record from OpenSanctions shows its sanction entries, which field linked it to Singapore, and
  relationships. Names of related people outside the Singapore scope are hidden, and passport/ID numbers
  are never stored.
- The empty result now reads "No match in the selected sources and scope."
- The daily refresh rule is written but switched off. Nothing is scheduled.
- Measured: one full ACRA-sized copy takes about 1.5 GB locally and an hour to import here. Keeping a
  rollback copy while importing a new one peaks near 4.6 GB (see the storage go/no-go).

## What is implemented, and how far it is verified

| Area | Implemented | Fixture | Local runtime | Live source | Remote D1 |
|---|---|---|---|---|---|
| Worker API + static assets (`worker/src/index.ts`) | yes | — | yes (`wrangler dev`, UI suite) | n/a | pending |
| D1 schema, migrations (`worker/migrations`) | yes | — | yes (`wrangler d1 migrations apply --local`) | n/a | pending |
| FTS5 on D1 (tokenizer, MATCH, prefix, bm25, rebuild, delete, restore) | yes | — | yes (spike suite) | n/a | pending |
| Search tiers, filters, keyset pagination, generation isolation | yes | yes | yes | pending | pending |
| "Possible similar name" (bounded rerank) | yes | yes (FP/FN cases) | yes | pending | pending |
| Snapshot lifecycle (lock, chunks, resume, guarded activation, rollback, cleanup) | yes | yes (fault injection) | yes | pending | pending |
| D1 sessions / CSRF / limiter / revocation / cross-instance | yes | — | yes (two runtimes sharing one local D1) | n/a | pending |
| Demo/live isolation (separate DBs + mode stamp) | yes | — | yes | n/a | pending |
| ACRA CSV parser + mapping | yes | yes | yes (CLI import, UI) | **pending** | pending |
| ACRA initiate/poll/download client | yes | mocked network only | — | **pending** (host unverified → fails closed) | n/a |
| OpenSanctions NDJSON passes + SG subset + context | yes | yes | yes (CLI import, UI) | **pending** | pending |
| OpenSanctions download | yes (6 h floor, size/time caps) | mocked policy tests | — | **pending** | n/a |
| Daily refresh policy (`refresh.ts`) | yes, **disabled** | — | `scheduled()` no-op when disabled | n/a | pending |
| Unattended production refresh | **no**: needs a runtime decision (deployment-handoff §0, §3) | | | | |
| Remote import path (SQL files / HTTP API / Worker job) | **no**: owner decision | | | | |

## Commands run and results (this session)

| Command | Result |
|---|---|
| `make legacy-test` (Stage 1 baseline before the port, and again at the end) | 49 passed both times |
| `npx tsc -p worker/tsconfig.json` (strict, `erasableSyntaxOnly`) | clean |
| `cd worker && npm test` (Node test runner, local D1 via workerd) | **83 passed, 0 failed** |
| `cd web && npm run build` | ok |
| `node web/tests/ui.cjs` (4 `wrangler dev` runtimes: demo, live-empty, live-fixtures, demo+auth) | **92 passed, 0 failed** |
| `node web/tests/shots.cjs` (+ live fixtures pass) | 68 screenshots at 320/390/768/1280 (live: 390/1280), both themes; inspected; 10 curated in `docs/screenshots/stage2/` |
| Final QA pass (end of session) | tsc clean (worker + web); worker 83/83; UI 92/92; legacy 49/49 |
| CLI smoke: `init --env live`, `import acra --file fixture` (×2 → `unchanged`), wrong-checksum manifest, `import demo --env live`, `import phishtank` | imported / unchanged (no writes) / rejected / refused / refused |
| `node worker/tools/bench.ts --rows 2133906 --generations 2` | see *Benchmark* |

### Test mapping (Stage 1 → Stage 2)

| Stage 1 (Python, kept) | Stage 2 equivalent |
|---|---|
| `test_normalize.py` (9) | `normalize.test.ts` (12): plus FTS-expression and similar-name cases |
| `test_search.py` (14) | `search.test.ts` (15): plus keyset pagination, generation isolation, live-empty |
| `test_import.py` (12) | `lifecycle.test.ts` (12), `acra.test.ts` (10), `opensanctions.test.ts` (10) |
| `test_security.py` (14) | `api.test.ts` (12): plus fail-closed hosting, durable/cross-instance sessions and limits, DB mode stamp |
| UI 72 checks (Python servers) | UI 92 checks (wrangler dev). Changed: no-match wording now names "selected sources and scope" |
| — | `d1-spike.test.ts` (12) |

No Stage 1 test was deleted; the Python suite still runs (`make legacy-test`).

## Findings from the local D1 spike (fixed in code)

1. With `JOIN names … WHERE names_fts MATCH ? AND n.gen = ?`, SQLite drove from `names` by generation
   (a full-generation scan per query). Fixed with `CROSS JOIN` (FTS first). The plan is asserted in
   `d1-spike.test.ts`.
2. `DELETE … WHERE nid IN (SELECT nid … ORDER BY nid LIMIT n)` planned as `SCAN names`. Cleanup now
   deletes name/FTS rows by nid range (a generation owns `[gen·2³², (gen+1)·2³²)`) and other tables by
   unordered rowid subqueries. Plans asserted.
3. D1 refuses `sqlite_version()`, `load_extension`, `ATTACH`; the app depends on none of them.
4. 100 bound parameters per statement enforced locally; `insertMany` stays under it.
5. `unicode61` does not segment CJK runs (a full CJK name matches only as a whole token). Documented
   limitation.
6. `DELETE … LIMIT` works locally but is **not relied on** (remote support unverified).

## Other fixes found by tests

- Similar-name tier fuzzed numeric tokens ("1050" ≈ "1051"). Numbers must now match exactly.
- `csv-parse` with `skip_records_with_error` silently skipped an unterminated quote at end of file.
  This is now fatal ("truncated").
- Record IDs in `GET /api/record/<id>` appeared in the platform request log (`wrangler dev`). Detail is
  now `POST /api/record {id}`; URL paths with IDs return 404. This is the one API-shape change from Stage 1.
- Fail-closed hosting guard rejected `wrangler dev` because it sets a loopback `CF-Connecting-IP`; now
  only loopback values are accepted, and only together with `ALLOW_LOOPBACK_NO_AUTH=true`.
- ACRA rows repeated ~550 bytes of per-source constants; moved to source defaults (display unchanged).

## Benchmark (local, synthetic; `docs/bench/bench-2133906.json`)

**What this is:** `node worker/tools/bench.ts --rows 2133906 --generations 1`. It generates a synthetic
ACRA-shaped CSV (211 MB, impossible `T99…` UENs, random syllable names) and imports it through the real
ACRA parser and lifecycle into **local** D1 (workerd/Miniflare) via `getPlatformProxy`. Machine: build
container, Intel Xeon @ 2.10 GHz, 4 vCPU, 16 GB RAM, Node 22.23.4. **Not remote D1. Not a capacity or
latency promise for Cloudflare.** One full-scale generation was run (about 1 hour). Generation scaling
was measured at 100k rows (1 generation 105 MB → 2 generations 205 MB, linear, before the row
compaction below).

| Measure | Result (2,133,906 entities, 1 generation) |
|---|---|
| Import wall time | 3,620 s (≈ 589 rows/s). Bottleneck: per-statement RPC into local D1; Node parse/hash/row-building is < 1 s per 20k rows. Chunk size 400 vs 2,000 made no difference |
| Local `rows_written` (D1 meta) | 19,215,824 ≈ **9.0 per entity** (entity + name + FTS + identifier rows and index entries, as counted locally) |
| Peak memory | Node CLI 781 MB RSS (includes the duplicate-UEN set); workerd 672 MB RSS |
| On-disk size, 1 generation | **1,524 MB** (dbstat), state dir 1,537 MB |
| Storage by object | entities 876 MB (57 %), names 152, identifiers 86, names_norm 70, names_entity 68, names_fts_content 65, entities PK 61, identifiers_lookup 59, names_fts_data 36, names_fts_docsize 28, identifiers_gen 22 |
| Active + previous (steady state) | ≈ 3.0 GB (2 × measured; linear per the 100k run) |
| **Peak during an import** (staging + active + previous) | **≈ 4.6 GB**, plus the OpenSanctions subset and auth tables |

Latency on the active generation (in-process calls into local D1; cold = first call after the import):

| Query | cold | p50 | p95 | max | local rows_read |
|---|---|---|---|---|---|
| Exact UEN | 24.5 ms | 19.6 | 24.2 | 25.4 | 3 |
| Exact name (2 tokens + suffix) | 104.7 | 105.1 | 134.1 | 146.5 | 95* |
| Token + prefix (2 tokens) | 93.0 | 84.0 | 114.5 | 126.4 | ≤ 5,999 (capped scan) |
| Common single token (truncated) | 12.7 | 13.2 | 15.8 | 20.1 | ≤ 5,999 (capped) |
| Typo → possible similar name | 26.3 | 38.1 | 51.9 | 58.0 | ≤ 300 candidates |
| Record detail | 21.0 | 16.7 | 22.8 | 212.7 | — |

\* The synthetic vocabulary (≈ 46 syllables) makes many names collide, so exact-name lookups return
more candidates than real ACRA names would. Every search reads a bounded number of rows: FTS scans are
capped at 2,000 name rows plus joins, and results at 200 per source.

**Go/no-go reading (for the owner):** one ACRA generation measures about 1.5 GB locally. Keeping a
previous generation for rollback and building a new one alongside both means a peak near **4.6 GB**.
That fits under D1's 10 GB per-database maximum but would consume almost all of the **5 GB included
account storage** (shared with other apps), before OpenSanctions. Remote sizes are not measured.
Options are in `deployment-handoff.md` §0.

## Known gaps

- No live-source or remote-D1 verification (see levels above). ACRA download host, poll status values,
  metadata endpoint; OpenSanctions metadata fields and context property names: unresolved
  (`source-contracts.md`).
- No remote import path implemented (deployment-handoff §3); no unattended refresh runtime.
- Similar-name tier misses typos in the first three letters of every token (candidate retrieval uses a
  3-letter prefix); no transliteration (Cyrillic/CJK ↔ Latin).
- Self-hosted Plex Mono is Latin-only; non-Latin names render in the system monospace fallback (checked
  in screenshots).
- Manual screen-reader testing (VoiceOver/NVDA): **pending**. The automated checks are structural
  (labels, roles, live region, focus order).
- Local `rows_written`/`rows_read` are Miniflare approximations; remote values may differ.
- `npm` could not install `vitest` here (npm resolver error), so tests use Node's built-in runner.
- The Stage 1 Python server remains in `server/` (retired; owner may delete).
