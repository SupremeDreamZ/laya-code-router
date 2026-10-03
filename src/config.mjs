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
  { name: "sonnet", id: "claude-sonnet-5-5", family: "sonnet", thinking: true, effort: true },
  { name: "opus", id: "claude-opus-5-5", family: "opus", thinking: true, effort: true },
  { name: "fable", id: "claude-fable-5-1", family: "fable", thinking: true, effort: true },
];

/**
 * Claude families the binary ships that are NOT a tier substring: `mythos` is the same
 * underlying model as Fable 5.1 (the label exists only because Mythos ships without the
 * dual-use safety measures, to approved orgs), so it belongs at the top tier. Without it
 * tierOf() returns null and the model is dropped from routing entirely.
 */
const ALIASED_FAMILIES = [["mythos", "fable"]];

export const TIER_NAMES = TIERS.map((t) => t.name);

const FAMILIES = [...TIERS.map((t) => [t.family, t.name]), ...ALIASED_FAMILIES];

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
  typeof model === "string"
    ? (FAMILIES.find(([family]) => model.includes(family)) ?? [null, null])[1]
    : null;

/**
 * Routing is local and costs nothing, so it is ON by default: there is no API key to check
 * and no hosted call to fail. Set LAYA_DISABLE_ROUTING=1 (or LAYA_NO_ROUTING=1) to launch the
 * CLI untouched — useful when the local Laya package or weights are not installed yet.
 * Routing itself still fails open per turn: a sidecar error keeps the current model.
 */
export const routingEnabled = () =>
  process.env.LAYA_DISABLE_ROUTING !== "1" && process.env.LAYA_NO_ROUTING !== "1";

/**
 * Fable can bill differently from the other models depending on the plan, so it is opt-in.
 * Everything else is covered by a normal subscription.
 *
 * Who decides: when the menu-bar app is running its switches are the user's explicit choice and
 * are the only thing consulted. Without it (plain command-line use) the environment variable
 * decides, as it always has.
 */
export const availableTiers = (appTiers) =>
  TIER_NAMES.filter(
    (n) => n !== "fable" || (appTiers ? appTiers.fable === true : process.env.LAYA_ALLOW_FABLE === "1"),
  );

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
   * Step routing (off unless prefs.stepRouting, LAYA_STEP_ROUTING=1, or the launcher's
   * x-laya-step-routing header): at a tool-loop continuation LAYA is asked again, about what the
   * assistant is doing next. `stepEvery`: at most once per this many continuations of one
   * conversation, and never on two requests in a row. Each check costs a sidecar call (200-500 ms
   * measured) on the request it is made for, so it is not done on every tool call.
   */
  stepEvery: 4,
  /**
   * How many more steps a switch is assumed to serve when its saving is weighed against the cache
   * rebuild it causes. A guess, not a measurement: a step event records both figures, so it can be
   * checked against what the following steps actually cost.
   */
  stepHorizon: 6,
  /**
   * A step never moves down past this much context, whatever the arithmetic says: the rebuild is
   * paid up front and the saving only if the loop runs on, and a long loop is the likeliest to be
   * hard work that needs the stronger model. Twice the turn-level `downgradeMaxContextTokens`,
   * because a step downgrade is checked against its cost and a turn downgrade is not.
   */
  stepMaxContextTokens: 40000,
  /** The longest a step waits for LAYA. Past it the step stays where it is; the turn is not held. */
  stepDeadlineMs: 3000,
  /** Longest step prompt sent to LAYA. The rubric reads intent, and intent is in the first lines. */
  stepPromptChars: 1500,
  /**
   * LAYA sidecar thresholds. The sidecar loads its model as soon as it starts (6 to 10 s measured on
   * an M2 Max with the weights already on disk; a slower machine takes longer), so a prompt rarely
   * waits for a load, and one that does waits behind it.
   *
   * `ackMs` is the fast-fail window for a missing id echo: the sidecar answers that at once, from a
   * thread that is never loading, so five seconds without it means a dead process.
   *
   * `layaDeadlineMs` is the longest a prompt waits for a decision from a model that is up. Measured
   * on 2026-10-01 with every core busy, one decision took 31.7 s on the real daemon and another
   * 95.6 s, and nothing stopped either: this constant was defined and never read. Past it the turn
   * goes on with the model it already has, which is what "routing must never block a prompt" has to
   * mean.
   *
   * `loadDeadlineMs` is the same wait while the model has not answered anything yet, so it is still
   * loading. It is longer because a load is not a stall: the first decision of a command-line run
   * (`laya-claude -p`) is made the moment the process starts, and on a slow machine it waits for the
   * whole load. The 60 s is the figure this was designed around before the load moved to start-up.
   */
  ackMs: 5000,
  layaDeadlineMs: 15000,
  loadDeadlineMs: 60000,
  /**
   * When a silent model is replaced. The bridge does one request at a time, so a model that is stuck on
   * one holds every later prompt behind it, and without a replacement the deadline only moves the damage:
   * each prompt for the rest of the daemon's life waits the full deadline and then goes without a decision.
   *
   * It is replaced when it has sent nothing for this many deadlines (or echo windows) while a request
   * sat with it. Anything it sends counts, an answer to a request already given up on included, so a
   * model that is slow but working is never mistaken for one that is stuck. The clock starts at the
   * oldest request it is holding, so prompts that pile up behind a stuck one do not restart it.
   */
  wedgedAfterDeadlines: 3,
  /** A model that is still not loaded this long after it started is replaced at the next missed deadline. */
  loadGiveUpMs: 5 * 60_000,
};

