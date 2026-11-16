"""Optional local credentials, server-side sessions, CSRF tokens and rate limits.

Local protection only. A shared deployment should put individual allowlisted identities behind a
proper access service (see docs/architecture.md, Stage 3).
"""

from __future__ import annotations

import hashlib
import hmac
import json
import secrets
import threading
import time
from collections import defaultdict, deque
from dataclasses import dataclass
from pathlib import Path

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError

_ph = PasswordHasher()  # argon2id with library defaults
_DUMMY_HASH = _ph.hash(secrets.token_urlsafe(16))

USERNAME_MAX = 64
PASSWORD_MAX = 256


def hash_password(password: str) -> str:
    return _ph.hash(password)


def load_users(path: Path) -> dict[str, str]:
    data = json.loads(path.read_text())
    users = {}
    for u in data.get("users", []):
        if isinstance(u.get("username"), str) and isinstance(u.get("hash"), str) and u["hash"].startswith("$argon2"):
            users[u["username"]] = u["hash"]
    return users


def save_user(path: Path, username: str, password: str) -> None:
    data = {"users": []}
    if path.is_file():
        data = json.loads(path.read_text())
    data["users"] = [u for u in data.get("users", []) if u.get("username") != username]
    data["users"].append({"username": username, "hash": hash_password(password)})
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=1))
    tmp.chmod(0o600)
    tmp.replace(path)


@dataclass
class Session:
    user: str
    csrf: str
    created: float
    last_seen: float


def _h(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


class SessionStore:
    def __init__(self, idle_seconds: int, max_seconds: int):
        self.idle = idle_seconds
        self.max = max_seconds
        self._s: dict[str, Session] = {}
        self._lock = threading.Lock()

    def create(self, user: str) -> tuple[str, Session]:
        token = secrets.token_urlsafe(32)
        now = time.time()
        s = Session(user=user, csrf=secrets.token_urlsafe(32), created=now, last_seen=now)
        with self._lock:
            self._s[_h(token)] = s
        return token, s

    def get(self, token: str | None) -> Session | None:
        if not token or len(token) > 100:
            return None
        now = time.time()
        with self._lock:
            s = self._s.get(_h(token))
            if not s:
                return None
            if now - s.last_seen > self.idle or now - s.created > self.max:
                del self._s[_h(token)]
                return None
            s.last_seen = now
            return s

    def destroy(self, token: str | None) -> None:
        if token:
            with self._lock:
                self._s.pop(_h(token), None)


class Authenticator:
    def __init__(self, users_file: Path):
        self.users_file = users_file

    def verify(self, username: str, password: str) -> bool:
        if len(username) > USERNAME_MAX or len(password) > PASSWORD_MAX:
            _safe_verify(_DUMMY_HASH, password[:PASSWORD_MAX])
            return False
        users = load_users(self.users_file)  # re-read so add/remove takes effect without restart
        h = users.get(username)
        ok = _safe_verify(h or _DUMMY_HASH, password)
        return bool(h) and ok


def _safe_verify(h: str, password: str) -> bool:
    try:
        return _ph.verify(h, password)
    except (VerificationError, InvalidHashError):
        return False


class RateLimiter:
    """Sliding one-minute window per key."""

    def __init__(self, per_minute: int):
        self.per_minute = per_minute
        self._hits: dict[str, deque] = defaultdict(deque)
        self._lock = threading.Lock()

    def allow(self, key: str) -> bool:
        now = time.monotonic()
        with self._lock:
            q = self._hits[key]
            while q and now - q[0] > 60:
                q.popleft()
            if len(q) >= self.per_minute:
                return False
            q.append(now)
            if len(self._hits) > 10000:  # bound memory
                for k in [k for k, v in self._hits.items() if not v][:5000]:
                    del self._hits[k]
            return True


def tokens_equal(a: str | None, b: str | None) -> bool:
    return bool(a) and bool(b) and hmac.compare_digest(a, b)
