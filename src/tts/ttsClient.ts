import { config } from '../config/config';
import { logger } from '../utils/logger';
import { withRetry } from '../utils/retry';

// ─────────────────────────────────────────────────────────────────────────────
// TTS module — Deepgram Aura-2 streaming REST API.
//
// Design decisions:
//
//  1. speak() is an AsyncGenerator so the orchestrator can pipe audio
//     chunks to the media session as they arrive — first byte hits the caller
//     in ~90–150ms without waiting for the full synthesis.
//
//  2. Barge-in is implemented via AbortController.  When the user starts
//     speaking mid-response, cancelTts() aborts the in-flight fetch, the
//     generator exits cleanly, and the media session flushes Twilio's buffer.
//
//  3. Deepgram Aura returns µ-law 8kHz directly when `encoding=mulaw` is
//     requested — this matches Twilio's wire format exactly, so we never need
//     to do a PCM ↔ µ-law conversion on the TTS path.
//
//  4. One AbortController per active call. A new speak() call for the same
//     callId implicitly cancels any prior one (handles rapid successive turns).
// ─────────────────────────────────────────────────────────────────────────────

const DEEPGRAM_TTS_BASE = 'https://api.deepgram.com/v1/speak';

/** Per-call cancellation registry */
const activeControllers = new Map<string, AbortController>();

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Synthesise `text` to speech and stream µ-law audio chunks as a generator.
 *
 * Usage in orchestrator:
 *   for await (const chunk of speak(callId, sentence)) {
 *     mediaSession.sendMulawAudio(chunk);
 *   }
 *
 * The generator exits silently if cancelled (barge-in).
 */
export async function* speak(
  callId: string,
  text:   string,
): AsyncGenerator<Buffer, void, unknown> {
  if (!text.trim()) return;

  // Cancel any in-flight TTS for this call before starting a new one.
  // This is the barge-in / sentence-chaining cancel path.
  cancelTts(callId);

  const controller = new AbortController();
  activeControllers.set(callId, controller);

  const url = buildTtsUrl();

  let response: Response;
  try {
    response = await withRetry(
      () => fetch(url, {
        method:  'POST',
        headers: {
          'Authorization': `Token ${config.deepgram.apiKey}`,
          'Content-Type':  'application/json',
        },
        body:   JSON.stringify({ text }),
        signal: controller.signal,
      }),
      { maxAttempts: 2, baseDelayMs: 150, label: 'TTS fetch' },
    );
  } catch (err: unknown) {
    if (isAbortError(err)) {
      logger.debug({ callId }, 'TTS fetch aborted before start (barge-in)');
      return;
    }
    logger.error({ err, callId }, 'TTS API request failed');
    activeControllers.delete(callId);
    throw err;
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    logger.error({ callId, status: response.status, body }, 'TTS API error response');
    activeControllers.delete(callId);
    throw new Error(`TTS API ${response.status}: ${body}`);
  }

  if (!response.body) {
    activeControllers.delete(callId);
    throw new Error('TTS response body is null');
  }

  // ── Stream body chunks ──────────────────────────────────────────────────────
  // Node 18+ fetch returns a Web ReadableStream.  We use the reader directly
  // rather than for-await-of on the body to handle abort cleanly.
  const reader = response.body.getReader();

  try {
    while (true) {
      // Check for cancellation on every iteration (fast barge-in path)
      if (controller.signal.aborted) {
        logger.debug({ callId }, 'TTS stream cancelled mid-stream (barge-in)');
        reader.cancel().catch(() => undefined);
        return;
      }

      const { done, value } = await reader.read();
      if (done) break;

      // value is Uint8Array; caller expects Node Buffer
      yield Buffer.from(value);
    }
  } catch (err: unknown) {
    if (isAbortError(err)) {
      logger.debug({ callId }, 'TTS stream reader aborted');
      return;
    }
    logger.error({ err, callId }, 'TTS stream read error');
    throw err;
  } finally {
    // Only clean up our own controller (a newer speak() call may have
    // already replaced it with a fresh one)
    if (activeControllers.get(callId) === controller) {
      activeControllers.delete(callId);
    }
    reader.releaseLock();
  }
}

/**
 * Cancel any in-progress TTS synthesis for this call.
 * Safe to call even if no TTS is active.
 *
 * Called by the orchestrator the instant Deepgram fires a new transcript
 * (user started speaking → barge-in).
 */
export function cancelTts(callId: string): void {
  const controller = activeControllers.get(callId);
  if (controller && !controller.signal.aborted) {
    controller.abort();
    activeControllers.delete(callId);
    logger.debug({ callId }, 'TTS cancelled');
  }
}

/** Returns true if TTS audio is actively streaming for this call */
export function isSpeaking(callId: string): boolean {
  const c = activeControllers.get(callId);
  return c !== undefined && !c.signal.aborted;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildTtsUrl(): string {
  const params = new URLSearchParams({
    model:       config.deepgram.ttsModel,
    // Request µ-law 8kHz to match Twilio's wire format — no conversion needed
    encoding:    'mulaw',
    sample_rate: '8000',
    container:   'none', // raw audio bytes, no WAV header
  });
  return `${DEEPGRAM_TTS_BASE}?${params.toString()}`;
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'AbortError' || err.message.includes('aborted'))
  );
}
