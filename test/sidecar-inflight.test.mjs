// The sidecar class itself, in this process, against the stand-in sidecar.
//
// test/sidecar-truth.test.mjs drives a whole daemon and proves what the app is told; it is slow (a
// second per missed deadline) and sees only what the daemon exposes. These reach the class directly with
// deadlines of a fifth of a second, so the rule for replacing a stuck model can be checked exactly, in
// the cases that decide it: a model that was idle, one that is slow but working, one that is failing
// slowly, one that is frozen. Each of those looks the same from the outside (a prompt that missed its
// deadline) and only the history tells them apart.
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wait, waitFor } from "./helpers.mjs";
import { THRESHOLDS } from "../src/config.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const home = mkdtempSync(join(tmpdir(), "laya-inflight-"));
const modeFile = join(home, "mode");
const startLog = join(home, "starts.log");
const wrapper = join(home, "fake-python");
writeFileSync(modeFile, "ok");
writeFileSync(startLog, "");
writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${join(REPO, "test", "fixtures", "fake-sidecar.mjs")}"\n`, { mode: 0o755 });
process.env.LAYA_PYTHON = wrapper;
process.env.FAKE_SIDECAR_MODE = modeFile;
process.env.FAKE_SIDECAR_LOG = startLog;
// Each test waits a few windows of 200 ms; the load clock must not be what ends a model's life here.
process.env.LAYA_LOAD_GIVE_UP_MS = "600000";

const { getSidecar, sidecarTracker } = await import("../src/router.mjs");

const REQ = { state: "Add pagination.", current_model: "claude-sonnet-5-5", context_tokens: 10, models: [{ id: "claude-sonnet-5-5", tier: "sonnet" }] };
const setMode = (mode) => writeFileSync(modeFile, mode);
const starts = () => readFileSync(startLog, "utf8").split("\n").filter(Boolean).length;
const outcome = (p) => p.then((value) => ({ value }), (error) => ({ error }));
const WINDOW = 200;

/** A sidecar that has never been asked anything, whatever the last test left behind. */
async function fresh(t, { mode = "ok", env = {} } = {}) {
  const old = getSidecar();
  if (!old.dead) {
    old.child.kill("SIGKILL");
    await once(old.child, "exit");
  }
  setMode(mode);
  // The start log is shared by every test in this file; each one counts only its own sidecars.
  writeFileSync(startLog, "");
  sidecarTracker.store.set("stopped");
  // Kept for the whole test, not only while the process starts: the child reads its own settings when
  // it is spawned, and the router reads the load give-up time each time it judges a stall.
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  const sc = getSidecar();
  t.after(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    const current = getSidecar();
    if (!current.dead) {
      current.child.kill("SIGKILL");
      await once(current.child, "exit");
    }
  });
  return sc;
}

/** Asks once and waits for the answer, so the sidecar has proved its model works. */
async function prove(sc) {
  const r = await outcome(sc.ask(REQ, { deadline: 5000 }));
  assert.ok(r.value?.answers, `the first ask was answered (${r.error?.message})`);
  assert.equal(sc.proven, true);
}

// ---------------------------------------------------------------- what is in flight

test("a request is in flight from the moment it is sent until the sidecar sends something for it or after it", async (t) => {
  const sc = await fresh(t, { mode: "slow:400" });
  const [p1, p2, p3] = [sc.ask(REQ, { deadline: 60000 }), sc.ask(REQ, { deadline: 60000 }), sc.ask(REQ, { deadline: 60000 })];
  assert.deepEqual([...sc.inflight.keys()], [1, 2, 3], "all three are held, in the order they were sent");
  await p1;
  assert.deepEqual([...sc.inflight.keys()], [2, 3], "the first answer releases the first request and nothing else");
  await p2;
  assert.deepEqual([...sc.inflight.keys()], [3]);
  await p3;
  assert.deepEqual([...sc.inflight.keys()], [], "and an answered request is not held any longer");
});

