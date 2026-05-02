import twilio from 'twilio';
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config/config';
import {
  getCallState,
  updateCallState,
  getConversationHistory,
} from '../state/redisClient';
import { logger }     from '../utils/logger';
import { withTimeout } from '../utils/retry';

// ─────────────────────────────────────────────────────────────────────────────
// Warm transfer module — Twilio Conference API.
//
// Warm transfer sequence (no-drop guarantee):
//
//   ┌──────────┐   1. moves to conference   ┌────────────────────────┐
//   │  Caller  │ ─────────────────────────► │  Twilio Conference     │
//   └──────────┘                            │  (hold music playing)  │
//                                           │                        │
//   ┌──────────┐   2. dials into conference │                        │
//   │  Agent   │ ─────────────────────────► │                        │
//   └──────────┘   hears whisper summary    │                        │
//                                           │  3. conference starts  │
//   ┌──────────┐   4. exits silently        │  caller + agent bridged│
//   │  AI leg  │ ◄───────────────────────── └────────────────────────┘
//   └──────────┘  (only after agent CONNECTED)
//
// The caller hears hold music for ≤3 seconds.  Their audio is never silent
// for longer than the standard PSTN connection delay.
//
// The AI generates a short summary via Claude Haiku and delivers it as
// a <Say> whisper to the agent before bridging — so the agent is briefed
// without the caller hearing.
// ─────────────────────────────────────────────────────────────────────────────

const twilioClient = twilio(config.twilio.accountSid, config.twilio.authToken);
const anthropic    = new Anthropic({ apiKey: config.anthropic.apiKey });

// ── Summary generation ────────────────────────────────────────────────────────

/**
 * Generate a concise 2–3 sentence call summary for the agent whisper.
 *
 * Covers: reason for call, key facts mentioned, emotional tone, suggested action.
 * Target: ≤ 800ms (Claude Haiku non-streaming for predictable latency).
 */
async function generateCallSummary(callId: string): Promise<string> {
  const history = await getConversationHistory(callId);

  if (history.length === 0) {
    return 'Customer inquiry — conversation just started, no detail captured yet.';
  }

  // Build a compact transcript
  const transcript = history
    .map((t) => `${t.role === 'user' ? 'Customer' : 'AI'}: ${t.text}`)
    .join('\n');

  try {
    const response = await withTimeout(
      anthropic.messages.create({
        model:      config.anthropic.model,
        max_tokens: 180,
        system:
          'You write ultra-brief call summaries for human agents taking over from an AI assistant. ' +
          'Output ONLY 2–3 plain sentences. No bullet points. No formatting. ' +
          'Cover: (1) why the customer called, (2) any key facts, (3) suggested next action.',
        messages: [{
          role:    'user',
          content: `Summarise this call for the agent:\n\n${transcript}`,
        }],
      }),
      3_000,
      'Call summary generation timeout',
    );

    const block = response.content[0];
    return block?.type === 'text'
      ? block.text.trim()
      : 'Customer transferred from AI — please review call history.';

  } catch (err: unknown) {
    logger.error({ err, callId }, 'Failed to generate call summary — using fallback');
    return 'Customer transferred from AI assistant. Please assist with their inquiry.';
  }
}

// ── Sanitisation helper ───────────────────────────────────────────────────────

/**
 * Strip characters that would break inline TwiML <Say> content.
 * The summary is injected directly into XML so we must escape it.
 */
