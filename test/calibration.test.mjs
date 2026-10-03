// Pin the calibration so a future edit that breaks it fails loudly, with no LAYA process needed.
// FIXTURE is the real output: dirien/jev-router's 58 labeled prompts (eval/prompts.jsonl) scored
// by this checkpoint on 2026-09-30 under production conditions (the proxy's own model list, opus
// as the current model, ~5,600 tokens of context). Each row is [expected class, rubric mean].
import test from "node:test";
import assert from "node:assert/strict";
import { SCORE_TIER, scoreTierFor } from "../src/config.mjs";

const FIXTURE = [
  ["mechanical", 0.4228],
  ["mechanical", 0.4772],
  ["mechanical", 0.4778],
  ["mechanical", 0.4207],
  ["mechanical", 0.4625],
  ["mechanical", 0.5128],
  ["mechanical", 0.3474],
  ["mechanical", 0.4995],
  ["mechanical", 0.4468],
  ["mechanical", 0.3645],
  ["mechanical", 0.4878],
  ["mechanical", 0.3886],
  ["routine", 0.4585],
  ["routine", 0.4448],
  ["routine", 0.4445],
  ["routine", 0.461],
  ["routine", 0.5179],
  ["routine", 0.4992],
  ["routine", 0.5037],
  ["routine", 0.5137],
  ["routine", 0.5417],
  ["routine", 0.5453],
  ["routine", 0.5412],
  ["routine", 0.4742],
  ["complex", 0.5643],
  ["complex", 0.5744],
  ["complex", 0.601],
  ["complex", 0.5776],
  ["complex", 0.4908],
  ["complex", 0.5175],
  ["complex", 0.606],
  ["complex", 0.5153],
  ["complex", 0.5482],
  ["complex", 0.5474],
  ["complex", 0.5417],
  ["complex", 0.6689],
  ["deep", 0.5559],
  ["deep", 0.5165],
  ["deep", 0.6183],
  ["deep", 0.6503],
  ["deep", 0.5276],
  ["deep", 0.4925],
  ["deep", 0.5626],
  ["deep", 0.5527],
  ["deep", 0.5737],
  ["deep", 0.5415],
  ["deep", 0.5394],
  ["deep", 0.5271],
  ["complex", 0.459],
  ["complex", 0.4478],
  ["complex", 0.5966],
  ["deep", 0.5747],
  ["deep", 0.598],
  ["deep", 0.5571],
  ["routine", 0.4035],
  ["mechanical", 0.514],
  ["routine", 0.4169],
  ["complex", 0.5687],
];
const TIER = { mechanical: 0, routine: 1, complex: 2, deep: 2 };
const pick = (m) => (m < SCORE_TIER.weakFloor ? 0 : m < SCORE_TIER.strongFloor ? 1 : 2);
const stats = (predicate) => {
  const rows = FIXTURE.filter(predicate);
  return { n: rows.length, right: rows.filter(([c, m]) => pick(m) === TIER[c]).length };
};

test("the fixture is the whole labeled set", () => {
  assert.equal(FIXTURE.length, 58);
});

test("the shipped floors make the fast tier reachable, which 0.18 never did", () => {
  assert.ok(FIXTURE.some(([c, m]) => c === "mechanical" && pick(m) === 0));
  assert.equal(FIXTURE.filter(([, m]) => m < 0.18).length, 0, "no real score is below the old 0.18 floor");
});

test("tier accuracy on the labeled set stays well above always-guess-balanced (24%)", () => {
  const all = stats(() => true);
  assert.ok(all.right / all.n >= 0.6, `accuracy ${(all.right / all.n).toFixed(3)}`);
});

test("hard work is rarely sent below balanced, and never as far down as the fast tier more than once", () => {
  const hard = FIXTURE.filter(([c]) => TIER[c] === 2);
  const belowBalanced = hard.filter(([, m]) => pick(m) < 1).length;
  assert.ok(belowBalanced <= 1, `${belowBalanced} of ${hard.length} hard prompts routed to the fast tier`);
});

// The presets on the same fixture. Measured when they were chosen (2026-10-03):
//   savings  weak 0.416 strong 0.540: 24 to Opus, 11 under-routed, 59% right, 0 hard to Haiku
//   balanced weak 0.396 strong 0.515: 31 to Opus,  4 under-routed, 69% right, 0 hard to Haiku
//   careful  weak 0.376 strong 0.490: 39 to Opus,  2 under-routed, 66% right, 0 hard to Haiku
const byPreset = (preset) => {
  const t = scoreTierFor(preset);
  const at = (m) => (m < t.weakFloor ? 0 : m < t.strongFloor ? 1 : 2);
  return {
    opus: FIXTURE.filter(([, m]) => at(m) === 2).length,
    under: FIXTURE.filter(([c, m]) => at(m) < TIER[c]).length,
    hardToHaiku: FIXTURE.filter(([c, m]) => TIER[c] === 2 && at(m) === 0).length,
  };
};

test("presets: savings sends less to Opus, careful under-routes less, and none sends hard work to Haiku", () => {
  const [s, b, c] = ["savings", "balanced", "careful"].map(byPreset);
  assert.ok(s.opus < b.opus && b.opus < c.opus, JSON.stringify({ s, b, c }));
  assert.ok(c.under <= b.under && b.under < s.under, JSON.stringify({ s, b, c }));
  for (const p of [s, b, c]) assert.equal(p.hardToHaiku, 0);
});
