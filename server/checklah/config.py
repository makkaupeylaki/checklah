"""Settings from CHECKLAH_* environment variables. Unsafe combinations refuse to start."""

from __future__ import annotations

import ipaddress
import os
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


class ConfigError(Exception):
    pass


def _is_loopback(host: str) -> bool:
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


@dataclass
class Settings:
    mode: str = "demo"
    data_dir: Path = ROOT / "data"
    static_dir: Path = ROOT / "web" / "dist"
    host: str = "127.0.0.1"
    port: int = 8765
    auth: str = "off"  # off | local
    users_file: Path | None = None
    cookie_secure: bool | None = None  # None -> secure unless loopback
    session_idle_minutes: int = 30
    session_max_hours: int = 12
    login_per_minute: int = 5
    search_per_minute: int = 30
    extra: dict = field(default_factory=dict)

    @property
    def mode_dir(self) -> Path:
        return self.data_dir / self.mode

    @property
    def secure_cookies(self) -> bool:
        if self.cookie_secure is not None:
            return self.cookie_secure
        return not _is_loopback(self.host)

    def validate(self) -> "Settings":
        if self.mode not in ("demo", "live"):
            raise ConfigError("CHECKLAH_MODE must be 'demo' or 'live'")
        if self.auth not in ("off", "local"):
            raise ConfigError("CHECKLAH_AUTH must be 'off' or 'local'")
        if self.auth == "off" and not _is_loopback(self.host):
            raise ConfigError("Refusing to bind a non-loopback address without authentication (set CHECKLAH_AUTH=local).")
        if self.auth == "local":
            uf = self.users_file or (self.data_dir / "users.json")
            if not uf.is_file():
                raise ConfigError(f"CHECKLAH_AUTH=local needs a users file ({uf}); create one with `python -m checklah add-user`.")
            self.users_file = uf
            if self.cookie_secure is False and not _is_loopback(self.host):
                raise ConfigError("Insecure cookies are only allowed on a loopback bind.")
        return self

    @classmethod
    def from_env(cls) -> "Settings":
        e = os.environ.get
        s = cls(
            mode=e("CHECKLAH_MODE", "demo"),
            data_dir=Path(e("CHECKLAH_DATA_DIR", str(ROOT / "data"))),
            static_dir=Path(e("CHECKLAH_STATIC_DIR", str(ROOT / "web" / "dist"))),
            host=e("CHECKLAH_HOST", "127.0.0.1"),
            port=int(e("CHECKLAH_PORT", "8765")),
            auth=e("CHECKLAH_AUTH", "off"),
            users_file=Path(e("CHECKLAH_USERS_FILE")) if e("CHECKLAH_USERS_FILE") else None,
            cookie_secure={"1": True, "0": False}.get(e("CHECKLAH_COOKIE_SECURE", ""), None),
            session_idle_minutes=int(e("CHECKLAH_SESSION_IDLE_MINUTES", "30")),
            session_max_hours=int(e("CHECKLAH_SESSION_MAX_HOURS", "12")),
            login_per_minute=int(e("CHECKLAH_LOGIN_PER_MINUTE", "5")),
            search_per_minute=int(e("CHECKLAH_SEARCH_PER_MINUTE", "30")),
        )
        return s.validate()
