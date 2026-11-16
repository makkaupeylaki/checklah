"""Connector interface. A connector describes a source and turns a local file into Records.

Connectors never fetch user-supplied URLs. Live connectors that are not yet verified declare
`blocked_reason`; the importer refuses to run them and the UI shows the reason.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterator

from ..models import Record, RowError


@dataclass
class Connector:
    id: str
    title: str
    mode: str  # "demo" | "live" ("bench" only for the benchmark)
    kinds: tuple[str, ...]  # categories it can provide
    scope: str
    licence_name: str
    licence_url: str | None
    attribution: str
    homepage: str | None = None
    refresh: str = ""
    max_age_hours: float | None = None  # local import older than this -> stale
    upstream_max_age_hours: float | None = None  # upstream export older than this -> stale
    blocked_reason: str | None = None  # set -> cannot be imported or searched
    allowed_hosts: tuple[str, ...] = ()
    input_format: str | None = None
    input_schema_version: int | None = None
    parse_row: Callable[[dict[str, Any]], Record] | None = field(default=None, repr=False)
    notes: tuple[str, ...] = ()

    @property
    def available(self) -> bool:
        return self.blocked_reason is None

    def read(self, path: Path) -> tuple[dict[str, Any], Iterator[Record | RowError]]:
        """Read a CheckLah JSONL interchange file: header line, then one row per line."""
        if not self.available or not self.parse_row:
            raise RuntimeError(f"connector {self.id} is not available: {self.blocked_reason}")
        f = open(path, "r", encoding="utf-8")
        try:
            header = json.loads(f.readline() or "null")
        except ValueError:
            f.close()
            raise ValueError("missing or malformed header line")
        if not isinstance(header, dict) or header.get("format") != self.input_format:
            f.close()
            raise ValueError(f"unexpected format: expected {self.input_format!r}")
        if header.get("schema_version") != self.input_schema_version:
            f.close()
            raise ValueError(
                f"changed schema: got version {header.get('schema_version')!r}, expected {self.input_schema_version}")
        upstream = {k: header.get(k) for k in ("exported_at", "version", "row_count")}

        def rows() -> Iterator[Record | RowError]:
            with f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        obj = json.loads(line)
                        if not isinstance(obj, dict):
                            raise RowError("row is not an object")
                        yield self.parse_row(obj)
                    except (ValueError, KeyError, TypeError, RowError) as e:
                        yield e if isinstance(e, RowError) else RowError(str(e)[:120])

        return upstream, rows()


def record_from_dict(obj: dict[str, Any]) -> Record:
    allowed = Record.__dataclass_fields__.keys()
    unknown = set(obj) - set(allowed)
    if unknown:
        raise RowError(f"unknown fields: {sorted(unknown)[:3]}")
    return Record(**obj)


_REGISTRY: dict[str, Connector] = {}


def register(c: Connector) -> Connector:
    _REGISTRY[c.id] = c
    return c


def registry() -> dict[str, Connector]:
    from . import demo, live  # noqa: F401  (populate)
    return dict(_REGISTRY)
