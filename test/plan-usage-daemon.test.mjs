// What the menu bar and the panel hold on a machine where nothing is going through Laya.
//
// Until now the plan's usage was learned only from responses that passed through the proxy. On a
// new machine that is never, and on any machine the last reading's window ends within five hours:
// a real Mac (2026-10-01) held a reading 13 hours old, every window in it over, and showed a dash
// while the account sat at 26%. The daemon now also asks Claude Code, on a timer, once someone is
// signed in. These tests run a real daemon against a stand-in Claude Code that behaves as the real
// one was measured to (test/fixtures/fake-claude-usage.mjs), and send no turn unless the test says so.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callDaemon, freePort, wait, waitFor } from "./helpers.mjs";

const REPO = new URL("..", import.meta.url).pathname;
const DAEMON = join(REPO, "src", "daemon.mjs");
const FAKE = join(REPO, "test", "fixtures", "fake-claude-usage.mjs");

/** A usage cache of the real shape that was fetched `agoMs` ago and still says `pct`. */
const oldCache = (pct, agoMs) => ({
  fetchedAtMs: Date.now() - agoMs,
  accountUuid: "PERSONAL-UUID",
  utilization: {
    five_hour: { utilization: pct, resets_at: new Date(Date.now() + 3600_000).toISOString() },
    seven_day: { utilization: 5, resets_at: new Date(Date.now() + 3 * 86400_000).toISOString() },
  },
});

async function boot(t, { scenario = {}, tick = "250", seed = null, headers = {}, claudeBin = FAKE, accountTick = "100" } = {}) {
  const home = mkdtempSync(join(tmpdir(), "laya-plan-"));
  const scenarioFile = join(home, "scenario.json");
  const log = join(home, "claude-calls.log");
  writeFileSync(scenarioFile, JSON.stringify(scenario));
  writeFileSync(log, "");
  if (seed) writeFileSync(join(home, ".claude.json"), JSON.stringify({ cachedUsageUtilization: seed }));

  // A stand-in for Anthropic for the tests that do send a turn. Its headers can be changed between turns.
  const up = { headers };
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      for (const [k, v] of Object.entries(up.headers)) res.setHeader(k, v);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "message", model: "claude-sonnet-5-5", content: [], usage: { input_tokens: 5, output_tokens: 5 } }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());

  const control = await freePort();
  const child = spawn(process.execPath, [DAEMON], {
    env: {
      PATH: "/usr/bin:/bin", HOME: home, LAYA_HOME: join(home, ".laya-router"), LAYA_TOKEN: "t",
      LAYA_CONTROL_PORT: String(control), LAYA_CLAUDE_PROXY_PORT: "0",
      LAYA_CLAUDE_UPSTREAM: `http://127.0.0.1:${server.address().port}`, LAYA_PYTHON: "/usr/bin/false",
      LAYA_CLAUDE_BIN: claudeBin, FAKE_USAGE_SCENARIO: scenarioFile, FAKE_CLAUDE_LOG: log,
      LAYA_ACCOUNT_TICK_MS: accountTick, LAYA_PLAN_TICK_MS: tick,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (c) => (stderr += c));
  t.after(() => child.kill("SIGKILL"));
  await waitFor(async () => (await callDaemon(control, "ping")).result, "the daemon");

  const snap = async () => (await callDaemon(control, "snapshot")).result;
  return {
    home, snap, up, control,
    set: (s) => writeFileSync(scenarioFile, JSON.stringify(s)),
    calls: () => readFileSync(log, "utf8").split("\n").filter(Boolean),
    probes: () => readFileSync(log, "utf8").split("\n").filter((c) => c.startsWith("-p /usage")).length,
    ask: async () => {
      const port = await waitFor(async () => (await snap()).engines.claude.port, "the proxy");
      const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: "claude-sonnet-5-5", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }),
      });
      await res.text();
      await wait(80);
    },
    get stderr() { return stderr; },
  };
}

const figure = (d, window) => async () => {
  const l = (await d.snap()).limits;
  return l?.windows?.[window] ? l : null;
};

test("the figure is there with no turn ever sent through Laya", async (t) => {
  const d = await boot(t, { scenario: { five: 42, week: 12 } });
  const limits = await waitFor(figure(d, "5h"), "a 5-hour figure with nothing routed");
  assert.equal(limits.windows["5h"].utilization, 0.42);
  assert.equal(limits.windows["7d"].utilization, 0.12);
  const s = await d.snap();
  assert.equal(s.usage.all.n, 0, "no turn went through the router");
  assert.deepEqual([...new Set(d.calls())].filter((c) => c !== "auth status"), ["-p /usage --output-format json --no-session-persistence --strict-mcp-config --setting-sources user --settings {\"disableAllHooks\":true}"],
    "the only things run were the sign-in check and the probe");
});

test("it is the cache's figure that is shown, not the text the command printed", async (t) => {
  // The stand-in prints 99% in its text on purpose.
  const d = await boot(t, { scenario: { five: 31, week: 7 } });
  const limits = await waitFor(figure(d, "5h"), "a figure");
  assert.notEqual(Math.round(limits.windows["5h"].utilization * 100), 99);
  assert.equal(Math.round(limits.windows["5h"].utilization * 100), 31);
});

