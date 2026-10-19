// <owcs-scenarios>: OWCS Scenario Tracker as a drop-in web component.
//
//   <script type="module" src="https://YOUR-HOST/owcs-scenarios.js"></script>
//   <owcs-scenarios></owcs-scenarios>
//
// Attributes (all optional):
//   stage     "<tournament-slug>/<stage-slug>" to show one stage only (no home page, no back link),
//             e.g. "japan-stage-3-owcs-2026/regular-season".
//   routing   How the tracker uses the page URL:
//               "none" (default) keeps navigation inside the component; the host URL is untouched.
//               "hash" uses #/<tournament>/<stage>?whatif=…, so views and what-ifs are shareable
//                      on any host page without server config.
//               "path" uses /<tournament>/<stage>?whatif=…; needs the server to serve the page
//                      for those paths (this repo's server does). Used by the standalone site.
//   base      With routing="path": the path prefix the tracker lives under, e.g. "/scenario-tracker".
//   api-base  Where the tracker's API lives. Defaults to the host that served this script.
//
// Everything renders inside a Shadow DOM, so the tracker's CSS and the host page's CSS don't
// affect each other. Theme tokens (--bg, --card, --primary, …) can be overridden from outside:
//   owcs-scenarios { --bg: transparent; }

import { formatFor } from "./formats.js";

const ASSET_BASE = new URL(".", import.meta.url);
const POLL_MS = 60_000;

// The scenario engine runs in a Web Worker. Workers must be same-origin, so the script is
// fetched and started from a blob: URL, which also works when embedded on another site.
let workerSource;
async function createWorker() {
  workerSource ||= fetch(new URL("sim.js", ASSET_BASE)).then((r) => {
    if (!r.ok) throw new Error(`Couldn't load sim.js (${r.status})`);
    return r.text();
  }).then((code) => URL.createObjectURL(new Blob([code], { type: "text/javascript" })));
  return new Worker(await workerSource);
}

