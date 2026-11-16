import logging
import re
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from checklah.app import create_app
from checklah.auth import save_user
from checklah.config import ConfigError, Settings

ROOT = Path(__file__).resolve().parents[2]
SEARCH = {"q": "Orlo Vantrell", "mode": "name"}


def make(demo_dir, auth="off", **kw):
    s = Settings(mode="demo", data_dir=demo_dir, static_dir=ROOT / "web" / "dist", auth=auth, **kw)
    if auth == "local":
        save_user(demo_dir / "users.json", "alice", "correct horse battery")
    s.validate()
    return TestClient(create_app(s), base_url="https://testserver")


def csrf(c):
    return c.get("/api/session").json()["csrf"]


def login(c, password="correct horse battery"):
    token = csrf(c)
    return c.post("/api/login", json={"username": "alice", "password": password}, headers={"X-CheckLah-CSRF": token})


# ---------------------------------------------------------------- auth
def test_unauthenticated_requests_fail(demo_dir):
    c = make(demo_dir, auth="local")
    assert c.get("/api/sources").status_code == 401
    assert c.get("/api/record/demo-watchlist:DEMO-P-0001").status_code == 401
    assert c.post("/api/search", json=SEARCH, headers={"X-CheckLah-CSRF": csrf(c)}).status_code == 401
    assert c.get("/api/session").json()["authenticated"] is False


def test_login_logout_and_session_flow(demo_dir):
    c = make(demo_dir, auth="local", cookie_secure=True)
    assert login(c, "wrong").status_code == 401
    r = login(c)
    assert r.status_code == 200
    cookie = r.headers["set-cookie"]
    assert "HttpOnly" in cookie and "SameSite=strict" in cookie and "Secure" in cookie
    tok = r.json()["csrf"]
    assert c.post("/api/search", json=SEARCH, headers={"X-CheckLah-CSRF": tok}).status_code == 200
    assert c.get("/api/record/demo-watchlist:DEMO-P-0001").status_code == 200
    assert c.post("/api/logout", json={}, headers={"X-CheckLah-CSRF": tok}).status_code == 200
    assert c.get("/api/sources").status_code == 401


def test_session_expiry(demo_dir):
    c = make(demo_dir, auth="local")
    login(c)
    sessions = c.app.state.sessions
    for s in sessions._s.values():
        s.last_seen -= 31 * 60
    assert c.get("/api/sources").status_code == 401


def test_login_rate_limited(demo_dir):
    c = make(demo_dir, auth="local")
    codes = [login(c, "wrong").status_code for _ in range(6)]
    assert codes[:5] == [401] * 5 and codes[5] == 429


def test_search_rate_limited(demo_dir):
    c = make(demo_dir, search_per_minute=3)
    h = {"X-CheckLah-CSRF": csrf(c)}
    codes = [c.post("/api/search", json=SEARCH, headers=h).status_code for _ in range(4)]
    assert codes == [200, 200, 200, 429]


def test_csrf_and_origin(demo_dir):
    c = make(demo_dir, auth="local")
    tok = login(c).json()["csrf"]
    assert c.post("/api/search", json=SEARCH).status_code == 403
    assert c.post("/api/search", json=SEARCH, headers={"X-CheckLah-CSRF": "nope"}).status_code == 403
    assert c.post("/api/search", json=SEARCH, headers={"X-CheckLah-CSRF": tok, "Origin": "https://evil.example"}).status_code == 403
    assert c.post("/api/search", json=SEARCH, headers={"X-CheckLah-CSRF": tok, "Sec-Fetch-Site": "cross-site"}).status_code == 403
    # login also needs the pre-session token
    c2 = make(demo_dir, auth="local")
    assert c2.post("/api/login", json={"username": "alice", "password": "correct horse battery"}).status_code == 403


def test_auth_off_still_requires_csrf(demo_dir):
    c = make(demo_dir)
    assert c.post("/api/search", json=SEARCH).status_code == 403
    assert c.post("/api/search", json=SEARCH, headers={"X-CheckLah-CSRF": csrf(c)}).status_code == 200


