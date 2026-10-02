// The plan's usage, asked of Claude Code instead of waited for.
//
// Until a turn had gone through Laya there was no figure to show, and once the window that figure
// belonged to had ended there was none again: on a real Mac (2026-10-01) the router held a reading
// 13 hours old, every window in it over, and the menu bar showed a dash while the account sat at 26%.
// `claude -p /usage` refreshes Claude Code's own usage cache without a token, a model or a session.
// What is read is that cache, not the text the command prints, and the two things that can go wrong
// are tested hardest: a cache served because Claude Code was offline (a stale figure shown as
// current), and a status carried over from a window that has since ended (a limit alert that is
// no longer true).
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { userInfo, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createAlerts } from "../src/alerts.mjs";
import { mergeLimits } from "../src/limits.mjs";
import {
  DEFAULT_TICK_MS,
  USAGE_ARGS,
  foldPlanReading,
  planTickMs,
  readPlanUsage,
  readUsageCache,
  usableWindows,
  watchPlanUsage, createPollNotes, planPollHandlers,
} from "../src/plan-usage.mjs";

const FAKE = fileURLToPath(new URL("./fixtures/fake-claude-usage.mjs", import.meta.url));
const tmp = (name) => mkdtempSync(join(tmpdir(), `laya-plan-${name}-`));
const settle = () => new Promise((r) => setImmediate(r));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// The shape Claude Code writes under `cachedUsageUtilization`, captured from a real Max account on
// 2026-09-30. The keys are the real ones; every value that could identify someone is invented.
const REAL_CACHE = {
  fetchedAtMs: 1790825394754,
  accountUuid: "00000000-0000-4000-8000-00000000aaaa",
  utilization: {
    five_hour: { utilization: 69, resets_at: "2026-10-01T05:29:59.689576+00:00", limit_dollars: null, used_dollars: null, remaining_dollars: null, locked_reason: null },
    seven_day: { utilization: 14, resets_at: "2026-10-01T06:59:59.689594+00:00", limit_dollars: null, used_dollars: null, remaining_dollars: null, locked_reason: null },
    seven_day_oauth_apps: null,
    seven_day_opus: null,
    seven_day_sonnet: null,
    iguana_necktie: { utilization: 0, resets_at: "2026-11-05T07:59:00+00:00", limit_dollars: 250, used_dollars: 0, remaining_dollars: 250, locked_reason: null },
    extra_usage: { is_enabled: false, monthly_limit: 4000, used_credits: 0, utilization: 0, currency: "USD" },
  },
};
const R5 = 1790832600000; // 2026-10-01T05:30:00Z, what the cache's 05:29:59.689 rounds to
const R7 = 1790838000000; // 2026-10-01T07:00:00Z

function config(home, cache, extra = {}) {
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ ...extra, ...(cache === undefined ? {} : { cachedUsageUtilization: cache }) }));
}
/** A cache of the real shape, fetched just now, saying 61%: what a probe that ran to the end could use. */
const freshCache = () => {
  const soon = (ms) => new Date(Date.now() + ms).toISOString();
  return { fetchedAtMs: Date.now(), utilization: { five_hour: { utilization: 61, resets_at: soon(3600_000) }, seven_day: { utilization: 9, resets_at: soon(3 * 86400_000) } } };
};
const withWindow = (name, w) => ({ ...REAL_CACHE, utilization: { ...REAL_CACHE.utilization, [name]: w } });

// ---------------------------------------------------------------- reading the cache

test("a real cache gives the two plan windows and when they were fetched", () => {
  const home = tmp("cache");
  config(home, REAL_CACHE);
  const got = readUsageCache({ env: {}, home });
  assert.equal(got.fetchedAt, 1790825394754);
  assert.deepEqual(got.windows, {
    "5h": { utilization: 0.69, resetsAt: R5 },
    "7d": { utilization: 0.14, resetsAt: R7 },
  });
});

test("the reset is to the second: the cache keeps fractions of one, the headers do not", () => {
  const home = tmp("round");
  config(home, REAL_CACHE);
  const { windows } = readUsageCache({ env: {}, home });
  assert.equal(windows["5h"].resetsAt % 1000, 0);
  // measured: the headers on a proxied turn said 1790832600 for this same window
  assert.equal(windows["5h"].resetsAt, 1790832600 * 1000);
});

test("only the two plan windows are read: a credit, or a model's own row, is not one", () => {
  const home = tmp("others");
  config(home, REAL_CACHE);
  assert.deepEqual(Object.keys(readUsageCache({ env: {}, home }).windows), ["5h", "7d"]);
});

