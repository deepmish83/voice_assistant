import { logger } from './logger';

// ─────────────────────────────────────────────────────────────────────────────
// Retry + timeout utilities.
//
// Design principles:
//  • Every external API call should be wrapped with withTimeout() so a slow
//    provider never stalls a live call.
//  • Retryable errors (5xx, network blips) use withRetry() with exponential
//    backoff + jitter to avoid thundering-herd on provider recovery.
//  • Non-retryable errors (4xx auth failures, bad input) propagate immediately.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Race `promise` against a timer.  Rejects with a descriptive error if the
 * timer fires first.  Use this as the outermost wrapper on every API call.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label = 'operation',
): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new TimeoutError(`${label} timed out after ${ms}ms`)),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer!));
}

export interface RetryOptions {
  /** Maximum number of attempts (including the first). Default 3. */
  maxAttempts?: number;
  /** Base delay in ms before the first retry. Default 200. */
  baseDelayMs?: number;
  /** Cap on the computed delay. Default 2000. */
  maxDelayMs?: number;
  /** Return true to retry this error; false to propagate immediately. */
  isRetryable?: (err: unknown) => boolean;
  /** Optional label for log context */
  label?: string;
}

/**
 * Call `fn` up to `maxAttempts` times with exponential backoff + jitter.
 * Propagates the last error if all attempts fail.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    maxAttempts  = 3,
    baseDelayMs  = 200,
    maxDelayMs   = 2000,
    isRetryable  = defaultIsRetryable,
    label        = 'operation',
  } = options;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastError = err;

      if (!isRetryable(err)) {
        logger.warn({ err, label, attempt }, 'Non-retryable error — propagating');
        throw err;
      }

      if (attempt === maxAttempts) break;

      // Exponential backoff: 200ms, 400ms, 800ms … capped at maxDelayMs
      // Add ±50ms jitter to spread retries across worker instances
      const jitter = Math.random() * 100 - 50;
      const delay  = Math.min(baseDelayMs * 2 ** (attempt - 1) + jitter, maxDelayMs);

      logger.warn({ err, label, attempt, nextRetryMs: Math.round(delay) },
        `${label} failed — retrying`);

      await sleep(delay);
    }
  }

  logger.error({ err: lastError, label, maxAttempts },
    `${label} failed after ${maxAttempts} attempts`);
  throw lastError;
}

/** Returns true for errors that are likely transient (5xx, network, timeout). */
function defaultIsRetryable(err: unknown): boolean {
  if (err instanceof TimeoutError)     return true;
  if (err instanceof NetworkError)     return true;
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    // Propagate auth errors immediately — retrying won't help
    if (msg.includes('401') || msg.includes('403') || msg.includes('invalid api key')) {
      return false;
    }
    // Retry server errors and rate limits (with backoff for 429)
    if (
      msg.includes('500') || msg.includes('502') || msg.includes('503') ||
      msg.includes('504') || msg.includes('429') || msg.includes('econnreset') ||
      msg.includes('econnrefused') || msg.includes('etimedout')
    ) {
      return true;
    }
  }
  return false;
}

/** Typed error classes for circuit-breaker consumers */
export class TimeoutError extends Error {
  constructor(message: string) { super(message); this.name = 'TimeoutError'; }
}

export class NetworkError extends Error {
  constructor(message: string) { super(message); this.name = 'NetworkError'; }
}

/** Simple sleep helper */
export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
