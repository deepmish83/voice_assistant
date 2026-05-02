import { Router, type Request, type Response } from 'express';
import twilio from 'twilio';
import { config } from '../config/config';
import { setCallState, getCallState, updateCallState } from '../state/redisClient';
import type { CallState, Lead } from '../types';
import { logger } from '../utils/logger';

// ─────────────────────────────────────────────────────────────────────────────
// Telephony module — Twilio webhook routes + outbound call management.
//
// This module owns:
//   • All Twilio HTTP webhook handlers
//   • The Twilio REST API client (startOutboundCall)
//   • Call state transitions triggered by Twilio events
//
// It does NOT contain any AI logic — that lives in the orchestrator.
// ─────────────────────────────────────────────────────────────────────────────

export const twilioRouter = Router();

// One shared Twilio client, initialised once at module load
const twilioClient = twilio(config.twilio.accountSid, config.twilio.authToken);

// ── Webhook signature validation ──────────────────────────────────────────────

/**
 * Validate that the request genuinely came from Twilio.
 * Skip in development (BASE_URL is localhost so signatures won't match).
 */
function isValidTwilioSignature(req: Request): boolean {
  if (config.server.isDev) return true;
  const signature = req.headers['x-twilio-signature'] as string | undefined;
  if (!signature) return false;
  const url = `${config.server.baseUrl}${req.originalUrl}`;
  return twilio.validateRequest(config.twilio.authToken, signature, url, req.body as Record<string, string>);
}

function requireValidSignature(req: Request, res: Response): boolean {
  if (!isValidTwilioSignature(req)) {
    logger.warn({ ip: req.ip, path: req.path }, 'Invalid Twilio webhook signature');
    res.status(403).send('Forbidden');
    return false;
  }
  return true;
}

// ── POST /twilio/voice-webhook ────────────────────────────────────────────────

/**
 * Primary call lifecycle webhook.  Twilio calls this:
 *   • When the call is first answered (CallStatus=in-progress)
 *   • On status updates (ringing, completed, busy, no-answer, failed)
 *
 * Returns TwiML to instruct Twilio what to do with the call.
 */
twilioRouter.post('/voice-webhook', async (req: Request, res: Response) => {
  if (!requireValidSignature(req, res)) return;

  const {
    CallSid: callId,
    CallStatus: callStatus,
    Direction: direction,
    AnsweredBy: answeredBy,
  } = req.body as Record<string, string>;

  logger.info({ callId, callStatus, direction, answeredBy }, 'Twilio voice webhook');

  const twiml = new twilio.twiml.VoiceResponse();

  // ── Answering machine detection ───────────────────────────────────────────
  // Twilio AMD fires a separate async webhook; if we detect a machine here
  // we hang up immediately instead of burning AI + telephony cost.
  if (answeredBy === 'machine_start' || answeredBy === 'machine_end_beep') {
    logger.info({ callId }, 'Answering machine detected — hanging up');
    twiml.hangup();
    await updateCallState(callId, { status: 'COMPLETED' });
    res.type('text/xml').send(twiml.toString());
    return;
  }

  if (callStatus === 'in-progress') {
    // ── Connect Twilio Media Streams ─────────────────────────────────────────
    // This TwiML connects the live call to our WebSocket server so we get
    // raw µ-law audio for ASR and can push TTS audio back in real-time.
    const wsBase = config.server.baseUrl
      .replace('https://', 'wss://')
      .replace('http://',  'ws://');

    const connect = twiml.connect();
    // `track: inbound_track` = we receive caller audio; `both_tracks` for full duplex
    connect.stream({
      url:   `${wsBase}/twilio/media-websocket`,
      track: 'both_tracks',
    });

    await updateCallState(callId, { status: 'GREETING' });

    // NOTE: The actual greeting TTS is triggered by the orchestrator once the
    //       media WebSocket is established (see orchestrator.handleCallConnected).
  }

  if (['completed', 'failed', 'busy', 'no-answer', 'canceled'].includes(callStatus)) {
    const finalStatus: CallState['status'] = callStatus === 'completed' ? 'COMPLETED' : 'FAILED';
    await updateCallState(callId, { status: finalStatus });
    // The orchestrator's handleCallEnded is called from the WebSocket 'stop' event,
    // not here, because the WS close guarantees all audio has been flushed.
  }

  res.type('text/xml').send(twiml.toString());
});

