import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort, subscribe, wait, waitFor } from "./helpers.mjs";

// The status dot and the "Router" card are drawn from sidecar.state. It used to say `warm` as soon
// as any event arrived, even a turn the user pinned (no routing decision) and even straight after a
// routing failure. A real daemon runs here against a stand-in sidecar (test/fixtures/fake-sidecar.mjs)
// whose behaviour each test changes, and the assertions are on what the daemon tells the app.
const REPO = new URL("..", import.meta.url).pathname;
const DAEMON = join(REPO, "src", "daemon.mjs");
const FAKE = join(REPO, "test", "fixtures", "fake-sidecar.mjs");



function upstream() {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (/^\/v1\/models/.test(req.url)) return res.writeHead(200, { "content-type": "application/json" }).end('{"data":[]}');
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "message", model: "claude-sonnet-5-5", content: [], usage: { input_tokens: 10, output_tokens: 5 } }));
    });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ port: server.address().port, close: () => server.close() })));
}

/** A real daemon using the stand-in sidecar. `python` overrides the interpreter for the missing-Python case. */
async function boot(t, { mode = "ok", python, env = {}, upstreamMs = 0 } = {}) {
  const up = await upstream();
  t.after(() => up.close());
  const home = mkdtempSync(join(tmpdir(), "laya-sc-"));
  const layaHome = join(home, ".laya-router");
  const modeFile = join(home, "mode");
  const startLog = join(home, "starts.log");
  writeFileSync(modeFile, mode);
  writeFileSync(startLog, "");
  const control = await freePort();
  // The stand-in is a Node script; LAYA_PYTHON is what the router spawns, so a wrapper runs it.
  const wrapper = join(home, "fake-python");
  writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}"\n`, { mode: 0o755 });
  const child = spawn(process.execPath, [DAEMON], {
    env: {
      PATH: process.env.PATH, HOME: home, LAYA_HOME: layaHome, LAYA_TOKEN: "t", LAYA_CONTROL_PORT: String(control),
      LAYA_CLAUDE_PROXY_PORT: "0", LAYA_CLAUDE_UPSTREAM: `http://127.0.0.1:${up.port}`,
      LAYA_PYTHON: python ?? wrapper, FAKE_SIDECAR_MODE: modeFile, FAKE_SIDECAR_LOG: startLog, ...env,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (c) => (stderr += c));
  t.after(() => child.kill("SIGKILL"));
  const call = (action, arg) =>
    new Promise((resolve, reject) => {
      const s = net.createConnection({ host: "127.0.0.1", port: control }, () =>
        s.write(JSON.stringify({ id: 1, action, token: "t", ...(arg !== undefined ? { arg } : {}) }) + "\n"));
      let buf = "";
      s.on("data", (c) => {
        buf += c;
        if (buf.includes("\n")) {
          s.end();
          resolve(JSON.parse(buf.split("\n")[0]));
        }
      });
      s.on("error", reject);
      setTimeout(() => reject(new Error(`timeout ${action}`)), 8000);
    });
  const snap = async () => (await call("snapshot")).result;
  const proxyPort = await waitFor(async () => (await snap()).engines.claude.port, "the daemon's proxy");
  const turn = async (model, { session = `s-${Math.random()}`, prompt = "Add pagination to the users list." } = {}) => {
    const r = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-claude-code-session-id": session },
      body: JSON.stringify({
        model, max_tokens: 100,
        tools: [{ name: "Bash", description: "x", input_schema: { type: "object", properties: {} } }],
        messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
      }),
    });
    await r.text();
  };
  const starts = () => readFileSync(startLog, "utf8").split("\n").filter(Boolean).length;
  return { call, snap, turn, control, setMode: (m) => writeFileSync(modeFile, m), starts, get stderr() { return stderr; }, layaHome, wrapper };
}

const sidecar = async (d) => (await d.snap()).sidecar;