test("a request that failed with an error line is released too, and the error counts as hearing from the sidecar", async (t) => {
  const sc = await fresh(t, { mode: "slowerror:300" });
  assert.equal(sc.lastOutputAt, 0, "nothing heard yet");
  const first = outcome(sc.ask(REQ, { deadline: 60000 }));
  const second = outcome(sc.ask(REQ, { deadline: 60000 }));
  const r = await first;
  assert.match(r.error.message, /checkpoint could not be loaded/);
  assert.deepEqual([...sc.inflight.keys()], [2], "the failed request is released, the one behind it is not");
  assert.ok(Date.now() - sc.lastOutputAt < 500, "the error line is output, and is timestamped when it arrives");
  await second;
  assert.deepEqual([...sc.inflight.keys()], []);
});

test("the bare echo is not hearing from the sidecar: a reader thread can echo while the model is frozen", async (t) => {
  const sc = await fresh(t, { mode: "hang" });
  const held = outcome(sc.ask(REQ, { deadline: 60000 }));
  await waitFor(() => sc.pending.get(1)?.sawAck, "the echo to arrive", 3000);
  assert.equal(sc.lastOutputAt, 0, "it echoed, and that says nothing about the model");
  assert.deepEqual([...sc.inflight.keys()], [1], "the request is still held");
  assert.equal(sc.proven, false);
  sc.child.kill("SIGKILL");
  await held;
});

test("a late answer counts as proof of life even though nobody is waiting for it any more", async (t) => {
  const sc = await fresh(t, { mode: "slow:700" });
  const r = await outcome(sc.ask(REQ, { deadline: WINDOW }));
  assert.match(r.error.message, /no answer in 1s/);
  assert.equal(sc.proven, false, "nothing has been heard yet");
  assert.deepEqual([...sc.inflight.keys()], [1], "and the abandoned request is still counted as held");
  await waitFor(() => sc.proven, "the late answer to arrive", 3000);
  assert.deepEqual([...sc.inflight.keys()], [], "the late answer releases it");
  assert.ok(Date.now() - sc.lastOutputAt < 500);
});

test("'ready' is proof the model works, and counts as hearing from it", async (t) => {
  const sc = await fresh(t, { env: { FAKE_SIDECAR_EVENTS: "1", FAKE_SIDECAR_LOAD_MS: "300" } });
  assert.equal(sc.proven, false, "still loading");
  await waitFor(() => sc.proven, "ready", 3000);
  assert.ok(sc.lastOutputAt > 0 && Date.now() - sc.lastOutputAt < 1000);
});

// ---------------------------------------------------------------- how long a request may wait

test("a model that has answered is held to LAYA_DEADLINE_MS, read when the ask is made", async (t) => {
  // The daemon never passes a deadline; this default is the whole of how a person's setting reaches it.
  const sc = await fresh(t, { env: { LAYA_DEADLINE_MS: "1000", LAYA_LOAD_DEADLINE_MS: "30000" } });
  await prove(sc);
  setMode("hang");
  const started = Date.now();
  const r = await outcome(sc.ask(REQ));
  const took = Date.now() - started;
  assert.match(r.error.message, /no answer in 1s$/);
  assert.ok(took >= 950 && took < 3000, `one second, as set, not the 30 s loading allowance (${took} ms)`);
});

test("a model that has not answered anything yet is held to the longer loading allowance", async (t) => {
  // A load is not a stall. The first ask of a command-line run is made the moment the process starts,
  // and on a slow machine it waits behind the whole load.
  const sc = await fresh(t, { mode: "slow:1500", env: { LAYA_DEADLINE_MS: "400", LAYA_LOAD_DEADLINE_MS: "5000" } });
  assert.equal(sc.proven, false);
  const r = await outcome(sc.ask(REQ));
  assert.ok(r.value?.answers, `waited the 5 s loading allowance, not the 0.4 s steady one, and was answered (${r.error?.message})`);
});

test("the loading allowance ends too: a model that never answers is not waited for forever", async (t) => {
  const sc = await fresh(t, { mode: "hang", env: { LAYA_DEADLINE_MS: "300", LAYA_LOAD_DEADLINE_MS: "1000" } });
  const started = Date.now();
  const r = await outcome(sc.ask(REQ));
  assert.match(r.error.message, /no answer in 1s$/);
  assert.ok(Date.now() - started >= 950, "it waited the loading allowance (1 s), not the steady deadline (0.3 s)");
});

