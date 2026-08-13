CREATE TABLE IF NOT EXISTS submissions (
  token             UUID PRIMARY KEY,
  language_id       INTEGER NOT NULL,
  source_code       TEXT,
  stdin             TEXT,
  expected_output   TEXT,

  -- Batch-judging path: testcases resolved judge-side by (problem, version).
  problem_id        TEXT,
  testcase_version  INTEGER,
  testcase_index    INTEGER,
  submission_group  UUID,

  cpu_time_limit    NUMERIC,
  wall_time_limit   NUMERIC,
  memory_limit      INTEGER,
  stack_limit       INTEGER,
  max_processes     INTEGER,
  max_file_size     INTEGER,

  callback_url      TEXT,
  compile_key       TEXT,

  status_id         INTEGER NOT NULL DEFAULT 1,
  stdout            TEXT,
  stderr            TEXT,
  compile_output    TEXT,
  message           TEXT,
  exit_code         INTEGER,
  exit_signal       INTEGER,
  time              NUMERIC,
  wall_time         NUMERIC,
  memory            INTEGER,

  -- Non-C++ submissions forwarded to a real Judge0 instance.
  is_proxied        BOOLEAN NOT NULL DEFAULT FALSE,
  upstream_token    TEXT,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_submissions_group
  ON submissions (submission_group, testcase_index);
CREATE INDEX IF NOT EXISTS idx_submissions_compile_key
  ON submissions (compile_key);
CREATE INDEX IF NOT EXISTS idx_submissions_created_at
  ON submissions (created_at DESC);

-- Testcase sets materialized on this worker host's local disk.
CREATE TABLE IF NOT EXISTS testcase_sets (
  problem_id       TEXT NOT NULL,
  version          INTEGER NOT NULL,
  node_id          TEXT NOT NULL DEFAULT '',
  case_count       INTEGER NOT NULL,
  total_bytes      BIGINT NOT NULL DEFAULT 0,
  manifest_sha256  TEXT NOT NULL,
  materialized_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (problem_id, version, node_id)
);

-- Compiled binaries, keyed by sha256(source, language_id, flags).
CREATE TABLE IF NOT EXISTS compile_cache (
  compile_key      TEXT NOT NULL,
  node_id          TEXT NOT NULL DEFAULT '',
  language_id      INTEGER NOT NULL,
  binary_path      TEXT,
  size_bytes       BIGINT NOT NULL DEFAULT 0,
  success          BOOLEAN NOT NULL,
  compile_output   TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  hit_count        BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (compile_key, node_id)
);

CREATE INDEX IF NOT EXISTS idx_compile_cache_lru
  ON compile_cache (node_id, last_used_at ASC);
