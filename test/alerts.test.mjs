import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAlerts } from "../src/alerts.mjs";
import { DEFAULT_PREFS, mergePrefs } from "../src/prefs.mjs";

const H = 3600_000;
const D = 24 * H;
const T0 = Date.UTC(2026, 8, 30, 20, 0, 0);

/** An engine on a throwaway file, a clock the test moves, and time words that are easy to assert. */
function engine(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), "laya-alerts-"));
  const file = opts.file ?? join(dir, "alerts.json");
  const clock = { t: opts.now ?? T0 };
  const fmt = { time: (ms) => `T(${Math.round((ms - T0) / 60000)}m)`, duration: (ms) => `D(${Math.round(ms / 60000)}m)` };
  const make = () => createAlerts({ file, now: () => clock.t, fmt });
  return { alerts: make(), make, clock, file };
}

const R5 = T0 + 3 * H;
const R7 = T0 + 5 * D;
const limits = (u5, u7 = 0.1, over = {}) => ({
  at: T0,
  status: "allowed",
  representative: "5h",
  windows: {
    "5h": { utilization: u5, resetsAt: R5, status: "allowed" },
    "7d": { utilization: u7, resetsAt: R7, status: "allowed" },
    ...(over.windows ?? {}),
  },
  ...Object.fromEntries(Object.entries(over).filter(([k]) => k !== "windows")),
});
const prefs = (patch = {}) => mergePrefs(DEFAULT_PREFS, { alerts: patch }).alerts;

test("below every threshold nothing fires", () => {
  const { alerts } = engine();
  assert.deepEqual(alerts.evaluate({ limits: limits(0.7), prefs: prefs() }), []);
});

test("crossing a threshold fires one alert naming the window, the real figure and the reset", () => {
  const { alerts } = engine();
  const [a, ...rest] = alerts.evaluate({ limits: limits(0.78), prefs: prefs() });
  assert.equal(rest.length, 0);
  assert.equal(a.kind, "threshold");
  assert.equal(a.window, "5h");
  assert.equal(a.threshold, 75);
  assert.equal(a.pct, 78);
  assert.equal(a.level, "warning");
  assert.match(a.title, /5-hour/i);
  assert.match(a.title, /78%/);
  assert.match(a.body, /T\(180m\)/, "says when it resets");
  assert.match(a.body, /D\(180m\)/, "and how long that is");
});

test("the same reading twice does not fire twice", () => {
  const { alerts } = engine();
  assert.equal(alerts.evaluate({ limits: limits(0.78), prefs: prefs() }).length, 1);
  assert.equal(alerts.evaluate({ limits: limits(0.78), prefs: prefs() }).length, 0);
  assert.equal(alerts.evaluate({ limits: limits(0.8), prefs: prefs() }).length, 0);
});

test("the next threshold fires on its own, and the top one is critical", () => {
  const { alerts } = engine();
  alerts.evaluate({ limits: limits(0.78), prefs: prefs() });
  const [a] = alerts.evaluate({ limits: limits(0.92), prefs: prefs() });
  assert.equal(a.threshold, 90);
  assert.equal(a.level, "critical");
});

test("jumping past two thresholds in one reading raises one alert, for the higher", () => {
  const { alerts, make } = engine();
  const out = alerts.evaluate({ limits: limits(0.95), prefs: prefs() });
  assert.equal(out.length, 1);
  assert.equal(out[0].threshold, 90);
  // The 75 it skipped is spent: it must not turn up later or after a restart.
  assert.deepEqual(alerts.evaluate({ limits: limits(0.96), prefs: prefs() }), []);
  assert.deepEqual(make().evaluate({ limits: limits(0.96), prefs: prefs() }), []);
});

test("a restart does not repeat an alert that was already raised", () => {
  const { alerts, make } = engine();
  alerts.evaluate({ limits: limits(0.8), prefs: prefs() });
  assert.deepEqual(make().evaluate({ limits: limits(0.8), prefs: prefs() }), []);
});

