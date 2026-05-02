import WebSocket from 'ws';
import { config } from '../config/config';
import type { DeepgramMessage, DeepgramResultsMessage } from '../types';
import { logger } from '../utils/logger';

// ─────────────────────────────────────────────────────────────────────────────
// ASR module — Deepgram Nova-3 streaming WebSocket.
//
// One persistent WebSocket connection is held per active call.
// Audio frames are sent as raw binary; transcript events arrive as JSON.
//
// End-of-utterance strategy (two-layer):
//   Primary:  Deepgram `endpointing` + `speech_final: true`
//             Deepgram detects silence gap and fires speech_final.
//   Fallback: 800ms silence timer (VAD guard)
//             If Deepgram returns interim results but never fires speech_final
//             (edge case on noisy lines), we treat the last transcript as final
//             after 800ms of inactivity.
// ─────────────────────────────────────────────────────────────────────────────

const DEEPGRAM_WS_URL = 'wss://api.deepgram.com/v1/listen';
/** Fallback silence window for utterance-end detection (ms) */
const VAD_FALLBACK_MS = 800;
/** WebSocket connect timeout (ms) */
const CONNECT_TIMEOUT_MS = 6_000;

export type TranscriptCallback = (
  transcript: string,
  isFinal:    boolean,
  confidence: number,
) => void;

interface AsrSession {
  ws:           WebSocket;
  callId:       string;
  onTranscript: TranscriptCallback;
  /** VAD fallback timer — reset on every interim result */
  vadTimer:     NodeJS.Timeout | null;
  /** Last interim transcript text (used by VAD fallback) */
  lastInterim:  string;
  connected:    boolean;
}

/** Module-level registry: callId → session */
const sessions = new Map<string, AsrSession>();

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Open a Deepgram streaming connection for a call.
 *
 * @param callId       Twilio CallSid (used as the session key)
 * @param onTranscript Called with (text, isFinal, confidence) on each result
 * @returns            Resolves when the WebSocket is open and ready
 */
export function startAsrSession(
  callId:       string,
  onTranscript: TranscriptCallback,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // Build Deepgram connection URL with all parameters in the query string
    const params = new URLSearchParams({
      model:           config.deepgram.asrModel,
      encoding:        'linear16',    // PCM 16-bit from our µ-law decoder
      sample_rate:     '8000',        // Twilio telephony = 8kHz
      channels:        '1',
      language:        'en-US',
      punctuate:       'true',
      interim_results: 'true',
      endpointing:     String(config.deepgram.endpointing),
      smart_format:    'true',
      // utterance_end_ms: '1000',    // Enable if you want UtteranceEnd events
      diarize:         'false',       // Single speaker on outbound calls
    });

    const url = `${DEEPGRAM_WS_URL}?${params.toString()}`;

    const ws = new WebSocket(url, {
      headers: { Authorization: `Token ${config.deepgram.apiKey}` },
    });

    const session: AsrSession = {
      ws,
      callId,
      onTranscript,
      vadTimer:    null,
      lastInterim: '',
      connected:   false,
    };

    // ── Connection established ──────────────────────────────────────────────
    ws.on('open', () => {
      session.connected = true;
      sessions.set(callId, session);
      logger.info({ callId }, 'Deepgram ASR session opened');
      resolve();
    });

    // ── Transcript events ───────────────────────────────────────────────────
    ws.on('message', (data: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(data.toString()) as DeepgramMessage;
        handleDeepgramMessage(session, msg);
      } catch (err) {
        logger.error({ err, callId }, 'Failed to parse Deepgram message');
      }
    });

    // ── Errors ─────────────────────────────────────────────────────────────
    ws.on('error', (err: Error) => {
      logger.error({ err, callId }, 'Deepgram WebSocket error');
      if (!session.connected) reject(err);
    });

    // ── Connection closed ──────────────────────────────────────────────────
    ws.on('close', (code: number, reason: Buffer) => {
      session.connected = false;
      clearVadTimer(session);
      sessions.delete(callId);
      logger.info({ callId, code, reason: reason.toString() }, 'Deepgram ASR session closed');
    });

    // ── Connect timeout ────────────────────────────────────────────────────
    const connectTimeout = setTimeout(() => {
      if (!session.connected) {
        ws.terminate();
        reject(new Error(`Deepgram connect timeout after ${CONNECT_TIMEOUT_MS}ms`));
      }
    }, CONNECT_TIMEOUT_MS);

    ws.once('open', () => clearTimeout(connectTimeout));
  });
}

