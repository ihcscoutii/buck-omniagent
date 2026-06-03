// Mint a fresh session token for an existing agent — fast, creates nothing new.
// Session tokens are short-lived, so run this right before you connect.
//   npm run token            (webrtc, agent from .agent.json)
//   CHANNEL=websocket npm run token
//   AGENT_ID=<id> npm run token
import { readFileSync } from "node:fs";

const KEY = process.env.NAPSTER_API_KEY;
const CHANNEL = process.env.CHANNEL || "webrtc";
let agentId = process.env.AGENT_ID;
if (!agentId) {
  try {
    agentId = JSON.parse(readFileSync(new URL("../.agent.json", import.meta.url))).agentId;
  } catch {}
}
if (!KEY) { console.error("Set NAPSTER_API_KEY (see .env)."); process.exit(1); }
if (!agentId) { console.error("No agent. Run `npm run setup` first (or set AGENT_ID)."); process.exit(1); }

const res = await fetch(
  `https://companion-api.napster.com/public/agents/${agentId}/connections`,
  { method: "POST", headers: { "X-Api-Key": KEY, "Content-Type": "application/json" }, body: JSON.stringify({ channelType: CHANNEL }) }
);
const body = await res.json().catch(() => ({}));
const token = body.token || body.data?.token;
if (!token) { console.error(`Failed (${res.status}):`, JSON.stringify(body)); process.exit(1); }

try {
  const payload = JSON.parse(Buffer.from(token, "base64").toString());
  console.error(`channel=${CHANNEL}  expiresAt=${payload.expiresAt}`);
} catch {}
console.error("\nPaste this token into the scoreboard's “Connect Buck” box:\n");
console.log(token);