test("the weekly window alerts on its own and is named as weekly", () => {
  const { alerts } = engine();
  const [a] = alerts.evaluate({ limits: limits(0.1, 0.8), prefs: prefs() });
  assert.equal(a.window, "7d");
  assert.match(a.title, /weekly/i);
});

test("each window can be switched off without silencing the other", () => {
  const { alerts } = engine();
  const out = alerts.evaluate({ limits: limits(0.8, 0.8), prefs: prefs({ windows: { weekly: false } }) });
  assert.deepEqual(out.map((a) => a.window), ["5h"]);
});

test("master switch: off is silent, and turning it on later still tells you", () => {
  const { alerts } = engine();
  assert.deepEqual(alerts.evaluate({ limits: limits(0.92), prefs: prefs({ enabled: false }) }), []);
  const out = alerts.evaluate({ limits: limits(0.92), prefs: prefs({ enabled: true }) });
  assert.equal(out.length, 1, "nothing was recorded while it was off, so it is not swallowed");
});

test("a new window re-arms every threshold", () => {
  const { alerts } = engine();
  assert.equal(alerts.evaluate({ limits: limits(0.8), prefs: prefs() }).length, 1);
  const next = limits(0.8);
  next.windows["5h"].resetsAt = R5 + 5 * H;
  assert.equal(alerts.evaluate({ limits: next, prefs: prefs() }).length, 1);
});

test("your own thresholds replace the defaults", () => {
  const { alerts } = engine();
  const p = prefs({ thresholds: [50] });
  assert.equal(alerts.evaluate({ limits: limits(0.55), prefs: p })[0].threshold, 50);
  assert.deepEqual(alerts.evaluate({ limits: limits(0.8), prefs: p }), [], "75 is not one of yours");
});

// ---- hitting the limit, and the reset ----------------------------------------------------
const blocked = () => limits(1, 0.1, { windows: { "5h": { utilization: 1, resetsAt: R5, status: "rejected" } } });

test("hitting the limit raises one critical alert with the reset time", () => {
  const { alerts } = engine();
  const out = alerts.evaluate({ limits: blocked(), prefs: prefs() });
  const limit = out.find((a) => a.kind === "limit");
  assert.ok(limit);
  assert.equal(limit.level, "critical");
  assert.equal(limit.window, "5h");
  assert.match(limit.body, /T\(180m\)/);
  assert.equal(alerts.evaluate({ limits: blocked(), prefs: prefs() }).filter((a) => a.kind === "limit").length, 0);
});

test("the limit alert can be turned off, and then so is the reset that follows it", () => {
  const { alerts, clock } = engine();
  const out = alerts.evaluate({ limits: blocked(), prefs: prefs({ limit: false }) });
  assert.equal(out.filter((a) => a.kind === "limit").length, 0);
  clock.t = R5 + 1000;
  assert.deepEqual(alerts.evaluate({ limits: { windows: {} }, prefs: prefs({ limit: false }) }), []);
});

test("after a limit, the reset is announced once when the window rolls over", () => {
  const { alerts, clock } = engine();
  alerts.evaluate({ limits: blocked(), prefs: prefs() });
  clock.t = R5 - 60_000;
  assert.deepEqual(alerts.evaluate({ limits: { windows: {} }, prefs: prefs() }), [], "not before it resets");
  clock.t = R5 + 60_000;
  const [r] = alerts.evaluate({ limits: { windows: {} }, prefs: prefs() });
  assert.equal(r.kind, "reset");
  assert.equal(r.level, "info");
  assert.equal(r.window, "5h");
  assert.deepEqual(alerts.evaluate({ limits: { windows: {} }, prefs: prefs() }), [], "once only");
});

test("no reset is announced for a limit you never hit", () => {
  const { alerts, clock } = engine();
  alerts.evaluate({ limits: limits(0.8), prefs: prefs() });
  clock.t = R5 + 60_000;
  assert.deepEqual(alerts.evaluate({ limits: { windows: {} }, prefs: prefs() }), []);
});

