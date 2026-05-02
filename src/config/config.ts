import * as dotenv from 'dotenv';
dotenv.config();

// ─────────────────────────────────────────────────────────────────────────────
// Configuration module.
//
// Every environment variable is read exactly once here.  All other modules
// import `config` rather than reading process.env directly, making the
// dependency on env vars explicit and the module testable (just swap config).
// ─────────────────────────────────────────────────────────────────────────────

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) {
    throw new Error(
      `[config] Required environment variable "${key}" is not set. ` +
      `Check .env.example for the full list.`
    );
  }
  return val;
}

function optionalEnv(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function optionalInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed)) throw new Error(`[config] "${key}" must be an integer, got "${raw}"`);
  return parsed;
}

export const config = {
  server: {
    port:    optionalInt('PORT', 3000),
    /** Full public HTTPS base URL — used when building Twilio webhook URLs */
    baseUrl: optionalEnv('BASE_URL', 'http://localhost:3000'),
    isDev:   optionalEnv('NODE_ENV', 'development') === 'development',
  },

  twilio: {
    accountSid:    requireEnv('TWILIO_ACCOUNT_SID'),
    authToken:     requireEnv('TWILIO_AUTH_TOKEN'),
    phoneNumber:   requireEnv('TWILIO_PHONE_NUMBER'),
    /** If set, webhook signature validation is enforced */
    webhookSecret: process.env['TWILIO_WEBHOOK_SECRET'],
  },

  deepgram: {
    apiKey:      requireEnv('DEEPGRAM_API_KEY'),
    asrModel:    optionalEnv('DEEPGRAM_ASR_MODEL',  'nova-3'),
    ttsModel:    optionalEnv('DEEPGRAM_TTS_MODEL',  'aura-2-andromeda-en'),
    /**
     * Milliseconds of silence after which Deepgram fires speech_final = true.
     * 400ms works well for phone audio; increase to 600ms for slower speakers.
     */
    endpointing: optionalInt('DEEPGRAM_ENDPOINTING', 400),
  },

  anthropic: {
    apiKey:    requireEnv('ANTHROPIC_API_KEY'),
    model:     optionalEnv('ANTHROPIC_MODEL', 'claude-haiku-4-5-20251001'),
    maxTokens: optionalInt('ANTHROPIC_MAX_TOKENS', 512),
  },

  openai: {
    apiKey:         requireEnv('OPENAI_API_KEY'),
    embeddingModel: optionalEnv('OPENAI_EMBEDDING_MODEL', 'text-embedding-3-small'),
  },

  pinecone: {
    apiKey:      requireEnv('PINECONE_API_KEY'),
    environment: requireEnv('PINECONE_ENVIRONMENT'),
    indexName:   requireEnv('PINECONE_INDEX'),
  },

  redis: {
    url: requireEnv('REDIS_URL'),
  },

  call: {
    maxDurationMinutes: optionalInt('MAX_CALL_DURATION_MINUTES', 10),
    /** Keep last N turn-pairs in LLM context (user + assistant = 1 pair) */
    historyTurns:       optionalInt('CONVERSATION_HISTORY_TURNS', 12),
    /**
     * If KB retrieval hasn't returned within this many ms, fire filler audio
     * so the caller doesn't hear silence.
     */
    fillerAudioTimeoutMs: optionalInt('FILLER_AUDIO_TIMEOUT_MS', 650),
    /** Hard timeout on Anthropic API calls; triggers fallback + transfer */
    llmTimeoutMs:         optionalInt('LLM_TIMEOUT_MS', 2000),
  },

  transfer: {
    /** PSTN number of the human agent queue dialled during warm transfers */
    agentPhoneNumber: process.env['AGENT_PHONE_NUMBER'] ?? '',
  },
} as const;

export type Config = typeof config;
