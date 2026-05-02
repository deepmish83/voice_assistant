import pino from 'pino';

// ─────────────────────────────────────────────────────────────────────────────
// Structured logger (Pino).
//
// In production, logs are emitted as newline-delimited JSON and shipped to
// Datadog / CloudWatch via the sidecar log agent.
// In development, pino-pretty provides coloured human-readable output.
// ─────────────────────────────────────────────────────────────────────────────

const isDev = (process.env['NODE_ENV'] ?? 'development') === 'development';

export const logger = pino({
  level: process.env['LOG_LEVEL'] ?? 'info',
  base: {
    service: 'voice-ai',
    // pod / instance identifier — useful in multi-region deployments
    instance: process.env['HOSTNAME'] ?? 'local',
  },
  // Rename pino's "msg" field to "message" for Datadog convention
  messageKey: 'message',
  // ISO timestamps for log aggregators
  timestamp: pino.stdTimeFunctions.isoTime,
  ...(isDev && {
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'HH:MM:ss',
        ignore: 'pid,hostname,service,instance',
      },
    },
  }),
});

// Convenience re-export so modules do: import { logger } from '../utils/logger'
export type Logger = typeof logger;
