// Every routing decision knob lives here, so the whole policy is reviewable in one file.

/**
 * Model tiers, cheapest first. `id` is what goes into the API request body; `family` is the
 * substring used to recognise whatever model Claude Code asked for, which may be an older
 * version within the same tier such as `claude-sonnet-4-6`. The capability flags come from
 * the Agent SDK's model catalogue: Haiku supports neither adaptive thinking nor effort, so
 * those fields have to be stripped when routing down to it.
 */
export const TIERS = [
  { name: "haiku", id: "claude-haiku-4-5-20251001", family: "haiku", thinking: false, effort: false },
  { name: "sonnet", id: "claude-sonnet-5", family: "sonnet", thinking: true, effort: true },
  { name: "opus", id: "claude-opus-5", family: "opus", thinking: true, effort: true },
  { name: "fable", id: "claude-fable-5-1", family: "fable", thinking: true, effort: true },
];

export const TIER_NAMES = TIERS.map((t) => t.name);

export const rankOf = (name) => TIER_NAMES.indexOf(name);

export const idOf = (name) => TIERS.find((t) => t.name === name)?.id;

export const tierSpec = (name) => TIERS.find((t) => t.name === name);

/**
 * Sentinel model id offered as an extra row in Claude Code's /model picker. Claude Code
 * sends it verbatim because it does not validate model names behind a custom base URL, so
 * its presence in a request is an exact signal that the user wants this turn routed. Any
 * other model means the user picked one themselves and it must be passed straight through.
 */
export const AUTO_MODEL = "laya-router";

/** Whether a request should be routed, or passed through as the user's own choice. */
export const isAuto = (model) => model === AUTO_MODEL;

/** Tier name for a model string Claude Code sent, or null if we don't recognise it. */
export const tierOf = (model) =>
  TIERS.find((t) => typeof model === "string" && model.includes(t.family))?.name ?? null;

/**
 * Routing is local and costs nothing, so it is ON by default: there is no API key to check
 * and no hosted call to fail. Set LAYA_DISABLE_ROUTING=1 (or LAYA_NO_ROUTING=1) to launch the
 * CLI untouched — useful when the local Laya package or weights are not installed yet.
 * Routing itself still fails open per turn: a sidecar error keeps the current model.
 */
export const routingEnabled = () =>
  process.env.LAYA_DISABLE_ROUTING !== "1" && process.env.LAYA_NO_ROUTING !== "1";

/**
 * Fable bills extra usage credits, so it is opt-in. Everything else is covered by a normal
 * subscription.
 */
export const availableTiers = () =>
  TIER_NAMES.filter((n) => n !== "fable" || process.env.LAYA_ALLOW_FABLE === "1");

export const THRESHOLDS = {
  /**
   * Below this confidence we refuse to downgrade and cap upgrades at `uncertainCeiling`.
   * Calibrated live 2026-09-23 against the default checkpoint's score head: the mean
   * score-question confidence lands at 0.16-0.44 across trivial/ordinary/hard prompts
   * (0.44+ only on genuinely hard work), so the hosted-Jev 0.3 default would cap nearly
   * every upgrade. 0.15 keeps the guard for pathological answers without neutering
   * ordinary routing.
   */
  minConfidence: 0.15,
  /** Safest tier to land on when Laya is unsure. */
  uncertainCeiling: "sonnet",
  /**
   * Switching models invalidates the prompt cache; the next turn re-sends the whole
   * conversation. Measured at ~23.6k cache-creation tokens switching into Opus, so a
   * downgrade only pays off while the conversation is still small.
   */
  downgradeMaxContextTokens: 20000,
  /**
   * LAYA sidecar thresholds. The sidecar answers in ~35-50ms warm on MPS but pays a ~40s
   * model load on its first request in a fresh process, so the first ask of a session runs
   * under the deadline while the load finishes. `ackMs` is the fast-fail window for a
   * missing id echo (the sidecar crashed on the request line); the deadline covers the
   * whole decision including a cold model load.
   */
  ackMs: 5000,
  layaDeadlineMs: 60000,
};

export const CONTEXT_WINDOW_TOKENS = 200000;