test("once the model has answered, the shorter deadline applies from the next ask", async (t) => {
  const sc = await fresh(t, { mode: "slow:200", env: { LAYA_DEADLINE_MS: "5000", LAYA_LOAD_DEADLINE_MS: "30000" } });
  assert.equal(sc.proven, false);
  await outcome(sc.ask(REQ));
  assert.equal(sc.proven, true);
  setMode("hang");
  const started = Date.now();
  const r = await outcome(sc.ask(REQ, {}));
  assert.ok(Date.now() - started >= 4500 && Date.now() - started < 9000, "five seconds, the steady deadline, now that it has answered");
  assert.match(r.error.message, /no answer in 5s$/);
}, { timeout: 30000 });

test("with nothing set, an ask waits the default, and an explicit deadline overrides both", async (t) => {
  const sc = await fresh(t, { mode: "hang", env: { LAYA_DEADLINE_MS: "not a number" } });
  const started = Date.now();
  const pending = outcome(sc.ask(REQ, { deadline: 400 }));
  const r = await pending;
  assert.ok(Date.now() - started < 2000, "the explicit 400 ms won over the default");
  assert.match(r.error.message, /no answer in 1s$/);
  assert.equal(sc.pending.size, 0);
});

// ---------------------------------------------------------------- when a silent model is replaced

test("silence while holding a request, for three windows, replaces the model; two windows does not", async (t) => {
  const sc = await fresh(t);
  await prove(sc);
  setMode("hang");
  const errors = [];
  for (let i = 0; i < 4; i++) {
    const r = await outcome(sc.ask(REQ, { deadline: WINDOW }));
    errors.push(r.error.message);
    if (i === 1) assert.equal(sc.dead, false, "about two windows of silence: it may be busy");
  }
  assert.ok(errors.slice(0, 2).every((m) => !/restarting/.test(m)), `the first two only missed: ${JSON.stringify(errors.slice(0, 2))}`);
  assert.match(errors.at(-1) + errors.at(-2), /restarting: stuck/, "by the fourth miss it has been silent for four windows and is replaced");
  assert.equal(sc.dead, true);
  assert.equal(sc.restarting, true);
  await waitFor(() => starts() === 2, "the replacement to be started with nobody asking for it", 3000);
  await wait(300);
  assert.equal(starts(), 2, "once");
});

test("a model that sat idle and then takes one slow prompt is not replaced for the idle time", async (t) => {
  // The silence that matters is silence while a request is waiting. A model that answered once and was
  // then left alone for a minute has not been silent, it has had nothing to say.
  const sc = await fresh(t);
  await prove(sc);
  await wait(1100); // more than five windows with nothing in flight
  setMode("slow:350");
  const r = await outcome(sc.ask(REQ, { deadline: WINDOW }));
  assert.match(r.error.message, /no answer in 1s$/, "the prompt missed its deadline, plainly");
  assert.equal(sc.dead, false, "and the model that was idle is not blamed for the minute nobody asked it anything");
  await wait(400);
  assert.equal(starts(), 1);
});

test("a model that is slow but working is never replaced, however many deadlines it misses", async (t) => {
  const sc = await fresh(t);
  await prove(sc);
  setMode("slow:380"); // every request misses the 200 ms window, then is answered 180 ms later
  for (let i = 0; i < 8; i++) {
    const r = await outcome(sc.ask(REQ, { deadline: WINDOW }));
    assert.match(r.error?.message ?? "", /no answer in 1s$/, `ask ${i} missed its window`);
    assert.equal(sc.dead, false, `ask ${i}: answers keep arriving, so it is alive`);
  }
  assert.equal(starts(), 1);
});

