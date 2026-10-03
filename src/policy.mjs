import { EFFORT, DESIGN_WORK, TIER_NAMES, THRESHOLDS, OVERRIDE_PATTERNS, rankOf, scoreTierFor } from "./config.mjs";
import { pricesFor } from "./pricing.mjs";

/** Design-shaped wording (architecture, migration, from scratch); see DESIGN_WORK. */
export function isDesignWork(prompt) {
  return DESIGN_WORK.test(prompt ?? "");
}

/** The tier the user named explicitly in the prompt, or null. */
export function detectOverride(prompt) {
  const hit = OVERRIDE_PATTERNS.find((p) => p.re.test(prompt ?? ""));
  return hit ? hit.tier : null;
}

/**
 * Nearest tier the account can actually run. Prefers stepping up rather than down so we
 * never silently hand a hard task to a weaker model, but never steps up into `fable`
 * (which bills extra usage credits) unless that is what was asked for.
 */
function clampToAvailable(tier, available) {
  if (available.includes(tier)) return tier;
  const rank = rankOf(tier);
  const up = TIER_NAMES.filter(
    (t, i) => i > rank && available.includes(t) && (t !== "fable" || tier === "fable"),
  );
  if (up.length) return up[0];
  const down = TIER_NAMES.filter((t, i) => i < rank && available.includes(t));
  return down.length ? down[down.length - 1] : null;
}

/**
 * Maps the sidecar's rubric scores (metrics.*, already normalised to 0..1) onto a tier.
 * Deterministic by design: LAYA's choice head is UNCALIBRATED for wide option sets
 * (verified 2026-09-22: 7-option confidence 0.02-0.03, near-flat distribution — 0.002
 * gaps are noise), so the N-way model pick is never part of the routing path. The
 * three-level score rubric is the primary signal and this table carries the decision:
 *
 *   mean score >= strongFloor  -> strong (hard reasoning / high blast radius)
 *   mean score <  weakFloor    -> fast   (below-rubric noise band keeps the cheap tier)
 *   anything between           -> balanced (ordinary day-to-day engineering)
 */
export function tierFromScores(metrics = {}, preset = "balanced") {
  const parts = [metrics?.taskComplexity, metrics?.reasoningRequired, metrics?.toolComplexity]
    .filter((v) => Number.isFinite(v));
  if (!parts.length) return null;
  // The app's preset shifts the cuts (config.PRESET_OFFSETS); Balanced is SCORE_TIER itself.
  const cuts = scoreTierFor(preset);
  const mean = parts.reduce((a, b) => a + b, 0) / parts.length;
  if (mean >= cuts.strongFloor) return "opus";
  // Haiku: the looser cut applies only when LAYA also says the work needs no investigation or
  // design. Without that answer, only the conservative floor is safe.
  const judgment = Number.isFinite(metrics.judgment) ? metrics.judgment : null;
  if (judgment !== null && mean < cuts.haikuCut && judgment < cuts.judgmentVeto) return "haiku";
  if (mean < cuts.weakFloor) return "haiku";
  return "sonnet";
}

/**
 * Turns a Laya answer into the model we will actually run. Pure and total: any missing,
 * malformed, or unavailable input falls back to the model already in use.
 *
 * `laya.confidence` is the mean of the three score-question confidences (computed by the
 * bridge); the N-way `choice` is carried for the explanation UI only and never drives
 * routing.
 *
 * @param {object} input
 * @param {string} input.prompt        raw user prompt, for explicit-override detection
 * @param {?object} input.laya  null when Laya failed
 * @param {string} input.current       tier currently active in the session
 * @param {string[]} input.available   tier names the account can run
 * @param {number} input.contextTokens approximate size of the conversation so far
 * @param {string} [input.preset]      the app's preset, which shifts the score cuts
 * @param {boolean} [input.paceCap]    the plan's 5-hour window is near its limit (limits.paceCapActive)
 * @returns {{tier: string, reason: string, changed: boolean}}
 */
