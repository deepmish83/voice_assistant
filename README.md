Here's the complete runbook — from zero to a live outbound call.

Prerequisites
You need these installed on your machine before anything else:

Node.js 18+ — node --version to check. Install from nodejs.org if needed.
npm 9+ — comes with Node.
ngrok — free tier works fine for dev. Install from ngrok.com/download and run ngrok authtoken <your-token> once.

You also need accounts (all have free tiers sufficient for testing):
ServiceSign-up URLWhat you needTwiliotwilio.com/try-twilioAccount SID, Auth Token, phone numberDeepgramconsole.deepgram.comAPI keyAnthropicconsole.anthropic.comAPI keyOpenAIplatform.openai.comAPI key (embeddings only)Pineconeapp.pinecone.ioAPI key, index nameUpstash Redisconsole.upstash.comRedis URL (free serverless tier)

Step 1 — Install dependencies
bashcd voice-ai
npm install
This pulls all 9 production packages. Takes ~30 seconds on first run.

Step 2 — Create your .env file
Copy the example and fill in real values:
bashcp .env.example .env
Open .env and fill in every value. The minimum set to get a call working:
envPORT=3000
BASE_URL=https://REPLACE-WITH-NGROK-URL.ngrok-free.app   # fill in step 4

TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=your_auth_token
TWILIO_PHONE_NUMBER=+1XXXXXXXXXX

DEEPGRAM_API_KEY=your_deepgram_key
ANTHROPIC_API_KEY=your_anthropic_key
OPENAI_API_KEY=your_openai_key

PINECONE_API_KEY=your_pinecone_key
PINECONE_ENVIRONMENT=us-east-1-aws
PINECONE_INDEX=voice-ai-kb

REDIS_URL=rediss://default:password@host.upstash.io:6380

AGENT_PHONE_NUMBER=+1XXXXXXXXXX   # your own phone for testing transfers
Leave BASE_URL blank for now — you'll fill it in after Step 4.

Step 3 — Create the Pinecone index
Pinecone needs an index before the app can write to it. Do this once in the Pinecone console or via their CLI:
Index name:      voice-ai-kb          (must match PINECONE_INDEX)
Dimensions:      1536                 (text-embedding-3-small output size)
Metric:          cosine
Pod type:        Serverless
Cloud / Region:  AWS us-east-1

Step 4 — Start ngrok (local dev tunnel)
Twilio's webhooks must reach a public HTTPS URL. ngrok creates one that forwards to your local server:
bash# In a separate terminal — keep this running
ngrok http 3000
You'll see output like:
Forwarding  https://abc123.ngrok-free.app -> http://localhost:3000
Copy that https://... URL and paste it into .env as BASE_URL:
envBASE_URL=https://abc123.ngrok-free.app

Note: The free ngrok URL changes every restart. Re-update BASE_URL (and the Twilio webhook in Step 5) each time you restart ngrok.


Step 5 — Configure Twilio webhooks
Log into the Twilio Console → Phone Numbers → Manage → your number → Voice Configuration.
Set both fields:
A Call Comes In (webhook):     https://abc123.ngrok-free.app/twilio/voice-webhook
                               Method: HTTP POST

Call Status Changes (callback): https://abc123.ngrok-free.app/twilio/status-callback
                                Method: HTTP POST
Save. This is only needed for inbound testing — outbound calls set their own webhook URL via the REST API automatically.

Step 6 — (Optional) Seed the knowledge base
If you want the RAG pipeline to return results, ingest at least one document before making calls. Create a quick seed script:
typescript// scripts/seed-kb.ts
import 'dotenv/config';
import { ingestDocument } from '../src/kb/kbClient';

async function seed() {
  await ingestDocument(
    'faq-001',
    `Acme Corp return policy: Customers may return any product within 30 days of purchase
     for a full refund. Items must be in original condition. To start a return, call our
     support line or visit acme.com/returns. Refunds are processed within 5-7 business days.`,
    { source: 'faq.pdf', namespace: 'default', department: 'support' },
  );
  console.log('KB seeded successfully');
}

seed().catch(console.error);
Run it once:
bashnpx ts-node scripts/seed-kb.ts

Step 7 — Start the server
bash# Development (auto-restarts on file changes)
npm run dev

# Production build
npm run build
npm start
You should see:
INFO  Redis connected
INFO  🎙  Voice AI server started  { port: 3000, baseUrl: "https://abc123.ngrok-free.app" }
Verify health:
bashcurl http://localhost:3000/health
# → {"status":"ok","ts":"2026-05-02T...","pid":12345}

curl http://localhost:3000/ready
# → {"status":"ready"}

Step 8 — Make a test outbound call
Create a tiny test script to dial a number:
typescript// scripts/test-call.ts
import 'dotenv/config';
import { startOutboundCall } from '../src/telephony/twilioRoutes';

async function main() {
  const callId = await startOutboundCall({
    id:          'lead-test-001',
    phoneNumber: '+1XXXXXXXXXX',   // ← your own phone number
    name:        'Test User',
    campaignId:  'default',
  });
  console.log('Call initiated — CallSid:', callId);
}

main().catch(console.error);
Run it:
bashnpx ts-node scripts/test-call.ts
Your phone will ring within a few seconds. When you pick up you'll hear the AI greeting. The server logs will show the full turn-by-turn flow in real time.

What to watch in the logs
With LOG_LEVEL=debug in .env you'll see the complete pipeline per turn:
DEBUG  Deepgram ASR session opened          { callId: "CA..." }
INFO   Call connected — sending greeting    { callId: "CA..." }
INFO   User utterance received              { callId: "CA...", transcript: "Hi, what's your return policy?" }
DEBUG  KB lookup triggered                  { callId: "CA..." }
DEBUG  KB retrieval complete                { passed: 2, topScore: 0.87 }
DEBUG  LLM call starting                    { callId: "CA...", turns: 3, hasKb: true }
DEBUG  LLM stream complete                  { inputTokens: 412, outputTokens: 38 }
DEBUG  Turn complete                        { callId: "CA...", replyLen: 142 }

Common issues
"Missing required environment variable" — a .env value is blank or the file isn't being loaded. Check the variable name matches .env.example exactly.
Twilio webhook returns 403 — TWILIO_WEBHOOK_SECRET is set but the signature isn't matching (common when BASE_URL has a trailing slash or the wrong protocol). Either unset the secret for local dev or make sure BASE_URL exactly matches what Twilio sees.
ngrok "tunnel not found" — the free ngrok URL changed. Re-run ngrok http 3000, update BASE_URL in .env, restart the server, and update the webhook URLs in the Twilio console.
Pinecone "index not found" — the index wasn't created yet, or PINECONE_INDEX doesn't match the name in the console. Index creation takes ~30 seconds after you click save.
Redis "ECONNREFUSED" — the REDIS_URL is wrong or the Upstash instance is paused (free tier pauses after inactivity). Open the Upstash console and resume it; the URL doesn't change.
TTS audio sounds choppy — the media session's µ-law encoder is the pure-JS fallback. Install the alawmulaw npm package and swap pcmToMulaw / mulawToPcm in mediaSession.ts to use it; the native C addon is ~5× faster and eliminates the choppiness under load.