test("it keeps asking at its pace, so the figure follows the account", async (t) => {
  const d = await boot(t, { scenario: { five: 20 }, tick: "150" });
  await waitFor(async () => (await figure(d, "5h")())?.windows["5h"].utilization === 0.2, "20%");
  d.set({ five: 55, week: 12 });
  const after = await waitFor(async () => { const l = await figure(d, "5h")(); return l?.windows["5h"].utilization === 0.55 ? l : null; }, "the figure to follow");
  assert.equal(after.windows["5h"].utilization, 0.55);
  assert.ok(d.probes() >= 2);
});

test("a figure from a probe can raise an alert with no turn at all", async (t) => {
  const d = await boot(t, { scenario: { five: 80 } });
  const alerts = await waitFor(async () => { const a = (await d.snap()).alerts; return a.length ? a : null; }, "an alert from the probe's figure alone");
  assert.deepEqual(alerts.map((a) => [a.kind, a.threshold, a.window]), [["threshold", 75, "5h"]]);
  await wait(700);
  assert.equal((await d.snap()).alerts.length, 1, "and it is raised once, not on every probe");
});

test("a probe that only got Claude Code's old cache is refused, and no figure is made up", async (t) => {
  // Offline, Claude Code leaves its cache as it was and the command still prints the old figure and
  // exits 0, saying nothing. Here the old figure is 77, ten minutes old.
  const d = await boot(t, { scenario: { fetch: false }, seed: oldCache(77, 10 * 60_000) });
  await waitFor(() => d.probes() >= 2, "several probes");
  assert.equal((await d.snap()).limits, null, "the 77 never reaches the app");
});

test("when the network comes back the figure appears on the next probe", async (t) => {
  const d = await boot(t, { scenario: { fetch: false }, seed: oldCache(77, 10 * 60_000), tick: "150" });
  await waitFor(() => d.probes() >= 2, "probes while offline");
  assert.equal((await d.snap()).limits, null);
  d.set({ fetch: true, five: 35, week: 6 });
  const limits = await waitFor(figure(d, "5h"), "the figure once online");
  assert.equal(limits.windows["5h"].utilization, 0.35);
});

test("a machine that is signed out is never probed: no process is started for someone who cannot use it", async (t) => {
  const d = await boot(t, { scenario: { signedOut: true }, tick: "100" });
  await waitFor(async () => (await d.snap()).account?.state === "signed-out", "a signed-out answer");
  await wait(700);
  assert.deepEqual([...new Set(d.calls())], ["auth status"]);
  assert.equal((await d.snap()).limits, null);
});

test("signing in starts it: the figure appears with no restart and no turn", async (t) => {
  const d = await boot(t, { scenario: { signedOut: true, five: 61, week: 9 }, tick: "100" });
  await waitFor(async () => (await d.snap()).account?.state === "signed-out", "signed out");
  assert.equal(d.probes(), 0);
  d.set({ signedOut: false, five: 61, week: 9 });
  const limits = await waitFor(figure(d, "5h"), "a figure after signing in", 30000);
  assert.equal(limits.windows["5h"].utilization, 0.61);
});

test("it can be switched off, and then nothing but the sign-in check ever runs", async (t) => {
  const d = await boot(t, { scenario: { five: 42 }, tick: "off" });
  await waitFor(async () => (await d.snap()).account?.state === "signed-in", "signed in");
  await wait(700);
  assert.deepEqual([...new Set(d.calls())], ["auth status"]);
  assert.equal((await d.snap()).limits, null);
});

test("a Claude Code that is not there leaves the daemon answering and the figure empty", async (t) => {
  const d = await boot(t, { claudeBin: join(tmpdir(), "nowhere", "claude") });
  await waitFor(async () => (await d.snap()).account?.state === "missing", "missing");
  await wait(500);
  assert.equal((await d.snap()).limits, null);
  assert.equal((await callDaemon(d.control, "ping")).result.pong, true, "still answering");
});

test("what only the response headers know survives a probe", async (t) => {
  // The probe reports figures. Which window is blocked, which is binding, and whether overage was
  // refused come from headers, and a probe that did not know them must not wipe them.
  const reset = Math.floor(Date.now() / 1000) + 3600;
  const d = await boot(t, {
    scenario: { fetch: false },
    headers: {
      "anthropic-ratelimit-unified-5h-utilization": "0.5",
      "anthropic-ratelimit-unified-5h-reset": String(reset),
      "anthropic-ratelimit-unified-5h-status": "allowed_warning",
      "anthropic-ratelimit-unified-status": "allowed",
      "anthropic-ratelimit-unified-representative-claim": "five_hour",
      "anthropic-ratelimit-unified-overage-status": "rejected",
    },
  });
  await d.ask();
  const before = (await d.snap()).limits;
  assert.equal(before.status, "allowed");
  assert.equal(before.windows["5h"].status, "allowed_warning");

  d.set({ fetch: true, five: 55, week: 8, fiveAtMs: reset * 1000 });
  const after = await waitFor(async () => { const l = await figure(d, "5h")(); return l?.windows["5h"].utilization === 0.55 ? l : null; }, "the probe's figure");
  assert.equal(after.windows["5h"].status, "allowed_warning", "the window is the same one, so its status stays");
  assert.equal(after.status, "allowed");
  assert.equal(after.representative, "5h");
  assert.deepEqual(after.overage, { status: "rejected", reason: null });
  assert.equal(after.windows["5h"].resetsAt, reset * 1000, "and it is still one window, not two a second apart");
});

