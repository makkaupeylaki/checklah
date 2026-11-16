# CheckLah — overview

> "Check the source, lah." Working name only: no domain or trademark clearance has been done.
> Alternatives considered: TraceLah, WhoLah, KenalLah. CheckLah is preferred because it covers
> people, companies and websites without implying guilt.

## What it is

A **private, local research tool** for a small invited group. You type a person's or company's name
(or, in identifier mode, a Singapore UEN or a URL/domain) and CheckLah shows records from the
**public sources it has connected**, each with links back to the original source.

It is a **source browser**. It is *not* identity verification, KYC, AML screening or a compliance
decision engine. It never decides that a person is a criminal, a company is legitimate or a website
is safe. Hero copy: **"Names match. People may not."**

## Use restriction (owner-confirmed)

The owner confirmed on 16 Nov 2026: *"Okay personal hobby tool"*, after being told this must not be
used for work by him or the invited few. CheckLah therefore runs on a **personal, non-commercial,
hobby-only** basis:

- OpenSanctions bulk data is CC BY-NC 4.0. OpenSanctions states that any use inside a for-profit
  business needs a data licence, including internal compliance that produces no revenue. Password
  protection, no ads and a small audience do not change that.
- If the scope ever changes to employer, business, client or operational screening, **pause that use**
  until the appropriate licence or permission is settled.

The restriction is shown in the UI footer, on the Sources view and in the README.

## Delivery stages

| Stage | Content | Status |
|---|---|---|
| 1 | Docs + working local UI on **fictional demo data**, FlightLah/HarbourLah family themes | Done (commit fd6e8b9) |
| 2 | Cloudflare Workers + D1 port; real ACRA and OpenSanctions bulk adapters, Singapore-first | **This build**: code + local tests. Live-source and remote-D1 checks pending (see `stage2-status.md`) |
| 3 | Private hosting: deploy, first real import, smoke test | Not started; needs the owner's explicit "Push" (see `deployment-handoff.md`) |

Nothing is deployed, registered, purchased or exposed. Stage 2 replaces the Python web server with a
TypeScript Worker on D1, run locally with `wrangler dev` (no Cloudflare credentials needed). The Stage 1
Python server stays in `server/` as a retired reference with its tests; it is not the primary app.

## Source categories

| Category | Intended source | This build |
|---|---|---|
| People / Companies (watchlists, sanctions, PEPs) | OpenSanctions default bulk collection, **Singapore-linked subset only** (explicit `sg` country-type properties) | Stage 2: adapter written, fixture-tested; live download pending |
| Companies (Singapore registry) | ACRA "Entities Registered with ACRA" (`d_3f960c10fed6145404ca7b821f263b87`) | Stage 2: adapter written, fixture-tested; live initiate/poll/download pending |
| Websites (phishing/malware listings) | Candidates: PhishTank, URLhaus | Interface + demo; production feeds disconnected until terms are recorded |
| Public records (Singapore) | None chosen | Reserved category: "Not connected: suitable source and reuse terms required" |

## Assumptions

1. "Build locally" means a single machine, single process, a few concurrent users at most.
2. Demo mode and live mode are separate server configurations; one process never serves both.
3. The owner will supply any secrets (session secret, user password hashes) out of band.
4. Search across ~millions of names with SQLite FTS5 is acceptable for a hobby tool; measured numbers
   are in `architecture.md`.
5. No phone numbers, no NRIC/passport collection, no crowdsourced reports in this version.

## Stage 2 scope decisions

- **Singapore first.** OpenSanctions is streamed in full but only entities whose own `country`,
  `nationality`, `citizenship`, `jurisdiction`, `mainCountry` or `birthCountry` property contains `sg`
  are searchable. This is CheckLah's scope choice, not an official OpenSanctions Singapore feed, and it
  misses overseas entities relevant to Singapore and indirect links. A Singapore sanctioning authority
  alone does not make a subject Singapore-linked.
- **ACRA is a registry**, not an adverse source: Registered and Deregistered entities are shown with the
  supplied status and never tagged sanctioned/PEP/suspicious.
- **No match** means "No match in the selected sources and scope", never clear or safe.
- No direct MAS adapter (not verified); PhishTank/URLhaus stay disconnected; public records stay disabled.

## Open questions (owner)

1. (Stage 1 question, still open: Stage 2 proceeded offline with the documentation packet.) Allow the build environment to reach `www.opensanctions.org`, `data.opensanctions.org`,
   `data.gov.sg`, `api-production.data.gov.sg`, `api-open.data.gov.sg` and `guide.data.gov.sg` so the
   current docs and schemas can be read before writing the live adapters? (Stage 2 gate.)
2. Daily OpenSanctions refresh (proposed) or every six hours?
3. Which always-on machine, if any, should eventually host it (Stage 3)? No new bill without approval.
4. Which access service for individual allowlisted identities in a future deployment?
5. Final name.
