"""The connector-neutral record shape every connector produces."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

KINDS = ("person", "company", "website", "record", "other")
NAME_TYPES = ("primary", "alias", "weak_alias", "previous")


class RowError(Exception):
    """A single malformed upstream row. Counted, skipped, and bounded by the reject ratio."""


@dataclass
class Record:
    id: str
    kind: str
    schema: str
    caption: str
    names: list[dict[str, str]] = field(default_factory=list)  # {"value", "type"}
    countries: list[str] = field(default_factory=list)
    topics: list[str] = field(default_factory=list)
    datasets: list[dict[str, str]] = field(default_factory=list)  # {"id", "title"}
    identifiers: list[dict[str, Any]] = field(default_factory=list)  # {"type","value","label","sensitive","scope"?}
    dates: list[dict[str, str]] = field(default_factory=list)  # {"type", "value"}
    links: list[dict[str, str]] = field(default_factory=list)  # {"label", "url"}
    properties: dict[str, Any] = field(default_factory=dict)
    provenance: dict[str, Any] = field(default_factory=dict)
    referents: list[str] = field(default_factory=list)
    raw: dict[str, Any] = field(default_factory=dict)

    def validate(self, namespace: str) -> None:
        if not isinstance(self.id, str) or not self.id.startswith(namespace + ":") or len(self.id) > 200:
            raise RowError("id missing or outside source namespace")
        if self.kind not in KINDS:
            raise RowError("unknown kind")
        if not isinstance(self.caption, str) or not self.caption.strip() or len(self.caption) > 1000:
            raise RowError("caption missing")
        for n in self.names:
            if not isinstance(n.get("value"), str) or n.get("type") not in NAME_TYPES:
                raise RowError("bad name entry")
        for r in self.referents:
            if not isinstance(r, str) or not r.startswith(namespace + ":"):
                raise RowError("referent outside namespace")
        if not any(n["type"] == "primary" for n in self.names):
            self.names.insert(0, {"value": self.caption, "type": "primary"})
