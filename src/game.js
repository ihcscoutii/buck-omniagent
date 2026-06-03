// Little League game engine — pure state + stats logic, no I/O.
// The Napster agent ("Buck") calls the tool endpoints in server.js, which
// drive this engine. Every mutating action snapshots state so `undo()` is
// bulletproof (voice scorekeeping produces plenty of "wait, no" moments).

const HIT_RESULTS = new Set(["single", "double", "triple", "home_run"]);
const OUT_RESULTS = new Set([
  "strikeout",
  "groundout",
  "flyout",
  "lineout",
  "popout",
  "out",
]);
const REACH_RESULTS = new Set(["walk", "hbp", "error", "fielders_choice"]);

// Short notation for the printed scorecard grid (per at-bat cell).
const ABBR = {
  single: "1B", double: "2B", triple: "3B", home_run: "HR",
  walk: "BB", hbp: "HBP", error: "E", fielders_choice: "FC",
  strikeout: "K", groundout: "GO", flyout: "FO", lineout: "LO",
  popout: "PO", out: "OUT",
};
function abbrFor(result) {
  return ABBR[result] || result.toUpperCase();
}

// Bases earned by the batter on a clean hit (used to auto-advance runners
// when the scorekeeper doesn't dictate exact base running).
const BASES_FOR = {
  single: 1,
  double: 2,
  triple: 3,
  home_run: 4,
  walk: 1,
  hbp: 1,
  error: 1,
  fielders_choice: 1,
};

function newPlayer(name, number) {
  return {
    name,
    number: number ?? null,
    ab: 0, // official at-bats (excludes walks/hbp/sac)
    h: 0,
    singles: 0,
    doubles: 0,
    triples: 0,
    hr: 0,
    rbi: 0,
    r: 0, // runs scored
    bb: 0,
    k: 0,
  };
}

function newTeam(name, players = []) {
  return {
    name,
    players: players.map((p) =>
      typeof p === "string" ? newPlayer(p) : newPlayer(p.name, p.number)
    ),
    battingIndex: 0,
  };
}

export function createGame({
  homeName = "Home",
  awayName = "Away",
  homeLineup = [],
  awayLineup = [],
  innings = 6, // little league regulation is often 6
} = {}) {
  return {
    home: newTeam(homeName, homeLineup),
    away: newTeam(awayName, awayLineup),
    regulationInnings: innings,
    inning: 1,
    half: "top", // "top" = away bats, "bottom" = home bats
    outs: 0,
    count: { balls: 0, strikes: 0 }, // live count for the batter at the plate
    bases: [null, null, null], // [1B, 2B, 3B] -> player name or null
    score: { home: 0, away: 0 },
    lineScore: [], // [{inning, top, bottom}]
    atBats: [], // completed plate appearances, for the scorecard grid
    log: [], // play-by-play entries {seq, text, ...}
    status: "in_progress", // "in_progress" | "final"
    _seq: 0,
    _history: [], // snapshots for undo
  };
}

// ---- helpers -------------------------------------------------------------

function battingTeam(game) {
  return game.half === "top" ? game.away : game.home;
}
function fieldingScoreKey(game) {
  return game.half === "top" ? "away" : "home";
}

export function currentBatter(game) {
  const team = battingTeam(game);
  if (team.players.length === 0) return null;
  return team.players[team.battingIndex % team.players.length];
}

function snapshot(game) {
  // structuredClone keeps undo dead simple and correct.
  const { _history, ...rest } = game;
  game._history.push(structuredClone(rest));
  if (game._history.length > 200) game._history.shift();
}

function logPlay(game, text, extra = {}) {
  game._seq += 1;
  game.log.push({
    seq: game._seq,
    inning: game.inning,
    half: game.half,
    text,
    ts: Date.now(),
    ...extra,
  });
}

function ensureLineScoreCell(game) {
  let cell = game.lineScore.find((c) => c.inning === game.inning);
  if (!cell) {
    cell = { inning: game.inning, top: 0, bottom: 0 };
    game.lineScore.push(cell);
  }
  return cell;
}