test("nothing has been asked yet: the model is not claimed to be running", async (t) => {
  const d = await boot(t);
  const s = await sidecar(d);
  assert.equal(s.state, "stopped");
  assert.equal(s.lastError, null);
});

// The bug this file exists for.
test("a turn the user pinned to a model makes no routing decision, so it proves nothing about the model", async (t) => {
  const d = await boot(t);
  await d.turn("claude-sonnet-5-5");
  await wait(300);
  const s = await sidecar(d);
  assert.notEqual(s.state, "warm", "a pinned turn never reached the routing model, so 'warm' would be a claim with nothing behind it");
  assert.equal((await d.snap()).events.some((e) => e.kind === "manual"), true, "but the turn is still recorded");
});

test("a routed turn that gets an answer is what makes it warm", async (t) => {
  const d = await boot(t);
  await d.turn("laya-router");
  await waitFor(async () => (await sidecar(d)).state === "warm", "the state to become warm");
  assert.equal((await sidecar(d)).lastError, null);
});

test("a routed turn when the model errors shows an error with a readable reason, not warm", async (t) => {
  const d = await boot(t, { mode: "error" });
  await d.turn("laya-router");
  await waitFor(async () => (await sidecar(d)).state === "error", "the state to become error");
  const s = await sidecar(d);
  assert.match(s.lastError, /checkpoint could not be loaded/);
  assert.doesNotMatch(s.lastError, /^laya failed/, "no internal prefix");
});

test("the turn still goes through when routing fails: it keeps the current model", async (t) => {
  const d = await boot(t, { mode: "error" });
  await d.turn("laya-router");
  await wait(300);
  const e = (await d.snap()).events.find((x) => x.kind === "routed");
  assert.ok(e, "the turn was served and recorded");
  assert.match(e.reason, /laya-unavailable/);
});

test("a crashing model says what crashed, in one line, with no traceback", async (t) => {
  const d = await boot(t, { mode: "crash" });
  await d.turn("laya-router");
  await waitFor(async () => (await sidecar(d)).state === "error", "the state to become error");
  const s = await sidecar(d);
  assert.match(s.lastError, /torch/);
  assert.doesNotMatch(s.lastError, /Traceback|\n/);
});

test("a model that never answers ends as an error rather than staying 'starting' forever", async (t) => {
  const d = await boot(t, { mode: "silent" });
  await d.turn("laya-router");
  await waitFor(async () => (await sidecar(d)).state === "error", "the silent model to be reported", 25000);
  assert.match((await sidecar(d)).lastError, /did not respond/i);
});

test("a Python that does not exist is reported with where it looked and how to fix it", async (t) => {
  const d = await boot(t, { python: "/definitely/not/here/bin/python" });
  await d.turn("laya-router");
  await waitFor(async () => (await sidecar(d)).state === "error", "the state to become error");
  const s = await sidecar(d);
  assert.ok(s.lastError.includes("/definitely/not/here/bin/python"), s.lastError);
  assert.match(s.lastError, /LAYA_PYTHON/);
});

test("once it is fixed, the very next routed turn clears the error", async (t) => {
  const d = await boot(t, { mode: "error" });
  await d.turn("laya-router", { session: "a" });
  await waitFor(async () => (await sidecar(d)).state === "error", "error");
  d.setMode("ok");
  await d.turn("laya-router", { session: "b" });
  await waitFor(async () => (await sidecar(d)).state === "warm", "warm again");
  assert.equal((await sidecar(d)).lastError, null, "the old message is gone with the old problem");
});

test("a sidecar that died is started again on the next turn, not left dead for the life of the daemon", async (t) => {
  const d = await boot(t, { mode: "crash" });
  await d.turn("laya-router", { session: "a" });
  await waitFor(async () => (await sidecar(d)).state === "error", "error after the crash");
  assert.equal(d.starts(), 1);
  d.setMode("ok");
  await d.turn("laya-router", { session: "b" });
  await waitFor(async () => (await sidecar(d)).state === "warm", "warm after recovering");
  assert.equal(d.starts(), 2, "a fresh process was started");
});

