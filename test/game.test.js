// Minimal sanity checks for the game engine. Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createGame,
  recordPlay,
  recordPitch,
  setCount,
  recordOut,
  undo,
  nextHalfInning,
  publicState,
  scoresheet,
  gameRecap,
  endGame,
  setBases,
  addBatter,
  editBatter,
  stealBase,
  currentBatter,
  playerStats,
} from "../src/game.js";

function game() {
  return createGame({
    homeName: "Tigers",
    awayName: "Sharks",
    awayLineup: ["Tommy", "Mia", "Jo"],
    homeLineup: ["Sam", "Ana", "Lee"],
  });
}

test("away bats in the top of the 1st", () => {
  const g = game();
  assert.equal(g.half, "top");
  assert.equal(currentBatter(g).name, "Tommy");
});

test("single puts batter on first and advances lineup", () => {
  const g = game();
  recordPlay(g, { result: "single" });
  assert.equal(g.bases[0], "Tommy");
  assert.equal(currentBatter(g).name, "Mia");
  assert.equal(playerStats(g, "Tommy").h, 1);
  assert.equal(playerStats(g, "Tommy").ab, 1);
});

test("home run with runners scores everyone", () => {
  const g = game();
  recordPlay(g, { result: "single" }); // Tommy on 1B
  recordPlay(g, { result: "home_run" }); // Mia
  assert.equal(g.score.away, 2);
  assert.deepEqual(g.bases, [null, null, null]);
  assert.equal(playerStats(g, "Mia").rbi, 2);
  assert.equal(playerStats(g, "Mia").r, 1);
  assert.equal(playerStats(g, "Tommy").r, 1);
});

test("walks don't count as at-bats", () => {
  const g = game();
  recordPlay(g, { result: "walk" });
  assert.equal(playerStats(g, "Tommy").ab, 0);
  assert.equal(playerStats(g, "Tommy").bb, 1);
  assert.equal(g.bases[0], "Tommy");
});

test("three outs flips to the bottom half", () => {
  const g = game();
  recordPlay(g, { result: "strikeout" });
  recordPlay(g, { result: "groundout" });
  recordPlay(g, { result: "flyout" });
  assert.equal(g.half, "bottom");
  assert.equal(g.outs, 0);
  assert.equal(currentBatter(g).name, "Sam");
});

test("the inning-ending play is logged in the half it ended, not the next", () => {
  const g = game();
  recordPlay(g, { result: "strikeout" });
  recordPlay(g, { result: "strikeout" });
  recordPlay(g, { result: "strikeout" }); // 3rd out flips to the bottom
  assert.equal(g.half, "bottom"); // game has advanced
  const lastOut = g.log.at(-1);
  assert.equal(lastOut.half, "top"); // ...but the strikeout belongs to the top
  assert.equal(lastOut.inning, 1);
});

test("undo reverts the last play exactly", () => {
  const g = game();
  recordPlay(g, { result: "double", runsScored: 0 });
  const before = JSON.stringify(publicState(g));
  recordPlay(g, { result: "home_run" });
  undo(g);
  assert.equal(JSON.stringify(publicState(g)), before);
});

test("explicit runsScored on a sac fly credits the runner and clears the base", () => {
  const g = game();
  recordPlay(g, { result: "triple" }); // Tommy to 3B
  recordPlay(g, { result: "flyout", runsScored: 1, rbi: 1 }); // sac fly, Tommy scores
  assert.equal(g.score.away, 1);
  assert.equal(playerStats(g, "Mia").rbi, 1);
  assert.equal(playerStats(g, "Tommy").r, 1); // runner's run is credited
  assert.deepEqual(g.bases, [null, null, null]); // and he leaves the bases
});

test("an HBP runner who scores later is credited and removed from the bases", () => {
  const g = game(); // Tommy, Mia, Jo
  recordPlay(g, { result: "hbp" }); // Tommy to 1B (no AB, no run yet)
  assert.equal(playerStats(g, "Tommy").r, 0);
  recordPlay(g, { result: "single" }); // Mia singles -> Tommy to 2B
  recordPlay(g, { result: "single", runsScored: 1 }); // Jo singles, Tommy scores
  assert.equal(g.score.away, 1);
  assert.equal(playerStats(g, "Tommy").r, 1); // the reported bug: now credited
  assert.ok(!g.bases.includes("Tommy")); // and off the bases
});

test("four balls is a walk and resets the count", () => {
  const g = game();
  recordPitch(g, "ball");
  recordPitch(g, "ball");
  recordPitch(g, "ball");
  assert.deepEqual(publicState(g).count, { balls: 3, strikes: 0 });
  recordPitch(g, "ball");
  assert.deepEqual(publicState(g).count, { balls: 0, strikes: 0 });
  assert.equal(g.bases[0], "Tommy");
  assert.equal(playerStats(g, "Tommy").bb, 1);
});