// ---------- Pure helpers ----------
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
// True while showing a sampled (not fully counted) result: mid-range values are only good to
// about +/-0.15 points, so they are rounded to whole numbers rather than implying false precision.
let approx = false;
const pct = (p) => {
  if (p >= 1 - 1e-9) return "100%";
  if (p <= 1e-9) return "0%";
  const v = p * 100;
  if (approx && v >= 10 && v <= 90) return Math.round(v) + "%";
  if (v > 99.9) return ">99.9%";
  if (v < 0.01) return "<0.01%";
  if (v < 0.1) return v.toFixed(2) + "%";
  return v.toFixed(1) + "%";
};
const color = (t) => { const c = String(t.color || "").replace(/^#/, ""); return /^[0-9a-f]{3,8}$/i.test(c) ? "#" + c : "#555"; };
const hexColor = (c) => { c = String(c || "").replace(/^#/, ""); return /^[0-9a-f]{6}$/i.test(c) ? "#" + c : "#5af8fe"; };
const safeLogo = (u) => u && String(u).startsWith("https://owtv.gg/") ? u : null;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const shortDate = (iso) => { if (!iso) return ""; const x = new Date(iso); return `${x.getDate()} ${MONTHS[x.getMonth()]}`; };
const longDate = (iso) => { if (!iso) return ""; const x = new Date(iso); return `${x.getDate()} ${MONTHS[x.getMonth()]} ${x.getFullYear()}`; };
const isPlayed = (m) => m.complete && m.s1 != null && m.s2 != null;
const expPos = (r) => r.pos.reduce((s, p, i) => s + p * i, 0);
const STATUS = { ongoing: ["Ongoing", "live"], upcoming: ["Upcoming", "soon"], tbd: ["Schedule TBD", "tbd"] };
const TB_NAMES = { wins: "match wins", mapDiff: "map differential", mapsWon: "maps won", h2hWins: "head-to-head match wins", h2hMapDiff: "head-to-head map differential", mapPct: "map score %", sov: "strength of victory" };
const DEFAULT_TB = ["wins", "mapDiff", "h2hWins", "h2hMapDiff", "mapsWon"];

function parseLocks(str) {
  const locked = {};
  for (const part of (str || "").split(",").filter(Boolean)) {
    const m = part.match(/^(\d+):(\d+)-(\d+)$/);
    if (m) locked[m[1]] = [+m[2], +m[3]];
  }
  return locked;
}

// "Top 4 teams advance…", "Next 4 teams…", "Bottom team proceed…"
function parseZones(desc, n) {
  const zones = [];
  if (!desc) return zones;
  let at = 0;
  for (const line of desc.split(/\n/)) {
    let m;
    if ((m = line.match(/^\s*top\s+(\d+)/i))) { zones.push({ from: 1, to: +m[1], label: line.trim() }); at = +m[1]; }
    else if ((m = line.match(/^\s*next\s+(\d+)/i)) && at) { zones.push({ from: at + 1, to: at + +m[1], label: line.trim() }); at += +m[1]; }
    else if ((m = line.match(/^\s*bottom\s+(\d+|team)/i))) { const k = m[1] === "team" ? 1 : +m[1]; zones.push({ from: n - k + 1, to: n, label: line.trim() }); }
  }
  return zones;
}

// Label a bucket by the team's final record (w/l already banked, plus k wins in g more games).
// "Win all" / "Lose all" only when that really is a perfect / winless run.
// Outside results that move a bucket's odds: the best few, and any that put the team out on their own.
function helpLines(b, team) {
  const line = (r, cls, text) => `<span class="${cls}">${text} <b>${esc(team(r.winner).name)}</b> ${cls === "up" ? "beating" : "beat"} ${esc(team(r.loser).name)}${cls === "up" ? ` → ${pct(r.p)}` : ""}</span>`;
  const rows = [...(b.helps || []).map((r) => line(r, "up", "helped by")), ...(b.outIf || []).map((r) => line(r, "down", "out if"))];
  const sc = b.scenarios;
  const paths = sc && sc.list.length ? `<details class="paths"><summary>${sc.alive} of ${sc.total} outside combinations keep them alive</summary>${sc.list.map((x) =>
    `<div class="path"><span class="pp">${x.p >= 1 - 1e-9 ? "in" : pct(x.p)}</span><span>${x.picks.map((r) => `<b>${esc(team(r.winner).name)}</b> beat ${esc(team(r.loser).name)}`).join(" · ")}</span></div>`).join("")}${sc.alive > sc.list.length ? `<div class="path more">+ ${sc.alive - sc.list.length} more</div>` : ""}</details>` : "";
  return rows.length || paths ? `<span class="help">${rows.join("")}${paths}</span>` : "";
}

function bucketLabel(k, g, w, l) {
  const total = w || l ? ` <span class="tot">(${w + k}–${l + g - k})</span>` : "";
  if (k === g && l === 0) return (g === 1 ? "Win" : g === 2 ? "Win both" : "Win all") + total;
  if (k === 0 && w === 0) return (g === 1 ? "Lose" : g === 2 ? "Lose both" : "Lose all") + total;
  return `${k}–${g - k}${total}`;
}

// Heatmap cell text: whole numbers from 1%, then 1-2 decimals so a real chance never renders blank.
function heatText(p) {
  const v = p * 100;
  if (v <= 1e-7) return "";
  if (v >= 0.995) return String(Math.round(v));
  if (v >= 0.1) return v.toFixed(1);
  if (v >= 0.01) return v.toFixed(2);
  return "<.01";
}

function heat(p, inZone) {
  if (p < 0.005) return "background:transparent";
  const a = (0.1 + 0.8 * p).toFixed(2);
  const bg = inZone ? `rgba(90,248,254,${a})` : `rgba(160,160,180,${(a * 0.6).toFixed(2)})`;
  return `background:${bg};color:${inZone && p > 0.45 ? "#0b0b0f" : "inherit"}`;
}

// Team logo from OWTV, falling back to a colour chip (swapped in by the error handler below).
const logo = (t, cls = "logo") => safeLogo(t.logo)
  ? `<img class="${cls}" src="${esc(t.logo)}" alt="" loading="lazy" data-fallback="chip">`
  : `<span class="chip" style="background:${color(t)}"></span>`;
const circuitImg = (src, cls = "") => safeLogo(src)
  ? `<img${cls ? ` class="${cls}"` : ""} src="${esc(src)}" alt="" data-fallback="remove">` : "";

// ---------- One tracker instance ----------
function createTracker(host, root, view) {
  const opts = {
    fixedStage: host.getAttribute("stage") || null,
    routing: host.getAttribute("stage") ? "none" : (host.getAttribute("routing") || "none"),
    base: "/" + (host.getAttribute("base") || "").split("/").filter(Boolean).join("/"),
    apiBase: new URL(host.getAttribute("api-base") || ".", ASSET_BASE).href.replace(/\/?$/, "/"),
  };
  const api = (p) => opts.apiBase + p.replace(/^\//, "");

  const state = {
    view: "home", circuits: null, data: null, phaseId: null, stageKey: null,
    locked: {}, cutoff: 4, cutoffOverridden: false, zones: [], format: null,
    result: null, running: 0, tab: "overview", treeFocus: null, treeOpen: new Set(), treeZoom: null,
    checkedAt: null, news: [], fresh: new Set(),
  };
  let seq = 0, polling = false, destroyed = false;
  const workerReady = createWorker().then((w) => {
    w.onmessage = (e) => {
      const { id, result } = e.data;
      if (id !== seq || !result) return;
      state.result = result;
      state.running = 0;
      render();
    };
    return w;
  });
  workerReady.catch((e) => { view.innerHTML = `<p class="empty">${esc(e.message)}</p>`; });

  const team = (id) => state.data?.teams[id] || { name: id ? `Team ${id}` : "TBD", initials: "?", color: "555" };

  // ---------- Location ----------
  // Internally a location is "/<tournament>/<stage>?whatif=…&cut=…" ("/" for home).
  let memLoc = opts.fixedStage ? `/${opts.fixedStage}` : "/";
  function getLoc() {
    if (opts.routing === "path") {
      const p = location.pathname;
      const inBase = opts.base === "/" ? p : p === opts.base || p.startsWith(opts.base + "/") ? p.slice(opts.base.length) || "/" : "/";
      return inBase + location.search;
    }
    if (opts.routing === "hash") return location.hash.startsWith("#/") ? location.hash.slice(1) : "/";
    return memLoc;
  }
  function setLoc(loc, push) {
    if (opts.routing === "none") { memLoc = loc; return; }
    const url = opts.routing === "path" ? pathFor(loc) : location.pathname + location.search + "#" + loc;
    history[push ? "pushState" : "replaceState"](null, "", url);
  }
  const pathFor = (loc) => opts.base === "/" ? loc : opts.base + (loc === "/" ? "/" : loc);
  const hrefFor = (loc) => opts.routing === "path" ? pathFor(loc) : opts.routing === "hash" ? "#" + loc : "#";
  function readLoc() {
    // Legacy "#112&l=1627:3-0" links from the first version of the site.
    const legacy = opts.routing !== "none" && location.hash.match(/^#(\d+)(.*)$/);
    if (legacy) {
      const h = new URLSearchParams(legacy[2]);
      return { id: +legacy[1], cut: +h.get("cut") || null, locked: parseLocks(h.get("l")) };
    }
    const u = new URL(getLoc(), "http://x");
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length !== 2) return {};
    return { slugs: parts.join("/"), cut: +u.searchParams.get("cut") || null, locked: parseLocks(u.searchParams.get("whatif")) };
  }
  function writeLoc() {
    const d = state.data;
    if (!d) return;
    const q = new URLSearchParams();
    const l = Object.entries(state.locked).map(([id, [a, b]]) => `${id}:${a}-${b}`).join(",");
    if (l) q.set("whatif", l);
    if (state.cutoffOverridden) q.set("cut", state.cutoff);
    const qs = q.toString().replace(/%3A/gi, ":").replace(/%2C/gi, ",");
    setLoc(`/${d.tournament.slug}/${d.phase.slug}` + (qs ? "?" + qs : ""), false);
  }
  const navigate = (loc) => { setLoc(loc, true); route(); };
  const setTitle = (t) => { if (opts.routing === "path") document.title = t; };

  // ---------- Data ----------
  async function getJSON(p) {
    const r = await fetch(api(p));
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    return r.json();
  }

  function route() {
    if (destroyed) return;
    const r = readLoc();
    if (r.id) return loadPhase({ id: r.id }, r);
    if (r.slugs) {
      if (state.view === "stage" && state.stageKey === r.slugs) return;
      return loadPhase({ slugs: r.slugs }, r);
    }
    showHome();
  }

  // ---------- Home: live and upcoming circuits ----------
  async function showHome() {
    state.view = "home";
    state.data = null; state.phaseId = null; state.stageKey = null; state.result = null; seq++;
    setTitle("OWCS Scenarios");
    if (!state.circuits) view.innerHTML = `<p class="loading">Loading circuits…</p>`;
    else renderHome();
    try {
      state.circuits = await getJSON("api/circuits");
    } catch (e) {
      if (!state.circuits && state.view === "home") view.innerHTML = `<p class="empty">Couldn't load circuits: ${esc(e.message)}</p>`;
      return;
    }
    if (state.view === "home") renderHome();
  }

  function renderHome() {
    const cs = state.circuits || [];
    const stageRow = (c) => (st) => {
      const loc = `/${c.slug}/${st.slug}`;
      const pctDone = st.matches ? Math.round((st.played / st.matches) * 100) : 0;
      const info = st.played ? `${st.played} of ${st.matches} played`
        : st.startDate ? `Starts ${shortDate(st.startDate)}` : "TBD";
      return `<a class="stage-row" data-nav="${esc(loc)}" href="${esc(hrefFor(loc))}">
        <span class="st-name">${esc(st.name)}</span>
        <span class="st-info">${info}</span>
        <span class="st-bar"><i style="width:${pctDone}%"></i></span>
        <span class="st-go" aria-hidden="true">›</span>
      </a>`;
    };
    const card = (c) => {
      const [label, cls] = STATUS[c.status] || STATUS.tbd;
      const first = c.stages.find((s) => !s.tbd) || c.stages[0];
      const loc = `/${c.slug}/${first.slug}`;
      return `<article class="circuit">
        ${safeLogo(c.logo) ? `<div class="hero-glow" aria-hidden="true">${circuitImg(c.logo)}</div>` : ""}
        <a class="circuit-head" data-nav="${esc(loc)}" href="${esc(hrefFor(loc))}">
          ${circuitImg(c.logo, "circuit-logo")}
          <span class="circuit-id">
            <span class="badges">${c.regions.map((r) => `<span class="region" style="--rc:${hexColor(r.color)}">${esc(r.name)}</span>`).join("")}
              <span class="status ${cls}">${label}</span></span>
            <span class="circuit-name">${esc(c.name)}</span>
            <span class="circuit-dates">${shortDate(c.startDate)}${c.endDate ? " – " + shortDate(c.endDate) : ""}</span>
          </span>
        </a>
        <div class="stage-list">${c.stages.map(stageRow(c)).join("")}</div>
      </article>`;
    };
    view.innerHTML = `
      <section class="card">
        <div class="home-head">
          <h1>Scenario Tracker</h1>
          <p>Live and upcoming OWCS stages. Pick one to see who can still qualify.</p>
        </div>
        <div class="card-body">
          ${cs.length ? `<div class="circuits">${cs.map(card).join("")}</div>`
            : `<div class="note">No live or upcoming OWCS stages right now.</div>`}
        </div>
      </section>`;
  }

  // ---------- Stage ----------
  async function loadPhase(which, { cut, locked } = {}) {
    const key = which.slugs || `#${which.id}`;
    state.view = "stage";
    state.stageKey = key;
    state.locked = locked || {};
    state.result = null;
    view.innerHTML = `<p class="loading">Loading…</p>`;
    let data;
    try {
      data = await getJSON(which.slugs ? `api/stage/${which.slugs}` : `api/phase/${which.id}`);
    } catch (e) {
      if (state.stageKey === key) view.innerHTML = `<p class="empty">Couldn't load this stage: ${esc(e.message)}</p>`;
      return;
    }
    if (destroyed || state.view !== "stage" || state.stageKey !== key) return;
    state.data = data;
    state.phaseId = data.phase.id;
    state.stageKey = `${data.tournament.slug}/${data.phase.slug}`;
    if (which.id) history.replaceState(null, "", location.pathname + location.search); // drop legacy #id
    setTitle(`${data.tournament.name} · OWCS Scenarios`);
    state.checkedAt = new Date();
    state.news = []; state.fresh = new Set();
    state.format = formatFor(state.phaseId, data.tournament.regions);
    state.zones = state.format.zones || parseZones(data.phase.description, teamIds().length);
    state.cutoffOverridden = !!cut;
    state.cutoff = cut || state.zones[0]?.to || Math.min(4, Math.max(1, teamIds().length - 1));
    run();
  }

  function teamIds() {
    const d = state.data;
    const ids = d.standings.map((s) => s.team).filter(Boolean);
    if (ids.length) return ids;
    return [...new Set(d.matches.flatMap((m) => [m.team1, m.team2]).filter(Boolean))];
  }

  // Matches the all-results tree branches on: the user's pick, else the soonest few when too many remain.
  const openMatches = () => (state.data?.matches || []).filter((m) => !isPlayed(m) && m.team1 && m.team2 && !state.locked[m.id])
    .sort((x, y) => String(x.start || "").localeCompare(String(y.start || "")) || x.id - y.id);
  function treeFocusIds() {
    const open = openMatches(), ids = new Set(open.map((m) => m.id));
    const picked = (state.treeFocus || []).filter((id) => ids.has(id));
    if (state.treeFocus) return picked.slice(0, 6);
    return open.length > 6 ? open.slice(0, 4).map((m) => m.id) : null;
  }

  function run() {
    const d = state.data;
    const teams = teamIds();
    const played = d.matches.filter(isPlayed).map((m) => ({ a: m.team1, b: m.team2, sa: m.s1, sb: m.s2 }));
    const remaining = d.matches.filter((m) => !isPlayed(m) && m.team1 && m.team2)
      .map((m) => ({ id: m.id, a: m.team1, b: m.team2, ft: m.firstTo }));
    writeLoc();
    render();
    // Odds are only meaningful once every fixture has both teams (Swiss rounds, unseeded stages).
    if (!teams.length || d.matches.some((m) => !m.team1 || !m.team2)) return;
    const id = ++seq;
    state.running = id;
    const input = { teams, played, remaining, locked: state.locked, cutoff: state.cutoff, tiebreakers: state.format.tiebreakers, focus: treeFocusIds() };
    workerReady.then((w) => w.postMessage({ id, input }));
  }

  function currentTable() {
    const rows = {};
    for (const t of teamIds()) rows[t] = { team: t, w: 0, l: 0, d: 0, mw: 0, ml: 0, left: [] };
    for (const m of state.data.matches) {
      const a = rows[m.team1], b = rows[m.team2];
      if (!a || !b) continue;
      // A locked what-if counts as played, so the table shows the record that scoreline would give.
      const L = !isPlayed(m) && state.locked[m.id];
      if (!isPlayed(m) && !L) { a.left.push(m.team2); b.left.push(m.team1); continue; }
      const s1 = L ? L[0] : m.s1, s2 = L ? L[1] : m.s2;
      a.mw += s1; a.ml += s2; b.mw += s2; b.ml += s1;
      if (s1 > s2) { a.w++; b.l++; } else if (s2 > s1) { b.w++; a.l++; } else { a.d++; b.d++; }
    }
    return rows;
  }

  function stageStatus(d) {
    const now = new Date().toISOString();
    const start = d.phase.startDate || d.tournament.startDate, end = d.phase.endDate || d.tournament.endDate;
    // With matches on the schedule, only played results count. The listed end date can be wrong
    // (EMEA's ends before it starts) or pass with matches still to play.
    const done = d.matches.length ? d.matches.every(isPlayed) : end && end < now;
    if (done) return { label: "Completed", cls: "done" };
    if (start && start <= now) return { label: "Ongoing", cls: "live" };
    if (start) return { label: "Upcoming", cls: "soon" };
    return null;
  }
  const dateRange = (d) => {
    const a = longDate(d.tournament.startDate), b = longDate(d.tournament.endDate);
    return a && b ? `${a} – ${b}` : a || b;
  };
  const tiebreakText = () => (state.format.tiebreakers || DEFAULT_TB).map((c) => TB_NAMES[c]).join(" → ");
  // Label of the headline zone (the one ending at the cutoff), if it came from the format.
  const headline = () => { const z = state.zones.find((z) => z.from === 1 && z.to === state.cutoff); return z && state.format.zones ? z.label : ""; };
  const shortLabel = (l) => l.length > 22 ? l.replace(/ teams?.*$/i, "") : l;

  function render() {
    const d = state.data;
    if (!d || destroyed) return;
    const rows = currentTable();
    const res = state.result;
    approx = !!res && res.exact === false;
    const byTeam = res ? Object.fromEntries(res.results.map((r) => [r.team, r])) : {};
    const n = teamIds().length;
    const played = d.matches.filter(isPlayed).length;
    const tbd = d.matches.filter((m) => !m.team1 || !m.team2).length;
    const lockedCount = Object.keys(state.locked).length;

    const order = Object.values(rows);
    if (res) order.sort((a, b) => byTeam[b.team].qualify - byTeam[a.team].qualify || expPos(byTeam[a.team]) - expPos(byTeam[b.team]));
    else order.sort((a, b) => b.w - a.w || (b.mw - b.ml) - (a.mw - a.ml));

    const tab = state.tab;
    const tabs = [["overview", "Overview"], ["flow", "Flowchart"], ["fixtures", "Fixtures"], ["format", "Format"]];
    const status = stageStatus(d);

    view.innerHTML = `
      ${opts.fixedStage ? "" : `<a class="back" data-nav="/" href="${esc(hrefFor("/"))}">‹ All circuits</a>`}
      <section class="card hero-card">
        <div class="hero">
          ${safeLogo(d.tournament.logo) ? `<div class="hero-glow" aria-hidden="true">${circuitImg(d.tournament.logo)}</div>` : ""}
          <div class="hero-id">
            ${circuitImg(d.tournament.logo, "circuit")}
            <div class="hero-main">
              <div class="badges">
                ${(d.tournament.regionBadges || []).map((r) => `<span class="region" style="--rc:${hexColor(r.color)}">${esc(r.name)}</span>`).join("")}
              </div>
              <div class="title-row">
                <h1>${esc(d.tournament.name)}</h1>
                ${status ? `<span class="status ${status.cls}">${status.label}</span>` : ""}
              </div>
              ${dateRange(d) ? `<div class="dates">${dateRange(d)}</div>` : ""}
              <div class="sub">${esc(d.phase.name)} · ${played} of ${d.matches.length} matches played</div>
            </div>
          </div>
          <div class="controls">
            ${lockedCount ? `<button class="btn" data-action="clear">Clear ${lockedCount} what-if${lockedCount > 1 ? "s" : ""}</button>` : ""}
          </div>
        </div>
        ${state.news.length ? `<div class="news"><b>New result${state.news.length > 1 ? "s" : ""}</b> ${state.news.map((m) =>
          `${esc(team(m.team1).initials || team(m.team1).name)} <b>${m.s1}–${m.s2}</b> ${esc(team(m.team2).initials || team(m.team2).name)}`).join(" · ")} · odds updated</div>` : ""}
      </section>

      <section class="card">
        <nav class="tabs">${tabs.map(([k, l]) => `<button data-tab="${k}" class="${tab === k ? "on" : ""}">${l}</button>`).join("")}</nav>
        <div class="card-body">
        ${tbd ? `<div class="note">TBD</div>` : ""}
        ${!n ? (tbd ? "" : `<div class="note">TBD</div>`) : tab === "overview" ? `
          <h2>Standings <small>${res && res.freeMatches ? "Chance to finish in each place across every remaining scoreline" : ""}</small></h2>
          ${standingsTable(order, byTeam, n)}
          ${res && res.freeMatches ? `<h2>What they need <small>Every remaining result, sorted by what the team itself does. Top ${state.cutoff}${headline() ? " → " + esc(headline()) : ""}.</small></h2>
            <div class="cards">${order.map((r) => needCard(r, byTeam[r.team])).join("")}</div>` : ""}
        ` : tab === "flow" ? flowSection() : tab === "fixtures" ? matchesSection() : `
          ${formatSection()}
          <h2>How it's counted</h2>
          <div class="note">
            <ul class="fmt">
              <li>Every possible scoreline of every remaining match is treated as equally likely. The percentages are shares of outcomes, not predictions.</li>
              <li>Early in a stage there are too many outcomes to count, so a fixed sample of ${(400_000).toLocaleString()} is used. Near the end, every outcome is counted.</li>
              <li>Ties: ${tiebreakText()}.</li>
              <li>Lock scorelines under Fixtures to try what-ifs${opts.routing === "none" ? "" : ", and share the link"}.</li>
            </ul>
          </div>`}
        </div>
      </section>`;
  }

  function formatSection() {
    const f = state.format;
    if (!f.path.length && !f.link) return "";
    return `<h2>Format</h2>
      <div class="note"><ul class="fmt">${f.path.map((p) => `<li>${esc(p)}</li>`).join("")}
        <li>Regular-season tiebreakers: ${esc(tiebreakText())}. Source: ${esc(f.tiebreakerSource)}.</li></ul></div>`;
  }

  function standingsTable(order, byTeam, n) {
    const res = state.result;
    const showHeat = res && res.freeMatches;
    const zoneCols = state.zones.length > 1 ? state.zones.filter((z) => !(z.from === 1 && z.to === state.cutoff)) : [];
    const head = `<tr><th>#</th><th class="team">Team</th><th>W</th><th>L</th><th>Maps</th><th>+/-</th>
      <th title="${esc(headline())}">Top ${state.cutoff}${headline() ? `<br><span class="zl">${esc(headline())}</span>` : ""}</th>${zoneCols.map((z) => `<th title="${esc(z.label)}">${z.from === z.to ? z.from : `${z.from}–${z.to}`}<br><span class="zl">${esc(shortLabel(z.label))}</span></th>`).join("")}
      ${showHeat ? `<th>Range</th>` + Array.from({ length: n }, (_, i) => `<th class="heat">${i + 1}</th>`).join("") : ""}</tr>`;
    const body = order.map((r, i) => {
      const t = team(r.team), s = byTeam[r.team];
      const q = s ? s.qualify : null;
      const cls = q == null ? "" : q >= 1 - 1e-9 ? "in" : q <= 1e-9 ? "out" : "";
      const zone = (z) => s ? pct(s.pos.slice(z.from - 1, z.to).reduce((a, b) => a + b, 0)) : "–";
      return `<tr class="${res && i === state.cutoff - 1 && q != null ? "cutline" : ""}" style="--tc:${color(t)}">
        <td class="muted">${i + 1}</td>
        <td class="team"><span class="tname">${logo(t)}${esc(t.name)}</span></td>
        <td><span class="wl w">${r.w}</span></td><td><span class="wl l">${r.l}</span></td>
        <td class="muted">${r.mw}–${r.ml}</td>
        <td class="muted">${r.mw - r.ml > 0 ? "+" : ""}${r.mw - r.ml}</td>
        <td class="pct ${cls}">${q == null ? (state.running ? "…" : "–") : pct(q)}</td>
        ${zoneCols.map((z) => `<td>${zone(z)}</td>`).join("")}
        ${showHeat ? `<td class="muted">${s.best === s.worst ? s.best : `${s.best}–${s.worst}`}</td>` +
          s.pos.map((p, j) => `<td class="heat" style="${heat(p, j < state.cutoff)}">${heatText(p)}</td>`).join("") : ""}
      </tr>`;
    }).join("");
    return `<div class="table-wrap"><table><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
  }

  function needCard(row, s) {
    const t = team(row.team);
    if (!s) return "";
    const q = s.qualify, c = state.cutoff;
    const games = row.left.length;
    const leftText = row.left.map((id) => team(id).name).join(", ");
    const fb = s.buckets; // wins high -> low, over matches not locked
    const g = fb[0]?.games ?? 0;
    let lead, cls = "";

    if (q >= 1 - 1e-9) { cls = "in"; lead = s.worst <= c ? "Already through. The rest decides seeding." : "Through in every remaining scenario."; }
    else if (q <= 1e-9) { cls = "out"; lead = `Out. Can't finish top ${c} whatever happens.`; }
    else if (g === 0) {
      lead = "Their games are done. It comes down to other results.";
    } else {
      const safe = fb.filter((b) => b.p >= 1 - 1e-9);
      const minSafe = safe.length ? Math.min(...safe.map((b) => b.wins)) : null;
      const allAbove = minSafe != null && fb.every((b) => b.wins < minSafe || b.p >= 1 - 1e-9);
      const deadMax = Math.max(-1, ...fb.filter((b) => b.p <= 1e-9 && fb.every((x) => x.wins > b.wins || x.p <= 1e-9)).map((b) => b.wins));
      if (minSafe != null && allAbove) {
        lead = minSafe === g
          ? `Only a clean sweep settles it: win ${g === 1 ? "it" : g === 2 ? "both" : `all ${g}`} and they are in, anything less and they need results elsewhere.`
          : `Win ${minSafe} of their last ${g} and they are in, whatever anyone else does.`;
      } else {
        lead = `Still alive, but can't clinch on their own: even winning ${g === 1 ? "it" : g === 2 ? "both" : `all ${g}`} leaves them at ${pct(fb[0].p)}, so they need help elsewhere.`;
      }
      if (deadMax >= 0) lead += deadMax === 0 ? ` Lose ${g === 1 ? "it" : "the lot"} and they are out.` : ` Win ${deadMax} or fewer and they're eliminated whatever else happens.`;
    }

    // Record banked so far; locked what-ifs are already in the table row (and not in the buckets).
    const bw = row.w, bl = row.l;
    const rows = g === 0 ? "" : fb.map((b) => {
      const through = b.p >= 1 - 1e-9, out = b.p <= 1e-9;
      return `<div class="row">
        <span class="lbl">${bucketLabel(b.wins, b.games, bw, bl)}</span>
        <span class="bar ${through ? "full" : ""}"><i style="width:${(b.p * 100).toFixed(1)}%"></i></span>
        <span class="v ${through ? "in" : out ? "out" : ""}">${through ? "THROUGH" : out ? "OUT" : pct(b.p)}</span>
        ${helpLines(b, team)}
      </div>`;
    }).join("");

    return `<div class="card ${cls}">
      <div class="card-head"><span><span class="name">${logo(t, "logo lg")}${esc(t.name)}</span><span class="rec">${row.w}–${row.l}</span></span>
        <span class="big" style="color:${cls === "in" ? "var(--good)" : cls === "out" ? "var(--dim)" : "var(--text)"}">${pct(q)}</span></div>
      <div class="lead">${lead}</div>
      ${rows}
      ${games ? `<div class="left">Left to play: ${esc(leftText)}</div>` : ""}
    </div>`;
  }

  // Decision tree of every remaining match in date order: each branch is a winner, each leaf who gets through.
  function flowSection() {
    const chosen = new Set(treeFocusIds() || openMatches().map((m) => m.id));
    const picker = `<div class="note"><b>Matchups to branch on</b> (up to 6)</div><div class="chips">${openMatches().map((m) =>
      `<button data-focus="${m.id}" class="chip-btn ${chosen.has(m.id) ? "on" : ""}" title="${esc(m.start ? longDate(m.start) : "")}">${esc(team(m.team1).initials || team(m.team1).name)} vs ${esc(team(m.team2).initials || team(m.team2).name)}${m.start ? ` · ${esc(shortDate(m.start))}` : ""}</button>`).join("")}</div>`;
    const tr = state.result?.tree;
    if (!tr) return picker + (state.result ? `<div class="note">Pick at least one matchup to see how its result changes who gets through.</div>` : `<div class="note">Working it out…</div>`);
    const byId = Object.fromEntries(state.data.matches.map((m) => [m.id, m]));
    const ord = tr.matches.map((m, i) => ({ ...m, j: i, bit: 1 << i, start: byId[m.id]?.start || "" }))
      .sort((x, y) => String(x.start).localeCompare(String(y.start)) || x.id - y.id);
    const F = ord.length, nm = (id) => team(id).initials || team(id).name;
    const exact = state.result.exact !== false;
    const prec = exact ? 1000 : 50;                                // sampled odds are noisy, so compare coarsely
    const build = (d, mask) => {
      if (d === F) { const lf = tr.leaves[mask]; return { lf, mask, sig: lf ? lf.q.map((v) => Math.round(v * prec)).join(",") : "x" }; }
      const m = ord[d], lo = build(d + 1, mask), hi = build(d + 1, mask | m.bit);   // lo: first-listed team wins
      if (lo.sig === hi.sig) return { m, d, skip: lo, sig: lo.sig };               // result doesn't change anything
      return { m, d, lo, hi, sig: `(${m.id}:${lo.sig}|${hi.sig})` };
    };
    const root = build(0, 0);
    // What each tied team needs: the one match whose map score best splits its in/out cases.
    const needs = (lf, mask, t) => {
      if (!lf?.by) return { text: "", full: "", more: false };
      let best = null;
      for (const m of ord) {
        const st = lf.by[t][m.j].map((v) => v == null ? null : v >= 1 - 1e-9 ? "in" : v <= 1e-9 ? "out" : "maybe");
        const kinds = new Set(st.filter(Boolean));
        if (kinds.size < 2) continue;
        const def = st.filter((x) => x === "in" || x === "out").length;
        if (!best || def > best.def) best = { m, st, def };
      }
      if (!best) return { text: "depends on several map scores", full: "", more: true };
      const b = (mask >> best.m.j) & 1, W = nm(b ? best.m.b : best.m.a), L = nm(b ? best.m.a : best.m.b);
      const valid = best.st.map((x, lm) => x ? lm : null).filter((x) => x != null);
      const sc = (kind) => { const v = best.st.map((x, lm) => x === kind ? lm : null).filter((x) => x != null); return v.length ? scoreText(best.m.ft, v, valid) : ""; };
      const groups = [["in", "in if"], ["out", "out if"], ["maybe", "unclear if"]].filter(([k]) => sc(k))
        .map(([k, w]) => `${w} ${W} beat ${L} ${sc(k)}`);
      // Closed leaf: just the first clear condition. The rest is in the dropdown.
      return { text: groups[0], full: groups.join(" · "), more: groups.length > 1 };
    };
    // "3–0 or 3–1", or "any score" when the list covers every score that can happen.
    const scoreText = (ft, vals, valid) => vals.length === valid.length ? "by any score" : vals.map((v) => `${ft}–${v}`).join(" or ");
    const byJ = Object.fromEntries(ord.map((m) => [m.j, m]));
    // The same, from the best pair of matches, for teams one score can't settle.
    const pairLines = (lf, mask, t) => {
      const P = lf?.pairs;
      if (!P) return [];
      let best = null;
      P.list.forEach(([j1, j2], p) => {
        const cells = P.by[t][p].map((v) => v == null ? null : v >= 1 - 1e-9 ? "in" : v <= 1e-9 ? "out" : "maybe");
        if (new Set(cells.filter(Boolean)).size < 2) return;
        const def = cells.filter((x) => x === "in" || x === "out").length;
        if (!best || def > best.def) best = { j1, j2, cells, def };
      });
      if (!best) return ["still depends on three or more map scores"];
      const m1 = byJ[best.j1], m2 = byJ[best.j2], mf = P.mf;
      const who = (m) => { const b = (mask >> m.j) & 1; return `${nm(b ? m.b : m.a)} beat ${nm(b ? m.a : m.b)}`; };
      const lines = [];
      const validA = [], validB = [];
      for (let x = 0; x < mf; x++) for (let y = 0; y < mf; y++) if (best.cells[x * mf + y]) { if (!validA.includes(x)) validA.push(x); if (!validB.includes(y)) validB.push(y); }
      for (const kind of ["in", "out"]) {
        // Scores of the first match that give the same set of second-match scores are merged.
        const groups = new Map();
        for (const x of validA) {
          const ys = validB.filter((y) => best.cells[x * mf + y] === kind);
          if (!ys.length) continue;
          const key = ys.join(",");
          if (!groups.has(key)) groups.set(key, { xs: [], ys });
          groups.get(key).xs.push(x);
        }
        for (const g of groups.values()) lines.push(`${kind}: ${who(m1)} ${scoreText(m1.ft, g.xs, validA)} + ${who(m2)} ${scoreText(m2.ft, g.ys, validB)}`);
      }
      return lines.length ? lines : ["still depends on three or more map scores"];
    };
    const names = (arr) => arr.map((t) => esc(nm(tr.teams[t]))).join(", ");
    const hiQ = exact ? 1 - 1e-9 : 0.995, loQ = exact ? 1e-9 : 0.005;
    const info = (nd) => {
      if (nd.lf !== undefined) {
        const q = nd.lf ? nd.lf.q : [], inn = [], mid = [], no = [];
        q.forEach((v, t) => (v >= hiQ ? inn : v <= loQ ? no : mid).push(t));
        const pl = nd.lf ? nd.lf.place : [];
        const byPlace = (x, y) => pl[x] - pl[y] || q[y] - q[x];     // finish order, best first
        mid.sort(byPlace); inn.sort(byPlace); no.sort(byPlace);
        const open = state.treeOpen.has(String(nd.mask));
        const need = mid.map((t) => exact ? needs(nd.lf, nd.mask, t) : { text: Math.round(q[t] * 100) + "%", full: "", more: false });
        const more = exact && need.some((x) => x.more) && !!nd.lf?.pairs;
        const rows = [{ c: "tr-in", t: "In: " + names(inn) }];
        mid.forEach((t, i) => rows.push({ c: "tr-mid", t: esc(nm(tr.teams[t])) + ": " + esc(need[i].text) }));
        if (more) rows.push({ c: "tr-tog", t: open ? "▾ hide detail" : "▸ more detail", leaf: nd.mask });
        if (more && open) mid.forEach((t, i) => { if (need[i].more) { rows.push({ c: "tr-sub1", t: esc(nm(tr.teams[t])) + ":" }); if (need[i].full) rows.push({ c: "tr-sub", t: esc(need[i].full) }); pairLines(nd.lf, nd.mask, t).forEach((l) => rows.push({ c: "tr-sub", t: esc(l) })); } });
        rows.push({ c: "tr-out", t: "Out: " + names(no) });
        nd.rows = rows; nd.h = rows.length * 16 + 14;
        return;
      }
      if (nd.skip) info(nd.skip); else { info(nd.lo); info(nd.hi); }
    };
    info(root);
    const COLW = 205, NW = 118, NH = 32, LEAFW = 470, LX = F * COLW + 24;
    let cursor = 10;
    const lay = (nd) => {
      if (nd.lf !== undefined) { nd.y = cursor + nd.h / 2 + 4; cursor += nd.h + 8; return; }
      if (nd.skip) { lay(nd.skip); nd.y = nd.skip.y; return; }
      lay(nd.lo); lay(nd.hi); nd.y = (nd.lo.y + nd.hi.y) / 2;
    };
    lay(root);
    const xOf = (nd) => nd.lf !== undefined ? LX : nd.d * COLW;
    const edge = (a, b, label) => {
      const x1 = xOf(a) + NW, y1 = a.y, x2 = xOf(b), y2 = b.y, m = (x1 + x2) / 2;
      return `<path class="tr-edge" d="M${x1},${y1} C${m},${y1} ${m},${y2} ${x2},${y2}"/>${label ? `<text class="tr-win" x="${m}" y="${(y1 + y2) / 2 - 4}" text-anchor="middle">${esc(label)}</text>` : ""}`;
    };
    let out = "";
    const draw = (nd) => {
      if (nd.lf !== undefined) {
        const h = nd.h, top = nd.y - h / 2 - 4 + 4;
        out += `<g class="tr-leaf"><rect x="${LX}" y="${top - 4 + 4}" width="${LEAFW}" height="${h}" rx="4"/>${nd.rows.map((r, i) =>
          `<text x="${LX + (r.c === "tr-sub" ? 22 : 10)}" y="${top + 16 + i * 16}" class="${r.c}"${r.leaf != null ? ` data-leaf="${r.leaf}"` : ""}>${r.t}</text>`).join("")}</g>`;
        return;
      }
      const x = nd.d * COLW, m = nd.m;
      if (nd.skip) { out += edge(nd, nd.skip, ""); draw(nd.skip); }
      else {
        out += edge(nd, nd.lo, nm(m.a) + " wins") + edge(nd, nd.hi, nm(m.b) + " wins");
        draw(nd.lo); draw(nd.hi);
      }
      out += `<g class="tr-node"><rect x="${x}" y="${nd.y - NH / 2}" width="${NW}" height="${NH}" rx="14"/>
        <text x="${x + NW / 2}" y="${nd.y + (nd.skip ? -1 : 4)}" text-anchor="middle" class="tr-t">${esc(nm(m.a))} vs ${esc(nm(m.b))}</text>${nd.skip ? `<text x="${x + NW / 2}" y="${nd.y + 11}" text-anchor="middle" class="tr-s">${exact ? "doesn't matter" : "barely matters"}</text>` : ""}</g>`;
    };
    draw(root);
    const H = cursor + 10, W = LX + LEAFW + 10;
    return `<h2>All results <small>Pick matchups, then follow a winner to see who finishes in the top ${state.cutoff}${F < (state.result.freeMatches || 0) ? ". Matches you didn't pick are averaged over, so some teams show a chance instead of in/out" : ""}.</small></h2>${picker}
      <div class="zoom"><button data-zoom="out" aria-label="Zoom out">−</button><span>${state.treeZoom ? Math.round(state.treeZoom * 100) + "%" : "Fit"}</span><button data-zoom="in" aria-label="Zoom in">+</button><button data-zoom="fit">Fit</button></div>
      <div class="flow-wrap${state.treeZoom ? " zoomed" : ""}"><svg class="flow tree" viewBox="0 0 ${W} ${H}" style="${state.treeZoom ? `width:${Math.round(W * state.treeZoom)}px;min-width:0;max-width:none` : `min-width:${Math.min(W, 900)}px`}" role="img" aria-label="All remaining results">${out}</svg></div>`;
  }

  function matchesSection() {
    const d = state.data;
    const upcoming = d.matches.filter((m) => !isPlayed(m));
    const done = d.matches.filter(isPlayed);
    const groupBy = (ms) => {
      const g = new Map();
      for (const m of ms) { const k = m.round || "Matches"; if (!g.has(k)) g.set(k, []); g.get(k).push(m); }
      return [...g.entries()];
    };
    const date = (m) => m.start ? new Date(m.start).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
    const side = (t, cls, logoFirst) => {
      const names = `<span class="nm">${esc(t.name)}</span><span class="ini">${esc(t.initials || t.name)}</span>`;
      return `<span class="${cls}">${logoFirst ? logo(t) + names : names + logo(t)}</span>`;
    };

    const upcomingHtml = groupBy(upcoming).map(([name, ms]) => `<div class="round"><h3>${esc(name)}</h3>${ms.map((m) => {
      const t1 = team(m.team1), t2 = team(m.team2);
      const L = state.locked[m.id];
      const f = m.firstTo || 3;
      const opts1 = Array.from({ length: f }, (_, k) => `${f}-${k}`);
      const opts2 = Array.from({ length: f }, (_, k) => `${f - 1 - k}-${f}`);
      const btn = (s) => `<button data-m="${m.id}" data-s="${s}" class="${L && L.join("-") === s ? "on" : ""}" title="${esc(t1.name)} ${s} ${esc(t2.name)}">${s.replace("-", "–")}</button>`;
      const w = L ? (L[0] > L[1] ? 1 : 2) : 0;
      return `<div class="match ${L ? "locked" : ""}">
        ${side(t1, `t1 ${w === 2 ? "lose" : ""}`, false)}
        ${m.team1 && m.team2 ? `<span class="picker">${opts1.map(btn).join("")}<span class="sep"></span>${opts2.map(btn).join("")}</span>` : `<span class="score">vs</span>`}
        ${side(t2, `t2 ${w === 1 ? "lose" : ""}`, true)}
        <span class="date">${date(m)}</span>
      </div>`;
    }).join("")}</div>`).join("");

    const doneHtml = groupBy(done).map(([name, ms]) => `<div class="round"><h3>${esc(name)}</h3>${ms.map((m) => `
      <div class="match ${state.fresh.has(m.id) ? "fresh" : ""}">
        ${side(team(m.team1), `t1 ${m.s1 < m.s2 ? "lose" : ""}`, false)}
        <span class="score">${m.s1}–${m.s2}</span>
        ${side(team(m.team2), `t2 ${m.s2 < m.s1 ? "lose" : ""}`, true)}
      </div>`).join("")}</div>`).join("");

    return `
      ${upcoming.length ? `<h2>Remaining fixtures <small>Pick a scoreline to lock a what-if · click it again to unlock</small></h2><div class="rounds">${upcomingHtml}</div>` : ""}
      ${done.length ? `<details class="done" ${upcoming.length ? "" : "open"}><summary>${done.length} completed match${done.length > 1 ? "es" : ""}</summary><div class="rounds">${doneHtml}</div></details>` : ""}`;
  }

  // ---------- Events (delegated on the shadow root; no inline handlers, so host CSPs are happy) ----------
  function onClick(e) {
    const nav = e.target.closest("a[data-nav]");
    if (nav) {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) { if (opts.routing !== "none") return; }
      e.preventDefault();
      return navigate(nav.dataset.nav);
    }
    const zb = e.target.closest("button[data-zoom]");
    if (zb) {
      const z = state.treeZoom, k = zb.dataset.zoom;
      state.treeZoom = k === "fit" ? null : Math.min(3, Math.max(0.3, (z ?? 1) * (k === "in" ? 1.25 : 0.8)));
      const keep = root.querySelector(".flow-wrap"), sl = keep?.scrollLeft || 0, st = keep?.scrollTop || 0;
      render();
      const w = root.querySelector(".flow-wrap"); if (w) { w.scrollLeft = sl; w.scrollTop = st; }
      return;
    }
    const tl = e.target.closest("[data-leaf]");
    if (tl) { const k = tl.dataset.leaf; if (state.treeOpen.has(k)) state.treeOpen.delete(k); else state.treeOpen.add(k); return render(); }
    const fp = e.target.closest("button[data-focus]");
    if (fp) {
      const id = +fp.dataset.focus, cur = new Set(treeFocusIds() || openMatches().map((m) => m.id));
      if (cur.has(id)) cur.delete(id); else if (cur.size < 6) cur.add(id); else return;
      state.treeFocus = [...cur]; state.result = null; return run();
    }
    const tab = e.target.closest("button[data-tab]");
    if (tab) { state.tab = tab.dataset.tab; return render(); }
    if (e.target.closest('button[data-action="clear"]')) { state.locked = {}; state.result = null; return run(); }
    const pick = e.target.closest(".picker button");
    if (pick) {
      const id = pick.dataset.m, sc = pick.dataset.s;
      const cur = state.locked[id];
      if (cur && cur.join("-") === sc) delete state.locked[id];
      else state.locked[id] = sc.split("-").map(Number);
      state.result = null;
      run();
    }
  }
  // Broken images: team logos fall back to a colour chip, circuit logos are dropped.
  function onError(e) {
    const img = e.target;
    if (!(img instanceof HTMLImageElement) || !img.dataset.fallback) return;
    if (img.dataset.fallback === "chip") img.replaceWith(Object.assign(document.createElement("span"), { className: "chip" }));
    else img.remove();
  }

  // ---------- Auto-update from OWTV ----------
  // Re-fetch every minute (the server caches OWTV for 30s). When a result lands, standings and
  // odds are recounted; what-ifs on matches that have now been played are dropped.
  const signature = (d) => d.matches.map((m) => `${m.id}:${m.team1}:${m.team2}:${m.complete ? 1 : 0}:${m.s1}-${m.s2}`).join("|")
    + "#" + d.standings.map((x) => x.team).join(",");
  async function poll() {
    if (document.hidden || polling || destroyed) return;
    if (state.view === "home") return showHome();
    if (!state.data) return;
    polling = true;
    const id = state.phaseId;
    try {
      const next = await getJSON(`api/phase/${id}`);
      if (id !== state.phaseId) return;
      state.checkedAt = new Date();
      if (signature(next) === signature(state.data)) return;
      const before = new Map(state.data.matches.map((m) => [m.id, m]));
      const landed = next.matches.filter((m) => isPlayed(m) && !(before.has(m.id) && isPlayed(before.get(m.id))));
      for (const m of next.matches) if (isPlayed(m)) delete state.locked[m.id];
      state.data = next;
      state.news = [...state.news, ...landed].slice(-4);
      state.fresh = new Set([...state.fresh, ...landed.map((m) => m.id)]);
      state.result = null;
      run();
    } catch {
      // OWTV unreachable: try again on the next tick.
    } finally {
      polling = false;
    }
  }
  const onVisible = () => { if (!document.hidden && state.checkedAt && Date.now() - state.checkedAt > 20_000) poll(); };
  const onUrl = () => route();

  root.addEventListener("click", onClick);
  root.addEventListener("error", onError, true);
  document.addEventListener("visibilitychange", onVisible);
  if (opts.routing === "path") window.addEventListener("popstate", onUrl);
  if (opts.routing !== "none") window.addEventListener("hashchange", onUrl);
  const timer = setInterval(poll, POLL_MS);
  route();

  return {
    destroy() {
      destroyed = true;
      clearInterval(timer);
      root.removeEventListener("click", onClick);
      root.removeEventListener("error", onError, true);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("popstate", onUrl);
      window.removeEventListener("hashchange", onUrl);
      workerReady.then((w) => w.terminate()).catch(() => {});
    },
  };
}

// ---------- The custom element ----------
class OwcsScenarios extends HTMLElement {
  static observedAttributes = ["stage", "routing", "base", "api-base"];

  connectedCallback() {
    if (!this.shadowRoot) {
      const root = this.attachShadow({ mode: "open" });
      root.innerHTML = `<link rel="stylesheet" href="${new URL("styles.css", ASSET_BASE)}"><main class="app"></main>`;
    }
    this.#start();
  }
  disconnectedCallback() { this.tracker?.destroy(); this.tracker = null; }
  attributeChangedCallback() { if (this.tracker) this.#start(); }

  #start() {
    this.tracker?.destroy();
    this.tracker = createTracker(this, this.shadowRoot, this.shadowRoot.querySelector("main"));
  }
}

if (!customElements.get("owcs-scenarios")) customElements.define("owcs-scenarios", OwcsScenarios);