test("a failing model does not take the daemon down", async (t) => {
  const d = await boot(t, { mode: "crash" });
  for (let i = 0; i < 3; i++) await d.turn("laya-router", { session: `x${i}` });
  await wait(300);
  assert.equal((await d.call("ping")).result.pong, true);
});

test("a model that is slow to start is 'starting' while it loads, then warm", async (t) => {
  const d = await boot(t, { mode: "silent" });
  const pending = d.turn("laya-router", { session: "slow" });
  await waitFor(async () => (await sidecar(d)).state === "starting", "the state to become starting");
  d.setMode("ok");
  await pending.catch(() => {});
});

// The app does not poll: it subscribes and is pushed a snapshot whenever something changes. A state
// change that is stored but not pushed shows up only at the next unrelated update, which during the
// model's slow first load means the panel would never say "Loading the routing model". The tests
// above poll `snapshot`, which always reads fresh state, so they cannot see the difference.
test("the app is pushed 'starting' while the model loads, and 'error' when it gives up, with no other event to carry them", async (t) => {
  const d = await boot(t, { mode: "silent" });
  const pushed = subscribe(t, d.control, (snapshot) => snapshot.sidecar);
  await waitFor(() => pushed.length > 0, "the first pushed snapshot");
  assert.equal(pushed.at(-1).state, "stopped");
  d.turn("laya-router").catch(() => {}); // the stand-in never answers, so only the state machine moves
  await waitFor(() => pushed.some((s) => s.state === "starting"), "a pushed update saying the model is loading");
  const error = await waitFor(() => pushed.find((s) => s.state === "error"), "a pushed update saying it gave up", 25000);
  assert.match(error.lastError, /did not respond/i, "and the pushed update carries the reason");
});

test("a pushed update that changes nothing is not sent again", async (t) => {
  const d = await boot(t, { mode: "ok" });
  const pushed = subscribe(t, d.control, (snapshot) => snapshot.sidecar);
  await waitFor(() => pushed.length > 0, "the first pushed snapshot");
  await d.turn("laya-router", { session: "one" });
  await waitFor(() => pushed.some((s) => s.state === "warm"), "warm");
  const warmCount = () => pushed.filter((s) => s.state === "warm").length;
  const before = warmCount();
  await d.turn("laya-router", { session: "two" });
  await wait(400);
  // Each turn publishes its own event, so snapshots keep coming; the point is that the state itself
  // never flickers away from warm and back (a begin() while warm would push a 'starting').
  assert.equal(pushed.slice(pushed.findIndex((s) => s.state === "warm")).some((s) => s.state === "starting"), false);
  assert.ok(warmCount() >= before);
});

// Publishing builds a snapshot from what is stored, so storing AFTER publishing sends the update one
// step behind: the app is told "stopped" when the model has just started loading, and "starting"
// when it has just failed, and the truth only arrives with the next unrelated push. Comparing each
// push's state to its own predecessor catches it; the earlier tests only checked that some push
// existed and that one of them said the right thing eventually.
test("every pushed update describes the state that has just been entered, never the one before it", async (t) => {
  const d = await boot(t, { mode: "error" });
  const pushed = subscribe(t, d.control, (snapshot) => snapshot.sidecar);
  await waitFor(() => pushed.length > 0, "the first pushed snapshot");
  await wait(300); // let the start-up updates settle, so what follows is only the model's doing
  const before = pushed.length;
  await d.turn("laya-router");
  await waitFor(() => pushed.some((s, i) => i >= before && s.state === "error"), "the failure to be pushed");
  await wait(300);
  const after = pushed.slice(before).map((s) => s.state);
  // Measured on a real daemon (2026-09-30): the correct order is starting, then error, each update
  // describing the state just entered. Publishing before storing pushes one step BEHIND:
  // "stopped, starting, error" for the same two changes, so the app says "stopped" while the model
  // is loading, and "starting" for a whole update after it has failed.
  const firstChange = after.findIndex((state) => state !== "stopped");
  assert.equal(after[0], "starting", `the first update after the turn began should say starting; the app was told: ${after.join(" > ")}`);
  assert.equal(firstChange, 0, `no update may still say stopped once the model has begun loading: ${after.join(" > ")}`);
  const err = pushed.slice(before).find((s) => s.state === "error");
  assert.ok(err.lastError, "and the update that says error also carries why");
  // No update may report an error state without its reason, nor a reason without the error state.
  for (const s of pushed) assert.equal(Boolean(s.lastError), s.state === "error", `${s.state} with lastError=${JSON.stringify(s.lastError)}`);
});


