// The plan's usage figures, asked of Claude Code instead of waited for.
//
// Why this exists: the proxy reads Anthropic's rate-limit headers off responses that pass through
// Laya, so until a turn has gone through Laya there is nothing to show, and once the window that
// reading belonged to has ended there is nothing again. Found on a real Mac (2026-10-01): the
// router held a reading 13 hours old, every window in it had ended, and the menu bar showed a dash
// while the account sat at 26%.
//
// Claude Code can be asked directly. `claude -p /usage` costs no tokens, calls no model and writes
// no session or history entry. It refreshes the usage cache in Claude Code's own config file
// (`cachedUsageUtilization`, with the time it was fetched beside it), and that cache is what is read
// here, not the text `/usage` prints: the text gives times in the machine's own zone, to the minute,
// in wording that can change, and the cache holds the same figures with exact times. Measured on a
// Max account (2026-09-30): the cache, the text and the rate-limit headers of a proxied turn agreed
// (69, "69% used", 0.69), and the cache's reset, rounded to the second, equalled the headers'
// (22:29:59.689576 against 1790832600).
//
// The trap, and the reason for the freshness rule: when Claude Code cannot reach Anthropic it leaves
// the cache as it was, and `/usage` prints that without saying so (measured: offline, it printed the
// old figure and exited 0). A figure is used only if the fetch that wrote it was recent. Anything
// older is "stale" and ignored, and the last real reading is left to age on its own.
//
// What the probe is told, each measured on 2026-09-30:
//   --no-session-persistence     no session file is written
//   --strict-mcp-config          MCP servers stay out of a background poll (3.9 s of CPU became 0.9 s)
//   --setting-sources user and
//   --settings disableAllHooks   together keep a person's own hooks from running. A project-level
//                                hook fires with either one alone, and a user-level hook with neither.
//   DISABLE_TELEMETRY and
//   DISABLE_ERROR_REPORTING      keep the poll from opening a second connection to a log intake
// and one thing it must not be told: CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC makes `/usage` skip
// its fetch and serve the cache (the cache's timestamp did not move), so it is removed from the
// probe's environment even when the person has it set.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { findClaude } from "./account.mjs";
import { sameWindow, windowLength } from "./limits.mjs";

export const USAGE_ARGS = Object.freeze([
  "-p", "/usage",
  "--output-format", "json",
  "--no-session-persistence",
  "--strict-mcp-config",
  "--setting-sources", "user",
  "--settings", '{"disableAllHooks":true}',
]);