test("a new window is not marked blocked because the one before it was", async (t) => {
  const reset = Math.floor(Date.now() / 1000) + 600;
  const d = await boot(t, {
    scenario: { fetch: false },
    headers: {
      "anthropic-ratelimit-unified-5h-utilization": "1",
      "anthropic-ratelimit-unified-5h-reset": String(reset),
      "anthropic-ratelimit-unified-5h-status": "rejected",
      "anthropic-ratelimit-unified-status": "rejected",
      "anthropic-ratelimit-unified-representative-claim": "five_hour",
    },
  });
  await d.ask();
  const blocked = await waitFor(async () => { const s = await d.snap(); return s.alerts.some((a) => a.kind === "limit") ? s : null; }, "the limit alert");
  assert.equal(blocked.limits.status, "rejected");

  // The account has a fresh window now: a different reset, almost nothing used.
  d.set({ fetch: true, five: 3, week: 8, fiveAtMs: reset * 1000 + 4.5 * 3600_000 });
  const after = await waitFor(async () => { const l = await figure(d, "5h")(); return l?.windows["5h"].utilization === 0.03 ? l : null; }, "the new window");
  assert.equal(after.windows["5h"].status, null);
  assert.equal(after.status, null, "the overall status was about the window that ended");
  assert.equal(after.representative, null);
  await wait(500);
  const s = await d.snap();
  assert.equal(s.alerts.filter((a) => a.kind === "limit").length, 1, "no second limit alert for a limit that is over");
});

test("the file kept between runs holds figures only, nothing that identifies the account", async (t) => {
  // The stand-in writes an account id into the config file the probe reads, as the real one does.
  const d = await boot(t, { scenario: { five: 42 } });
  await waitFor(figure(d, "5h"), "a figure");
  await wait(1500);
  const raw = readFileSync(join(d.home, ".laya-router", "limits.json"), "utf8");
  for (const secret of ["PERSONAL", "accountUuid", "oauth", "email"]) assert.ok(!raw.includes(secret), secret);
  const saved = JSON.parse(raw);
  assert.equal(saved.windows["5h"].utilization, 0.42);
  assert.deepEqual(Object.keys(saved).sort(), ["at", "fallbackPct", "overage", "representative", "resetsAt", "status", "windows"]);
});

test("nothing from Claude Code's config reaches the snapshot, with the token or without it", async (t) => {
  // The probe reads one file that also holds the account's identity. Only two windows come out of it.
  const d = await boot(t, { scenario: { five: 42 } });
  await waitFor(figure(d, "5h"), "a figure");
  const withToken = JSON.stringify((await callDaemon(d.control, "snapshot")).result);
  const tokenless = JSON.stringify((await callDaemon(d.control, "snapshot", { token: null })).result ?? {});
  for (const shown of [withToken, tokenless]) {
    for (const secret of ["PERSONAL", "accountUuid", "oauthAccount", "cachedUsageUtilization"]) assert.ok(!shown.includes(secret), secret);
  }
  assert.ok(!tokenless.includes("limits"), "the tokenless look that laya-claude takes shows no usage at all");
});

test("the daemon's log says what the check found, once per change, however many times it runs", async (t) => {
  // Polls are 250 ms apart here. With nothing to read the first probe ends as "unreadable"; the log gets
  // that once, not once per poll, and then a line when a reading arrives, and none after it.
  const d = await boot(t, { scenario: { fetch: false }, tick: "250" });
  await waitFor(() => /Claude Code's usage check did not finish/.test(d.stderr), "the first line");
  const probes = d.probes();
  await waitFor(() => d.probes() >= probes + 3, "three more polls");
  const lines = () => d.stderr.split("\n").filter((l) => /plan usage:/.test(l));
  assert.equal(lines().length, 1, `one line for the whole stretch of identical polls, not one per poll: ${JSON.stringify(lines())}`);
  d.set({ five: 42, week: 12 });
  await waitFor(() => /plan usage: reading ok/.test(d.stderr), "the recovery to be written down");
  const after = d.probes();
  await waitFor(() => d.probes() >= after + 3, "three more polls");
  assert.equal(lines().length, 2, `and one line for the recovery: ${JSON.stringify(lines())}`);
  assert.doesNotMatch(d.stderr, /PERSONAL|example\.com/, "none of the account's details are in the log");
});