function addRuns(game, n) {
  if (n <= 0) return;
  const key = fieldingScoreKey(game); // team currently batting scores
  game.score[key] += n;
  const cell = ensureLineScoreCell(game);
  cell[game.half] += n;
}

// Advance runners by `bases`, scoring any who pass home. Returns runs scored
// by runners (not counting the batter). `batter` is placed on `batterBase`.
function advanceRunners(game, bases, batter, batterBase) {
  let runs = 0;
  const scorers = [];
  const next = [null, null, null];
  // Move existing runners.
  for (let i = 2; i >= 0; i--) {
    const runner = game.bases[i];
    if (!runner) continue;
    const newPos = i + bases; // 0->1B index... actually i is index, +bases
    if (newPos >= 3) {
      runs += 1;
      scorers.push(runner);
    } else {
      next[newPos] = runner;
    }
  }
  // Place batter (if they stay on base).
  if (batterBase !== null && batterBase <= 2) {
    next[batterBase] = batter;
  } else if (batterBase !== null && batterBase > 2) {
    runs += 1;
    scorers.push(batter);
  }
  game.bases = next;
  return { runs, scorers };
}

// Walk/HBP: only forced runners advance. Batter takes first; a runner advances
// only if every base behind them is occupied. Returns runs forced home.
function forceWalk(game, batterName) {
  let [b1, b2, b3] = game.bases;
  let runs = 0;
  const scorers = [];
  if (b1) {
    if (b2) {
      if (b3) { runs += 1; scorers.push(b3); } // bases loaded -> runner on 3rd forced home
      b3 = b2; // 2nd -> 3rd
    }
    b2 = b1; // 1st -> 2nd
  }
  b1 = batterName; // batter to first
  game.bases = [b1, b2, b3];
  return { runs, scorers };
}

function creditRun(game, playerName) {
  const team = battingTeam(game);
  const p = team.players.find((x) => x.name === playerName);
  if (p) p.r += 1;
}

// Remove up to k lead runners (3rd, then 2nd, then 1st) from the bases and
// return their names. Used to reconcile an explicit runsScored that's larger
// than what our auto-advance moved home, so player runs & bases stay correct.
function takeLeadRunners(game, k) {
  const scored = [];
  for (let i = 2; i >= 0 && k > 0; i--) {
    if (game.bases[i]) {
      scored.push(game.bases[i]);
      game.bases[i] = null;
      k -= 1;
    }
  }
  return scored;
}

// ---- public actions ------------------------------------------------------

// The headline tool. The scorekeeper says what happened; we trust explicit
// numbers when given and otherwise auto-advance runners. Snapshots for undo,
// then delegates to applyPlay so pitch-driven walks/Ks don't double-snapshot.
export function recordPlay(game, opts = {}) {
  if (game.status === "final") throw new Error("Game is already final.");
  snapshot(game);
  return applyPlay(game, opts);
}