test("nothing about the account comes out, though the same file holds it", () => {
  const home = tmp("private");
  config(home, REAL_CACHE, { oauthAccount: { emailAddress: "PERSONAL@example.com", accountUuid: "PERSONAL-UUID", organizationName: "Invented Studio" }, userID: "PERSONAL-ID" });
  const shown = JSON.stringify(readUsageCache({ env: {}, home }));
  for (const secret of ["PERSONAL", "Invented", "00000000-0000-4000", "oauth"]) assert.ok(!shown.includes(secret), secret);
});

test("the file is .claude.json in the home folder, or in CLAUDE_CONFIG_DIR when that is set", () => {
  const home = tmp("home");
  const other = tmp("other");
  // The decoy sits where one would wrongly look (measured: it is not inside ~/.claude/).
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", ".claude.json"), JSON.stringify({ cachedUsageUtilization: withWindow("five_hour", { ...REAL_CACHE.utilization.five_hour, utilization: 11 }) }));
  config(home, REAL_CACHE);
  assert.equal(readUsageCache({ env: {}, home }).windows["5h"].utilization, 0.69);
  config(other, withWindow("five_hour", { ...REAL_CACHE.utilization.five_hour, utilization: 33 }));
  assert.equal(readUsageCache({ env: { CLAUDE_CONFIG_DIR: other }, home }).windows["5h"].utilization, 0.33);
});

test("a relative CLAUDE_CONFIG_DIR means the folder the process is in, which is also what the child it starts means", () => {
  const dir = tmp("rel");
  config(dir, REAL_CACHE);
  assert.equal(readUsageCache({ env: { CLAUDE_CONFIG_DIR: relative(process.cwd(), dir) }, home: tmp("unused") }).windows["5h"].utilization, 0.69);
});

test("a missing, unreadable or shapeless config is no cache, never a guess", () => {
  const home = tmp("bad");
  assert.equal(readUsageCache({ env: {}, home }), null, "no file");
  writeFileSync(join(home, ".claude.json"), "not json");
  assert.equal(readUsageCache({ env: {}, home }), null, "not json");
  for (const [what, cache] of [
    ["no cache at all", undefined],
    ["an empty cache", {}],
    ["no time of fetch", { utilization: REAL_CACHE.utilization }],
    ["a time that is a string", { ...REAL_CACHE, fetchedAtMs: "soon" }],
    ["no figures", { fetchedAtMs: 1 }],
    ["figures that are not an object", { fetchedAtMs: 1, utilization: "69" }],
    ["figures that are a list", { fetchedAtMs: 1, utilization: [] }],
    ["a cache that is null", null],
  ]) {
    config(home, cache);
    assert.equal(readUsageCache({ env: {}, home }), null, what);
  }
});

test("a window is read only if its figure is a real, non-negative number", () => {
  const home = tmp("figure");
  const good = REAL_CACHE.utilization.seven_day;
  for (const [what, bad] of [["a string", "69"], ["null", null], ["negative", -1], ["an object", {}], ["a list", [69]], ["missing", undefined]]) {
    config(home, { ...REAL_CACHE, utilization: { five_hour: { ...REAL_CACHE.utilization.five_hour, utilization: bad }, seven_day: good } });
    assert.deepEqual(Object.keys(readUsageCache({ env: {}, home }).windows), ["7d"], `${what} drops that window and only that one`);
  }
  config(home, { ...REAL_CACHE, utilization: { five_hour: null, seven_day: null } });
  assert.equal(readUsageCache({ env: {}, home }), null, "with no window left there is no reading");
});

test("a figure too big to be a number is not read as one", () => {
  const home = tmp("huge");
  // JSON.parse turns 1e999 into Infinity, which is a number that is not finite.
  writeFileSync(join(home, ".claude.json"), '{"cachedUsageUtilization":{"fetchedAtMs":1,"utilization":{"five_hour":{"utilization":1e999,"resets_at":null},"seven_day":{"utilization":14,"resets_at":null}}}}');
  assert.deepEqual(Object.keys(readUsageCache({ env: {}, home }).windows), ["7d"]);
});

test("a figure is the percent turned into a fraction, as the headers give it, and going over is kept", () => {
  const home = tmp("scale");
  for (const [pct, want] of [[0, 0], [100, 1], [69, 0.69], [140, 1.4]]) {
    config(home, withWindow("five_hour", { ...REAL_CACHE.utilization.five_hour, utilization: pct }));
    assert.equal(readUsageCache({ env: {}, home }).windows["5h"].utilization, want, String(pct));
  }
});

test("a reset that is not a time drops its window, and no reset at all keeps it", () => {
  const home = tmp("reset");
  const five = REAL_CACHE.utilization.five_hour;
  for (const [what, resets_at] of [["words", "soon"], ["a number", 1790832600], ["an object", {}], ["absent", undefined]]) {
    config(home, withWindow("five_hour", { ...five, resets_at }));
    assert.deepEqual(Object.keys(readUsageCache({ env: {}, home }).windows), ["7d"], what);
  }
  config(home, withWindow("five_hour", { ...five, resets_at: null }));
  assert.deepEqual(readUsageCache({ env: {}, home }).windows["5h"], { utilization: 0.69, resetsAt: null }, "null is a window with no known end");
});

