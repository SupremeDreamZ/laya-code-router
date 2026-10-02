// What happens to the daemon's unsaved work, and to the routing model, when the daemon is stopped.
//
// launchd stops the login item with SIGTERM (a logout, a restart, `setup.sh --uninstall`, start.sh
// replacing a running copy). Node's default for SIGTERM is to end the process on the spot without
// running any exit handler, which lost up to two seconds of the day's savings ledger, a second of
// the plan's limit readings, and left the routing model, which can be mid-way through a
// minute-long load and not reading its input, running with nobody to answer to.
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callDaemon, freePort, waitFor } from "./helpers.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const DAEMON = join(REPO, "src", "daemon.mjs");
const FAKE = join(REPO, "test", "fixtures", "fake-sidecar.mjs");

const RESET = Math.floor(Date.now() / 1000) + 3 * 3600;

/** An Anthropic stand-in that answers with usage and the plan's limit headers. */
async function upstream() {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, {
        "content-type": "application/json",
        "anthropic-ratelimit-unified-5h-utilization": "0.42",
        "anthropic-ratelimit-unified-5h-reset": String(RESET),
        "anthropic-ratelimit-unified-5h-status": "allowed",
        "anthropic-ratelimit-unified-7d-utilization": "0.1",
        "anthropic-ratelimit-unified-7d-reset": String(RESET + 4 * 86400),
        "anthropic-ratelimit-unified-7d-status": "allowed",
        "anthropic-ratelimit-unified-status": "allowed",
      });
      res.end(JSON.stringify({ type: "message", model: "claude-sonnet-5-5", content: [], usage: { input_tokens: 1000, output_tokens: 200 } }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { port: server.address().port, close: () => server.close() };
}

async function boot(t, { stubborn = false } = {}) {
  const up = await upstream();
  t.after(() => up.close());
  const home = mkdtempSync(join(tmpdir(), "laya-down-"));
  const layaHome = join(home, ".laya-router");
  const startLog = join(home, "starts.log");
  writeFileSync(startLog, "");
  const wrapper = join(home, "fake-python");
  writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}"\n`, { mode: 0o755 });
  const control = await freePort();
  const child = spawn(process.execPath, [DAEMON], {
    env: {
      PATH: "/usr/bin:/bin", HOME: home, LAYA_HOME: layaHome, LAYA_TOKEN: "t", LAYA_CONTROL_PORT: String(control),
      LAYA_CLAUDE_PROXY_PORT: "0", LAYA_CLAUDE_UPSTREAM: `http://127.0.0.1:${up.port}`, LAYA_PYTHON: wrapper,
      FAKE_SIDECAR_LOG: startLog, ...(stubborn ? { FAKE_SIDECAR_STUBBORN: "1" } : {}),
      LAYA_CLAUDE_BIN: join(home, "nowhere", "claude"),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (c) => (stderr += c));
  t.after(() => child.kill("SIGKILL"));
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  const snap = async () => (await callDaemon(control, "snapshot")).result;
  const proxyPort = await waitFor(async () => (await snap()).engines.claude.port, "the proxy");
  return {
    child, exited, snap, control, layaHome, proxyPort, startLog,
    get stderr() { return stderr; },
    call: (action, arg) => callDaemon(control, action, { arg }),
    file: (name) => join(layaHome, name),
    sidecarPids: () => readFileSync(startLog, "utf8").split("\n").filter(Boolean).map((l) => Number(l.split(" ")[1])),
    /** One real turn through the proxy, so the daemon records usage and a limit reading. */
    turn: async (model = "claude-sonnet-5-5") => {
      const r = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-claude-code-session-id": `s-${Math.random()}` },
        body: JSON.stringify({ model, max_tokens: 10, messages: [{ role: "user", content: "hi" }] }),
      });
      await r.text();
    },
  };
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const todayN = (path) => {
  const days = JSON.parse(readFileSync(path, "utf8")).days;
  return Object.values(days).reduce((n, d) => n + d.n, 0);
};

for (const how of ["SIGTERM", "SIGINT", "SIGHUP", "quit"]) {
  test(`${how}: the turn just made is on disk, not lost to a timer that never fired`, async (t) => {
    const d = await boot(t);
    await d.turn();
    await waitFor(async () => (await d.snap()).usage.today.n === 1, "the turn to be counted");
    assert.ok(!existsSync(d.file("usage.json")) || todayN(d.file("usage.json")) === 0, "it must still be unsaved, or this proves nothing");
    if (how === "quit") await d.call("quit"); else d.child.kill(how);
    const { code } = await d.exited;
    assert.equal(code, 0, `exit code ${code}; launchd reads anything but 0 as a crash and restarts it`);
    assert.equal(todayN(d.file("usage.json")), 1, "the day's ledger lost the turn");
  });

  test(`${how}: the plan's limit reading is on disk too`, async (t) => {
    const d = await boot(t);
    await d.turn();
    await waitFor(async () => (await d.snap()).limits?.windows?.["5h"], "the reading to arrive");
    assert.ok(!existsSync(d.file("limits.json")), "it must still be unsaved, or this proves nothing");
    if (how === "quit") await d.call("quit"); else d.child.kill(how);
    await d.exited;
    const saved = JSON.parse(readFileSync(d.file("limits.json"), "utf8"));
    assert.equal(saved.windows["5h"].utilization, 0.42);
  });
}

test("stopping an idle daemon is quick and clean, with nothing to save", async (t) => {
  const d = await boot(t);
  const started = Date.now();
  d.child.kill("SIGTERM");
  const { code, signal } = await d.exited;
  assert.equal(code, 0);
  assert.equal(signal, null, "it ended itself rather than being ended by the signal");
  assert.ok(Date.now() - started < 4000, `took ${Date.now() - started}ms`);
  assert.ok(!/Error|at .*\.mjs/.test(d.stderr), d.stderr);
});

test("the routing model is stopped with the daemon, even one too busy to notice its input closed", async (t) => {
  // A real model that is mid-load reads nothing, so closing its stdin does not end it. The stand-in
  // behaves the same way when told to (FAKE_SIDECAR_STUBBORN).
  const d = await boot(t, { stubborn: true });
  await d.turn("laya-router").catch(() => {}); // starts the sidecar
  const [pid] = await waitFor(() => { const p = d.sidecarPids(); return p.length > 0 && p; }, "the routing model to start");
  assert.ok(alive(pid), "it should be running before the daemon is stopped");
  d.child.kill("SIGTERM");
  await d.exited;
  await waitFor(() => !alive(pid), "the routing model to be stopped with the daemon", 6000);
});

test("the routing model is also stopped by `quit`", async (t) => {
  const d = await boot(t, { stubborn: true });
  await d.turn("laya-router").catch(() => {});
  const [pid] = await waitFor(() => { const p = d.sidecarPids(); return p.length > 0 && p; }, "the routing model to start");
  await d.call("quit");
  await d.exited;
  await waitFor(() => !alive(pid), "the routing model to be stopped", 6000);
});

test("a save that fails does not stop the others, and the daemon still exits cleanly", async (t) => {
  // A full disk or a bad permission must not turn a requested stop into a crash: launchd restarts
  // a job that exits non-zero, and a daemon that cannot save would then stop and start forever.
  const d = await boot(t);
  await d.turn();
  await waitFor(async () => (await d.snap()).limits?.windows?.["5h"], "the reading to arrive");
  await waitFor(async () => (await d.snap()).usage.today.n === 1, "the turn to be counted");
  mkdirSync(d.file("limits.json"), { recursive: true }); // a directory where the file goes: the limits save will fail
  d.child.kill("SIGTERM");
  const { code, signal } = await d.exited;
  assert.equal(signal, null);
  assert.equal(code, 0, d.stderr.slice(-300));
  assert.equal(todayN(d.file("usage.json")), 1, "the failed limits save took the ledger down with it");
});

test("quit answers the app that asked before the daemon goes", async (t) => {
  // The app's Quit button waits for the reply. A daemon that exits first leaves it with a dropped
  // connection and no way to tell "quit" from "crashed".
  const d = await boot(t);
  const reply = await d.call("quit");
  assert.deepEqual(reply.result, { ok: true });
  const { code } = await d.exited;
  assert.equal(code, 0);
});

test("the daemon stops itself: a signal ends it with its own exit, not by the signal", async (t) => {
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    const d = await boot(t);
    d.child.kill(signal);
    const out = await d.exited;
    assert.deepEqual(out, { code: 0, signal: null }, signal);
  }
});
