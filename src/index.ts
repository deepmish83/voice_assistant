import 'dotenv/config';
import express from 'express';
import http    from 'http';
import { WebSocketServer, WebSocket } from 'ws';

import { config }                    from './config/config';
import { logger }                    from './utils/logger';
import { twilioRouter, hangUpCall }  from './telephony/twilioRoutes';
import { MediaSession }              from './media/mediaSession';
import { startAsrSession, sendAudio, endAsrSession } from './asr/deepgramClient';
import {
  handleCallConnected,
  handleCallEnded,
  handleUserUtterance,
  registerMediaSession,
  unregisterMediaSession,
} from './orchestrator/orchestrator';
import { redis }                     from './state/redisClient';

// ─────────────────────────────────────────────────────────────────────────────
// Application bootstrap — index.ts
//
// Sets up:
//   • Express HTTP server (Twilio webhooks, health check, metrics stub)
//   • WebSocket server on /twilio/media-websocket (one connection per call)
//   • Graceful shutdown (SIGTERM / SIGINT)
//
// One WebSocket connection = one active call.
// Each connection creates a MediaSession, an ASR session, and registers
// with the orchestrator — all cleaned up when the connection closes.
// ─────────────────────────────────────────────────────────────────────────────

// ── Express app ───────────────────────────────────────────────────────────────

const app = express();

// Twilio sends webhook payloads as application/x-www-form-urlencoded
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ── Health + readiness ────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString(), pid: process.pid });
});

/**
 * /ready — used by load balancer to determine if this worker can accept calls.
 * Checks that Redis is reachable before reporting ready.
 */
app.get('/ready', async (_req, res) => {
  try {
    await redis.ping();
    res.json({ status: 'ready' });
  } catch (err: unknown) {
    logger.error({ err }, 'Readiness check failed — Redis unreachable');
    res.status(503).json({ status: 'not ready', reason: 'redis' });
  }
});

// ── Metrics stub ─────────────────────────────────────────────────────────────
// In production, replace with Datadog DogStatsD or Prometheus /metrics endpoint.

app.get('/metrics', (_req, res) => {
  res.type('text/plain').send([
    `# HELP voice_ai_active_calls Number of active WebSocket media sessions`,
    `# TYPE voice_ai_active_calls gauge`,
    `voice_ai_active_calls ${wss?.clients.size ?? 0}`,
  ].join('\n'));
});

// ── Twilio routes ─────────────────────────────────────────────────────────────

app.use('/twilio', twilioRouter);

// ── HTTP server ───────────────────────────────────────────────────────────────

const server = http.createServer(app);

// ── WebSocket server (Twilio Media Streams) ───────────────────────────────────

/**
 * Twilio opens one WebSocket per call when the <Connect><Stream> TwiML fires.
 * Path must match what we put in the TwiML in twilioRoutes.ts.
 */
const wss = new WebSocketServer({ server, path: '/twilio/media-websocket' });

wss.on('connection', (ws: WebSocket) => {
  logger.debug('New Twilio media stream WebSocket connection');

  const mediaSession = new MediaSession(ws);

  // ── Once Twilio sends the 'start' message we know the CallSid ───────────
  mediaSession.once('callSid', async (callId: string) => {
    logger.info({ callId }, 'Media session associated with call');

    // Register with orchestrator so it can push TTS audio back
    registerMediaSession(callId, mediaSession);

    // ── Start Deepgram ASR session ─────────────────────────────────────────
    try {
      await startAsrSession(callId, async (transcript, isFinal, confidence) => {
        if (!isFinal) {
          // Interim: use for barge-in detection only (cancel TTS if user is speaking)
          // The orchestrator's cancelTts is called from handleUserUtterance when final
          // fires, so we don't act on interim here to avoid duplicate cancels.
          return;
        }

        if (!transcript.trim()) return;

        logger.info({ callId, confidence, transcript: transcript.slice(0, 100) }, 'Final ASR transcript');

        // Fire-and-forget: don't await in the WebSocket message handler —
        // that would block processing of the next audio frame.
        handleUserUtterance(callId, transcript).catch((err: unknown) => {
          logger.error({ err, callId }, 'Orchestrator error on user utterance');
        });
      });

      // Notify orchestrator the call is live (triggers greeting)
      await handleCallConnected(callId);

    } catch (err: unknown) {
      logger.error({ err, callId }, 'Failed to start ASR session — hanging up');
      await hangUpCall(callId).catch(() => undefined);
    }
  });

  // ── Forward inbound audio (caller → Deepgram) ────────────────────────────
  mediaSession.on('audioChunk', (pcm: Buffer) => {
    const callId = mediaSession.callSid;
    if (callId) sendAudio(callId, pcm);
  });

  // ── Cleanup on WebSocket close (call ended) ──────────────────────────────
  mediaSession.once('end', () => {
    const callId = mediaSession.callSid;
    if (!callId) return;

    logger.info({ callId }, 'Media stream ended — cleaning up call resources');

    unregisterMediaSession(callId);
    endAsrSession(callId).catch((err: unknown) =>
      logger.error({ err, callId }, 'ASR session cleanup error'),
    );
    handleCallEnded(callId, 'websocket_closed').catch((err: unknown) =>
      logger.error({ err, callId }, 'Call ended handler error'),
    );
  });
});

wss.on('error', (err: Error) => {
  logger.error({ err }, 'WebSocket server error');
});

// ── Start listening ───────────────────────────────────────────────────────────

server.listen(config.server.port, () => {
  logger.info(
    {
      port:    config.server.port,
      baseUrl: config.server.baseUrl,
      env:     process.env['NODE_ENV'] ?? 'development',
    },
    '🎙  Voice AI server started',
  );
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'Shutdown signal received — draining connections');

  // 1. Stop accepting new WebSocket connections
  wss.close(() => logger.info('WebSocket server closed'));

  // 2. Stop accepting new HTTP connections
  server.close(() => logger.info('HTTP server closed'));

  // 3. Allow in-flight calls up to 30s to wrap up
  await new Promise<void>((resolve) => setTimeout(resolve, 30_000));

  // 4. Close Redis
  await redis.quit();
  logger.info('Redis connection closed');

  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM').catch(console.error));
process.on('SIGINT',  () => shutdown('SIGINT').catch(console.error));

// Surface unhandled rejections as errors (don't crash the process — a single
// bad call should not take down all concurrent calls)
process.on('unhandledRejection', (reason: unknown) => {
  logger.error({ reason }, 'Unhandled promise rejection');
});

export default server;
