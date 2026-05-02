import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config/config';
import type { TranscriptTurn, LlmReplyChunk } from '../types';
import { logger } from '../utils/logger';
import { withTimeout } from '../utils/retry';

// ─────────────────────────────────────────────────────────────────────────────
// LLM module — Anthropic Claude Haiku streaming.
//
// Key design choices:
//
//  1. generateReply() is an AsyncGenerator.  The orchestrator pipes streamed
//     text tokens to sentence-boundary detection and starts TTS on the first
//     complete sentence — this is what keeps E2E latency under 900ms despite
//     the LLM still generating the rest of the response.
//
//  2. Tools (transfer_to_human, schedule_callback) are declared here.  When
//     the model decides to call one, we yield a `tool_call` chunk so the
//     orchestrator can handle it without needing to inspect raw API objects.
//
//  3. On any error we yield a safe fallback text + a transfer tool_call so
//     the call never goes silent — the caller gets a human immediately.
//
//  4. System prompt is assembled once per turn with optional KB context
//     appended.  Keeping it dynamic (not cached across turns) lets us inject
//     fresh KB chunks without a round-trip cache invalidation.
// ─────────────────────────────────────────────────────────────────────────────

const client = new Anthropic({ apiKey: config.anthropic.apiKey });

// ── System prompt ─────────────────────────────────────────────────────────────

/**
 * Build the system prompt for a given persona.
 *
 * Extend this function to load persona configs from your DB / config store
 * when you add multi-persona / multi-campaign support in Phase 3.
 */
export function buildSystemPrompt(personaId: string, kbContext?: string): string {
  // ── Base persona ──────────────────────────────────────────────────────────
  const base = `\
You are Alex, a friendly and professional customer support representative for Acme Corp.
You are conducting a live phone call. The caller cannot see text — they only hear speech.

VOICE RESPONSE RULES (critical — violating these breaks the call experience):
• Keep every response to 1–2 short sentences maximum.
• Never use bullet points, numbered lists, markdown, or any formatting.
• Speak naturally and conversationally, as you would on a real phone call.
• Do not say "As an AI", "As a language model", or reveal your automated nature unprompted.
• If directly asked whether you are a robot or AI, say: "I'm a virtual assistant — how can I help you today?"
• Never read out URLs, email addresses, or long reference numbers unless the caller specifically asks.

PERSONA:
• Name: Alex
• Company: Acme Corp
• Tone: warm, calm, and efficient
• Persona ID in use: ${personaId}

ESCALATION — call the transfer_to_human tool immediately when ANY of these are true:
• The caller explicitly asks to speak to a human, agent, supervisor, or "real person"
• The caller expresses anger, frustration, or emotional distress
• You cannot answer the question even after consulting the knowledge base
• The request involves account changes, refunds, or financial transactions
• There is any ambiguity about customer safety or urgent health/legal issues
• You have attempted to answer the same question twice and the caller remains unsatisfied

KNOWLEDGE BASE USAGE:
• If KB context is provided below, use it to answer accurately.
• Cite facts from KB context naturally — do not say "[KB SOURCE: ...]" aloud.
• If KB context is absent or the top result score is low, do not guess. Acknowledge
  you are checking and, if still uncertain after a moment, escalate.

CALL HYGIENE:
• Always acknowledge what the caller said before you respond.
• Use the caller's name when available.
• Never stay silent — if thinking, say "One moment" or "Let me check on that."
• When closing a resolved call, summarise the outcome in one sentence and say goodbye warmly.`;

  // ── Injected KB context (per-turn, only when retrieved) ───────────────────
  if (kbContext && kbContext.trim()) {
    return `${base}

─── KNOWLEDGE BASE CONTEXT ───────────────────────────────────────────────────
The following excerpts were retrieved from the Acme Corp knowledge base and are
relevant to the caller's most recent question. Use them to answer accurately.
${kbContext}
──────────────────────────────────────────────────────────────────────────────`;
  }

  return base;
}

// ── Tool definitions ──────────────────────────────────────────────────────────

const TOOLS: Anthropic.Tool[] = [
  {
    name:        'transfer_to_human',
    description: 'Transfer the call to a human agent. Use this whenever the caller requests a human or you cannot resolve the issue.',
    input_schema: {
      type: 'object',
      properties: {
        reason: {
          type:        'string',
          description: 'Brief reason for the transfer (logged for the agent screen-pop)',
        },
        priority: {
          type:        'string',
          enum:        ['normal', 'urgent'],
          description: '"urgent" for distressed or at-risk callers',
        },
      },
      required: ['reason'],
    },
  },
  {
    name:        'schedule_callback',
    description: 'Schedule a callback when the caller cannot wait or no agents are available.',
    input_schema: {
      type: 'object',
      properties: {
        preferred_time: {
          type:        'string',
          description: 'Caller\'s preferred callback time in natural language, e.g. "tomorrow morning"',
        },
        notes: {
          type:        'string',
          description: 'Brief summary of the issue for the callback agent',
        },
      },
      required: ['preferred_time'],
    },
  },
  {
    name:        'end_call',
    description: 'Gracefully end the call when the issue has been fully resolved and the caller is satisfied.',
    input_schema: {
      type: 'object',
      properties: {
        disposition: {
          type:        'string',
          enum:        ['resolved', 'unresolved', 'callback_scheduled'],
          description: 'Outcome of the call',
        },
        summary: {
          type:        'string',
          description: 'One-sentence summary of what was resolved',
        },
      },
      required: ['disposition'],
    },
  },
];

