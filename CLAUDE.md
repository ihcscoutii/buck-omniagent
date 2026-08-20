# Buck — AI Little League Announcer & Scorekeeper

An Omniagent API Hackathon project (won its category). A coach/parent talks naturally about a
live baseball game ("Tommy hit a double, two runs scored") to **Buck**, a lip-synced Napster
avatar, who calls energetic play-by-play back while silently keeping the official scorebook via
tool calls against this backend.

## Architecture

```
You (voice) → Buck (Napster agent) → POST /tools/<name> → game engine (src/game.js)
                                                                  │
 Scoreboard UI ← Server-Sent Events (/events) ← state broadcast
```

- `src/game.js` — pure game/stats engine, **no I/O**. Every mutating export takes the plain
  `game` object (mutated in place, not returned) and returns `{ message, state }` via
  `summarize()`. Zero external deps.
- `src/server.js` — zero-dependency `node:http` server. Three jobs: serve `public/`, expose
  `POST /tools/<name>` (what Buck calls), and stream state over SSE at `/events`. Holds the one
  live `game` instance in module state (single game at a time, no persistence/DB).
- `src/setup-napster.js` — one-shot script: registers/upserts Buck's tool definitions,
  companion, and agent against the Napster Companion API, writes `.agent.json` (gitignored).
  **Upserts by name** (POST, falls back to PUT on 409) and **PATCHes the existing agent in
  place** so `AGENT_ID` never changes when tools/instructions are edited — don't change that to
  "always create a new agent."
- `src/connect.js` — mints a connection token standalone (`npm run token`).
- `public/` — scoreboard UI (`index.html`/`app.js`/`styles.css`, polls `/events` via SSE) and a
  print-styled per-inning score sheet (`scoresheet.html`/`sheet.js`/`sheet.css`, reads
  `GET /api/scoresheet`).
- `test/game.test.js` — engine tests via node's built-in `node:test` + `node:assert/strict`.

## Core engine invariants (`src/game.js`)

- **Snapshot-based undo.** Every mutating action calls `snapshot(game)` (structuredClone, capped
  at 200 entries in `game._history`) *before* mutating, so `undo()` can restore prior state
  wholesale. When adding a new mutating export, snapshot first and pop `game._history` on early
  error-throws (see existing functions for the pattern) so a failed call doesn't leave a stray
  snapshot.
- **`recordPitch` auto-resolves the count** — ball four calls `applyPlay(game, {result:"walk"})`
  internally and strike three calls strikeout; `applyPlay` is the un-snapshotted inner half of
  `recordPlay` specifically so this doesn't double-snapshot. Don't call `record_play` for the
  walk/strikeout that `record_pitch` just produced — the Napster system prompt in
  `setup-napster.js` explicitly tells Buck this.
- **Runs are reconciled in one place** at the end of `applyPlay`: if the caller-supplied
  `runsScored` exceeds what the base-advance model moved home, `takeLeadRunners()` pulls the
  difference off the bases (3rd → 2nd → 1st) so team score, per-player runs, and base state never
  disagree. Keep new result types flowing through this same path rather than mutating
  `game.score` directly (use `addRuns`/`creditRun`).
- **`publicState(game)`** is the only shape sent to the UI/SSE/tool responses — it's the
  contract Buck and the frontend both read. If you add fields the UI or Buck needs, add them here
  (and keep it JSON-serializable; it strips `_history`).
- Result/pitch-type strings are the vocabulary shared across `game.js`, `server.js`'s tool
  dispatch, and the `enum`s in `setup-napster.js`'s tool defs — if you add a new play result,
  update `HIT_RESULTS`/`OUT_RESULTS`/`REACH_RESULTS`/`ABBR`/`BASES_FOR` in `game.js` **and** the
  matching `enum`/description in `setup-napster.js`, then re-run `npm run setup`.

## Server conventions (`src/server.js`)

- Tool dispatch is a flat `{ name: (body) => result }` map (`tools`), matched to `POST
  /tools/<name>`. Every tool handler returns what its `game.js` call returns; the server then
  `broadcast()`s the new state over SSE.
- Napster wraps args as `{ arguments: {...} }` or `{ data: {...} }`; `readBody` accepts either or
  raw args directly — keep that forgiving unwrap if touching request parsing.
- `TOOL_SECRET` (via `x-tool-secret` header) gates **writes only**: `/tools/*` and `/api/token`.
  Reads (`/events`, `/api/state`, `/api/scoresheet`, static files) stay open so spectators can
  watch without a key. Don't add auth to the read endpoints.
- `/api/token` mints short-lived Napster session tokens server-side on demand — the
  `NAPSTER_API_KEY` never reaches the browser. It re-reads `.agent.json` on every call (not just
  at boot) so re-running `npm run setup` takes effect without a server restart.

## Commands

```bash
node src/server.js          # or: npm start / npm run dev (--watch)
npm test                     # node --test, runs test/game.test.js
npm run setup                 # registers tools/agent with Napster, writes .agent.json
npm run token                  # mints a standalone connection token
```

No build step, no bundler, no npm dependencies for the runtime (`type: module`, Node >= 20).

## Config (`.env`, see `.env.example`)

`NAPSTER_API_KEY`, `PUBLIC_TOOL_URL` (must be publicly reachable by Napster — tunnel with ngrok
locally), `TOOL_SECRET`, `AGENT_ID` (prod fallback when `.agent.json` isn't deployed), `VOICE_ID`,
`CHANNEL` (`webrtc` for video avatar vs `websocket` for voice-only), `PORT`.

`.agent.json` and `.env` are gitignored — never commit real keys/secrets.

## Deployment

Targets Azure App Service (Linux, Node 24) — see `DEPLOY.md`. The app already reads config from
env vars and `process.env.PORT`, so no code changes are needed to deploy. After changing
`PUBLIC_TOOL_URL` or `TOOL_SECRET`, **re-run `npm run setup`** (it upserts the tools so the new
URL/secret take effect) and update the matching Azure App Settings.

## Project status

This is a completed, judged hackathon submission (see `SUBMISSION.md` for the pitch/demo script —
historical, not a live TODO list). The user won the hackathon and is now resuming development on
their own Napster account once new API credits arrive. Until then, live Napster
testing (`npm run setup`, real voice/avatar sessions) is blocked, but engine/UI/test work can
proceed normally against the manual-control fallback in the UI.

## Style notes observed in this codebase

- Comments explain *why*, not what (e.g. why a snapshot happens before vs. after a mutation).
  Match that density — sparse, load-bearing comments only.
- No TypeScript, no framework, no build tooling. Keep additions dependency-free unless there's a
  strong reason.
- Error handling: throw plain `Error`s with human-readable messages from `game.js`; `server.js`
  catches and returns them as `{ error }` with 400/401/404/502/503 as appropriate. Buck reads
  `message` fields aloud, so keep tool-return messages short and speakable.
