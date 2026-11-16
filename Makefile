PY ?= .venv/bin/python

.PHONY: setup demo build serve test ui shots check bench

setup:            ## create venv + install deps
	python3 -m venv .venv && .venv/bin/pip install -r server/requirements.txt
	cd web && npm ci

demo:             ## (re)import the fictional demo sources
	cd server && ../$(PY) -m checklah import all

build:            ## build the frontend into web/dist
	cd web && npm run build

serve:            ## serve on http://127.0.0.1:8765 (demo mode, no auth, loopback only)
	cd server && ../$(PY) -m checklah serve

test:             ## backend unit/import/security tests
	cd server && ../$(PY) -m pytest -q -W ignore::DeprecationWarning tests

ui: build         ## browser UI tests (starts its own servers)
	cd web && node tests/ui.cjs

shots: build      ## screenshots at 320/390/768/1280, both themes (needs `make serve` running)
	cd web && node tests/shots.cjs

check: test ui    ## everything automated in docs/security-qa.md

bench:            ## synthetic benchmark
	cd server && ../$(PY) -m checklah bench --rows 1000000
