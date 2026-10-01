// Decides when to tell you about your plan limits. Pure logic plus one small state file: it is
// handed the latest reading and your settings, and returns the alerts that are newly due. It never
// shows anything itself, so the same rules drive the notification, the panel and the tests.
//
// The rules, in the order they matter:
//   - Each (window, threshold) fires once per window. A new window starts from zero.
//   - Jumping past two thresholds in one reading raises one alert, for the higher; the lower is
//     marked spent so it cannot turn up late.
//   - Hitting the limit is its own alert, and the reset that follows it is announced once.
//   - A reset is only announced if the limit was actually hit and the news is fresh.
//   - Being blocked is never muted by a per-window switch: only the master switch and the
//     dedicated "limit" switch control it.
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { HOME_DIR } from "./prefs.mjs";
import { projectHit, windowLength } from "./limits.mjs";

export const ALERTS_FILE = () => join(HOME_DIR(), "alerts.json");

const MAX_LOG = 30;
const KEEP_WINDOWS = 3;
const FRESH_RESET_MS = 2 * 3600_000;
const LOG_KEEP_MS = 14 * 24 * 3600_000;

const NAMES = { "5h": "5-hour", "7d": "weekly" };
const PREF_KEY = { "5h": "fiveHour", "7d": "weekly" };
const nameOf = (key) => NAMES[key] ?? key;

const defaultFormat = {
  time: (ms) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
  duration: (ms) => {
    const m = Math.max(1, Math.round(ms / 60000));
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60);
    const r = m % 60;
    return h >= 24 ? `${Math.round(h / 24)} days` : r ? `${h} h ${r} min` : `${h} h`;
  },
};

const empty = () => ({ fired: {}, log: [], pending: {} });

function read(file) {
  try {
    const s = JSON.parse(readFileSync(file, "utf8"));
    if (!s || typeof s !== "object") return empty();
    return { fired: s.fired ?? {}, log: Array.isArray(s.log) ? s.log : [], pending: s.pending ?? {} };
  } catch {
    return empty();
  }
}

function write(file, state) {
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    renameSync(tmp, file);
    chmodSync(file, 0o600);
  } catch {
    // Alert bookkeeping is never worth failing a request over.
  }
}

export function createAlerts({ file = ALERTS_FILE(), now = Date.now, fmt = defaultFormat } = {}) {
  const state = read(file);
  let seq = 0;
  const id = (t) => `${t}-${++seq}-${Math.random().toString(36).slice(2, 7)}`;

  const save = () => write(file, state);

  function raise(alert) {
    const a = { id: id(now()), at: now(), ...alert };
    state.log.push(a);
    if (state.log.length > MAX_LOG) state.log.splice(0, state.log.length - MAX_LOG);
    return a;
  }

  const slot = (key, resetsAt) => `${key}@${resetsAt ?? "x"}`;

  /** Drops bookkeeping for windows that ended long ago, so the file stays small. */
  function prune() {
    const slots = Object.keys(state.fired);
    if (slots.length > KEEP_WINDOWS) {
      const newest = slots
        .map((s) => ({ s, at: state.fired[s].seen ?? 0 }))
        .sort((a, b) => b.at - a.at)
        .slice(0, KEEP_WINDOWS)
        .map((x) => x.s);
      for (const s of slots) if (!newest.includes(s)) delete state.fired[s];
    }
    const cut = now() - LOG_KEEP_MS;
    state.log = state.log.filter((a) => a.at >= cut).slice(-MAX_LOG);
  }

  function evaluate({ limits, prefs }) {
    const out = [];
    if (!prefs?.enabled) return out;
    const t = now();
    const thresholds = prefs.thresholds ?? [];
    const windows = Object.entries(limits?.windows ?? {}).filter(([, w]) => !w.resetsAt || w.resetsAt > t);

    for (const [key, w] of windows) {
      const s = slot(key, w.resetsAt);
      const rec = (state.fired[s] ??= { spent: [], limit: false, pace: false, seen: t });
      rec.seen = t;
      const pct = Math.floor(w.utilization * 100 + 1e-9);
      const windowOn = prefs.windows?.[PREF_KEY[key]] !== false;
      const blocked = w.status === "rejected" || (limits?.status === "rejected" && limits?.representative === key && w.utilization >= 1);

      // ---- limit hit: never muted by the per-window switch
      if (blocked && prefs.limit !== false && !rec.limit) {
        rec.limit = true;
        state.pending[key] = { resetsAt: w.resetsAt, raisedAt: t };
        out.push(
          raise({
            kind: "limit",
            level: "critical",
            window: key,
            pct: Math.min(100, pct),
            title: `You hit your ${nameOf(key)} limit`,
            body: w.resetsAt
              ? `Resets at ${fmt.time(w.resetsAt)}, in ${fmt.duration(w.resetsAt - t)}.`
              : "Resets when the window rolls over.",
          }),
        );
        // Everything below the limit is moot now.
        for (const th of thresholds) if (!rec.spent.includes(th)) rec.spent.push(th);
        continue;
      }

      if (!windowOn) continue;

      // ---- thresholds: fire the highest one newly crossed, mark the ones it skipped as spent
      const crossed = thresholds.filter((th) => pct >= th && !rec.spent.includes(th));
      if (crossed.length) {
        for (const th of crossed) rec.spent.push(th);
        const th = Math.max(...crossed);
        const top = thresholds.length ? Math.max(...thresholds) : th;
        out.push(
          raise({
            kind: "threshold",
            level: th >= Math.max(90, top) ? "critical" : "warning",
            window: key,
            threshold: th,
            pct,
            title: `${pct}% of your ${nameOf(key)} limit used`,
            body: w.resetsAt
              ? `Resets at ${fmt.time(w.resetsAt)}, in ${fmt.duration(w.resetsAt - t)}.`
              : "Resets when the window rolls over.",
          }),
        );
      }

      // ---- pace: a prediction, opt-in, once per window
      if (prefs.pace && !rec.pace && windowLength(key)) {
        const hit = projectHit({ key, ...w }, t);
        if (hit) {
          rec.pace = true;
          out.push(
            raise({
              kind: "pace",
              level: "warning",
              window: key,
              pct,
              title: `At this pace your ${nameOf(key)} limit runs out in ${fmt.duration(hit.inMs)}`,
              body: `It resets at ${fmt.time(w.resetsAt)}. Easing off, or routing more to Haiku, stretches it.`,
            }),
          );
        }
      }
    }

    // ---- a window we were waiting on has ended
    for (const [key, p] of Object.entries(state.pending)) {
      const live = windows.some(([k, w]) => k === key && w.resetsAt === p.resetsAt);
      if (live) continue;
      if (p.resetsAt && t < p.resetsAt) continue;
      delete state.pending[key];
      const fresh = !p.resetsAt || t - p.resetsAt <= FRESH_RESET_MS;
      if (!fresh || prefs.reset === false || prefs.limit === false) continue;
      out.push(
        raise({
          kind: "reset",
          level: "info",
          window: key,
          title: `Your ${nameOf(key)} limit has reset`,
          body: "You have a fresh window.",
        }),
      );
    }

    prune();
    if (out.length || Object.keys(state.fired).length) save();
    return out;
  }

  /** A sample alert so the notification path can be tried; it leaves the real dedupe state alone. */
  function test() {
    const a = raise({
      kind: "test",
      test: true,
      level: "info",
      title: "Usage alerts are on",
      body: "This is what an alert looks like.",
    });
    save();
    return a;
  }

  return {
    evaluate,
    test,
    recent: () => state.log.slice(),
  };
}
