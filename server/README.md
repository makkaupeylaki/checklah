# Retired: Stage 1 Python server

This FastAPI + SQLite implementation was CheckLah's Stage 1 local server. Stage 2 replaced it with the
Cloudflare Worker + D1 app in `../worker/`. It is kept, with its 49 tests, as a reference until the
owner decides to delete it. It is **not** the primary app: no `make` target starts it
(`make legacy-test` only runs its tests).

Its behaviour was ported to `worker/` (see `docs/stage2-status.md`, "Test mapping").
