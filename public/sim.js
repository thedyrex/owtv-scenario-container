// Scenario engine. Runs as a Web Worker in the browser and as a module in Node (tests).
//
// Every remaining match can end in any legal scoreline (first-to-f => 2f outcomes).
// Each scoreline is weighted equally: there is no "likelihood" model; percentages are
// "share of all remaining scorelines in which this happens".
//
// Tiebreakers come from input.tiebreakers (per-region, see formats.js), e.g.
//   ["wins", "mapDiff", "h2hWins"]  (Asia/China)
//   ["wins", "h2hWins", "h2hMapDiff", "mapDiff", "mapPct", "sov"]  (NA/EMEA)
// Head-to-head criteria are recomputed within each tied subset; once a subset shrinks,
// it restarts from the first head-to-head criterion. Anything still tied is split evenly
// across the tied places.

const DEFAULT_TIEBREAKERS = ["wins", "mapDiff", "h2hWins", "h2hMapDiff", "mapsWon"];
const H2H = new Set(["h2hWins", "h2hMapDiff"]);

const EXACT_LIMIT = 3_000_000;
const SAMPLES = 400_000;

// Sampling is deterministic: the seed is a hash of the inputs, so the same results + what-ifs
// always draw the same sample (same numbers on every reload, for every viewer). It only
// changes when a real result or a locked what-if changes.
function seedFrom(input) {
  const key = JSON.stringify([input.teams, input.played, input.remaining.map((m) => m.id),
    input.locked || {}, input.cutoff, input.tiebreakers || null]);
  let h = 0x811c9dc5;                                  // FNV-1a
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
function mulberry32(a) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function simulate(input, onProgress) {
  const { teams, played, remaining, locked = {}, cutoff } = input;
  const n = teams.length;
  const idx = Object.fromEntries(teams.map((t, i) => [t, i]));

  // Base table from completed matches and locked results.
  const w = new Float64Array(n), mw = new Float64Array(n), ml = new Float64Array(n);
  const H = new Float64Array(n * n), HM = new Float64Array(n * n);
  const apply = (a, b, sa, sb, wA, mwA, mlA, HA, HMA) => {
    mwA[a] += sa; mlA[a] += sb; mwA[b] += sb; mlA[b] += sa;
    HMA[a * n + b] += sa; HMA[b * n + a] += sb;
    if (sa > sb) { wA[a]++; HA[a * n + b]++; } else if (sb > sa) { wA[b]++; HA[b * n + a]++; }
  };
  for (const m of played) {
    if (idx[m.a] == null || idx[m.b] == null) continue;
    apply(idx[m.a], idx[m.b], m.sa, m.sb, w, mw, ml, H, HM);
  }
  const free = [];
  for (const m of remaining) {
    const a = idx[m.a], b = idx[m.b];
    if (a == null || b == null) continue;
    const L = locked[m.id];
    if (L) apply(a, b, L[0], L[1], w, mw, ml, H, HM);
    else free.push({ id: m.id, a, b, f: m.ft || 3 });
  }
  const F = free.length;
  const radix = free.map((m) => 2 * m.f);
  let total = 1;
  for (const r of radix) { total *= r; if (total > EXACT_LIMIT) break; }
  const exact = total <= EXACT_LIMIT;
  const runs = exact ? total : SAMPLES;

  // Accumulators
  const pos = new Float64Array(n * n);          // pos[t*n + p]
  const qual = new Float64Array(n);
  const best = new Int32Array(n).fill(n), worst = new Int32Array(n).fill(-1);
  const myGames = Array.from({ length: n }, (_, t) => free.filter((m) => m.a === t || m.b === t).length);
  // bucket[t][k] = scenarios where t wins k of its free matches; cond = same, split by another match's winner
  const bCnt = teams.map((_, t) => new Float64Array(myGames[t] + 1));
  const bQ = teams.map((_, t) => new Float64Array(myGames[t] + 1));
  const cCnt = teams.map((_, t) => new Float64Array((myGames[t] + 1) * F * 2));
  const cQ = teams.map((_, t) => new Float64Array((myGames[t] + 1) * F * 2));

  // Scenario paths: per team, per own win count, per combination of OUTSIDE match winners. Only
  // tracked when the count is exact and small enough for the combinations to stay readable.
  const trackScen = exact && F <= 12;
  const NM = 1 << F;
  const sCnt = trackScen ? teams.map((_, t) => new Float64Array((myGames[t] + 1) * NM)) : null;
  const sQ = trackScen ? teams.map((_, t) => new Float64Array((myGames[t] + 1) * NM)) : null;
  // Whole-table outcome per combination of winners, for the all-results flowchart. Kept small.
  // input.focus = match ids to branch on (max 6); the other matches are averaged over. Without it,
  // an exact count with 6 or fewer matches left branches on all of them.
  let focusIdx = null;
  if (input.focus) focusIdx = input.focus.map((id) => free.findIndex((m) => m.id === id)).filter((i) => i >= 0).slice(0, 6);
  else if (trackScen && F > 0 && F <= 6) focusIdx = free.map((_, i) => i);
  const trackTree = !!focusIdx && focusIdx.length > 0;
  const NF = trackTree ? 1 << focusIdx.length : 0;
  const gCnt = trackTree ? new Float64Array(NF) : null;
  const gQ = trackTree ? new Float64Array(NF * n) : null;
  const gP = trackTree ? new Float64Array(NF * n) : null;       // summed finishing place (0-based) per leaf
  const runPlace = new Float64Array(n);
  // Per leaf: how each focus match's map score (loser's maps) moves each team's odds. Exact counts only.
  const KF = trackTree ? focusIdx.length : 0;
  const MF = trackTree ? Math.max(...focusIdx.map((i) => free[i].f)) : 0;
  const trackMar = trackTree && exact;
  const mCnt = trackMar ? new Float64Array(NF * KF * MF) : null;
  const mQ = trackMar ? new Float64Array(NF * n * KF * MF) : null;
  // Same, for pairs of focus matches, so a team that one score can't settle can be explained by two.
  const pairList = [];
  for (let a = 0; a < KF; a++) for (let b = a + 1; b < KF; b++) pairList.push([a, b]);
  const PK = pairList.length, MM = MF * MF;
  const trackPair = trackMar && PK > 0 && runs <= 600000;
  const pCnt = trackPair ? new Float64Array(NF * PK * MM) : null;
  const pQ = trackPair ? new Float64Array(NF * n * PK * MM) : null;
  const lms = new Int32Array(KF || 1);
  const cw = new Float64Array(n), cmw = new Float64Array(n), cml = new Float64Array(n);
  const cH = new Float64Array(n * n), cHM = new Float64Array(n * n);
  const out = new Int32Array(F);
  const winnerSide = new Uint8Array(F);         // 0 = a won, 1 = b won
  const myWins = new Int32Array(n);
  const q = new Float64Array(n);
  const all = Array.from({ length: n }, (_, i) => i);

  const tbs = input.tiebreakers?.length ? input.tiebreakers : DEFAULT_TIEBREAKERS;
  const firstH2H = tbs.findIndex((c) => H2H.has(c));
  const val = (set, crit, i) => {
    switch (tbs[crit]) {
      case "wins": return cw[i];
      case "mapDiff": return cmw[i] - cml[i];
      case "mapsWon": return cmw[i];
      case "h2hWins": { let s = 0; for (const j of set) s += cH[i * n + j]; return s; }
      case "mapPct": return cmw[i] / (cmw[i] + cml[i] || 1);
      case "sov": {                                   // combined record of every team i beat
        let bw = 0, bg = 0;
        for (let j = 0; j < n; j++) {
          if (cH[i * n + j] <= 0) continue;
          let lost = 0;
          for (let k = 0; k < n; k++) lost += cH[k * n + j];
          bw += cw[j]; bg += cw[j] + lost;
        }
        return bg ? bw / bg : 0;
      }
      case "h2hMapDiff": { let s = 0; for (const j of set) s += cHM[i * n + j] - cHM[j * n + i]; return s; }
      default: throw new Error("Unknown tiebreaker " + tbs[crit]);
    }
  };
  let place;
  const emit = (block) => {
    const k = block.length, s = place;
    const inCut = Math.max(0, Math.min(k, cutoff - s)) / k;
    for (const t of block) {
      for (let p = s; p < s + k; p++) pos[t * n + p] += 1 / k;
      q[t] = inCut; runPlace[t] = s + (k - 1) / 2;
      if (s < best[t]) best[t] = s;
      if (s + k - 1 > worst[t]) worst[t] = s + k - 1;
    }
    place += k;
  };
  const rank = (set, crit) => {
    if (set.length === 1) return emit(set);
    if (crit >= tbs.length) return emit(set);
    const v = set.map((i) => [i, val(set, crit, i)]).sort((x, y) => y[1] - x[1]);
    if (v[0][1] === v[v.length - 1][1]) return rank(set, crit + 1);
    if (set.length > 2 && firstH2H >= 0 && firstH2H <= crit) {
      // Once head-to-head has been reached, any criterion that splits 3+ teams only places the
      // leader. The rest go back to the first head-to-head criterion, recomputed among just themselves.
      const top = v.filter((x) => x[1] === v[0][1]).map((x) => x[0]);
      rank(top, firstH2H);
      return rank(set.filter((i) => !top.includes(i)), firstH2H);
    }
    let g = [v[0][0]];
    for (let x = 1; x <= v.length; x++) {
      if (x < v.length && v[x][1] === v[x - 1][1]) { g.push(v[x][0]); continue; }
      rank(g, firstH2H >= 0 && firstH2H <= crit ? firstH2H : crit + 1);
      if (x < v.length) g = [v[x][0]];
    }
  };

  const runOne = () => {
    cw.set(w); cmw.set(mw); cml.set(ml); cH.set(H); cHM.set(HM); myWins.fill(0);
    for (let i = 0; i < F; i++) {
      const m = free[i], o = out[i], f = m.f;
      const sa = o < f ? f : o - f, sb = o < f ? o : f;
      apply(m.a, m.b, sa, sb, cw, cmw, cml, cH, cHM);
      winnerSide[i] = o < f ? 0 : 1;
      myWins[o < f ? m.a : m.b]++;
    }
    place = 0;
    rank(all, 0);
    let allMask = 0;
    if (trackScen) for (let i = 0; i < F; i++) if (winnerSide[i]) allMask |= 1 << i;
    if (trackTree) {
      let gm = 0;
      for (let j = 0; j < focusIdx.length; j++) if (winnerSide[focusIdx[j]]) gm |= 1 << j;
      gCnt[gm]++; for (let t = 0; t < n; t++) { gQ[gm * n + t] += q[t]; gP[gm * n + t] += runPlace[t]; }
      if (trackMar) for (let j = 0; j < KF; j++) {
        const o = out[focusIdx[j]], f = free[focusIdx[j]].f, lm = o < f ? o : o - f;
        lms[j] = lm;
        mCnt[(gm * KF + j) * MF + lm]++;
        for (let t = 0; t < n; t++) mQ[((gm * n + t) * KF + j) * MF + lm] += q[t];
      }
      if (trackPair) for (let p = 0; p < PK; p++) {
        const cell = lms[pairList[p][0]] * MF + lms[pairList[p][1]];
        pCnt[(gm * PK + p) * MM + cell]++;
        for (let t = 0; t < n; t++) pQ[((gm * n + t) * PK + p) * MM + cell] += q[t];
      }
    }
    for (let t = 0; t < n; t++) {
      qual[t] += q[t];
      if (trackScen) {
        let mask = allMask;
        for (let i = 0; i < F; i++) if (free[i].a === t || free[i].b === t) mask &= ~(1 << i);
        const si = myWins[t] * NM + mask;
        sCnt[t][si]++; sQ[t][si] += q[t];
      }
      const k = myWins[t];
      bCnt[t][k]++; bQ[t][k] += q[t];
      const base = k * F * 2;
      for (let i = 0; i < F; i++) {
        const c = base + i * 2 + winnerSide[i];
        cCnt[t][c]++; cQ[t][c] += q[t];
      }
    }
  };

  const tick = Math.max(1, Math.floor(runs / 50));
  if (exact) {
    out.fill(0);
    for (let r = 0; r < runs; r++) {
      runOne();
      for (let i = 0; i < F; i++) { if (++out[i] < radix[i]) break; out[i] = 0; }
      if (onProgress && r % tick === 0) onProgress(r / runs);
    }
  } else {
    const rand = mulberry32(seedFrom(input));
    for (let r = 0; r < runs; r++) {
      for (let i = 0; i < F; i++) out[i] = (rand() * radix[i]) | 0;
      runOne();
      if (onProgress && r % tick === 0) onProgress(r / runs);
    }
  }

  // Summaries
  const results = teams.map((team, t) => {
    const buckets = [];
    for (let k = myGames[t]; k >= 0; k--) {
      if (!bCnt[t][k]) continue;
      const p = bQ[t][k] / bCnt[t][k];
      // Outside results that move this bucket's odds: the ones that help most, and any that on
      // their own put the team out. help is the single best, kept for older callers.
      const helps = [], outIf = [];
      if (p > 1e-9 && p < 1 - 1e-9) {
        for (let i = 0; i < F; i++) {
          const m = free[i];
          if (m.a === t || m.b === t) continue;
          for (let s = 0; s < 2; s++) {
            const c = k * F * 2 + i * 2 + s;
            if (!cCnt[t][c]) continue;
            const pc = cQ[t][c] / cCnt[t][c];
            const r = { matchId: m.id, winner: teams[s ? m.b : m.a], loser: teams[s ? m.a : m.b], p: pc };
            if (pc > p + 0.005) helps.push(r);
            else if (pc <= 1e-9) outIf.push(r);
          }
        }
        helps.sort((x, y) => y.p - x.p);
      }
      const help = helps[0] || null;
      // Every combination of outside winners that leaves the team a chance, best first.
      let scenarios = null;
      if (trackScen && p > 1e-9 && p < 1 - 1e-9) {
        scenarios = [];
        let total = 0;
        for (let mask = 0; mask < NM; mask++) {
          const c = sCnt[t][k * NM + mask];
          if (!c) continue;
          total++;
          const pm = sQ[t][k * NM + mask] / c;
          if (pm <= 1e-9) continue;
          const picks = [];
          for (let i = 0; i < F; i++) {
            const m = free[i];
            if (m.a === t || m.b === t) continue;
            const bWon = (mask >> i) & 1;
            picks.push({ matchId: m.id, winner: teams[bWon ? m.b : m.a], loser: teams[bWon ? m.a : m.b] });
          }
          scenarios.push({ picks, p: pm });
        }
        scenarios.sort((x, y) => y.p - x.p);
        scenarios = { total, alive: scenarios.length, list: scenarios.slice(0, 16) };
      }
      buckets.push({ wins: k, games: myGames[t], p, share: bCnt[t][k] / runs, help, helps: helps.slice(0, 3), outIf: outIf.slice(0, 2), scenarios });
    }
    return {
      team,
      qualify: qual[t] / runs,
      pos: Array.from({ length: n }, (_, p) => pos[t * n + p] / runs),
      best: best[t] + 1, worst: worst[t] + 1,
      buckets,
    };
  });
  const tree = trackTree ? {
    teams, matches: focusIdx.map((i) => ({ id: free[i].id, a: teams[free[i].a], b: teams[free[i].b], ft: free[i].f })),
    leaves: Array.from({ length: NF }, (_, mask) => gCnt[mask] ? {
      share: gCnt[mask] / runs,
      q: Array.from({ length: n }, (_, t) => gQ[mask * n + t] / gCnt[mask]),
      place: Array.from({ length: n }, (_, t) => gP[mask * n + t] / gCnt[mask] + 1),
      // by[t][j][lm]: odds for team t when focus match j ended with the loser on lm maps (null if never)
      pairs: trackPair ? {
        list: pairList, mf: MF,
        by: Array.from({ length: n }, (_, t) => pairList.map((_, p) => Array.from({ length: MM }, (_, c) => {
          const k = pCnt[(mask * PK + p) * MM + c];
          return k ? pQ[((mask * n + t) * PK + p) * MM + c] / k : null;
        }))),
      } : null,
      by: trackMar ? Array.from({ length: n }, (_, t) => Array.from({ length: KF }, (_, j) => Array.from({ length: MF }, (_, lm) => {
        const c = mCnt[(mask * KF + j) * MF + lm];
        return c ? mQ[((mask * n + t) * KF + j) * MF + lm] / c : null;
      }))) : null,
    } : null),
  } : null;
  return { tree, exact, runs, total: exact ? total : null, freeMatches: F, seed: exact ? null : seedFrom(input), results };
}

if (typeof self !== "undefined" && typeof self.postMessage === "function" && typeof window === "undefined") {
  self.onmessage = (e) => {
    const { id, input } = e.data;
    const res = simulate(input, (p) => self.postMessage({ id, progress: p }));
    self.postMessage({ id, result: res });
  };
}
if (typeof module !== "undefined") module.exports = { simulate };
