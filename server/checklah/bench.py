"""Synthetic benchmark: import time, disk, peak RAM and search latency. Not real-source numbers."""

from __future__ import annotations

import os
import platform
import random
import resource
import shutil
import statistics
import tempfile
import time
from pathlib import Path

from .connectors.base import Connector, register
from .models import Record
from .search import Query, SearchService
from .snapshot import SnapshotStore

SYL = ["an", "bel", "cor", "dra", "el", "fin", "gor", "hal", "is", "jun", "ka", "lim", "mor", "nash", "ol", "pra",
       "quin", "ros", "sel", "tan", "ul", "vor", "wen", "xan", "yus", "zel", "ah", "ming", "kumar", "lee", "ng", "ong"]


def name(rng: random.Random, parts: int) -> str:
    return " ".join("".join(rng.choice(SYL) for _ in range(rng.randint(1, 3))).capitalize() for _ in range(parts))


def records(n: int, seed: int = 7):
    rng = random.Random(seed)
    for i in range(n):
        person = rng.random() < 0.6
        primary = name(rng, rng.randint(2, 4)) if person else name(rng, rng.randint(1, 3)) + " Pte. Ltd."
        aliases = [{"value": name(rng, 2), "type": "alias"} for _ in range(rng.choice([0, 0, 1, 2, 5]))]
        yield Record(
            id=f"bench:{i}", kind="person" if person else "company", schema="Person" if person else "Company",
            caption=primary, names=[{"value": primary, "type": "primary"}] + aliases,
            countries=[rng.choice(["sg", "my", "id", "gb", "us", "cn", "in", "ru"])],
            topics=[rng.choice(["sanction", "role.pep", "crime", "debarment"])],
            datasets=[{"id": "synthetic", "title": "Synthetic benchmark"}],
            identifiers=[{"type": "uen", "value": f"T99BM{i % 10000:04d}{chr(65 + i % 26)}", "label": "UEN", "sensitive": False}]
            if not person else [],
            properties={"notes": "synthetic " * 5}, raw={"i": i, "pad": "x" * 200},
        )


def pct(xs, p):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(len(xs) * p))]


def run(n: int, workdir: Path | None) -> int:
    register(Connector(id="bench", title="Synthetic", mode="bench", kinds=("person", "company"), scope="", licence_name="",
                       licence_url=None, attribution=""))
    tmp = Path(tempfile.mkdtemp(dir=workdir))
    try:
        store = SnapshotStore(tmp, "bench")
        t0 = time.perf_counter()
        stats = store.build(records(n), {"exported_at": None})
        t_import = time.perf_counter() - t0
        size = store.current_file().stat().st_size
        svc = SearchService(tmp, "bench")
        rng = random.Random(99)
        sample = [r.caption for r in records(min(n, 2000), seed=7)]
        suites = {
            "exact full name": [Query(rng.choice(sample)) for _ in range(200)],
            "prefix (3 letters)": [Query(rng.choice(SYL)[:3]) for _ in range(200)],
            "common token + filter": [Query(rng.choice(SYL), topic="sanction", country="sg") for _ in range(200)],
            "exact UEN": [Query(f"T99BM{rng.randint(0, 9999):04d}A", mode="identifier") for _ in range(200)],
        }
        print(f"host: {platform.processor() or platform.machine()} | {os.cpu_count()} CPUs | Python {platform.python_version()}"
              f" | SQLite {__import__('sqlite3').sqlite_version}")
        print(f"rows: {stats['rows']:,} entities | import {t_import:.1f}s ({stats['rows'] / t_import:,.0f}/s) | "
              f"snapshot {size / 1e6:.0f} MB | peak RSS {resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024:.0f} MB")
        for label, qs in suites.items():
            times, totals = [], []
            for q in qs:
                s = time.perf_counter()
                r = svc.search(q)
                times.append((time.perf_counter() - s) * 1000)
                totals.append(r["total"])
            print(f"  {label:24s} p50 {statistics.median(times):6.1f} ms  p95 {pct(times, .95):6.1f} ms  max {max(times):6.1f} ms"
                  f"  (median candidates {statistics.median(totals):.0f})")
        return 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
