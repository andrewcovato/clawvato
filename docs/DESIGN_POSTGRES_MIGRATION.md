# Design: SQLite → Postgres Migration

> Status: Approved | Priority: #1 | Trigger: Volume mount incident caused data loss

## Why

SQLite is a single file on a single volume that can only be mounted by one Railway service. This caused:
- **Data loss**: Adding a backup cron service moved the volume, main service got an empty DB
- **No shared access**: CC bridge, local dev, backup cron can't reach the same DB
- **Fragile backups**: File-copy-based backups depend on the main service running

Postgres solves all of these: every surface connects via a connection string.

## What We Get

| Capability | SQLite (current) | Postgres (target) |
|---|---|---|
| Multi-service access | Volume mount (one service only) | Connection string (any service) |
| Backups | Manual file copy to Drive | Railway automatic daily backups + point-in-time recovery |
| Full-text search | FTS5 | `tsvector`/`tsquery` (built-in) |
| Vector search | sqlite-vec (experimental, 384-dim) | pgvector (production-grade, any dimension) |
| Concurrent writes | Single-writer (WAL mode) | Full MVCC concurrent transactions |
| Local dev access | File on disk only | Connection string (same DB or local Postgres) |
| CC bridge | Requires SSH tunnel + MCP | Direct connection from anywhere |
| Max DB size | Volume size (50GB) | Railway Postgres (unlimited with plan) |

## Migration Strategy

### Phase 0: Provision Postgres on Railway

1. `railway add --database postgres` on the clawvato project
2. Wire `DATABASE_URL` to both clawvato and clawvato-backup services via `${{Postgres.DATABASE_URL}}`
3. Verify connectivity from both services

### Phase 1: Schema Translation

Translate `src/db/schema.sql` from SQLite to Postgres:

| SQLite | Postgres | Notes |
|---|---|---|
| `TEXT PRIMARY KEY` | `TEXT PRIMARY KEY` | Same |
| `INTEGER` | `INTEGER` | Same |
| `REAL` | `DOUBLE PRECISION` | |
| `datetime('now')` | `NOW()` | |
| `julianday('now') - julianday(col)` | `EXTRACT(EPOCH FROM NOW() - col) / 86400` | Days calculation |
| `CHECK(type IN (...))` | Removed (dynamic categories) | Already done |
| `FTS5 virtual table` | `tsvector` column + `GIN` index | See FTS migration below |
| `sqlite-vec virtual table` | `pgvector` extension + `vector` column | See vector migration below |
| `INSERT OR IGNORE` | `INSERT ... ON CONFLICT DO NOTHING` | |
| `INSERT OR REPLACE` | `INSERT ... ON CONFLICT DO UPDATE` | |

#### New schema file: `src/db/schema.pg.sql`

```sql
-- Enable extensions
CREATE EXTENSION IF NOT EXISTS vector;

-- Memories table (same structure, Postgres syntax)
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  source TEXT NOT NULL,
  importance INTEGER NOT NULL DEFAULT 5 CHECK(importance BETWEEN 1 AND 10),
  confidence DOUBLE PRECISION NOT NULL DEFAULT 0.5 CHECK(confidence BETWEEN 0 AND 1),
  valid_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  valid_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_accessed_at TIMESTAMPTZ,
  access_count INTEGER NOT NULL DEFAULT 0,
  entities TEXT DEFAULT '[]',
  superseded_by TEXT REFERENCES memories(id),
  reflection_source INTEGER DEFAULT 0,
  -- Full-text search column (auto-maintained via trigger)
  content_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  -- Vector embedding (384-dim for MiniLM, upgradeable)
  embedding vector(384)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
CREATE INDEX IF NOT EXISTS idx_memories_valid ON memories(valid_until);
CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance DESC);
CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memories_type_valid ON memories(type, valid_until);
CREATE INDEX IF NOT EXISTS idx_memories_tsv ON memories USING GIN(content_tsv);
CREATE INDEX IF NOT EXISTS idx_memories_embedding ON memories USING ivfflat(embedding vector_cosine_ops) WITH (lists = 100);

-- Entity junction table
CREATE TABLE IF NOT EXISTS memory_entities (
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  entity TEXT NOT NULL,
  PRIMARY KEY (memory_id, entity)
);
CREATE INDEX IF NOT EXISTS idx_memory_entities_entity ON memory_entities(entity);

-- Dynamic category registry
CREATE TABLE IF NOT EXISTS memory_categories (
  name TEXT PRIMARY KEY,
  description TEXT,
  count INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'seed' CHECK(source IN ('seed', 'discovered')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- People, actions, action_patterns, workflows, consolidation_runs,
-- documents, agent_state, schema_version — same structure, just
-- datetime('now') → NOW(), REAL → DOUBLE PRECISION
```

Key differences from SQLite:
- **FTS is a generated column** (`content_tsv`) with a GIN index — no triggers needed. Auto-updates on INSERT/UPDATE.
- **Vector embedding is a column** on the memories table — no separate `memories_vec` table. Cleaner, faster JOINs.
- **IVFFlat index** on embeddings for approximate nearest neighbor search.

