# CheckLah

**Check the source, lah.** A private, local research tool that searches public-source records by a
person's or company's name (or a Singapore UEN / URL / domain) and links back to the original source.

> **Names match. People may not.** CheckLah is a source browser. It is not identity verification,
> KYC/AML screening or a compliance decision engine. It never decides that a person is a criminal,
> a company is legitimate or a website is safe. Not legal advice.

Working name only: no domain or trademark clearance has been done.

## Use restriction

**Personal, non-commercial hobby use only** (owner-confirmed 16 Nov 2026). Do not use it for work,
an employer, clients or business/operational screening. OpenSanctions bulk data is CC BY-NC 4.0, and
OpenSanctions states that any use inside a for-profit business needs a data licence, including
internal compliance that produces no revenue. Password protection, no ads and a small audience do
not change that. If scope changes, pause that use until a licence or permission is settled.

## Status (Stage 1 of 3)

| | |
|---|---|
| UI + API on **fictional demo data** | Done. Permanent "FICTIONAL DEMO DATA" banner. |
| OpenSanctions / ACRA live adapters | **Not written.** Their official docs could not be reached from the build environment, and the brief requires reading the current schema first. Connectors are listed in the UI as "Not configured" with that reason. |
| PhishTank / URLhaus | Not connected until terms are read and recorded. |
| Singapore court/public records | Reserved category: "Not connected: suitable source and reuse terms required." |
| Deployment / sharing | **None.** Binds to `127.0.0.1`. Do not share until server-side access is configured and tested. |

See `docs/` for the overview, requirements, architecture (with benchmark), security/QA checklist and
the sources register.

## Run locally

Requires Python 3.11+ (with SQLite FTS5) and Node 18+.

```sh
make setup        # venv + pip deps, npm ci
make build        # frontend -> web/dist
make demo         # import the fictional demo sources into data/demo/
make serve        # http://127.0.0.1:8765
```

Without `make`:

```sh
python3 -m venv .venv && .venv/bin/pip install -r server/requirements.txt
(cd web && npm ci && npm run build)
cd server && ../.venv/bin/python -m checklah import all && ../.venv/bin/python -m checklah serve
```

Frontend development: run `make serve`, then `cd web && npm run dev` (Vite proxies `/api`).

### Optional local sign-in

```sh
cd server && ../.venv/bin/python -m checklah add-user alice   # password prompted, argon2id hash in data/users.json
CHECKLAH_AUTH=local ../.venv/bin/python -m checklah serve
```

The server refuses to bind a non-loopback address without `CHECKLAH_AUTH=local`. Local sign-in is a
safeguard for one machine, not a sharing plan; a shared deployment needs individual identities behind
an access service (Stage 3, owner decision).

### Settings (`CHECKLAH_*`)

| Variable | Default | |
|---|---|---|
| `MODE` | `demo` | `demo` loads only fictional sources, `live` only real ones. Never both. |
| `DATA_DIR` | `./data` | Snapshots live in `<DATA_DIR>/<mode>/<source>/` |
| `HOST` / `PORT` | `127.0.0.1` / `8765` | |
| `AUTH` | `off` | `local` = argon2id users file + server-side sessions |
| `COOKIE_SECURE` | auto | Secure unless loopback |
| `SESSION_IDLE_MINUTES` / `SESSION_MAX_HOURS` | 30 / 12 | |
| `LOGIN_PER_MINUTE` / `SEARCH_PER_MINUTE` | 5 / 30 | |

### Importer

```sh
python -m checklah import <source|all> [--file F] [--sha256 HEX] [--allow-shrink]
python -m checklah rollback <source>
python -m checklah status
python -m checklah bench --rows 1000000
```

Imports stream, validate, build a new SQLite snapshot and swap atomically. Failed, empty or
unexpectedly small imports never replace the working snapshot; the previous one is kept for rollback.

## Tests

```sh
make test   # 49 pytest: normalization, search, import/rollback, downloader, auth/CSRF/rate limits, privacy
make ui     # 72 browser checks: keyboard/focus, labels, XSS probe, states, demo/live, themes, sign-in
make shots  # screenshots at 320/390/768/1280 in both themes (server must be running)
```

## Design

FlightLah / HarbourLah family: exact Legacy (default) and Classic colour tokens, IBM Plex Mono
400/500/600/700 self-hosted under the SIL OFL (`web/public/fonts/OFL.txt`), 4px radii, fine rules.
Coral is used only for sanctions tags and errors; green is never an "all clear".

## Privacy

No analytics, query history, third-party AI, embeddings or enrichment. Searches are `POST` bodies,
never in URLs. Logs record only method, route template, status and time. API responses are
`no-store`; no service worker; `noindex`; strict CSP. User-entered URLs are never fetched.

## Attribution

Source attribution is shown in the footer and on the Sources view, separate from the credit line.
Demo data: fictional, part of this project. Planned live sources and their licences: `docs/sources.md`.

LUQ TECH.