function applyPlay(game, opts = {}) {
  if (game.status === "final") throw new Error("Game is already final.");

  const result = String(opts.result || "").toLowerCase();
  const team = battingTeam(game);
  const side = game.half === "top" ? "away" : "home";
  const paInning = game.inning; // capture before a 3rd out can flip the half
  const paHalf = game.half;
  const orderIndex = team.battingIndex; // batting slot, captured before advancing
  const batterName = opts.batter || currentBatter(game)?.name || "Batter";
  let batter = team.players.find((p) => p.name === batterName);
  if (!batter) {
    // Unknown batter named on the fly — add to the lineup so stats track.
    batter = newPlayer(batterName);
    team.players.push(batter);
  }

  let runsScored = Number.isFinite(opts.runsScored) ? opts.runsScored : null;
  let outsRecorded = 0;
  let scorers = []; // runners (and HR batter) our base model brought home
  let text = "";

  if (HIT_RESULTS.has(result)) {
    batter.ab += 1;
    batter.h += 1;
    if (result === "single") batter.singles += 1;
    if (result === "double") batter.doubles += 1;
    if (result === "triple") batter.triples += 1;
    if (result === "home_run") batter.hr += 1;

    const bases = BASES_FOR[result];
    // Base index the batter ends on: 1B=0, 2B=1, 3B=2, home=99 (scores).
    const batterBase = bases >= 4 ? 99 : bases - 1;
    const adv = advanceRunners(game, bases, batter.name, batterBase);
    scorers = adv.scorers; // includes the batter on a home run
    if (runsScored === null) runsScored = adv.runs;
    const label = { single: "a single", double: "a double", triple: "a triple", home_run: "a home run" }[result];
    text = `${batter.name} hits ${label}` + (runsScored ? `, ${runsScored} run(s) score` : "");
    batter.rbi += Number.isFinite(opts.rbi) ? opts.rbi : runsScored;
    advanceBatter(game);
  } else if (REACH_RESULTS.has(result)) {
    if (result === "walk") batter.bb += 1;
    // walk/hbp don't count as AB; error/FC do count as AB but no hit.
    if (result === "error" || result === "fielders_choice") batter.ab += 1;
    // Walks/HBP only force runners; errors/FC let everyone take a base.
    const forced = result === "walk" || result === "hbp";
    const adv = forced ? forceWalk(game, batter.name) : advanceRunners(game, 1, batter.name, 0);
    scorers = adv.scorers;
    if (runsScored === null) runsScored = adv.runs;
    if (runsScored) batter.rbi += Number.isFinite(opts.rbi) ? opts.rbi : (forced ? runsScored : 0);
    const label = { walk: "draws a walk", hbp: "is hit by pitch", error: "reaches on an error", fielders_choice: "reaches on a fielder's choice" }[result];
    text = `${batter.name} ${label}` + (runsScored ? `, ${runsScored} run(s) score` : "");
    advanceBatter(game);
  } else if (OUT_RESULTS.has(result)) {
    batter.ab += 1;
    if (result === "strikeout") batter.k += 1;
    outsRecorded = Number.isFinite(opts.outsOnPlay) ? opts.outsOnPlay : 1;
    // A run can still score on an out (sac fly, etc.) if the caller says so.
    if (runsScored === null) runsScored = 0;
    if (runsScored > 0) batter.rbi += Number.isFinite(opts.rbi) ? opts.rbi : runsScored;
    const label = { strikeout: "strikes out", groundout: "grounds out", flyout: "flies out", lineout: "lines out", popout: "pops out", out: "is out" }[result] || "is out";
    text = `${batter.name} ${label}`;
    if (runsScored > 0) text += `, ${runsScored} run(s) score`;
    // Advance the lineup for the batting team BEFORE outs may flip the half.
    advanceBatter(game);
    addOuts(game, outsRecorded, false);
  } else {
    game._history.pop();
    throw new Error(`Unknown result "${opts.result}".`);
  }

  // Reconcile runs in ONE place so the team score, each runner's run total, and
  // the bases never disagree. If more runs were reported than our model moved
  // home (e.g. a runner scores on a single, or a sac fly), bring the lead
  // runners around the bases to make up the difference.
  if (runsScored > scorers.length) {
    scorers = scorers.concat(takeLeadRunners(game, runsScored - scorers.length));
  }
  runsScored = Math.max(runsScored, scorers.length);
  scorers.forEach((s) => creditRun(game, s));
  if (runsScored > 0) addRuns(game, runsScored);

  // Record the completed plate appearance for the scorecard grid, stamped with
  // the inning/half it belongs to (capture before any half-flip from outs).
  game.atBats.push({
    seq: game._seq + 1,
    inning: paInning,
    half: paHalf,
    side,
    orderIndex,
    batter: batter.name,
    number: batter.number ?? null,
    result,
    abbr: abbrFor(result),
    isHit: HIT_RESULTS.has(result),
    rbi: Number.isFinite(opts.rbi) ? opts.rbi : (HIT_RESULTS.has(result) || result === "walk" || result === "hbp" ? runsScored : 0),
    runsScored,
    outsRecorded,
    pitches: { balls: game.count.balls, strikes: game.count.strikes },
  });

  game.count = { balls: 0, strikes: 0 }; // fresh count for the next batter
  // Stamp the log with the half the play happened in — a 3rd out may have just
  // flipped game.half, but this play still belongs to the half it ended.
  logPlay(game, text, { inning: paInning, half: paHalf, result, batter: batter.name, runsScored });
  return summarize(game, text);
}

