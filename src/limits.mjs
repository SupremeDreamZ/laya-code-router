// What the plan says about your usage, read off the response headers Anthropic already sends on
// every request. Nothing here makes a call of its own: the proxy sees each response go past, this
// parses it, and the daemon keeps the latest reading.
//
// Shapes verified against real responses on 2026-09-30 (Max plan):
//   anthropic-ratelimit-unified-5h-utilization: 0.05     fraction 0..1, the same figure Claude
//   anthropic-ratelimit-unified-5h-reset:       1790814600   Code's status line shows as a percent
//   anthropic-ratelimit-unified-5h-status:      allowed
//   anthropic-ratelimit-unified-7d-*                      the weekly window
//   anthropic-ratelimit-unified-7d_oi-*                   a third window that appeared on a Fable
//                                                         request; its meaning is undocumented
//   anthropic-ratelimit-unified-overage-status: rejected  pay-as-you-go extra usage, NOT a window
//   anthropic-ratelimit-unified-representative-claim: five_hour   the window currently binding
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { HOME_DIR } from "./prefs.mjs";
import { THRESHOLDS } from "./config.mjs";

export const LIMITS_FILE = () => join(HOME_DIR(), "limits.json");

const PREFIX = "anthropic-ratelimit-unified-";
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const STATUSES = new Set(["allowed", "allowed_warning", "rejected"]);
const CLAIMS = { five_hour: "5h", seven_day: "7d" };
// Suffixes that belong to the account-wide summary, not to a window.
const NOT_A_WINDOW = new Set(["overage", "fallback", "representative", "reset", "status"]);

const first = (v) => (Array.isArray(v) ? v[0] : v);
const num = (v) => {
  const n = Number(first(v));
  return first(v) !== undefined && first(v) !== "" && Number.isFinite(n) ? n : null;
};

/** Length of a window from its name ("5h", "7d", "7d_oi"), or null when it cannot be told. */
export function windowLength(key) {
  const m = /^(\d+)(h|d)(?:_[a-z0-9]+)?$/.exec(key);
  if (!m) return null;
  return Number(m[1]) * (m[2] === "h" ? HOUR : DAY);
}

/**
 * One window's reset, as two sources give it, can differ by a second or so: the usage cache keeps
 * fractions of a second and the headers do not. Within this they are the same window.
 */
export const SAME_WINDOW_MS = 5000;
export const sameWindow = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= SAME_WINDOW_MS;

/**
 * Reads the limit headers off one response. Returns null when there are none, which is the normal
 * case for any non-subscription credential. Values that do not parse are dropped field by field,
 * so one odd header never discards its neighbours.
 */
export function parseLimitHeaders(headers) {
  if (!headers || typeof headers !== "object") return null;
  const raw = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (lower.startsWith(PREFIX)) raw[lower.slice(PREFIX.length)] = first(value);
  }
  if (!Object.keys(raw).length) return null;

  const windows = {};
  for (const key of Object.keys(raw)) {
    const m = /^(.+)-utilization$/.exec(key);
    if (!m || NOT_A_WINDOW.has(m[1])) continue;
    const name = m[1];
    const utilization = num(raw[key]);
    // A negative or non-numeric figure is noise. Above 1 is kept: going over is information.
    if (utilization === null || utilization < 0) continue;
    const reset = num(raw[`${name}-reset`]);
    const status = raw[`${name}-status`];
    windows[name] = {
      utilization,
      resetsAt: reset !== null && reset > 0 ? reset * 1000 : null,
      status: STATUSES.has(status) ? status : null,
    };
  }

  const overageStatus = raw["overage-status"];
  const overageReason = raw["overage-disabled-reason"];
  const claim = raw["representative-claim"];
  const reset = num(raw.reset);
  return {
    windows,
    status: STATUSES.has(raw.status) ? raw.status : null,
    representative: CLAIMS[claim] ?? null,
    resetsAt: reset !== null && reset > 0 ? reset * 1000 : null,
    overage: overageStatus
      ? {
          status: STATUSES.has(overageStatus) ? overageStatus : null,
          reason: typeof overageReason === "string" && /^[a-z_]{1,40}$/.test(overageReason) ? overageReason : null,
        }
      : null,
    fallbackPct: num(raw["fallback-percentage"]),
  };
}

