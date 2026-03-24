/**
 * Cross-Encoder Reranker — local reranking using ms-marco-MiniLM-L-6-v2.
 *
 * Replaces the previous Haiku API reranking with a local cross-encoder model.
 * Scores query-document pairs for relevance, producing much better ordering
 * than bi-encoder similarity alone.
 *
 * The model is downloaded on first use (~80MB quantized) and cached locally.
 * Cost: $0 (runs locally). Speed: ~5-15ms per candidate on Apple Silicon.
 *
 * Uses @huggingface/transformers v3 pipeline API with task 'text-classification'.
 * The ms-marco model is trained as a cross-encoder: it takes (query, passage)
 * pairs and outputs a relevance score.
 */

import { logger } from '../logger.js';
import { getConfig } from '../config.js';
import type { Memory } from './store.js';

/** Minimal interface for the HuggingFace text-classification pipeline */
interface ClassificationResult {
  label: string;
  score: number;
}

interface ClassificationPipeline {
  (inputs: { text: string; text_pair: string }[]): Promise<ClassificationResult[]>;
  (inputs: { text: string; text_pair: string }): Promise<ClassificationResult>;
}

// Lazy-loaded pipeline
let pipelineInstance: ClassificationPipeline | null = null;
let loadingPromise: Promise<ClassificationPipeline | null> | null = null;
let loadFailed = false;

/**
 * Get or initialize the cross-encoder pipeline.
 * Uses dynamic import since @huggingface/transformers is ESM.
 */
async function getPipeline(): Promise<ClassificationPipeline | null> {
  if (loadFailed) return null;
  if (pipelineInstance) return pipelineInstance;
  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    const startTime = Date.now();
    const config = getConfig();
    const modelName = config.memory.rerankModel;
    logger.info({ model: modelName }, 'Loading cross-encoder rerank model (first use may download ~80MB)...');

    try {
      const { pipeline } = await import('@huggingface/transformers');
      pipelineInstance = await pipeline('text-classification', modelName, {
        dtype: 'q8',
      }) as unknown as ClassificationPipeline;

      const elapsed = Date.now() - startTime;
      logger.info({ elapsed, model: modelName }, 'Cross-encoder rerank model loaded');
      loadingPromise = null;
      return pipelineInstance;
    } catch (error) {
      loadFailed = true;
      loadingPromise = null;
      logger.warn({ error }, 'Failed to load cross-encoder rerank model — reranking will be skipped');
      return null;
    }
  })();

  return loadingPromise;
}

/**
 * Rerank memory candidates using a local cross-encoder model.
 *
 * For each candidate, creates a (query, document) pair and scores it
 * with the cross-encoder. Returns the top K candidates sorted by
 * descending relevance score.
 *
 * Falls back gracefully: if the model fails to load or scoring errors,
 * returns candidates in their original order.
 */
export async function rerankWithCrossEncoder(
  query: string,
  candidates: Memory[],
  topK: number,
): Promise<Memory[]> {
  if (candidates.length === 0) return [];

  const classifier = await getPipeline();
  if (!classifier) {
    // Model failed to load — return original order
    return candidates.slice(0, topK);
  }

  try {
    // Score each candidate against the query
    const scored: Array<{ memory: Memory; score: number }> = [];

    for (const candidate of candidates) {
      // Truncate content to avoid excessive inference time
      const passage = candidate.content.slice(0, 512);
      const result = await classifier({ text: query, text_pair: passage });
      // ms-marco model outputs a single score — higher = more relevant
      const score = result.score;
      scored.push({ memory: candidate, score });
    }

    // Sort by score descending, take top K
    scored.sort((a, b) => b.score - a.score);
    const reranked = scored.slice(0, topK).map(s => s.memory);

    logger.debug(
      {
        candidates: candidates.length,
        topK,
        topScore: scored[0]?.score,
        bottomScore: scored[scored.length - 1]?.score,
      },
      'Cross-encoder rerank complete',
    );

    return reranked;
  } catch (error) {
    // Scoring failed — fall back to original order
    logger.debug({ error }, 'Cross-encoder rerank failed — using original order');
    return candidates.slice(0, topK);
  }
}

/**
 * Check if the reranker model is loaded (for status reporting).
 */
export function isRankerLoaded(): boolean {
  return pipelineInstance !== null;
}
