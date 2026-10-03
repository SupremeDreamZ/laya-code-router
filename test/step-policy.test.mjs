import test from "node:test";
import assert from "node:assert/strict";
import { decideStep, stepCost } from "../src/policy.mjs";
import { THRESHOLDS } from "../src/config.mjs";
import { mergePrefs, defaultPrefs } from "../src/prefs.mjs";

// Step routing re-asks LAYA in the middle of a tool loop. A switch there throws away the prompt
// cache for the model being left, so a move down has to pay for the rebuild out of what it saves,
// while a move up is about quality and only needs LAYA to be sure.
const ALL = ["haiku", "sonnet", "opus"];
const at = (score, confidence = 0.5) => ({
  metrics: { taskComplexity: score, reasoningRequired: score, toolComplexity: score, judgment: 0.1 },
  confidence,
});
const base = { prompt: "Next step of an ongoing task:\nBash: ls", available: ALL, contextTokens: 8000, step: { input: 2000, output: 1000 } };

test("step config: the documented defaults", () => {
  assert.equal(THRESHOLDS.stepEvery, 4);
  assert.equal(THRESHOLDS.stepHorizon, 6);
  assert.equal(THRESHOLDS.stepMaxContextTokens, 40000);
  assert.ok(THRESHOLDS.stepPromptChars <= 1500);
});

test("step routing is off unless asked for, and the setting only takes a boolean", () => {
  assert.equal(defaultPrefs().stepRouting, false);
  assert.equal(mergePrefs(defaultPrefs(), { stepRouting: true }).stepRouting, true);
  assert.equal(mergePrefs(defaultPrefs(), { stepRouting: "yes" }).stepRouting, false);
});

test("stepCost: rebuild is the context at the target's uncached-minus-cached input rate", () => {
  // opus -> haiku. Haiku: input $1, cache read $0.10 per MTok. Opus: input $4, output $20; Haiku output $5.
  const c = stepCost({ current: "opus", target: "haiku", contextTokens: 10000, step: { input: 2000, output: 1000 }, horizon: 6 });
  assert.ok(Math.abs(c.rebuild - (10000 * (1 - 0.1)) / 1e6) < 1e-12);
  assert.ok(Math.abs(c.saving - (6 * (2000 * (4 - 1) + 1000 * (20 - 5))) / 1e6) < 1e-12);
});

test("a confident upgrade switches whatever it costs", () => {
  const d = decideStep({ ...base, laya: at(0.6), current: "haiku", contextTokens: 150000 });
  assert.equal(d.tier, "opus");
  assert.equal(d.switched, true);
  assert.equal(d.reason, "step-upgrade");
  assert.ok(d.rebuild > d.saving || d.saving < 0, "it was not a saving, and it switched anyway");
});

test("a confident downgrade that pays for its rebuild switches", () => {
  const d = decideStep({ ...base, laya: at(0.37), current: "opus" });
  assert.equal(d.tier, "haiku");
  assert.equal(d.switched, true);
  assert.equal(d.reason, "step-downgrade");
  assert.ok(d.saving > d.rebuild);
});

test("a downgrade that would not pay for its rebuild stays", () => {
  const d = decideStep({ ...base, laya: at(0.37), current: "opus", contextTokens: 39000, step: { input: 100, output: 50 } });
  assert.equal(d.tier, "opus");
  assert.equal(d.switched, false);
  assert.equal(d.reason, "step-not-worth-cache-rebuild");
  assert.ok(d.saving <= d.rebuild);
});

test("a downgrade past the context cap stays, even when the arithmetic says it pays", () => {
  const d = decideStep({ ...base, laya: at(0.37), current: "opus", contextTokens: 41000, step: { input: 50000, output: 50000 } });
  assert.equal(d.switched, false);
  assert.equal(d.reason, "step-context-too-large");
});

test("an uncertain answer never moves a step, up or down", () => {
  assert.equal(decideStep({ ...base, laya: at(0.6, 0.1), current: "haiku" }).switched, false);
  assert.equal(decideStep({ ...base, laya: at(0.37, 0.1), current: "opus" }).reason, "step-low-confidence");
  assert.equal(decideStep({ ...base, laya: { ...at(0.37), confidence: null }, current: "opus" }).switched, false);
});

test("no answer, or no usable scores, keeps the step where it is", () => {
  assert.deepEqual(
    [decideStep({ ...base, laya: null, current: "sonnet" }), decideStep({ ...base, laya: { metrics: {}, confidence: 0.9 }, current: "sonnet" })].map((d) => [d.tier, d.switched, d.reason]),
    [["sonnet", false, "step-laya-unavailable"], ["sonnet", false, "step-laya-unavailable"]],
  );
});

test("the same tier is a recorded stay, with nothing to rebuild", () => {
  const d = decideStep({ ...base, laya: at(0.5), current: "sonnet" });
  assert.equal(d.switched, false);
  assert.equal(d.reason, "step-same-tier");
  assert.equal(d.rebuild, 0);
  assert.equal(d.saving, 0);
});

test("a switch the wire cannot carry is refused, and the reason is recorded", () => {
  const d = decideStep({ ...base, laya: at(0.37), current: "opus", hazard: (tier) => (tier === "haiku" ? "thinking-only-message" : null) });
  assert.equal(d.switched, false);
  assert.equal(d.tier, "opus");
  assert.equal(d.reason, "step-refused-thinking-only-message");
});

test("a step never lands on a tier that is switched off", () => {
  const d = decideStep({ ...base, available: ["sonnet", "opus"], laya: at(0.37), current: "opus" });
  assert.equal(d.tier, "sonnet");
});
