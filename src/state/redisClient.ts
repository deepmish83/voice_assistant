import Redis from 'ioredis';
import { config } from '../config/config';
import type { CallState, TranscriptTurn } from '../types';
import { logger } from '../utils/logger';

// ─────────────────────────────────────────────────────────────────────────────
// Redis state module.
//
// All per-call state lives here so that any stateless worker can handle any
// call — there's no in-process state that needs to be co-located.
//
// Key schema:
//   call:state:<callId>     → JSON CallState        (TTL: 4h)
//   call:history:<callId>   → Redis List of JSON    (TTL: 4h)
//   embed:cache:<hash>      → JSON number[]         (TTL: 24h)
// ─────────────────────────────────────────────────────────────────────────────

const CALL_TTL_SECONDS    = 4  * 60 * 60; // 4 hours
const EMBED_TTL_SECONDS   = 24 * 60 * 60; // 24 hours

// Build the Redis client once, shared across the process.
export const redis = new Redis(config.redis.url, {
  // Upstash + Redis Cloud both require TLS; ioredis handles rediss:// automatically
  maxRetriesPerRequest: 3,
  retryStrategy: (times: number) => Math.min(times * 100, 3_000),
  enableReadyCheck: true,
  lazyConnect: false,
});

redis.on('connect', () => logger.info('Redis connected'));
redis.on('ready',   () => logger.debug('Redis ready'));
redis.on('error',   (err: Error) => logger.error({ err }, 'Redis connection error'));
redis.on('close',   () => logger.warn('Redis connection closed'));

// ── Key helpers ───────────────────────────────────────────────────────────────

const stateKey = (callId: string) => `call:state:${callId}`;
const histKey  = (callId: string) => `call:history:${callId}`;
const embedKey = (hash: string)   => `embed:cache:${hash}`;

// ── Call state ────────────────────────────────────────────────────────────────

export async function getCallState(callId: string): Promise<CallState | null> {
  const raw = await redis.get(stateKey(callId));
  return raw ? (JSON.parse(raw) as CallState) : null;
}

export async function setCallState(callId: string, state: CallState): Promise<void> {
  await redis.set(stateKey(callId), JSON.stringify(state), 'EX', CALL_TTL_SECONDS);
}

/**
 * Partial update — fetches, merges, and writes back in a single round-trip
 * pair (not fully atomic; sufficient for this use case since workers are
 * single-threaded per call).
 */
export async function updateCallState(
  callId: string,
  patch: Partial<CallState>,
): Promise<CallState | null> {
  const existing = await getCallState(callId);
  if (!existing) {
    logger.warn({ callId }, 'updateCallState: no existing state found');
    return null;
  }
  const updated: CallState = {
    ...existing,
    ...patch,
    lastActivityAt: Date.now(),
  };
  await setCallState(callId, updated);
  return updated;
}

/**
 * Remove all Redis keys for a completed call.
 * Call logs/transcripts are already persisted to S3 by this point.
 */
export async function deleteCallState(callId: string): Promise<void> {
  await redis.del(stateKey(callId), histKey(callId));
  logger.debug({ callId }, 'Call state deleted from Redis');
}

// ── Conversation history ──────────────────────────────────────────────────────

/**
 * Append a transcript turn and keep the list trimmed to the last
 * (config.call.historyTurns * 2) entries.
 *
 * We store user and assistant turns in the same list; each entry is one turn.
 * `historyTurns * 2` gives us N complete exchanges (user + assistant = 1 exchange).
 */
export async function appendTranscript(
  callId: string,
  role: 'user' | 'assistant',
  text: string,
): Promise<void> {
  const turn: TranscriptTurn = { role, text, timestamp: Date.now() };
  const maxEntries = config.call.historyTurns * 2;
  const key = histKey(callId);

  // RPUSH adds to the tail; LTRIM keeps only the last N entries
  await redis
    .pipeline()
    .rpush(key, JSON.stringify(turn))
    .ltrim(key, -maxEntries, -1)
    .expire(key, CALL_TTL_SECONDS)
    .exec();
}

export async function getConversationHistory(callId: string): Promise<TranscriptTurn[]> {
  const raw = await redis.lrange(histKey(callId), 0, -1);
  return raw.map((item) => JSON.parse(item) as TranscriptTurn);
}

// ── Embedding cache ───────────────────────────────────────────────────────────
// Caching embeddings dramatically reduces OpenAI API calls for repeated queries.
// At 3,500 hrs/month, a 60% cache hit rate saves ~$60–$80/month.

export async function getCachedEmbedding(queryHash: string): Promise<number[] | null> {
  const raw = await redis.get(embedKey(queryHash));
  return raw ? (JSON.parse(raw) as number[]) : null;
}

export async function setCachedEmbedding(
  queryHash: string,
  embedding: number[],
): Promise<void> {
  await redis.set(embedKey(queryHash), JSON.stringify(embedding), 'EX', EMBED_TTL_SECONDS);
}

// ── Rate-limit counter (for future use) ──────────────────────────────────────

/**
 * Increment a counter for `key` within a sliding window.
 * Useful for per-campaign dialling rate limits.
 */
export async function incrementCounter(key: string, windowSeconds: number): Promise<number> {
  const full = `rate:${key}`;
  const count = await redis.incr(full);
  if (count === 1) await redis.expire(full, windowSeconds);
  return count;
}