/**
 * The three-level rubric the LAYA sidecar scores per fresh user turn. Kept here so the
 * whole policy is reviewable in one file and the sidecar's questions stay in sync with
 * the JS thresholds below.
 */
export const SCORE_QUESTIONS = {
  task_complexity: {
    instructions:
      "How complex is the coding task overall, including ambiguity, scope, and blast radius?",
    criteria: [
      "trivial: mechanical or purely factual work",
      "ordinary: bounded day-to-day engineering",
      "hard: hard reasoning, ambiguity, or high blast radius",
    ],
  },
  reasoning_required: {
    instructions:
      "How much reasoning is required to complete the request correctly in one pass?",
    criteria: [
      "none: run one obvious command",
      "some: implement a specified function or fix an understood local bug",
      "extensive: unknown-cause debugging, cross-module design, or migrations",
    ],
  },
  tool_complexity: {
    instructions:
      "How complex is the tool use required, from no tools to many coordinated or stateful operations?",
    criteria: [
      "none: no tools",
      "some: one or two tool calls",
      "many: coordinated or stateful multi-step tool use",
    ],
  },
};

/**
 * Maps the sidecar's expected rubric score (0..2, already normalised to 0..1 by the
 * bridge as metrics.*) onto a tier. Deterministic by design: LAYA's choice head is
 * UNCALIBRATED for wide option sets (verified 2026-09-22: 7-option confidence 0.02-0.03,
 * near-flat distribution), so the N-way pick is never part of the routing path — the
 * score rubric is the primary signal and this table carries the decision.
 *
 * Calibrated live 2026-09-23 (default checkpoint, mean of the three rubric scores):
 * trivial/ordinary prompts land in an indistinguishable 0.44-0.51 band — differences
 * there are noise — while genuinely hard work separates upward (0.62+; auth redesign,
 * whole-repo migration). `laya-typed-decisions` was measured worse (classes fully
 * overlap, 0.54-0.67) and is not the default. The honest policy:
 *
 *   score >= strongFloor     -> strong tier (hard reasoning / high blast radius)
 *   score <  weakFloor       -> fast tier (below-rubric noise band; near-dormant with
 *                               the current checkpoint, kept for a calibrated one)
 *   anything between         -> balanced tier (ordinary day-to-day engineering)
 *
 * The saving comes from the no-router baseline, which pins the session tier at opus:
 * ordinary work drops to the balanced tier instead of riding Opus all session.
 */
export const SCORE_TIER = {
  strongFloor: 0.62,
  weakFloor: 0.18,
};

/** Phrases that mean "the human already decided", checked against the raw prompt. */
export const OVERRIDE_PATTERNS = TIERS.map((t) => ({
  tier: t.name,
  re: new RegExp(
    `\\b(?:use|switch to|with|on)\\s+(?:${{
      haiku: "haiku|fast|luna",
      sonnet: "sonnet|balanced|terra",
      opus: "opus|strong|sol",
      fable: "fable|long|astra",
    }[t.name]})\\b`,
    "i",
  ),
}));

/**
 * The N-way pick over the account's exact models, sent to the sidecar for the
 * explanation UI. Emitted as `model_tier` in the response; the policy layer ignores it
 * for routing (uncalibrated on wide sets).
 */
export const MODEL_CHOICE_QUESTION = {
  instructions: [
    "Pick the cheapest exact model that can fully complete this coding request in one pass, without retrying on a stronger model.",
    "Treat different model versions as separate choices. Judge required reasoning, not requested reply length.",
  ],
};

/**
 * Builds the model question sent to the sidecar from the exact models available to this
 * account and CLI, so model versions such as `claude-opus-4-8` and `claude-opus-5`
 * remain separate choices.
 */
export const questionForModels = (models) => ({
  type: "choice",
  instructions: MODEL_CHOICE_QUESTION.instructions.join(" "),
  criteria: Object.fromEntries(
    models.map(({ id, description }) => [id, description ?? id]),
  ),
});

/** Whether policy accepted the exact model, including a version change within one tier. */
export const shouldUseExactModel = (reason, chosenTier, finalTier) =>
  (reason === "laya" || reason === "laya/no-change") && chosenTier === finalTier;