// ── Public API ────────────────────────────────────────────────────────────────

export interface GenerateReplyParams {
  callId:     string;
  userText:   string;
  history:    TranscriptTurn[];
  kbContext?: string;
  personaId?: string;
}

/**
 * Stream a reply from Claude Haiku for a single conversational turn.
 *
 * Yields:
 *   { type: 'text',      text: '...' }   — streamed token(s) from the model
 *   { type: 'tool_call', toolName, toolInput }  — model is invoking a tool
 *   { type: 'done' }                     — stream complete
 *
 * The orchestrator accumulates text chunks into sentences and starts TTS
 * as each sentence completes, rather than waiting for the full response.
 */
export async function* generateReply(
  params: GenerateReplyParams,
): AsyncGenerator<LlmReplyChunk, void, unknown> {
  const { callId, userText, history, kbContext, personaId = 'default' } = params;

  // Build the Anthropic messages array from stored conversation history
  const messages: Anthropic.MessageParam[] = history.map((turn) => ({
    role:    turn.role === 'user' ? 'user' : 'assistant',
    content: turn.text,
  }));
  // Append the current user turn
  messages.push({ role: 'user', content: userText });

  const systemPrompt = buildSystemPrompt(personaId, kbContext);

  logger.debug(
    { callId, turns: messages.length, hasKb: !!kbContext, personaId },
    'LLM call starting',
  );

  // ── Stream from Anthropic ─────────────────────────────────────────────────
  let stream: Anthropic.MessageStreamManager;
  try {
    // withTimeout wraps the stream *creation* (first-token latency).
    // Individual token streaming is not timed — once tokens are flowing
    // the model is healthy.
    stream = await withTimeout(
      Promise.resolve(
        client.messages.stream({
          model:      config.anthropic.model,
          max_tokens: config.anthropic.maxTokens,
          system:     systemPrompt,
          messages,
          tools:      TOOLS,
        }),
      ),
      config.call.llmTimeoutMs,
      `LLM first-token timeout (${config.call.llmTimeoutMs}ms)`,
    );
  } catch (err: unknown) {
    logger.error({ err, callId }, 'LLM stream creation failed — yielding fallback');
    yield* fallbackResponse();
    return;
  }

  // ── Yield streamed events ─────────────────────────────────────────────────
  try {
    for await (const event of stream) {
      // ── Text delta ─────────────────────────────────────────────────────
      if (
        event.type === 'content_block_delta' &&
        event.delta.type === 'text_delta' &&
        event.delta.text
      ) {
        yield { type: 'text', text: event.delta.text };
      }

      // ── Tool use block opening (model has decided to call a tool) ──────
      if (
        event.type === 'content_block_start' &&
        event.content_block.type === 'tool_use'
      ) {
        logger.info(
          { callId, toolName: event.content_block.name },
          'LLM tool call initiated',
        );
      }

      // ── Stream complete — extract tool calls from final message ────────
      if (event.type === 'message_stop') {
        const finalMsg = await stream.finalMessage();

        for (const block of finalMsg.content) {
          if (block.type === 'tool_use') {
            yield {
              type:      'tool_call',
              toolName:  block.name,
              toolInput: block.input as Record<string, unknown>,
            };
          }
        }

        logger.debug(
          {
            callId,
            inputTokens:  finalMsg.usage.input_tokens,
            outputTokens: finalMsg.usage.output_tokens,
            stopReason:   finalMsg.stop_reason,
          },
          'LLM stream complete',
        );
      }
    }
  } catch (err: unknown) {
    logger.error({ err, callId }, 'LLM stream read error — yielding fallback');
    yield* fallbackResponse();
    return;
  }

  yield { type: 'done' };
}

// ── Fallback ──────────────────────────────────────────────────────────────────

/**
 * Yielded when the LLM API is unavailable or times out.
 * Gives the caller a graceful message and immediately triggers a transfer
 * so the call never goes silent or ends without resolution.
 */
function* fallbackResponse(): Generator<LlmReplyChunk> {
  yield {
    type: 'text',
    text: "I'm sorry, I'm having a bit of trouble right now. Let me get someone to help you right away.",
  };
  yield {
    type:      'tool_call',
    toolName:  'transfer_to_human',
    toolInput: { reason: 'LLM unavailable — automatic fallback transfer', priority: 'normal' },
  };
  yield { type: 'done' };
}
