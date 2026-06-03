// Zero-dependency HTTP server. Three jobs:
//   1. Serve the scoreboard UI (public/)
//   2. Expose the tool endpoints the Napster agent ("Buck") calls (explicit flow)
//   3. Stream live game state to the scoreboard via Server-Sent Events
//
// Run: node src/server.js   (then open http://localhost:3000)
import http from "node:http";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import {
  createGame,
  recordPlay,
  recordPitch,
  setCount,
  recordOut,
  nextHalfInning,
  endGame,
  manualScore,
  setLineup,
  setBases,
  undo,
  playerStats,
  publicState,
  scoresheet,
  gameRecap,
} from "./game.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "..", "public");
const PORT = process.env.PORT || 3000;
// Optional shared secret so random callers can't drive your game. The Napster
// tool is configured with this in its `headers`; set TOOL_SECRET to enforce.
const TOOL_SECRET = process.env.TOOL_SECRET || "";

// Napster session tokens are short-lived (~seconds), so we mint them
// server-side on demand. The API key stays here and never reaches the browser.
const NAPSTER_API = "https://companion-api.napster.com/public";
const API_KEY = process.env.NAPSTER_API_KEY || "";
let AGENT_ID = process.env.AGENT_ID || "";
if (!AGENT_ID) {
  try {
    AGENT_ID = JSON.parse(readFileSync(new URL("../.agent.json", import.meta.url))).agentId;
  } catch {}
}

let game = createGame({
  homeName: "Tigers",
  awayName: "Sharks",
  awayLineup: ["Tommy", "Mia", "Jordan", "Priya", "Diego"],
  homeLineup: ["Sam", "Ana", "Lee", "Quinn", "Noah"],
});

// ---- SSE fan-out ---------------------------------------------------------
const clients = new Set();
function broadcast() {
  const payload = `data: ${JSON.stringify(publicState(game))}\n\n`;
  for (const res of clients) res.write(payload);
}

// ---- tool handlers -------------------------------------------------------
// Each returns { message, state } so Buck can read the result back to the user.
const tools = {
  record_play: (b) => recordPlay(game, b),
  record_pitch: (b) => recordPitch(game, b.type),
  set_count: (b) => setCount(game, b.balls, b.strikes),
  record_out: (b) => recordOut(game, b.outs ?? 1),
  next_inning: () => nextHalfInning(game),
  end_game: () => endGame(game),
  adjust_score: (b) => manualScore(game, b.team, Number(b.runs)),
  set_lineup: (b) => setLineup(game, b.side, b.players || []),
  set_bases: (b) => setBases(game, b.first, b.second, b.third),
  reset_game: () => {
    // Start fresh but keep the same teams and batting orders (names + numbers).
    const lineup = (t) => t.players.map((p) => ({ name: p.name, number: p.number }));
    game = createGame({
      homeName: game.home.name, awayName: game.away.name,
      homeLineup: lineup(game.home), awayLineup: lineup(game.away),
    });
    return { message: "New game — same teams, score and stats reset.", state: publicState(game) };
  },
  undo: () => undo(game),
  game_recap: () => ({ message: gameRecap(game).narration, state: publicState(game) }),
  get_game_state: () => ({ message: describe(game), state: publicState(game) }),
  get_player_stats: (b) => {
    const s = playerStats(game, b.name);
    return {
      message: s ? statLine(b.name, s) : `No stats found for ${b.name}.`,
      state: publicState(game),
    };
  },
  new_game: (b) => {
    game = createGame(b || {});
    return { message: "New game started.", state: publicState(game) };
  },
};

function describe(g) {
  const s = publicState(g);
  const half = s.half === "top" ? "Top" : "Bottom";
  return `${s.score.away}-${s.score.home}. ${half} of inning ${s.inning}, ${s.outs} out(s), count ${s.count.balls}-${s.count.strikes}. ${g.away.name} (away) vs ${g.home.name} (home).`;
}
function statLine(name, s) {
  return `${name}: ${s.h}-for-${s.ab}, ${s.rbi} RBI, ${s.r} run(s), avg ${s.avg}.`;
}

// ---- HTTP plumbing -------------------------------------------------------
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

