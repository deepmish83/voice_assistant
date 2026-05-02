import OpenAI from 'openai';
import { Pinecone } from '@pinecone-database/pinecone';
import { createHash } from 'crypto';
import { config } from '../config/config';
import type { KbResult } from '../types';
import { getCachedEmbedding, setCachedEmbedding } from '../state/redisClient';
import { logger } from '../utils/logger';
import { withRetry, withTimeout } from '../utils/retry';

// ─────────────────────────────────────────────────────────────────────────────
// Knowledge base module — OpenAI embeddings + Pinecone Serverless.
//
// Two public surfaces:
//
//   ingestDocument()  — called offline (data pipeline) to load KB articles.
//   retrieveContext() — called at call-time (live) to fetch relevant chunks.
//
// Live-call retrieval budget:
//   Redis cache hit:  ~5ms    (base64 embedding + JSON parse)
//   Cache miss:       ~80ms   (OpenAI embed API round-trip)
//   Pinecone query:   ~20ms   (serverless p50)
//   Total hot path:   ~25ms   (cache hit + Pinecone)
//   Total cold path:  ~140ms  (embed miss + Pinecone + Redis write)
//
// Confidence gate: results with score < CONFIDENCE_THRESHOLD are dropped.
// If nothing passes, the caller's KB context is empty and the LLM is
// instructed to escalate rather than guess.
// ─────────────────────────────────────────────────────────────────────────────

const CONFIDENCE_THRESHOLD = 0.72;  // minimum cosine similarity to include
const CHUNK_SIZE_CHARS     = 1_800; // ~450 tokens (GPT-4 tokeniser ≈ 4 chars/token)
const CHUNK_OVERLAP_CHARS  = 200;   // overlap to avoid cutting context at boundaries
const EMBED_TIMEOUT_MS     = 4_000;
const PINECONE_TIMEOUT_MS  = 3_000;

// Clients — instantiated once per process
const openai  = new OpenAI({ apiKey: config.openai.apiKey });
const pinecone = new Pinecone({ apiKey: config.pinecone.apiKey });

function getIndex() {
  return pinecone.index(config.pinecone.indexName);
}

// ── Embedding with cache ──────────────────────────────────────────────────────

/**
 * Embed `text` via OpenAI API, backed by a 24h Redis cache.
 *
 * The cache key is the first 16 hex chars of a SHA-256 hash of the text.
 * Collision probability at this scale is negligible.
 */
async function embed(text: string): Promise<number[]> {
  // Truncate to ~8 000 chars to stay within model's token limit
  const truncated = text.slice(0, 8_000);
  const hash      = createHash('sha256').update(truncated).digest('hex').slice(0, 24);

  const cached = await getCachedEmbedding(hash);
  if (cached) return cached;

  const response = await withTimeout(
    withRetry(
      () => openai.embeddings.create({
        model: config.openai.embeddingModel,
        input: truncated,
      }),
      { maxAttempts: 2, baseDelayMs: 200, label: 'OpenAI embed' },
    ),
    EMBED_TIMEOUT_MS,
    'OpenAI embed timeout',
  );

  const vector = response.data[0]?.embedding;
  if (!vector) throw new Error('OpenAI returned no embedding vector');

  await setCachedEmbedding(hash, vector);
  return vector;
}

// ── Document ingestion ────────────────────────────────────────────────────────

/**
 * Chunk text into overlapping windows.
 *
 * We break on sentence boundaries ('. ') where possible to avoid
 * cutting a sentence in half — which would hurt retrieval quality.
 */
function chunkText(text: string): string[] {
  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    const end = Math.min(start + CHUNK_SIZE_CHARS, text.length);
    let boundary = end;

    // Walk back to the nearest sentence boundary within the last 30% of the chunk
    if (end < text.length) {
      const searchFrom = start + Math.floor(CHUNK_SIZE_CHARS * 0.7);
      const dot = text.lastIndexOf('. ', end);
      if (dot >= searchFrom) boundary = dot + 2; // include '. '
    }

    const chunk = text.slice(start, boundary).trim();
    if (chunk.length > 40) chunks.push(chunk); // skip tiny trailing fragments

    start = boundary - CHUNK_OVERLAP_CHARS;
    if (start <= 0) break; // avoid infinite loop on very short text
  }

  return chunks;
}