// Record a single pitch and let the count drive automatic walks/strikeouts.
// types: ball | strike | called_strike | swinging_strike | foul
export function recordPitch(game, type) {
  if (game.status === "final") throw new Error("Game is already final.");
  snapshot(game);
  const t = String(type || "").toLowerCase();
  const c = game.count;

  if (t === "ball") {
    c.balls += 1;
    if (c.balls >= 4) return applyPlay(game, { result: "walk" }); // resets count
    logPlay(game, `Ball. Count ${c.balls}-${c.strikes}.`, { pitch: "ball" });
  } else if (t === "foul") {
    if (c.strikes < 2) c.strikes += 1; // a foul can't be strike three
    logPlay(game, `Foul ball. Count ${c.balls}-${c.strikes}.`, { pitch: "foul" });
  } else if (t === "strike" || t === "called_strike" || t === "swinging_strike") {
    c.strikes += 1;
    if (c.strikes >= 3) return applyPlay(game, { result: "strikeout" }); // resets count
    logPlay(game, `Strike. Count ${c.balls}-${c.strikes}.`, { pitch: "strike" });
  } else {
    game._history.pop();
    throw new Error(`Unknown pitch "${type}".`);
  }
  return summarize(game, `Count ${c.balls}-${c.strikes}.`);
}

// Set the count directly, e.g. "two balls, one strike".
export function setCount(game, balls, strikes) {
  snapshot(game);
  game.count = {
    balls: Math.max(0, Math.min(3, Number(balls) || 0)),
    strikes: Math.max(0, Math.min(2, Number(strikes) || 0)),
  };
  logPlay(game, `Count set to ${game.count.balls}-${game.count.strikes}.`);
  return summarize(game);
}

function advanceBatter(game) {
  const team = battingTeam(game);
  if (team.players.length > 0) {
    team.battingIndex = (team.battingIndex + 1) % team.players.length;
  }
}

// Add outs; flip half-innings (and game-over check) when we hit 3.
function addOuts(game, n = 1, takeSnapshot = true) {
  if (game.status === "final") throw new Error("Game is already final.");
  if (takeSnapshot) snapshot(game);
  const wasInning = game.inning, wasHalf = game.half; // for a correctly-stamped log
  game.outs += n;
  while (game.outs >= 3) {
    game.outs -= 3; // carry any overflow (shouldn't happen, but safe)
    flipHalf(game);
  }
  if (takeSnapshot) logPlay(game, `That's the out.`, { inning: wasInning, half: wasHalf });
}

export function recordOut(game, n = 1) {
  return summarize(game, `Out recorded.`, () => addOuts(game, n, true));
}

function flipHalf(game) {
  game.outs = 0;
  game.count = { balls: 0, strikes: 0 };
  game.bases = [null, null, null];
  if (game.half === "top") {
    game.half = "bottom";
  } else {
    game.half = "top";
    game.inning += 1;
  }
  checkGameOver(game);
}

export function nextHalfInning(game) {
  snapshot(game);
  game.outs = 0;
  flipHalf(game);
  logPlay(game, `Moving to the ${game.half} of inning ${game.inning}.`);
  return summarize(game);
}