// ---------------------------------------------------------------- what counts as current

const cacheAt = (fetchedAt, windows = { "5h": { utilization: 0.4, resetsAt: R5 }, "7d": { utilization: 0.1, resetsAt: R7 } }) => ({ fetchedAt, windows });

test("a cache fetched a moment ago is current, and one fetched earlier is refused whole", () => {
  const now = R5 - 3600_000;
  assert.deepEqual(Object.keys(usableWindows(cacheAt(now - 5000), now)), ["5h", "7d"]);
  assert.ok(usableWindows(cacheAt(now - 90_000), now), "exactly the limit");
  assert.equal(usableWindows(cacheAt(now - 90_001), now), null, "this is what is served when Claude Code could not reach Anthropic");
  assert.equal(usableWindows(cacheAt(now - 3600_000), now), null);
});

test("a clock a few seconds out is not a reason to refuse a cache, and one far out is", () => {
  const now = R5 - 3600_000;
  assert.ok(usableWindows(cacheAt(now + 5000), now));
  assert.equal(usableWindows(cacheAt(now + 5001), now), null);
  assert.equal(usableWindows(cacheAt(now + 3600_000), now), null);
});

test("a window that cannot be the length it claims is dropped, in both directions", () => {
  const now = R5 - 3600_000;
  const fresh = (resetsAt) => usableWindows(cacheAt(now, { "5h": { utilization: 0.4, resetsAt } }), now);
  assert.ok(fresh(now + 3600_000), "an hour out is inside five");
  assert.equal(fresh(now + 21 * 86400_000), null, "a 5-hour window cannot reset in three weeks, and one that did would never end on screen");
  assert.equal(fresh(now - 600_000), null, "ten minutes ago: that window is over");
  assert.ok(fresh(now - 60_000), "a minute ago: a probe landing right at the roll is allowed");
  assert.deepEqual(fresh(null), { "5h": { utilization: 0.4, resetsAt: null } }, "no reset is a window with no known end");
});

test("one window that cannot be used does not take the other with it", () => {
  const now = R5 - 3600_000;
  const got = usableWindows(cacheAt(now, { "5h": { utilization: 0.4, resetsAt: now + 99 * 86400_000 }, "7d": { utilization: 0.1, resetsAt: now + 86400_000 } }), now);
  assert.deepEqual(Object.keys(got), ["7d"]);
});

test("no cache, or no usable window in it, is nothing", () => {
  assert.equal(usableWindows(null, 1), null);
  assert.equal(usableWindows(undefined, 1), null);
  const now = R7 + 3600_000;
  assert.equal(usableWindows(cacheAt(now), now), null, "both windows are over: the weekly one ends later than the 5-hour one");
});

// ---------------------------------------------------------------- the probe, against a stand-in

/** A machine with a stand-in `claude` whose behaviour the test sets between calls. */
function machine(t, scenario = {}, { seed } = {}) {
  const home = tmp("machine");
  const file = join(home, "scenario.json");
  writeFileSync(file, JSON.stringify(scenario));
  if (seed) config(home, seed);
  const lines = (name) => { try { return readFileSync(join(home, name), "utf8").split("\n").filter(Boolean); } catch { return []; } };
  return {
    home,
    env: { PATH: "/usr/bin:/bin", HOME: home, USER: "someone", FAKE_USAGE_SCENARIO: file, FAKE_USAGE_ENVLOG: join(home, "env.log"), FAKE_CLAUDE_LOG: join(home, "calls.log") },
    set: (s) => writeFileSync(file, JSON.stringify(s)),
    calls: () => lines("calls.log"),
    given: () => lines("env.log").map((l) => JSON.parse(l)),
    probe: (over = {}) => readPlanUsage({ env: { PATH: "/usr/bin:/bin", HOME: home, USER: "someone", FAKE_USAGE_SCENARIO: file, FAKE_USAGE_ENVLOG: join(home, "env.log"), FAKE_CLAUDE_LOG: join(home, "calls.log"), ...over.env }, home, bin: FAKE, ...over.options }),
  };
}

test("a probe that reaches Anthropic returns the cache's figures, not the text it printed", async (t) => {
  // The stand-in prints 99% in its text on purpose. A reader of the text would show that.
  const m = machine(t, { five: 42, week: 12 });
  const got = await m.probe();
  assert.equal(got.state, "ok");
  assert.equal(got.windows["5h"].utilization, 0.42);
  assert.equal(got.windows["7d"].utilization, 0.12);
  assert.ok(Date.now() - got.fetchedAt < 5000, "and it is a fetch from just now");
});

