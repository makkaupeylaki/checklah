# CheckLah — sources register

Not legal advice. Each connector's enablement decision is recorded here before it is turned on.
"Date checked" means the official page was actually read on that date; "not read" means the page
could not be reached and nothing below is from it.

## Build-environment note (16 Nov 2026)

The build container's network policy refused `www.opensanctions.org`, `data.gov.sg`,
`api-production.data.gov.sg` and `guide.data.gov.sg` (DNS/egress rejected). The brief requires the
**current** docs and schemas before coding live adapters, so the live parsers were **not written**.
Only the connector interface, importer pipeline and gated stubs exist. Nothing below claims a live
source works.

---

## demo — CheckLah fictional demo data

| Field | Value |
|---|---|
| URL | none (generated locally: `server/checklah/connectors/demo_data.py`) |
| Scope | Fictional people, companies and website listings with `demo:` IDs |
| Licence | Part of this project |
| Attribution | "Fictional demo data. Not a real source." |
| Access | Local file |
| Decision | **Enabled in demo mode only.** Never loaded in live mode. |

## opensanctions — OpenSanctions default collection (bulk)

| Field | Value |
|---|---|
| Official docs | https://www.opensanctions.org/docs/bulk/ · https://www.opensanctions.org/docs/bulk/updates/ |
| Download (per brief) | https://data.opensanctions.org/datasets/latest/default/entities.ftm.json |
| Scope | Sanctions, PEPs and other watchlist entities across supported schemas. Not every person/company. |
| Licence | CC BY-NC 4.0 — https://creativecommons.org/licenses/by-nc/4.0/ ; commercial use / exemption: https://www.opensanctions.org/docs/commercial/exemption/ |
| Use restriction | Personal hobby use only (owner confirmed 16 Nov 2026). Any for-profit business use, incl. internal compliance, needs a licence. |
| Attribution (planned) | "Contains data from OpenSanctions (opensanctions.org), licensed CC BY-NC 4.0. Locally indexed and reformatted by CheckLah; not endorsed by OpenSanctions." Preserve upstream dataset/source attribution per record. |
| Access mechanism (planned) | Bulk file only; no website scraping; no paid hosted API. Daily refresh proposed; never refetch the full export more often than every 6 h. |
| Date checked | **Not read** (blocked from build environment) |
| Decision | **Disabled.** Gate: read current bulk + FtM docs, then implement mapping preserving schema, properties, topics, datasets, IDs, referents. |

## acra — Entities Registered with ACRA (data.gov.sg)

| Field | Value |
|---|---|
| Dataset | `d_3f960c10fed6145404ca7b821f263b87` — https://data.gov.sg/datasets/d_3f960c10fed6145404ca7b821f263b87/view |
| Scope (planned) | Entity name, UEN, registry status, entity type and supported registration fields. **No** directors, beneficial ownership, financial health or website ownership. |
| Licence | Singapore Open Data Licence — https://data.gov.sg/open-data-licence . Excludes personal data and third-party rights; not blanket permission for personal-data use. |
| Attribution (planned) | Source/date/link pattern of the licence, e.g. "Contains information from Entities Registered with ACRA accessed on <date> from data.gov.sg, made available under the Singapore Open Data Licence." (exact wording to be confirmed from the licence page) |
| Access mechanism (planned) | Official bulk CSV download; monthly; no per-search upstream queries; respect rate limits. |
| Date checked | **Not read** (blocked) |
| Decision | **Disabled.** Gate: read current schema + download API docs. Status shown as "Registered" (registry status), never "Legit". |

## phishtank / urlhaus — website listings (candidates)

| Field | Value |
|---|---|
| Scope | Listed URLs/hosts with listing scope, status and dates |
| Licence / terms | **Not yet read.** Access, licence, redistribution, retention and commercial terms must be recorded first; neither is assumed unrestricted or account-free. |
| Access | None. No live browsing or fetching of user-entered URLs, ever. |
| Decision | **Not connected.** Display wording when connected: "Listed by [source]" with scope/status/date, never "Scam". |

## sg-public-records — Singapore court / public records (reserved)

| Field | Value |
|---|---|
| Scope | Reserved category only |
| Decision | **Not connected: suitable source and reuse terms required.** No scraping/republishing of judgments, personal records or government pages. No scam-number lists, no crowdsourcing. OpenSanctions may carry some public watchlists; that is not court/public-record coverage. |