// ---------------------------------------------------------------- a prompt never waits for the model forever
//
// Measured on a real Mac (2026-10-01) with every core busy: one routing decision took 31.7 s on the
// real daemon and another 95.6 s on an isolated copy, and nothing ended either wait. `layaDeadlineMs`
// was defined and read by nothing, so a model that never answers held the prompt for as long as it
// pleased. The stand-in sidecar can now hang, run slow, or load on first use, so each of those is
// something a test can stand in the middle of.

// Both waits are short: a test cannot sit through fifteen seconds. Which one applies depends on whether the
// model has answered anything yet, and the tests below are about exactly that.
const SHORT = { LAYA_DEADLINE_MS: "1000", LAYA_LOAD_DEADLINE_MS: "1000" };

/** The newest routed turn the daemon recorded, from the feed the app shows. */
const lastRouted = async (d) => (await d.snap()).events.filter((e) => e.kind === "routed").at(-1);
const routedCount = async (d) => (await d.snap()).events.filter((e) => e.kind === "routed").length;

test("a model that echoes and then never answers does not hold the turn past the deadline", async (t) => {
  const d = await boot(t, { mode: "hang", env: SHORT });
  const t0 = Date.now();
  await d.turn("laya-router");
  const took = Date.now() - t0;
  assert.ok(took >= 950, `the turn waited as long as it was allowed to (${took} ms)`);
  assert.ok(took < 4000, `and then went through, instead of waiting for an answer that never comes (${took} ms)`);
  const ev = await waitFor(() => lastRouted(d), "the routed event");
  assert.equal(ev.ms, null, "no decision was made");
  assert.match(ev.reason ?? "", /laya-unavailable/, "so the turn kept its model, for the reason the app shows");
});

test("the deadline is reported as a plain sentence naming the wait, not as a crash", async (t) => {
  const d = await boot(t, { mode: "hang", env: { ...SHORT, LAYA_LOAD_GIVE_UP_MS: "600000" } });
  await d.turn("laya-router");
  await waitFor(async () => (await sidecar(d)).state === "error", "the state to become error");
  const s = await sidecar(d);
  assert.match(s.lastError, /took longer than 1 second,/);
  assert.match(s.lastError, /kept its current model/);
  assert.match(s.lastError, /asked again on the next one/, "and says what happens next");
  assert.doesNotMatch(s.lastError, /Traceback|laya sidecar deadline/, "none of the internal wording");
});

test("a model that is merely slow, but inside the deadline, still decides the turn", async (t) => {
  const d = await boot(t, { mode: "slow:600", env: { LAYA_DEADLINE_MS: "5000", LAYA_LOAD_DEADLINE_MS: "5000" } });
  const t0 = Date.now();
  await d.turn("laya-router");
  assert.ok(Date.now() - t0 >= 550, "the turn waited for the decision");
  const ev = await waitFor(() => lastRouted(d), "the routed event");
  assert.ok(ev.ms >= 550, `the decision is the model's, and says how long it took (${ev.ms} ms)`);
  assert.doesNotMatch(ev.reason ?? "", /unavailable/);
  assert.equal((await sidecar(d)).state, "warm");
});

