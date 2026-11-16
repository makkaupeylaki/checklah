"""Candidate retrieval across connected snapshots. Lexical only: not identity matching."""

from __future__ import annotations

import datetime as dt
import json
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import normalize as nz
from .connectors.base import Connector, registry
from .snapshot import SnapshotStore, open_readonly

PER_SOURCE_CAP = 200
PAGE_SIZE = 20

CATEGORIES = {
    "person": "People",
    "company": "Companies",
    "website": "Websites",
    "record": "Public records",
}

TOPIC_LABELS = {
    "sanction": "Sanctions",
    "role.pep": "PEP",
    "role.rca": "PEP associate",
    "debarment": "Debarment",
    "export.control": "Export control",
    "crime": "Crime",
    "wanted": "Wanted",
    "poi": "Person of interest",
    "reg.warn": "Regulatory warning",
}

DATE_LABELS = {
    "birth": "Date of birth",
    "listed": "Listed",
    "registered": "Registered",
    "status_changed": "Status changed",
    "last_checked": "Last checked by source",
}

PROPERTY_LABELS = {
    "programme": "Programme",
    "position": "Position",
    "notes": "Source notes",
    "registry_status": "Registry status",
    "entity_type": "Entity type",
    "listing_scope": "Listing scope",
    "listing_status": "Listing status",
    "threat_label": "Source label",
}

TIER_REASON = {
    "uen": "Exact UEN",
    "url": "Exact URL listing",
    "host": "Host listed by source",
    "url_host": "URL on this host (listing covers that URL only)",
    "exact": "Name/alias exact match",
    "text": "Name/alias text match",
    "prefix": "Name/alias prefix match",
}
TIER_ORDER = {"uen": 0, "url": 0, "host": 0, "url_host": 1, "exact": 1, "text": 2, "prefix": 3}


def topic_label(t: str) -> str:
    return TOPIC_LABELS.get(t, t.replace(".", " ").replace("_", " ").capitalize())


def topic_class(t: str) -> str:
    if t == "sanction" or t.startswith("sanction"):
        return "sanction"
    if t.startswith("role.pep") or t == "role.rca":
        return "pep"
    return "other"


def _parse_ts(s: str | None) -> dt.datetime | None:
    if not s:
        return None
    try:
        v = dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None
    return v if v.tzinfo else v.replace(tzinfo=dt.timezone.utc)


@dataclass
class Query:
    text: str
    mode: str = "name"  # name | identifier
    category: str = "all"
    country: str = ""
    topic: str = "any"  # any | sanction | pep
    page: int = 1


