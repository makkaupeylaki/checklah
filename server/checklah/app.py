"""FastAPI application: same-origin JSON API + the built frontend."""

from __future__ import annotations

import logging
import secrets
import time
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, Response
from pydantic import BaseModel, Field
from starlette.exceptions import HTTPException as StarletteHTTPException

from .auth import Authenticator, RateLimiter, SessionStore, tokens_equal
from .config import Settings
from .normalize import MAX_QUERY_LEN
from .search import Query, SearchService

log = logging.getLogger("checklah")

SESSION_COOKIE = "checklah_session"
PRE_COOKIE = "checklah_pre"
CSRF_HEADER = "x-checklah-csrf"

CSP = ("default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; "
       "connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; "
       "object-src 'none'")
SECURITY_HEADERS = {
    "Content-Security-Policy": CSP,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
}
PUBLIC_API = {"/api/session", "/api/login"}


class SearchBody(BaseModel):
    q: str = Field(max_length=MAX_QUERY_LEN)
    mode: Literal["name", "identifier"] = "name"
    category: Literal["all", "person", "company", "website", "record"] = "all"
    country: str = Field(default="", pattern=r"^([a-z]{2})?$")
    topic: Literal["any", "sanction", "pep"] = "any"
    page: int = Field(default=1, ge=1, le=50)


class LoginBody(BaseModel):
    username: str = Field(max_length=64)
    password: str = Field(max_length=256)