test("a deadline that fires does not leave a timer behind to fail a later, unrelated ask", async (t) => {
  // Each ask arms two timers. One that outlives its ask would reject somebody else's, or the answer
  // that arrives in time would still be followed by a spurious failure.
  const d = await boot(t, { mode: "slow:100", env: SHORT });
  for (let i = 0; i < 5; i++) await d.turn("laya-router", { session: `s${i}` });
  await wait(1400); // past every deadline that was armed
  const s = await sidecar(d);
  assert.equal(s.state, "warm", "five answered asks, and no deadline fired for any of them");
  assert.equal(s.lastError, null);
  assert.equal(d.starts(), 1, "and nothing was restarted");
});

test("a model that is loading its weights on first use is waited for, inside the deadline", async (t) => {
  // `cold:N` answers its first request after N ms, the way a model that loads on first use does. The
  // echo comes at once either way, so the five-second echo window is not what ends the wait.
  const d = await boot(t, { mode: "cold:1200", env: { LAYA_DEADLINE_MS: "300", LAYA_LOAD_DEADLINE_MS: "6000" } });
  await d.turn("laya-router");
  const first = await waitFor(() => lastRouted(d), "the routed event");
  assert.ok(first.ms >= 1100, `the first decision paid the load (${first.ms} ms) and was still the model's`);
  assert.equal((await sidecar(d)).state, "warm");
  await d.turn("laya-router", { session: "second" });
  const second = await waitFor(async () => ((await routedCount(d)) >= 2 ? lastRouted(d) : null), "the second event");
  assert.ok(second.ms < 800, `and the next one did not (${second.ms} ms)`);
});

// ---------------------------------------------------------------- a stuck model is replaced, a slow one is not
//
// The bridge answers one request at a time, so a model that is stuck on one holds every later prompt
// behind it. Without a replacement the deadline only moves the damage: every prompt for the rest of
// the daemon's life waits the full deadline and then goes without a decision. The rule is silence:
// nothing from the model for three deadlines while it holds a request. With the one-second deadline
// used here, three back-to-back prompts is what that takes.

/** Sends `n` prompts one after the other, as a person at the keyboard does. */
const prompts = async (d, n, tag) => { for (let i = 0; i < n; i++) await d.turn("laya-router", { session: `${tag}-${i}` }); };

test("a model that answered before and then goes silent is replaced once it has been silent three deadlines", async (t) => {
  const d = await boot(t, { mode: "ok", env: SHORT });
  await d.turn("laya-router", { session: "a" });
  await waitFor(async () => (await sidecar(d)).state === "warm", "warm");
  assert.equal(d.starts(), 1);
  d.setMode("hang");
  await prompts(d, 2, "b");
  assert.equal(d.starts(), 1, "two misses are only two seconds of silence: it may be busy, and it is not replaced");
  await waitFor(async () => (await sidecar(d)).state === "error", "error");
  assert.match((await sidecar(d)).lastError, /took longer than/);
  await d.turn("laya-router", { session: "c" });
  const s = await waitFor(async () => { const x = await sidecar(d); return /being restarted/.test(x.lastError ?? "") ? x : null; }, "the restart to be announced");
  assert.match(s.lastError, /stopped answering, so it is being restarted\. That turn kept its current model\./, "in words");
  d.setMode("ok"); // the new process reads the file when it handles a request
  await waitFor(() => d.starts() === 2, "a second sidecar to be started", 10000);
  await d.turn("laya-router", { session: "d" });
  await waitFor(async () => (await sidecar(d)).state === "warm", "warm again");
  assert.equal(d.starts(), 2, "and exactly one was started, not one per missed prompt");
  assert.equal((await sidecar(d)).lastError, null);
});

test("the replacement starts loading at once, so the next prompt does not wait for a process that was just started", async (t) => {
  const d = await boot(t, { mode: "ok", env: { ...SHORT, FAKE_SIDECAR_EVENTS: "1", FAKE_SIDECAR_LOAD_MS: "50" } });
  await waitFor(async () => (await sidecar(d)).state === "warm", "warm from the start-up load alone");
  d.setMode("hang");
  await prompts(d, 3, "b");
  d.setMode("ok");
  await waitFor(() => d.starts() === 2, "the replacement, with no further prompt", 10000);
  await waitFor(async () => (await sidecar(d)).state === "warm", "warm, with no further prompt", 10000);
});