function checkGameOver(game) {
  // Finalize once we've completed regulation and the game isn't tied.
  const completed = game.inning > game.regulationInnings;
  const homeWalkoff =
    game.inning >= game.regulationInnings &&
    game.half === "top" && // just finished bottom -> now top of next
    false;
  if (completed && game.score.home !== game.score.away) {
    game.status = "final";
  }
}

export function endGame(game) {
  snapshot(game);
  game.status = "final";
  logPlay(game, "Ballgame! That's the final out.");
  return summarize(game);
}

export function manualScore(game, team, runs) {
  snapshot(game);
  if (team !== "home" && team !== "away") throw new Error("team must be home/away");
  game.score[team] += runs;
  logPlay(game, `Adjusted ${game[team].name} score by ${runs}.`);
  return summarize(game);
}

// Manually set who is on each base (correction lever, like undo). Pass player
// names or empty/null for an empty base.
export function setBases(game, first, second, third) {
  snapshot(game);
  const norm = (v) => (v && String(v).trim() ? String(v).trim() : null);
  game.bases = [norm(first), norm(second), norm(third)];
  logPlay(game, `Bases set — 1B: ${game.bases[0] || "—"}, 2B: ${game.bases[1] || "—"}, 3B: ${game.bases[2] || "—"}.`);
  return summarize(game);
}

export function setLineup(game, side, names = []) {
  snapshot(game);
  if (side !== "home" && side !== "away") throw new Error("side must be home/away");
  game[side].players = names.map((n) =>
    typeof n === "string" ? newPlayer(n) : newPlayer(n.name, n.number)
  );
  game[side].battingIndex = 0;
  logPlay(game, `Set ${game[side].name} lineup (${game[side].players.length} batters).`);
  return summarize(game);
}

export function undo(game) {
  if (game._history.length === 0) {
    return summarize(game, "Nothing to undo.");
  }
  const prev = game._history.pop();
  const history = game._history;
  Object.keys(game).forEach((k) => {
    if (k !== "_history") delete game[k];
  });
  Object.assign(game, prev, { _history: history });
  return summarize(game, "Undid the last play.");
}

// Wrap a mutation that doesn't return its own summary.
function summarize(game, message, mutate) {
  if (typeof mutate === "function") mutate();
  return { message: message || "OK", state: publicState(game) };
}

export function playerStats(game, name) {
  const all = [...game.home.players, ...game.away.players];
  const p = all.find((x) => x.name.toLowerCase() === String(name).toLowerCase());
  if (!p) return null;
  return { ...p, avg: p.ab > 0 ? (p.h / p.ab).toFixed(3) : ".000" };
}

