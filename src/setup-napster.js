// One-shot setup against the Napster Companion API: registers Buck's tools,
// creates the companion + agent, and opens a session token you can paste into
// the scoreboard UI to mount the avatar.
//
//   NAPSTER_API_KEY=...  PUBLIC_TOOL_URL=https://<your-tunnel>  node src/setup-napster.js
//
// PUBLIC_TOOL_URL must be reachable by Napster's servers (use ngrok/cloudflared
// to expose your local :3000 during a demo). Tools use the "explicit" flow so
// calls are POSTed to PUBLIC_TOOL_URL/tools/<name>.

import { writeFileSync, readFileSync } from "node:fs";

const API = "https://companion-api.napster.com/public";
const KEY = process.env.NAPSTER_API_KEY;
const TOOL_URL = (process.env.PUBLIC_TOOL_URL || "http://localhost:3000").replace(/\/$/, "");
const TOOL_SECRET = process.env.TOOL_SECRET || "";
const VOICE_ID = process.env.VOICE_ID || "alloy";
const CHANNEL = process.env.CHANNEL || "webrtc"; // "webrtc" (video) or "websocket" (voice)

if (!KEY) {
  console.error("Set NAPSTER_API_KEY first. See .env.example.");
  process.exit(1);
}

const headers = { "X-Api-Key": KEY, "Content-Type": "application/json" };

