import { config } from '../config/config';
import {
  getCallState,
  updateCallState,
  appendTranscript,
  getConversationHistory,
} from '../state/redisClient';
import { generateReply }          from '../llm/claudeClient';
import { retrieveContext, formatKbContext } from '../kb/kbClient';
import { speak, cancelTts }       from '../tts/ttsClient';
import { endAsrSession }          from '../asr/deepgramClient';
import { initiateWarmTransfer }   from '../transfer/transferService';
import { hangUpCall }             from '../telephony/twilioRoutes';
import type { CallState, LlmReplyChunk } from '../types';
import type { MediaSession }      from '../media/mediaSession';
import { logger }                 from '../utils/logger';

// ─────────────────────────────────────────────────────────────────────────────
// Orchestrator — the central coordination hub for a live call.
//
// Responsibility boundary:
//   orchestrator.ts  owns: business logic, state transitions, turn sequencing
//   vendor modules   own:  API transport, codec, protocol details
//
// Per-turn flow:
//   final ASR transcript
//       │
//       ▼
//   [cancel in-flight TTS + flush Twilio buffer]   ← barge-in
//       │
//       ▼
//   [check call guards: status, duration, turn count]
//       │
//       ▼
//   [shouldLookupKb()?]──yes──► [retrieveContext()] ◄── filler audio timer
//       │                                │
//       └──────────────────────────────► ▼
//                                  [generateReply()]  ← LLM streaming
//                                        │
//                                  sentence boundary?
//                                        │ yes
//                                        ▼
//                                  [speak(sentence)]  ← TTS streaming
//                                        │
//                                  tool_call chunk?
//                                        │ yes
//                                        ▼
//                                  [handleToolCall()]
// ─────────────────────────────────────────────────────────────────────────────

// ── Media session registry ────────────────────────────────────────────────────
// Keyed by Twilio CallSid.  Lives in-process (one worker owns one set of calls).
// If you run multiple workers, add a Redis pub/sub fan-out here.

const mediaSessions = new Map<string, MediaSession>();

export function registerMediaSession(callId: string, session: MediaSession): void {
  mediaSessions.set(callId, session);
  logger.debug({ callId }, 'Media session registered');
}

export function unregisterMediaSession(callId: string): void {
  mediaSessions.delete(callId);
  logger.debug({ callId }, 'Media session unregistered');
}

// ── Call lifecycle hooks ──────────────────────────────────────────────────────

/**
 * Called once by the telephony layer when the Media Streams WebSocket opens
 * and the call is live.  Sends the opening greeting.
 */
export async function handleCallConnected(callId: string): Promise<void> {
  logger.info({ callId }, 'Call connected — sending greeting');

  const state = await getCallState(callId);
  if (!state) {
    logger.warn({ callId }, 'handleCallConnected: no state in Redis — orphaned call');
    return;
  }

  const greeting =
    "Hello, this is Alex calling from Acme Corp. " +
    "How are you doing today? I'm reaching out about your recent inquiry.";

  await speakAndRecord(callId, greeting);
  await updateCallState(callId, { status: 'ACTIVE' });
}

/**
 * Called when the Twilio WebSocket closes (call ended by any party).
 * Cleans up all in-process resources for this call.
 */
export async function handleCallEnded(callId: string, reason: string): Promise<void> {
  logger.info({ callId, reason }, 'Call ended — cleaning up');
  cancelTts(callId);
  await endAsrSession(callId);
  unregisterMediaSession(callId);
  // Redis state retained for TTL period (analytics / post-call processing)
}

// ── Main orchestration loop ───────────────────────────────────────────────────

/**
 * Core per-turn handler.  Called by the ASR module every time Deepgram fires
 * a final transcript (speech_final = true).
 *
 * This function must be non-blocking at the call site — it's invoked inside
 * a WebSocket message handler.  Errors are caught internally so a single bad
 * turn never crashes the call.
 */
