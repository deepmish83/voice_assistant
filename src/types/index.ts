// ─────────────────────────────────────────────────────────────────────────────
// Core domain types for the voice AI system.
// All modules import from here — keeps the type graph acyclic.
// ─────────────────────────────────────────────────────────────────────────────

// ── Call lifecycle ────────────────────────────────────────────────────────────

/**
 * Finite state machine for a call's lifecycle.
 *
 *  INITIATED → GREETING → ACTIVE → TRANSFERRING → COMPLETED
 *                                               ↘ FAILED
 */
export type CallStatus =
  | 'INITIATED'     // Twilio call placed, not yet answered
  | 'GREETING'      // Call answered, AI playing opening line
  | 'ACTIVE'        // Normal ASR ↔ LLM ↔ TTS loop
  | 'TRANSFERRING'  // Conference bridge being built for warm transfer
  | 'COMPLETED'     // Call ended normally
  | 'FAILED';       // Call dropped or unrecoverable error

export interface CallState {
  /** Twilio CallSid — used as the primary key everywhere */
  callId:              string;
  leadId:              string;
  phoneNumber:         string;
  status:              CallStatus;
  campaignId:          string;
  /** Which persona / system-prompt variant to use */
  personaId:           string;
  /** Unix ms — used to enforce MAX_CALL_DURATION_MINUTES */
  startedAt:           number;
  lastActivityAt:      number;
  /** Incremented on every final ASR transcript (for analytics) */
  turnCount:           number;
  /** Set to true once a transfer attempt has been made (prevents retry loops) */
  transferAttempted:   boolean;
}

// ── Conversation history ──────────────────────────────────────────────────────

export interface TranscriptTurn {
  role:      'user' | 'assistant';
  text:      string;
  /** Unix ms */
  timestamp: number;
}

// ── LLM / streaming ──────────────────────────────────────────────────────────

/**
 * A single streamed chunk from the LLM.
 *
 * - `text`      — a partial text token to be spoken
 * - `tool_call` — the LLM is requesting a side-effect (transfer, callback, etc.)
 * - `done`      — stream is complete
 */
export interface LlmReplyChunk {
  type:       'text' | 'tool_call' | 'done';
  text?:      string;
  toolName?:  string;
  toolInput?: Record<string, unknown>;
}

// ── Knowledge base ────────────────────────────────────────────────────────────

export interface KbResult {
  text:     string;
  /** Pinecone cosine similarity score [0, 1] */
  score:    number;
  source:   string;
  metadata: Record<string, string>;
}

// ── Campaign / outbound dialling ──────────────────────────────────────────────

export interface Lead {
  id:          string;
  phoneNumber: string;
  name:        string;
  campaignId:  string;
  /** Override the default persona for this lead */
  personaId?:  string;
  /** Arbitrary CRM data injected into LLM context */
  metadata?:   Record<string, string>;
}

// ── Twilio Media Streams protocol ────────────────────────────────────────────

export interface TwilioConnectedMessage {
  event: 'connected';
  protocol: string;
  version: string;
}

export interface TwilioStartMessage {
  event: 'start';
  sequenceNumber: string;
  start: {
    streamSid: string;
    callSid:   string;
    tracks:    string[];
    customParameters?: Record<string, string>;
  };
  streamSid: string;
}

export interface TwilioMediaMessage {
  event: 'media';
  sequenceNumber: string;
  media: {
    track:     string;
    chunk:     string;
    timestamp: string;
    /** Base64-encoded µ-law 8kHz mono audio */
    payload:   string;
  };
  streamSid: string;
}

export interface TwilioMarkMessage {
  event: 'mark';
  sequenceNumber: string;
  mark: { name: string };
  streamSid: string;
}

export interface TwilioStopMessage {
  event: 'stop';
  sequenceNumber: string;
  stop: { accountSid: string; callSid: string };
  streamSid: string;
}

export type TwilioStreamMessage =
  | TwilioConnectedMessage
  | TwilioStartMessage
  | TwilioMediaMessage
  | TwilioMarkMessage
  | TwilioStopMessage;

// ── Deepgram response ────────────────────────────────────────────────────────

export interface DeepgramAlternative {
  transcript: string;
  confidence: number;
  words?:     unknown[];
}

export interface DeepgramResultsMessage {
  type:         'Results';
  channel_index: [number, number];
  duration:     number;
  start:        number;
  is_final:     boolean;
  /** true when Deepgram's endpointing fires — the utterance has ended */
  speech_final: boolean;
  channel: {
    alternatives: DeepgramAlternative[];
  };
}

export interface DeepgramMetadataMessage {
  type:        'Metadata';
  transaction_key: string;
  request_id: string;
  sha256:     string;
  created:    string;
  duration:   number;
  channels:   number;
  models:     string[];
}

export interface DeepgramUtteranceEndMessage {
  type:         'UtteranceEnd';
  channel:      [number, number];
  last_word_end: number;
}

export interface DeepgramErrorMessage {
  type:    'Error';
  description: string;
  message:     string;
  variant:     string;
}

export type DeepgramMessage =
  | DeepgramResultsMessage
  | DeepgramMetadataMessage
  | DeepgramUtteranceEndMessage
  | DeepgramErrorMessage;
