// Scenario engine tests. Run with: npm test
// sim.js is a classic worker script, so it's loaded into a VM context rather than imported.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const code = fs.readFileSync(new URL("../public/sim.js", import.meta.url), "utf8");
const ctx = { module: { exports: {} } };
vm.runInNewContext(code, ctx);
const { simulate } = ctx.module.exports;

// Four teams, round robin, first-to-3. A beat B 3-0 and C beat D 3-1; four matches left.
const base = {
  teams: [1, 2, 3, 4],
  played: [{ a: 1, b: 2, sa: 3, sb: 0 }, { a: 3, b: 4, sa: 3, sb: 1 }],
  remaining: [
    { id: 11, a: 1, b: 3, ft: 3 }, { id: 12, a: 2, b: 4, ft: 3 },
    { id: 13, a: 1, b: 4, ft: 3 }, { id: 14, a: 2, b: 3, ft: 3 },
  ],
  cutoff: 2,
  tiebreakers: ["wins", "mapDiff", "h2hWins"],
};
const byTeam = (res) => Object.fromEntries(res.results.map((r) => [r.team, r]));

test("few matches left: every scoreline is counted exactly", () => {
  const res = simulate(base);
  assert.equal(res.exact, true);
  assert.equal(res.total, 6 ** 4);
  for (const r of res.results) {
    const sum = r.pos.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9, `team ${r.team} place odds sum to ${sum}`);
  }
  // Two places qualify, so qualification chances add up to 2.
  const q = res.results.reduce((a, r) => a + r.qualify, 0);
  assert.ok(Math.abs(q - 2) < 1e-9);
});

test("locking every result gives a final table", () => {
  const locked = { 11: [3, 0], 12: [0, 3], 13: [3, 1], 14: [3, 2] };
  const res = simulate({ ...base, locked });
  assert.equal(res.freeMatches, 0);
  const t = byTeam(res);
  // Team 1 won all three; team 2 lost all three.
  assert.equal(t[1].pos[0], 1);
  assert.equal(t[2].pos[3], 1);
  assert.equal(t[1].qualify, 1);
  assert.equal(t[2].qualify, 0);
});

test("tiebreakers: a circular tie that nothing separates is split evenly", () => {
  const res = simulate({
    teams: [1, 2, 3],
    played: [{ a: 1, b: 2, sa: 3, sb: 2 }, { a: 2, b: 3, sa: 3, sb: 2 }, { a: 3, b: 1, sa: 3, sb: 2 }],
    remaining: [],
    cutoff: 1,
    tiebreakers: ["wins", "mapDiff", "h2hWins"],
  });
  // All three are 1-1 with +0 maps and a circular head-to-head, so it stays an even three-way split.
  for (const r of res.results) assert.ok(Math.abs(r.qualify - 1 / 3) < 1e-9);
});

test("tiebreaker order matters (NA puts head-to-head before map diff)", () => {
  // A and B both 2-1. A has the better map diff; B beat A.
  const input = {
    teams: ["A", "B", "C", "D"],
    played: [
      { a: "B", b: "A", sa: 3, sb: 2 }, { a: "A", b: "C", sa: 3, sb: 0 }, { a: "A", b: "D", sa: 3, sb: 0 },
      { a: "B", b: "C", sa: 3, sb: 2 }, { a: "D", b: "B", sa: 3, sb: 2 }, { a: "C", b: "D", sa: 3, sb: 0 },
    ],
    remaining: [],
    cutoff: 1,
  };
  const asia = byTeam(simulate({ ...input, tiebreakers: ["wins", "mapDiff", "h2hWins"] }));
  const na = byTeam(simulate({ ...input, tiebreakers: ["wins", "h2hWins", "h2hMapDiff", "mapDiff"] }));
  assert.equal(asia.A.pos[0], 1, "map diff first: A tops the table");
  assert.equal(na.B.pos[0], 1, "head-to-head first: B tops the table");
});

test("sampling is deterministic for the same inputs", () => {
  const many = {
    ...base,
    teams: [1, 2, 3, 4, 5, 6, 7, 8],
    played: [],
    remaining: Array.from({ length: 12 }, (_, i) => ({ id: 100 + i, a: 1 + (i % 8), b: 1 + ((i + 3) % 8), ft: 3 })),
  };
  const a = simulate(many), b = simulate(many);
  assert.equal(a.exact, false);
  assert.equal(a.seed, b.seed);
  assert.deepEqual(a.results.map((r) => r.qualify), b.results.map((r) => r.qualify));
  const c = simulate({ ...many, locked: { 100: [3, 0] } });
  assert.notEqual(c.seed, a.seed, "a what-if changes the sample");
});