export function decide({ prompt, laya, current, available, contextTokens = 0, fresh = false, preset = "balanced", paceCap = false }) {
  const settle = (tier, reason) => {
    const final = clampToAvailable(tier, available) ?? current;
    const why = final === tier ? reason : `${reason}+unavailable`;
    return { tier: final, reason: final === current ? `${why}/no-change` : why, changed: final !== current };
  };

  const override = detectOverride(prompt);
  if (override) return settle(override, "override");

  const decided = decideFromLaya({ prompt, laya, current, available, contextTokens, fresh, preset, settle });
  // Plan-aware pacing: near the 5-hour limit a NEW landing on Opus gets Sonnet. A conversation
  // already on Opus (not fresh) stays: pacing only shapes new decisions, it never moves one down.
  if (paceCap && decided.tier === "opus" && (fresh || current !== "opus") && available.includes("sonnet")) {
    return settle("sonnet", "plan-pace-cap");
  }
  return decided;
}

/** `decide` once no override applies: what LAYA's answer is worth, under the ratchet. */
function decideFromLaya({ prompt, laya, current, available, contextTokens, fresh, preset, settle }) {
  if (!laya) return settle(current, "laya-unavailable");

  let target = tierFromScores(laya.metrics, preset);
  if (!target) return settle(current, "laya-unavailable");
  // Design-shaped work is never the cheap tier, whatever LAYA scored; it only moves work up.
  if (target === "haiku" && isDesignWork(prompt)) target = "sonnet";

  if (laya.confidence != null && laya.confidence < THRESHOLDS.minConfidence) {
    // An ongoing session never downgrades on an uncertain rubric. A fresh one has no decision
    // to protect: its `current` is only the proxy's placeholder ("opus" before any tier is
    // set), so measuring against it would pin every uncertain new session to the top tier.
    // Measure a fresh session against the uncertain ceiling instead.
    const baseline = fresh ? THRESHOLDS.uncertainCeiling : current;
    if (rankOf(target) < rankOf(baseline)) return settle(baseline, "low-confidence-no-downgrade");
    const ceiling = Math.max(rankOf(baseline), rankOf(THRESHOLDS.uncertainCeiling));
    if (rankOf(target) > ceiling) return settle(TIER_NAMES[ceiling], "low-confidence-capped");
  }

  // Ratchet (dirien/jev-router): in an ongoing session the tier only goes up. Anthropic's
  // prompt cache belongs to one model, so a downgrade makes the next request start cold, and
  // an agent's requests are mostly cache reads. A new, idle or compacted session has no
  // ongoing decision to protect, so `fresh` lets it move either way.
  if (!fresh && rankOf(target) < rankOf(current)) return settle(current, "ratchet-no-downgrade");

  if (rankOf(target) < rankOf(current) && contextTokens > THRESHOLDS.downgradeMaxContextTokens) {
    return settle(current, "downgrade-not-worth-cache-rebuild");
  }

  return settle(target, "laya");
}

/**
 * What a step switch from `current` to `target` costs and saves, in list-price dollars.
 *  - rebuild: the switch leaves the prompt cache behind, so the context is read once more at the
 *    target's uncached input rate instead of its cached-read rate.
 *  - saving: the price difference over the next `horizon` steps of the measured average size (new
 *    input and output per step). Context re-reads on later steps are left out, so a downgrade's
 *    saving is understated, never overstated. Negative for an upgrade.
 */
export function stepCost({ current, target, contextTokens, step, horizon = THRESHOLDS.stepHorizon }) {
  const from = pricesFor(null, current);
  const to = pricesFor(null, target);
  if (!from || !to) return { rebuild: 0, saving: 0 };
  const [fromIn, , , , fromOut] = from;
  const [toIn, , , toRead, toOut] = to;
  return {
    rebuild: (contextTokens * (toIn - toRead)) / 1e6,
    saving: (horizon * ((step?.input ?? 0) * (fromIn - toIn) + (step?.output ?? 0) * (fromOut - toOut))) / 1e6,
  };
}

