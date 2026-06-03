// Scoreboard client: subscribes to live game state via SSE and renders it.
// Also wires the manual control buttons and the Napster avatar mount.

const $ = (id) => document.getElementById(id);

// ---- operator key (gates writes when the server has TOOL_SECRET set) ------
// Spectators can watch (reads are open); driving the game needs the key.
function opKey() {
  const el = $("opKey");
  return (el && el.value.trim()) || sessionStorage.getItem("opKey") || "";
}
function initOpKey() {
  const el = $("opKey");
  if (!el) return;
  el.value = sessionStorage.getItem("opKey") || "";
  el.addEventListener("input", () => sessionStorage.setItem("opKey", el.value.trim()));
}
// POST to a tool endpoint with the operator key attached.
async function toolPost(tool, args = {}) {
  const res = await fetch(`/tools/${tool}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-tool-secret": opKey() },
    body: JSON.stringify(args),
  });
  if (res.status === 401) {
    alert("Operator key required (or incorrect). Enter it in the Manual control panel to drive the game.");
  }
  return res;
}

// ---- live state stream ---------------------------------------------------
function connect() {
  const es = new EventSource("/events");
  es.onopen = () => $("conn").className = "conn dot-on";
  es.onerror = () => $("conn").className = "conn dot-off";
  es.onmessage = (e) => render(JSON.parse(e.data));
}

// ---- rendering -----------------------------------------------------------
function render(s) {
  // Count + bases
  $("inningNum").textContent = s.inning;
  $("inningHalf").textContent = s.half === "top" ? "▲" : "▼";
  $("balls").textContent = s.count?.balls ?? 0;
  $("strikes").textContent = s.count?.strikes ?? 0;
  $("outs").textContent = s.outs;
  // Map each base explicitly — the DOM order of the icons is 2B,3B,1B, so a
  // positional loop would light the wrong base. bases = [1B, 2B, 3B].
  document.querySelector(".diamond .b1").classList.toggle("on", !!s.bases[0]);
  document.querySelector(".diamond .b2").classList.toggle("on", !!s.bases[1]);
  document.querySelector(".diamond .b3").classList.toggle("on", !!s.bases[2]);

  // At-bat banner
  if (s.status === "final") {
    const w = s.score.home > s.score.away ? s.teams.home.name : s.teams.away.name;
    $("atbat").textContent = `FINAL — ${w} win`;
  } else {
    $("atbat").textContent = s.currentBatter ? `Now batting: ${s.currentBatter}` : "";
  }

  renderRecap(s.recap);
  renderLineScore(s);
  renderPbp(s.log);
  renderBox("boxAway", s.teams.away.name, s.players.away, s.batting === "away", s.teams.away.battingIndex);
  renderBox("boxHome", s.teams.home.name, s.players.home, s.batting === "home", s.teams.home.battingIndex);
}

function renderRecap(recap) {
  const el = $("recap");
  if (!recap || !recap.final) { el.hidden = true; return; }
  const pog = recap.playerOfGame;
  el.hidden = false;
  el.innerHTML = `
    <div class="recap-head">🏆 ${escapeHtml(recap.headline)}</div>
    ${pog ? `<div class="recap-pog"><span>Player of the Game</span>
      <strong>${pog.number != null ? "#" + escapeHtml(pog.number) + " " : ""}${escapeHtml(pog.name)}</strong>
      <em>${escapeHtml(pog.team)} — ${escapeHtml(pog.line)}</em></div>` : ""}`;
}

function renderLineScore(s) {
  const innings = Math.max(s.lineScore.length, s.inning, 6);
  let head = "<tr><th class='team'></th>";
  for (let i = 1; i <= innings; i++) head += `<th>${i}</th>`;
  head += "<th class='rhe'>R</th></tr>";

  const row = (side, name) => {
    const batting = s.batting === side ? " class='batting'" : "";
    let r = `<tr${batting}><td class='team'>${name}</td>`;
    for (let i = 1; i <= innings; i++) {
      const cell = s.lineScore.find((c) => c.inning === i);
      const v = cell ? cell[side === "away" ? "top" : "bottom"] : "";
      // Don't show a future/un-played half.
      const played = cell && (side === "away" || cell.bottom > 0 || i < s.inning || (i === s.inning && s.half === "bottom"));
      r += `<td>${played ? v : (cell ? v : "")}</td>`;
    }
    r += `<td class='tot'>${s.score[side]}</td></tr>`;
    return r;
  };
  $("linescore").innerHTML = head + row("away", s.teams.away.name) + row("home", s.teams.home.name);
}

function renderPbp(log) {
  const items = [...log].reverse().map((e) => {
    const half = e.half === "top" ? "▲" : "▼";
    return `<li><span class="tag">${half}${e.inning}</span>${escapeHtml(e.text)}</li>`;
  });
  $("pbp").innerHTML = items.join("") || "<li class='tag'>No plays yet — let's play ball!</li>";
}

function renderBox(elId, name, players, isBatting, upIndex) {
  const rows = players.map((p, i) => {
    const up = isBatting && i === upIndex % Math.max(players.length, 1);
    const num = p.number != null && p.number !== "" ? `#${p.number} ` : "";
    return `<tr class="${up ? "up" : ""}">
      <td class="name">${escapeHtml(num)}${escapeHtml(p.name)}</td>
      <td>${p.ab}</td><td>${p.r}</td><td>${p.h}</td><td>${p.rbi}</td>
      <td>${p.bb}</td><td>${p.k}</td><td>${p.avg}</td></tr>`;
  });
  $(elId).innerHTML = `<h3>${escapeHtml(name)}</h3>
    <table><tr><th class="name">Batter</th><th>AB</th><th>R</th><th>H</th><th>RBI</th><th>BB</th><th>K</th><th>AVG</th></tr>
    ${rows.join("")}</table>`;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---- manual control (demo without voice) ---------------------------------
