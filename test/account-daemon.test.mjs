// How the daemon presents Claude Code's sign-in state to the menu-bar app.
//
// The app is the only place a person sees whether routing can work, so a signed-out Claude Code
// has to be visible there, and has to clear itself the moment they sign in. Signing in itself is
// Claude Code's: the app opens `claude auth login` in the person's terminal, where the browser
// hand-off and any code to paste back are visible. The daemon only reports the state. It starts
// no login, holds no credential, and exposes nothing that could.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callDaemon, freePort, subscribe, wait, waitFor } from "./helpers.mjs";

const REPO = new URL("..", import.meta.url).pathname;
const DAEMON = join(REPO, "src", "daemon.mjs");
const FAKE_CLAUDE = join(REPO, "test", "fixtures", "fake-claude");
const PERSONAL = ["someone@example.com", "org-0000-invented", "Invented Studio", "/Users/someone", "max"];

async function upstream() {
  const server = http.createServer((req, res) => { req.resume(); req.on("end", () => { res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); }); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { port: server.address().port, close: () => server.close() };
}

/**
 * A real daemon with a stand-in `claude`. `state` is a file the test rewrites to sign in or out;
 * `loginLog` records every call made to the stand-in, so a test can tell what was run and with
 * what arguments.
 */
async function boot(t, { state = "signed-out", accountTick = "100", tokenless = false } = {}) {
  const up = await upstream();
  t.after(() => up.close());
  const home = mkdtempSync(join(tmpdir(), "laya-acct-"));
  const stateFile = join(home, "claude-state");
  const log = join(home, "claude-calls.log");
  writeFileSync(stateFile, state);
  writeFileSync(log, "");
  const control = await freePort();
  const child = spawn(process.execPath, [DAEMON], {
    env: {
      PATH: "/usr/bin:/bin", HOME: home, LAYA_HOME: join(home, ".laya-router"), LAYA_TOKEN: "t",
      LAYA_CONTROL_PORT: String(control), LAYA_CLAUDE_PROXY_PORT: "0",
      LAYA_CLAUDE_UPSTREAM: `http://127.0.0.1:${up.port}`, LAYA_PYTHON: "/usr/bin/false",
      LAYA_CLAUDE_BIN: FAKE_CLAUDE, FAKE_CLAUDE_STATE: stateFile, FAKE_CLAUDE_LOG: log,
      LAYA_ACCOUNT_TICK_MS: accountTick,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (c) => (stderr += c));
  t.after(() => child.kill("SIGKILL"));
  await waitFor(async () => (await callDaemon(control, "ping")).result, "the daemon");
  const snap = async () => (await callDaemon(control, "snapshot")).result;
  return {
    control, snap, child,
    setState: (s) => writeFileSync(stateFile, s),
    calls: () => readFileSync(log, "utf8").split("\n").filter(Boolean),
    get stderr() { return stderr; },
    call: (action, arg, token) => callDaemon(control, action, { arg, token }),
  };
}

test("the snapshot says whether Claude Code is signed in, and by what method", async (t) => {
  const d = await boot(t, { state: "signed-in" });
  const account = await waitFor(async () => { const a = (await d.snap()).account; return a?.state === "signed-in" && a; }, "a signed-in account");
  assert.deepEqual(account, { state: "signed-in", method: "claude.ai" });
});

test("signed out is reported as signed out", async (t) => {
  const d = await boot(t, { state: "signed-out" });
  const account = await waitFor(async () => { const a = (await d.snap()).account; return a?.state === "signed-out" && a; }, "a signed-out account");
  assert.deepEqual(account, { state: "signed-out", method: null });
});

test("before the first answer the state is unknown, not signed out", async (t) => {
  // A check that is slow must not flash a sign-in prompt at someone who is signed in.
  const d = await boot(t, { state: "hang", accountTick: "60000" });
  const first = (await d.snap()).account;
  // Not "signed out", which would flash a prompt at someone who is signed in, and not "signed in"
  // either, which would be a claim made before anything was checked.
  assert.deepEqual(first, { state: "unknown", method: null });
});

test("nothing personal reaches the snapshot, which any local subscriber receives", async (t) => {
  const d = await boot(t, { state: "signed-in" });
  await waitFor(async () => (await d.snap()).account?.state === "signed-in", "signed in");
  const whole = JSON.stringify(await d.snap());
  for (const secret of PERSONAL) assert.ok(!whole.includes(secret), `${secret} is in the snapshot`);
});

test("signing in clears it on its own, pushed to the app with no click and no restart", async (t) => {
  const d = await boot(t, { state: "signed-out" });
  const pushed = subscribe(t, d.control, (snapshot) => snapshot.account?.state);
  await waitFor(() => pushed.includes("signed-out"), "the app to be told it is signed out");
  d.setState("signed-in"); // what `claude auth login` leaves behind when the person finishes in the browser
  await waitFor(() => pushed.includes("signed-in"), "the app to be told the sign-in worked");
  assert.equal(pushed.at(-1), "signed-in");
});

test("signing out is noticed too", async (t) => {
  const d = await boot(t, { state: "signed-in" });
  const pushed = subscribe(t, d.control, (snapshot) => snapshot.account?.state);
  await waitFor(() => pushed.includes("signed-in"), "signed in");
  d.setState("signed-out");
  await waitFor(() => pushed.includes("signed-out"), "the sign-out to be pushed");
});

test("an unchanged answer is not pushed again", async (t) => {
  const d = await boot(t, { state: "signed-in", accountTick: "60" });
  const pushed = subscribe(t, d.control, (snapshot) => snapshot.account?.state);
  await waitFor(() => pushed.includes("signed-in"), "signed in");
  const before = pushed.length;
  await waitFor(() => d.calls().length >= 6, "several more checks to have run");
  await wait(150);
  assert.equal(pushed.length, before, `${pushed.length - before} extra pushes while nothing changed`);
});

test("a change of method alone, still signed in, is pushed too", async (t) => {
  const d = await boot(t, { state: "signed-in" });
  const pushed = subscribe(t, d.control, (snapshot) => snapshot.account?.method);
  await waitFor(() => pushed.includes("claude.ai"), "signed in with claude.ai");
  d.setState("signed-in-key");
  await waitFor(() => pushed.includes("api_key"), "the new method to be pushed");
});

test("a check that cannot be made leaves the last clear answer in place", async (t) => {
  const d = await boot(t, { state: "signed-in" });
  await waitFor(async () => (await d.snap()).account?.state === "signed-in", "signed in");
  d.setState("garbage"); // the next checks get no clear answer
  const seen = d.calls().length;
  await waitFor(() => d.calls().length >= seen + 3, "more checks to have run");
  assert.equal((await d.snap()).account.state, "signed-in", "one unreadable reply must not flip the panel to a sign-in prompt");
});

test("the checks are paced, not a tight loop", async (t) => {
  const d = await boot(t, { state: "signed-in", accountTick: "60000" });
  await waitFor(async () => (await d.snap()).account?.state === "signed-in", "the first check");
  await wait(400);
  assert.equal(d.calls().filter((c) => c === "auth status").length, 1, "one check at start, and none until the next tick");
});

test("a tiny or nonsense interval in the environment does not turn into a tight loop", async (t) => {
  // Each of these used to be able to reach setTimeout as 0 or 1 ms, and every tick starts a
  // process. A person can easily end up with `LAYA_ACCOUNT_TICK_MS=` (empty) in ~/.laya-router.env.
  for (const bad of ["10", "0", "", "-5", "abc", "Infinity", "3000000000"]) {
    const d = await boot(t, { state: "signed-in", accountTick: bad });
    await waitFor(async () => (await d.snap()).account?.state === "signed-in", `signed in with interval ${JSON.stringify(bad)}`);
    await wait(500);
    assert.ok(d.calls().length <= 2, `interval ${JSON.stringify(bad)}: ${d.calls().length} checks in half a second`);
    d.child.kill("SIGKILL");
  }
});

// -------------------------------------------------------------------- what the daemon does not do

test("there is no action that starts a sign-in: the daemon reports the state and nothing else", async (t) => {
  const d = await boot(t, { state: "signed-out" });
  for (const action of ["account.login", "account.logout", "login", "auth.login", "account.signin"]) {
    const r = await d.call(action);
    assert.ok(r.error, `${action} should not exist`);
  }
  await wait(300);
  assert.ok(!d.calls().some((c) => c.startsWith("auth login") || c.startsWith("auth logout")), d.calls().join(" | "));
});

test("only `auth status` is ever run", async (t) => {
  const d = await boot(t, { state: "signed-out", accountTick: "50" });
  await waitFor(() => d.calls().length >= 5, "several checks");
  assert.deepEqual([...new Set(d.calls())], ["auth status"]);
});

test("a stand-in that is gone entirely reads as missing, and the daemon keeps answering", async (t) => {
  const up = await upstream();
  t.after(() => up.close());
  const home = mkdtempSync(join(tmpdir(), "laya-acct-"));
  const control = await freePort();
  const child = spawn(process.execPath, [DAEMON], {
    env: {
      PATH: "/usr/bin:/bin", HOME: home, LAYA_HOME: join(home, ".laya-router"), LAYA_TOKEN: "t",
      LAYA_CONTROL_PORT: String(control), LAYA_CLAUDE_PROXY_PORT: "0", LAYA_CLAUDE_UPSTREAM: `http://127.0.0.1:${up.port}`,
      LAYA_PYTHON: "/usr/bin/false", LAYA_CLAUDE_BIN: join(home, "nowhere", "claude"), LAYA_ACCOUNT_TICK_MS: "100",
    },
    stdio: "ignore",
  });
  t.after(() => child.kill("SIGKILL"));
  await waitFor(async () => (await callDaemon(control, "ping")).result, "the daemon");
  const account = await waitFor(async () => { const a = (await callDaemon(control, "snapshot")).result.account; return a?.state === "missing" && a; }, "missing");
  assert.deepEqual(account, { state: "missing", method: null });
  assert.equal((await callDaemon(control, "ping")).result.pong, true);
});

test("the tokenless look that `laya-claude` takes still shows nothing about the account", async (t) => {
  const d = await boot(t, { state: "signed-in" });
  await waitFor(async () => (await d.snap()).account?.state === "signed-in", "signed in");
  const r = await d.call("snapshot", undefined, null);
  const shown = JSON.stringify(r.result ?? r);
  assert.ok(!shown.includes("signed-in") && !shown.includes("claude.ai") && !/account/.test(shown), shown);
});