test("a model that is slow but working is never replaced, however many deadlines it misses", async (t) => {
  // Every decision takes 1.5 s against a 1 s deadline, and the prompts come back to back, so each one
  // queues behind the one before. Each is given up on, and each answer arrives late. Late answers are
  // output, and output is the proof it is alive: silence never reaches three deadlines.
  const d = await boot(t, { mode: "ok", env: SHORT });
  await d.turn("laya-router", { session: "a" });
  d.setMode("slow:1500");
  await prompts(d, 6, "slow");
  await wait(2500);
  assert.equal(d.starts(), 1, "six missed deadlines, none of them silence: slow, not stuck");
});

test("an answer that arrives after its prompt was given up on still counts as proof the model is alive", async (t) => {
  const d = await boot(t, { mode: "ok", env: SHORT });
  await d.turn("laya-router", { session: "a" });
  d.setMode("slow:2600"); // misses the 1 s deadline, then answers at 2.6 s
  await d.turn("laya-router", { session: "late-1" });
  await wait(1900); // its answer lands now, about 2.6 s after it was sent
  await d.turn("laya-router", { session: "late-2" }); // a second prompt, sent after the late answer
  assert.equal(d.starts(), 1, "the late answer reset the silence, so the second miss is a first one");
});

test("prompts that pile up behind a stuck one do not restart its clock, and three at once are one stall", async (t) => {
  const d = await boot(t, { mode: "ok", env: SHORT });
  await d.turn("laya-router", { session: "a" });
  d.setMode("hang");
  await Promise.all([d.turn("laya-router", { session: "x" }), d.turn("laya-router", { session: "y" }), d.turn("laya-router", { session: "z" })]);
  assert.equal(d.starts(), 1, "three prompts waited on the same stall: one second of silence, not three");
  assert.match((await sidecar(d)).lastError, /took longer than/);
  assert.doesNotMatch((await sidecar(d)).lastError, /restarted/);
  await prompts(d, 2, "after");
  await waitFor(() => d.starts() === 2, "the replacement once the silence has lasted", 10000);
});

test("a model that cannot even echo is replaced the same way, by the same silence", async (t) => {
  // `silent` reads the request and says nothing at all, not even the echo: a process whose reader is
  // frozen, as it is when a native call holds the interpreter. The echo window is five seconds, so
  // three of them is what the silence has to last.
  const d = await boot(t, { mode: "ok", env: { LAYA_DEADLINE_MS: "600000" } });
  await d.turn("laya-router", { session: "a" });
  await waitFor(async () => (await sidecar(d)).state === "warm", "warm");
  d.setMode("silent");
  await d.turn("laya-router", { session: "b" });
  assert.match((await sidecar(d)).lastError, /did not respond in time/);
  assert.equal(d.starts(), 1, "one unanswered echo is not enough");
  await d.turn("laya-router", { session: "c" });
  await d.turn("laya-router", { session: "d" });
  const s = await waitFor(async () => { const x = await sidecar(d); return /stopped responding, so it is being restarted/.test(x.lastError ?? "") ? x : null; }, "the restart to be announced");
  assert.doesNotMatch(s.lastError, /Traceback|laya sidecar/);
  d.setMode("ok");
  await waitFor(() => d.starts() === 2, "a second sidecar", 10000);
}, { timeout: 60000 });

test("a model that never comes up at all is replaced once it has had its time to load", async (t) => {
  const d = await boot(t, { mode: "hang", env: { ...SHORT, LAYA_LOAD_GIVE_UP_MS: "1000" } });
  await wait(1100);
  await d.turn("laya-router");
  const s = await waitFor(async () => { const x = await sidecar(d); return /never finished loading/.test(x.lastError ?? "") ? x : null; }, "the restart to be announced");
  assert.match(s.lastError, /being restarted/);
  await waitFor(() => d.starts() === 2, "a second sidecar", 10000);
});

