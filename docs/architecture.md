# CheckLah — architecture

> **Stage 2 (current):** the served app is a Cloudflare Worker + D1 (`worker/`). Sections below marked
> "Stage 1" describe the retired Python server kept in `server/` for reference and its tests. The
> Stage 2 design is in "Stage 2: Workers + D1" at the end of this file.

```
browser ──HTTPS/HTTP same origin──▶ FastAPI (127.0.0.1:8765)
  Vite+TS static bundle               ├── /api/*            JSON, no-store, auth + CSRF
  (no records, no SW)                 ├── static dist/      built frontend (no data)
                                      └── SearchService ──▶ data/<mode>/<source>/current → snapshot-*.sqlite (FTS5)
CLI importer (python -m checklah …) ──▶ stream → validate → build new snapshot → atomic swap
```

## Components

| Path | Role |
|---|---|
| `server/checklah/config.py` | Settings from environment (`CHECKLAH_*`). Refuses unsafe combinations. |
| `server/checklah/normalize.py` | Unicode normalization, UEN/URL/domain normalization, FTS query escaping, date precision. |
| `server/checklah/snapshot.py` | Snapshot schema, builder, validation, atomic swap, rollback, retention. |
| `server/checklah/download.py` | Allowlisted, size/time-limited downloader with per-hop redirect checks (not used by demo). |
| `server/checklah/connectors/` | `base.py` interface; `demo.py`; gated `opensanctions.py`, `acra.py`, `webfeeds.py`, `sg_public_records.py`. |
| `server/checklah/search.py` | Multi-source candidate retrieval and ranking. |
| `server/checklah/auth.py` | Optional local credentials, sessions, CSRF, rate limiting. |
| `server/checklah/app.py` | FastAPI app, security headers, quiet logging, static serving. |
| `server/checklah/cli.py` | `import`, `rollback`, `status`, `add-user`, `serve`, `bench`. |
| `web/` | Vite + TypeScript UI. DOM built with `textContent`; no `innerHTML` with data. |

## Modes

`CHECKLAH_MODE=demo` (default) loads **only** the demo connector; `live` loads **only** real
connectors. Data directories are separate (`data/demo/…`, `data/live/…`), so a demo row cannot be
returned by a live server or vice versa. The API reports the mode on every response and the UI shows
the permanent "FICTIONAL DEMO DATA" banner in demo mode.

## Snapshot format (one SQLite file per source per import)

- `meta(key, value)` — source id, schema version, upstream export time, upstream version/checksum,
  local import time, row count, rejected count.
- `entities` — `id` (namespaced, e.g. `demo:person:0001`), `kind` (person/company/website/record/
  other), `schema` (upstream schema name, e.g. FtM `Person`), `caption`, JSON columns for
  `names`, `countries`, `topics`, `datasets`, `identifiers`, `dates`, `links`, `properties`,
  `provenance`, and `raw` (the private original record, never sent to the browser as-is).
- `names(entity_rowid, name, norm, kind)` + index on `norm` for exact matches.
- `names_fts` — FTS5 (`unicode61 remove_diacritics 2`) over `norm` for token/prefix candidates.
- `identifiers(entity_rowid, type, norm)` + index for exact identifier lookups.
- `referents(old_id, entity_id)` — merged/replaced IDs resolve to the current entity.

`data/<mode>/<source>/current` is a one-line pointer file to the active snapshot, replaced with
`os.replace` (atomic on POSIX). The previous snapshot is retained (`keep=2`) for `rollback`.
Readers open snapshots read-only (`mode=ro` URI) and reopen when the pointer changes.

### Import validation (before swap)

1. Connector-declared format/schema check (e.g. header columns) — mismatch aborts.
2. Per-row required fields; malformed rows are counted and skipped; reject ratio > 1 % aborts.
3. Checksum/version check when the source supplies one.
4. Empty snapshot aborts. Row count below 50 % of the previous snapshot aborts unless `--allow-shrink`.
5. On any failure the temporary file is deleted and `current` is untouched; the failure is
   recorded in `data/<mode>/<source>/status.json` (last attempt + error) for the Sources panel.

## Search pipeline

1. Validate input (≤ 200 chars, control characters stripped, mode/filters from fixed enums).
2. Identifier mode: classify as UEN, URL or domain; exact lookup in `identifiers`. A domain query also
   returns URL-scoped listings on that host, labelled "URL on this host (listing covers that URL only)".
3. Name mode: normalized exact match on `names.norm`; then FTS5 `MATCH` on quoted tokens (last
   token as prefix). Tokens are reduced to `[\w]` before quoting, so FTS operators cannot be injected.
4. Filters (category, country, topic) applied in SQL; cap 200 candidates per source; merge; sort by
   internal tier then name; paginate (≤ 25).
5. Records are never merged across sources on name alone. Cross-source linking would require strong,
   type-compatible identifiers (not implemented: none exist yet between the planned sources).

**SQLite FTS is lexical candidate retrieval, not entity matching.** It handles case, diacritics
("José" = "Jose"), token order and prefixes. It does not handle transliteration (Cyrillic ↔ Latin,
Chinese ↔ pinyin), misspellings or phonetic similarity. That is a known limitation.

## Auth (optional, `CHECKLAH_AUTH=local`)