export async function handleUserUtterance(
  callId:     string,
  transcript: string,
): Promise<void> {
  logger.info({ callId, transcript: transcript.slice(0, 120) }, 'User utterance received');

  // ── 1. Barge-in: cancel any in-progress TTS immediately ─────────────────
  cancelTts(callId);
  const media = mediaSessions.get(callId);
  media?.clearAudioBuffer();

  // ── 2. Load call state ───────────────────────────────────────────────────
  const state = await getCallState(callId);
  if (!state) {
    logger.warn({ callId }, 'handleUserUtterance: no call state — ignoring turn');
    return;
  }

  // Ignore turns that arrive after the call has already ended / transferred
  if (state.status === 'TRANSFERRING' || state.status === 'COMPLETED' || state.status === 'FAILED') {
    logger.debug({ callId, status: state.status }, 'Ignoring utterance — call not ACTIVE');
    return;
  }

  // ── 3. Guard: max call duration ──────────────────────────────────────────
  const elapsedMin = (Date.now() - state.startedAt) / 60_000;
  if (elapsedMin >= config.call.maxDurationMinutes) {
    logger.info({ callId, elapsedMin }, 'Max call duration reached');
    await handleMaxDuration(callId, state);
    return;
  }

  // ── 4. Persist user turn ─────────────────────────────────────────────────
  await Promise.all([
    appendTranscript(callId, 'user', transcript),
    updateCallState(callId, { turnCount: state.turnCount + 1 }),
  ]);

  // ── 5. Load conversation history for LLM context ─────────────────────────
  const history = await getConversationHistory(callId);

  // ── 6. Decide whether to hit the knowledge base first ───────────────────
  // A lightweight lexical heuristic — fast enough to run synchronously.
  // Replace with a fast Claude Haiku intent call in Phase 3.
  let kbContext: string | undefined;

  if (shouldLookupKb(transcript)) {
    logger.debug({ callId }, 'KB lookup triggered');

    // Start filler audio timer.  If KB + LLM first-token takes > threshold,
    // the caller hears a short phrase instead of silence.
    const fillerTimer = startFillerTimer(callId, media);

    try {
      const namespace = state.campaignId || 'default';
      const results   = await retrieveContext(transcript, 4, namespace);
      kbContext       = formatKbContext(results);
    } finally {
      clearTimeout(fillerTimer);
    }
  }

  // ── 7. Generate LLM reply (streaming) ───────────────────────────────────
  let fullReply    = '';
  let sentenceBuf  = '';
  // Chain TTS calls sequentially so sentences play in order without gaps
  let ttsChain     = Promise.resolve<void>(undefined);
  let toolHandled  = false;

  for await (const chunk of generateReply({
    callId,
    userText:  transcript,
    history,
    kbContext,
    personaId: state.personaId,
  })) {
    // ── Tool call ──────────────────────────────────────────────────────────
    if (chunk.type === 'tool_call' && !toolHandled) {
      toolHandled = true;
      // Drain remaining TTS before acting on the tool
      await ttsChain;
      await handleToolCall(callId, state, chunk);
      break;
    }

    if (chunk.type === 'done') break;

    // ── Text token ──────────────────────────────────────────────────────────
    if (chunk.type === 'text' && chunk.text) {
      fullReply   += chunk.text;
      sentenceBuf += chunk.text;

      // Flush complete sentences to TTS as soon as they are formed.
      // This is the key latency optimisation: the caller starts hearing
      // the first sentence before the LLM has finished generating the rest.
      const { ready, remainder } = splitOnSentenceBoundary(sentenceBuf);
      if (ready) {
        sentenceBuf = remainder;
        const toSpeak = ready; // capture for closure
        ttsChain = ttsChain.then(() => streamTts(callId, toSpeak, media));
      }
    }
  }

  // Flush any remaining text that didn't end with punctuation
  if (sentenceBuf.trim() && !toolHandled) {
    ttsChain = ttsChain.then(() => streamTts(callId, sentenceBuf.trim(), media));
  }

  await ttsChain;

  // ── 8. Persist assistant reply ────────────────────────────────────────────
  if (fullReply) {
    await appendTranscript(callId, 'assistant', fullReply);
  }

  logger.debug({ callId, replyLen: fullReply.length }, 'Turn complete');
}

