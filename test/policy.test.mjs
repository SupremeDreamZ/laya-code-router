import test from "node:test";
import assert from "node:assert/strict";
import { decide, detectOverride, tierFromScores } from "../src/policy.mjs";
import { SCORE_QUESTIONS, SCORE_TIER, shouldUseExactModel } from "../src/config.mjs";

const ALL = ["haiku", "sonnet", "opus", "fable"];
// The bridge computes this shape: rubric scores normalised to 0..1, confidence = the
// mean of the three score-question confidences, N-way choice for the explanation UI.
const rubric = (score, confidence = 0.9) => ({
  metrics: { taskComplexity: score, reasoningRequired: score, toolComplexity: score },
  confidence,
});
const base = { prompt: "refactor the parser", current: "sonnet", available: ALL, contextTokens: 0 };

test("score rubrics are three-level lists under the option cap", () => {
  for (const question of Object.values(SCORE_QUESTIONS)) {
    assert.ok(Array.isArray(question.criteria));
    assert.equal(question.criteria.length, 3);
    assert.ok(question.criteria.length <= 10);
    assert.ok(typeof question.instructions === "string");
  }
});

test("the rubric maps scores onto tiers deterministically", () => {
  assert.equal(tierFromScores(rubric(0.05).metrics), "haiku");
  assert.equal(tierFromScores(rubric(0.4).metrics), "sonnet");
  assert.equal(tierFromScores(rubric(0.9).metrics), "opus");
  assert.equal(tierFromScores({}), null);
  assert.equal(tierFromScores({ taskComplexity: "x" }), null);
});

test("follows a confident rubric upgrade to strong", () => {
  assert.deepEqual(decide({ ...base, laya: rubric(0.9) }), {
    tier: "opus",
    reason: "laya",
    changed: true,
  });
});

test("an explicit user override beats Laya", () => {
  const out = decide({ ...base, prompt: "use haiku to fix this typo", laya: rubric(0.9) });
  assert.equal(out.tier, "haiku");
  assert.equal(out.reason, "override");
});

test("detectOverride only fires on a real instruction", () => {
  assert.equal(detectOverride("switch to opus"), "opus");
  assert.equal(detectOverride("use luna"), "haiku");
  assert.equal(detectOverride("use strong"), "opus");
  assert.equal(detectOverride("the opus of his career"), null);
});

test("keeps the current model when Laya is unreachable", () => {
  const out = decide({ ...base, laya: null });
  assert.equal(out.tier, "sonnet");
  assert.equal(out.changed, false);
  assert.match(out.reason, /laya-unavailable/);
});

test("keeps the current model when the rubric produces no usable scores", () => {
  const out = decide({ ...base, laya: { metrics: {}, confidence: null } });
  assert.equal(out.tier, "sonnet");
  assert.match(out.reason, /laya-unavailable/);
});

test("never downgrades on a low-confidence rubric", () => {
  const out = decide({ ...base, laya: rubric(0.05, 0.1) });
  assert.equal(out.tier, "sonnet");
  assert.match(out.reason, /low-confidence-no-downgrade/);
});

test("caps a low-confidence upgrade at the safe ceiling", () => {
  const out = decide({ ...base, current: "haiku", laya: rubric(0.9, 0.1) });
  assert.equal(out.tier, "sonnet");
  assert.equal(out.reason, "low-confidence-capped");
});

test("allows a confident upgrade with high confidence", () => {
  assert.equal(decide({ ...base, current: "haiku", laya: rubric(0.9, 0.85) }).tier, "opus");
});

test("refuses a downgrade once the cache rebuild costs more than it saves", () => {
  const out = decide({ ...base, current: "opus", laya: rubric(0.05), contextTokens: 80000 });
  assert.equal(out.tier, "opus");
  assert.match(out.reason, /cache-rebuild/);
});

test("allows the same downgrade early in a conversation", () => {
  assert.equal(decide({ ...base, current: "opus", laya: rubric(0.05) }).tier, "haiku");
});

test("substitutes upward when the chosen tier is unavailable", () => {
  const out = decide({ ...base, current: "haiku", available: ["haiku", "opus"], laya: rubric(0.4) });
  assert.equal(out.tier, "opus");
  assert.match(out.reason, /unavailable/);
});

test("never substitutes upward into paid fable", () => {
  const out = decide({ ...base, current: "haiku", available: ["haiku", "fable"], laya: rubric(0.9) });
  assert.equal(out.tier, "haiku");
});

test("accepts exact model changes within the same tier", () => {
  assert.equal(shouldUseExactModel("laya/no-change", "opus", "opus"), true);
  assert.equal(shouldUseExactModel("low-confidence-no-downgrade/no-change", "opus", "opus"), false);
});

test("the score floors bracket the tiers", () => {
  assert.ok(SCORE_TIER.weakFloor < SCORE_TIER.strongFloor);
  assert.ok(SCORE_TIER.weakFloor > 0);
  assert.ok(SCORE_TIER.strongFloor < 1);
});
