import test from "node:test";
import assert from "node:assert/strict";
import { decide, detectOverride, tierFromScores, effortFor, settleEffort, isDesignWork } from "../src/policy.mjs";
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
  assert.equal(tierFromScores(rubric(0.47).metrics), "sonnet");
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
  const out = decide({ ...base, current: "opus", laya: rubric(0.05), contextTokens: 80000, fresh: false });
  assert.equal(out.tier, "opus");
  assert.match(out.reason, /cache-rebuild|ratchet/);
});

test("allows a downgrade when the session has no ongoing decision to build on", () => {
  assert.equal(decide({ ...base, current: "opus", laya: rubric(0.05), fresh: true }).tier, "haiku");
});

test("substitutes upward when the chosen tier is unavailable", () => {
  const out = decide({ ...base, current: "haiku", available: ["haiku", "opus"], laya: rubric(0.47) });
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


// dirien/jev-router (the Jev router live-tested against Claude Code): within a session the tier
// only goes up, because a downgrade throws away the prompt cache; a new, idle or compacted
// session has no ongoing decision to protect and is decided fresh.
test("ratchet: an ongoing session never moves down, whatever LAYA says", () => {
  const out = decide({ ...base, current: "opus", laya: rubric(0.05), fresh: false });
  assert.equal(out.tier, "opus");
  assert.equal(out.changed, false);
  assert.match(out.reason, /ratchet/);
});

test("ratchet: an ongoing session still moves up", () => {
  assert.equal(decide({ ...base, current: "haiku", laya: rubric(0.9, 0.85), fresh: false }).tier, "opus");
});

test("ratchet: a fresh session takes LAYA's tier in either direction", () => {
  assert.equal(decide({ ...base, current: "opus", laya: rubric(0.47), fresh: true }).tier, "sonnet");
  assert.equal(decide({ ...base, current: "sonnet", laya: rubric(0.9, 0.85), fresh: true }).tier, "opus");
});

test("ratchet: fresh defaults to false, so existing callers keep the safe behaviour", () => {
  assert.equal(decide({ ...base, current: "opus", laya: rubric(0.05) }).tier, "opus");
});

test("ratchet: an explicit override still moves down, because the human decided", () => {
  const out = decide({ ...base, prompt: "use haiku: list files", current: "opus", laya: rubric(0.9), fresh: false });
  assert.equal(out.tier, "haiku");
  assert.equal(out.reason, "override");
});

// Fit on dirien's 58 labeled prompts with LAYA's real scores, asymmetric cost (under-routing
// costs twice over-routing), leave-one-out. Shipped thresholds 0.18/0.62 scored 29% with 48%
// under-routed; the fitted ones scored 65% out of sample with 7% under-routed.
test("the calibrated floors sit inside the band LAYA actually produces", () => {
  assert.ok(SCORE_TIER.weakFloor > 0.37 && SCORE_TIER.weakFloor < 0.43, `weakFloor ${SCORE_TIER.weakFloor}`);
  assert.ok(SCORE_TIER.strongFloor > 0.5 && SCORE_TIER.strongFloor < 0.53, `strongFloor ${SCORE_TIER.strongFloor}`);
});

test("a typical ordinary score lands on sonnet and a typical hard score on opus", () => {
  assert.equal(tierFromScores(rubric(0.48).metrics), "sonnet");
  assert.equal(tierFromScores(rubric(0.58).metrics), "opus");
  assert.equal(tierFromScores(rubric(0.37).metrics), "haiku");
});


// Haiku is the cheap first attempt: a human reviews the work, and the ratchet lets a later, harder
// message move the session up, so wrongly sending ordinary work to Haiku is recoverable while
// wrongly sending hard work to it costs a bad answer. LAYA's blended score cannot tell
// Haiku-shaped work from ordinary work well enough on its own (AUC 0.82 pooled over 116 labeled
// prompts), so a second question, "would this need investigating, design, or several files?",
// vetoes the cases the blend would misplace. Measured on those 116: at mean < 0.48 with judgment
// < 0.45, 59% of Haiku-shaped work reaches Haiku and 0 of 37 Opus-shaped prompts do (the blend
// alone sent 2 of 37).
const withJudgment = (mean, judgment) => ({
  taskComplexity: mean,
  reasoningRequired: mean,
  toolComplexity: mean,
  judgment,
});

test("haiku: a low score with a low need for judgment goes to the cheap tier", () => {
  assert.equal(tierFromScores(withJudgment(0.46, 0.15)), "haiku");
  assert.equal(tierFromScores(withJudgment(0.475, 0.30)), "haiku");
});

test("haiku: a low score is vetoed when the work would need investigating or design", () => {
  // e.g. "there's a race condition somewhere in the scheduler": scored 0.448 but judgment 0.85
  assert.equal(tierFromScores(withJudgment(0.448, 0.85)), "sonnet");
  assert.equal(tierFromScores(withJudgment(0.46, 0.48)), "sonnet");
});

test("haiku: above the cut it is never haiku, whatever the judgment", () => {
  assert.equal(tierFromScores(withJudgment(0.49, 0.05)), "sonnet");
});

test("haiku: without a judgment answer it falls back to the conservative floor", () => {
  assert.equal(tierFromScores({ taskComplexity: 0.46, reasoningRequired: 0.46, toolComplexity: 0.46 }), "sonnet");
  assert.equal(tierFromScores({ taskComplexity: 0.37, reasoningRequired: 0.37, toolComplexity: 0.37 }), "haiku");
  assert.equal(tierFromScores({ ...withJudgment(0.46, null) }), "sonnet");
});

test("haiku: hard work still reaches opus regardless of judgment", () => {
  assert.equal(tierFromScores(withJudgment(0.6, 0.05)), "opus");
  assert.equal(tierFromScores(withJudgment(0.6, 0.9)), "opus");
});

test("haiku: the cut and the veto are inside the band LAYA produces", () => {
  assert.ok(SCORE_TIER.haikuCut > SCORE_TIER.weakFloor && SCORE_TIER.haikuCut < SCORE_TIER.strongFloor);
  assert.ok(SCORE_TIER.judgmentVeto > 0.2 && SCORE_TIER.judgmentVeto < 0.6);
});


// Effort is the second thing the router decides. Anthropic: lower effort is faster and cheaper
// for straightforward work; "for agentic coding and multistep tool use, start with medium for
// well-specified tasks and move to high for harder or longer ones" (Sonnet 5.5); Opus 5.5's
// default is medium. Haiku takes no effort parameter at all.
const at = (mean, judgment) => ({ taskComplexity: mean, reasoningRequired: mean, toolComplexity: mean, judgment });

test("effort: haiku has none, because Haiku cannot take the parameter", () => {
  assert.equal(effortFor("haiku", at(0.4, 0.1)), null);
});

test("effort: sonnet is low for a stated task, medium by default, high for work that needs investigating", () => {
  assert.equal(effortFor("sonnet", at(0.49, 0.15)), "low");
  assert.equal(effortFor("sonnet", at(0.49, 0.40)), "medium");
  assert.equal(effortFor("sonnet", at(0.49, 0.75)), "high");
});

test("effort: opus is medium for well-specified work and high for hard or open-ended work", () => {
  assert.equal(effortFor("opus", at(0.52, 0.30)), "medium");
  assert.equal(effortFor("opus", at(0.56, 0.30)), "high");
  assert.equal(effortFor("opus", at(0.52, 0.70)), "high");
});

test("effort: without a judgment answer it stays at the documented default", () => {
  assert.equal(effortFor("sonnet", { taskComplexity: 0.49, reasoningRequired: 0.49, toolComplexity: 0.49 }), "medium");
  assert.equal(effortFor("opus", { taskComplexity: 0.52, reasoningRequired: 0.52, toolComplexity: 0.52 }), "medium");
  assert.equal(effortFor("sonnet", null), "medium");
});

test("effort: fable keeps the documented default high", () => {
  assert.equal(effortFor("fable", at(0.6, 0.5)), "high");
});

test("effort ratchet: within one tier an ongoing session never drops effort", () => {
  assert.equal(settleEffort({ target: "low", previous: "high", fresh: false, tierChanged: false }), "high");
  assert.equal(settleEffort({ target: "high", previous: "low", fresh: false, tierChanged: false }), "high");
});

test("effort ratchet: a fresh session or a tier change takes the new level either way", () => {
  assert.equal(settleEffort({ target: "low", previous: "high", fresh: true, tierChanged: false }), "low");
  assert.equal(settleEffort({ target: "medium", previous: "high", fresh: false, tierChanged: true }), "medium");
});

test("effort ratchet: no previous level takes the target; no target stays null", () => {
  assert.equal(settleEffort({ target: "medium", previous: null, fresh: false, tierChanged: false }), "medium");
  assert.equal(settleEffort({ target: null, previous: "high", fresh: false, tierChanged: true }), null);
});


// Found on the live launcher: "Design a multi-tenant billing system ... Top 3 components, one line
// each." scored mean 0.457 / judgment 0.199 and went to Haiku, while the same design without the
// brevity clause scored 0.598 and went to Opus. LAYA reads "one line each", a constraint on the
// ANSWER, as an easy task. Wrongly choosing Haiku is the costly mistake, so design-shaped work is
// never sent there. It only moves work up, from Haiku to Sonnet.
test("design work: architecture and migration wording is recognised, plain edits are not", () => {
  for (const p of [
    "Design a multi-tenant billing system with metering. Top 3 components, one line each.",
    "Propose an architecture for real-time collaborative editing. Keep it to 5 bullets.",
    "Plan the migration from Webpack to Vite.",
    "Build a billing system from scratch.",
    "What are the trade-offs between Postgres and DynamoDB here?",
  ]) assert.equal(isDesignWork(p), true, p);
  for (const p of [
    "Rename getUsr to getUser in src/users.ts.",
    "What is the default port for PostgreSQL?",
    "Bump the lodash version in package.json.",
    "Fix the typo in the README.",
    "",
    null,
  ]) assert.equal(isDesignWork(p), false, String(p));
});

test("design work: a cheap-looking score is not allowed to reach haiku", () => {
  const laya = { metrics: { taskComplexity: 0.457, reasoningRequired: 0.457, toolComplexity: 0.457, judgment: 0.199 }, confidence: 0.3 };
  const base = { laya, current: "opus", available: ALL, fresh: true };
  assert.equal(decide({ ...base, prompt: "Rename getUsr to getUser." }).tier, "haiku");
  assert.equal(decide({ ...base, prompt: "Design a billing system. Top 3 components, one line each." }).tier, "sonnet");
});

test("design work: it never moves work down, and an explicit override still wins", () => {
  const hard = { metrics: { taskComplexity: 0.6, reasoningRequired: 0.6, toolComplexity: 0.6, judgment: 0.3 }, confidence: 0.3 };
  assert.equal(decide({ prompt: "Design a billing system.", laya: hard, current: "opus", available: ALL, fresh: true }).tier, "opus");
  const cheap = { metrics: { taskComplexity: 0.457, reasoningRequired: 0.457, toolComplexity: 0.457, judgment: 0.199 }, confidence: 0.3 };
  assert.equal(decide({ prompt: "use haiku: design a billing system", laya: cheap, current: "opus", available: ALL, fresh: true }).tier, "haiku");
});