test("a probe that could not reach Anthropic is stale, whatever figure the cache still holds", async (t) => {
  // The trap. Offline, Claude Code leaves its cache as it was and the command still prints the old
  // figure and exits 0, saying nothing. Here the old figure is 77, ten minutes old.
  const m = machine(t, { fetch: false }, { seed: withWindow("five_hour", { ...REAL_CACHE.utilization.five_hour, utilization: 77, resets_at: new Date(Date.now() + 3600_000).toISOString() }) });
  const stale = JSON.parse(readFileSync(join(m.home, ".claude.json"), "utf8"));
  stale.cachedUsageUtilization.fetchedAtMs = Date.now() - 600_000;
  writeFileSync(join(m.home, ".claude.json"), JSON.stringify(stale));
  const got = await m.probe();
  assert.equal(got.state, "stale");
  assert.equal(got.windows, undefined, "the 77 does not come out");
});

test("nothing ever fetched, and no cache at all, is unreadable", async (t) => {
  const m = machine(t, { fetch: false });
  assert.equal((await m.probe()).state, "unreadable");
});

test("windows that are already over by the time they are read are not a reading", async (t) => {
  const m = machine(t, { fiveInMs: -3600_000, weekInMs: -3600_000 });
  assert.equal((await m.probe()).state, "stale");
  m.set({ fiveInMs: -3600_000, weekInMs: 86400_000 });
  const got = await m.probe();
  assert.deepEqual(Object.keys(got.windows), ["7d"]);
});