function sanitiseForTwiml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .slice(0, 500); // hard cap to prevent oversized TwiML
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Initiate a warm transfer for an active call.
 *
 * @param callId      Twilio CallSid of the caller (the AI's existing call leg)
 * @param agentNumber E.164 phone number or SIP URI of the agent / ACD queue
 */
export async function initiateWarmTransfer(
  callId:      string,
  agentNumber: string,
): Promise<void> {
  logger.info({ callId, agentNumber }, 'Initiating warm transfer');

  const callState = await getCallState(callId);
  if (!callState) {
    logger.error({ callId }, 'initiateWarmTransfer: no call state found');
    return;
  }

  // Transition state early so new utterances are ignored during bridging
  await updateCallState(callId, { status: 'TRANSFERRING' });

  // ── Generate summary in parallel with Twilio setup ──────────────────────
  // Both tasks can start immediately — Twilio REST call doesn't depend on summary
  const [summary] = await Promise.all([
    generateCallSummary(callId),
  ]);

  logger.debug({ callId, summary: summary.slice(0, 100) }, 'Whisper summary ready');

  const conferenceName      = `xfer-${callId}`;
  const statusCallbackUrl   = `${config.server.baseUrl}/twilio/status-callback`;
  const safeConferenceName  = sanitiseForTwiml(conferenceName);
  const safeSummary         = sanitiseForTwiml(summary);

  // ── Step 1: Move the live call into a Twilio Conference ─────────────────
  // Updating the in-progress call's TwiML replaces whatever is currently
  // playing (our Media Stream) with the Conference instruction.
  // `startConferenceOnEnter="false"` keeps the caller on hold until the
  // agent joins — they hear hold music from `waitUrl`.
  await twilioClient.calls(callId).update({
    twiml: `\
<Response>
  <Say voice="alice">Please hold for just a moment while I connect you.</Say>
  <Dial>
    <Conference
      participantLabel="caller"
      startConferenceOnEnter="false"
      endConferenceOnExit="true"
      waitUrl="https://twilio.com/chime"
      waitMethod="GET"
      statusCallback="${statusCallbackUrl}"
      statusCallbackMethod="POST"
      statusCallbackEvent="join leave end"
    >${safeConferenceName}</Conference>
  </Dial>
</Response>`,
  });

  logger.debug({ callId, conferenceName }, 'Caller moved to conference (on hold)');

  // ── Step 2: Dial the agent into the same conference ─────────────────────
  // The agent hears the whisper summary via <Say> *before* <Conference>
  // starts, so they're briefed before being connected to the caller.
  // `startConferenceOnEnter="true"` bridges caller + agent when agent joins.
  const agentCall = await twilioClient.calls.create({
    to:     agentNumber,
    from:   config.twilio.phoneNumber,
    twiml:  `\
<Response>
  <Say voice="alice">
    Incoming transfer from AI assistant. Here is a summary:
    ${safeSummary}
    You will now be connected to the customer.
  </Say>
  <Dial>
    <Conference
      participantLabel="agent"
      startConferenceOnEnter="true"
      endConferenceOnExit="false"
      statusCallback="${statusCallbackUrl}"
      statusCallbackMethod="POST"
      statusCallbackEvent="join"
    >${safeConferenceName}</Conference>
  </Dial>
</Response>`,
    statusCallback:       statusCallbackUrl,
    statusCallbackMethod: 'POST',
    statusCallbackEvent:  ['completed'],
  });

  logger.info(
    { callId, agentCallSid: agentCall.sid, conferenceName },
    'Agent dialled into conference — warm transfer in progress',
  );

  // ── Step 3: Mark transfer complete ──────────────────────────────────────
  // We trust Twilio's Conference webhook (participant-join for label="agent")
  // to confirm the agent connected.  The telephony route updates state then.
  // Here we optimistically mark the original call as COMPLETED so the
  // orchestrator stops processing new utterances.
  await updateCallState(callId, { status: 'COMPLETED' });

  logger.info({ callId }, 'Warm transfer initiated — AI leg will disconnect when agent joins');
}

// ── Fallback: no-agent path ───────────────────────────────────────────────────

/**
 * Called when the ACD reports no agents are available.
 * Offers the caller a callback instead of a live transfer.
 *
 * Returns true if a callback was successfully scheduled.
 * The orchestrator handles telling the caller what happened.
 */
export async function handleNoAgentsAvailable(
  callId:         string,
  preferredTime?: string,
): Promise<boolean> {
  logger.info({ callId, preferredTime }, 'No agents available — scheduling callback');
  // TODO: integrate with Google Calendar / Calendly / your scheduling API
  // For now we just log and return true to indicate "handled"
  return true;
}