test("a reset that happened long ago is not announced as news after a restart", () => {
  const { alerts, make, clock } = engine();
  alerts.evaluate({ limits: blocked(), prefs: prefs() });
  clock.t = R5 + 3 * H;
  assert.deepEqual(make().evaluate({ limits: { windows: {} }, prefs: prefs() }), []);
  clock.t = R5 + 3 * H + 1000;
  assert.deepEqual(make().evaluate({ limits: { windows: {} }, prefs: prefs() }), [], "and it was consumed, not deferred");
});

test("an overall rejection with no flagged window is pinned on the window that was binding", () => {
  const { alerts } = engine();
  const out = alerts.evaluate({ limits: limits(1, 0.1, { status: "rejected", representative: "5h" }), prefs: prefs() });
  assert.equal(out.find((a) => a.kind === "limit")?.window, "5h");
});

test("a blocked window we have no name for still raises the limit alert, under its own id", () => {
  const { alerts } = engine();
  const odd = limits(0.1, 0.1, { windows: { "7d_oi": { utilization: 1, resetsAt: R7, status: "rejected" } } });
  const out = alerts.evaluate({ limits: odd, prefs: prefs({ windows: { weekly: false } }) });
  const a = out.find((x) => x.kind === "limit");
  assert.ok(a, "being blocked is never muted by a per-window switch");
  assert.equal(a.window, "7d_oi");
  assert.match(a.title, /7d_oi/);
});

// ---- pace --------------------------------------------------------------------------------
test("pace warnings are off unless asked for", () => {
  const { alerts } = engine();
  // 2h into the window at 60%: on pace to run out early, so a warning would fire if enabled.
  const l = { at: T0, windows: { "5h": { utilization: 0.6, resetsAt: T0 + 3 * H, status: "allowed" } } };
  assert.deepEqual(alerts.evaluate({ limits: l, prefs: prefs({ thresholds: [] }) }), []);
});

test("pace: on, and running out before the reset, warns once with the time left", () => {
  const { alerts } = engine();
  // 2h in (resets in 3h), 60% used -> 30%/h -> empty in 1h20m, before the reset.
  const l = { at: T0, windows: { "5h": { utilization: 0.6, resetsAt: T0 + 3 * H, status: "allowed" } } };
  const out = alerts.evaluate({ limits: l, prefs: prefs({ pace: true, thresholds: [] }) });
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, "pace");
  assert.equal(out[0].level, "warning");
  assert.match(out[0].title, /D\(80m\)/);
  assert.deepEqual(alerts.evaluate({ limits: l, prefs: prefs({ pace: true, thresholds: [] }) }), [], "once per window");
});

test("pace: staying under until the reset says nothing", () => {
  const { alerts } = engine();
  const l = { at: T0, windows: { "5h": { utilization: 0.2, resetsAt: T0 + 3 * H, status: "allowed" } } };
  assert.deepEqual(alerts.evaluate({ limits: l, prefs: prefs({ pace: true, thresholds: [] }) }), []);
});

// ---- housekeeping ------------------------------------------------------------------------
test("the file does not grow without bound", () => {
  const { alerts, file, clock } = engine();
  for (let i = 0; i < 40; i++) {
    clock.t = T0 + i * 6 * H;
    const l = limits(0.8);
    l.windows["5h"].resetsAt = clock.t + 3 * H;
    alerts.evaluate({ limits: l, prefs: prefs() });
  }
  clock.t = T0 + 30 * D;
  const l = limits(0.8);
  l.windows["5h"].resetsAt = clock.t + 3 * H;
  alerts.evaluate({ limits: l, prefs: prefs() });
  const saved = JSON.parse(readFileSync(file, "utf8"));
  assert.ok(Object.keys(saved.fired).length <= 3, `kept ${Object.keys(saved.fired).length} window records`);
  assert.ok(saved.log.length <= 30);
});

test("recent alerts are available for the panel, oldest first, capped", () => {
  const { alerts, clock } = engine();
  alerts.evaluate({ limits: limits(0.8), prefs: prefs() });
  clock.t += 1000;
  alerts.evaluate({ limits: limits(0.92), prefs: prefs() });
  const recent = alerts.recent();
  assert.deepEqual(recent.map((a) => a.threshold), [75, 90]);
  assert.ok(recent[0].at < recent[1].at);
});