/**
 * The step decision: whether a tool-loop continuation moves to another tier. Pure, and total like
 * `decide`: any missing or uncertain input keeps the tier the loop is on.
 *
 * Unlike a turn, a step moves either way, because the work inside one turn changes (reading files,
 * then designing a fix). An upgrade is about quality and only needs a confident answer. A
 * downgrade throws away a warm cache to save money, so it also has to stay under
 * `stepMaxContextTokens` and save more over the next steps than the rebuild costs. `hazard(tier)`
 * names a reason the wire cannot carry the switch (see wire.stepHazard), which refuses it.
 *
 * @returns {{tier: string, switched: boolean, reason: string, target?: string, saving: number, rebuild: number}}
 */
export function decideStep({ prompt, laya, current, available, contextTokens = 0, step, hazard = () => null, preset = "balanced", paceCap = false }) {
  const none = { saving: 0, rebuild: 0 };
  const stay = (reason, extra = none) => ({ tier: current, switched: false, reason, ...extra });
  if (!laya) return stay("step-laya-unavailable");
  let target = tierFromScores(laya.metrics, preset);
  if (!target) return stay("step-laya-unavailable");
  if (target === "haiku" && isDesignWork(prompt)) target = "sonnet";
  target = clampToAvailable(target, available) ?? current;
  if (!(laya.confidence >= THRESHOLDS.minConfidence)) return stay("step-low-confidence", { target, ...none });
  // Pacing, as in `decide`: a step may not newly land on Opus near the 5-hour limit. A loop that
  // is already on Opus is not on this path (its target equals its tier, or is lower).
  const paced = paceCap && target === "opus" && current !== "opus" && available.includes("sonnet");
  if (paced) target = "sonnet";
  if (target === current) return stay(paced ? "plan-pace-cap" : "step-same-tier");
  const cost = { target, ...stepCost({ current, target, contextTokens, step }) };
  const up = rankOf(target) > rankOf(current);
  if (!up) {
    if (contextTokens > THRESHOLDS.stepMaxContextTokens) return stay("step-context-too-large", cost);
    if (!(cost.saving > cost.rebuild)) return stay("step-not-worth-cache-rebuild", cost);
  }
  const why = hazard(target);
  if (why) return stay(`step-refused-${why}`, cost);
  return { tier: target, switched: true, reason: paced ? "plan-pace-cap" : up ? "step-upgrade" : "step-downgrade", ...cost };
}

const EFFORT_ORDER = ["low", "medium", "high"];

/**
 * The effort level for a turn routed to `tier`, or null when the tier takes none (Haiku).
 * Without LAYA's judgment answer it stays at the documented default rather than guessing.
 */
export function effortFor(tier, metrics) {
  if (tier === "haiku") return null;
  const parts = [metrics?.taskComplexity, metrics?.reasoningRequired, metrics?.toolComplexity].filter((v) =>
    Number.isFinite(v),
  );
  const mean = parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : null;
  const judgment = Number.isFinite(metrics?.judgment) ? metrics.judgment : null;
  if (tier === "sonnet") {
    if (judgment === null) return "medium";
    if (judgment >= EFFORT.sonnetHighJudgment) return "high";
    if (judgment < EFFORT.sonnetLowJudgment) return "low";
    return "medium";
  }
  if (tier === "opus") {
    if ((mean !== null && mean >= EFFORT.opusHighMean) || (judgment !== null && judgment >= EFFORT.opusHighJudgment)) return "high";
    return "medium";
  }
  return "high";
}

/**
 * Same ratchet as the tier: inside one tier an ongoing session only moves effort up, because a
 * changed top-level effort restarts the prompt cache (Anthropic, effort docs, "Hold top-level
 * effort constant within cached conversations"). A fresh session or a tier change already
 * starts cold, so it takes the new level either way.
 */
export function settleEffort({ target, previous, fresh, tierChanged }) {
  if (target === null) return null;
  if (fresh || tierChanged || !EFFORT_ORDER.includes(previous)) return target;
  return EFFORT_ORDER.indexOf(target) > EFFORT_ORDER.indexOf(previous) ? target : previous;
}