const PROBE_ENV = Object.freeze({ DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1" });
const NEVER = "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC";

/** How often to ask. The figure moves slowly, and each ask is a process that lives about a second. */
export const DEFAULT_TICK_MS = 5 * 60_000;
/** How soon to look again when there is nobody to ask for yet. That is a flag check, not a process. */
const RECHECK_MS = 1000;
const PROBE_TIMEOUT_MS = 30_000;
/**
 * How old a fetch may be and still count as now. Claude Code fetches again only when its cache is
 * older than about a minute (measured: not at 25, 52 or 55 s; yes at 80 s and over), so a probe
 * that worked always leaves a cache younger than this, and one that did not leaves an older one.
 */
const FRESH_MS = 90_000;
/** A cache stamped slightly in the future is a clock a few seconds out, not a reason to refuse it. */
const CLOCK_SLACK_MS = 5000;
/** How far outside its own length a reset may land before the whole window is thrown away. */
const RESET_SLACK_MS = 5 * 60_000;
const CACHE_WINDOWS = { five_hour: "5h", seven_day: "7d" };
const TIMER_MAX = 2 ** 31 - 1;
const TIMER_MIN = 50;

// ---------------------------------------------------------------- reading the cache

/**
 * What Claude Code last fetched, read out of its own config file: the two plan windows, and when.
 * Nothing else in that file is read, kept or returned. It also holds the account's identity.
 * `null` when the file, the cache or every window in it is missing or does not make sense.
 *
 * The file is `.claude.json` in the home folder, or in CLAUDE_CONFIG_DIR when that is set (measured:
 * it is not inside ~/.claude/). A relative CLAUDE_CONFIG_DIR means the folder this process is in,
 * which is also what the child it starts means by it.
 */
export function readUsageCache({ env = process.env, home = homedir() } = {}) {
  let cache;
  try {
    const dir = env.CLAUDE_CONFIG_DIR ? resolve(env.CLAUDE_CONFIG_DIR) : home;
    cache = JSON.parse(readFileSync(join(dir, ".claude.json"), "utf8"))?.cachedUsageUtilization;
  } catch {
    return null;
  }
  const data = cache?.utilization;
  if (!Number.isFinite(cache?.fetchedAtMs) || !data || typeof data !== "object") return null;
  const windows = {};
  for (const [name, key] of Object.entries(CACHE_WINDOWS)) {
    const w = data[name];
    if (typeof w?.utilization !== "number" || !Number.isFinite(w.utilization) || w.utilization < 0) continue;
    const raw = w.resets_at;
    const at = raw === null ? null : typeof raw === "string" ? Date.parse(raw) : NaN;
    if (at !== null && !Number.isFinite(at)) continue;
    // To the second: the cache keeps fractions of one (…:59.689), the headers do not.
    windows[key] = { utilization: w.utilization / 100, resetsAt: at === null ? null : Math.round(at / 1000) * 1000 };
  }
  return Object.keys(windows).length ? { fetchedAt: cache.fetchedAtMs, windows } : null;
}

/**
 * The windows in a cache that can be shown as current, or null when none can.
 *
 * A cache fetched long ago is refused whole: it is what Claude Code serves when it could not reach
 * Anthropic, and showing it would be a figure from some time ago presented as now. Each window must
 * also reset inside the length of window it claims to be. A 5-hour figure cannot reset in three
 * weeks, and one that did would leave a window on screen that never ends.
 */
export function usableWindows(cache, now = Date.now()) {
  if (!cache) return null;
  const age = now - cache.fetchedAt;
  if (age > FRESH_MS || age < -CLOCK_SLACK_MS) return null;
  const windows = {};
  for (const [key, w] of Object.entries(cache.windows)) {
    const span = windowLength(key);
    if (w.resetsAt !== null && (!span || w.resetsAt <= now - RESET_SLACK_MS || w.resetsAt > now + span + RESET_SLACK_MS)) continue;
    windows[key] = w;
  }
  return Object.keys(windows).length ? windows : null;
}

// ---------------------------------------------------------------- the probe itself

/**
 * One probe: ask Claude Code to refresh its usage cache, then read it.
 *
 * @returns {Promise<{state: "ok", windows: object, fetchedAt: number}
 *   | {state: "stale"} | {state: "missing"} | {state: "unreadable"}>}
 * "stale": it ran, but nothing was fetched recently. That is what being offline looks like, and it
 * is also what an API key looks like, which has no plan windows. "missing": no Claude Code.
 * "unreadable": it did not run to the end (a deadline, a crash, a flood of output), or left no cache.
 */
export function readPlanUsage({ env = process.env, home = homedir(), system, timeoutMs = PROBE_TIMEOUT_MS, bin = null, now = Date.now } = {}) {
  const claude = bin ?? findClaude({ env, home, system });
  if (!claude) return Promise.resolve({ state: "missing" });
  const childEnv = {
    ...env,
    ...PROBE_ENV,
    // `claude` reads the sign-in as "signed out" when USER is missing (measured), whoever is signed in.
    USER: env.USER || userInfo().username,
    // A claude installed by npm starts `#!/usr/bin/env node`, and a background service has no node.
    PATH: [env.PATH, dirname(process.execPath)].filter(Boolean).join(delimiter),
  };
  delete childEnv[NEVER];
  return new Promise((done) => {
    const child = execFile(claude, [...USAGE_ARGS], { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 256 * 1024, env: childEnv }, (err) => {
      // A non-zero exit still leaves a cache worth reading. A deadline, a signal, too much output
      // or a script that cannot start leaves nothing to trust.
      if (err && typeof err.code !== "number") return done({ state: "unreadable" });
      const cache = readUsageCache({ env, home });
      if (!cache) return done({ state: "unreadable" });
      const windows = usableWindows(cache, now());
      done(windows ? { state: "ok", windows, fetchedAt: cache.fetchedAt } : { state: "stale" });
    });
    child.stdin?.end();
  });
}

// ---------------------------------------------------------------- folding it into what is known

/**
 * What to store after a probe, given what was stored before, or null when the probe adds nothing.
 *
 * The probe knows figures and when they reset. It does not know what the response headers know:
 * whether a window is blocked, which one is binding, whether overage was refused. Those are carried
 * over rather than erased, because an unknown is not a "no". But a window's own status is carried
 * only while it is the same window. When the window has rolled over, "rejected" from the old one
 * would mark a fresh, empty window as blocked and raise a limit alert that is no longer true. The
 * same goes for the overall status when the window it was about is the one that rolled.
 */
export function foldPlanReading(previous, reading) {
  if (reading?.state !== "ok") return null;
  const windows = Object.fromEntries(
    Object.entries(reading.windows).map(([key, w]) => {
      const old = previous?.windows?.[key];
      return [key, { ...w, status: old && sameWindow(old.resetsAt, w.resetsAt) ? old.status ?? null : null }];
    }),
  );
  // The overall status, and which window it was about, describe one window. Once that window has
  // rolled over they describe nothing, and a stale "rejected" must not outlive it.
  const bound = previous?.representative;
  const rolled = bound && reading.windows[bound] && !sameWindow(previous.windows?.[bound]?.resetsAt, reading.windows[bound].resetsAt);
  return {
    windows,
    status: rolled ? null : previous?.status ?? null,
    representative: rolled ? null : previous?.representative ?? null,
    resetsAt: rolled ? null : previous?.resetsAt ?? null,
    overage: previous?.overage ?? null,
    fallbackPct: previous?.fallbackPct ?? null,
  };
}

// ---------------------------------------------------------------- what the log says about it

const POLL_WORDS = {
  ok: "plan usage: reading ok",
  stale: "plan usage: Claude Code had nothing fresh to give (offline, or signed in with an API key, which has no plan windows)",
  missing: "plan usage: Claude Code was not found",
  unreadable: "plan usage: Claude Code's usage check did not finish, or left nothing to read",
};

/**
 * One line for the daemon's log each time what a probe finds CHANGES, and nothing while it stays the
 * same. A probe every five minutes would otherwise write the same sentence 288 times a day, and a log
 * that says nothing cannot explain why a figure went missing at 10:40. Returns a function that takes
 * the state a probe ended in ("ok", "stale", "missing", "unreadable", or "error" with the reason) and
 * gives the line to write, or null.
 */
export function createPollNotes() {
  let last = null;
  return (state, detail = "") => {
    const key = state === "error" ? `error:${detail}` : state;
    if (key === last) return null;
    last = key;
    if (state === "error") return `plan usage: the check failed: ${String(detail).split("\n")[0].slice(0, 200)}`;
    return POLL_WORDS[state] ?? `plan usage: ${String(state).slice(0, 40)}`;
  };
}

// ---------------------------------------------------------------- how often

/**
 * How often to probe: the number a person asked for in LAYA_PLAN_TICK_MS, or the default. `off`,
 * `0`, `no`, `false` and `none` turn it off and give null. Anything else out of range is ignored,
 * since Node turns a timer it cannot hold, or one of 0, into a 1 ms loop that would start a
 * process every millisecond. Only a string or a number is read: `Number()` would turn an array or
 * an object into one.
 */
export function planTickMs(raw, fallback = DEFAULT_TICK_MS) {
  if (typeof raw !== "string" && typeof raw !== "number") return fallback;
  const text = String(raw).trim().toLowerCase();
  if (["off", "0", "no", "false", "none"].includes(text)) return null;
  const ms = Number(text);
  return ms >= TIMER_MIN && ms <= TIMER_MAX ? ms : fallback;
}

/**
 * Keeps probing, one at a time. A probe is never started while another is running, readings are
 * handed over in order, `enabled` is asked before each probe so that a machine with nobody signed
 * in starts no process at all, and nothing is delivered or scheduled once `stop` has been called.
 * The first probe is made at once: the person who just opened the app is the one waiting for it.
 * Returns a function that stops it, safe to call twice and from inside a handler.
 */
export function watchPlanUsage({
  read = readPlanUsage, onReading, onError = () => {}, every = DEFAULT_TICK_MS, enabled = () => true,
  recheckMs = RECHECK_MS, setTimer = setTimeout, clearTimer = clearTimeout,
}) {
  let timer = null;
  let stopped = false;
  const later = (ms) => {
    timer = setTimer(loop, ms);
    timer.unref?.();
  };
  const loop = async () => {
    if (stopped) return;
    if (!enabled()) return later(Math.min(every, recheckMs));
    try {
      const reading = await read();
      if (stopped) return; // asked before stop() and answered after it: not wanted any more
      onReading(reading);
    } catch (err) {
      if (stopped) return;
      onError(err);
    }
    if (stopped) return;
    later(every);
  };
  loop();
  return () => {
    stopped = true;
    clearTimer(timer);
  };
}
