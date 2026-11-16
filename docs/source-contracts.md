# CheckLah — source contracts

What each live adapter relies on, where that knowledge came from, and what is still unverified.
Status words: **verified (packet)** = quoted or summarised in the owner's 16 Nov 2026 documentation
packet; **assumed (model)** = from general FtM/CSV knowledge, not in the packet; **unresolved** = must
be checked against a real upstream response before the connector is called verified.

No real upstream call was completed during Stage 2: `data.opensanctions.org`, `api-open.data.gov.sg`,
`data.gov.sg` and `www.opensanctions.org` were refused by the build container's egress policy. All
adapter tests use **synthetic contract fixtures** (`worker/test/fixtures/PROVENANCE.md`). There are
no captured schemas or metadata yet.

## ACRA: Entities Registered with ACRA

| Item | Value | Status |
|---|---|---|
| Dataset ID | `d_3f960c10fed6145404ca7b821f263b87` | verified (packet [4]) |
| Format / cadence | CSV, monthly updates; ~2.1M rows / 224.1 MB at fetch (Nov 2026), 2,133,906 records in the sample `total` | verified (packet [4]); sizes will change |
| Field IDs | `uen, issuance_agency_desc, uen_status_desc, entity_name, entity_type_desc, uen_issue_date, reg_street_name, reg_postal_code` (+ `_id` in datastore responses) | verified (packet [4], datastore sample) |
| CSV column order, quoting, BOM, line endings | adapter is order-independent, BOM-tolerant, RFC 4180 quoting via `csv-parse` | **unresolved** for the real file |
| Status vocabulary | "Registered/Deregistered-style" seen in one sample record. Adapter displays the supplied text and records a histogram (`status_values`) | **unresolved** (full set unknown) |
| `uen_issue_date` | YYYY-MM-DD in sample. Shown as **UEN issue date**, never as incorporation date. Partial or invalid values: partial kept partial; invalid omitted and counted | format verified for one record only |
| Postal code | text with leading zeroes preserved | verified (sample was textual) |
| Required columns | `uen`, `entity_name`. A missing required column fails the whole import (changed schema) | adapter decision |
| Missing name | row rejected (counted `missing_name`), never invented | adapter decision |
| Non-standard UEN text | kept as supplied if `[A-Z0-9]{5,15}`, counted `nonstandard_uen`; not findable by identifier mode | adapter decision |
| Duplicate UEN | later rows rejected and counted (`duplicates`) | adapter decision |
| Download API | `GET https://api-open.data.gov.sg/v1/public/api/datasets/{id}/initiate-download` then `.../poll-download` | verified (packet [5]) |
| Optional `columnNames` / `filters` | **omitted** for the full snapshot (GET-body examples are ambiguous) | adapter decision |
| Response envelope | `{code, data:{message}, errorMsg}` / `{code, data:{status, url}, errorMsg}` | shape verified as *illustrative* only (packet [5]: "text" placeholders) |
| Success test | **not** a status string. Success requires `data.url` on a verified host **and** a CSV that passes validation. A non-empty `errorMsg` is an error. `code` and `status` values are recorded, not interpreted | adapter decision |
| Poll budget | at most 20 polls and 6 minutes (both configurable); then "poll budget exhausted" | adapter decision |
| Download host (from `data.url`) | **unresolved.** `ACRA_VERIFIED_DOWNLOAD_HOSTS` is empty, so a real download **fails closed** until an operator verifies the host and passes `--trust-download-host <exact host>` | **unresolved** |
| URL expiry, content type, Content-Length, checksum | unknown. Adapter: rejects `text/html`/`application/json` bodies, checks Content-Length when sent, caps size at 1 GiB and time at 20 min. No published checksum, so the file SHA-256 is recorded for provenance | **unresolved** |
| Rate limit | official pages disagree (2 downloads/10 s vs 5 requests/min). Adapter spaces API requests ≥ 12 s (≤ 5/min), honours `Retry-After`, retries 429/5xx at most 3 times with backoff, never retries 401/403 | verified disagreement (packet [5]); stricter cap chosen |
| API key | not required for development; recommended by the provider for production. Not requested or created | packet [5] |
| Metadata/version endpoint | not verified. Daily "is there a new release?" check falls back to downloading and comparing file SHA-256 plus normalised content hash, which skips all D1 writes when unchanged | **unresolved** |
| Licence / attribution | Singapore Open Data Licence v1.0, attribution pattern "Contains information from {dataset} accessed on {date} from {source} which is made available under the terms of the Singapore Open Data Licence version 1.0 {link}". Licence excludes personal data and third-party rights; as-is, no accuracy guarantee; has liability/indemnity conditions | verified (packet [6]) |
| Not in this dataset | directors, officers, owners, former names, SSIC, financials, the other six ACRA datasets | verified (packet [4]) |

## OpenSanctions: default collection, Singapore-linked subset

