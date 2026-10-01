// OWCS Scenario Tracker: zero-dependency server.
// Proxies the OWTV API (keeping the key server-side) and serves ./public, including the
// embeddable <owcs-scenarios> component.
//
// Environment:
//   OWTV_API_KEY  required. Can also live in .env.
//   PORT          default 3000.
//   CORS_ORIGIN   who may embed the component / call the API. Default "*".
//                 Set to e.g. "https://owtv.gg" to allow only that site.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, "public");
const API = "https://owtv.gg/api";
const PORT = Number(process.env.PORT) || 3000;
const CACHE_MS = 30_000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";

loadDotEnv();
const KEY = process.env.OWTV_API_KEY;
if (!KEY) {
  console.error("Missing OWTV_API_KEY (set it in the environment or in .env)");
  process.exit(1);
}

function loadDotEnv() {
  try {
    const txt = fs.readFileSync(path.join(ROOT, ".env"), "utf8");
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {}
}

// ---------- OWTV API access with a small TTL cache ----------
const cache = new Map();
async function owtv(pathAndQuery) {
  const hit = cache.get(pathAndQuery);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  const res = await fetch(`${API}/${pathAndQuery}`, { headers: { "X-API-Key": KEY } });
  if (!res.ok) throw new Error(`OWTV ${res.status} for ${pathAndQuery}`);
  const data = await res.json();
  cache.set(pathAndQuery, { at: Date.now(), data });
  return data;
}

async function all(collection, query = "") {
  const out = [];
  for (let page = 1; ; page++) {
    const depth = /(^|&)depth=/.test(query) ? "" : "&depth=0";
    const d = await owtv(`${collection}?limit=500${depth}&page=${page}${query ? "&" + query : ""}`);
    out.push(...d.docs);
    if (!d.hasNextPage) return out;
  }
}

async function teamsById(ids) {
  ids = [...new Set(ids.filter(Boolean))];
  if (!ids.length) return {};
  // depth=1 embeds each team's `image` media doc, which carries the public logo URL.
  const docs = await all("team", `where[id][in]=${ids.join(",")}&depth=1`);
  return Object.fromEntries(docs.map((t) => [t.id, {
    id: t.id, name: t.name, initials: t.initials, color: t.primaryColour,
    logo: logoUrl(t.image),
  }]));
}

// Prefer the 300px thumbnail when OWTV generated one; logos are shown small.
// "Regular Season - Swiss Stage" -> "regular-season-swiss-stage" (used in readable page URLs)
const slugify = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// Resolve /<tournament-slug>/<stage-slug> to an OWTV phase id.
async function phaseIdFromSlugs(tSlug, pSlug) {
  const [t] = await all("tournament", `where[slug][equals]=${encodeURIComponent(tSlug)}`);
  if (!t) return null;
  const phases = await all("tournament-phase", `where[tournament][equals]=${t.id}`);
  return phases.find((p) => slugify(p.name) === pSlug)?.id ?? null;
}

function logoUrl(img) {
  if (!img || typeof img !== "object") return null;
  const url = img.sizes?.thumbnail?.url || img.url;
  return typeof url === "string" && url.startsWith("https://owtv.gg/") ? url : null;
}

// Home page: tier-1 circuits with at least one stage that is live or still to come.
// A stage counts as done when every match has a result, or its end date has passed.
async function listCircuits() {
  const now = new Date().toISOString();
  const [phases, tournaments, regions] = await Promise.all([
    // Regular seasons only; seeding deciders ("groups" phases) aren't tracked.
    all("tournament-phase", "where[type][equals]=regular_season"),
    all("tournament"),
    all("region"),
  ]);
  const tById = Object.fromEntries(tournaments.map((t) => [t.id, t]));
  const rById = Object.fromEntries(regions.map((r) => [r.id, r]));
  // OWTV sometimes has a phase ending before it starts (e.g. Korea/EMEA Stage 3), so a phase's
  // end date only counts when it's after its start; otherwise fall back to the tournament's.
  const endOf = (p, t) => {
    const s = p.startDate || t.startDate;
    return p.endDate && (!s || p.endDate >= s) ? p.endDate : t.endDate;
  };
  const candidates = phases.filter((p) => {
    const t = tById[p.tournament];
    if (!t || t.tier !== "1") return false;
    if (/round robin/i.test(p.name || "")) return false; // e.g. China's second-phase Round Robin Stage

    const end = endOf(p, t);
    return !(end && end < now);
  });
  if (!candidates.length) return [];

  const matches = await all("match", `where[tournamentPhase][in]=${candidates.map((p) => p.id).join(",")}`);
  const byPhase = {};
  for (const m of matches) (byPhase[m.tournamentPhase] ||= []).push(m);

  const circuits = new Map();
  for (const p of candidates) {
    const ms = byPhase[p.id] || [];
    const played = ms.filter((m) => m.complete).length;
    if (ms.length && played === ms.length) continue; // finished
    const t = tById[p.tournament];
    const start = p.startDate || t.startDate;
    const tbd = !ms.length || ms.some((m) => !m.team1 || !m.team2);
    const status = start && start <= now ? "ongoing" : tbd ? "tbd" : "upcoming";
    if (!circuits.has(t.id)) {
      circuits.set(t.id, {
        id: t.id, name: t.name, slug: t.slug, imageId: t.image,
        startDate: t.startDate, endDate: t.endDate,
        regions: (t.regions || []).map((id) => rById[id]).filter(Boolean).map((r) => ({ name: r.name, color: r.color })),
        stages: [],
      });
    }
    circuits.get(t.id).stages.push({
      id: p.id, name: p.name, slug: slugify(p.name), startDate: start, endDate: endOf(p, t),
      matches: ms.length, played, tbd, status,
    });
  }

  const list = [...circuits.values()];
  await Promise.all(list.map(async (c) => {
    c.logo = c.imageId ? logoUrl(await owtv(`media/${c.imageId}?depth=0`).catch(() => null)) : null;
    delete c.imageId;
    c.stages.sort((a, b) => String(a.startDate).localeCompare(String(b.startDate)));
    c.status = c.stages.some((s) => s.status === "ongoing") ? "ongoing" : c.stages.some((s) => s.status === "upcoming") ? "upcoming" : "tbd";
  }));
  const rank = { ongoing: 0, upcoming: 1, tbd: 2 };
  return list.sort((a, b) => rank[a.status] - rank[b.status] || String(a.startDate).localeCompare(String(b.startDate)));
}

async function phaseDetail(id) {
  const [phase, matches, standings, rounds] = await Promise.all([
    owtv(`tournament-phase/${id}?depth=0`),
    all("match", `where[tournamentPhase][equals]=${id}`),
    all("tournament-phase-standing", `where[tournamentPhase][equals]=${id}`),
    all("tournament-phase-round", `where[tournamentPhase][equals]=${id}`),
  ]);
  const [tournament, regions] = await Promise.all([owtv(`tournament/${phase.tournament}?depth=0`), all("region")]);
  const regionDocs = (tournament.regions || []).map((r) => regions.find((x) => x.id === r)).filter(Boolean);
  // Circuit/tournament logo (e.g. the OWCS Asia badge): a media doc like team logos.
  const tournamentLogo = tournament.image
    ? logoUrl(await owtv(`media/${tournament.image}?depth=0`).catch(() => null))
    : null;
  const regionNames = regionDocs.map((r) => r.name);
  const teams = await teamsById([
    ...standings.map((s) => s.team),
    ...matches.flatMap((m) => [m.team1, m.team2]),
  ]);
  const roundName = Object.fromEntries(rounds.map((r) => [r.id, r.name]));
  return {
    phase: {
      id: phase.id, name: phase.name, slug: slugify(phase.name), type: phase.type, description: phase.description,
      startDate: phase.startDate, endDate: phase.endDate,
    },
    tournament: { id: tournament.id, name: tournament.name, slug: tournament.slug, regions: regionNames,
      regionBadges: regionDocs.map((r) => ({ name: r.name, color: r.color })),
      startDate: tournament.startDate, endDate: tournament.endDate, logo: tournamentLogo },
    teams,
    standings: standings.map((s) => ({
      team: s.team, seed: s.seed, group: s.groupNumber, tiebreakerOrder: s.tiebreakerOrder,
    })),
    matches: matches
      .map((m) => ({
        id: m.id, slug: m.slug, team1: m.team1, team2: m.team2,
        s1: m.team1Score, s2: m.team2Score, winner: m.winningTeam,
        complete: !!m.complete, firstTo: m.firstTo || 3, resultType: m.resultType,
        start: m.startDate, round: roundName[m.round] || null, group: m.bracketGroup,
      }))
      .sort((a, b) => String(a.start).localeCompare(String(b.start))),
    fetchedAt: new Date().toISOString(),
  };
}

// ---------- HTTP ----------
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json" };

// API responses are never cached by browsers (the server already caches OWTV for 30s).
// Static files use ETags: browsers revalidate each load (a cheap 304), so embeds pick up a new
// release immediately without re-downloading unchanged files.
function send(res, code, body, type = "application/json", extra = {}) {
  res.writeHead(code, {
    "Content-Type": type + "; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": CORS_ORIGIN,
    "Vary": "Origin",
    ...extra,
  });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "Access-Control-Allow-Origin": CORS_ORIGIN, "Access-Control-Allow-Methods": "GET", "Access-Control-Max-Age": "86400" });
      return res.end();
    }
    if (url.pathname === "/healthz") return send(res, 200, { ok: true });
    if (url.pathname === "/api/circuits") return send(res, 200, await listCircuits());
    const m = url.pathname.match(/^\/api\/phase\/(\d+)$/);
    if (m) return send(res, 200, await phaseDetail(m[1]));
    const sm = url.pathname.match(/^\/api\/stage\/([a-z0-9-]+)\/([a-z0-9-]+)$/);
    if (sm) {
      const id = await phaseIdFromSlugs(sm[1], sm[2]);
      return id ? send(res, 200, await phaseDetail(id)) : send(res, 404, { error: "Stage not found" });
    }
    if (url.pathname.startsWith("/api/")) return send(res, 404, { error: "not found" });

    if (url.pathname === "/") { res.writeHead(302, { Location: "/scenario-tracker/" + url.search }); return res.end(); }

    // Readable page URLs (/scenario-tracker/japan-stage-3-owcs-2026/regular-season) have no file extension: serve the app.
    const rel = url.pathname.startsWith("/scenario-tracker") || !path.extname(url.pathname) ? "index.html" : url.pathname.slice(1);
    const file = path.normalize(path.join(PUBLIC, rel));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      return send(res, 404, "Not found", "text/plain");
    }
    const stat = fs.statSync(file);
    const etag = `"${stat.size.toString(36)}-${stat.mtimeMs.toString(36)}"`;
    const headers = { "Cache-Control": "no-cache", ETag: etag };
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, { ...headers, "Access-Control-Allow-Origin": CORS_ORIGIN, Vary: "Origin" });
      return res.end();
    }
    send(res, 200, fs.readFileSync(file, "utf8"), MIME[path.extname(file)] || "text/plain", headers);
  } catch (err) {
    console.error(err);
    send(res, 502, { error: String(err.message || err) });
  }
}).listen(PORT, () => console.log(`OWCS tracker on http://localhost:${PORT}`));
