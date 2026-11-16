import json
import os
import subprocess
import sys
from pathlib import Path

import httpx
import pytest

from checklah.connectors.base import registry
from checklah.connectors.demo import FORMAT, SCHEMA_VERSION, WATCHLIST
from checklah.download import DownloadError, download
from checklah.models import RowError
from checklah.search import Query, SearchService
from checklah.snapshot import ImportPolicy, ImportRejected, SnapshotStore

SERVER = Path(__file__).resolve().parents[1]


def write(path: Path, rows, header=None, raw_lines=()):
    header = header or {"format": FORMAT, "schema_version": SCHEMA_VERSION, "exported_at": "2026-11-16T00:00:00+00:00"}
    with open(path, "w") as f:
        f.write(json.dumps(header) + "\n")
        for r in rows:
            f.write(json.dumps(r) + "\n")
        for line in raw_lines:
            f.write(line + "\n")
    return path


def run_import(base: Path, path: Path, policy=None):
    c = registry()["demo-watchlist"]
    up, rows = c.read(path)
    return SnapshotStore(base, "demo-watchlist").build(rows, up, policy)


def ids(base):
    s = SearchService(base, "demo")
    return {x["id"] for x in s.search(Query("a", category="all"))["results"]}


@pytest.fixture
def base(tmp_path):
    b = tmp_path / "demo"
    b.mkdir()
    return b


def test_good_import_then_changed_schema_keeps_current(base, tmp_path):
    run_import(base, write(tmp_path / "a.jsonl", WATCHLIST))
    store = SnapshotStore(base, "demo-watchlist")
    before = store.current_file()
    bad = write(tmp_path / "b.jsonl", WATCHLIST, header={"format": FORMAT, "schema_version": 2})
    with pytest.raises(ValueError, match="changed schema"):
        registry()["demo-watchlist"].read(bad)
    wrong = write(tmp_path / "c.jsonl", WATCHLIST, header={"format": "something-else", "schema_version": 1})
    with pytest.raises(ValueError, match="unexpected format"):
        registry()["demo-watchlist"].read(wrong)
    assert store.current_file() == before


def test_malformed_rows_counted_and_ratio_enforced(base, tmp_path):
    rows = list(WATCHLIST) + [dict(WATCHLIST[0], id="demo-watchlist:EXTRA-%d" % i) for i in range(200)]
    stats = run_import(base, write(tmp_path / "a.jsonl", rows, raw_lines=["{not json", "[1,2]"]))
    assert stats["rejected"] == 2 and stats["rows"] == len(rows)
    store = SnapshotStore(base, "demo-watchlist")
    good = store.current_file()
    many_bad = write(tmp_path / "b.jsonl", WATCHLIST, raw_lines=["{bad"] * 5)
    with pytest.raises(ImportRejected, match="malformed"):
        run_import(base, many_bad, ImportPolicy(allow_shrink=True))
    assert store.current_file() == good
    assert "malformed" in store.read_status()["last_error"]


def test_row_validation(base, tmp_path):
    rows = [dict(WATCHLIST[0]), dict(WATCHLIST[1], id="other-source:X"), dict(WATCHLIST[2], caption=""),
            dict(WATCHLIST[3], kind="alien"), dict(WATCHLIST[4], unexpected=1), dict(WATCHLIST[0])]
    with pytest.raises(ImportRejected, match="malformed"):
        run_import(base, write(tmp_path / "a.jsonl", rows))


def test_empty_snapshot_rejected_and_unexpected_shrink(base, tmp_path):
    with pytest.raises(ImportRejected, match="empty"):
        run_import(base, write(tmp_path / "empty.jsonl", []))
    assert SnapshotStore(base, "demo-watchlist").current_file() is None
    rows = [dict(WATCHLIST[0], id=f"demo-watchlist:R{i}", caption=f"Name {i}") for i in range(100)]
    run_import(base, write(tmp_path / "a.jsonl", rows))
    with pytest.raises(ImportRejected, match="unexpectedly small"):
        run_import(base, write(tmp_path / "b.jsonl", rows[:10]))
    assert SnapshotStore(base, "demo-watchlist").current_meta()["rows"] == "100"
    run_import(base, write(tmp_path / "b.jsonl", rows[:10]), ImportPolicy(allow_shrink=True))
    assert SnapshotStore(base, "demo-watchlist").current_meta()["rows"] == "10"


def test_deletion_referents_and_rollback(base, tmp_path):
    s = lambda: SearchService(base, "demo")  # noqa: E731
    run_import(base, write(tmp_path / "a.jsonl", WATCHLIST))
    assert s().record("demo-watchlist:DEMO-P-0001")
    # New snapshot: P-0001 removed by the source; P-0002 re-issued under a new ID with a referent.
    newer = [r for r in WATCHLIST if r["id"] not in ("demo-watchlist:DEMO-P-0001", "demo-watchlist:DEMO-P-0002")]
    newer.append(dict(WATCHLIST[1], id="demo-watchlist:DEMO-P-2002", referents=["demo-watchlist:DEMO-P-0002"]))
    run_import(base, write(tmp_path / "b.jsonl", newer))
    assert s().record("demo-watchlist:DEMO-P-0001") is None  # removed allegation is gone
    assert s().search(Query("Orlo Vantrell", topic="sanction"))["total"] == 0
    d = s().record("demo-watchlist:DEMO-P-0002")
    assert d["id"] == "demo-watchlist:DEMO-P-2002" and d["resolved_from"] == "demo-watchlist:DEMO-P-0002"
    SnapshotStore(base, "demo-watchlist").rollback()
    assert s().record("demo-watchlist:DEMO-P-0001")  # previous good snapshot restored