test("the one variable that makes the real probe serve its cache is taken out, even when the person has it set", async (t) => {
  // Measured: with CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 the real probe's cache timestamp did
  // not move. The stand-in behaves the same, so a probe that left it in would come back stale.
  const m = machine(t, {});
  const got = await m.probe({ env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" } });
  assert.equal(got.state, "ok");
  assert.equal(m.given().at(-1).quiet, null, "the child was not given it");
});

test("the probe is told what it is told: telemetry and error reports off, and exactly these arguments", async (t) => {
  const m = machine(t, {});
  await m.probe();
  assert.equal(m.given().at(-1).telemetry, "1");
  assert.equal(m.given().at(-1).errors, "1");
  assert.deepEqual([...USAGE_ARGS], [
    "-p", "/usage", "--output-format", "json", "--no-session-persistence",
    "--strict-mcp-config", "--setting-sources", "user", "--settings", '{"disableAllHooks":true}',
  ]);
  assert.equal(m.calls().at(-1), USAGE_ARGS.join(" "));
  assert.ok(!USAGE_ARGS.includes("--bare"), "--bare reads no OAuth, so the plan could not be read at all");
});

test("a missing USER is filled in, because Claude Code reads a missing one as signed out", async (t) => {
  const m = machine(t, {});
  const env = { ...m.env };
  delete env.USER;
  await readPlanUsage({ env, home: m.home, bin: FAKE });
  assert.equal(m.given().at(-1).user, userInfo().username);
  await readPlanUsage({ env: { ...env, USER: "someone" }, home: m.home, bin: FAKE });
  assert.equal(m.given().at(-1).user, "someone", "one that is set is never replaced");
});

test("no Claude Code is 'missing', and nothing is started", async () => {
  assert.deepEqual(await readPlanUsage({ env: { PATH: "/nonexistent" }, home: tmp("nocl"), system: [], bin: null }), { state: "missing" });
});

test("a Claude Code that cannot start, hangs, or floods is unreadable and never a crash", async (t) => {
  // Each one is given a fresh cache to be tempted by. A probe that did not run to the end must not
  // have its answer taken from whatever happens to be on disk.
  const dir = tmp("broken");
  config(dir, freshCache());
  const noexec = join(dir, "claude");
  writeFileSync(noexec, "#!/bin/sh\nexit 0\n");
  chmodSync(noexec, 0o644);
  assert.equal((await readPlanUsage({ env: {}, home: dir, bin: noexec })).state, "unreadable", "not executable");

  const m = machine(t, { hangMs: 5000 }, { seed: freshCache() });
  const t0 = Date.now();
  assert.equal((await m.probe({ options: { timeoutMs: 400 } })).state, "unreadable", "a hang ends at the deadline");
  assert.ok(Date.now() - t0 < 3500, "and does not wait out the hang");

  const flood = join(dir, "flood");
  writeFileSync(flood, "#!/bin/sh\nwhile true; do echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; done\n");
  chmodSync(flood, 0o755);
  assert.equal((await readPlanUsage({ env: {}, home: dir, bin: flood, timeoutMs: 6000 })).state, "unreadable", "a flood is cut off");

  const killed = join(dir, "killed");
  writeFileSync(killed, "#!/bin/sh\nkill -9 $$\n");
  chmodSync(killed, 0o755);
  assert.equal((await readPlanUsage({ env: {}, home: dir, bin: killed })).state, "unreadable", "killed by a signal");
});

test("a non-zero exit that still left a fresh cache is read: the cache decides, not the exit code", async (t) => {
  const m = machine(t, { exitCode: 1 });
  assert.equal((await m.probe()).state, "ok");
});

// ---------------------------------------------------------------- what is kept from before

const BEFORE = Object.freeze({
  windows: Object.freeze({ "5h": Object.freeze({ utilization: 0.5, resetsAt: R5, status: "allowed_warning" }), "7d": Object.freeze({ utilization: 0.1, resetsAt: R7, status: "allowed" }) }),
  status: "allowed",
  representative: "5h",
  resetsAt: R5,
  overage: Object.freeze({ status: "rejected", reason: "out_of_credits" }),
  fallbackPct: 0.5,
});
const reading = (windows) => ({ state: "ok", windows, fetchedAt: 1 });

test("anything that is not a recent reading adds nothing", () => {
  for (const r of [{ state: "stale" }, { state: "missing" }, { state: "unreadable" }, { state: "ok-ish" }, {}, null, undefined]) {
    assert.equal(foldPlanReading(BEFORE, r), null, JSON.stringify(r));
  }
});

test("what only the headers know is carried over, not erased: an unknown is not a no", () => {
  const got = foldPlanReading(BEFORE, reading({ "5h": { utilization: 0.55, resetsAt: R5 - 311 }, "7d": { utilization: 0.11, resetsAt: R7 } }));
  assert.equal(got.windows["5h"].utilization, 0.55, "the figure is the newer one");
  assert.equal(got.windows["5h"].status, "allowed_warning", "this window's own status, because it is still this window");
  assert.equal(got.status, "allowed");
  assert.equal(got.representative, "5h");
  assert.equal(got.resetsAt, R5);
  assert.deepEqual(got.overage, { status: "rejected", reason: "out_of_credits" });
  assert.equal(got.fallbackPct, 0.5);
});

test("with nothing known before, nothing is claimed", () => {
  const got = foldPlanReading(null, reading({ "5h": { utilization: 0.4, resetsAt: R5 } }));
  assert.deepEqual(got, { windows: { "5h": { utilization: 0.4, resetsAt: R5, status: null } }, status: null, representative: null, resetsAt: null, overage: null, fallbackPct: null });
});

test("a window the reading lacks is not invented, and the one before is not touched", () => {
  const got = foldPlanReading(BEFORE, reading({ "7d": { utilization: 0.2, resetsAt: R7 } }));
  assert.deepEqual(Object.keys(got.windows), ["7d"]);
  assert.equal(BEFORE.windows["5h"].utilization, 0.5, "what was kept before is as it was");
});

test("a status is carried only while it is the same window: a new window is not blocked because the old one was", () => {
  const blocked = { windows: { "5h": { utilization: 1, resetsAt: R5, status: "rejected" } }, status: "rejected", representative: "5h", resetsAt: R5, overage: { status: "rejected", reason: "out_of_credits" }, fallbackPct: null };
  const got = foldPlanReading(blocked, reading({ "5h": { utilization: 0.03, resetsAt: R5 + 4.5 * 3600_000 } }));
  assert.equal(got.windows["5h"].status, null, "the new window has no status of its own yet");
  assert.equal(got.status, null, "and the overall one was about the window that ended");
  assert.equal(got.representative, null);
  assert.equal(got.resetsAt, null);
  assert.deepEqual(got.overage, { status: "rejected", reason: "out_of_credits" }, "overage is the account's, not a window's, so it stays");
});

test("the overall status stays when the window it was about did not roll, even if another did", () => {
  const got = foldPlanReading(BEFORE, reading({ "5h": { utilization: 0.5, resetsAt: R5 }, "7d": { utilization: 0.01, resetsAt: R7 + 7 * 86400_000 } }));
  assert.equal(got.status, "allowed");
  assert.equal(got.representative, "5h");
  assert.equal(got.windows["7d"].status, null, "the weekly window did roll, so its status does not follow it");
});

test("end to end: the window rolls while nothing is going through Laya, and no false limit alert is raised", () => {
  // The limit is hit and announced. Then the window ends, the account is fresh, and the probe is
  // the only thing that notices. A status carried over blindly would mark the new window blocked
  // and announce a limit that is no longer true.
  let t = R5 - 600_000;
  const alerts = createAlerts({ file: join(tmp("alerts"), "alerts.json"), now: () => t });
  const prefs = { enabled: true, thresholds: [75, 90], limit: true, reset: true, pace: false, windows: { fiveHour: true, weekly: true } };
  let limits = mergeLimits(null, { windows: { "5h": { utilization: 1, resetsAt: R5, status: "rejected" } }, status: "rejected", representative: "5h", resetsAt: R5, overage: null, fallbackPct: null }, t);
  assert.deepEqual(alerts.evaluate({ limits, prefs }).map((a) => a.kind), ["limit"]);

  t = R5 + 60_000;
  limits = mergeLimits(limits, foldPlanReading(limits, reading({ "5h": { utilization: 0.03, resetsAt: R5 + 4.5 * 3600_000 } })), t);
  assert.deepEqual(alerts.evaluate({ limits, prefs }).map((a) => a.kind), ["reset"], "the reset is announced, and no second limit");
});

// ---------------------------------------------------------------- how often

test("the pace is five minutes unless it is asked for, and off means off", () => {
  assert.equal(planTickMs(undefined), DEFAULT_TICK_MS);
  assert.equal(DEFAULT_TICK_MS, 300_000);
  assert.equal(planTickMs(""), DEFAULT_TICK_MS, "an empty value in ~/.laya-router.env is easy to leave behind");
  assert.equal(planTickMs("60000"), 60_000);
  assert.equal(planTickMs(" 90000 "), 90_000);
  assert.equal(planTickMs(120_000), 120_000, "a number is read as one");
  for (const off of ["off", "0", "no", "false", "none", "OFF", " Off "]) assert.equal(planTickMs(off), null, JSON.stringify(off));
});

test("a pace Node cannot hold, or that would spin, falls back to the default", () => {
  // Node turns a timer past 2^31-1 ms, and one of 0, into a 1 ms timer, and each tick starts a process.
  for (const bad of ["10", "49", "9007199254740991", "soon", "-5", "NaN", "Infinity", "5e99"]) assert.equal(planTickMs(bad), DEFAULT_TICK_MS, bad);
  for (const odd of [{}, [], [60000], null, true]) assert.equal(planTickMs(odd), DEFAULT_TICK_MS, `${JSON.stringify(odd)}: Number() would have turned this into one`);
  assert.equal(planTickMs("50"), 50);
  assert.equal(planTickMs(String(2 ** 31 - 1)), 2 ** 31 - 1);
  assert.equal(planTickMs(String(2 ** 31)), DEFAULT_TICK_MS);
});

// ---------------------------------------------------------------- the loop

/** A scheduler the test drives by hand, so nothing waits on a clock. */
function clock() {
  const pending = [];
  const cleared = [];
  return {
    pending, cleared,
    setTimer: (fn, ms) => { const h = { fn, ms, unrefd: false, unref() { this.unrefd = true; } }; pending.push(h); return h; },
    clearTimer: (h) => cleared.push(h),
    fire: async () => { const h = pending.shift(); h.fn(); await settle(); return h; },
  };
}
const ok = () => ({ state: "ok", windows: {}, fetchedAt: 1 });

test("the first probe is made at once, not after a wait", () => {
  const c = clock();
  let probes = 0;
  watchPlanUsage({ read: async () => { probes++; return ok(); }, onReading: () => {}, ...c });
  assert.equal(probes, 1, "the person who just opened the app is the one waiting for it");
});

test("the next probe is scheduled only after the last finished, at the pace asked for, and never overlaps", async () => {
  const c = clock();
  let release;
  let probes = 0;
  const seen = [];
  watchPlanUsage({ read: () => new Promise((r) => { probes++; release = () => r({ ...ok(), n: probes }); }), onReading: (r) => seen.push(r.n), every: 40_000, ...c });
  await settle();
  assert.equal(c.pending.length, 0, "nothing is scheduled while a probe is running, so two can never run together");
  release();
  await settle();
  assert.deepEqual(seen, [1]);
  assert.deepEqual(c.pending.map((h) => h.ms), [40_000]);
  await c.fire();
  assert.equal(probes, 2);
  release();
  await settle();
  assert.deepEqual(seen, [1, 2], "in order");
});

test("a pending probe never holds the process open", async () => {
  const c = clock();
  watchPlanUsage({ read: async () => ok(), onReading: () => {}, ...c });
  await settle();
  assert.equal(c.pending[0].unrefd, true);
});

test("nobody signed in means no process at all, a look again soon, and a probe the moment someone is", async () => {
  const c = clock();
  let probes = 0;
  let signedIn = false;
  watchPlanUsage({ read: async () => { probes++; return ok(); }, onReading: () => {}, enabled: () => signedIn, every: 300_000, recheckMs: 1000, ...c });
  await settle();
  assert.equal(probes, 0);
  assert.deepEqual(c.pending.map((h) => h.ms), [1000], "a flag check every second, not a process every five minutes");
  await c.fire();
  assert.equal(probes, 0);
  signedIn = true;
  await c.fire();
  assert.equal(probes, 1);
  assert.deepEqual(c.pending.map((h) => h.ms), [300_000], "and then the normal pace");
});

test("looking again never waits longer than the pace itself", async () => {
  const c = clock();
  watchPlanUsage({ read: async () => ok(), onReading: () => {}, enabled: () => false, every: 200, recheckMs: 1000, ...c });
  await settle();
  assert.deepEqual(c.pending.map((h) => h.ms), [200]);
});

test("a probe that throws is reported and the loop carries on", async () => {
  const c = clock();
  const errors = [];
  watchPlanUsage({ read: async () => { throw new Error("boom"); }, onReading: () => {}, onError: (e) => errors.push(e.message), every: 5000, ...c });
  await settle();
  assert.deepEqual(errors, ["boom"]);
  assert.deepEqual(c.pending.map((h) => h.ms), [5000]);
});

test("a handler that throws is reported and the loop carries on", async () => {
  const c = clock();
  const errors = [];
  watchPlanUsage({ read: async () => ok(), onReading: () => { throw new Error("handler"); }, onError: (e) => errors.push(e.message), every: 5000, ...c });
  await settle();
  assert.deepEqual(errors, ["handler"]);
  assert.equal(c.pending.length, 1);
});

test("after stop() nothing is delivered, and nothing is scheduled behind an answer that arrives late", async () => {
  const c = clock();
  let release;
  const seen = [];
  const stop = watchPlanUsage({ read: () => new Promise((r) => { release = () => r(ok()); }), onReading: (r) => seen.push(r), onError: (e) => seen.push(e), ...c });
  stop();
  release();
  await settle();
  assert.deepEqual(seen, [], "asked before stop() and answered after it: not wanted any more");
  assert.equal(c.pending.length, 0);
});

test("a probe that fails after stop() is not reported either: the person who stopped it is gone", async () => {
  const c = clock();
  let fail;
  const seen = [];
  const stop = watchPlanUsage({ read: () => new Promise((_, reject) => { fail = () => reject(new Error("late")); }), onReading: (r) => seen.push(r), onError: (e) => seen.push(e), ...c });
  stop();
  fail();
  await settle();
  assert.deepEqual(seen, [], "neither an answer nor a failure reaches a handler that was told to stop");
  assert.equal(c.pending.length, 0);
});

test("stop() clears the probe that was waiting, and stopping twice is harmless", async () => {
  const c = clock();
  let probes = 0;
  const stop = watchPlanUsage({ read: async () => { probes++; return ok(); }, onReading: () => {}, ...c });
  await settle();
  const waiting = c.pending[0];
  const before = probes;
  stop();
  stop();
  assert.ok(c.cleared.includes(waiting));
  waiting.fn();
  await settle();
  assert.equal(probes, before, "a timer that had already fired when stop() was called starts no probe");
  assert.equal(c.pending.length, 1, "and schedules nothing");
});

test("stop() from inside a reading ends it there", async () => {
  const c = clock();
  let stop;
  const seen = [];
  stop = watchPlanUsage({ read: async () => ok(), onReading: (r) => { seen.push(r.state); stop(); }, ...c });
  await settle();
  assert.deepEqual(seen, ["ok"]);
  assert.equal(c.pending.length, 0, "nothing scheduled after a handler stopped it");
});

test("on a real clock it keeps its pace, and stops when told", async () => {
  let probes = 0;
  const stop = watchPlanUsage({ read: async () => { probes++; return ok(); }, onReading: () => {}, every: 60 });
  await pause(330);
  stop();
  const at = probes;
  assert.ok(at >= 3 && at <= 7, `${at} probes in 330 ms at a 60 ms pace`);
  await pause(200);
  assert.equal(probes, at, "none after stop()");
});

// ---------------------------------------------------------------- what the log says
//
// The usage check runs every five minutes for as long as the daemon lives. A missed poll used to leave
// no trace, so a figure that went missing could not be explained afterwards. The log gets one line when
// what a probe finds changes, and none while it stays the same.

test("the first probe is written down, and a repeat of the same result is not", () => {
  const note = createPollNotes();
  assert.equal(note("ok"), "plan usage: reading ok");
  for (let i = 0; i < 50; i++) assert.equal(note("ok"), null, `poll ${i + 2}: nothing new to say`);
});

test("a change is written down, in a sentence for each way a probe can end", () => {
  const note = createPollNotes();
  note("ok");
  assert.match(note("stale"), /^plan usage: Claude Code had nothing fresh to give \(offline, or signed in with an API key/);
  assert.equal(note("missing"), "plan usage: Claude Code was not found");
  assert.equal(note("unreadable"), "plan usage: Claude Code's usage check did not finish, or left nothing to read");
  assert.equal(note("ok"), "plan usage: reading ok", "and the recovery is written down too");
});

test("a failure with a reason is written down once per reason", () => {
  const note = createPollNotes();
  assert.equal(note("error", "spawn EMFILE"), "plan usage: the check failed: spawn EMFILE");
  assert.equal(note("error", "spawn EMFILE"), null, "the same failure again is not news");
  assert.equal(note("error", "spawn ENOMEM"), "plan usage: the check failed: spawn ENOMEM", "a different one is");
  assert.equal(note("ok"), "plan usage: reading ok");
  assert.equal(note("error", "spawn ENOMEM"), "plan usage: the check failed: spawn ENOMEM", "and one that comes back after a success is news again");
});

test("a reason is one short line, whatever the error looked like", () => {
  const note = createPollNotes();
  const line = note("error", `first line\nsecond line\n${"x".repeat(500)}`);
  assert.equal(line, "plan usage: the check failed: first line");
  assert.ok(!note("error", "y".repeat(500)).includes("y".repeat(201)), "a long one is cut");
});

test("a state nobody planned for is still written down, shortened, and once", () => {
  const note = createPollNotes();
  assert.equal(note("something-new"), "plan usage: something-new");
  assert.equal(note("something-new"), null);
  assert.equal(note(undefined), "plan usage: undefined", "a reading with no state is a state too");
  assert.ok(note("z".repeat(200)).length <= "plan usage: ".length + 40);
});


// ---------------------------------------------------------------- what the loop is handed

/** The handlers wired to a log and an ingest that both just record what they are given. */
function handlers() {
  const log = [];
  const ingested = [];
  const h = planPollHandlers({ ingest: (r) => ingested.push(r), log: (line) => log.push(line) });
  return { ...h, log, ingested };
}

test("a reading is written down by what it found, and then handed on whole", () => {
  const h = handlers();
  const reading = { state: "ok", windows: { "5h": { utilization: 0.4 } } };
  h.onReading(reading);
  assert.deepEqual(h.log, ["plan usage: reading ok"]);
  assert.deepEqual(h.ingested, [reading], "the very object, so nothing is lost on the way");
});

test("the same result again is handed on every time but written down once", () => {
  const h = handlers();
  for (let i = 0; i < 5; i++) h.onReading({ state: "stale" });
  assert.equal(h.log.length, 1, "one line for five identical probes");
  assert.equal(h.ingested.length, 5, "and every reading still reached the ingest");
});

test("a probe that threw is written down with its reason, once, and hands nothing on", () => {
  const h = handlers();
  h.onError(new Error("spawn E2BIG"));
  h.onError(new Error("spawn E2BIG"));
  assert.deepEqual(h.log, ["plan usage: the check failed: spawn E2BIG"]);
  assert.deepEqual(h.ingested, [], "an error is not a reading");
});

test("something thrown that is not an Error is still written down", () => {
  const h = handlers();
  h.onError("a bare string");
  h.onError(undefined);
  assert.deepEqual(h.log, ["plan usage: the check failed: a bare string", "plan usage: the check failed: undefined"]);
});

test("a reading with no state is written down as one, and still handed on", () => {
  const h = handlers();
  h.onReading(undefined);
  assert.deepEqual(h.log, ["plan usage: undefined"]);
  assert.deepEqual(h.ingested, [undefined]);
});

test("the log line is written before the reading is ingested, so a failing ingest cannot lose it", () => {
  const log = [];
  const h = planPollHandlers({ ingest: () => { throw new Error("ingest broke"); }, log: (l) => log.push(l) });
  assert.throws(() => h.onReading({ state: "ok" }), /ingest broke/, "the loop sees the throw, as it should, and reports it");
  assert.deepEqual(log, ["plan usage: reading ok"], "but what the probe found was written first");
});

test("the loop given these handlers writes a failed ingest down as a failed check", async () => {
  const log = [];
  const h = planPollHandlers({ ingest: () => { throw new Error("ingest broke"); }, log: (l) => log.push(l) });
  let stop;
  await new Promise((done) => {
    stop = watchPlanUsage({
      read: async () => ({ state: "ok", windows: {} }),
      onReading: h.onReading,
      onError: (err) => { h.onError(err); done(); },
      every: 600000,
    });
  });
  stop();
  assert.deepEqual(log, ["plan usage: reading ok", "plan usage: the check failed: ingest broke"]);
});

test("a probe that throws for real is written down: a process whose environment is too big to start", async () => {
  // Measured: execFile throws E2BIG synchronously for an environment this large, rather than reporting
  // it through its callback, so readPlanUsage rejects and the loop's error handler is the only witness.
  const log = [];
  const h = planPollHandlers({ ingest: () => {}, log: (l) => log.push(l) });
  let stop;
  await new Promise((done) => {
    stop = watchPlanUsage({
      read: () => readPlanUsage({ bin: "/usr/bin/true", env: { ...process.env, HUGE: "x".repeat(2_000_000) } }),
      onReading: h.onReading,
      onError: (err) => { h.onError(err); done(); },
      every: 600000,
    });
  });
  stop();
  assert.equal(log.length, 1);
  assert.match(log[0], /^plan usage: the check failed: spawn E2BIG/);
});