### Phase 2: Database Client Layer

Replace `src/db/index.ts`:

```typescript
// Before (SQLite)
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(dbPath);
db.prepare('SELECT ...').all();

// After (Postgres)
import postgres from 'postgres';
const sql = postgres(process.env.DATABASE_URL!);
await sql`SELECT ...`;
```

**Library choice: `postgres` (porsager/postgres)**
- Zero-dependency, TypeScript-native
- Tagged template literals prevent SQL injection by default
- Connection pooling built-in
- ESM native

**Key API differences:**

| Pattern | SQLite (DatabaseSync) | Postgres (postgres.js) |
|---|---|---|
| Query | `db.prepare(sql).all(...params)` | `await sql\`SELECT ...\`` |
| Single row | `db.prepare(sql).get(...params)` | `const [row] = await sql\`...\`` |
| Insert | `db.prepare(sql).run(...params)` | `await sql\`INSERT ...\`` |
| Parameterize | `?` placeholders + positional | `${value}` in tagged template |
| Sync/Async | Synchronous | All async |
| Transaction | N/A (single-threaded) | `await sql.begin(async sql => { ... })` |

**The biggest change: everything becomes async.** All `store.ts`, `retriever.ts`, `consolidation.ts` functions that currently return values synchronously will need to return Promises. Most callers already await their results (the agent code is async), but some consolidation code is sync.

### Phase 3: Query Translation (file by file)

#### `src/memory/store.ts`

```typescript
// Before
export function insertMemory(db: DatabaseSync, memory: NewMemory): string {
  const id = generateId();
  db.prepare('INSERT INTO memories ...').run(id, ...);
  return id;
}

// After
export async function insertMemory(sql: Sql, memory: NewMemory): Promise<string> {
  const id = generateId();
  await sql`INSERT INTO memories (id, type, content, source, importance, confidence, entities)
    VALUES (${id}, ${memory.type}, ${memory.content}, ${memory.source},
            ${memory.importance ?? 5}, ${memory.confidence ?? 0.5},
            ${JSON.stringify(memory.entities ?? [])})`;
  // Entity junction
  for (const entity of memory.entities ?? []) {
    await sql`INSERT INTO memory_entities (memory_id, entity) VALUES (${id}, ${entity})
              ON CONFLICT DO NOTHING`;
  }
  return id;
}
```

#### FTS5 → tsvector

```typescript
// Before (FTS5)
const results = db.prepare(
  'SELECT m.* FROM memories m JOIN memories_fts f ON m.rowid = f.rowid WHERE memories_fts MATCH ?'
).all(query);

// After (tsvector)
const results = await sql`
  SELECT * FROM memories
  WHERE content_tsv @@ plainto_tsquery('english', ${query})
    AND valid_until IS NULL
  ORDER BY ts_rank(content_tsv, plainto_tsquery('english', ${query})) DESC
  LIMIT ${limit}`;
```

`plainto_tsquery` is safer than `to_tsquery` — it handles special characters without injection risk (solves SEC-001 from the mitigation plan for free).

#### sqlite-vec → pgvector

```typescript
// Before (sqlite-vec)
const results = db.prepare(
  'SELECT v.memory_id FROM memories_vec v WHERE v.embedding MATCH ? AND k = ?'
).all(embeddingBytes, limit);

// After (pgvector)
const results = await sql`
  SELECT id FROM memories
  WHERE embedding IS NOT NULL AND valid_until IS NULL
  ORDER BY embedding <=> ${pgvector.toSql(queryEmbedding)}
  LIMIT ${limit}`;
```

Vector is a column on `memories` — no JOIN needed. `<=>` is cosine distance.

#### Hybrid search (RRF)

```typescript
// Before: two separate queries + JS RRF merge
// After: single query with CTE
const results = await sql`
  WITH fts_results AS (
    SELECT id, ts_rank(content_tsv, plainto_tsquery('english', ${query})) as rank
    FROM memories
    WHERE content_tsv @@ plainto_tsquery('english', ${query}) AND valid_until IS NULL
    ORDER BY rank DESC LIMIT 30
  ),
  vec_results AS (
    SELECT id, embedding <=> ${pgvector.toSql(queryEmbedding)} as distance
    FROM memories
    WHERE embedding IS NOT NULL AND valid_until IS NULL
    ORDER BY distance LIMIT 30
  ),
  rrf AS (
    SELECT id,
      COALESCE(1.0 / (60 + fts.rn), 0) + COALESCE(1.0 / (60 + vec.rn), 0) as score
    FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY rank DESC) as rn FROM fts_results) fts
    FULL OUTER JOIN (SELECT id, ROW_NUMBER() OVER (ORDER BY distance) as rn FROM vec_results) vec
    USING (id)
  )
  SELECT m.* FROM memories m
  JOIN rrf ON m.id = rrf.id
  ORDER BY rrf.score DESC
  LIMIT ${limit}`;
```

RRF fusion in a single SQL query — no JS merge code needed.

