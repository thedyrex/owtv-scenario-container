// Circuit formats (ES module), from Liquipedia (liquipedia.net/overwatch/Overwatch_Champions_Series/2026).
// Checked 2026-09-28. The keys are OWTV tournament-phase ids.
//
// zones: finishing-place bands (1-based, inclusive). The first zone is the headline cutoff.
// tiebreakers: see sim.js. Liquipedia's standings tables list them per region:
//   Asia (Japan / Korea / Pacific) & China: series → map diff → head-to-head
//   NA & EMEA (rulebook 11.4): series → head-to-head series → head-to-head map diff → map diff
//   → map score % → strength of victory (combined record of teams beaten)

const LP = "https://liquipedia.net/overwatch/Overwatch_Champions_Series/2026/";

const TIEBREAKERS = {
  asia: ["wins", "mapDiff", "h2hWins"],
  china: ["wins", "mapDiff", "h2hWins"],
  na: ["wins", "h2hWins", "h2hMapDiff", "mapDiff", "mapPct", "sov"],
  emea: ["wins", "h2hWins", "h2hMapDiff", "mapDiff", "mapPct", "sov"],
};
const TIEBREAKER_SOURCE = {
  asia: "OWCS rulebook 10.4 (Liquipedia)", china: "Liquipedia",
  na: "OWCS rulebook 11.4", emea: "OWCS rulebook 11.4",
};

const FORMATS = {
  // Japan Stage 3: Regular Season
  112: {
    tb: "asia",
    zones: [{ from: 1, to: 4, label: "Regional Playoffs" }],
    path: [
      "Regular Season: round robin, Ft3. Top 4 advance to Regional Playoffs.",
      "Regional Playoffs (Oct 19–20): single elimination, Ft4. Top 3 advance to OWCS Asia Stage 3.",
    ],
    link: LP + "Asia/Stage_3/Japan",
  },
  // Korea Stage 3: Regular Season
  100: {
    tb: "asia",
    zones: [
      { from: 1, to: 4, label: "Seeding Deciders" },
      { from: 5, to: 8, label: "Last Chance Qualifier" },
      { from: 9, to: 9, label: "Promotion/Relegation" },
    ],
    path: [
      "Regular Season: round robin, Ft3. Top 4 advance to the Playoffs Seeding Decider Matches (results carry over; top 2 get a first-round bye). Next 4 go to the Last Chance Qualifier (5th and 6th start in the upper bracket).",
      "Last Chance Qualifier: double elimination, Ft3. Top 2 advance to Regional Playoffs.",
      "Regional Playoffs (Nov 6–8): single elimination, Ft4. Top 4 advance to OWCS Asia Stage 3.",
    ],
    link: LP + "Asia/Stage_3/Korea",
  },
  // Pacific Stage 3: Regular Season
  111: {
    tb: "asia",
    zones: [{ from: 1, to: 4, label: "Regional Playoffs" }],
    path: [
      "Regular Season: round robin, Ft3. Top 4 advance to Regional Playoffs.",
      "Regional Playoffs (Nov 3): single elimination, Ft3 (Grand Final Ft4). Winner advances to OWCS Asia Stage 3.",
    ],
    link: LP + "Asia/Stage_3/Pacific",
  },
  // NA Stage 3: Regular Season
  95: {
    tb: "na",
    zones: [{ from: 1, to: 4, label: "Regional Playoffs" }],
    path: [
      "Regular Season: round robin, Ft3. Top 4 advance to Regional Playoffs.",
      "Regional Playoffs (Oct 30–Nov 1): double elimination, Ft3 (Grand Final Ft4).",
    ],
    link: LP + "NA/Stage_3",
  },
  // EMEA Stage 3: Regular Season
  93: {
    tb: "emea",
    zones: [{ from: 1, to: 4, label: "Regional Playoffs" }],
    path: [
      "Regular Season: round robin, Ft3. Top 4 advance to Regional Playoffs.",
      "Regional Playoffs (Oct 30–Nov 1): double elimination, Ft3 (Grand Final Ft4).",
    ],
    link: LP + "EMEA/Stage_3",
  },
  // China Stage 3: Swiss, then Round Robin
  97: {
    tb: "china",
    zones: [{ from: 1, to: 6, label: "Round Robin Stage" }],
    path: ["Swiss Stage: top 6 advance to the Round Robin Stage."],
    link: LP + "China/Stage_3",
  },
  98: {
    tb: "china",
    zones: [{ from: 1, to: 4, label: "Regional Playoffs" }],
    path: [
      "Round Robin Stage: Ft3. Top 4 advance to Regional Playoffs.",
      "Regional Playoffs (Nov 7–8): double elimination, Ft3 (Grand Final Ft4).",
    ],
    link: LP + "China/Stage_3",
  },
};

// Anything not listed above falls back to the region's tiebreakers and the OWTV description.
function regionKey(regions = []) {
  const r = regions.join(" ").toLowerCase();
  if (/\bna\b/.test(r)) return "na";
  if (/emea/.test(r)) return "emea";
  if (/\bcn\b|china/.test(r)) return "china";
  if (/korea|jpn|japan|pac|asia/.test(r)) return "asia";
  return null;
}

export function formatFor(phaseId, regions) {
  const f = FORMATS[phaseId];
  const tb = f?.tb || regionKey(regions);
  return {
    zones: f?.zones || null,
    path: f?.path || [],
    link: f?.link || null,
    tiebreakers: tb ? TIEBREAKERS[tb] : null,
    tiebreakerSource: tb ? TIEBREAKER_SOURCE[tb] : "default",
  };
}
