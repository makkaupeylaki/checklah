"""Text and identifier normalization.

Original Unicode text is always preserved for display; these functions only build search keys.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from urllib.parse import urlsplit

MAX_QUERY_LEN = 200
MAX_TOKENS = 8

_CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f​-‏ -‮⁠-⁤﻿]")
_NON_WORD = re.compile(r"[^\w]+", re.UNICODE)


def clean_input(text: str) -> str:
    """Strip control/invisible characters and collapse whitespace. Keeps the user's characters."""
    text = _CONTROL.sub(" ", text)
    return " ".join(text.split())


def fold(text: str) -> str:
    """Search key: NFKC, casefold, remove diacritics, punctuation -> space, collapse whitespace.

    "José  O'Neil-Tan" -> "jose o neil tan". Non-Latin scripts are kept (casefolded), not
    transliterated.
    """
    text = unicodedata.normalize("NFKC", text).casefold()
    decomposed = unicodedata.normalize("NFKD", text)
    stripped = "".join(c for c in decomposed if not unicodedata.combining(c))
    # Letters that do not decompose but are commonly written without the mark.
    stripped = stripped.translate(_EXTRA_FOLD)
    stripped = unicodedata.normalize("NFC", stripped)
    stripped = _NON_WORD.sub(" ", stripped).replace("_", " ")
    return " ".join(stripped.split())


_EXTRA_FOLD = str.maketrans({"ø": "o", "đ": "d", "ł": "l", "ı": "i", "ß": "ss", "æ": "ae", "œ": "oe", "þ": "th"})


def tokens(text: str) -> list[str]:
    return fold(text).split()[:MAX_TOKENS]


def fts_query(text: str) -> str | None:
    """Build a safe FTS5 MATCH expression: every token quoted; the last one as a prefix.

    Tokens contain only word characters after fold(), so quotes and FTS operators (NEAR, OR, *, -,
    :, parentheses) from user input can never reach the query syntax.
    """
    toks = [t for t in tokens(text) if t]
    if not toks:
        return None
    parts = [f'"{t}"' for t in toks[:-1]]
    last = toks[-1]
    parts.append(f'"{last}"*' if len(last) >= 2 else f'"{last}"')
    return " ".join(parts)


# ------------------------------------------------------------------ identifiers

# Singapore UEN formats (ACRA): 8 digits + check letter (businesses), 9 digits + check letter
# (local companies), and T/S/R + 2-digit year + 2-letter entity type + 4 digits + check letter.
_UEN_RE = re.compile(r"^(?:\d{8}[A-Z]|\d{9}[A-Z]|[TSR]\d{2}[A-Z]{2}\d{4}[A-Z])$")


def normalize_uen(text: str) -> str | None:
    v = re.sub(r"[\s\-]", "", text).upper()
    return v if _UEN_RE.match(v) else None


_HOST_RE = re.compile(r"^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$")


def normalize_host(host: str) -> str | None:
    host = host.strip().rstrip(".").lower()
    try:
        host = host.encode("idna").decode("ascii")
    except UnicodeError:
        return None
    return host if _HOST_RE.match(host) else None


def normalize_url(text: str) -> str | None:
    """Canonical form for exact URL matching. Never fetched.

    Lowercases scheme and host, drops default ports, userinfo and fragment; keeps path and query
    exactly (paths are case-sensitive on most servers).
    """
    text = text.strip()
    if "://" not in text:
        return None
    try:
        parts = urlsplit(text)
    except ValueError:
        return None
    scheme = parts.scheme.lower()
    if scheme not in ("http", "https"):
        return None
    host = normalize_host(parts.hostname or "")
    if not host:
        return None
    try:
        port = parts.port
    except ValueError:
        return None
    netloc = host if port in (None, 80 if scheme == "http" else 443) else f"{host}:{port}"
    path = parts.path or "/"
    query = f"?{parts.query}" if parts.query else ""
    return f"{scheme}://{netloc}{path}{query}"


@dataclass(frozen=True)
class Identifier:
    type: str  # "uen" | "url" | "domain"
    value: str  # normalized


def classify_identifier(text: str) -> Identifier | None:
    text = clean_input(text)
    if not text:
        return None
    uen = normalize_uen(text)
    if uen:
        return Identifier("uen", uen)
    url = normalize_url(text)
    if url:
        return Identifier("url", url)
    if " " not in text and "/" not in text:
        host = normalize_host(text)
        if host:
            return Identifier("domain", host)
    return None


def url_host(url: str) -> str | None:
    try:
        return urlsplit(url).hostname
    except ValueError:
        return None


# ------------------------------------------------------------------ dates

_DATE_RE = re.compile(r"^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$")


def date_precision(value: str) -> str | None:
    """'year' | 'month' | 'day' for ISO-8601 prefixes; None if not a recognised date."""
    m = _DATE_RE.match(value.strip())
    if not m:
        return None
    if m.group(3):
        return "day"
    if m.group(2):
        return "month"
    return "year"


# ------------------------------------------------------------------ links

SAFE_LINK_SCHEMES = ("https", "http")


def safe_link(url: str) -> str | None:
    """Return the URL if it is an absolute http(s) link to a real host, else None."""
    if not isinstance(url, str) or len(url) > 2048:
        return None
    url = url.strip()
    if _CONTROL.search(url):
        return None
    try:
        parts = urlsplit(url)
    except ValueError:
        return None
    if parts.scheme.lower() not in SAFE_LINK_SCHEMES or not parts.hostname:
        return None
    if not normalize_host(parts.hostname):
        return None
    return url


def defang(url: str) -> str:
    """Display form of a listed (possibly dangerous) URL: not clickable, not auto-linkable."""
    return url.replace("http://", "hxxp://").replace("https://", "hxxps://").replace(".", "[.]")