/**
 * Forward a raw PCM 16-bit audio chunk to Deepgram.
 * Called by the media session on every inbound audio frame from Twilio.
 */
export function sendAudio(callId: string, pcmChunk: Buffer): void {
  const session = sessions.get(callId);
  if (!session?.connected) return;
  if (session.ws.readyState === WebSocket.OPEN) {
    // Deepgram expects binary frames for audio
    session.ws.send(pcmChunk);
  }
}

/**
 * Gracefully close the Deepgram session for a finished call.
 * Sends Deepgram's close-stream signal before closing the WebSocket.
 */
export async function endAsrSession(callId: string): Promise<void> {
  const session = sessions.get(callId);
  if (!session) return;

  clearVadTimer(session);

  if (session.ws.readyState === WebSocket.OPEN) {
    // Deepgram: empty binary frame signals end-of-stream
    session.ws.send(Buffer.alloc(0));
    // Brief grace period for in-flight transcripts to arrive
    await new Promise<void>((r) => setTimeout(r, 250));
    session.ws.close(1000, 'Call ended');
  }

  sessions.delete(callId);
  logger.info({ callId }, 'ASR session ended');
}

/** True if an ASR session exists and is connected for this call */
export function isAsrActive(callId: string): boolean {
  return sessions.get(callId)?.connected ?? false;
}

// ── Internal handlers ─────────────────────────────────────────────────────────

function handleDeepgramMessage(session: AsrSession, msg: DeepgramMessage): void {
  switch (msg.type) {
    case 'Results':
      handleTranscriptResult(session, msg);
      break;

    case 'UtteranceEnd':
      // Fired when utterance_end_ms is set and Deepgram considers the
      // utterance complete — treat last interim as final
      if (session.lastInterim) {
        logger.debug({ callId: session.callId }, 'Deepgram UtteranceEnd — firing final');
        clearVadTimer(session);
        session.onTranscript(session.lastInterim, true, 0.9);
        session.lastInterim = '';
      }
      break;

    case 'Metadata':
      logger.debug({ callId: session.callId }, 'Deepgram metadata received');
      break;

    case 'Error':
      logger.error(
        { callId: session.callId, description: msg.description, variant: msg.variant },
        'Deepgram error event',
      );
      break;
  }
}

function handleTranscriptResult(session: AsrSession, msg: DeepgramResultsMessage): void {
  const alt = msg.channel.alternatives[0];
  if (!alt) return;

  const transcript = alt.transcript.trim();
  if (!transcript) return;

  if (msg.is_final && msg.speech_final) {
    // ── Primary utterance-end path ─────────────────────────────────────────
    // Deepgram detected endpointing silence and marked this as the final
    // transcript for the utterance.  This is the happy-path signal.
    clearVadTimer(session);
    session.lastInterim = '';
    logger.debug(
      { callId: session.callId, transcript, confidence: alt.confidence },
      'ASR speech_final',
    );
    session.onTranscript(transcript, true, alt.confidence);

  } else if (!msg.is_final) {
    // ── Interim result — update VAD fallback timer ─────────────────────────
    // These arrive every ~200ms while the user is speaking.  We surface them
    // so the orchestrator can use them for barge-in detection (the interim
    // text shows user is speaking even before the final fires).
    session.lastInterim = transcript;
    session.onTranscript(transcript, false, alt.confidence);
    resetVadTimer(session, transcript);
  }
}

/**
 * VAD fallback: if Deepgram hasn't fired speech_final within VAD_FALLBACK_MS
 * after the last interim result, treat the last known transcript as final.
 *
 * This handles noisy telephony lines where Deepgram's endpointing can stall.
 */
function resetVadTimer(session: AsrSession, currentTranscript: string): void {
  clearVadTimer(session);
  session.vadTimer = setTimeout(() => {
    if (currentTranscript && session.connected) {
      logger.debug(
        { callId: session.callId, transcript: currentTranscript },
        'VAD fallback fired — treating interim as final',
      );
      session.lastInterim = '';
      session.onTranscript(currentTranscript, true, 0.85);
    }
  }, VAD_FALLBACK_MS);
}

function clearVadTimer(session: AsrSession): void {
  if (session.vadTimer) {
    clearTimeout(session.vadTimer);
    session.vadTimer = null;
  }
}