// ── POST /twilio/status-callback ──────────────────────────────────────────────

/**
 * Handles conference participant events during warm transfers.
 * Twilio posts here when an agent joins / leaves the conference.
 */
twilioRouter.post('/status-callback', async (req: Request, res: Response) => {
  if (!requireValidSignature(req, res)) return;

  const {
    CallSid:             callId,
    ConferenceSid:       conferenceSid,
    StatusCallbackEvent: event,
    ParticipantLabel:    label,
  } = req.body as Record<string, string>;

  logger.info({ callId, conferenceSid, event, label }, 'Twilio status callback');

  if (event === 'participant-join' && label === 'agent') {
    // Agent has joined the conference — mark the original call as COMPLETED
    // (the AI leg will disconnect in the transferService once it confirms this event)
    logger.info({ callId, conferenceSid }, 'Agent joined conference — transfer complete');
    await updateCallState(callId, { status: 'COMPLETED' });
  }

  res.sendStatus(200);
});

// ── POST /twilio/amd-callback ─────────────────────────────────────────────────

/**
 * Async AMD (Answering Machine Detection) result webhook.
 * Twilio fires this asynchronously after the call is connected.
 */
twilioRouter.post('/amd-callback', async (req: Request, res: Response) => {
  const { CallSid: callId, AnsweredBy: answeredBy } = req.body as Record<string, string>;
  logger.info({ callId, answeredBy }, 'AMD result received');

  if (answeredBy?.startsWith('machine')) {
    // Hang up and mark as completed — no AI resources consumed
    await twilioClient.calls(callId).update({ status: 'completed' });
    await updateCallState(callId, { status: 'COMPLETED' });
  }

  res.sendStatus(200);
});

// ── Outbound call initiation ───────────────────────────────────────────────────

/**
 * Initiates an outbound call to a lead.
 *
 * When the called party answers, Twilio makes a POST to /twilio/voice-webhook
 * which returns the <Connect><Stream> TwiML to open the Media Streams WebSocket.
 *
 * Returns the Twilio CallSid which is used as the callId everywhere.
 */
export async function startOutboundCall(lead: Lead): Promise<string> {
  const webhookUrl      = `${config.server.baseUrl}/twilio/voice-webhook`;
  const statusCallback  = `${config.server.baseUrl}/twilio/status-callback`;
  const amdCallbackUrl  = `${config.server.baseUrl}/twilio/amd-callback`;

  const call = await twilioClient.calls.create({
    to:                  lead.phoneNumber,
    from:                config.twilio.phoneNumber,
    url:                 webhookUrl,
    method:              'POST',
    statusCallback,
    statusCallbackMethod: 'POST',
    statusCallbackEvent:  ['initiated', 'ringing', 'answered', 'completed'],
    // AMD: detect answering machines before burning AI cost
    machineDetection:     'Enable',
    machineDetectionTimeout: 3000,
    asyncAmd:             'true',
    asyncAmdStatusCallback: amdCallbackUrl,
  });

  const callId = call.sid;

  const state: CallState = {
    callId,
    leadId:           lead.id,
    phoneNumber:      lead.phoneNumber,
    status:           'INITIATED',
    campaignId:       lead.campaignId,
    personaId:        lead.personaId ?? 'default',
    startedAt:        Date.now(),
    lastActivityAt:   Date.now(),
    turnCount:        0,
    transferAttempted: false,
  };

  await setCallState(callId, state);

  logger.info({ callId, leadId: lead.id, phone: lead.phoneNumber }, 'Outbound call initiated');
  return callId;
}

/**
 * Hang up a call programmatically (e.g., on max-duration limit).
 */
export async function hangUpCall(callId: string): Promise<void> {
  await twilioClient.calls(callId).update({ status: 'completed' });
  await updateCallState(callId, { status: 'COMPLETED' });
  logger.info({ callId }, 'Call hung up programmatically');
}
