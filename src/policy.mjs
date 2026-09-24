import { SCORE_TIER, TIER_NAMES, THRESHOLDS, OVERRIDE_PATTERNS, rankOf } from "./config.mjs";

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
export function tierFromScores(metrics = {}) {
  const parts = [metrics.taskComplexity, metrics.reasoningRequired, metrics.toolComplexity]
    .filter((v) => Number.isFinite(v));
  if (!parts.length) return null;
  const mean = parts.reduce((a, b) => a + b, 0) / parts.length;
  if (mean >= SCORE_TIER.strongFloor) return "opus";
  if (mean < SCORE_TIER.weakFloor) return "haiku";
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
 * @returns {{tier: string, reason: string, changed: boolean}}
 */
export function decide({ prompt, laya, current, available, contextTokens = 0 }) {
  const settle = (tier, reason) => {
    const final = clampToAvailable(tier, available) ?? current;
    const why = final === tier ? reason : `${reason}+unavailable`;
    return { tier: final, reason: final === current ? `${why}/no-change` : why, changed: final !== current };
  };

  const override = detectOverride(prompt);
  if (override) return settle(override, "override");

  if (!laya) return settle(current, "laya-unavailable");

  const target = tierFromScores(laya.metrics);
  if (!target) return settle(current, "laya-unavailable");

  if (laya.confidence != null && laya.confidence < THRESHOLDS.minConfidence) {
    if (rankOf(target) < rankOf(current)) return settle(current, "low-confidence-no-downgrade");
    const ceiling = Math.max(rankOf(current), rankOf(THRESHOLDS.uncertainCeiling));
    if (rankOf(target) > ceiling) return settle(TIER_NAMES[ceiling], "low-confidence-capped");
  }

  if (rankOf(target) < rankOf(current) && contextTokens > THRESHOLDS.downgradeMaxContextTokens) {
    return settle(current, "downgrade-not-worth-cache-rebuild");
  }

  return settle(target, "laya");
}