export const CONTEXT_WINDOW_TOKENS = 200000;

/** First line of every step prompt, so LAYA scores the rest as a step of work already under way. */
export const STEP_FRAMING = "Next step of an ongoing task:";

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
 * Calibrated 2026-09-30 on dirien/jev-router's 58 labeled prompts (13 mechanical, 14 routine,
 * 31 complex/deep), scored under the conditions production has on a claude.ai login: the
 * proxy's own model list, opus as the current model, ~5,600 tokens of Claude Code context
 * (scores move by up to 0.12 with those inputs, so a fit under other conditions is wrong).
 * The scores rank well (AUC 0.91 frontier vs the rest, 0.86 mechanical vs the rest) but sit
 * in a narrow 0.35-0.67 band, so the earlier 0.18/0.62 floors were unreachable: 29% tier
 * accuracy, 48% of prompts under-routed, and the fast tier could not fire at all. Fitted with
 * under-routing costing twice over-routing and checked leave-one-out: 67% accuracy, 7%
 * under-routed, 26% over-routed (always "balanced" is 24% and 53% under-routed). Across the 58
 * leave-one-out fits the cuts moved by 0.02 (lower) and 0.00 (upper). 58 prompts is small and
 * the labels are one project's opinion: treat these as a starting point and re-fit on prompts
 * from real sessions.
 *
 *   score >= strongFloor     -> strong tier (hard reasoning / high blast radius)
 *   score <  weakFloor       -> fast tier (mechanical, already-specified work)
 *   anything between         -> balanced tier (ordinary day-to-day engineering)
 */
export const SCORE_TIER = {
  strongFloor: 0.515,
  /**
   * The conservative Haiku floor, used when LAYA gave no judgment answer: the blended score
   * alone catches only 18% of Haiku-shaped work at this cut, but sends none of the rest down.
   */
  weakFloor: 0.396,
  /**
   * The Haiku cut once the judgment question is available: Haiku is a cheap first attempt whose
   * output a person reviews, and the ratchet lets a harder later message move the session up.
   * Measured on 116 labeled prompts (dirien's 58, 18 written from Anthropic's model guidance,
   * 40 fresh ones never used to fit anything): 59% of Haiku-shaped work reaches Haiku, 30% of
   * Sonnet-shaped work is tried on Haiku first, and 0 of 37 Opus-shaped prompts are.
   */
  haikuCut: 0.48,
  /**
   * `judgment` is LAYA's answer to "would doing this correctly require investigating an
   * unknown cause, weighing design options, or changing several files?" (0..1). At or above
   * this the work is never sent to Haiku, which is what keeps unknown-cause debugging and
   * design work that scores low on the blend (e.g. 0.448 for a scheduler race condition, with
   * judgment 0.85) off the cheap tier.
   */
  judgmentVeto: 0.45,
};