/**
 * Ingest a document into the knowledge base.
 *
 * Call this from your data-pipeline script, not from the live call path.
 *
 * @param docId    Unique identifier — used to build per-chunk Pinecone IDs
 * @param text     Full document text (plain text, markdown, or extracted HTML)
 * @param metadata Arbitrary key–value pairs stored alongside each vector
 *                 Recommended keys: source, department, date_updated, namespace
 */
export async function ingestDocument(
  docId:    string,
  text:     string,
  metadata: Record<string, string>,
): Promise<void> {
  const chunks    = chunkText(text);
  const namespace = metadata['namespace'] ?? 'default';

  logger.info({ docId, chunks: chunks.length, namespace }, 'Starting document ingestion');

  const BATCH = 10; // Pinecone upsert batch size

  for (let i = 0; i < chunks.length; i += BATCH) {
    const batch   = chunks.slice(i, i + BATCH);
    const vectors = await Promise.all(
      batch.map(async (chunk, j) => {
        const values = await embed(chunk);
        return {
          id:       `${docId}__chunk_${i + j}`,
          values,
          metadata: {
            ...metadata,
            text:       chunk,
            docId,
            chunkIndex: String(i + j),
          },
        };
      }),
    );

    await withRetry(
      () => getIndex().namespace(namespace).upsert(vectors),
      { maxAttempts: 3, baseDelayMs: 300, label: 'Pinecone upsert' },
    );

    logger.debug({ docId, batch: Math.floor(i / BATCH) + 1 }, 'Chunk batch upserted');
  }

  logger.info({ docId, totalChunks: chunks.length }, 'Document ingestion complete');
}

// ── Context retrieval ─────────────────────────────────────────────────────────

/**
 * Retrieve the most relevant KB chunks for a live-call query.
 *
 * Returns an empty array (not an error) when:
 *   - No results pass the confidence gate
 *   - The embed or Pinecone call fails (fail-safe: call continues without KB)
 *
 * @param query     Raw utterance or extracted question from the user
 * @param topK      Number of results to request from Pinecone (default 4)
 * @param namespace Pinecone namespace — typically the campaignId or department
 */
export async function retrieveContext(
  query:     string,
  topK     = 4,
  namespace = 'default',
): Promise<KbResult[]> {
  try {
    const queryVector = await withTimeout(
      embed(query),
      EMBED_TIMEOUT_MS,
      'KB embed timeout',
    );

    const response = await withTimeout(
      withRetry(
        () => getIndex().namespace(namespace).query({
          vector:          queryVector,
          topK,
          includeMetadata: true,
        }),
        { maxAttempts: 2, baseDelayMs: 100, label: 'Pinecone query' },
      ),
      PINECONE_TIMEOUT_MS,
      'Pinecone query timeout',
    );

    const results = (response.matches ?? [])
      .filter((m) => (m.score ?? 0) >= CONFIDENCE_THRESHOLD)
      .map((m) => ({
        text:     String(m.metadata?.['text']  ?? ''),
        score:    m.score ?? 0,
        source:   String(m.metadata?.['source'] ?? 'unknown'),
        metadata: (m.metadata ?? {}) as Record<string, string>,
      }));

    logger.debug(
      { query: query.slice(0, 60), namespace, total: response.matches?.length ?? 0, passed: results.length },
      'KB retrieval complete',
    );

    return results;

  } catch (err: unknown) {
    // KB errors must NEVER crash a live call — return empty and let the LLM
    // decide whether to escalate based on absent context.
    logger.error({ err, query: query.slice(0, 60) }, 'KB retrieval failed — returning empty');
    return [];
  }
}

/**
 * Format retrieved chunks for injection into the LLM system prompt.
 *
 * Produces a clearly delimited block so the model knows exactly which
 * text is from the KB vs the conversation.  Each chunk is tagged with its
 * source filename and relevance score for transparency.
 */
export function formatKbContext(results: KbResult[]): string {
  if (results.length === 0) return '';

  return results
    .map((r, i) =>
      `[KB ${i + 1} | source: ${r.source} | score: ${r.score.toFixed(3)}]\n${r.text}`,
    )
    .join('\n\n');
}
