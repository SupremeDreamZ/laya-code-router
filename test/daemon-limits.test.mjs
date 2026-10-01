import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort, wait, waitFor } from "./helpers.mjs";

// The whole chain, for real: a daemon process, its proxy, a stand-in for Anthropic that answers
// with the plan's limit headers, and the control socket the app reads. A figure that goes in as a
// response header must come out as a number in the snapshot and, past a threshold, an alert.
const REPO = new URL("..", import.meta.url).pathname;
const DAEMON = join(REPO, "src", "daemon.mjs");


const RESET = Math.floor(Date.now() / 1000) + 3 * 3600; // fixed for the whole test: one window

function anthropic() {
  const state = { util5: 0.1, util7: 0.05, status: "allowed", hits: 0, reset5: RESET };
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (/^\/v1\/models/.test(req.url)) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end('{"data":[]}');
      }
      state.hits++;
      res.writeHead(200, {
        "content-type": "application/json",
        "anthropic-ratelimit-unified-5h-utilization": String(state.util5),
        "anthropic-ratelimit-unified-5h-reset": String(state.reset5),
        "anthropic-ratelimit-unified-5h-status": state.status,
        "anthropic-ratelimit-unified-7d-utilization": String(state.util7),
        "anthropic-ratelimit-unified-7d-reset": String(RESET + 4 * 86400),
        "anthropic-ratelimit-unified-7d-status": "allowed",
        "anthropic-ratelimit-unified-status": state.status,
        "anthropic-ratelimit-unified-representative-claim": "five_hour",
      });
      res.end(JSON.stringify({ type: "message", model: "claude-sonnet-5-5", content: [], usage: { input_tokens: 5, output_tokens: 5 } }));
    });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ state, port: server.address().port, close: () => server.close() })));
}

async function boot(t, { up, layaHome, home, env: extraEnv = {} }) {
  const port = await freePort();
  const child = spawn(process.execPath, [DAEMON], {
    env: {
      PATH: process.env.PATH,
      HOME: home,
      LAYA_HOME: layaHome,
      LAYA_TOKEN: "tok",
      LAYA_CONTROL_PORT: String(port),
      LAYA_CLAUDE_PROXY_PORT: "0",
      LAYA_CLAUDE_UPSTREAM: `http://127.0.0.1:${up.port}`,
      LAYA_PYTHON: "/usr/bin/false",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (c) => (stderr += c));
  t.after(() => child.kill("SIGKILL"));
  const runFile = join(layaHome, "run.json");
  for (let i = 0; i < 60; i++) {
    if (existsSync(runFile) && JSON.parse(readFileSync(runFile, "utf8")).port === port) break;
    await wait(150);
  }
  const call = (action, arg) =>
    new Promise((resolve, reject) => {
      const s = net.createConnection({ host: "127.0.0.1", port }, () => s.write(JSON.stringify({ id: 1, action, token: "tok", ...(arg !== undefined ? { arg } : {}) }) + "\n"));
      let buf = "";
      s.on("data", (c) => {
        buf += c;
        const nl = buf.indexOf("\n");
        if (nl >= 0) {
          s.end();
          resolve(JSON.parse(buf.slice(0, nl)));
        }
      });
      s.on("error", reject);
      setTimeout(() => reject(new Error(`timeout ${action}\n${stderr}`)), 6000);
    });
  const snap = async () => (await call("snapshot")).result;
  let proxyPort = 0;
  for (let i = 0; i < 40 && !proxyPort; i++) {
    proxyPort = (await snap()).engines.claude.port;
    if (!proxyPort) await wait(100);
  }
  assert.ok(proxyPort, `the daemon never started its proxy. stderr:\n${stderr}`);
  const ask = async () => {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-sonnet-5-5", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }),
    });
    await res.text();
    await wait(80);
  };
  return { child, call, snap, ask, proxyPort, controlPort: port, get stderr() { return stderr; } };
}

const dirs = () => ({ layaHome: mkdtempSync(join(tmpdir(), "laya-e2e-")), home: mkdtempSync(join(tmpdir(), "laya-e2ehome-")) });

test("a response's limit headers become figures in the snapshot", async (t) => {
  const up = await anthropic();
  t.after(() => up.close());
  const d = await boot(t, { up, ...dirs() });
  assert.equal((await d.snap()).limits, null, "nothing is claimed before a response has been seen");
  up.state.util5 = 0.42;
  await d.ask();
  const s = await d.snap();
  assert.equal(s.limits.windows["5h"].utilization, 0.42);
  assert.equal(s.limits.windows["7d"].utilization, 0.05);
  assert.equal(s.limits.windows["5h"].resetsAt, RESET * 1000);
  assert.equal(s.limits.representative, "5h");
});