// ── Private helpers ───────────────────────────────────────────────────────────

/**
 * Stream synthesised audio for `text` to the caller via the media session.
 * Silently exits if cancelled mid-stream (barge-in).
 */
async function streamTts(
  callId: string,
  text:   string,
  media?: MediaSession,
): Promise<void> {
  if (!text.trim() || !media?.isActive) return;

  media.setIsSpeaking(true);
  try {
    for await (const chunk of speak(callId, text)) {
      // Deepgram Aura returns µ-law 8kHz directly — send straight to Twilio
      media.sendMulawAudio(chunk);
    }
  } catch (err: unknown) {
    // AbortError = barge-in cancel — not a real error, don't log as error
    const isAbort = err instanceof Error &&
      (err.name === 'AbortError' || err.message.includes('aborted'));
    if (!isAbort) logger.error({ err, callId }, 'TTS stream error');
  } finally {
    media.setIsSpeaking(false);
  }
}

/**
 * Speak a line of AI text and record it as an assistant turn.
 * Used for scripted lines (greeting, transfer announcement, etc.).
 */
async function speakAndRecord(callId: string, text: string): Promise<void> {
  const media = mediaSessions.get(callId);
  await streamTts(callId, text, media);
  await appendTranscript(callId, 'assistant', text);
}

/** Handle the max-duration guard — gracefully close or transfer */
async function handleMaxDuration(callId: string, state: CallState): Promise<void> {
  const agentNumber = config.transfer.agentPhoneNumber;
  if (agentNumber) {
    await speakAndRecord(
      callId,
      "We've been talking for a while and I want to make sure you get the best help. " +
      "Let me connect you with a team member to continue.",
    );
    await initiateWarmTransfer(callId, agentNumber);
  } else {
    await speakAndRecord(
      callId,
      "I need to wrap up our call now, but please don't hesitate to call us back. " +
      "Thank you for reaching out to Acme Corp. Have a great day!",
    );
    await hangUpCall(callId);
  }
}

/**
 * Dispatch a tool call emitted by the LLM.
 */
async function handleToolCall(
  callId: string,
  state:  CallState,
  chunk:  LlmReplyChunk,
): Promise<void> {
  const { toolName, toolInput = {} } = chunk;
  logger.info({ callId, toolName, toolInput }, 'Handling LLM tool call');

  switch (toolName) {
    // ── Transfer to human ────────────────────────────────────────────────
    case 'transfer_to_human': {
      const agentNumber = config.transfer.agentPhoneNumber;
      if (!agentNumber) {
        logger.warn({ callId }, 'AGENT_PHONE_NUMBER not set — cannot transfer');
        await speakAndRecord(
          callId,
          "I'd like to connect you with a specialist but I'm unable to do so right now. " +
          "Please call us back at 1-800-ACME and we'll be happy to assist.",
        );
        break;
      }

      // Prevent re-entrant transfer loops
      if (state.transferAttempted) {
        logger.warn({ callId }, 'Transfer already attempted — skipping');
        break;
      }

      const reason = String(toolInput['reason'] ?? 'requested');
      const priority = String(toolInput['priority'] ?? 'normal');
      logger.info({ callId, reason, priority }, 'Initiating warm transfer');

      await speakAndRecord(
        callId,
        "Let me connect you with one of our specialists right now. Just one moment, please.",
      );
      await updateCallState(callId, { transferAttempted: true });
      // Transfer is async — we return immediately; the conference flow
      // handles the rest (see transferService.ts)
      initiateWarmTransfer(callId, agentNumber).catch((err: unknown) =>
        logger.error({ err, callId }, 'Warm transfer failed'),
      );
      break;
    }

    // ── Schedule callback ─────────────────────────────────────────────────
    case 'schedule_callback': {
      const time  = String(toolInput['preferred_time'] ?? 'soon');
      const notes = String(toolInput['notes'] ?? '');
      logger.info({ callId, time, notes }, 'Callback scheduled');
      // TODO: call your calendar API here (Google Calendar, Calendly, etc.)
      await speakAndRecord(
        callId,
        `I've noted that — someone from our team will call you back ${time}. ` +
        "Is there anything else I can help you with before we hang up?",
      );
      break;
    }

    // ── End call ──────────────────────────────────────────────────────────
    case 'end_call': {
      const summary     = String(toolInput['summary'] ?? '');
      const disposition = String(toolInput['disposition'] ?? 'resolved');
      logger.info({ callId, disposition, summary }, 'LLM requested call end');
      if (summary) {
        await speakAndRecord(callId, `${summary} Thank you for calling Acme Corp. Have a great day!`);
      } else {
        await speakAndRecord(callId, "Thank you for calling Acme Corp. Have a great day!");
      }
      await hangUpCall(callId);
      break;
    }

    default:
      logger.warn({ callId, toolName }, 'Unknown tool call — ignoring');
  }
}

