"""Live connectors. All are gated in this build; see docs/sources.md for the decision record.

The OpenSanctions and ACRA mappings are deliberately NOT written yet: the brief requires reading
the current official documentation and schema first, and those pages were unreachable from the
build environment on 16 Nov 2026. Writing field mappings from memory would be guessing.
"""

from __future__ import annotations

from .base import Connector, register

DOCS_BLOCKED = (
    "Not configured: current official docs/schema not yet verified (unreachable from the build "
    "environment on 16 Nov 2026). Adapter will be written after they are read."
)

register(Connector(
    id="opensanctions",
    title="OpenSanctions — default collection",
    mode="live",
    kinds=("person", "company", "other"),
    scope="Sanctions, politically exposed persons and other watchlist records across supported entity "
          "types. Not every person or company in the world.",
    licence_name="CC BY-NC 4.0 (non-commercial; business use needs a data licence)",
    licence_url="https://www.opensanctions.org/docs/commercial/exemption/",
    attribution="Contains data from OpenSanctions (opensanctions.org), CC BY-NC 4.0. Locally indexed and "
                "reformatted by CheckLah; not endorsed by OpenSanctions.",
    homepage="https://www.opensanctions.org/docs/bulk/",
    refresh="Daily local refresh proposed (6-hour option). Never refetch the full export more often than every 6 hours.",
    max_age_hours=36,
    allowed_hosts=("data.opensanctions.org",),
    blocked_reason=DOCS_BLOCKED,
))

register(Connector(
    id="acra",
    title="Entities Registered with ACRA (data.gov.sg)",
    mode="live",
    kinds=("company",),
    scope="Singapore entity name, UEN, registry status, entity type and supported registration fields. "
          "No directors, beneficial ownership, financial health or website ownership.",
    licence_name="Singapore Open Data Licence (excludes personal data and third-party rights)",
    licence_url="https://data.gov.sg/open-data-licence",
    attribution="Contains information from Entities Registered with ACRA, accessed from data.gov.sg under the "
                "Singapore Open Data Licence.",
    homepage="https://data.gov.sg/datasets/d_3f960c10fed6145404ca7b821f263b87/view",
    refresh="Monthly upstream updates; monthly local import from the official bulk download.",
    max_age_hours=24 * 45,
    blocked_reason=DOCS_BLOCKED,
))

TERMS_BLOCKED = ("Not connected: access, licence, redistribution, retention and commercial terms not yet "
                 "read and recorded.")

register(Connector(
    id="phishtank",
    title="PhishTank (candidate)",
    mode="live",
    kinds=("website",),
    scope="Listed phishing URLs, as the source scopes them.",
    licence_name="Terms not yet reviewed",
    licence_url=None,
    attribution="",
    blocked_reason=TERMS_BLOCKED,
))

register(Connector(
    id="urlhaus",
    title="URLhaus (candidate)",
    mode="live",
    kinds=("website",),
    scope="Listed malware distribution URLs, as the source scopes them.",
    licence_name="Terms not yet reviewed",
    licence_url=None,
    attribution="",
    blocked_reason=TERMS_BLOCKED,
))

register(Connector(
    id="sg-public-records",
    title="Singapore court and public records",
    mode="live",
    kinds=("record",),
    scope="Reserved category. No scraping or republishing of judgments, personal records or government pages.",
    licence_name="No source chosen",
    licence_url=None,
    attribution="",
    blocked_reason="Not connected: suitable source and reuse terms required.",
))
