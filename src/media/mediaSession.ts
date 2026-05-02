import { EventEmitter } from 'events';
import WebSocket from 'ws';
import type {
  TwilioStreamMessage,
  TwilioStartMessage,
  TwilioMediaMessage,
} from '../types';
import { logger } from '../utils/logger';

// ─────────────────────────────────────────────────────────────────────────────
// Media session module.
//
// One MediaSession is created per call when Twilio's Media Streams WebSocket
// connects.  It owns:
//   • Decoding inbound µ-law audio → PCM (for ASR)
//   • Encoding outbound PCM audio → µ-law (for TTS → Twilio)
//   • Barge-in: the clearAudioBuffer() command tells Twilio to discard its
//     playback buffer immediately when new user speech is detected
//
// Audio format throughout:
//   Twilio wire:   µ-law 8kHz mono, base64-encoded in JSON
//   ASR input:     PCM 16-bit LE 8kHz mono (Deepgram linear16 encoding)
//   TTS output:    µ-law 8kHz mono (Deepgram Aura returns mulaw directly)
//                  → no conversion needed on the TTS→Twilio path
// ─────────────────────────────────────────────────────────────────────────────

// ── µ-law ↔ PCM codec ─────────────────────────────────────────────────────────

/**
 * Pre-computed µ-law → linear PCM decode table (256 entries, Int16).
 * Built once at module load — zero overhead at call time.
 *
 * In production you can swap this for the `alawmulaw` npm package which
 * provides a native C addon for ~5× throughput if CPU becomes a bottleneck.
 */
const MULAW_DECODE_TABLE = ((): Int16Array => {
  const table = new Int16Array(256);
  for (let i = 0; i < 256; i++) {
    let ulaw = ~i & 0xff;
    const sign     = ulaw & 0x80;
    const exponent = (ulaw >> 4) & 0x07;
    const mantissa = ulaw & 0x0f;
    // ITU-T G.711 µ-law expansion formula
    let sample = ((mantissa << 1) + 33) << (exponent + 2);
    sample -= 33;
    table[i] = sign ? -sample : sample;
  }
  return table;
})();

/** µ-law buffer → PCM 16-bit little-endian buffer */
export function mulawToPcm(mulaw: Buffer): Buffer {
  const pcm = Buffer.allocUnsafe(mulaw.length * 2);
  for (let i = 0; i < mulaw.length; i++) {
    // MULAW_DECODE_TABLE[byte] is always defined (256-entry table, byte is 0-255)
    pcm.writeInt16LE(MULAW_DECODE_TABLE[mulaw[i]!]!, i * 2);
  }
  return pcm;
}

/** PCM 16-bit little-endian buffer → µ-law buffer (ITU-T G.711 approximation) */
export function pcmToMulaw(pcm: Buffer): Buffer {
  const out = Buffer.allocUnsafe(pcm.length >> 1);
  for (let i = 0, j = 0; i < pcm.length; i += 2, j++) {
    out[j] = encodeLinearToMulaw(pcm.readInt16LE(i));
  }
  return out;
}

const MULAW_BIAS = 33;
const MULAW_CLIP = 32635;

function encodeLinearToMulaw(sample: number): number {
  const sign = sample >> 8 & 0x80;
  if (sign) sample = -sample;
  if (sample > MULAW_CLIP) sample = MULAW_CLIP;
  sample += MULAW_BIAS;
  let exp = 7;
  for (let expMask = 0x4000; exp > 0 && !(sample & expMask); exp--, expMask >>= 1);
  const mantissa = (sample >> (exp + 3)) & 0x0f;
  return ~(sign | (exp << 4) | mantissa) & 0xff;
}

// ── MediaSession ──────────────────────────────────────────────────────────────