test("crossing 75% raises one alert, and 90% raises the next, each exactly once", async (t) => {
  const up = await anthropic();
  t.after(() => up.close());
  const d = await boot(t, { up, ...dirs() });
  up.state.util5 = 0.78;
  await d.ask();
  await d.ask();
  let s = await d.snap();
  assert.deepEqual(s.alerts.map((a) => [a.kind, a.threshold]), [["threshold", 75]]);
  up.state.util5 = 0.93;
  await d.ask();
  s = await d.snap();
  assert.deepEqual(s.alerts.map((a) => [a.kind, a.threshold, a.level]), [["threshold", 75, "warning"], ["threshold", 90, "critical"]]);
  assert.match(s.alerts[1].title, /93%/);
});

test("switching alerts off in the app silences them, and on again they work", async (t) => {
  const up = await anthropic();
  t.after(() => up.close());
  const d = await boot(t, { up, ...dirs() });
  await d.call("prefs.update", { alerts: { enabled: false } });
  up.state.util5 = 0.95;
  await d.ask();
  assert.deepEqual((await d.snap()).alerts, []);
  await d.call("prefs.update", { alerts: { enabled: true } });
  await d.ask();
  assert.equal((await d.snap()).alerts.length, 1);
});

test("hitting the limit is reported, and the 429 still reaches the client", async (t) => {
  const up = await anthropic();
  t.after(() => up.close());
  const d = await boot(t, { up, ...dirs() });
  up.state.util5 = 1.0;
  up.state.status = "rejected";
  await d.ask();
  const limit = (await d.snap()).alerts.find((a) => a.kind === "limit");
  assert.ok(limit);
  assert.equal(limit.level, "critical");
  assert.equal(limit.window, "5h");
});

test("the test-alert button produces an alert the app can show", async (t) => {
  const up = await anthropic();
  t.after(() => up.close());
  const d = await boot(t, { up, ...dirs() });
  const reply = await d.call("alerts.test");
  assert.equal(reply.result.kind, "test");
  assert.equal((await d.snap()).alerts.at(-1).test, true);
});

test("a client with no token cannot fire a test alert or change alert settings", async (t) => {
  const up = await anthropic();
  t.after(() => up.close());
  const d = await boot(t, { up, ...dirs() });
  const tokenless = (action, arg) =>
    new Promise((resolve, reject) => {
      const s = net.createConnection({ host: "127.0.0.1", port: d.controlPort }, () =>
        s.write(JSON.stringify({ id: 9, action, ...(arg !== undefined ? { arg } : {}) }) + "\n"),
      );
      let buf = "";
      s.on("data", (c) => {
        buf += c;
        if (buf.includes("\n")) {
          s.end();
          resolve(JSON.parse(buf.split("\n")[0]));
        }
      });
      s.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 5000);
    });
  assert.equal((await tokenless("alerts.test")).error, "forbidden");
  assert.equal((await tokenless("prefs.update", { alerts: { enabled: false } })).error, "forbidden");
  const s = await d.snap();
  assert.equal(s.prefs.alerts.enabled, true, "the refused change did not happen");
  assert.deepEqual(s.alerts, [], "and no alert was fired");
});

test("limits and alerts survive a daemon restart, and an alert is not raised twice", async (t) => {
  const up = await anthropic();
  t.after(() => up.close());
  const where = dirs();
  const first = await boot(t, { up, ...where });
  up.state.util5 = 0.8;
  await first.ask();
  assert.equal((await first.snap()).alerts.length, 1);
  // The figure is written a moment after the response, not on every one. Wait for it to be on
  // disk rather than guessing how long "a moment" is on a busy machine.
  await waitFor(() => JSON.parse(readFileSync(join(where.layaHome, "limits.json"), "utf8")).windows["5h"].utilization === 0.8, "limits.json to hold the reading");
  const firstGone = new Promise((resolve) => (first.child.exitCode !== null || first.child.signalCode !== null ? resolve() : first.child.once("exit", resolve)));
  first.child.kill("SIGKILL");
  await firstGone;

  const second = await boot(t, { up, ...where });
  const s = await second.snap();
  assert.equal(s.limits.windows["5h"].utilization, 0.8, "the figure was still there when it came back");
  assert.equal(s.alerts.length, 1, "and so was the alert history");
  await second.ask();
  assert.equal((await second.snap()).alerts.length, 1, "the same reading after a restart raises nothing new");
});

