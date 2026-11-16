-- CheckLah D1 schema (Stage 2). Applied with `wrangler d1 migrations apply DB --local --env <demo|live>`.
-- Source data tables carry `gen` (generation). Account tables are never written by importers.

-- Mode stamp: written once by `cli.ts init --mode demo|live`. The Worker refuses to serve if it
-- differs from its MODE variable, so a live Worker can never fall back to a demo database.
CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;

-- ---------------------------------------------------------------- sources and generations
CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  active_gen INTEGER,
  previous_gen INTEGER,
  lock_token TEXT,
  lock_expires INTEGER,
  checked_at TEXT,          -- last time upstream was checked (even if unchanged)
  last_attempt_at TEXT,
  last_success_at TEXT,
  last_error TEXT,
  last_error_at TEXT
) WITHOUT ROWID;

CREATE TABLE generations (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('staging', 'active', 'previous', 'retired', 'failed')),
  import_key TEXT NOT NULL,
  upstream_version TEXT,
  upstream_export_at TEXT,
  upstream_checksum TEXT,
  created_at TEXT NOT NULL,
  imported_at TEXT,          -- when this generation finished importing and was activated
  retired_at INTEGER,        -- epoch ms; cleanup waits for a grace period after this
  cursor INTEGER NOT NULL DEFAULT 0,   -- records committed so far (resume point)
  rows INTEGER NOT NULL DEFAULT 0,
  names INTEGER NOT NULL DEFAULT 0,
  counts TEXT,               -- JSON: read/valid/selected/excluded/unsupported/rejected...
  scope TEXT,                -- JSON: selection rule applied (e.g. Singapore-linked subset)
  last_changed_at TEXT       -- when the content last differed from the previous generation
);
CREATE INDEX generations_source ON generations(source, state);
CREATE INDEX generations_key ON generations(source, import_key);

-- ---------------------------------------------------------------- source records
CREATE TABLE entities (
  gen INTEGER NOT NULL,
  id TEXT NOT NULL,
  kind TEXT NOT NULL,
  schema TEXT NOT NULL,
  caption TEXT NOT NULL,
  caption_fold TEXT NOT NULL,
  country_codes TEXT NOT NULL DEFAULT ',',  -- ",sg,my," for bounded candidate filtering
  topic_flags TEXT NOT NULL DEFAULT ',',    -- ",sanction,pep," (separate classes)
  countries TEXT, topics TEXT, datasets TEXT, identifiers TEXT, dates TEXT, links TEXT,
  properties TEXT, provenance TEXT, context TEXT,
  PRIMARY KEY (gen, id)
);

CREATE TABLE names (
  nid INTEGER PRIMARY KEY,      -- also the names_fts rowid
  gen INTEGER NOT NULL,
  entity_id TEXT NOT NULL,
  name TEXT NOT NULL,
  norm TEXT NOT NULL,
  type TEXT NOT NULL
);
CREATE INDEX names_norm ON names(gen, norm);
CREATE INDEX names_entity ON names(gen, entity_id);

-- FTS5 over normalized names. `g` holds "g<gen>" so the generation is enforced inside MATCH.
-- Regular (content-storing) table: rows are deleted by rowid during cleanup.
CREATE VIRTUAL TABLE names_fts USING fts5(norm, g, tokenize = 'unicode61 remove_diacritics 2');

CREATE TABLE identifiers (
  gen INTEGER NOT NULL,
  type TEXT NOT NULL,
  norm TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  scope TEXT
);
CREATE INDEX identifiers_lookup ON identifiers(type, norm, gen);
CREATE INDEX identifiers_gen ON identifiers(gen);

CREATE TABLE referents (
  gen INTEGER NOT NULL,
  old_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  PRIMARY KEY (gen, old_id)
) WITHOUT ROWID;

-- ---------------------------------------------------------------- accounts (never imported)
CREATE TABLE users (
  username TEXT PRIMARY KEY,
  pw_hash TEXT NOT NULL,         -- scrypt via @noble/hashes; never plaintext
  disabled INTEGER NOT NULL DEFAULT 0,
  session_epoch INTEGER NOT NULL DEFAULT 0,  -- bump to revoke every session of this user
  created_at TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,   -- SHA-256 of a 256-bit random token; the token is only in the cookie
  username TEXT NOT NULL,
  csrf TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX sessions_user ON sessions(username);
CREATE INDEX sessions_expiry ON sessions(expires_at);

CREATE TABLE rate_limits (
  bucket TEXT NOT NULL,          -- "login:<hash of client address>" / "search:<user or hash>"
  window INTEGER NOT NULL,       -- epoch minute
  count INTEGER NOT NULL,
  PRIMARY KEY (bucket, window)
) WITHOUT ROWID;
CREATE INDEX rate_limits_window ON rate_limits(window);