Users file (`data/users.json`) holds argon2id hashes created with `python -m checklah add-user`
(password read from the terminal, never an argument). Sessions are random 256-bit tokens stored
hashed in memory with idle + absolute expiry; cookie `HttpOnly; SameSite=Strict; Secure` (Secure can
be relaxed only for loopback HTTP). Every `POST` needs `X-CheckLah-CSRF` matching the session's token
(login uses a pre-session token) and a same-origin `Origin`/`Sec-Fetch-Site`. Rate limits: login
5/min/IP, search 30/min/session. With `CHECKLAH_AUTH=off` the server refuses to bind anything except
loopback. This is local protection only; a shared deployment needs individual identities behind an
access service (Stage 3).

## Benchmark (measured 16 Nov 2026, synthetic data)

`python -m checklah bench --rows N`: synthetic random-syllable names (60 % people, 40 % companies,
0–5 aliases, one topic, ~200-byte raw blob each). Build container: Intel Xeon @ 2.10 GHz, 4 vCPU,
15 GiB RAM, Python 3.13.18, SQLite 3.53.1, single-threaded importer.

| Entities | Import | Snapshot on disk | Peak RSS | Exact name p50/p95 | 3-letter prefix p50/p95 | Common token + 2 filters p50/p95 | Exact UEN p50/p95 |
|---|---|---|---|---|---|---|---|
| 100,000 | 10.3 s | 104 MB | 26 MB | 1.9 / 5.8 ms | 6.6 / 10.1 ms | 17.9 / 23.2 ms | 0.4 / 0.5 ms |
| 1,000,000 | 105.5 s | 1,029 MB | 26 MB | 4.6 / 26.2 ms | 23.1 / 27.3 ms | 35.3 / 51.1 ms | 0.4 / 0.5 ms |

Notes and limits:
- These are **synthetic** numbers. Real OpenSanctions/ACRA imports have not been measured (Stage 2
  gate). Real records are larger (more properties, longer raw JSON), so expect a bigger snapshot.
- Disk: the import needs room for the new snapshot **plus** the current and previous ones (keep=2),
  i.e. about 3× one snapshot during an import.
- Broad queries hit the 200-candidates-per-source cap; the UI says so and asks for a narrower search.
- No transliteration, phonetic or typo-tolerant matching. Next-step option if needed: an
  ICU/transliteration-normalised second name column, or a dedicated matcher; measure before choosing.

## Stage 2: Workers + D1

```
browser ─same origin─▶ Worker (worker/src/index.ts)            wrangler dev (local) / Workers (later)
                         ├─ /api/*  auth, CSRF, D1 limiter, no-store, quiet log
                         ├─ static: env.ASSETS (web/dist) + security headers (run_worker_first)
                         └─ D1 binding DB ── sources / generations / entities / names / names_fts /
                                              identifiers / referents ── app_meta (mode stamp)
                                              users / sessions / rate_limits  (never touched by imports)
Node CLI (worker/tools/cli.ts) ─getPlatformProxy()─▶ same local D1 state ◀─ streaming adapters
```

### Generations

All source rows carry `gen` (a global integer). `sources` holds `active_gen` and `previous_gen` per
source; `generations` holds state (`staging`, `active`, `previous`, `retired`, `failed`), the idempotent
`import_key` (source + upstream version + checksum), counts and a resume `cursor`.

1. **Lock** — `UPDATE sources SET lock_token=?, lock_expires=? WHERE id=? AND (lock_token IS NULL OR
   lock_expires < now)`; `changes = 1` means acquired.
2. **Begin** — reuse an incomplete staging generation with the same import key (resume), or skip with no
   data writes if the active generation already has that key (unchanged upstream).
3. **Chunks** — each chunk's inserts *and* the cursor update go in one `batch()` (one transaction), so a
   chunk is either fully in or not; a retry resumes after the last committed cursor.
4. **Validate** — counts in D1 equal counts streamed; non-empty; not < 50 % of the active generation
   (unless explicitly allowed); FTS row count equals name count.
5. **Activate** — one `batch()`: old previous → retired, active → previous, staging → active, pointers
   updated. Requests resolve `active_gen` once and use it for every query in that request.
6. **Cleanup** — retired/failed generations are deleted in bounded batches (FTS rows first), never the
   active or previous one, and only after a grace period so in-flight reads finish.
7. **Rollback** — one `batch()` swapping active and previous.

### Search on D1

- Identifier lookups use `identifiers(type, norm, gen)` equality.
- Exact names use `names(gen, norm)` equality.
- FTS5 table `names_fts(norm, g)` with `unicode61 remove_diacritics 2`; the generation is an indexed
  FTS column, so a query is `g : "g<N>" AND norm : "tok" AND norm : "pre"*` built only from
  word-character tokens and bound as one parameter.
- Country/topic filters are applied to the bounded candidate set via delimited columns
  (`,sg,`), avoiding a 2M-row country table.
- "Possible similar name": only when earlier tiers return few results; reranks at most 300 FTS
  candidates (3-letter prefix of each query token) with a bounded edit distance. Misses typos in the
  first three letters (documented false negative).

### Execution model for refresh

Local CLI streams downloads to disk (size/time capped), then parses with bounded memory and writes
chunks through the D1 binding. A Worker cron cannot be assumed to process a full OpenSanctions export
and a 2.13M-row CSV within documented limits, so unattended production refresh is a deployment decision
(see `deployment-handoff.md`). The Worker includes a disabled `scheduled()` handler that only performs
bounded maintenance (cleanup, check timestamps) when explicitly enabled.