// ── KB trigger heuristic ──────────────────────────────────────────────────────

const KB_TRIGGER_PATTERNS = [
  /\b(what|how|why|when|where|can|does|do|is|are)\b/i,
  /\b(price|cost|fee|charge|rate|plan|tier)\b/i,
  /\b(policy|return|refund|cancel|warranty|guarantee)\b/i,
  /\b(feature|product|service|work|support|help)\b/i,
  /\b(billing|invoice|account|subscription|upgrade|downgrade)\b/i,
  /\b(hours|location|address|contact|available)\b/i,
];

/**
 * Returns true when the utterance is likely a knowledge-seeking question.
 *
 * Intentionally permissive (low false-negative rate) — a spurious KB lookup
 * only costs ~140ms and a cache hit is ~25ms.  Missing a lookup and having
 * the LLM hallucinate is far worse.
 */
function shouldLookupKb(transcript: string): boolean {
  return KB_TRIGGER_PATTERNS.some((re) => re.test(transcript));
}

// ── Sentence boundary splitting ───────────────────────────────────────────────

/**
 * Split streamed LLM text on the last complete sentence boundary.
 *
 * Returns:
 *   ready     — text up to and including the last sentence-ending punctuation
 *   remainder — any trailing text that hasn't ended yet (still buffering)
 *
 * We use a simple punctuation scan rather than a full NLP sentence tokeniser
 * because we need this to be near-zero latency on the hot path.
 */
function splitOnSentenceBoundary(
  buffer: string,
): { ready: string; remainder: string } {
  // Match . ! ? followed by a space or end-of-string, not inside abbreviations
  const re = /[.!?](?:\s+|$)/g;
  let lastEnd = 0;
  let match: RegExpExecArray | null;

  while ((match = re.exec(buffer)) !== null) {
    lastEnd = match.index + match[0].length;
  }

  if (lastEnd === 0) return { ready: '', remainder: buffer };

  return {
    ready:     buffer.slice(0, lastEnd).trim(),
    remainder: buffer.slice(lastEnd),
  };
}

// ── Filler audio ──────────────────────────────────────────────────────────────

/**
 * Start a timer that plays a filler phrase if KB retrieval takes too long.
 * Returns the timer handle so the caller can clearTimeout() on it.
 *
 * This ensures the caller never hears more than ~650ms of silence while
 * the KB round-trip completes.
 */
function startFillerTimer(callId: string, media?: MediaSession): NodeJS.Timeout {
  return setTimeout(async () => {
    if (!media?.isActive) return;
    logger.debug({ callId }, 'Filler audio triggered (KB taking longer than threshold)');
    await streamTts(callId, 'Sure, one moment.', media);
  }, config.call.fillerAudioTimeoutMs);
}