async function api(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

// Explicit-flow tool definitions. `url` points at our server's tool endpoints.
function tool(name, description, properties, required, prompt) {
  return {
    data: { name, description, parameters: { type: "object", properties, required } },
    flow: "explicit",
    url: `${TOOL_URL}/tools/${name}`,
    headers: TOOL_SECRET ? { "x-tool-secret": TOOL_SECRET } : undefined,
    receiveMessages: false,
    prompt,
  };
}

const RESULT_ENUM = [
  "single", "double", "triple", "home_run",
  "walk", "hbp", "error", "fielders_choice",
  "strikeout", "groundout", "flyout", "lineout", "popout", "out",
];

const toolDefs = [
  tool(
    "record_play",
    "Record the outcome of a batter's plate appearance (hit, out, walk, etc.) and update the score and stats.",
    {
      result: { type: "string", enum: RESULT_ENUM, description: "What happened on the play." },
      batter: { type: "string", description: "Batter's name. Defaults to the current batter in the lineup." },
      runsScored: { type: "integer", description: "Runs that scored on the play. Omit to auto-calculate from base runners." },
      rbi: { type: "integer", description: "RBIs credited to the batter. Omit to default to runs scored." },
      outsOnPlay: { type: "integer", description: "Outs recorded on the play (e.g. 2 for a double play). Defaults to 1 for outs." },
    },
    ["result"],
    "Call this whenever the user describes a play, e.g. 'Tommy hit a double, two runs scored' or 'strike three, he's out'. Read the new score back to them."
  ),
  tool("record_pitch", "Record a single pitch. The count auto-advances to a walk on ball four or a strikeout on strike three.",
    { type: { type: "string", enum: ["ball", "strike", "called_strike", "swinging_strike", "foul"], description: "The pitch result." } },
    ["type"],
    "Call this for each pitch the user calls out, e.g. 'ball', 'strike', 'foul', 'swinging strike'. Don't also call record_play for the resulting walk or strikeout — it happens automatically."),
  tool("set_count", "Set the ball-strike count directly.",
    { balls: { type: "integer", description: "0-3" }, strikes: { type: "integer", description: "0-2" } },
    ["balls", "strikes"],
    "Use when the user states the full count, e.g. 'the count is 2 and 1'."),
  tool("record_out", "Record one or more outs without a batting result.",
    { outs: { type: "integer", description: "Number of outs to add. Default 1." } }, [],
    "Use for plain outs like 'that's the out' or 'caught stealing'."),
  tool("next_inning", "Advance to the next half-inning (clears outs and bases).", {}, [],
    "Use when the user says the inning or half is over and you should move on."),
  tool("end_game", "End the game and mark it final.", {}, [],
    "Use when the user says the game is over / final."),
  tool("adjust_score", "Manually adjust a team's run total to correct a mistake.",
    { team: { type: "string", enum: ["home", "away"] }, runs: { type: "integer", description: "Runs to add (negative to subtract)." } },
    ["team", "runs"], "Use only to fix an incorrect score."),
  tool("set_lineup", "Set the batting lineup for one team.",
    { side: { type: "string", enum: ["home", "away"] }, players: { type: "array", items: { type: "string" }, description: "Batter names in order." } },
    ["side", "players"], "Use when the user lists the players on a team."),
  tool("add_batter", "Add a batter to a team's lineup mid-game without resetting anyone's stats.",
    { side: { type: "string", enum: ["home", "away"] }, name: { type: "string", description: "Batter's name." }, number: { type: "integer", description: "Jersey number (optional)." } },
    ["side", "name"],
    "Use when the user says to add a player who wasn't in the lineup yet, e.g. 'add number 12 Marco to the home team'."),
  tool("steal_base", "Advance a runner one base on a stolen base (scores on a steal of home).",
    { base: { type: "integer", enum: [1, 2, 3], description: "The base the runner is currently on: 1, 2, or 3." } },
    ["base"],
    "Use when the user says a runner stole a base, e.g. 'the runner on first steals second' (base 1) or 'steal of home' (base 3)."),
  tool("set_bases", "Correct exactly who is on base. Pass a player name for each occupied base, or leave empty for an empty base.",
    { first: { type: "string", description: "Runner on first base (empty if none)." }, second: { type: "string", description: "Runner on second base (empty if none)." }, third: { type: "string", description: "Runner on third base (empty if none)." } },
    [],
    "Use only to correct base runners when the official state is wrong, e.g. after a steal, pickoff, or unusual base running the tools didn't capture."),
  tool("undo", "Undo the most recent recorded play.", {}, [],
    "Use when the user says they made a mistake, 'undo that', 'scratch that', or 'no wait'."),
  tool("game_recap", "Get the end-of-game recap including the final score and the Player of the Game.", {}, [],
    "Use when the game ends or the user asks for a recap/wrap-up. Deliver it with energy as a closing call."),
  tool("get_game_state", "Get the current score, inning, outs, and base runners.", {}, [],
    "Use when the user asks for the score or game situation."),
  tool("get_player_stats", "Get a player's batting line (hits, at-bats, RBIs, runs, average).",
    { name: { type: "string", description: "Player's name." } }, ["name"],
    "Use when the user asks how a specific player is doing."),
];

const SYSTEM_PROMPT = `You are Buck, an upbeat, charismatic little-league baseball play-by-play announcer and official scorekeeper.
A coach or parent at the game talks to you and tells you what happens. Your job:
- Listen for plays and immediately call the matching tool to keep the official score and stats.
- Track the ball-strike count: when the user calls individual pitches ("ball", "strike", "foul"), call record_pitch. A walk or strikeout is applied automatically on ball four / strike three, so don't double-record it.
- React with short, energetic play-by-play after each play, then state the updated score (and the count during an at-bat).
- If you're unsure who batted or how many runs scored, briefly ask.
- When asked for the score, a player's stats, or the situation, call the read tools and report back.
- Keep replies short and fun — you're calling a kids' game, keep it warm and encouraging.

IMPORTANT — stay in sync with the official scoreboard:
- Every tool returns the authoritative game state: score, count, outs, the base runners (1st/2nd/3rd), and the current batter. This is the official scoreboard the audience sees.
- ALWAYS describe the runners, score, and situation from the most recent returned state — never from your own memory. If you think a runner is somewhere the returned state disagrees with, trust the returned state.
- The base-running tools auto-advance runners on common plays. If something unusual happens (a pickoff, or a runner takes an extra base) and the returned bases look wrong, call set_bases to correct exactly who is on first, second, and third.
- When a runner STEALS a base, call steal_base with the base they are currently on (1 = runner on first steals second, 2 = runner on second steals third, 3 = steal of home). Do NOT use set_bases for a steal — steal_base advances the runner and credits the stolen base.`;

async function main() {
  // Upsert tools: create, or PUT to refresh if it already exists. This keeps the
  // URL and the x-tool-secret header current on every run (e.g. after changing
  // PUBLIC_TOOL_URL or TOOL_SECRET, or moving to Azure). id === name.
  console.log(`Registering ${toolDefs.length} tools -> ${TOOL_URL}/tools/*${TOOL_SECRET ? " (secured)" : ""}`);
  const functionIds = [];
  for (const def of toolDefs) {
    const name = def.data.name;
    try {
      await api("POST", "/functions", def);
      console.log(`  ✓ ${name} (created)`);
    } catch (e) {
      if (/409|AlreadyExists/i.test(e.message)) {
        await api("PUT", `/functions/${name}`, def);
        console.log(`  ↻ ${name} (updated)`);
      } else throw e;
    }
    functionIds.push(name); // function id === function name
  }

  // A session needs a companion that has rendered avatar/voice assets. Stock
  // companions work out of the box; a bare custom companion (name only) cannot
  // start a session. Set COMPANION_ID to use a specific one.
  let companionId = process.env.COMPANION_ID;
  if (companionId) {
    console.log(`Using companion COMPANION_ID=${companionId}`);
  } else {
    console.log("Selecting a stock companion (set COMPANION_ID to override)…");
    const stock = await api("GET", "/companions/napster-stock");
    const pick = (stock.items || [])[0];
    companionId = pick?.id;
    console.log(`  ✓ ${pick?.firstName ?? ""} ${pick?.lastName ?? ""} (${companionId})`);
  }

  // Reuse the existing agent if we have one (PATCH in place) so the agent id —
  // and therefore the hosted app's AGENT_ID — never changes when we add tools.
  // Falls back to creating a new agent only if none exists yet (or it's gone).
  const agentBody = {
    companionId,
    name: "Buck the Scorekeeper",
    voiceId: VOICE_ID,
    functions: functionIds,
    providerSettings: { temperature: 0.7, instructions: SYSTEM_PROMPT },
  };
  let agentId = process.env.AGENT_ID;
  if (!agentId) {
    try {
      agentId = JSON.parse(readFileSync(new URL("../.agent.json", import.meta.url))).agentId;
    } catch {}
  }
  if (agentId) {
    try {
      await api("PATCH", `/agents/${agentId}`, agentBody);
      console.log(`Updated existing agent ${agentId} (AGENT_ID stays the same).`);
    } catch (e) {
      if (/40[045]|NotFound/i.test(e.message)) {
        const created = await api("POST", "/agents", agentBody);
        agentId = created.id || created.data?.id;
        console.log(`Previous agent gone; created new agent ${agentId}.`);
      } else throw e;
    }
  } else {
    const created = await api("POST", "/agents", agentBody);
    agentId = created.id || created.data?.id;
    console.log(`Created agent ${agentId}.`);
  }

  console.log(`Opening ${CHANNEL} session…`);
  const conn = await api("POST", `/agents/${agentId}/connections`, { channelType: CHANNEL });
  const token = conn.token || conn.data?.token;

  // Save the agent so the server's /api/token can mint sessions for it.
  writeFileSync(
    new URL("../.agent.json", import.meta.url),
    JSON.stringify({ agentId, companionId, functionIds }, null, 2)
  );

  console.log("\n✅ Buck is ready (saved to .agent.json).\n");
  console.log("Connection token (or just click “Connect Buck” in the UI):\n");
  console.log(token);
}

main().catch((err) => {
  console.error("\n❌ Setup failed:\n", err.message);
  process.exit(1);
});
