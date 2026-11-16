# CheckLah — requirements

Status key: **[S1]** done in Stage 1 (demo), **[S2]** needs live sources, **[S3]** needs hosting decision.

## Functional

### Search
- F1 [S1] Name mode: one input labelled "Name or company"; search runs on explicit submit only.
- F2 [S1] Identifier mode: Singapore UEN (exact), URL / domain (exact, as the source supports).
- F3 [S1] Optional country filter (only countries present in connected data) and topic filter
  (Any / Sanctions / PEP). Sanctions and PEP are separate topics; PEP status is not wrongdoing.
- F4 [S1] Category filter: All / People / Companies / Websites / Public records. Categories with no
  connected source are disabled with an explicit reason and a Sources link, not fake zero results.
- F5 [S1] Names and identifiers never appear in URLs: search is a `POST` with a JSON body; the
  detail route uses opaque record IDs.
- F6 [S1] Ranking: exact supported identifier → exact normalized name/alias → indexed token/prefix
  candidates. Ranking values stay internal. No confidence percentages.
- F7 [S1] Each result states why it appears: "Exact UEN", "Exact URL", "Name/alias exact match",
  "Name/alias text match", "Name/alias prefix match", "URL on this host (listing covers that URL only)".
- F8 [S1] Server-side pagination and caps (page size ≤ 25, at most 200 candidates per source).

### Results and detail
- F9 [S1] Desktop: compact list (name, type/country, source/topic labels, "Review record").
  Phones: stacked cards from the same data.
- F10 [S1] Detail: right-hand panel on desktop, full-screen on phones. Entity type, aliases,
  countries, dates (partial dates labelled), identifier types (sensitive values masked), source
  datasets, original source links, source status, upstream published/updated dates if supplied,
  local retrieval (import) time. Banner: "This record may refer to a different person. Compare
  identifiers and the original source."
- F11 [S1] Missing values render as "Not supplied". Nationality/DOB are never inferred.
- F12 [S1] Listed URLs are shown defanged and never as clickable navigation. Only http(s) source
  links are clickable, with `rel="noopener noreferrer"` and `referrerpolicy="no-referrer"`.
- F13 [S1] Empty state: "No matches in the connected sources. This is not proof of a clean record or
  a safe transaction." Distinct from source error and not-connected states.
- F14 [S1] Correction guidance: contact the original publisher; no public allegation system.

### Sources
- F15 [S1] Coverage panel per connector: status, licence link, scope, last upstream export, last
  successful local import, last attempt/error, stale state. Unavailable and not-configured
  connectors are listed separately from connected ones.
- F16 [S1] Source-specific stale banners when a connected snapshot exceeds its max age.

### Demo
- F17 [S1] Permanent "FICTIONAL DEMO DATA" banner. Fictional records with conspicuous demo IDs
  (`demo:` namespace, `T99DM…` UENs in an impossible year, `.example`/`.test` domains). No invented
  allegations against real people or businesses. Demo and live never mix (server-level mode).

### Import
- F18 [S1] CLI importer, never browser-side. Stream input, validate counts/required fields, build a
  new indexed snapshot, swap atomically, keep the previous good snapshot for rollback.
- F19 [S1] Failed, empty or unexpectedly small imports never replace working data.
- F20 [S1] Full replacement removes records absent from the newest source; referents resolve old
  IDs to current ones; removed IDs report "no longer in the current snapshot".
- F21 [S1] Download helper: allowlisted hosts, redirects validated per hop, time and size limits.
- F22 [S2] OpenSanctions default bulk adapter (daily refresh proposed; never more often than 6 h).
- F23 [S2] ACRA entities adapter from official bulk download; monthly cadence.
- F24 [S2] Web feed adapters only after terms are recorded.

## Non-functional

- N1 [S1] Same-origin FastAPI backend, Vite + TypeScript frontend, SQLite FTS5.
- N2 [S1] Binds to 127.0.0.1 by default. Refuses non-loopback binds unless auth is enabled.
- N3 [S1] Exact FlightLah/HarbourLah family tokens; Legacy default, Classic toggle persisted per
  device without a flash; IBM Plex Mono 400/500/600/700 self-hosted with OFL; 4 px radii; no
  gradients/glass/glow; reduced motion respected; green never used as "all clear"; coral only for
  source tags or errors.
- N4 [S1] Layout works at 320, 390, 768, 1280 px; filters wrap on phones.
- N5 [S1] Keyboard operable; visible focus; labelled controls; live region for result counts.
- N6 [S1] Privacy: no analytics, no query history, no third-party AI/embeddings/enrichment; no
  search strings, DOBs or identifiers in logs; `Cache-Control: no-store` on API; no service worker;
  `noindex`; no sitemap; no share URLs.
- N7 [S1] Security: parameterized SQL; input length limits; escaped FTS syntax; DOM built with
  `textContent`; safe URL protocols; strict CSP and headers; no outbound fetch of user input.
- N8 [S1] Optional local credentials: argon2id hashes, random session tokens, HttpOnly + SameSite
  cookies, expiry, logout, CSRF header for mutations, rate limits. [S3] Individual allowlisted
  identities behind an access service for any shared deployment.
- N9 [S1] Export and mass-download endpoints do not exist in this version.

## Out of scope (this version)

Phone numbers / scam-number lists, crowdsourced accusations, court judgments or scraped government
pages, transliteration/fuzzy identity matching, directors/beneficial ownership, website safety
verdicts, live URL fetching, analytics, deployment.