/** Events emitted by MediaSession (typed via declaration merging below) */
interface MediaSessionEvents {
  /** Fires once Twilio sends the 'start' message with call metadata */
  callSid:    (callSid: string)    => void;
  streamSid:  (streamSid: string) => void;
  /** PCM 16-bit audio chunk ready for ASR */
  audioChunk: (pcm: Buffer)        => void;
  /** The WebSocket has closed (call ended or network drop) */
  end:        ()                   => void;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export declare interface MediaSession {
  on<K extends keyof MediaSessionEvents>(event: K, listener: MediaSessionEvents[K]): this;
  emit<K extends keyof MediaSessionEvents>(event: K, ...args: Parameters<MediaSessionEvents[K]>): boolean;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class MediaSession extends EventEmitter {
  /** Twilio CallSid — set when the 'start' message arrives */
  public callSid   = '';
  public streamSid = '';

  private ws:       WebSocket;
  private active =  true;
  /** True while we are actively streaming TTS audio to the caller */
  private speaking = false;

  constructor(ws: WebSocket) {
    super();
    this.ws = ws;
    this.attachWebSocketHandlers();
  }

  // ── WebSocket message handling ──────────────────────────────────────────────

  private attachWebSocketHandlers(): void {
    this.ws.on('message', (data: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(data.toString()) as TwilioStreamMessage;
        this.dispatchMessage(msg);
      } catch (err) {
        logger.error({ err, callSid: this.callSid }, 'Failed to parse Twilio media message');
      }
    });

    this.ws.on('close', (code: number, reason: Buffer) => {
      this.active  = false;
      this.speaking = false;
      logger.info({ callSid: this.callSid, code, reason: reason.toString() },
        'Media stream WebSocket closed');
      this.emit('end');
    });

    this.ws.on('error', (err: Error) => {
      logger.error({ err, callSid: this.callSid }, 'Media stream WebSocket error');
    });
  }

  private dispatchMessage(msg: TwilioStreamMessage): void {
    switch (msg.event) {
      case 'connected':
        logger.debug('Twilio media stream protocol negotiated');
        break;

      case 'start': {
        const start = (msg as TwilioStartMessage).start;
        this.callSid   = start.callSid;
        this.streamSid = start.streamSid;
        logger.info({ callSid: this.callSid, streamSid: this.streamSid },
          'Media stream started');
        this.emit('callSid',   this.callSid);
        this.emit('streamSid', this.streamSid);
        break;
      }

      case 'media': {
        const { payload } = (msg as TwilioMediaMessage).media;
        if (!payload) break;
        // Decode base64 µ-law → PCM for Deepgram
        const mulawBuf = Buffer.from(payload, 'base64');
        const pcmBuf   = mulawToPcm(mulawBuf);
        this.emit('audioChunk', pcmBuf);
        break;
      }

      case 'stop':
        this.active  = false;
        this.speaking = false;
        this.emit('end');
        break;

      case 'mark':
        // Twilio fires 'mark' events to confirm our mark messages were received.
        // Useful for synchronized playback — not needed for MVP.
        break;
    }
  }

  // ── Outbound audio (TTS → Twilio) ──────────────────────────────────────────

  /**
   * Send a µ-law audio buffer to the caller via Twilio Media Streams.
   *
   * Deepgram Aura TTS can return µ-law 8kHz directly (`encoding=mulaw`),
   * so no conversion is needed on this path — we just base64-encode and send.
   *
   * If Deepgram returns PCM, call pcmToMulaw() before this method.
   */
  sendMulawAudio(mulawBuf: Buffer): void {
    if (!this.active || this.ws.readyState !== WebSocket.OPEN) return;

    const msg = {
      event:     'media',
      streamSid: this.streamSid,
      media:     { payload: mulawBuf.toString('base64') },
    };
    this.ws.send(JSON.stringify(msg));
  }

  /**
   * Tell Twilio to immediately clear its audio playback buffer.
   *
   * Called during barge-in: when the user starts speaking while the AI is
   * talking, we cancel the TTS stream AND flush Twilio's buffer so the
   * caller's audio isn't blocked by queued AI speech.
   */
  clearAudioBuffer(): void {
    if (!this.active || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ event: 'clear', streamSid: this.streamSid }));
    this.speaking = false;
    logger.debug({ callSid: this.callSid }, 'Audio buffer cleared (barge-in)');
  }

  /**
   * Send a named mark — Twilio will echo it back after all preceding audio
   * has been played.  Useful for detecting when a greeting has finished.
   */
  sendMark(name: string): void {
    if (!this.active || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({
      event:     'mark',
      streamSid: this.streamSid,
      mark:      { name },
    }));
  }

  // ── State accessors ────────────────────────────────────────────────────────

  get isSpeaking(): boolean { return this.speaking; }
  setIsSpeaking(val: boolean): void { this.speaking = val; }

  get isActive(): boolean { return this.active; }

  close(): void {
    this.active = false;
    if (this.ws.readyState === WebSocket.OPEN) this.ws.close();
  }
}