class SearchService:
    def __init__(self, data_mode_dir: Path, mode: str):
        self.mode = mode
        self.base = data_mode_dir
        self.connectors: dict[str, Connector] = {c.id: c for c in registry().values()}
        self.stores = {cid: SnapshotStore(self.base, cid) for cid, c in self.connectors.items() if c.mode == mode}

    # ------------------------------------------------------------ source status
    def source_status(self, cid: str) -> dict[str, Any]:
        c = self.connectors[cid]
        info: dict[str, Any] = {
            "id": c.id, "title": c.title, "kinds": list(c.kinds), "scope": c.scope,
            "licence": {"name": c.licence_name, "url": nz.safe_link(c.licence_url or "")},
            "attribution": c.attribution, "homepage": nz.safe_link(c.homepage or ""),
            "refresh": c.refresh, "demo": c.mode == "demo", "notes": list(c.notes),
        }
        if c.mode != self.mode:
            info.update(state="not_loaded", reason=c.blocked_reason or f"Not loaded in {self.mode} mode.")
            return info
        if not c.available:
            info.update(state="not_connected", reason=c.blocked_reason)
            return info
        store = self.stores[cid]
        st = store.read_status()
        meta = store.current_meta() if store.current_file() else {}
        info.update(
            last_attempt=st.get("last_attempt"), last_success=st.get("last_success"),
            last_error=st.get("last_error"), last_error_at=st.get("last_error_at"),
            imported_at=meta.get("imported_at"), upstream_exported_at=meta.get("upstream_exported_at"),
            upstream_version=meta.get("upstream_version"), rows=int(meta["rows"]) if meta.get("rows") else None,
        )
        if not meta:
            info.update(state="not_imported", reason="Connector available but no snapshot has been imported yet.")
            return info
        now = dt.datetime.now(dt.timezone.utc)
        stale_reasons = []
        imp = _parse_ts(meta.get("imported_at"))
        if c.max_age_hours and imp and (now - imp).total_seconds() > c.max_age_hours * 3600:
            stale_reasons.append(f"local import is older than {c.max_age_hours:g} hours")
        up = _parse_ts(meta.get("upstream_exported_at"))
        if c.upstream_max_age_hours and up and (now - up).total_seconds() > c.upstream_max_age_hours * 3600:
            stale_reasons.append(f"upstream export is older than {c.upstream_max_age_hours / 24:g} days")
        info.update(state="stale" if stale_reasons else "connected", stale_reasons=stale_reasons)
        if st.get("last_error"):
            info["state_note"] = "Last import attempt failed; the previous good snapshot is still in use."
        return info

    def sources(self) -> dict[str, Any]:
        items = [self.source_status(cid) for cid, c in self.connectors.items()
                 if c.mode == self.mode or (self.mode == "demo" and c.mode == "live")]
        connected = [s for s in items if s["state"] in ("connected", "stale")]
        categories = []
        for kind, label in CATEGORIES.items():
            srcs = [s["id"] for s in connected if kind in s["kinds"]]
            if srcs:
                categories.append({"id": kind, "label": label, "enabled": True, "sources": srcs})
            else:
                pending = [s for s in items if kind in s["kinds"]]
                reason = next((s["reason"] for s in pending if s.get("reason")), "No connected source.")
                if kind == "record":
                    reason = "Not connected: suitable source and reuse terms required."
                categories.append({"id": kind, "label": label, "enabled": False, "reason": reason, "sources": []})
        return {"mode": self.mode, "sources": items, "categories": categories, "countries": self.countries(connected)}

    def countries(self, connected: list[dict[str, Any]]) -> list[str]:
        out: set[str] = set()
        for s in connected:
            con = self._open(s["id"])
            if con:
                with con:
                    out.update(r[0] for r in con.execute("SELECT DISTINCT code FROM countries LIMIT 300"))
                con.close()
        return sorted(c for c in out if len(c) == 2 and c.isalpha())

    def _open(self, cid: str) -> sqlite3.Connection | None:
        p = self.stores[cid].current_file() if cid in self.stores else None
        return open_readonly(p) if p else None

    # ------------------------------------------------------------ search
    def search(self, q: Query) -> dict[str, Any]:
        text = nz.clean_input(q.text)[: nz.MAX_QUERY_LEN]
        out: dict[str, Any] = {"mode": self.mode, "results": [], "searched": [], "unavailable": [], "errors": []}
        ident = None
        if q.mode == "identifier":
            ident = nz.classify_identifier(text)
            if not ident:
                out["notice"] = "Not a supported identifier. Supported: Singapore UEN, URL (http/https) or domain."
                out.update(total=0, page=1, pages=0)
                return out
            out["identifier_type"] = ident.type
        elif not nz.tokens(text):
            out["notice"] = "Enter a name with at least one letter or number."
            out.update(total=0, page=1, pages=0)
            return out

        rows: list[dict[str, Any]] = []
        for cid, store in self.stores.items():
            c = self.connectors[cid]
            if q.category != "all" and q.category not in c.kinds:
                continue
            if ident and ident.type == "uen" and "company" not in c.kinds:
                continue
            if ident and ident.type in ("url", "domain") and "website" not in c.kinds:
                continue
            st = self.source_status(cid)
            if st["state"] not in ("connected", "stale"):
                out["unavailable"].append({"id": cid, "title": c.title, "state": st["state"], "reason": st.get("reason")})
                continue
            try:
                con = self._open(cid)
                if not con:
                    raise RuntimeError("snapshot missing")
                try:
                    got = self._search_source(con, c, q, text, ident)
                    if len(got) >= PER_SOURCE_CAP:
                        out["capped"] = True
                    rows.extend(got)
                finally:
                    con.close()
                out["searched"].append({"id": cid, "title": c.title, "state": st["state"]})
            except (sqlite3.Error, RuntimeError):
                out["errors"].append({"id": cid, "title": c.title, "message": "Source could not be searched right now."})

        rows.sort(key=lambda r: (TIER_ORDER[r.pop("_tier")], r.pop("_sort"), r["id"]))
        total = len(rows)
        pages = (total + PAGE_SIZE - 1) // PAGE_SIZE
        page = max(1, min(q.page, max(pages, 1)))
        out.update(results=rows[(page - 1) * PAGE_SIZE: page * PAGE_SIZE], total=total, page=page, pages=pages,
                   page_size=PAGE_SIZE)
        return out

    def _filters(self, q: Query) -> tuple[str, list[Any]]:
        sql, args = [], []
        if q.category != "all":
            sql.append("e.kind = ?")
            args.append(q.category)
        if q.topic in ("sanction", "pep"):
            sql.append("(',' || e.topic_flags || ',') LIKE ?")
            args.append(f"%,{q.topic},%")
        if q.country:
            sql.append("EXISTS (SELECT 1 FROM countries k WHERE k.entity_rowid = e.rowid AND k.code = ?)")
            args.append(q.country)
        return (" AND " + " AND ".join(sql)) if sql else "", args

    def _search_source(self, con, c: Connector, q: Query, text: str, ident) -> list[dict[str, Any]]:
        fsql, fargs = self._filters(q)
        found: dict[int, dict[str, Any]] = {}

        def take(sql: str, args: list[Any], tier: str, matched_col: bool = False):
            for row in con.execute(sql + fsql + f" LIMIT {PER_SOURCE_CAP}", args + fargs):
                if row["rowid"] in found or len(found) >= PER_SOURCE_CAP:
                    continue
                found[row["rowid"]] = self._summary(row, c, tier, row["matched"] if matched_col else None)

        cols = "e.rowid, e.id, e.kind, e.schema, e.caption, e.caption_fold, e.countries, e.topics, e.datasets"
        if ident:
            if ident.type == "uen":
                take(f"SELECT {cols} FROM identifiers i JOIN entities e ON e.rowid = i.entity_rowid "
                     "WHERE i.type = 'uen' AND i.norm = ?", [ident.value], "uen")
            elif ident.type == "url":
                take(f"SELECT {cols} FROM identifiers i JOIN entities e ON e.rowid = i.entity_rowid "
                     "WHERE i.type = 'url' AND i.norm = ?", [ident.value], "url")
                host = nz.url_host(ident.value)
                if host:
                    take(f"SELECT {cols} FROM identifiers i JOIN entities e ON e.rowid = i.entity_rowid "
                         "WHERE i.type = 'domain' AND i.norm = ? AND i.scope = 'host'", [host], "host")
            elif ident.type == "domain":
                take(f"SELECT {cols} FROM identifiers i JOIN entities e ON e.rowid = i.entity_rowid "
                     "WHERE i.type = 'domain' AND i.norm = ?", [ident.value], "host")
                take(f"SELECT {cols} FROM identifiers i JOIN entities e ON e.rowid = i.entity_rowid "
                     "WHERE i.type = 'url_host' AND i.norm = ?", [ident.value], "url_host")
            return list(found.values())

        norm = nz.fold(text)
        take(f"SELECT {cols}, n.name AS matched FROM names n JOIN entities e ON e.rowid = n.entity_rowid "
             "WHERE n.norm = ?", [norm], "exact", True)
        match = nz.fts_query(text)
        if match and len(found) < PER_SOURCE_CAP:
            last = nz.tokens(text)[-1]
            sql = (f"SELECT {cols}, n.name AS matched, n.norm AS mnorm FROM names_fts f "
                   "JOIN names n ON n.rowid = f.rowid JOIN entities e ON e.rowid = n.entity_rowid "
                   "WHERE names_fts MATCH ?")
            for row in con.execute(sql + fsql + " LIMIT 2000", [match] + fargs):
                if row["rowid"] in found:
                    continue
                if len(found) >= PER_SOURCE_CAP:
                    break
                tier = "text" if last in row["mnorm"].split() else "prefix"
                found[row["rowid"]] = self._summary(row, c, tier, row["matched"])
        return list(found.values())

    @staticmethod
    def _summary(row, c: Connector, tier: str, matched: str | None) -> dict[str, Any]:
        topics = json.loads(row["topics"] or "[]")
        datasets = json.loads(row["datasets"] or "[]")
        caption = row["caption"]
        item = {
            "id": row["id"], "caption": caption, "kind": row["kind"], "schema": row["schema"],
            "countries": json.loads(row["countries"] or "[]")[:6],
            "topics": [{"id": t, "label": topic_label(t), "class": topic_class(t)} for t in topics[:8]],
            "datasets": [d.get("title") or d.get("id") for d in datasets[:4]],
            "source": {"id": c.id, "title": c.title},
            "reason": TIER_REASON[tier],
            "demo": c.mode == "demo",
            "_tier": tier, "_sort": row["caption_fold"],
        }
        if matched and nz.fold(matched) != nz.fold(caption):
            item["matched_name"] = matched
        if row["kind"] == "website":
            item["caption_defanged"] = nz.defang(caption)
        return item

    # ------------------------------------------------------------ detail
    def record(self, record_id: str) -> dict[str, Any] | None:
        if not isinstance(record_id, str) or len(record_id) > 200 or ":" not in record_id:
            return None
        cid = record_id.split(":", 1)[0]
        if cid not in self.stores or not self.connectors[cid].available:
            return None
        con = self._open(cid)
        if not con:
            return None
        try:
            row = con.execute("SELECT * FROM entities WHERE id = ?", [record_id]).fetchone()
            resolved_from = None
            if not row:
                ref = con.execute("SELECT entity_id FROM referents WHERE old_id = ?", [record_id]).fetchone()
                if ref:
                    row = con.execute("SELECT * FROM entities WHERE id = ?", [ref[0]]).fetchone()
                    resolved_from = record_id
            if not row:
                return None
            meta = dict(con.execute("SELECT key, value FROM meta"))
        finally:
            con.close()
        return self._detail(row, self.connectors[cid], meta, resolved_from)

    def _detail(self, row, c: Connector, meta: dict[str, str], resolved_from: str | None) -> dict[str, Any]:
        j = lambda k, d: json.loads(row[k]) if row[k] else d  # noqa: E731
        names = j("names", [])
        identifiers = []
        for i in j("identifiers", []):
            entry = {"type": i.get("type"), "label": i.get("label") or str(i.get("type", "Identifier")).upper(),
                     "scope": i.get("scope")}
            if i.get("sensitive", True) and i.get("type") not in ("uen", "url", "domain"):
                entry.update(masked=True, value=None)
            elif i.get("type") in ("url", "domain"):
                entry.update(masked=False, value=None, defanged=nz.defang(str(i.get("value", ""))))
            else:
                entry.update(masked=False, value=str(i.get("value", ""))[:100])
            identifiers.append(entry)
        dates = []
        for d in j("dates", []):
            v = str(d.get("value", ""))
            dates.append({"type": d.get("type"), "label": DATE_LABELS.get(d.get("type"), str(d.get("type")).replace("_", " ").capitalize()),
                          "value": v, "precision": nz.date_precision(v)})
        links = []
        for l in j("links", []):
            url = nz.safe_link(l.get("url", ""))
            if url:
                links.append({"label": str(l.get("label") or "Source page")[:120], "url": url})
        props = []
        for k, v in j("properties", {}).items():
            if isinstance(v, (str, int, float)):
                props.append({"key": k, "label": PROPERTY_LABELS.get(k, k.replace("_", " ").capitalize()), "value": str(v)[:2000]})
        prov = j("provenance", {})
        topics = j("topics", [])
        st = self.source_status(c.id)
        return {
            "id": row["id"], "resolved_from": resolved_from, "kind": row["kind"], "schema": row["schema"],
            "caption": row["caption"],
            "caption_defanged": nz.defang(row["caption"]) if row["kind"] == "website" else None,
            "names": [{"value": n["value"], "type": n["type"]} for n in names],
            "countries": j("countries", []),
            "topics": [{"id": t, "label": topic_label(t), "class": topic_class(t)} for t in topics],
            "datasets": [{"id": d.get("id"), "title": d.get("title")} for d in j("datasets", [])],
            "identifiers": identifiers, "dates": dates, "links": links, "properties": props,
            "provenance": {"first_seen": prov.get("first_seen"), "last_change": prov.get("last_change"),
                           "published": prov.get("published")},
            "source": {"id": c.id, "title": c.title, "state": st["state"], "stale_reasons": st.get("stale_reasons", []),
                       "attribution": c.attribution, "licence": {"name": c.licence_name, "url": nz.safe_link(c.licence_url or "")},
                       "imported_at": meta.get("imported_at"), "upstream_exported_at": meta.get("upstream_exported_at")},
            "demo": c.mode == "demo",
        }