// A narratable wrap-up for the end of the game — the demo's closer. Picks a
// "Player of the Game" and builds a short recap Buck can read aloud.
export function gameRecap(game) {
  const a = game.score.away;
  const h = game.score.home;
  const tied = a === h;
  const awayWon = a > h;
  const winnerName = tied ? null : awayWon ? game.away.name : game.home.name;
  const loserName = tied ? null : awayWon ? game.home.name : game.away.name;
  const winnerSide = awayWon ? "away" : "home";

  // Offensive impact score; prefer the winning team's players on a tie-break.
  const score = (p, side) =>
    p.h + p.rbi + p.r + p.hr * 2 + (!tied && side === winnerSide ? 0.5 : 0);

  const candidates = [
    ...game.away.players.map((p) => ({ p, side: "away", team: game.away.name })),
    ...game.home.players.map((p) => ({ p, side: "home", team: game.home.name })),
  ].filter((c) => c.p.ab > 0 || c.p.bb > 0 || c.p.r > 0);

  candidates.sort((x, y) => score(y.p, y.side) - score(x.p, x.side));
  const mvp = candidates[0] || null;

  const fmtLine = (p) => {
    const bits = [`${p.h}-for-${p.ab}`];
    if (p.hr) bits.push(`${p.hr} HR`);
    if (p.rbi) bits.push(`${p.rbi} RBI`);
    if (p.r) bits.push(`${p.r} R`);
    return bits.join(", ");
  };

  const headline = tied
    ? `Final: ${game.away.name} ${a}, ${game.home.name} ${h} — all tied up.`
    : `Final: ${winnerName} ${Math.max(a, h)}, ${loserName} ${Math.min(a, h)}.`;

  let narration = headline;
  if (mvp) {
    narration += ` Player of the game: ${mvp.p.name}${mvp.p.number != null ? ` (#${mvp.p.number})` : ""} of the ${mvp.team} — ${fmtLine(mvp.p)}.`;
  }

  return {
    final: game.status === "final",
    headline,
    narration,
    winner: winnerName,
    tied,
    score: { ...game.score },
    playerOfGame: mvp
      ? { name: mvp.p.name, number: mvp.p.number ?? null, team: mvp.team, line: fmtLine(mvp.p), stats: { ...mvp.p } }
      : null,
    topPerformers: candidates.slice(0, 3).map((c) => ({
      name: c.p.name, team: c.team, line: fmtLine(c.p),
    })),
  };
}

// Full data for the printable scorecard: a per-batter × per-inning grid plus
// per-inning run/hit totals for each team.
export function scoresheet(game) {
  const innings = Math.max(game.lineScore.length, game.inning, game.regulationInnings);
  const fmtAvg = (p) => (p.ab > 0 ? (p.h / p.ab).toFixed(3).replace(/^0/, "") : ".000");

  const buildSide = (side) => {
    const team = game[side];
    const rows = team.players.map((p, orderIndex) => {
      const cells = {};
      for (let i = 1; i <= innings; i++) cells[i] = [];
      game.atBats
        .filter((ab) => ab.side === side && ab.orderIndex === orderIndex)
        .forEach((ab) => {
          (cells[ab.inning] ||= []).push({
            abbr: ab.abbr,
            rbi: ab.rbi,
            runsScored: ab.runsScored,
            count: `${ab.pitches.balls}-${ab.pitches.strikes}`,
          });
        });
      return {
        orderIndex,
        number: p.number ?? null,
        name: p.name,
        cells,
        totals: { ab: p.ab, r: p.r, h: p.h, rbi: p.rbi, bb: p.bb, k: p.k, avg: fmtAvg(p) },
      };
    });

    const halfKey = side === "away" ? "top" : "bottom";
    const perInning = [];
    for (let i = 1; i <= innings; i++) {
      const cell = game.lineScore.find((c) => c.inning === i);
      perInning.push({
        inning: i,
        runs: cell ? cell[halfKey] : 0,
        hits: game.atBats.filter((ab) => ab.side === side && ab.inning === i && ab.isHit).length,
      });
    }
    return { name: team.name, rows, perInning };
  };

  return {
    status: game.status,
    date: new Date().toISOString().slice(0, 10),
    innings,
    score: game.score,
    away: buildSide("away"),
    home: buildSide("home"),
  };
}

// Trimmed, serializable view for the UI/SSE and tool responses.
export function publicState(game) {
  const withAvg = (p) => ({
    ...p,
    avg: p.ab > 0 ? (p.h / p.ab).toFixed(3).replace(/^0/, "") : ".000",
  });
  return {
    status: game.status,
    inning: game.inning,
    half: game.half,
    outs: game.outs,
    count: { ...game.count },
    bases: game.bases,
    score: game.score,
    teams: {
      home: { name: game.home.name, battingIndex: game.home.battingIndex },
      away: { name: game.away.name, battingIndex: game.away.battingIndex },
    },
    lineScore: game.lineScore,
    batting: game.half === "top" ? "away" : "home",
    currentBatter: currentBatter(game)?.name ?? null,
    players: {
      home: game.home.players.map(withAvg),
      away: game.away.players.map(withAvg),
    },
    log: game.log.slice(-25),
    recap: game.status === "final" ? gameRecap(game) : null,
  };
}