function send(res, code, body, headers = {}) {
  res.writeHead(code, { "Access-Control-Allow-Origin": "*", ...headers });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString() || "{}");
  } catch {
    return {};
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  if (req.method === "OPTIONS") {
    return send(res, 204, "", {
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,x-tool-secret",
    });
  }

  // Live state stream for the scoreboard.
  if (path === "/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    res.write(`data: ${JSON.stringify(publicState(game))}\n\n`);
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }

  // Tool endpoint: POST /tools/<name>  (this is what the agent calls)
  if (path.startsWith("/tools/") && req.method === "POST") {
    const name = path.slice("/tools/".length);
    const handler = tools[name];
    if (!handler) return send(res, 404, JSON.stringify({ error: `Unknown tool ${name}` }), { "Content-Type": "application/json" });
    if (TOOL_SECRET && req.headers["x-tool-secret"] !== TOOL_SECRET) {
      return send(res, 401, JSON.stringify({ error: "Bad tool secret" }), { "Content-Type": "application/json" });
    }
    // Napster sends tool args as { ...arguments }. Accept either the raw args
    // or a { data: {...} } / { arguments: {...} } envelope, to be forgiving.
    const raw = await readBody(req);
    const args = raw.arguments || raw.data || raw;
    try {
      const result = handler(args);
      broadcast();
      return send(res, 200, JSON.stringify(result), { "Content-Type": "application/json" });
    } catch (err) {
      return send(res, 400, JSON.stringify({ error: String(err.message || err) }), { "Content-Type": "application/json" });
    }
  }

  // Mint a fresh Napster session token for the browser SDK (one-click connect).
  if (path === "/api/token") {
    // Gate session creation too — it spends Napster minutes, so don't let
    // anonymous visitors open avatar sessions on a public host.
    if (TOOL_SECRET && req.headers["x-tool-secret"] !== TOOL_SECRET) {
      return send(res, 401, JSON.stringify({ error: "Operator key required." }), { "Content-Type": "application/json" });
    }
    // Re-read .agent.json each call so re-running `npm run setup` (new agent /
    // updated instructions) takes effect without restarting the server.
    let agentId = AGENT_ID;
    try {
      agentId = JSON.parse(readFileSync(new URL("../.agent.json", import.meta.url))).agentId || AGENT_ID;
    } catch {}
    if (!API_KEY || !agentId) {
      return send(res, 503, JSON.stringify({
        error: "Agent not configured. Run `npm run setup`, then start the server with `npm run start:env`.",
      }), { "Content-Type": "application/json" });
    }
    const channel = url.searchParams.get("channel") || "webrtc";
    try {
      const r = await fetch(`${NAPSTER_API}/agents/${agentId}/connections`, {
        method: "POST",
        headers: { "X-Api-Key": API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ channelType: channel }),
      });
      const b = await r.json().catch(() => ({}));
      const token = b.token || b.data?.token;
      if (!token) return send(res, 502, JSON.stringify({ error: "No token from Napster", detail: b }), { "Content-Type": "application/json" });
      return send(res, 200, JSON.stringify({ token, channel }), { "Content-Type": "application/json" });
    } catch (e) {
      return send(res, 502, JSON.stringify({ error: String(e.message || e) }), { "Content-Type": "application/json" });
    }
  }

  // Read-only state for quick polling / debugging.
  if (path === "/api/state") {
    return send(res, 200, JSON.stringify(publicState(game)), { "Content-Type": "application/json" });
  }

  // Full printable scorecard data (per batter × per inning + totals).
  if (path === "/api/scoresheet") {
    return send(res, 200, JSON.stringify(scoresheet(game)), { "Content-Type": "application/json" });
  }

  // Static files.
  if (req.method === "GET") {
    const file = path === "/" ? "index.html" : path.replace(/^\/+/, "");
    try {
      const data = await readFile(join(PUBLIC_DIR, file));
      return send(res, 200, data, { "Content-Type": MIME[extname(file)] || "application/octet-stream" });
    } catch {
      return send(res, 404, "Not found");
    }
  }

  send(res, 404, "Not found");
});

server.listen(PORT, () => {
  console.log(`\n  🏟️  Buck the Scorekeeper running at http://localhost:${PORT}`);
  console.log(`     Tool endpoints:  POST http://localhost:${PORT}/tools/<name>`);
  console.log(`     Live state SSE:  GET  http://localhost:${PORT}/events\n`);
});