def test_interrupted_build_leaves_current(base, tmp_path):
    run_import(base, write(tmp_path / "a.jsonl", WATCHLIST))
    store = SnapshotStore(base, "demo-watchlist")
    good = store.current_file()

    def boom():
        from checklah.models import Record
        yield Record(**WATCHLIST[0])
        raise OSError("connection reset mid-stream")

    with pytest.raises(ImportRejected):
        store.build(boom(), {})
    assert store.current_file() == good
    assert not list(base.glob("demo-watchlist/.building-*"))


def test_retention_keeps_previous(base, tmp_path):
    for i in range(4):
        run_import(base, write(tmp_path / f"{i}.jsonl", WATCHLIST))
    snaps = list((base / "demo-watchlist").glob("snapshot-*.sqlite"))
    assert len(snaps) == 2


def test_checksum_mismatch_via_cli(tmp_path):
    f = write(tmp_path / "a.jsonl", WATCHLIST)
    env = dict(os.environ, CHECKLAH_DATA_DIR=str(tmp_path / "data"), CHECKLAH_MODE="demo")
    p = subprocess.run([sys.executable, "-m", "checklah", "import", "demo-watchlist", "--file", str(f), "--sha256", "0" * 64],
                       cwd=SERVER, env=env, capture_output=True, text=True)
    assert p.returncode == 1 and "checksum mismatch" in p.stderr
    assert not (tmp_path / "data" / "demo" / "demo-watchlist" / "current").exists()
    import hashlib
    good = hashlib.sha256(f.read_bytes()).hexdigest()
    p = subprocess.run([sys.executable, "-m", "checklah", "import", "demo-watchlist", "--file", str(f), "--sha256", good],
                       cwd=SERVER, env=env, capture_output=True, text=True)
    assert p.returncode == 0, p.stderr


def test_cli_refuses_blocked_and_cross_mode(tmp_path):
    env = dict(os.environ, CHECKLAH_DATA_DIR=str(tmp_path / "data"), CHECKLAH_MODE="live")
    p = subprocess.run([sys.executable, "-m", "checklah", "import", "opensanctions", "--file", "/dev/null"],
                       cwd=SERVER, env=env, capture_output=True, text=True)
    assert "not available" in p.stdout
    p = subprocess.run([sys.executable, "-m", "checklah", "import", "demo-watchlist"], cwd=SERVER, env=env,
                       capture_output=True, text=True)
    assert p.returncode == 2 and "refusing" in p.stderr


def test_stale_banner_is_source_specific(tmp_path):
    from conftest import import_demo
    import_demo(tmp_path / "demo")
    states = {s["id"]: s for s in SearchService(tmp_path / "demo", "demo").sources()["sources"]}
    assert states["demo-webfeed"]["state"] == "stale"
    assert "upstream export" in states["demo-webfeed"]["stale_reasons"][0]
    assert states["demo-registry"]["state"] == "connected"


# ---------------------------------------------------------------- downloader
def client(handler):
    return httpx.Client(transport=httpx.MockTransport(handler), follow_redirects=False)


def test_download_allowlist_and_redirects(tmp_path):
    allowed = ("data.example.org",)
    with pytest.raises(DownloadError, match="not allowlisted"):
        download("https://evil.example/x", tmp_path / "f", allowed, max_bytes=100, timeout_s=5, client=client(lambda r: httpx.Response(200)))
    with pytest.raises(DownloadError, match="https"):
        download("http://data.example.org/x", tmp_path / "f", allowed, max_bytes=100, timeout_s=5, client=client(lambda r: httpx.Response(200)))

    def redirect_out(req):
        return httpx.Response(302, headers={"location": "http://169.254.169.254/latest/meta-data"})
    with pytest.raises(DownloadError):
        download("https://data.example.org/x", tmp_path / "f", allowed, max_bytes=100, timeout_s=5, client=client(redirect_out))

    def redirect_ok(req):
        if req.url.path == "/x":
            return httpx.Response(302, headers={"location": "/y"})
        return httpx.Response(200, content=b"hello")
    out = download("https://data.example.org/x", tmp_path / "f", allowed, max_bytes=100, timeout_s=5, client=client(redirect_ok))
    assert out.read_bytes() == b"hello"


def test_download_size_limit_and_interrupted(tmp_path):
    allowed = ("data.example.org",)
    big = client(lambda r: httpx.Response(200, content=b"x" * 1000))
    with pytest.raises(DownloadError, match="size"):
        download("https://data.example.org/x", tmp_path / "f", allowed, max_bytes=100, timeout_s=5, client=big)

    def short(req):
        return httpx.Response(200, headers={"content-length": "50"}, content=b"x" * 10)
    with pytest.raises(DownloadError):
        download("https://data.example.org/x", tmp_path / "f", allowed, max_bytes=100, timeout_s=5, client=client(short))
    assert not (tmp_path / "f").exists() and not (tmp_path / "f.part").exists()
