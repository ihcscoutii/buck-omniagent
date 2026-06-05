// Renders the printable scorecard from /api/scoresheet.
const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function cell(pas) {
  if (!pas || pas.length === 0) return "";
  // Stack multiple plate appearances in one inning cell.
  return pas
    .map((pa) => {
      const rbi = pa.rbi ? `<sup>${pa.rbi}</sup>` : "";
      const scored = pa.runsScored > 0 ? " score" : "";
      return `<span class="pa${scored}">${esc(pa.abbr)}${rbi}</span>`;
    })
    .join("<br>");
}

function teamTable(side) {
  const innHead = Array.from({ length: side.perInning.length }, (_, i) => `<th>${i + 1}</th>`).join("");
  const rows = side.rows
    .map((r) => {
      const cells = side.perInning.map((p) => `<td class="ab">${cell(r.cells[p.inning])}</td>`).join("");
      const t = r.totals;
      const num = r.number != null ? `<span class="num">${esc(r.number)}</span>` : "";
      return `<tr>
        <td class="ord">${r.orderIndex + 1}</td>
        <td class="batter">${num}${esc(r.name)}</td>
        ${cells}
        <td>${t.ab}</td><td>${t.r}</td><td>${t.h}</td><td>${t.rbi}</td><td>${t.bb}</td><td>${t.k}</td><td>${t.sb ?? 0}</td><td>${t.avg}</td>
      </tr>`;
    })
    .join("");

  const runRow = `<tr class="tot-row"><td></td><td>Runs</td>${side.perInning.map((p) => `<td>${p.runs || ""}</td>`).join("")}<td colspan="8"></td></tr>`;
  const hitRow = `<tr class="tot-row"><td></td><td>Hits</td>${side.perInning.map((p) => `<td>${p.hits || ""}</td>`).join("")}<td colspan="8"></td></tr>`;

  return `<h2>${esc(side.name)}</h2>
    <table class="card">
      <thead><tr>
        <th class="ord">#</th><th class="batter">Batter</th>${innHead}
        <th>AB</th><th>R</th><th>H</th><th>RBI</th><th>BB</th><th>K</th><th>SB</th><th>AVG</th>
      </tr></thead>
      <tbody>${rows || `<tr><td colspan="20" class="empty">No lineup entered</td></tr>`}${runRow}${hitRow}</tbody>
    </table>`;
}

async function load() {
  const s = await (await fetch("/api/scoresheet")).json();
  const final = s.status === "final" ? " — FINAL" : "";
  $("sheet").innerHTML = `
    <header class="sheet-head">
      <h1>⚾ Official Score Sheet</h1>
      <div class="meta">
        <span>${esc(s.away.name)} ${s.score.away} &nbsp;@&nbsp; ${esc(s.home.name)} ${s.score.home}${final}</span>
        <span>${esc(s.date)}</span>
      </div>
    </header>
    ${teamTable(s.away)}
    ${teamTable(s.home)}
    <p class="legend">1B/2B/3B hit • HR home run • BB walk • K strikeout • GO/FO/LO/PO out • E error • FC fielder's choice. Superscript = RBI. Shaded = run scored.</p>`;
}

load();