test("three strikes is a strikeout; fouls don't go past two strikes", () => {
  const g = game();
  recordPitch(g, "foul");
  recordPitch(g, "foul");
  recordPitch(g, "foul"); // still 0-2
  assert.deepEqual(publicState(g).count, { balls: 0, strikes: 2 });
  recordPitch(g, "swinging_strike");
  assert.equal(g.outs, 1);
  assert.equal(playerStats(g, "Tommy").k, 1);
});

test("undo reverts a single pitch", () => {
  const g = game();
  recordPitch(g, "strike");
  recordPitch(g, "ball");
  undo(g);
  assert.deepEqual(publicState(g).count, { balls: 0, strikes: 1 });
});

test("scoresheet records per-batter per-inning at-bats", () => {
  const g = game();
  recordPlay(g, { result: "single" }); // Tommy, inning 1
  recordPlay(g, { result: "home_run" }); // Mia, inning 1
  const sheet = scoresheet(g);
  assert.equal(sheet.away.rows[0].cells[1][0].abbr, "1B");
  assert.equal(sheet.away.rows[1].cells[1][0].abbr, "HR");
  assert.equal(sheet.away.perInning[0].runs, 2);
  assert.equal(sheet.away.perInning[0].hits, 2);
});

test("a walk does not advance an unforced runner", () => {
  const g = game();
  recordPlay(g, { result: "double" }); // Tommy to 2B (unforced by a later walk)
  recordPlay(g, { result: "walk" }); // Mia walks -> Tommy stays on 2B
  assert.equal(g.bases[0], "Mia"); // 1B
  assert.equal(g.bases[1], "Tommy"); // 2B unchanged
  assert.equal(g.bases[2], null); // 3B empty
  assert.equal(g.score.away, 0);
});

test("a bases-loaded walk forces in exactly one run", () => {
  const g = game(); // lineup: Tommy, Mia, Jo
  recordPlay(g, { result: "single" }); // Tommy 1B
  recordPlay(g, { result: "walk" }); // Mia: [Mia, Tommy, -]
  recordPlay(g, { result: "walk" }); // Jo: [Jo, Mia, Tommy] bases loaded
  recordPlay(g, { result: "walk" }); // Tommy: forces Tommy home
  assert.equal(g.score.away, 1);
  assert.deepEqual(g.bases, ["Tommy", "Jo", "Mia"]);
});

test("setBases overrides the base runners", () => {
  const g = game();
  recordPlay(g, { result: "single" });
  setBases(g, "Mia", "", "Jo");
  assert.deepEqual(g.bases, ["Mia", null, "Jo"]);
});

test("addBatter appends mid-game without resetting stats", () => {
  const g = game(); // away: Tommy, Mia, Jo
  recordPlay(g, { result: "single" }); // Tommy 1-for-1
  addBatter(g, "away", "Ken", 24);
  const names = g.away.players.map((p) => p.name);
  assert.deepEqual(names, ["Tommy", "Mia", "Jo", "Ken"]);
  assert.equal(playerStats(g, "Tommy").h, 1); // existing stats preserved
  assert.equal(playerStats(g, "Ken").number, 24);
});

test("editBatter renames/renumbers by index, keeping stats", () => {
  const g = game();
  recordPlay(g, { result: "single" }); // Tommy gets a hit
  editBatter(g, "away", 0, { name: "Thomas", number: 7 });
  assert.equal(g.away.players[0].name, "Thomas");
  assert.equal(g.away.players[0].number, 7);
  assert.equal(g.away.players[0].h, 1); // stat survived the rename
});

test("stealBase advances the runner and credits a SB", () => {
  const g = game();
  recordPlay(g, { result: "single" }); // Tommy on 1B
  stealBase(g, 1); // steals second
  assert.deepEqual(g.bases, [null, "Tommy", null]);
  assert.equal(playerStats(g, "Tommy").sb, 1);
});

test("stealing home scores a run", () => {
  const g = game();
  recordPlay(g, { result: "triple" }); // Tommy to 3B
  stealBase(g, 3); // steal of home
  assert.equal(g.score.away, 1);
  assert.equal(playerStats(g, "Tommy").sb, 1);
  assert.equal(playerStats(g, "Tommy").r, 1);
  assert.deepEqual(g.bases, [null, null, null]);
});

test("recap names a player of the game and final headline", () => {
  const g = game();
  recordPlay(g, { result: "single" }); // Tommy
  recordPlay(g, { result: "home_run" }); // Mia, 2 RBI
  endGame(g);
  const r = gameRecap(g);
  assert.equal(r.final, true);
  assert.equal(r.playerOfGame.name, "Mia");
  assert.match(r.narration, /Player of the game: Mia/);
  assert.match(r.headline, /Final:/);
});

test("line score tracks runs per inning", () => {
  const g = game();
  recordPlay(g, { result: "home_run" });
  nextHalfInning(g); // to bottom 1
  recordPlay(g, { result: "home_run" });
  const s = publicState(g);
  const first = s.lineScore.find((c) => c.inning === 1);
  assert.equal(first.top, 1);
  assert.equal(first.bottom, 1);
});