document.querySelectorAll(".btns button").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const tool = btn.dataset.tool;
    if (!tool) return; // buttons with their own handler (e.g. Random game)
    const args = btn.dataset.args ? JSON.parse(btn.dataset.args) : {};
    await toolPost(tool, args);
    // The server broadcasts new state over SSE, so no manual re-render needed.
  });
});

// ---- quick random game (for fast testing) -------------------------------
const BOYS_NAMES = [
  "Liam", "Noah", "Oliver", "Eli", "Mason", "Lucas", "Ethan", "Logan", "Jack",
  "Aiden", "Caleb", "Owen", "Wyatt", "Henry", "Leo", "Miles", "Jude", "Cole",
  "Max", "Hudson", "Gavin", "Brody", "Carter", "Hayden", "Ryder", "Tate",
  "Finn", "Asher", "Jonah", "Levi", "Cooper", "Beau", "Reid", "Sawyer", "Dax",
  "Knox", "Rhett", "Bo", "Theo", "Grant",
];
const TEAM_NAMES = ["Sharks", "Tigers", "Comets", "Bulldogs", "Rockets", "Wolves", "Pirates", "Hawks"];

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// 9 players per team, all 18 names unique, each with a unique jersey number.
function randomTeam(names) {
  const nums = shuffle([...Array(99).keys()].map((n) => n + 1)).slice(0, 9);
  return names.map((name, i) => ({ number: nums[i], name }));
}

$("randomGame")?.addEventListener("click", async () => {
  const names = shuffle(BOYS_NAMES).slice(0, 18);
  const teams = shuffle(TEAM_NAMES).slice(0, 2);
  const away = randomTeam(names.slice(0, 9));
  const home = randomTeam(names.slice(9, 18));
  const payload = { awayName: teams[0], homeName: teams[1], awayLineup: away, homeLineup: home };
  // Reflect into the setup form so the rosters are visible/editable.
  if ($("awayName")) $("awayName").value = teams[0];
  if ($("homeName")) $("homeName").value = teams[1];
  if ($("awayLineup")) $("awayLineup").value = away.map((p) => `${p.number} ${p.name}`).join("\n");
  if ($("homeLineup")) $("homeLineup").value = home.map((p) => `${p.number} ${p.name}`).join("\n");
  await toolPost("new_game", payload);
  // Scoreboard updates via SSE; no reload needed.
});

// ---- pre-game lineup setup ----------------------------------------------
// Parse a textarea: one batter per line, optional leading number. "12 Tommy".
function parseLineup(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const m = line.match(/^(\d+)\s+(.*)$/);
      return m ? { number: Number(m[1]), name: m[2].trim() } : { name: line };
    });
}

$("startGame")?.addEventListener("click", async () => {
  const payload = {
    awayName: $("awayName").value.trim() || "Away",
    homeName: $("homeName").value.trim() || "Home",
    awayLineup: parseLineup($("awayLineup").value),
    homeLineup: parseLineup($("homeLineup").value),
  };
  if (payload.awayLineup.length === 0 && payload.homeLineup.length === 0) {
    if (!confirm("No players entered. Start an empty game anyway?")) return;
  }
  const r = await toolPost("new_game", payload);
  if (r.ok) alert("New game started!");
});

// ---- Napster avatar mount ------------------------------------------------
// The standalone bundle attaches itself as window.napsterCompanionApiSDK.
// Accept a few casings in case the package renames it.
function getNapsterSdk() {
  return (
    window.napsterCompanionApiSDK ||
    window.NapsterCompanionApiSdk ||
    window.NapsterCompanionApiSDK ||
    null
  );
}

$("mountBtn")?.addEventListener("click", async () => {
  const sdk = getNapsterSdk();
  if (!sdk) return alert("Napster SDK failed to load (offline / blocked CDN?). Manual control still works.");
  const btn = $("mountBtn");
  btn.disabled = true; btn.textContent = "Connecting…";
  try {
    // Token is minted server-side on demand (it expires in seconds), unless the
    // user pasted one manually for debugging.
    let token = $("token").value.trim();
    if (!token) {
      const r = await fetch("/api/token?channel=webrtc", { headers: { "x-tool-secret": opKey() } });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not mint token");
      token = j.token;
    }
    await sdk.init(token, { mountContainer: $("avatar-container"), position: "bottom-right" });
  } catch (err) {
    alert("Could not connect Buck: " + err.message);
    btn.disabled = false; btn.textContent = "Connect Buck";
  }
});

initOpKey();
connect();