test("a model that is failing slowly is alive, and is not replaced either", async (t) => {
  // An error line is output from the worker: it proves the process is running its loop, which a stuck
  // process never does.
  const sc = await fresh(t);
  await prove(sc);
  setMode("slowerror:380");
  for (let i = 0; i < 8; i++) {
    const r = await outcome(sc.ask(REQ, { deadline: WINDOW }));
    assert.match(r.error?.message ?? "", /no answer in 1s$/);
    assert.equal(sc.dead, false, `ask ${i}`);
  }
  assert.equal(starts(), 1);
});

test("prompts that pile up behind a stuck one are one stall, not several", async (t) => {
  const sc = await fresh(t);
  await prove(sc);
  setMode("hang");
  const rs = await Promise.all([1, 2, 3, 4, 5, 6].map(() => outcome(sc.ask(REQ, { deadline: WINDOW }))));
  assert.ok(rs.every((r) => /no answer in 1s$/.test(r.error.message)), "six prompts, all at once, all missed");
  assert.equal(sc.dead, false, "silence is counted from the oldest of them, so six at once is one window, not six");
});

test("a model that has not come up yet is given its time, and replaced when it has had it and is still silent", async (t) => {
  const sc = await fresh(t, { mode: "hang", env: { LAYA_LOAD_GIVE_UP_MS: "1500" } });
  const early = await outcome(sc.ask(REQ, { deadline: WINDOW }));
  assert.match(early.error.message, /no answer in 1s$/);
  assert.equal(sc.dead, false, "young: still allowed to be loading");
  await wait(1500);
  const late = await outcome(sc.ask(REQ, { deadline: WINDOW }));
  assert.match(late.error.message, /restarting: never-loaded/);
  assert.equal(sc.dead, true);
  await waitFor(() => starts() === 2, "the replacement", 3000);
});

test("a model that cannot even echo is replaced by the same rule: silence for three windows while holding a request", async (t) => {
  // `silent` reads the line and says nothing at all, not even the echo: a process whose reader is frozen,
  // as it is when a native call holds the interpreter. The echo window is a constant of five seconds, so
  // the test shortens it for its own duration; the rule under test is the one the deadline path uses.
  const was = THRESHOLDS.ackMs;
  THRESHOLDS.ackMs = WINDOW;
  t.after(() => { THRESHOLDS.ackMs = was; });
  const sc = await fresh(t);
  await prove(sc);
  setMode("silent");
  const first = await outcome(sc.ask(REQ, { deadline: 600000 }));
  assert.match(first.error.message, /^laya sidecar unresponsive:/, "one window of silence: it did not respond, and that is all that is said");
  assert.equal(sc.dead, false);
  const second = await outcome(sc.ask(REQ, { deadline: 600000 }));
  assert.match(second.error.message, /^laya sidecar unresponsive:/, "two windows: still only that");
  assert.equal(sc.dead, false, "and it has not been replaced yet");
  const third = await outcome(sc.ask(REQ, { deadline: 600000 }));
  assert.match(third.error.message, /^laya sidecar unresponsive \(restarting: stuck\):/, "three windows of silence, and it is replaced");
  assert.equal(sc.dead, true);
  await waitFor(() => starts() === 2, "the replacement to be started", 3000);
});

test("a model that has not come up yet and cannot echo is given its time, then replaced", async (t) => {
  const was = THRESHOLDS.ackMs;
  THRESHOLDS.ackMs = WINDOW;
  t.after(() => { THRESHOLDS.ackMs = was; });
  const sc = await fresh(t, { mode: "silent", env: { LAYA_LOAD_GIVE_UP_MS: "1200" } });
  const early = await outcome(sc.ask(REQ, { deadline: 600000 }));
  assert.match(early.error.message, /^laya sidecar unresponsive:/);
  assert.equal(sc.dead, false, "young: it may still be starting");
  await wait(1200);
  const late = await outcome(sc.ask(REQ, { deadline: 600000 }));
  assert.match(late.error.message, /^laya sidecar unresponsive \(restarting: never-loaded\):/);
  await waitFor(() => starts() === 2, "the replacement", 3000);
});

// ---------------------------------------------------------------- a timer whose ask is gone does nothing
//
// Each ask arms two timers and neither is cleared when the ask ends some other way. What stops a timer
// from acting is one check at the top: is my ask still waiting? These pin what that check prevents.