/**
 * The newest reading on top of what was known. A window the new reading lacks is kept, because a
 * Haiku turn does not carry the Fable window and must not erase it; a window whose reset time has
 * passed is dropped, because it no longer describes anything.
 */
export function mergeLimits(previous, reading, now = Date.now()) {
  if (!reading) return previous ?? null;
  const windows = { ...(previous?.windows ?? {}) };
  for (const [key, w] of Object.entries(reading.windows)) {
    // One window, as two sources round its reset: the instant already in use is kept. A window is
    // never split in two, because alerts are tracked per window and would be told twice.
    windows[key] = sameWindow(windows[key]?.resetsAt, w.resetsAt) ? { ...w, resetsAt: windows[key].resetsAt } : w;
  }
  for (const [key, w] of Object.entries(windows)) {
    if (w.resetsAt && w.resetsAt <= now) delete windows[key];
  }
  return {
    at: now,
    windows,
    status: reading.status,
    representative: reading.representative,
    resetsAt: reading.resetsAt,
    overage: reading.overage ?? previous?.overage ?? null,
    fallbackPct: reading.fallbackPct ?? previous?.fallbackPct ?? null,
  };
}

const ORDER = ["5h", "7d"];

/** Live windows, 5h first, then weekly, then anything else; each with its key attached. */
export function activeWindows(state, now = Date.now()) {
  if (!state?.windows) return [];
  return Object.entries(state.windows)
    .filter(([, w]) => !w.resetsAt || w.resetsAt > now)
    .map(([key, w]) => ({ key, ...w }))
    .sort((a, b) => {
      const ia = ORDER.indexOf(a.key);
      const ib = ORDER.indexOf(b.key);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.key.localeCompare(b.key);
    });
}

/**
 * Whether routing should hold new decisions off Opus: the 5-hour window is at or over `capAt` and
 * resets more than `minResetMs` from now. Anything unknown (no reading, no reset time, a window
 * that already reset) is false, so a missing figure never changes a decision.
 */
export function paceCapActive(state, now = Date.now(), { capAt = THRESHOLDS.paceCapAt, minResetMs = THRESHOLDS.paceMinResetMs } = {}) {
  const win = activeWindows(state, now).find((w) => w.key === "5h");
  if (!win || !Number.isFinite(win.utilization) || !Number.isFinite(win.resetsAt)) return false;
  return win.utilization >= capAt && win.resetsAt - now > minResetMs;
}

/**
 * When a steady pace would empty this window, or null when it would last until the reset (or
 * there is too little to go on). Pace is the average so far: utilization over time elapsed.
 */
export function projectHit(win, now = Date.now()) {
  const length = windowLength(win?.key);
  if (!length || !win.resetsAt || !Number.isFinite(win.utilization)) return null;
  if (win.utilization >= 1) return null;
  const elapsed = length - (win.resetsAt - now);
  // Under a few minutes of history, or under 10% used, the rate is noise, not a trend.
  if (elapsed < 10 * 60_000 || win.utilization < 0.1) return null;
  const perMs = win.utilization / elapsed;
  const inMs = Math.round((1 - win.utilization) / perMs);
  if (inMs >= win.resetsAt - now) return null;
  return { inMs, atMs: now + inMs };
}

/** Sanity check for anything read from disk: a parsed file is not a trusted one. */
const valid = (state) =>
  state &&
  typeof state === "object" &&
  state.windows &&
  typeof state.windows === "object" &&
  Object.values(state.windows).every((w) => w && Number.isFinite(w.utilization));

export function loadLimits(file = LIMITS_FILE(), now = Date.now()) {
  try {
    const state = JSON.parse(readFileSync(file, "utf8"));
    if (!valid(state)) return null;
    // Anything that reset while the daemon was away no longer describes the plan.
    return {
      ...state,
      windows: Object.fromEntries(Object.entries(state.windows).filter(([, w]) => !w.resetsAt || w.resetsAt > now)),
    };
  } catch {
    return null;
  }
}

export function saveLimits(state, file = LIMITS_FILE()) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  renameSync(tmp, file);
  chmodSync(file, 0o600);
}