def test_config_refusals(tmp_path):
    with pytest.raises(ConfigError, match="non-loopback"):
        Settings(host="0.0.0.0", auth="off").validate()
    with pytest.raises(ConfigError, match="users file"):
        Settings(auth="local", data_dir=tmp_path).validate()
    with pytest.raises(ConfigError):
        Settings(mode="both").validate()
    assert Settings(host="127.0.0.1").validate().secure_cookies is False
    assert Settings(host="::1").validate()
    (tmp_path / "users.json").write_text('{"users": []}')
    remote = Settings(host="10.0.0.5", auth="local", data_dir=tmp_path).validate()
    assert remote.secure_cookies is True
    with pytest.raises(ConfigError, match="Insecure"):
        Settings(host="10.0.0.5", auth="local", data_dir=tmp_path, cookie_secure=False).validate()


# ---------------------------------------------------------------- privacy
def test_no_query_strings_and_no_store(demo_dir):
    c = make(demo_dir)
    assert c.get("/api/sources?q=Orlo").status_code == 400
    r = c.get("/api/sources")
    assert r.headers["cache-control"] == "no-store"
    for h in ("content-security-policy", "x-content-type-options", "x-frame-options", "referrer-policy",
              "cross-origin-opener-policy", "permissions-policy", "x-robots-tag"):
        assert h in r.headers
    assert "script-src 'self'" in r.headers["content-security-policy"]
    assert "unsafe-inline" not in r.headers["content-security-policy"]
    assert c.get("/robots.txt").text.strip().endswith("Disallow: /")


def test_no_export_or_docs_endpoints(demo_dir):
    c = make(demo_dir)
    for p in ("/api/export", "/api/export.csv", "/api/dump", "/docs", "/openapi.json", "/api/records"):
        assert c.get(p).status_code == 404, p
    assert c.put("/api/search", json=SEARCH).status_code == 405
    assert c.delete("/api/record/x").status_code == 405


def test_logs_do_not_contain_search_terms_or_ids(demo_dir, caplog):
    c = make(demo_dir)
    h = {"X-CheckLah-CSRF": csrf(c)}
    with caplog.at_level(logging.DEBUG):
        c.post("/api/search", json={"q": "Severin Aldaq 1959-01-01 S1234567D"}, headers=h)
        c.post("/api/search", json={"q": "x" * 500}, headers=h)
        c.get("/api/record/demo-watchlist:DEMO-P-0001")
    # Server-side loggers only (the test client's own httpx logger prints the URL it requested).
    text = "\n".join(r.getMessage() for r in caplog.records if not r.name.startswith(("httpx", "asyncio")))
    assert "POST /api/search 200" in text and "GET /api/record/{record_id} 200" in text
    for leak in ("Severin", "Aldaq", "1959", "S1234567D", "DEMO-P-0001", "xxxxx"):
        assert leak not in text


def test_validation_errors_do_not_echo_input(demo_dir):
    c = make(demo_dir)
    r = c.post("/api/search", json={"q": "SECRETNAME" * 30}, headers={"X-CheckLah-CSRF": csrf(c)})
    assert r.status_code == 422 and "SECRETNAME" not in r.text
    r = c.post("/api/search", json={"q": "a", "country": "sg'--"}, headers={"X-CheckLah-CSRF": csrf(c)})
    assert r.status_code == 422


def test_static_path_traversal_and_no_data_in_public_assets(demo_dir):
    c = make(demo_dir)
    for p in ("/../server/checklah/app.py", "/..%2f..%2fetc/passwd", "/fonts/../../server/checklah/app.py"):
        assert c.get(p).status_code == 404, p
    dist = ROOT / "web" / "dist"
    if not dist.exists():
        pytest.skip("frontend not built")
    blob = "".join(p.read_text(errors="ignore") for p in dist.rglob("*") if p.is_file() and p.suffix in (".js", ".css", ".html"))
    for needle in ("Vantrell", "T99DM", "Strelvaq", "login-verify", "DEMO-P-"):
        assert needle not in blob
    assert not list(dist.rglob("sw.js")) and "serviceWorker" not in blob
    assert "innerHTML" not in blob  # DOM is built with textContent


def test_api_never_returns_raw_records(demo_dir):
    c = make(demo_dir)
    r = c.get("/api/record/demo-watchlist:DEMO-P-0001").json()
    assert "raw" not in r and "DEMO-PX-0001" not in str(r)
