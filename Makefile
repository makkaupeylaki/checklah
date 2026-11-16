# CheckLah — Stage 2 (Cloudflare Workers + D1, run locally with wrangler; no credentials needed).
# Nothing here deploys or touches a remote database. The Stage 1 Python server in server/ is
# retired: it is only used by `make legacy-test`.

.PHONY: setup build demo serve serve-live test ui shots bench check legacy-test

setup:            ## install pinned dependencies (lockfiles)
	cd worker && npm ci
	cd web && npm ci

build:            ## build the frontend into web/dist (served by the Worker as static assets)
	cd web && npm run build

demo:             ## create the local demo D1 database and import the fictional demo sources
	cd worker && node tools/cli.ts init --env demo && node tools/cli.ts import demo --env demo

serve: build      ## demo app on http://127.0.0.1:8787 (wrangler dev, loopback only)
	cd worker && npx wrangler dev --env demo --ip 127.0.0.1 --port 8787 --persist-to ../.wrangler-state/demo

serve-live: build ## live-mode app on http://127.0.0.1:8788 (empty until you import local source files)
	cd worker && npx wrangler dev --env live --ip 127.0.0.1 --port 8788 --persist-to ../.wrangler-state/live

test:             ## Worker/D1 tests (unit, D1 spike, search, lifecycle, ACRA, OpenSanctions, API/security)
	cd worker && npx tsc -p tsconfig.json && npm test

ui: build         ## browser UI tests against real `wrangler dev` runtimes
	cd web && node tests/ui.cjs

shots: build      ## screenshots at 320/390/768/1280, both themes (needs `make serve` running)
	cd web && node tests/shots.cjs http://127.0.0.1:8787

bench:            ## local synthetic benchmark (default 2,133,906 rows, 2 generations; ~2 h on 4 vCPU)
	cd worker && node tools/bench.ts

legacy-test:      ## Stage 1 Python tests (retired reference implementation)
	cd server && ../.venv/bin/python -m pytest -q -W ignore::DeprecationWarning tests

check: test ui legacy-test