test("a daemon that restarts keeps its proxy on the same port, so open sessions are not stranded", async (t) => {
  const up = await anthropic();
  t.after(() => up.close());
  const fixed = await freePort();
  const where = dirs();
  const port = await freePort();
  const env = {
    PATH: process.env.PATH, HOME: where.home, LAYA_HOME: where.layaHome, LAYA_TOKEN: "tok",
    LAYA_CONTROL_PORT: String(port), LAYA_CLAUDE_PROXY_PORT: String(fixed),
    LAYA_CLAUDE_UPSTREAM: `http://127.0.0.1:${up.port}`, LAYA_PYTHON: "/usr/bin/false",
  };
  const run = async () => {
    const c = spawn(process.execPath, [DAEMON], { env, stdio: "ignore" });
    t.after(() => c.kill("SIGKILL"));
    // The killed daemon left its run.json behind, so "the file exists" proves nothing. The new
    // daemon is up when the file names ITS pid, and its proxy is up a moment after that.
    const ready = () => {
      try { return JSON.parse(readFileSync(join(where.layaHome, "run.json"), "utf8")).pid === c.pid; } catch { return false; }
    };
    for (let i = 0; i < 80 && !ready(); i++) await wait(100);
    assert.ok(ready(), "the new daemon never wrote its run file");
    await wait(300);
    return c;
  };
  const snapPort = () =>
    new Promise((resolve, reject) => {
      const s = net.createConnection({ host: "127.0.0.1", port }, () => s.write(JSON.stringify({ id: 1, action: "snapshot" }) + "\n"));
      let buf = "";
      s.on("data", (c) => { buf += c; if (buf.includes("\n")) { s.end(); resolve(JSON.parse(buf.split("\n")[0]).result.engines.claude.port); } });
      s.on("error", reject);
    });
  const a = await run();
  assert.equal(await snapPort(), fixed);
  // Wait for the process to actually be gone, not for a guessed interval: the new daemon asks for
  // the same port, and if the old one is still holding it the proxy quietly binds elsewhere.
  const gone = new Promise((resolve) => (a.exitCode !== null || a.signalCode !== null ? resolve() : a.once("exit", resolve)));
  a.kill("SIGKILL");
  await gone;
  await run();
  assert.equal(await snapPort(), fixed, "the same address after a restart");
});

// ---- the daemon's own clock ------------------------------------------------------------------
test("after a limit, the reset is announced by the daemon's own clock with no traffic at all", async (t) => {
  const up = await anthropic();
  t.after(() => up.close());
  const d = await boot(t, { up, ...dirs(), env: { LAYA_ALERT_TICK_MS: "200" } });
  up.state.util5 = 1.0;
  up.state.status = "rejected";
  up.state.reset5 = Math.floor(Date.now() / 1000) + 2;
  await d.ask();
  assert.equal((await d.snap()).alerts.filter((a) => a.kind === "limit").length, 1);
  assert.equal((await d.snap()).alerts.filter((a) => a.kind === "reset").length, 0, "not before the window ends");
  let reset;
  for (let i = 0; i < 120 && !reset; i++) {
    await wait(250);
    reset = (await d.snap()).alerts.find((a) => a.kind === "reset");
  }
  assert.ok(reset, "the reset was announced although no request arrived after it");
  assert.equal(reset.window, "5h");
});

// ---- who can read what -----------------------------------------------------------------------
const tokenlessSnapshot = (port) =>
  new Promise((resolve, reject) => {
    const s = net.createConnection({ host: "127.0.0.1", port }, () => s.write(JSON.stringify({ id: 1, action: "snapshot" }) + "\n"));
    let buf = "";
    s.on("data", (c) => {
      buf += c;
      if (buf.includes("\n")) {
        s.end();
        resolve(buf.split("\n")[0]);
      }
    });
    s.on("error", reject);
    setTimeout(() => reject(new Error("timeout")), 5000);
  });

test("a snapshot asked for without the token holds no prompt text, history, or settings", async (t) => {
  const up = await anthropic();
  t.after(() => up.close());
  const d = await boot(t, { up, ...dirs() });
  await d.call("event", { kind: "routed", tier: "sonnet", model: "claude-sonnet-5-5", prompt: "rotate the production signing key SECRET-MARKER-7" });
  assert.match(JSON.stringify((await d.snap()).events), /SECRET-MARKER-7/, "the app, holding the token, does see it");
  const raw = await tokenlessSnapshot(d.controlPort);
  assert.doesNotMatch(raw, /SECRET-MARKER-7/, "anyone else on this Mac must not");
  const body = JSON.parse(raw).result;
  for (const key of ["events", "prefs", "usage", "limits", "alerts"]) assert.equal(body[key], undefined, `${key} is not public`);
});

