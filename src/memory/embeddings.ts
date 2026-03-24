/**
 * Embedding Pipeline — local embeddings using nomic-embed-text-v1.5.
 *
 * Uses Matryoshka truncation to produce 384-dimensional vectors from a
 * 768-dim model, giving better semantic quality than a native 384-dim model
 * at the same storage/search cost.
 *
 * nomic-embed-text-v1.5 requires task-specific prefixes:
 *   - "search_document: " for content being stored
 *   - "search_query: " for retrieval queries
 *
 * Runs the model in-process (no worker thread needed — inference is fast
 * for short text). The model is downloaded on first use and cached locally.
 *
 * Cost: $0 (runs locally). Speed: ~5-20ms per text on Apple Silicon.
 */

import { logger } from '../logger.js';
import type { Sql } from '../db/index.js';

/** Minimal interface for the HuggingFace feature-extraction pipeline */
interface EmbeddingPipeline {
  (text: string, opts: { pooling: string; normalize: boolean }): Promise<{ data: Float32Array }>;
}

// Lazy-loaded pipeline
let pipelineInstance: EmbeddingPipeline | null = null;
let loadingPromise: Promise<EmbeddingPipeline> | null = null;

/** Embedding dimension (Matryoshka truncation from 768 to 384) */
export const EMBEDDING_DIM = 384;

/** Purpose determines the prefix prepended before embedding */
export type EmbeddingPurpose = 'document' | 'query';

/** Prefix map for nomic-embed-text-v1.5 */
const PURPOSE_PREFIX: Record<EmbeddingPurpose, string> = {
  document: 'search_document: ',
  query: 'search_query: ',
};

/**
 * Get or initialize the embedding pipeline.
 * Uses dynamic import since @huggingface/transformers is ESM.
 */
async function getPipeline(): Promise<EmbeddingPipeline> {
  if (pipelineInstance) return pipelineInstance;
  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    const startTime = Date.now();
    logger.info('Loading embedding model nomic-embed-text-v1.5 (first use may download ~250MB)...');

    const { pipeline } = await import('@huggingface/transformers');
    pipelineInstance = await pipeline('feature-extraction', 'nomic-ai/nomic-embed-text-v1.5', {
      // No quantized variant available for nomic — use fp32
    }) as unknown as EmbeddingPipeline;

    const elapsed = Date.now() - startTime;
    logger.info({ elapsed }, 'Embedding model loaded');
    loadingPromise = null;
    return pipelineInstance;
  })();

  return loadingPromise;
}

/**
 * Generate an embedding for a single text.
 * Returns a Float32Array of 384 dimensions (Matryoshka truncation).
 */
export async function embed(text: string, purpose: EmbeddingPurpose = 'document'): Promise<Float32Array> {
  const extractor = await getPipeline();
  const prefixed = PURPOSE_PREFIX[purpose] + text;
  const result = await extractor(prefixed, { pooling: 'mean', normalize: true });
  return new Float32Array(result.data.slice(0, EMBEDDING_DIM));
}

/**
 * Generate embeddings for multiple texts in a batch.
 * More efficient than calling embed() per text.
 */
export async function embedBatch(texts: string[], purpose: EmbeddingPurpose = 'document'): Promise<Float32Array[]> {
  if (texts.length === 0) return [];

  const extractor = await getPipeline();
  const embeddings: Float32Array[] = [];

  // Process one at a time (transformers.js handles batching internally)
  for (const text of texts) {
    const prefixed = PURPOSE_PREFIX[purpose] + text;
    const result = await extractor(prefixed, { pooling: 'mean', normalize: true });
    embeddings.push(new Float32Array(result.data.slice(0, EMBEDDING_DIM)));
  }

  return embeddings;
}

/**
 * Check if the embedding model is loaded (for status reporting).
 */
export function isModelLoaded(): boolean {
  return pipelineInstance !== null;
}

/**
 * Re-embed all existing memories after a model upgrade.
 *
 * Checks agent_state for 'embedding_model_version'. If already 'nomic-v1.5', skips.
 * Otherwise processes all active memories in batches of 50, then stamps the version.
 */
export async function reembedAllMemories(sql: Sql): Promise<void> {
  // Check if already migrated
  const existing = await sql`
    SELECT value FROM agent_state WHERE key = 'embedding_model_version'
  `;
  if (existing.length > 0 && existing[0].value === 'nomic-v1.5') {
    logger.info('Embeddings already migrated to nomic-v1.5, skipping re-embed');
    return;
  }

  logger.info('Starting re-embedding migration to nomic-embed-text-v1.5...');

  const BATCH_SIZE = 50;
  let offset = 0;
  let totalProcessed = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const rows = await sql`
      SELECT id, content FROM memories
      WHERE embedding IS NOT NULL AND valid_until IS NULL
      ORDER BY id
      LIMIT ${BATCH_SIZE} OFFSET ${offset}
    `;

    if (rows.length === 0) break;

    const contents = rows.map(r => r.content as string);
    const newEmbeddings = await embedBatch(contents, 'document');

    for (let i = 0; i < rows.length; i++) {
      const vecString = `[${Array.from(newEmbeddings[i]).join(',')}]`;
      await sql`
        UPDATE memories SET embedding = ${vecString}::vector WHERE id = ${rows[i].id}
      `;
    }

    totalProcessed += rows.length;
    offset += BATCH_SIZE;
    logger.info({ processed: totalProcessed }, 'Re-embedding progress');
  }

  // Stamp the version
  await sql`
    INSERT INTO agent_state (key, value, updated_at)
    VALUES ('embedding_model_version', 'nomic-v1.5', NOW())
    ON CONFLICT (key) DO UPDATE SET value = 'nomic-v1.5', updated_at = NOW()
  `;

  logger.info({ totalProcessed }, 'Re-embedding migration complete');
}
