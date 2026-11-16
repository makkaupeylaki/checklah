"""Command line: import, rollback, status, add-user, serve, bench."""

from __future__ import annotations

import argparse
import getpass
import json
import sys
import tempfile
from pathlib import Path

from .config import ConfigError, Settings
from .connectors.base import registry
from .snapshot import ImportPolicy, ImportRejected, SnapshotStore, sha256_file


def cmd_import(s: Settings, a) -> int:
    conns = registry()
    ids = [c for c in conns if conns[c].mode == s.mode] if a.source == "all" else [a.source]
    rc = 0
    for cid in ids:
        c = conns.get(cid)
        if not c:
            print(f"unknown source {cid}", file=sys.stderr)
            return 2
        if c.mode != s.mode:
            print(f"{cid}: is a {c.mode} connector; refusing to import into {s.mode} mode", file=sys.stderr)
            return 2
        if not c.available:
            print(f"{cid}: not available — {c.blocked_reason}")
            continue
        store = SnapshotStore(s.mode_dir, cid)
        with tempfile.TemporaryDirectory() as td:
            path = Path(a.file) if a.file else None
            if path is None:
                if c.mode != "demo":
                    print(f"{cid}: --file is required", file=sys.stderr)
                    return 2
                from .connectors.demo import write_demo_file
                path = write_demo_file(cid, Path(td) / f"{cid}.jsonl", with_probes=a.with_probes)
            if a.sha256 and sha256_file(path) != a.sha256.lower():
                store._write_status(last_error="ImportRejected: checksum mismatch")
                print(f"{cid}: rejected — checksum mismatch", file=sys.stderr)
                rc = 1
                continue
            try:
                upstream, rows = c.read(path)
                stats = store.build(rows, upstream, ImportPolicy(allow_shrink=a.allow_shrink))
                print(f"{cid}: imported {stats['rows']} rows ({stats['rejected']} rejected)")
            except (ImportRejected, ValueError) as e:
                store._write_status(last_error=f"{type(e).__name__}: {e}")
                print(f"{cid}: rejected — {e}", file=sys.stderr)
                rc = 1
    return rc


def cmd_rollback(s: Settings, a) -> int:
    try:
        print(f"{a.source}: now using {SnapshotStore(s.mode_dir, a.source).rollback()}")
        return 0
    except ImportRejected as e:
        print(f"{a.source}: {e}", file=sys.stderr)
        return 1


def cmd_status(s: Settings, a) -> int:
    from .search import SearchService
    print(json.dumps(SearchService(s.mode_dir, s.mode).sources()["sources"], indent=1))
    return 0


def cmd_add_user(s: Settings, a) -> int:
    from .auth import save_user
    path = s.users_file or (s.data_dir / "users.json")
    pw = getpass.getpass(f"Password for {a.username}: ")
    if len(pw) < 12:
        print("Use at least 12 characters.", file=sys.stderr)
        return 1
    if pw != getpass.getpass("Again: "):
        print("Passwords differ.", file=sys.stderr)
        return 1
    save_user(path, a.username, pw)
    print(f"Saved {a.username} to {path} (argon2id hash, mode 600).")
    return 0


def cmd_serve(s: Settings, a) -> int:
    import uvicorn
    from .app import configure_logging, create_app
    configure_logging()
    uvicorn.run(create_app(s), host=s.host, port=s.port, access_log=False, server_header=False, log_level="info")
    return 0


def cmd_bench(s: Settings, a) -> int:
    from .bench import run
    return run(a.rows, Path(a.workdir) if a.workdir else None)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="checklah")
    sub = p.add_subparsers(dest="cmd", required=True)
    i = sub.add_parser("import", help="build a new snapshot for a source (or 'all' in the current mode)")
    i.add_argument("source")
    i.add_argument("--file", help="local input file (required for live connectors)")
    i.add_argument("--sha256", help="expected checksum of the input file, when the source supplies one")
    i.add_argument("--allow-shrink", action="store_true", help="accept a snapshot under 50%% of the previous size")
    i.add_argument("--with-probes", action="store_true", help=argparse.SUPPRESS)
    r = sub.add_parser("rollback")
    r.add_argument("source")
    sub.add_parser("status")
    u = sub.add_parser("add-user")
    u.add_argument("username")
    sub.add_parser("serve")
    b = sub.add_parser("bench")
    b.add_argument("--rows", type=int, default=500_000)
    b.add_argument("--workdir")
    a = p.parse_args(argv)
    try:
        s = Settings.from_env() if a.cmd == "serve" else _settings_lenient()
    except ConfigError as e:
        print(f"config error: {e}", file=sys.stderr)
        return 2
    return {"import": cmd_import, "rollback": cmd_rollback, "status": cmd_status, "add-user": cmd_add_user,
            "serve": cmd_serve, "bench": cmd_bench}[a.cmd](s, a)


def _settings_lenient() -> Settings:
    """Offline commands don't bind a port, so only mode/path settings matter."""
    import os
    s = Settings(mode=os.environ.get("CHECKLAH_MODE", "demo"),
                 data_dir=Path(os.environ.get("CHECKLAH_DATA_DIR", str(Settings().data_dir))))
    if os.environ.get("CHECKLAH_USERS_FILE"):
        s.users_file = Path(os.environ["CHECKLAH_USERS_FILE"])
    if s.mode not in ("demo", "live"):
        raise ConfigError("CHECKLAH_MODE must be 'demo' or 'live'")
    return s
