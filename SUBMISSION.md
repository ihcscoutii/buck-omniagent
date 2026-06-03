# Submission — Buck, the AI Little League Announcer & Scorekeeper

**Omniagent API Hackathon** · Target category: **Most creative use of voice + video**
(also a Wild Card contender)

> ⏰ **Deadline: June 7, 23:59 PT.** Email GitHub repo + 60-second demo video + this
> description to **hackathon@napster.com**. Submissions are final after that.

---

## One-liner

Prop a phone on the dugout fence and *talk* to the game — Buck, a charismatic animated
Napster announcer, gives live play-by-play **and** keeps the official scorebook, hands-free.

## Description (paste into the submission email)

Scoring a kids' baseball game is annoying: you're either heads-down in a clunky scoring app or
scribbling on paper while missing the actual game. Buck fixes that with the one interface that
actually fits the situation — **your voice, and a face that talks back**.

Buck is a Napster Omniagent: a lip-synced video announcer you embed via the WebRTC Web SDK. You
just narrate what happens — *"ball… strike… he doubles, two come around to score"* — and Buck
(1) calls energetic, kid-friendly play-by-play in real time, and (2) silently keeps the official
record by calling agentic tools against a backend game engine. A live scoreboard, base diamond,
ball-strike-out count, per-player box scores, and a traditional **printable per-inning score
sheet** all stay in sync. When the game ends, Buck signs off with a **Player-of-the-Game** recap.

Why it needs the Omniagent API specifically: this only works as **real-time voice + visible
video presence**. A coach coaching first base can't tap a screen — but they can talk, and a
glanceable avatar reacting on the dugout tablet is the experience. Tool calling turns Buck's
understanding of the game into an authoritative, correctable scorebook (with single-pitch and
single-play `undo`, because voice scorekeeping is messy). It's a real, shippable use case wearing
a fun face.

**Tech:** zero-dependency Node server (game engine + tool endpoints + Server-Sent-Events live
sync), tested pure-JS scoring engine (counts → automatic walks/strikeouts, base running, RBIs,
line score, box score), Napster Companion Web SDK for the avatar. `node src/server.js` just runs.

**Links**
- GitHub repo: `<PASTE PUBLIC REPO URL>`
- Demo video (60s): `<PASTE VIDEO URL>`

---

## 60-second demo video — script & shot list

Keep it tight; **show the avatar talking and the scoreboard moving on screen at the same time.**
Record the avatar live (real Napster session) for the strongest "Use of the API" impression.

| Time | On screen | You say / what happens |
|---|---|---|
| 0:00–0:06 | Scoreboard + Buck avatar, "Now batting" banner | "This is Buck — an AI announcer that keeps score for little-league games. You just talk." |
| 0:06–0:16 | Speak a few pitches; B/S count climbs | "Ball… strike… foul…" → count updates live; Buck banters ("Full count, here's the pitch!") |
| 0:16–0:26 | Say the result | "He doubles — two runs score!" → diamond + line score + box score jump; Buck calls it with energy |
| 0:26–0:34 | Ask a question | "How's Mia doing today?" → Buck reads her batting line aloud (`get_player_stats`) |
| 0:34–0:42 | Make a mistake on purpose | "Wait — scratch that, it was a single." → `undo`; score visibly reverts. (Shows it's correctable.) |
| 0:42–0:52 | End the game | "That's the ballgame!" → Buck delivers the recap + **Player of the Game** card animates in |
| 0:52–0:60 | Click → printable score sheet | "And here's the official score sheet, per inning, ready to print." (Quick pan over the grid.) |

**Recording tips**
- 1080p, landscape. Capture system audio (Buck's voice) + your mic.
- Do a dry run first so the pitch/play beats land on time.
- If Wi-Fi is risky, the **Manual control** buttons reproduce every beat without a live session —
  but record at least the avatar talking once for the API-usage score.

---

## Pre-submission checklist

- [ ] Registered for the hackathon (you have the scoped API key)
- [ ] `git init`, first commit, push to a **public** GitHub repo
- [ ] Replace `<PASTE PUBLIC REPO URL>` / `<PASTE VIDEO URL>` above
- [ ] Live test: `npm run setup` → paste token → talk to Buck end-to-end
- [ ] `npm test` passes
- [ ] Record + upload the 60-second video (YouTube/Loom unlisted is fine)
- [ ] Confirm everything is **your own work** (individual entry)
- [ ] Email repo + video + description to **hackathon@napster.com** before **June 7, 23:59 PT**