def create_app(settings: Settings) -> FastAPI:
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    svc = SearchService(settings.mode_dir, settings.mode)
    sessions = SessionStore(settings.session_idle_minutes * 60, settings.session_max_hours * 3600)
    authn = Authenticator(settings.users_file) if settings.auth == "local" else None
    login_limit = RateLimiter(settings.login_per_minute)
    search_limit = RateLimiter(settings.search_per_minute)
    process_csrf = secrets.token_urlsafe(32)  # auth off: one token per server process
    app.state.svc, app.state.sessions, app.state.settings = svc, sessions, settings

    def cookie(resp: Response, name: str, value: str, max_age: int | None) -> None:
        resp.set_cookie(name, value, max_age=max_age, httponly=True, samesite="strict",
                        secure=settings.secure_cookies, path="/")

    def current_session(request: Request):
        return sessions.get(request.cookies.get(SESSION_COOKIE)) if authn else None

    # ---------------------------------------------------------------- middleware
    @app.middleware("http")
    async def guard(request: Request, call_next):
        start = time.monotonic()
        path = request.url.path
        resp: Response | None = None
        if request.url.query and path.startswith("/api/"):
            resp = JSONResponse({"error": "Query strings are not accepted."}, status_code=400)
        elif request.method not in ("GET", "HEAD", "POST"):
            resp = JSONResponse({"error": "Method not allowed."}, status_code=405)
        elif request.method == "POST":
            origin = request.headers.get("origin")
            host = request.headers.get("host", "")
            site = request.headers.get("sec-fetch-site")
            if (origin and origin.split("://", 1)[-1] != host) or (site and site not in ("same-origin", "none")):
                resp = JSONResponse({"error": "Cross-origin request refused."}, status_code=403)
            else:
                sent = request.headers.get(CSRF_HEADER)
                if authn is None:
                    expected = process_csrf
                elif path == "/api/login":
                    expected = request.cookies.get(PRE_COOKIE)
                else:
                    s = current_session(request)
                    expected = s.csrf if s else None
                    if not s:
                        resp = JSONResponse({"error": "Sign in required."}, status_code=401)
                if resp is None and not tokens_equal(sent, expected):
                    resp = JSONResponse({"error": "Missing or invalid CSRF token."}, status_code=403)
        if resp is None and authn and path.startswith("/api/") and path not in PUBLIC_API:
            if not current_session(request):
                resp = JSONResponse({"error": "Sign in required."}, status_code=401)
        if resp is None:
            resp = await call_next(request)
        for k, v in SECURITY_HEADERS.items():
            resp.headers.setdefault(k, v)
        if path.startswith("/api/") or path in ("/", "/index.html"):
            resp.headers["Cache-Control"] = "no-store"
        # Quiet access log: method, route template (never IDs, bodies or query strings), status, time.
        route = request.scope.get("route")
        template = getattr(route, "path", None) or ("/assets/*" if path.startswith("/assets/") else "(other)")
        log.info("%s %s %s %.0fms", request.method, template, resp.status_code, (time.monotonic() - start) * 1000)
        return resp

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, exc: RequestValidationError):
        # Never echo submitted values (FastAPI's default includes them).
        fields = sorted({".".join(str(p) for p in e.get("loc", [])[1:]) for e in exc.errors()})
        return JSONResponse({"error": "Invalid request.", "fields": fields}, status_code=422)

    @app.exception_handler(StarletteHTTPException)
    async def http_error(request: Request, exc: StarletteHTTPException):
        return JSONResponse({"error": "Not found." if exc.status_code == 404 else "Request failed."},
                            status_code=exc.status_code)

    @app.exception_handler(Exception)
    async def server_error(request: Request, exc: Exception):
        log.error("unhandled %s", type(exc).__name__)  # no message: it may contain user input
        return JSONResponse({"error": "Internal error."}, status_code=500)

    # ---------------------------------------------------------------- API
    @app.get("/api/session")
    def session_info(request: Request):
        body = {"mode": settings.mode, "auth": settings.auth}
        if not authn:
            return {**body, "authenticated": True, "user": None, "csrf": process_csrf}
        s = current_session(request)
        if s:
            return {**body, "authenticated": True, "user": s.user, "csrf": s.csrf}
        pre = secrets.token_urlsafe(32)
        resp = JSONResponse({**body, "authenticated": False, "user": None, "csrf": pre})
        cookie(resp, PRE_COOKIE, pre, 900)
        return resp

    @app.post("/api/login")
    def login(request: Request, body: LoginBody):
        if not authn:
            return JSONResponse({"error": "Authentication is not enabled."}, status_code=400)
        ip = request.client.host if request.client else "?"
        if not login_limit.allow(ip):
            return JSONResponse({"error": "Too many sign-in attempts. Wait a minute."}, status_code=429)
        if not authn.verify(body.username, body.password):
            return JSONResponse({"error": "Wrong username or password."}, status_code=401)
        sessions.destroy(request.cookies.get(SESSION_COOKIE))
        token, s = sessions.create(body.username)
        resp = JSONResponse({"mode": settings.mode, "auth": settings.auth, "authenticated": True,
                             "user": s.user, "csrf": s.csrf})
        cookie(resp, SESSION_COOKIE, token, settings.session_max_hours * 3600)
        resp.delete_cookie(PRE_COOKIE, path="/")
        return resp

    @app.post("/api/logout")
    def logout(request: Request):
        sessions.destroy(request.cookies.get(SESSION_COOKIE))
        resp = JSONResponse({"ok": True})
        resp.delete_cookie(SESSION_COOKIE, path="/")
        return resp

    @app.post("/api/search")
    def search(request: Request, body: SearchBody):
        s = current_session(request)
        key = f"u:{s.user}" if s else f"ip:{request.client.host if request.client else '?'}"
        if not search_limit.allow(key):
            return JSONResponse({"error": "Too many searches. Wait a minute."}, status_code=429)
        return svc.search(Query(text=body.q, mode=body.mode, category=body.category, country=body.country,
                                topic=body.topic, page=body.page))

    @app.get("/api/record/{record_id}")
    def record(record_id: str):
        r = svc.record(record_id)
        if not r:
            return JSONResponse({"error": "Record not found in the current snapshot. It may have been removed "
                                          "by the source in the latest import."}, status_code=404)
        return r

    @app.get("/api/sources")
    def sources():
        return svc.sources()

    # ---------------------------------------------------------------- static frontend
    static = settings.static_dir.resolve()

    @app.get("/robots.txt")
    def robots():
        return PlainTextResponse("User-agent: *\nDisallow: /\n")

    @app.get("/{path:path}")
    def frontend(path: str):
        if path.startswith("api/"):
            return JSONResponse({"error": "Not found."}, status_code=404)
        if path in ("", "index.html"):
            target = static / "index.html"
        else:
            target = (static / path).resolve()
            if static not in target.parents or not target.is_file():
                return JSONResponse({"error": "Not found."}, status_code=404)
        if not target.is_file():
            return PlainTextResponse("Frontend not built. Run `npm run build` in web/.", status_code=503)
        headers = {"Cache-Control": "public, max-age=31536000, immutable"} if path.startswith("assets/") else {}
        return FileResponse(target, headers=headers)

    return app


def configure_logging() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
