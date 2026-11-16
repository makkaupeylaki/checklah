# CheckLah

**Check the source, lah.** A private research tool that searches public-source records by a person's or
company's name (or a Singapore UEN / URL / domain) and links back to the original source.

> **Names match. People may not.** CheckLah is a source browser. It is not identity verification,
> KYC/AML screening or a compliance decision engine. It never decides that a person is a criminal,
> a company is legitimate or a website is safe. No match means only "No match in the selected sources
> and scope". Not legal advice.

Working name only: no domain or trademark clearance has been done.

## Use restriction

**Personal, non-commercial hobby use only** (owner-confirmed 16 Nov 2026). Do not use it for work, an
employer, clients or business/operational screening. OpenSanctions data is CC BY-NC 4.0: any use inside a
for-profit business, including compliance screening that earns no revenue, needs a data licence.
Password protection, no ads and a small audience do not change that.

## Status — Stage 2 (Workers + D1, Singapore-first), local only

| | |
|---|---|
| App runtime | Cloudflare Worker + D1, run **locally** with `wrangler dev`. Not deployed. |
| Demo | Fictional data, permanent "FICTIONAL DEMO DATA" banner, separate demo database |
| ACRA (Entities Registered with ACRA) | Adapter written, **fixture-tested only**. Real download not yet run; download host unverified, so it fails closed |
| OpenSanctions (Singapore-linked subset) | Adapter written, **fixture-tested only**. Real export not yet run |
| PhishTank / URLhaus / public records / direct MAS | Not connected |
| Daily refresh | Policy implemented; **disabled** (no cron trigger, `REFRESH_ENABLED=false`) |

Details: `docs/stage2-status.md` (what is verified, at which level), `docs/source-contracts.md`,
`docs/deployment-handoff.md` (nothing in it has been run).

## Run locally

Needs Node ≥ 22.18. No Cloudflare account or credentials are used.

```sh
make setup   # npm ci in worker/ and web/ (pinned lockfiles)
make demo    # create the local demo D1 database (.wrangler-state/demo) and import fictional data
make serve   # build the UI and serve http://127.0.0.1:8787 via wrangler dev (loopback only)
```

Live mode with local source files (never fetched automatically):

```sh
cd worker
node tools/cli.ts init --env live
node tools/cli.ts import acra --env live --file /path/to/acra.csv [--manifest m.json]
node tools/cli.ts import opensanctions --env live --file /path/to/entities.ftm.json [--manifest m.json]
cd .. && make serve-live   # http://127.0.0.1:8788
```

`--download` exists for both adapters, but it has not been run against the real sources. ACRA downloads
refuse to proceed until the real download host is verified (`--trust-download-host <exact host>`).

### CLI (`worker/tools/cli.ts`, local D1 only)

| Command | |
|---|---|
| `init --env demo\|live` | apply migrations, stamp the database with its mode |
| `import demo\|acra\|opensanctions` | stream → validate → chunked, resumable write → atomic activation |
| `rollback <source>` | swap active and previous generation |
| `cleanup` | bounded deletion of retired generations, expired sessions, old limiter rows |
| `status` | source states as the UI shows them |
| `add-user <name>` / `revoke-user <name>` | scrypt hash in D1; password from TTY, stdin or `CHECKLAH_PASSWORD_FILE` |

### Optional local sign-in

```sh
cd worker && node tools/cli.ts add-user alice --env demo
npx wrangler dev --env demo --var AUTH:local --var ALLOW_LOOPBACK_NO_AUTH:false --persist-to ../.wrangler-state/demo
```

Any non-loopback request is refused (503) unless `AUTH=local`.

## Tests

```sh
make test         # 83 Node tests on local D1 (workerd): normalisation, D1 spike, search, lifecycle faults,
                  # ACRA + OpenSanctions adapters, API/security, cross-instance sessions
make ui           # 92 browser checks against real wrangler dev runtimes (demo, live empty, live fixtures, auth)
make legacy-test  # 49 Stage 1 Python tests (retired reference server)
make bench        # local synthetic benchmark at ACRA scale (about 2 h)
```

## Design

FlightLah / HarbourLah family: exact Legacy (default) and Classic colour tokens, IBM Plex Mono
400/500/600/700 self-hosted under the SIL OFL (`web/public/fonts/OFL.txt`), 4 px radii, fine rules.
Coral marks sanctions tags and errors only; green is never an "all clear".

## Privacy

No analytics, query history, third-party AI, embeddings or enrichment. Searches and record lookups are
`POST` bodies, never in URLs. Logs record method, route template, status and time only. API responses are
`no-store`; no service worker; `noindex`; strict CSP. User-entered URLs, listed websites and `sourceUrl`
values are never fetched.

## Attribution

Shown in the footer and on the Sources view, separate from the credit line. ACRA: Singapore Open Data
Licence v1.0. OpenSanctions: CC BY-NC 4.0, modified (Singapore-linked subset, reformatted, indexed),
not endorsed. Demo data is fictional.

LUQ TECH.