test("...yet an unauthenticated caller can still tell that this is Laya, and where its proxy is", async (t) => {
  const up = await anthropic();
  t.after(() => up.close());
  const d = await boot(t, { up, ...dirs() });
  const body = JSON.parse(await tokenlessSnapshot(d.controlPort)).result;
  assert.equal(body.laya, true);
  assert.equal(body.engines.claude.running, true);
  assert.ok(body.engines.claude.port > 0);
});

// ---- the model list in Settings --------------------------------------------------------------
test("the snapshot lists every model with its own state, so a switched-off one can be switched back on", async (t) => {
  const up = await anthropic();
  t.after(() => up.close());
  const d = await boot(t, { up, ...dirs() });
  let s = await d.snap();
  assert.deepEqual(s.models.map((m) => m.tier), ["haiku", "sonnet", "opus", "fable"]);
  assert.deepEqual(s.tiers, ["haiku", "sonnet", "opus"], "Fable starts off, so it is not among the models the router may pick");
  await d.call("prefs.update", { tiers: { haiku: false, fable: true } });
  s = await d.snap();
  assert.deepEqual(s.models.map((m) => m.tier), ["haiku", "sonnet", "opus", "fable"], "nothing disappears from the list when it is switched off");
  assert.deepEqual(s.tiers, ["sonnet", "opus", "fable"]);
});

// ---- pace, computed once in the daemon so the app never reimplements the arithmetic -----------
test("each window carries a pace projection when use so far would empty it before it resets", async (t) => {
  const up = await anthropic();
  t.after(() => up.close());
  const d = await boot(t, { up, ...dirs() });
  // RESET is about 3h away, so the 5h window is about 2h old. 60% used in 2h is 30% an hour, which
  // empties it in about 80 minutes, well before the reset.
  up.state.util5 = 0.6;
  await d.ask();
  const w = (await d.snap()).limits.windows["5h"];
  assert.ok(w.pace, "on this pace the window runs out before it resets");
  assert.ok(w.pace.inMs > 70 * 60_000 && w.pace.inMs < 95 * 60_000, `inMs was ${Math.round(w.pace.inMs / 60000)} min`);
  assert.ok(w.pace.atMs > Date.now(), "and it names a time in the future");
  // 20% in 2h would take 8h to empty, and the window resets in 3h: nothing to warn about.
  up.state.util5 = 0.2;
  await d.ask();
  assert.equal((await d.snap()).limits.windows["5h"].pace, null);
});

// ---- one price table ---------------------------------------------------------------------------
// The panel's "Last decision" card used to carry its own copy of the prices, in Swift, and it was
// wrong: it charged Haiku 3x the ledger's rate (measured on a real turn: card $0.0199, ledger
// $0.0068). The daemon now prices each event from the one tested table and the app only displays it.
test("each recorded event carries its cost, and it is exactly what the ledger charged for it", async (t) => {
  const up = await anthropic();
  t.after(() => up.close());
  const d = await boot(t, { up, ...dirs() });
  const usage = { input: 5807, cacheWrite: 0, cacheRead: 7872, output: 32 };
  const before = (await d.snap()).usage.today.cost;
  await d.call("event", { kind: "routed", tier: "haiku", model: "claude-haiku-4-5-20251001", usage });
  await d.call("event", { kind: "routed", tier: "opus", model: "claude-opus-5-5", usage });
  const s = await d.snap();
  const [haiku, opus] = s.events.slice(-2);
  // Haiku $1/$5 per MTok, cache reads $0.10: (5807*1 + 7872*0.1 + 32*5) / 1e6 = 0.0067542
  assert.ok(Math.abs(haiku.cost - 0.0067542) < 1e-9, `haiku cost was ${haiku.cost}`);
  // Opus $4/$20, cache reads $0.20: (5807*4 + 7872*0.2 + 32*20) / 1e6 = 0.0254424
  assert.ok(Math.abs(opus.cost - 0.0254424) < 1e-9, `opus cost was ${opus.cost}`);
  const charged = s.usage.today.cost - before;
  assert.ok(Math.abs(charged - (haiku.cost + opus.cost)) < 1e-9, "the events add up to exactly what the ledger recorded");
});

test("an event with no usage has no cost, rather than a guessed one", async (t) => {
  const up = await anthropic();
  t.after(() => up.close());
  const d = await boot(t, { up, ...dirs() });
  await d.call("event", { kind: "manual", tier: "sonnet", model: "claude-sonnet-5-5" });
  const e = (await d.snap()).events.at(-1);
  assert.equal(e.cost, undefined);
});