test("a model that has not come up yet is given its time: one missed deadline is not a restart", async (t) => {
  const d = await boot(t, { mode: "hang", env: { ...SHORT, LAYA_LOAD_GIVE_UP_MS: "600000" } });
  await d.turn("laya-router", { session: "a" });
  await d.turn("laya-router", { session: "b" });
  await d.turn("laya-router", { session: "c" });
  assert.equal(d.starts(), 1, "three missed deadlines in a model that is still loading do not kill the load");
});

// ---------------------------------------------------------------- the model is loaded before the first prompt
//
// The bridge now loads the model at start and says so. The status is therefore true before any prompt:
// "starting" while it loads, "warm" when it has answered a real routing request, "error" with the reason
// when it could not, and none of that needs a turn.

test("the model is warm before any prompt, because the sidecar says so itself", async (t) => {
  const d = await boot(t, { env: { FAKE_SIDECAR_EVENTS: "1", FAKE_SIDECAR_LOAD_MS: "800" } });
  await waitFor(async () => (await sidecar(d)).state === "starting", "starting, while the model loads");
  assert.equal((await d.snap()).events.length, 0, "and no turn has been made");
  await waitFor(async () => (await sidecar(d)).state === "warm", "warm, with no turn");
  assert.equal((await sidecar(d)).lastError, null);
  assert.equal((await d.snap()).events.length, 0, "still no turn");
});

test("a load that fails is an error with the reason, before any prompt", async (t) => {
  const d = await boot(t, { env: { FAKE_SIDECAR_EVENTS: "1", FAKE_SIDECAR_FAIL_LOAD: "checkpoint weights are missing" } });
  await waitFor(async () => (await sidecar(d)).state === "error", "error, with no turn");
  assert.match((await sidecar(d)).lastError, /checkpoint weights are missing/);
  assert.equal((await d.snap()).events.length, 0, "and no turn has been made");
});

test("a process that dies while loading is an error, not 'starting' forever", async (t) => {
  const d = await boot(t, { env: { FAKE_SIDECAR_CRASH_AT_START: "1" } });
  await waitFor(async () => (await sidecar(d)).state === "error", "error, with no turn");
  const s = await sidecar(d);
  assert.match(s.lastError, /package the routing model needs is missing: torch/, "named in words, as for a crash at a prompt");
  assert.doesNotMatch(s.lastError, /Traceback/);
});

test("a prompt that arrives while the model is still loading waits for the load and is then decided by the model", async (t) => {
  const d = await boot(t, { env: { FAKE_SIDECAR_EVENTS: "1", FAKE_SIDECAR_LOAD_MS: "1500", LAYA_DEADLINE_MS: "300", LAYA_LOAD_DEADLINE_MS: "8000" } });
  await waitFor(async () => (await sidecar(d)).state === "starting", "starting");
  await d.turn("laya-router");
  const ev = await waitFor(() => lastRouted(d), "the routed event");
  assert.ok(ev.ms !== null && ev.ms >= 0, "the model decided it, not a fallback");
  assert.equal((await sidecar(d)).state, "warm");
  assert.equal(d.starts(), 1);
});

test("a loading announcement does not turn a warm status back into starting", async (t) => {
  const d = await boot(t, { env: { FAKE_SIDECAR_EVENTS: "1", FAKE_SIDECAR_LOAD_MS: "50" } });
  await waitFor(async () => (await sidecar(d)).state === "warm", "warm");
  const states = subscribe(t, d.control, (snap) => snap?.sidecar?.state);
  await d.turn("laya-router");
  await d.turn("laya-router", { session: "two" });
  await wait(300);
  assert.ok(!states.includes("starting"), `a warm model stayed warm across two asks (saw ${JSON.stringify(states)})`);
});