/**
 * What the app's preset does: a fixed shift of the three cuts. "Save most" (savings) raises the
 * Opus floor and both Haiku cuts, so the same scores land cheaper; "Careful" lowers them; Balanced
 * is the calibrated numbers above, exactly.
 *
 * Not a fit. The sizes come from the calibration notes: the leave-one-out fits moved the lower cut
 * by 0.02, so a 0.02 shift of the Haiku cuts is one unit of the calibration's own uncertainty. The
 * Opus floor moves 0.025, which keeps savings' floor (0.54) below the score that earns Opus high
 * effort (EFFORT.opusHighMean, 0.55): work scored hard enough for that still reaches Opus under
 * every preset. On the 58-prompt fixture
 * (calibration.test.mjs) that sends 24 / 31 / 39 prompts to Opus, under-routes 11 / 4 / 2, and sends
 * no hard prompt to Haiku under any preset. `judgmentVeto` never moves: it is what keeps
 * unknown-cause debugging and design work off Haiku, and no preset should trade that away.
 */
export const PRESET_OFFSETS = {
  savings: { strongFloor: 0.025, haikuCut: 0.02, weakFloor: 0.02 },
  balanced: { strongFloor: 0, haikuCut: 0, weakFloor: 0 },
  careful: { strongFloor: -0.025, haikuCut: -0.02, weakFloor: -0.02 },
};

/** SCORE_TIER for a preset. Anything that is not a known preset is Balanced. */
export function scoreTierFor(preset) {
  const offsets = PRESET_OFFSETS[preset];
  if (!offsets || preset === "balanced") return SCORE_TIER;
  const shifted = { ...SCORE_TIER };
  // Rounded so 0.515 + 0.025 is 0.54, not 0.5400000000000001.
  for (const [key, by] of Object.entries(offsets)) shifted[key] = Math.round((SCORE_TIER[key] + by) * 1000) / 1000;
  return shifted;
}

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

/**
 * Effort the router picks per turn. Anthropic (platform.claude.com/docs/en/build-with-claude/effort):
 * lower effort is faster and cheaper for straightforward work; for agentic coding on Sonnet 5.5,
 * "start with medium for well-specified tasks and move to high for harder or longer ones"; Opus
 * 5.5's own default is medium. Haiku takes no effort parameter.
 *
 * Both signals come from LAYA: `judgment` (would this need investigating, design, or several
 * files) and the blended mean. Measured on the 116 labeled prompts, Sonnet-routed turns split
 * 13 low / 18 medium / 4 high and Opus-routed turns 21 medium / 25 high. The cuts are a
 * starting point, not a fit: nothing here has been checked against answer quality.
 */
export const EFFORT = {
  /** Sonnet: a stated task (judgment below this) needs little thinking. */
  sonnetLowJudgment: 0.25,
  /** Sonnet: work that needs investigating or design (judgment at or above this) gets high. */
  sonnetHighJudgment: 0.6,
  /** Opus: a blended score at or above this is hard work and gets high. */
  opusHighMean: 0.55,
  /** Opus: open-ended work (judgment at or above this) gets high whatever the blend says. */
  opusHighJudgment: 0.65,
  /**
   * The launcher's session settings make Claude Code send this level, which is the documented
   * default for the Claude 5.5 models. It is the marker for "the user did not choose", so the
   * router replaces it and leaves any other value, which the user chose, alone.
   */
  launcherDefault: "medium",
};

/**
 * Wording that marks design-shaped work. LAYA reads a brevity constraint on the ANSWER ("top 3
 * components, one line each") as an easy TASK: a live run scored a multi-tenant billing design at
 * mean 0.457 and sent it to Haiku, while the same request without the clause scored 0.598 and went
 * to Opus. Wrongly choosing Haiku is the costly mistake, so these never reach it. On the 116
 * labeled prompts it matches 22: 20 Opus-shaped, 2 Sonnet-shaped, 0 Haiku-shaped. The list is
 * hand-written, so it is a stopgap for a scoring blind spot, not a measurement.
 */
export const DESIGN_WORK =
  /\b(design|architect(?:ure)?|re-?architect|system design|trade-?offs?|migrat(?:e|ion)|from scratch|end[- ]to[- ]end|across (?:all|the|our|services|modules))\b/i;