/** Shortens the echo window for one test and puts it back. */
function echoWindow(t, ms) {
  const was = THRESHOLDS.ackMs;
  THRESHOLDS.ackMs = ms;
  t.after(() => { THRESHOLDS.ackMs = was; });
}

test("an ask whose echo arrived is not failed by the echo window, however long the answer takes", async (t) => {
  // The echo says "I read your line"; once it is in, the echo window has nothing left to judge. A model
  // that takes longer than the window to decide is slow, and it is the deadline that ends that wait.
  echoWindow(t, 300);
  const sc = await fresh(t, { mode: "slow:1000" });
  const r = await outcome(sc.ask(REQ, { deadline: 5000 }));
  assert.ok(r.value?.answers, `answered at about a second, after the 300 ms window had passed (${r.error?.message})`);
});

test("the deadline timer of an ask that already ended does nothing: it cannot replace the model", async (t) => {
  // A model that has never come up and fails every request with an error line has each ask end at once.
  // Fifteen seconds later (here 1.8) that ask's deadline timer fires; if it acted, it would judge the
  // model as it is then, old enough to be called "never loaded", and kill it for an ask that was answered.
  const sc = await fresh(t, { mode: "error", env: { LAYA_LOAD_GIVE_UP_MS: "1000" } });
  const r = await outcome(sc.ask(REQ, { deadline: 1800 }));
  assert.match(r.error.message, /checkpoint could not be loaded/, "the ask ended at once, with the model's own words");
  assert.equal(sc.dead, false);
  await wait(2300); // past that ask's deadline timer, and past the second the model is allowed to take to come up
  assert.equal(sc.dead, false, "an ask that was answered cannot get the model replaced");
  assert.equal(starts(), 1);
});

test("the echo window's timer of an ask that already ended does nothing either", async (t) => {
  echoWindow(t, 2000);
  const sc = await fresh(t, { mode: "silent", env: { LAYA_LOAD_GIVE_UP_MS: "1200" } });
  const r = await outcome(sc.ask(REQ, { deadline: 300 })); // ended by its deadline, long before the echo window
  assert.match(r.error.message, /no answer in 1s$/, "plain, and the model is too young to be replaced for it");
  assert.equal(sc.dead, false);
  await wait(2300); // past the echo window, and past the 1.2 s the model is allowed to take to come up
  assert.equal(sc.dead, false, "an ask that ended cannot get the model replaced by a timer that was left behind");
  assert.equal(starts(), 1);
});

// ---------------------------------------------------------------- a process that is finished with the router can exit

