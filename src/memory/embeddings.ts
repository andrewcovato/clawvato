/**
 * Embedding Pipeline — local embeddings using all-MiniLM-L6-v2.
 *
 * Runs the model in-process (no worker thread needed — inference is fast
 * for short text). Produces 384-dimensional vectors for semantic search.
 *
 * The model is downloaded on first use (~80MB quantized) and cached locally.
 * Subsequent loads are instant from cache.
 *
 * Cost: $0 (runs locally). Speed: ~5-20ms per text on Apple Silicon.
 */

import { logger } from '../logger.js';

/** Minimal interface for the HuggingFace feature-extraction pipeline */
interface EmbeddingPipeline {
  (text: string, opts: { pooling: string; normalize: boolean }): Promise<{ data: Float32Array }>;
}

// Lazy-loaded pipeline
let pipelineInstance: EmbeddingPipeline | null = null;
let loadingPromise: Promise<EmbeddingPipeline> | null = null;

/** Embedding dimension for all-MiniLM-L6-v2 */
export const EMBEDDING_DIM = 384;

/**
 * Get or initialize the embedding pipeline.
 * Uses dynamic import since @huggingface/transformers is ESM.
 */
async function getPipeline(): Promise<EmbeddingPipeline> {
  if (pipelineInstance) return pipelineInstance;
  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    const startTime = Date.now();
    logger.info('Loading embedding model (first use may download ~80MB)...');

    const { pipeline } = await import('@huggingface/transformers');
    pipelineInstance = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
      dtype: 'q8', // Quantized for speed
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
 * Returns a Float32Array of 384 dimensions.
 */
export async function embed(text: string): Promise<Float32Array> {
  const extractor = await getPipeline();
  const result = await extractor(text, { pooling: 'mean', normalize: true });
  // result.data is a Float32Array of the pooled embedding
  return new Float32Array(result.data);
}

/**
 * Generate embeddings for multiple texts in a batch.
 * More efficient than calling embed() per text.
 */
export async function embedBatch(texts: string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return [];

  const extractor = await getPipeline();
  const embeddings: Float32Array[] = [];

  // Process one at a time (transformers.js handles batching internally)
  for (const text of texts) {
    const result = await extractor(text, { pooling: 'mean', normalize: true });
    embeddings.push(new Float32Array(result.data));
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
 * Convert a Float32Array embedding to a format sqlite-vec can ingest.
 * sqlite-vec expects raw bytes (Uint8Array of the Float32Array buffer).
 */
export function embeddingToBytes(embedding: Float32Array): Uint8Array {
  return new Uint8Array(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}

/**
 * Convert bytes from sqlite-vec back to a Float32Array.
 */
export function bytesToEmbedding(bytes: Uint8Array): Float32Array {
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}
