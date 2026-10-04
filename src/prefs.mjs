// Everything the menu-bar app lets a person choose, in one validated file. The daemon owns it;
// the UI only ever sends partial changes, and anything invalid is dropped rather than stored, so
// a hand-edited or corrupt file cannot put the router into a state the UI cannot show.
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const HOME_DIR = () => process.env.LAYA_HOME || join(homedir(), ".laya-router");
export const PREFS_FILE = () => join(HOME_DIR(), "prefs.json");

export const PRESET_NAMES = ["savings", "balanced", "careful"];
export const ENGINES = ["claude", "codex"];

export const DEFAULT_PREFS = Object.freeze({
  /** Master switch. Off means every session runs on `pausedTier`, untouched by the router. */
  enabled: true,
  /** How readily the router tries the cheapest model first. */
  preset: "balanced",
  /** Models the router may pick. Fable bills extra credits, so it starts off. */
  tiers: Object.freeze({ haiku: true, sonnet: true, opus: true, fable: false }),
  /** Let the router choose how hard the model thinks, not only which model. */
  effortAuto: true,
  /**
   * Re-ask the router in the middle of a tool loop, not only when you type. Off by default: each
   * check costs a moment on the request it is made for, and a switch rebuilds the prompt cache.
   */
  stepRouting: false,
  /**
   * Re-decide effort inside a tool loop, on the models that can change it without losing the prompt
   * cache. On by default: it costs a LAYA call every few steps and no model switch.
   */
  effortSteps: true,
  /**
   * Once a prompt passes ~120k tokens, have the API replace the oldest tool results (file contents,
   * command output the model already used) with a placeholder, keeping the latest few whole. On by
   * default: long tool loops re-read their whole history on every step, and this is the part of it
   * the model no longer needs. Server-side, so Claude Code's own copy of the conversation is untouched.
   */
  trimToolResults: true,
  /**
   * The tool gate (src/guard.mjs): rules plus one Laya question before Bash and file writes in a
   * routed session. Off by default: it adds a hook to every tool call, and a headless run it blocks
   * has to find another way. Read when a session starts.
   */
  guard: false,
  /**
   * Give routed sessions the laya_rank_files tool (bin/laya-mcp.mjs): rank files by a yes/no
   * question about their content without reading them. Off by default: it ranks, it does not
   * prove, and it takes about 1.5 s a file. Read when a session starts.
   */
  rankFiles: false,
  /** What a session runs on while the router is off. */
  pausedTier: "opus",
  /** What the savings figure compares against. */
  baselineTier: "opus",
  /** Keep the text of each prompt in the live feed (it never leaves this Mac either way). */
  showPrompts: true,
  launch: Object.freeze({ engine: "claude", terminal: "terminal", resume: false, dir: null }),
  /**
   * Usage alerts, driven by the plan limits Anthropic reports on every response. On by default:
   * being told at 75% and 90% costs nothing, and finding out at 100% in the middle of a task does.
   * Pace warnings are off because they guess; they are a prediction, not a measurement.
   */
  alerts: Object.freeze({
    enabled: true,
    thresholds: Object.freeze([75, 90]),
    limit: true,
    reset: true,
    pace: false,
    windows: Object.freeze({ fiveHour: true, weekly: true }),
  }),
  /** Show the 5-hour figure beside the menu-bar icon. Off: the icon stays just an icon. */
  showUsageInMenuBar: false,
});

const isBool = (v) => typeof v === "boolean";
const oneOf = (list) => (v) => list.includes(v);

/**
 * Field validators. Each returns the cleaned value, or `undefined` to reject it.
 * A nested object validates field by field, so one bad key never discards its siblings.
 */
const SCHEMA = {
  enabled: (v) => (isBool(v) ? v : undefined),
  preset: (v) => (oneOf(PRESET_NAMES)(v) ? v : undefined),
  tiers: (v, current) => {
    if (!v || typeof v !== "object") return undefined;
    const next = { ...current };
    for (const name of Object.keys(DEFAULT_PREFS.tiers)) if (isBool(v[name])) next[name] = v[name];
    // The router must always have somewhere to send a turn.
    return next.sonnet || next.opus ? next : undefined;
  },
  effortAuto: (v) => (isBool(v) ? v : undefined),
  stepRouting: (v) => (isBool(v) ? v : undefined),
  effortSteps: (v) => (isBool(v) ? v : undefined),
  trimToolResults: (v) => (isBool(v) ? v : undefined),
  guard: (v) => (isBool(v) ? v : undefined),
  rankFiles: (v) => (isBool(v) ? v : undefined),
  pausedTier: (v) => (oneOf(["haiku", "sonnet", "opus", "fable"])(v) ? v : undefined),
  baselineTier: (v) => (oneOf(["sonnet", "opus", "fable"])(v) ? v : undefined),
  showPrompts: (v) => (isBool(v) ? v : undefined),
  showUsageInMenuBar: (v) => (isBool(v) ? v : undefined),
  alerts: (v, current) => {
    if (!v || typeof v !== "object") return undefined;
    const next = { ...current, windows: { ...current.windows } };
    for (const key of ["enabled", "limit", "reset", "pace"]) if (isBool(v[key])) next[key] = v[key];
    if (Array.isArray(v.thresholds)) {
      // Whole percentages the panel can show: 1..99, sorted, no repeats, at most six.
      const good = [...new Set(v.thresholds.filter((n) => Number.isInteger(n) && n >= 1 && n <= 99))].sort((a, b) => a - b);
      next.thresholds = good.slice(0, 6);
    }
    if (v.windows && typeof v.windows === "object") {
      for (const key of ["fiveHour", "weekly"]) if (isBool(v.windows[key])) next.windows[key] = v.windows[key];
    }
    return next;
  },
  launch: (v, current) => {
    if (!v || typeof v !== "object") return undefined;
    const next = { ...current };
    if (oneOf(ENGINES)(v.engine)) next.engine = v.engine;
    if (typeof v.terminal === "string" && /^[a-z0-9-]{1,24}$/.test(v.terminal)) next.terminal = v.terminal;
    if (isBool(v.resume)) next.resume = v.resume;
    if (v.dir === null) next.dir = null;
    else if (typeof v.dir === "string" && v.dir.startsWith("/") && v.dir.length < 1024 && !/[\u0000-\u001f]/.test(v.dir)) next.dir = v.dir;
    return next;
  },
};

/** `base` with every valid field of `patch` applied. Unknown keys are ignored. */
export function mergePrefs(base, patch) {
  const out = structuredClone(base);
  if (!patch || typeof patch !== "object") return out;
  for (const [key, validate] of Object.entries(SCHEMA)) {
    if (!(key in patch)) continue;
    const cleaned = validate(patch[key], out[key]);
    if (cleaned !== undefined) out[key] = cleaned;
  }
  return out;
}

export const defaultPrefs = () => structuredClone(DEFAULT_PREFS);

export function loadPrefs(file = PREFS_FILE()) {
  try {
    return mergePrefs(defaultPrefs(), JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return defaultPrefs();
  }
}

/** Write through a temp file and rename, so a crash mid-write never leaves half a file. */
export function savePrefs(prefs, file = PREFS_FILE()) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(prefs, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
  chmodSync(file, 0o600);
}
