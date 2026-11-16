"""Per-source SQLite snapshots: stream -> validate -> build new file -> atomic swap.

Layout under <data>/<mode>/<source>/:
  snapshot-<stamp>.sqlite   immutable once built
  current                   one line: the active snapshot file name (replaced with os.replace)
  status.json               last attempt/success/error, previous snapshot (for rollback)
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import os
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Iterator

from . import normalize as nz
from .models import Record, RowError

SNAPSHOT_SCHEMA_VERSION = 1

DDL = """
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE entities(
  rowid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  schema TEXT NOT NULL,
  caption TEXT NOT NULL,
  caption_fold TEXT NOT NULL,
  names TEXT, countries TEXT, topics TEXT, datasets TEXT, identifiers TEXT,
  dates TEXT, links TEXT, properties TEXT, provenance TEXT, raw TEXT,
  topic_flags TEXT NOT NULL DEFAULT ''
);
CREATE TABLE names(entity_rowid INTEGER NOT NULL, name TEXT NOT NULL, norm TEXT NOT NULL, type TEXT NOT NULL);
CREATE TABLE identifiers(entity_rowid INTEGER NOT NULL, type TEXT NOT NULL, norm TEXT NOT NULL, scope TEXT);
CREATE TABLE countries(entity_rowid INTEGER NOT NULL, code TEXT NOT NULL);
CREATE TABLE referents(old_id TEXT PRIMARY KEY, entity_id TEXT NOT NULL);
CREATE VIRTUAL TABLE names_fts USING fts5(norm, content='names', content_rowid='rowid', tokenize="unicode61 remove_diacritics 2");
"""

POST_DDL = """
CREATE INDEX names_norm ON names(norm);
CREATE INDEX names_entity ON names(entity_rowid);
CREATE INDEX ident_lookup ON identifiers(type, norm);
CREATE INDEX countries_lookup ON countries(code, entity_rowid);
CREATE INDEX entities_kind ON entities(kind);
INSERT INTO names_fts(names_fts) VALUES('rebuild');
INSERT INTO names_fts(names_fts) VALUES('optimize');
"""


class ImportRejected(Exception):
    """The new snapshot failed validation; the current snapshot was left untouched."""


@dataclass
class ImportPolicy:
    max_reject_ratio: float = 0.01
    min_ratio_vs_previous: float = 0.5
    allow_shrink: bool = False
    min_rows: int = 1


def _utcnow() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()


def topic_flags(topics: Iterable[str]) -> str:
    """Compact searchable topic classes. Sanctions and PEP are separate; one never implies the other."""
    flags = set()
    for t in topics:
        if t == "sanction" or t.startswith("sanction."):
            flags.add("sanction")
        elif t == "role.pep" or t.startswith("role.pep") or t in ("role.rca",):
            flags.add("pep")
    return ",".join(sorted(flags))


class SnapshotStore:
    def __init__(self, base: Path, source_id: str, keep: int = 2):
        self.source_id = source_id
        self.dir = Path(base) / source_id
        self.keep = max(2, keep)

    # ------------------------------------------------------------ paths and status
    @property
    def pointer(self) -> Path:
        return self.dir / "current"

    @property
    def status_path(self) -> Path:
        return self.dir / "status.json"

    def current_file(self) -> Path | None:
        try:
            name = self.pointer.read_text().strip()
        except FileNotFoundError:
            return None
        p = self.dir / name
        if not name.startswith("snapshot-") or "/" in name or not p.is_file():
            return None
        return p

    def read_status(self) -> dict[str, Any]:
        try:
            return json.loads(self.status_path.read_text())
        except (FileNotFoundError, ValueError):
            return {}

    def _write_status(self, **updates: Any) -> None:
        st = self.read_status()
        st.update(updates)
        tmp = self.status_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(st, indent=1, sort_keys=True))
        os.replace(tmp, self.status_path)

    def current_meta(self) -> dict[str, str]:
        p = self.current_file()
        if not p:
            return {}
        con = open_readonly(p)
        try:
            return dict(con.execute("SELECT key, value FROM meta"))
        finally:
            con.close()

    def _swap(self, name: str) -> None:
        tmp = self.dir / "current.tmp"
        with open(tmp, "w") as f:
            f.write(name + "\n")
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, self.pointer)

    # ------------------------------------------------------------ build
    def build(
        self,
        records: Iterator[Record | RowError],
        upstream: dict[str, Any] | None = None,
        policy: ImportPolicy | None = None,
    ) -> dict[str, Any]:
        """Build and activate a new snapshot. Raises ImportRejected; never touches `current` on failure."""
        policy = policy or ImportPolicy()
        upstream = upstream or {}
        self.dir.mkdir(parents=True, exist_ok=True)
        attempt = _utcnow()
        self._write_status(last_attempt=attempt)
        stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        building = self.dir / f".building-{stamp}.sqlite"
        final = self.dir / f"snapshot-{stamp}.sqlite"
        try:
            stats = self._build_file(building, records, upstream, policy, attempt)
            os.replace(building, final)
            previous = self.current_file()
            self._swap(final.name)
        except BaseException as e:  # includes KeyboardInterrupt: never leave a half-built snapshot active
            for suffix in ("", "-journal", "-wal", "-shm"):
                try:
                    os.unlink(str(building) + suffix)
                except FileNotFoundError:
                    pass
            self._write_status(last_error=f"{type(e).__name__}: {str(e)[:300]}", last_error_at=attempt)
            if isinstance(e, ImportRejected):
                raise
            if isinstance(e, Exception):
                raise ImportRejected(f"import failed: {type(e).__name__}: {e}") from e
            raise
        self._write_status(
            last_success=attempt,
            last_error=None,
            last_error_at=None,
            previous=previous.name if previous else None,
            rows=stats["rows"],
            rejected=stats["rejected"],
        )
        self._prune()
        return stats

    def _build_file(self, path: Path, records, upstream, policy: ImportPolicy, attempt: str) -> dict[str, Any]:
        con = sqlite3.connect(path)
        try:
            con.execute("PRAGMA journal_mode=OFF")
            con.execute("PRAGMA synchronous=OFF")
            con.executescript(DDL)
            rows = rejected = 0
            seen_referents: dict[str, str] = {}
            batch_names: list[tuple] = []
            for item in records:
                if isinstance(item, RowError):
                    rejected += 1
                    continue
                try:
                    item.validate(self.source_id)
                except RowError:
                    rejected += 1
                    continue
                try:
                    rid = self._insert(con, item, batch_names)
                except sqlite3.IntegrityError:
                    rejected += 1  # duplicate id
                    continue
                rows += 1
                for old in item.referents:
                    if old != item.id:
                        seen_referents.setdefault(old, item.id)
                if len(batch_names) >= 5000:
                    con.executemany("INSERT INTO names(entity_rowid, name, norm, type) VALUES (?,?,?,?)", batch_names)
                    batch_names.clear()
                del rid
            if batch_names:
                con.executemany("INSERT INTO names(entity_rowid, name, norm, type) VALUES (?,?,?,?)", batch_names)
            total = rows + rejected
            if rows < policy.min_rows:
                raise ImportRejected(f"empty snapshot ({rows} valid rows, {rejected} rejected)")
            if total and rejected / total > policy.max_reject_ratio:
                raise ImportRejected(f"too many malformed rows: {rejected} of {total}")
            prev = self.current_meta()
            if prev.get("rows") and not policy.allow_shrink:
                prev_rows = int(prev["rows"])
                if rows < prev_rows * policy.min_ratio_vs_previous:
                    raise ImportRejected(f"unexpectedly small snapshot: {rows} rows vs {prev_rows} previously")
            # Referents: an old ID that is itself a current entity stays itself.
            con.executemany(
                "INSERT OR IGNORE INTO referents(old_id, entity_id) SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM entities WHERE id = ?)",
                ((old, new, old) for old, new in seen_referents.items()),
            )
            con.executescript(POST_DDL)
            meta = {
                "source": self.source_id,
                "snapshot_schema": str(SNAPSHOT_SCHEMA_VERSION),
                "imported_at": attempt,
                "rows": str(rows),
                "rejected": str(rejected),
            }
            for k, v in upstream.items():
                if v is not None:
                    meta[f"upstream_{k}"] = str(v)
            con.executemany("INSERT INTO meta(key, value) VALUES (?, ?)", meta.items())
            con.commit()
            integrity = con.execute("PRAGMA quick_check").fetchone()[0]
            if integrity != "ok":
                raise ImportRejected(f"integrity check failed: {integrity}")
            return {"rows": rows, "rejected": rejected, "imported_at": attempt}
        finally:
            con.close()

    @staticmethod
    def _insert(con: sqlite3.Connection, r: Record, batch_names: list[tuple]) -> int:
        dumps = lambda v: json.dumps(v, ensure_ascii=False, separators=(",", ":"))  # noqa: E731
        cur = con.execute(
            "INSERT INTO entities(id, kind, schema, caption, caption_fold, names, countries, topics, datasets, identifiers,"
            " dates, links, properties, provenance, raw, topic_flags) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                r.id, r.kind, r.schema, r.caption, nz.fold(r.caption), dumps(r.names), dumps(r.countries),
                dumps(r.topics), dumps(r.datasets), dumps(r.identifiers), dumps(r.dates), dumps(r.links),
                dumps(r.properties), dumps(r.provenance), dumps(r.raw), topic_flags(r.topics),
            ),
        )
        rowid = cur.lastrowid
        seen = set()
        for n in r.names:
            norm = nz.fold(n["value"])
            if norm and (norm, n["type"]) not in seen:
                seen.add((norm, n["type"]))
                batch_names.append((rowid, n["value"], norm, n["type"]))
        for ident in r.identifiers:
            t, v = ident.get("type"), ident.get("value")
            if not isinstance(v, str):
                continue
            norm = None
            if t == "uen":
                norm = nz.normalize_uen(v)
            elif t == "url":
                norm = nz.normalize_url(v)
            elif t == "domain":
                norm = nz.normalize_host(v)
            elif isinstance(t, str):
                norm = nz.clean_input(v).upper() or None
            if norm:
                con.execute("INSERT INTO identifiers(entity_rowid, type, norm, scope) VALUES (?,?,?,?)",
                            (rowid, t, norm, ident.get("scope")))
                if t == "url":  # host index for "URL on this host" candidates (never a host-wide listing)
                    host = nz.url_host(norm)
                    if host:
                        con.execute("INSERT INTO identifiers(entity_rowid, type, norm, scope) VALUES (?,?,?,?)",
                                    (rowid, "url_host", host, "exact_url"))
        for c in {c.lower() for c in r.countries if isinstance(c, str)}:
            con.execute("INSERT INTO countries(entity_rowid, code) VALUES (?, ?)", (rowid, c))
        return rowid

    # ------------------------------------------------------------ rollback / retention
    def rollback(self) -> str:
        st = self.read_status()
        prev = st.get("previous")
        cur = self.current_file()
        if not prev or not (self.dir / prev).is_file():
            raise ImportRejected("no previous snapshot to roll back to")
        self._swap(prev)
        self._write_status(previous=cur.name if cur else None, rolled_back_at=_utcnow())
        return prev

    def _prune(self) -> None:
        cur = self.current_file()
        prev = self.read_status().get("previous")
        keepers = {p for p in (cur.name if cur else None, prev) if p}
        snaps = sorted(self.dir.glob("snapshot-*.sqlite"), reverse=True)
        for p in snaps[self.keep:]:
            if p.name not in keepers:
                p.unlink(missing_ok=True)


def open_readonly(path: Path) -> sqlite3.Connection:
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True, check_same_thread=False)
    con.row_factory = sqlite3.Row
    return con


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()