test("the timers an ask leaves behind do not keep a finished process alive", async (t) => {
  // `laya-claude -p` and the live-routing script use the sidecar and then simply end. Each ask arms a
  // 5 s and a 15 s timer that nothing clears, so unless both are unref'd the process would sit for up to
  // fifteen seconds after its work was done. The sidecar and its pipes are shut down by hand here: they
  // are what the real launcher ends with process.exit, and are not what is being tested.
  const dir = mkdtempSync(join(tmpdir(), "laya-exit-"));
  const script = `
    import { getSidecar } from ${JSON.stringify(join(REPO, "src", "router.mjs"))};
    const sc = getSidecar();
    await sc.ask({ state: "x", current_model: "claude-sonnet-5-5", context_tokens: 1, models: [{ id: "claude-sonnet-5-5", tier: "sonnet" }] }, { deadline: 4000 });
    process.stdout.write("answered " + Date.now() + "\\n");
    sc.child.kill("SIGKILL");
    sc.child.stdin.destroy(); sc.child.stdout.destroy(); sc.child.stderr.destroy();
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    env: { PATH: process.env.PATH, HOME: dir, LAYA_PYTHON: wrapper, FAKE_SIDECAR_MODE: modeFile },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGKILL"));
  let out = "";
  let err = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (err += c));
  setMode("ok");
  const [code] = await once(child, "exit");
  const exitedAt = Date.now();
  const answered = Number(/answered (\d+)/.exec(out)?.[1]);
  assert.ok(answered, `the ask was answered (${err.slice(0, 200)})`);
  assert.equal(code, 0, err.slice(0, 200));
  assert.ok(exitedAt - answered < 1500, `it exited ${exitedAt - answered} ms after its work was done, not after its 4 s deadline or 5 s echo window`);
});

test("the echo timer of an ask that never got an echo does not keep a finished process alive either", async (t) => {
  // When the sidecar answers nothing at all, not even the echo, the 5 s echo timer is still pending when
  // the ask has ended by its deadline. It is the only thing left to hold the process, and it must not.
  const dir = mkdtempSync(join(tmpdir(), "laya-exit2-"));
  const script = `
    import { getSidecar } from ${JSON.stringify(join(REPO, "src", "router.mjs"))};
    const sc = getSidecar();
    await sc.ask({ state: "x", current_model: "claude-sonnet-5-5", context_tokens: 1, models: [{ id: "claude-sonnet-5-5", tier: "sonnet" }] }, { deadline: 300 }).catch(() => {});
    process.stdout.write("ended " + Date.now() + "\\n");
    sc.child.kill("SIGKILL");
    sc.child.stdin.destroy(); sc.child.stdout.destroy(); sc.child.stderr.destroy();
  `;
  setMode("silent");
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    env: { PATH: process.env.PATH, HOME: dir, LAYA_PYTHON: wrapper, FAKE_SIDECAR_MODE: modeFile },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGKILL"));
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  const [code] = await once(child, "exit");
  const exitedAt = Date.now();
  const endedAt = Number(/ended (\d+)/.exec(out)?.[1]);
  assert.ok(endedAt, "the ask ended by its deadline");
  assert.equal(code, 0);
  assert.ok(exitedAt - endedAt < 1500, `it exited ${exitedAt - endedAt} ms after its work was done, not after the 5 s echo window`);
});

// ---------------------------------------------------------------- what the sidecar says about itself
//
// Lines with an "event" in them are not answers: they are the bridge telling the router how its model is
// doing. They are fed straight to the stdout handler here, the way the existing replaced-process test
// does, so each one can be checked on its own and none of these waits for a model.

const say = (sc, event) => sc.child.stdout.emit("data", `${JSON.stringify(event)}\n`);
const status = () => sidecarTracker.store.get();

test("'loading' makes a status that knew nothing 'starting'; 'ready' makes it warm; 'failed' makes it an error with the reason", async (t) => {
  const sc = await fresh(t);
  assert.equal(status().state, "stopped");
  say(sc, { event: "loading" });
  assert.equal(status().state, "starting");
  say(sc, { event: "ready", ms: 5 });
  assert.equal(status().state, "warm");
  assert.equal(sc.proven, true, "and ready is proof the model works");
  say(sc, { event: "failed", error: "laya failed: checkpoint weights are missing" });
  assert.equal(status().state, "error");
  assert.equal(status().error, "checkpoint weights are missing", "the reason, without the internal prefix");
});

test("an event that is not one of those three changes nothing", async (t) => {
  const sc = await fresh(t);
  say(sc, { event: "ready", ms: 5 });
  say(sc, { event: "something-the-bridge-may-say-one-day" });
  assert.equal(status().state, "warm");
  assert.equal(sc.pending.size, 0);
});

test("an event is not an answer: an ask waiting for its own answer is still waiting after one", async (t) => {
  const sc = await fresh(t, { mode: "hang" });
  const pending = outcome(sc.ask(REQ, { deadline: 700 }));
  await wait(100);
  say(sc, { event: "ready", ms: 5 });
  say(sc, { event: "loading" });
  assert.equal(sc.pending.size, 1, "still waiting: nothing answered it");
  const r = await pending;
  assert.match(r.error.message, /no answer in 1s$/, "and it ends by its deadline, not by an event");
});

test("a line from the sidecar while an ask waits for its echo keeps the echo window from failing that ask", async (t) => {
  // Any line is proof the process is running and reading. The ask that is still waiting for its echo is
  // then waiting on a busy sidecar, not a dead one, and it is the deadline that ends it, not the echo window.
  const was = THRESHOLDS.ackMs;
  THRESHOLDS.ackMs = 400;
  t.after(() => { THRESHOLDS.ackMs = was; });
  const sc = await fresh(t, { mode: "silent" });
  const started = Date.now();
  const pending = outcome(sc.ask(REQ, { deadline: 1000 }));
  await wait(150);
  say(sc, { event: "loading" });
  const r = await pending;
  assert.match(r.error.message, /no answer in 1s$/, `it ended by the deadline, not as unresponsive: ${r.error.message}`);
  assert.ok(Date.now() - started >= 950, "it was given the whole deadline");
});

test("without that line, the same ask fails at the echo window, as unresponsive", async (t) => {
  const was = THRESHOLDS.ackMs;
  THRESHOLDS.ackMs = 400;
  t.after(() => { THRESHOLDS.ackMs = was; });
  const sc = await fresh(t, { mode: "silent" });
  const started = Date.now();
  const r = await outcome(sc.ask(REQ, { deadline: 1000 }));
  assert.match(r.error.message, /^laya sidecar unresponsive:/);
  assert.ok(Date.now() - started < 900, "and it did not wait for the deadline");
});

// ---------------------------------------------------------------- the process around it

test("writing to a sidecar that has already closed its input does not take this process down", async (t) => {
  const sc = await fresh(t);
  sc.child.stdin.end();
  const r = outcome(sc.ask(REQ, { deadline: 5000 }));
  const settled = await r;
  assert.match(settled.error.message, /laya sidecar exited/, "the ask is told the sidecar is gone, instead of the process being killed by an unhandled stream error");
});

test("a sidecar that is replaced takes its exit hook with it, so replacements do not pile up", async (t) => {
  const before = process.listenerCount("exit");
  const old = getSidecar();
  if (!old.dead) {
    old.child.kill("SIGKILL");
    await once(old.child, "exit");
  }
  const baseline = process.listenerCount("exit");
  assert.ok(baseline <= before, "starting point: no sidecar alive");
  for (let i = 0; i < 4; i++) {
    const sc = getSidecar();
    sc.child.kill("SIGKILL");
    await once(sc.child, "exit");
  }
  assert.equal(process.listenerCount("exit"), baseline, "four sidecars came and went and left nothing behind");
  const live = getSidecar();
  assert.equal(process.listenerCount("exit"), baseline + 1, "and a live one holds exactly one");
  t.after(async () => {
    live.child.kill("SIGKILL");
    await once(live.child, "exit");
  });
});

test("output from a sidecar that has been replaced is ignored", async (t) => {
  const sc = await fresh(t);
  sidecarTracker.failed("the old process was stuck");
  sc.restarting = true; // set when the sidecar is replaced; its process may still write for a moment
  sc.child.stdout.emit("data", `${JSON.stringify({ event: "ready", ms: 5 })}\n`);
  assert.equal(sidecarTracker.store.get().state, "error", "a dying process's last words do not mark the status warm");
  assert.equal(sc.proven, false);
  sc.restarting = false;
});

test("a sidecar that dies on its own tells the status, even with no prompt waiting", async (t) => {
  const sc = await fresh(t);
  assert.notEqual(sidecarTracker.store.get().state, "error");
  sc.child.kill("SIGKILL");
  await once(sc.child, "exit");
  assert.equal(sidecarTracker.store.get().state, "error", "nobody was waiting, and the status still says so");
  assert.match(sidecarTracker.store.get().error, /stopped/i);
});

test("a sidecar that was replaced on purpose is not reported as a crash", async (t) => {
  const sc = await fresh(t);
  sidecarTracker.store.set("warm");
  sc.restarting = true;
  sc.child.kill("SIGKILL");
  await once(sc.child, "exit");
  assert.equal(sidecarTracker.store.get().state, "warm", "the restart's own death does not flash an error");
});

// Written last so the file ends with the process quiet: nothing here may leave a child behind.
test("the stand-in is not left running", async () => {
  const sc = getSidecar();
  if (!sc.dead) {
    sc.child.kill("SIGKILL");
    await once(sc.child, "exit");
  }
  appendFileSync(startLog, "");
  assert.ok(true);
});
