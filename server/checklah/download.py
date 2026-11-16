"""Bounded downloader for official bulk files. Never used with user input.

- https only, host must be on the connector's allowlist, checked on every redirect hop
- size and wall-clock limits; partial files are deleted
"""

from __future__ import annotations

import time
from pathlib import Path
from urllib.parse import urljoin, urlsplit

import httpx


class DownloadError(Exception):
    pass


def _check(url: str, allowed_hosts: tuple[str, ...]) -> None:
    p = urlsplit(url)
    if p.scheme != "https":
        raise DownloadError("only https downloads are allowed")
    if (p.hostname or "").lower() not in allowed_hosts:
        raise DownloadError(f"host not allowlisted: {p.hostname}")
    if p.username or p.password or (p.port not in (None, 443)):
        raise DownloadError("credentials/ports in download URL are not allowed")


def download(url: str, dest: Path, allowed_hosts: tuple[str, ...], *, max_bytes: int, timeout_s: float,
             max_redirects: int = 5, client: httpx.Client | None = None) -> Path:
    own = client is None
    client = client or httpx.Client(timeout=httpx.Timeout(30.0), follow_redirects=False)
    tmp = dest.with_name(dest.name + ".part")
    deadline = time.monotonic() + timeout_s
    try:
        for _ in range(max_redirects + 1):
            _check(url, allowed_hosts)
            with client.stream("GET", url, headers={"User-Agent": "checklah-importer/0.1"}) as r:
                if r.status_code in (301, 302, 303, 307, 308):
                    loc = r.headers.get("location")
                    if not loc:
                        raise DownloadError("redirect without location")
                    url = urljoin(url, loc)
                    continue
                if r.status_code != 200:
                    raise DownloadError(f"HTTP {r.status_code}")
                declared = r.headers.get("content-length")
                if declared and declared.isdigit() and int(declared) > max_bytes:
                    raise DownloadError("declared size exceeds limit")
                size = 0
                with open(tmp, "wb") as f:
                    for chunk in r.iter_bytes(1 << 16):
                        size += len(chunk)
                        if size > max_bytes:
                            raise DownloadError("size limit exceeded")
                        if time.monotonic() > deadline:
                            raise DownloadError("time limit exceeded")
                        f.write(chunk)
                if declared and declared.isdigit() and size != int(declared):
                    raise DownloadError("interrupted download (size mismatch)")
                tmp.replace(dest)
                return dest
        raise DownloadError("too many redirects")
    except httpx.HTTPError as e:
        raise DownloadError(f"transfer failed: {type(e).__name__}") from e
    finally:
        tmp.unlink(missing_ok=True)
        if own:
            client.close()
