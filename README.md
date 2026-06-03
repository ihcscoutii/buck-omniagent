# ⚾ Buck — the AI Little League Announcer & Scorekeeper

Prop a phone on the fence and just **talk to the game**:

> "Tommy hit a double, two runs scored."

**Buck** — a charismatic animated baseball-announcer avatar (Napster Companion API) — calls
back with live play-by-play and quietly keeps the official score:

> "And Tommy ROPES one into the gap — two come around to score! 4–2 Tigers, bottom of the 3rd!"

…while a live **scoreboard, line score, base diamond, play-by-play ticker, and per-player box
scores** update in real time on screen.

Built for the hackathon. Zero npm dependencies for the core — `node src/server.js` just runs.

---

## What it shows off

- **Voice-in / avatar-out** real-time agent (Napster WebRTC video or WebSocket voice).
- **Tool/function calling → a real stateful backend.** Buck calls `record_play`, `record_pitch`,
  `undo`, `get_player_stats`, etc. (explicit flow) against this server.
- **Full count tracking** — call pitches ("ball", "strike", "foul") and the count auto-advances
  to a walk on ball four / strikeout on strike three. Balls • Strikes • Outs on screen.
- **Pre-game lineup entry** — enter each team's batting order with numbers before first pitch.
- **Printable official score sheet** — a traditional per-batter × per-inning grid (with R/H
  per inning and AB/R/H/RBI/BB/K/AVG totals) at `/scoresheet.html`, print-styled.
- **Live UI sync** over Server-Sent Events.
- **Hands-free + correctable** — `undo` rewinds a single pitch *or* a whole play.

## How this uses the Napster Omniagent API

Submitted to the **Omniagent API Hackathon** (category: *Most creative use of voice + video*).

- **Voice in** — the scorekeeper talks naturally ("ball… strike… he doubles, two score"); Buck
  parses live game events from speech.
- **Video avatar out** — Buck is a visible, lip-synced announcer who reacts in real time
  (celebrating a homer, calling the final out), embedded via the WebRTC Web SDK.
- **Agentic tool calling → a real stateful backend** — Buck invokes `record_pitch`,
  `record_play`, `undo`, `game_recap`, etc. (explicit flow) against this server, which is the
  official source of truth for the score, the box score, and the printable sheet.
- **Hands-free by design** — the whole point is a coach/parent who can't touch a screen mid-game.
  Voice + a live avatar is the *only* interface that fits; a chat box wouldn't.

## Judging-rubric map

| Criterion (weight) | Where to look |
|---|---|
| **Use of the API (30%)** | Real-time voice + visible video avatar + tool-driven backend — a hands-free use case that *needs* multimodal presence, not a text box. |
| **Technical execution (25%)** | Pure tested engine (`src/game.js`, `npm test`), zero-dep server, snapshot-based `undo`, auto count→walk/K, SSE live sync, graceful manual fallback. |
| **Creativity (25%)** | An AI play-by-play announcer that *also* keeps the official scorebook — and signs off with a Player-of-the-Game recap. |
| **Presentation (20%)** | See `SUBMISSION.md` for the 60-second demo script; printable score sheet at `/scoresheet.html`. |

## Architecture

```
  You (voice)  ─►  Buck (Napster agent)  ─►  POST /tools/<name>  ─►  game engine (src/game.js)
                                                                          │
   Scoreboard UI  ◄──  Server-Sent Events (/events)  ◄──────────────  state broadcast
```

- `src/game.js` — pure game + stats engine (snapshots → bulletproof `undo`). Tested.
- `src/server.js` — zero-dep HTTP server: tool endpoints + SSE + static UI.
- `src/setup-napster.js` — registers Buck's tools/companion/agent and opens a session.
- `public/` — the scoreboard UI + Napster Web SDK avatar mount.

## Run it (no API key needed)

```bash
node src/server.js
# open http://localhost:3000
```

Use the **Manual control** panel to drive the game (Single / HR / K / Undo / …) and watch the
scoreboard update live. This is the demo-safe fallback if Wi-Fi is flaky.

```bash
npm test   # game-engine sanity checks
```

## Wire up Buck (the avatar)

1. Get a `NAPSTER_API_KEY` (Azure Portal → Napster Companion API resource), copy `.env.example` → `.env`.
2. Expose your local server so Napster can reach the tool endpoints:
   ```bash
   ngrok http 3000        # → set PUBLIC_TOOL_URL in .env to the https URL
   ```
3. Register Buck and open a session:
   ```bash
   npm run setup          # prints a connection token
   ```
4. Start the server, open the UI, paste the token into **Connect Buck**, and start talking.

Set `CHANNEL=websocket` in `.env` for a voice-only Buck, or `webrtc` for the video avatar.

## Tools Buck can call

| Tool | Purpose |
|------|---------|
| `record_play` | Hit / out / walk + runs + RBIs; advances lineup & bases |
| `record_pitch` | One pitch (ball/strike/foul); auto walk on ball 4, K on strike 3 |
| `set_count` | Set the ball-strike count directly |
| `record_out` | Plain out(s) |
| `next_inning` | Advance half-inning |
| `adjust_score` | Fix a team's run total |
| `set_lineup` / `new_game` | Set a team's batting order / start a fresh game with lineups |
| `undo` | Revert the last pitch or play |
| `end_game` | Mark the game final |
| `game_recap` | Final score + Player of the Game, for Buck to narrate |
| `get_game_state` / `get_player_stats` | Read score / a player's line |

The printable score sheet pulls from `GET /api/scoresheet` (per-batter × per-inning grid + totals).

## Demo script (60 seconds)

1. Open **Lineups & new game**, paste numbered batting orders, **Start new game**.
2. "Ball… ball… strike… ball… ball four — he walks." → count climbs, then Tommy takes first.
3. "Mia hits a two-run homer!" → score jumps, diamond clears, Buck reacts.
4. "How's Mia doing?" → Buck reads her line.
5. "Wait, scratch that homer." → `undo`, score reverts.
6. "That's the ballgame!" → `end_game`; Buck delivers the recap + **Player of the Game** card.
7. Click **Open printable score sheet** → the full per-inning grid, ready to print.
