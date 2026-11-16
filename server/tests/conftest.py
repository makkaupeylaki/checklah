import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from checklah.connectors.base import registry  # noqa: E402
from checklah.connectors.demo import write_demo_file  # noqa: E402
from checklah.snapshot import SnapshotStore  # noqa: E402


def import_demo(mode_dir: Path, with_probes: bool = False):
    conns = registry()
    mode_dir.mkdir(parents=True, exist_ok=True)
    for cid in ("demo-watchlist", "demo-registry", "demo-webfeed"):
        f = write_demo_file(cid, mode_dir / f"{cid}.jsonl", with_probes=with_probes)
        up, rows = conns[cid].read(f)
        SnapshotStore(mode_dir, cid).build(rows, up)


@pytest.fixture
def demo_dir(tmp_path):
    d = tmp_path / "data"
    import_demo(d / "demo", with_probes=True)
    return d