test("a test alert is real to the UI but leaves the dedupe state alone", () => {
  const { alerts } = engine();
  const t = alerts.test();
  assert.equal(t.kind, "test");
  assert.equal(t.test, true);
  assert.equal(alerts.recent().at(-1).id, t.id);
  assert.equal(alerts.evaluate({ limits: limits(0.8), prefs: prefs() }).length, 1, "a real 75% alert still fires");
});

test("a corrupt alerts file starts clean instead of crashing the daemon", () => {
  const dir = mkdtempSync(join(tmpdir(), "laya-alerts-"));
  const file = join(dir, "alerts.json");
  writeFileSync(file, "{oops");
  const a = createAlerts({ file, now: () => T0, fmt: { time: String, duration: String } });
  assert.equal(a.evaluate({ limits: limits(0.8), prefs: prefs() }).length, 1);
});

test("alert ids are unique per alert, so the app can tell which it has already shown", () => {
  const { alerts } = engine();
  alerts.evaluate({ limits: limits(0.8), prefs: prefs() });
  alerts.evaluate({ limits: limits(0.92), prefs: prefs() });
  const ids = alerts.recent().map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length);
});

// ---- holes found by mutation testing: each of these was a real change no test noticed ----------
test("being blocked is announced even when that same window's threshold alerts are switched off", () => {
  const { alerts } = engine();
  // The 5h window is muted and is ALSO the one that is blocked. A mute is about the nagging at 75%
  // and 90%; it must never hide the one alert that says you cannot work.
  const out = alerts.evaluate({ limits: blocked(), prefs: prefs({ windows: { fiveHour: false } }) });
  const a = out.find((x) => x.kind === "limit");
  assert.ok(a, "a muted window still announces that it is blocked");
  assert.equal(a.window, "5h");
  assert.equal(out.filter((x) => x.kind === "threshold").length, 0, "and the muted threshold alerts stay muted");
});

test("the reset notice has its own switch, separate from the limit alert", () => {
  const { alerts, clock } = engine();
  const p = prefs({ reset: false });
  assert.equal(alerts.evaluate({ limits: blocked(), prefs: p }).filter((a) => a.kind === "limit").length, 1, "the limit alert still fires");
  clock.t = R5 + 60_000;
  assert.deepEqual(alerts.evaluate({ limits: { windows: {} }, prefs: p }), [], "but the reset is not announced");
});

test("the alert log is capped at 30 entries even when every one is fresh", () => {
  const { alerts, file, clock } = engine();
  for (let i = 0; i < 45; i++) {
    clock.t = T0 + i * 1000; // well inside the age window, so only the count can trim it
    const l = limits(0.8);
    l.windows["5h"].resetsAt = clock.t + 3 * H + i; // a new window each time, so each fires
    alerts.evaluate({ limits: l, prefs: prefs() });
  }
  assert.equal(alerts.recent().length, 30);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).log.length, 30);
  assert.equal(alerts.recent().at(-1).at, T0 + 44 * 1000, "it keeps the newest, not the oldest");
});

test("alerts older than two weeks fall out of the log", () => {
  const { alerts, clock } = engine();
  alerts.evaluate({ limits: limits(0.8), prefs: prefs() });
  assert.equal(alerts.recent().length, 1);
  clock.t = T0 + 15 * D;
  const l = limits(0.1);
  l.windows["5h"].resetsAt = clock.t + 3 * H;
  l.windows["7d"].resetsAt = clock.t + 5 * D;
  alerts.evaluate({ limits: l, prefs: prefs() });
  assert.equal(alerts.recent().length, 0);
});

test("pressing the test-alert button over and over cannot grow the log without bound", () => {
  // test() raises an alert without going through evaluate(), so this path has only the cap in
  // raise() standing between a bored user and an ever-growing file.
  const { alerts, file } = engine();
  for (let i = 0; i < 45; i++) alerts.test();
  assert.equal(alerts.recent().length, 30);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).log.length, 30);
});
