-- Clawvato Database Schema — PostgreSQL
-- Requires: pgvector extension for vector search

CREATE EXTENSION IF NOT EXISTS vector;

-- Core memory store with triple-factor scoring + bi-temporal tracking
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,  -- dynamic categories stored in memory_categories table
  content TEXT NOT NULL,
  source TEXT NOT NULL,

  -- Triple-factor scoring
  importance INTEGER NOT NULL DEFAULT 5 CHECK(importance BETWEEN 1 AND 10),
  confidence DOUBLE PRECISION NOT NULL DEFAULT 0.5 CHECK(confidence BETWEEN 0 AND 1),

  -- Bi-temporal tracking
  valid_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  valid_until TIMESTAMPTZ,

  -- Access tracking (for recency factor)
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_accessed_at TIMESTAMPTZ,
  access_count INTEGER NOT NULL DEFAULT 0,

  -- Entity references (JSON array of entity names/IDs)
  entities TEXT DEFAULT '[]',

  -- Surface isolation (local = dev, cloud = Slack agent, global = shared)
  surface_id TEXT NOT NULL DEFAULT 'global',

  -- Consolidation tracking
  superseded_by TEXT REFERENCES memories(id),
  reflection_source INTEGER DEFAULT 0,

  -- Full-text search: auto-maintained tsvector column
  content_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,

  -- Vector embedding for semantic search (384-dim, all-MiniLM-L6-v2)
  embedding vector(384)
);

CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
CREATE INDEX IF NOT EXISTS idx_memories_valid ON memories(valid_until);
CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance DESC);
CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memories_type_valid ON memories(type, valid_until);

CREATE INDEX IF NOT EXISTS idx_memories_surface ON memories(surface_id);
CREATE INDEX IF NOT EXISTS idx_memories_surface_valid ON memories(surface_id, valid_until);

-- GIN index for full-text search
CREATE INDEX IF NOT EXISTS idx_memories_fts ON memories USING GIN(content_tsv);

-- IVFFlat index for vector search (cosine distance)
-- Note: IVFFlat requires data to exist before creating with lists > 0.
-- We create with a small lists value; for production with >10K rows, rebuild with more lists.
-- Using HNSW instead — works on empty tables and has better recall.
CREATE INDEX IF NOT EXISTS idx_memories_embedding ON memories USING hnsw(embedding vector_cosine_ops);

-- Dynamic category registry — seeded at startup, grows organically
CREATE TABLE IF NOT EXISTS memory_categories (
  name TEXT PRIMARY KEY,
  description TEXT,
  count INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'seed' CHECK(source IN ('seed','discovered')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Entity junction table — replaces JSON LIKE scan on memories.entities
CREATE TABLE IF NOT EXISTS memory_entities (
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  entity TEXT NOT NULL,
  PRIMARY KEY (memory_id, entity)
);
CREATE INDEX IF NOT EXISTS idx_memory_entities_entity ON memory_entities(LOWER(entity));

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
  undo_available_until TIMESTAMPTZ,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  confirmed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
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
  last_occurred_at TIMESTAMPTZ,
  graduated_at TIMESTAMPTZ,
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
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  last_checkpoint TEXT
);

CREATE INDEX IF NOT EXISTS idx_workflows_status ON workflows(status);
CREATE INDEX IF NOT EXISTS idx_workflows_type ON workflows(type);

-- Consolidation run tracking
CREATE TABLE IF NOT EXISTS consolidation_runs (
  id TEXT PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
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
  approved_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Document registry for knowledge sync (Drive, local files, etc.)
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL CHECK(source_type IN ('gdrive', 'local', 'slack_canvas')),
  source_id TEXT NOT NULL,
  name TEXT NOT NULL,
  mime_type TEXT,
  folder_path TEXT,
  owner TEXT,
  modified_time TEXT,
  content_hash TEXT,
  summary TEXT,
  last_synced_at TIMESTAMPTZ,
  deep_read_at TIMESTAMPTZ,
  entities TEXT DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'removed', 'error')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_documents_source ON documents(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status);
CREATE INDEX IF NOT EXISTS idx_documents_name ON documents(name);

-- General-purpose agent state (replaces sentinel rows in other tables)
CREATE TABLE IF NOT EXISTS agent_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'sleeping')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Autonomous task queue — general-purpose scheduler for proactive work
CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,

  -- Status & priority
  status TEXT NOT NULL DEFAULT 'active'
    CHECK(status IN ('active','paused','running','completed','failed','cancelled','pending_approval')),
  priority INTEGER NOT NULL DEFAULT 5 CHECK(priority BETWEEN 1 AND 10),

  -- Timing
  due_at TIMESTAMPTZ,
  next_run_at TIMESTAMPTZ,
  last_run_at TIMESTAMPTZ,
  cron_expression TEXT,

  -- Provenance
  created_by_type TEXT NOT NULL DEFAULT 'owner'
    CHECK(created_by_type IN ('owner','agent','user','system','external')),
  created_by_id TEXT,
  spawned_by_task BOOLEAN NOT NULL DEFAULT false,

  -- 3P integration
  external_id TEXT,
  external_source TEXT,
  labels TEXT DEFAULT '[]',

  -- Execution tracking
  run_count INTEGER NOT NULL DEFAULT 0,
  last_result TEXT,
  last_error TEXT,

  -- Pinned message in task channel
  pin_message_ts TEXT,
  pin_detail_ts TEXT,
  pin_summary TEXT,

  -- Approval (for agent-created tasks needing owner sign-off)
  approved_at TIMESTAMPTZ,
  approval_slack_ts TEXT,
  approval_channel TEXT,
  reminder_sent BOOLEAN NOT NULL DEFAULT false,

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON scheduled_tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_next_run ON scheduled_tasks(next_run_at)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_tasks_approval ON scheduled_tasks(approval_slack_ts)
  WHERE status = 'pending_approval';

-- Schema version tracking
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO schema_version (version) VALUES (1) ON CONFLICT DO NOTHING;