| Item | Value | Status |
|---|---|---|
| Download URL | `https://data.opensanctions.org/datasets/latest/default/entities.ftm.json` | verified (packet [2]) |
| Format | NDJSON, one FtM entity per line, including relationship/sanction/document entities | verified (packet [2]) |
| Entity fields | `id, schema, caption, datasets, referents, first_seen, last_change, properties{...}`; properties are multi-valued **string arrays** | verified (packet [3]) |
| Root `first_seen` / `last_change` | processing metadata, shown as "(processing)", never as listing dates | verified (packet [3]) |
| Topics | `properties.topics`; `sanction` marks the sanctions topic. PEP (`role.pep`), crime, debarment etc. are kept distinct | verified (packet [2]) for `sanction`; other topic codes **assumed (model)** |
| Country-type properties used for selection | `country, nationality, citizenship, jurisdiction, mainCountry, birthCountry` (case-insensitive `sg`) | verified (packet [3]) as country-typed properties |
| Selection rule | entity's **own** property contains `sg`. No raw-text "Singapore" match. A Singapore sanctioning authority alone does not select. Field(s) that established the link are stored and shown | adapter decision (packet [3] asks for this) |
| Subject schemas | `Person` → person; `Company, Organization, LegalEntity, PublicBody` → companies tab | assumed (model) |
| Context schemas and reference properties | `Sanction.entity`; `Identification/Passport.holder`; `Family.person/relative`; `Associate.person/associate`; `Ownership.owner/asset`; `Directorship.director/organization`; `Membership.member/organization`; `Employment.employee/employer`; `UnknownLink.subject/object`; `Representation.agent/client`; `Occupancy.holder/post` | **assumed (model), unresolved.** A missing property degrades to "Not supplied"; it never crashes |
| Sanction fields shown | `authority, program, country, status, listingDate, startDate, endDate, reason, sourceUrl` | assumed (model). Listing date is taken from the Sanction entity when present |
| Identity document numbers | never stored (`passportNumber`, `idNumber`, `Passport.number` are dropped; only "supplied by source" is shown) | adapter decision |
| Related people outside scope | relationship kept, other person's name **not** shown; organisations/positions named | adapter decision |
| Unsupported schemas | counted per schema (`unsupported_schemas`), not imported (e.g. Vessel, Airplane, Position as a subject) | adapter decision |
| Malformed lines | counted. Import rejected if > 1 % of lines | adapter decision |
| Memory | three bounded streaming passes over the downloaded file (select → context → resolve referenced captions). Selected subject lines spill to a temp file. No global in-memory graph | adapter decision |
| Refresh | upstream republished ~every 6 h; adapter refuses to re-download within 6 h of the last attempt; app policy is daily | verified (packet [2]) |
| Metadata / checksum | `version`, `last_export` and resource SHA-1 exist per packet [2] "when that metadata contract is verified". Not used yet; a local manifest (`--manifest`) may carry `version`, `exported_at`, `sha1`/`sha256`, which are verified against the file | **unresolved** (field names, URL) |
| Deletions / merges | absent entity = removed (full snapshot replace); `referents` resolve old IDs | verified (packet [2]) |
| Licence | CC BY-NC 4.0. Personal/hobby use needs no permission; any for-profit use, including compliance screening, needs a licence. Free API keys are a separate grant | verified (packet [1]) |
| Attribution | credit OpenSanctions, link licence, state modifications (subset selected, reformatted, indexed), no endorsement | verified (packet [1]) |

### Scope statement shown to users

"Only entities whose own country, nationality, citizenship, jurisdiction, mainCountry or birthCountry
property is sg. This is CheckLah's selection, not an official OpenSanctions Singapore feed: it misses
overseas entities relevant to Singapore and indirect links." The `/countries/sg/` page on
OpenSanctions may cover a different set; no equivalence is claimed.

## Not connected

| Source | Reason |
|---|---|
| PhishTank, URLhaus | terms (access, licence, redistribution, retention, commercial) not read and recorded; no adapter |
| Singapore court/public records | no suitable source with reuse terms |
| Direct MAS lists | not in the verified packet; not configured. This build does not cover every MAS list or every sanction applicable in Singapore, and is not a legal compliance check |

## Live contract checks to run at the approved deployment step

1. ACRA: one real initiate → poll → download round trip. Record observed `code`/`status` values, the
   download host, URL lifetime, response headers, CSV header order, BOM, row count vs. the dataset page.
   Then add the exact host to `ACRA_VERIFIED_DOWNLOAD_HOSTS`.
2. ACRA: confirm whether a metadata/version endpoint exists, to avoid daily full downloads.
3. OpenSanctions: fetch the dataset metadata, confirm `version`/`last_export`/checksum field names, and
   compare the file SHA-1 with it.
4. OpenSanctions: confirm the context-schema property names on real lines (counts of `context_kept`,
   `unsupported_schemas`, `sg_link_fields`), and review a sample of selected records by hand.
5. Record all captured schemas/metadata in this file, replacing "unresolved".
