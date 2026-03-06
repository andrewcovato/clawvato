-- Clawvato Database Schema
-- SQLite with WAL mode, FTS5, and sqlite-vec extensions

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Core memory store with triple-factor scoring + bi-temporal tracking
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('fact','preference','decision','observation','reflection')),
  content TEXT NOT NULL,
  source TEXT NOT NULL,

  -- Triple-factor scoring
  importance INTEGER NOT NULL DEFAULT 5 CHECK(importance BETWEEN 1 AND 10),
  confidence REAL NOT NULL DEFAULT 0.5 CHECK(confidence BETWEEN 0 AND 1),

  -- Bi-temporal tracking
  valid_from TEXT NOT NULL DEFAULT (datetime('now')),
  valid_until TEXT,

  -- Access tracking (for recency factor)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_accessed_at TEXT,
  access_count INTEGER NOT NULL DEFAULT 0,

  -- Entity references (JSON array of entity names/IDs)
  entities TEXT DEFAULT '[]',

  -- Consolidation tracking
  superseded_by TEXT REFERENCES memories(id),
  reflection_source INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
CREATE INDEX IF NOT EXISTS idx_memories_valid ON memories(valid_until);
CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance DESC);
CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at DESC);

-- FTS5 index for keyword search
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content,
  content='memories',
  content_rowid='rowid'
);

-- Triggers to keep FTS5 in sync
CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.rowid, old.content);
END;

CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.rowid, old.content);
  INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
END;

-- People (structured, not embedded)
CREATE TABLE IF NOT EXISTS people (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  slack_id TEXT,
  github_username TEXT,
  relationship TEXT CHECK(relationship IN ('colleague','client','vendor','friend','unknown')),
  organization TEXT,
  role TEXT,
  timezone TEXT,
  notes TEXT,
  communication_preferences TEXT,
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_interaction_at TEXT,
  interaction_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_people_name ON people(name);
CREATE INDEX IF NOT EXISTS idx_people_email ON people(email);
CREATE INDEX IF NOT EXISTS idx_people_slack ON people(slack_id);

-- Immutable action audit trail
CREATE TABLE IF NOT EXISTS actions (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('planned','pending_confirmation','confirmed','executing','completed','failed','rejected','undone')),
  trust_level INTEGER NOT NULL,
  request_source TEXT NOT NULL,
  request_context TEXT,
  planned_action TEXT NOT NULL,
  actual_result TEXT,
  confirmed_by_user INTEGER NOT NULL DEFAULT 0,
  undo_available_until TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  confirmed_at TEXT,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_actions_type ON actions(type);
CREATE INDEX IF NOT EXISTS idx_actions_status ON actions(status);
CREATE INDEX IF NOT EXISTS idx_actions_created ON actions(created_at DESC);

-- Training wheels pattern tracking
CREATE TABLE IF NOT EXISTS action_patterns (
  id TEXT PRIMARY KEY,
  pattern_hash TEXT NOT NULL UNIQUE,
  action_type TEXT NOT NULL,
  description TEXT NOT NULL,
  total_occurrences INTEGER NOT NULL DEFAULT 0,
  total_approvals INTEGER NOT NULL DEFAULT 0,
  total_rejections INTEGER NOT NULL DEFAULT 0,
  total_modifications INTEGER NOT NULL DEFAULT 0,
  current_trust_level INTEGER NOT NULL DEFAULT 0,
  last_occurred_at TEXT,
  graduated_at TEXT,
  non_graduatable INTEGER NOT NULL DEFAULT 0
);

-- Durable workflow state machine
CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','waiting_reply','waiting_confirmation','completed','cancelled','failed')),
  state TEXT NOT NULL,
  current_step INTEGER NOT NULL DEFAULT 0,
  total_steps INTEGER,
  slack_channel TEXT,
  slack_thread_ts TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT,
  last_checkpoint TEXT
);

CREATE INDEX IF NOT EXISTS idx_workflows_status ON workflows(status);
CREATE INDEX IF NOT EXISTS idx_workflows_type ON workflows(type);

-- Consolidation run tracking
CREATE TABLE IF NOT EXISTS consolidation_runs (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  memories_processed INTEGER,
  memories_merged INTEGER,
  memories_superseded INTEGER,
  memories_archived INTEGER,
  observations_promoted INTEGER,
  reflections_generated INTEGER
);

-- MCP plugin registry
CREATE TABLE IF NOT EXISTS plugins (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  command TEXT NOT NULL,
  permission TEXT NOT NULL CHECK(permission IN ('read_only','read_write','admin')),
  tool_manifest TEXT NOT NULL DEFAULT '[]',
  rate_limits TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  approved_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Schema version tracking
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO schema_version (version) VALUES (1);
