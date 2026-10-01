// The control socket must survive anything a client does, including vanishing mid-write. The
// menu-bar app connects on launch and disconnects when it quits; a crash there must not take the
// router down with it, because the sidecar holds a 1.3GB model and an 85s cold start.
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { spawn } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort, wait, waitFor } from "./helpers.mjs";

const REPO = new URL("..", import.meta.url).pathname;
const DAEMON = join(REPO, "src", "daemon.mjs");



/** Starts a daemon on a free port in a throwaway home, and returns a client for it. */
async function startDaemon(t) {
  const home = mkdtempSync(join(tmpdir(), "laya-sock-"));
  const port = await freePort();
  const child = spawn(process.execPath, [DAEMON], {
    // /usr/bin/false: a daemon starts the routing model at boot now, and a test that is about the socket
    // must not load a gigabyte of weights because the Python on the contributor's PATH happens to have them.
    env: { ...process.env, LAYA_HOME: home, LAYA_TOKEN: "test-token", LAYA_CONTROL_PORT: String(port), LAYA_PYTHON: "/usr/bin/false" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (c) => (stderr += c.toString()));
  t.after(() => child.kill("SIGKILL"));

  const runFile = join(home, "run.json");
  for (let i = 0; i < 60 && !existsSync(runFile); i++) await wait(150);
  assert.ok(existsSync(runFile), `daemon never wrote run.json. stderr:\n${stderr}`);

  const call = (action, arg, token = "test-token") =>
    new Promise((resolve, reject) => {
      const s = net.createConnection({ host: "127.0.0.1", port }, () => {
        s.write(JSON.stringify({ id: 1, action, token, ...(arg !== undefined ? { arg } : {}) }) + "\n");
      });
      let buf = "";
      s.on("data", (c) => {
        buf += c.toString();
        const nl = buf.indexOf("\n");
        if (nl >= 0) { s.end(); try { resolve(JSON.parse(buf.slice(0, nl))); } catch (e) { reject(e); } }
      });
      s.on("error", reject);
      setTimeout(() => { s.end(); reject(new Error(`timeout on ${action}`)); }, 5000);
    });

  return { child, call, port, runFile, get stderr() { return stderr; } };
}

const alive = (child) => child.exitCode === null && child.signalCode === null;

/** Starts a daemon and returns the handle, without waiting for readiness. */
function spawnDaemon(t, { port, home, token = "test-token" }) {
  const child = spawn(process.execPath, [DAEMON], {
    env: { ...process.env, LAYA_HOME: home, LAYA_TOKEN: token, LAYA_CONTROL_PORT: String(port), LAYA_PYTHON: "/usr/bin/false" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (c) => (stderr += c.toString()));
  t.after(() => child.kill("SIGKILL"));
  return { child, port, home, runFile: join(home, "run.json"), get stderr() { return stderr; } };
}

/** Resolves once the child exits, with its code and everything it printed. */
function waitForExit(child, ms = 8000) {
  if (!alive(child)) return Promise.resolve([child.exitCode, ""]);
  return new Promise((resolve) => {
    let out = "";
    child.stderr?.on("data", (c) => (out += c.toString()));
    const timer = setTimeout(() => resolve([null, out]), ms);
    child.on("exit", (code) => {
      clearTimeout(timer);
      setTimeout(() => resolve([code, out]), 50);
    });
  });
}

test("a client that disconnects mid-write does not kill the daemon", async (t) => {
  const d = await startDaemon(t);
  assert.ok(alive(d.child));

  // The failure this pins: connect, send a partial line, then reset the connection so the
  // daemon's write lands on a dead socket.
  for (let i = 0; i < 5; i++) {
    const s = net.createConnection({ host: "127.0.0.1", port: d.port }, () => {
      s.write('{"id":1,"action":"subscribe","token":"test-token"}\n');
      // Reset without a clean FIN, which is what an app being force-quit looks like.
      s.resetAndDestroy ? s.resetAndDestroy() : s.destroy();
    });
    await new Promise((r) => s.on("close", r));
  }
  await wait(400);
  assert.ok(alive(d.child), `daemon died on an abrupt disconnect:\n${d.stderr}`);
});

test("a subscriber that vanishes takes its listener with it, and the daemon keeps serving", async (t) => {
  const d = await startDaemon(t);
  const s = net.createConnection({ host: "127.0.0.1", port: d.port }, () => {
    s.write('{"id":1,"action":"subscribe","token":"test-token"}\n');
  });
  await wait(200);
  s.destroy();
  await wait(300);
  assert.ok(alive(d.child));
  // Still answering other clients, so the socket was cleaned up rather than wedged.
  const reply = await d.call("snapshot");
  assert.equal(reply.result.prefs.preset, "balanced");
});

test("a subscriber still receives updates pushed after it connected", async (t) => {
  const d = await startDaemon(t);
  const got = [];
  const s = net.createConnection({ host: "127.0.0.1", port: d.port }, () => {
    s.write('{"id":1,"action":"subscribe","token":"test-token"}\n');
  });
  s.on("data", (c) => {
    for (const line of c.toString().split("\n")) {
      if (!line.trim()) continue;
      try { got.push(JSON.parse(line)); } catch { /* partial */ }
    }
  });
  await wait(250);
  await d.call("prefs.update", { preset: "savings" });
  await wait(300);
  s.destroy();
  assert.ok(got.some((m) => m.event?.prefs?.preset === "savings"), "the change was pushed to the subscriber");
  assert.ok(alive(d.child));
});

test("a client with no token cannot change anything, and the daemon says why", async (t) => {
  const d = await startDaemon(t);
  const reply = await d.call("prefs.update", { enabled: false }, "wrong-token");
  assert.equal(reply.error, "forbidden");
  const after = await d.call("snapshot");
  assert.equal(after.result.prefs.enabled, true, "the setting did not change");
});

test("garbage on the socket is rejected without dropping the connection", async (t) => {
  const d = await startDaemon(t);
  const s = net.createConnection({ host: "127.0.0.1", port: d.port }, () => s.write("not json at all\n"));
  const reply = await new Promise((resolve) => {
    let buf = "";
    s.on("data", (c) => { buf += c; if (buf.includes("\n")) { s.end(); resolve(JSON.parse(buf.split("\n")[0])); } });
  });
  assert.equal(reply.error, "bad json");
  s.destroy();
  assert.ok(alive(d.child));
  assert.ok((await d.call("snapshot")).result, "still serving after bad input");
});

test("an unknown action is an error on that request, not a crash", async (t) => {
  const d = await startDaemon(t);
  const reply = await d.call("does.not.exist");
  assert.match(reply.error, /unknown action/);
  assert.ok(alive(d.child));
  assert.ok((await d.call("snapshot")).result, "still serving");
});

test("two clients can be connected at once, and each gets its own stream", async (t) => {
  const d = await startDaemon(t);
  const a = net.createConnection({ host: "127.0.0.1", port: d.port });
  const b = net.createConnection({ host: "127.0.0.1", port: d.port });
  await wait(200);
  a.write('{"id":1,"action":"subscribe","token":"test-token"}\n');
  b.write('{"id":1,"action":"subscribe","token":"test-token"}\n');
  await wait(250);
  a.destroy();
  b.destroy();
  await wait(250);
  assert.ok(alive(d.child));
  assert.ok((await d.call("snapshot")).result);
});

test("the run file names a port and token the app can actually use", async (t) => {
  const d = await startDaemon(t);
  const info = JSON.parse(readFileSync(d.runFile, "utf8"));
  assert.equal(info.token, "test-token");
  assert.equal(info.port, d.port);
  assert.equal(info.pid, d.child.pid);
  assert.ok(alive(d.child));
});

// Two daemons on one port is the collision that produced a raw stack trace. It happens for real:
// launchctl starting the login item while someone runs bin/laya-daemon by hand, and the
// run-file guard misses it because LAYA_HOME (and therefore run.json) is per-home while the
// control port is global.
test("a second daemon on a taken port exits cleanly, without a stack trace", async (t) => {
  const first = await startDaemon(t);
  assert.ok(alive(first.child));

  const second = await spawnDaemon(t, { port: first.port, home: mkdtempSync(join(tmpdir(), "laya-dup-")) });
  const [code, stderr] = await waitForExit(second.child);
  assert.notEqual(code, null, "the second daemon should not keep running");
  assert.doesNotMatch(stderr, /at .*node:internal/, "no raw stack trace for an ordinary collision");
  // The second instance has a different LAYA_HOME, so it cannot see the first one's run file.
  // It must still recognise that a Laya holds the port, rather than blaming a stranger.
  assert.match(stderr, /Laya is already running/i, `unhelpful message:\n${stderr}`);
  assert.doesNotMatch(stderr, /something other than Laya/i);
  // The first daemon is untouched: this is a refusal to start, not a takeover.
  assert.ok(alive(first.child), "the running daemon was not disturbed");
  assert.ok((await first.call("snapshot")).result, "and still answers");
});

test("a port held by something that is not Laya is reported as such", async (t) => {
  const squatter = net.createServer();
  await new Promise((r) => squatter.listen(0, "127.0.0.1", r));
  const port = squatter.address().port;
  t.after(() => squatter.close());

  const d = await spawnDaemon(t, { port, home: mkdtempSync(join(tmpdir(), "laya-squat-")) });
  const [code, stderr] = await waitForExit(d.child);
  assert.notEqual(code, null);
  assert.doesNotMatch(stderr, /at .*node:internal/);
  assert.match(stderr, /in use/i, `should name the real problem:\n${stderr}`);
});

test("the port can be chosen, so a second instance is possible on purpose", async (t) => {
  const a = await startDaemon(t);
  const home = mkdtempSync(join(tmpdir(), "laya-two-"));
  const bPort = await freePort(); // not a.port + 1: that is often daemon A's own proxy port
  const b = await spawnDaemon(t, { port: bPort, home });
  t.after(() => b.child.kill("SIGKILL"));
  // Two daemons coexist, each with its own run file, token and home.
  await waitFor(() => readFileSync(join(home, "run.json"), "utf8"), "the second daemon's run file");
  assert.ok(alive(a.child));
  assert.ok(alive(b.child));
  const infoA = JSON.parse(readFileSync(a.runFile, "utf8"));
  const infoB = JSON.parse(readFileSync(join(home, "run.json"), "utf8"));
  assert.equal(infoA.port, a.port);
  assert.equal(infoB.port, bPort);
  assert.notEqual(infoA.pid, infoB.pid);
  // The second instance serves its own settings: its own socket, not the first daemon's.
  const reply = await new Promise((resolve, reject) => {
    const s = net.createConnection({ host: "127.0.0.1", port: bPort }, () => {
      s.write(JSON.stringify({ id: 1, action: "snapshot", token: "test-token" }) + "\n");
    });
    let buf = "";
    s.on("data", (c) => {
      buf += c;
      if (buf.includes("\n")) { s.end(); resolve(JSON.parse(buf.split("\n")[0])); }
    });
    s.on("error", reject);
    setTimeout(() => reject(new Error("timeout")), 5000);
  });
  assert.equal(reply.result.prefs.preset, "balanced");
});

// Found while reading my own hardening patch: the first version of it dropped the request id from
// every reply except "forbidden". The app matches replies to requests by id, so each change it
// sent left a task waiting forever for an answer that could never be recognised. No test noticed
// because the test client resolves on the first line whatever it says.
function exchange(port, messages, { lines = messages.length, ms = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const got = [];
    let buf = "";
    const s = net.createConnection({ host: "127.0.0.1", port }, () => {
      for (const m of messages) s.write(JSON.stringify(m) + "\n");
    });
    s.on("data", (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        got.push(JSON.parse(buf.slice(0, i)));
        buf = buf.slice(i + 1);
      }
      if (got.length >= lines) { s.end(); resolve(got); }
    });
    s.on("error", reject);
    setTimeout(() => { s.destroy(); reject(new Error(`only ${got.length}/${lines} replies: ${JSON.stringify(got)}`)); }, ms);
  });
}

test("every reply carries the id of the request it answers", async (t) => {
  const d = await startDaemon(t);
  const replies = await exchange(d.port, [
    { id: 41, action: "snapshot", token: "test-token" },
    { id: 42, action: "no-such-action", token: "test-token" },
    { id: 43, action: "ping", token: "test-token" },
    { id: 44, action: "snapshot" },
    { id: 45, action: "prefs.update", arg: { preset: "careful" } },
  ]);
  assert.deepEqual(replies.map((r) => r.id), [41, 42, 43, 44, 45]);
  assert.ok(replies[0].result, "a successful reply has its result");
  assert.equal(replies[1].error.includes("unknown action"), true, "an error reply has its error");
  assert.equal(replies[4].error, "forbidden", "a refused reply says so");
});

test("a subscription's acknowledgement and every pushed update carry the subscribe request's id", async (t) => {
  const d = await startDaemon(t);
  const replies = await exchange(d.port, [{ id: 77, action: "subscribe", token: "test-token" }], { lines: 2 });
  assert.ok(replies.length >= 2);
  for (const r of replies) assert.equal(r.id, 77, JSON.stringify(Object.keys(r)));
  assert.ok(replies.some((r) => r.event?.prefs), "the first update arrives straight away");
});

test("a thrown handler error is answered with the request's id, and the daemon keeps serving", async (t) => {
  const d = await startDaemon(t);
  const [bad] = await exchange(d.port, [{ id: 9, action: "engine.start", token: "test-token", arg: { engine: "nope" } }]);
  assert.equal(bad.id, 9);
  assert.ok(bad.error || bad.result !== undefined);
  assert.ok((await d.call("ping")).result.pong);
});