### Phase 4: Module-by-Module Changes

| Module | Sync→Async | Query Changes | Other |
|---|---|---|---|
| `src/db/index.ts` | Full rewrite | Connection pool setup | Remove sqlite-vec, add pgvector |
| `src/memory/store.ts` | All functions async | All queries | FTS5→tsvector, vec→pgvector |
| `src/memory/retriever.ts` | Already async | Search queries | Hybrid search in single CTE |
| `src/memory/extractor.ts` | Already async | storeExtractionResult | Minor |
| `src/memory/consolidation.ts` | Make async | Decay/archive queries | julianday→EXTRACT |
| `src/memory/reflection.ts` | Already async | insertMemory call | Minor |
| `src/memory/backup.ts` | **Delete** | N/A | Railway handles backups |
| `src/memory/embeddings.ts` | No change | N/A | Still generates embeddings |
| `src/mcp/memory/server.ts` | Handlers async | All queries | Minor |
| `src/agent/hybrid.ts` | Already async | processDeepPathFindings | Minor |
| `src/agent/fast-path.ts` | Already async | None (uses store) | Minor |
| `src/agent/context.ts` | Already async | loadWorkingContext | Minor |
| `src/cli/start.ts` | Already async | consolidation call | Minor |
| `src/cli/backup.ts` | **Delete** | N/A | Railway handles backups |
| `tests/**` | All async | All queries | Use test Postgres or pg-mem |

### Phase 5: Connection Management

```typescript
// src/db/index.ts (new)
import postgres from 'postgres';

let sql: ReturnType<typeof postgres> | null = null;

export function getDb(): ReturnType<typeof postgres> {
  if (!sql) throw new Error('Database not initialized');
  return sql;
}

export async function initDb(): Promise<ReturnType<typeof postgres>> {
  if (sql) return sql;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL not set');

  sql = postgres(connectionString, {
    max: 10,              // connection pool size
    idle_timeout: 30,     // close idle connections after 30s
    connect_timeout: 10,  // connection timeout
  });

  // Run schema migration
  await sql.file('src/db/schema.pg.sql');

  // Seed categories if needed
  const catCount = await sql`SELECT COUNT(*) as c FROM memory_categories`;
  if (catCount[0].c === 0) {
    await seedCategories(sql);
  }

  return sql;
}

export async function closeDb(): Promise<void> {
  if (sql) {
    await sql.end();
    sql = null;
  }
}
```

### Phase 6: MCP Server Update

The MCP server currently uses `DatabaseSync` (synchronous). With Postgres, all operations become async. The MCP protocol handlers are already async (they return `Promise<string>`), so this is a clean transition.

### Phase 7: Delete Dead Code

- `src/db/schema.sql` → replaced by `src/db/schema.pg.sql`
- `src/memory/backup.ts` → Railway handles backups
- `src/cli/backup.ts` → Railway handles backups
- `clawvato-backup` Railway service → delete
- Volume `clawvato-volume` → delete after migration
- `RESET_DB` entrypoint logic → replace with proper migration system
- `GWS_CONFIG_B64` persistence logic → already on volume, clean up

### Phase 8: Data Migration (one-time)

If there's data to preserve (currently empty due to incident):
1. Export SQLite to JSON via `sqlite3` CLI
2. Import to Postgres via INSERT statements
3. Generate embeddings for imported memories

Since we're starting fresh after the volume incident, this is a clean migration — no data to carry over.

## Testing Strategy

**Option A: pg-mem (in-memory Postgres for tests)**
- Fast, no external dependency
- Supports most Postgres features including tsvector
- May not support pgvector

**Option B: Test Postgres instance**
- Real Postgres via Docker or Railway dev environment
- Full feature parity
- Slower test runs

**Recommendation**: pg-mem for unit tests (store, retriever, consolidation), real Postgres for integration tests (if needed).

## Rollback Plan

Keep SQLite code on a branch for 2 weeks after migration. If Postgres causes issues, revert to SQLite with the volume mounted on the main service only.

## Implementation Order

1. Provision Railway Postgres + wire DATABASE_URL
2. Create `schema.pg.sql`
3. Rewrite `src/db/index.ts` (connection management)
4. Rewrite `src/memory/store.ts` (biggest change — all CRUD)
5. Rewrite `src/memory/retriever.ts` (search queries)
6. Update `src/memory/consolidation.ts` (date math)
7. Update `src/memory/reflection.ts` (minor)
8. Update `src/memory/extractor.ts` (minor)
9. Update `src/mcp/memory/server.ts` (async handlers)
10. Update `src/agent/hybrid.ts` (findings processor)
11. Update `src/agent/context.ts` (loadWorkingContext)
12. Update tests
13. Delete SQLite-specific code + backup service
14. Deploy + verify
15. Delete volume + backup service from Railway

## Cost

Railway Postgres: included in the Growth plan. No additional cost for a single-user DB.

## Timeline

This is a ~1 day effort. The schema translation is mechanical, the query changes follow clear patterns, and we're starting with an empty DB (no data migration needed).
