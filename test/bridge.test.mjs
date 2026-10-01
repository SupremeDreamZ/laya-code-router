// The routing bridge itself, run for real as a Python process against a stub of the `laya` package.
//
// What is under test is the threading and the line protocol, which no test of the Node side can see:
// the model is loaded as soon as the process starts, the caller is told how it went, and a request
// is echoed at once even while the model is loading. The stub's Router sleeps for as long as the test
// says, so "the model is mid-load" is a state a test can stand in, without a gigabyte of weights.
//
//   STUB_LOAD_S     how long Router() takes to construct
//   STUB_FAIL_FILE  while this file exists, Router() raises, as a missing checkpoint does
//   STUB_LOG        file that gets one line per Router() construction
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BRIDGE = new URL("../src/laya_bridge.py", import.meta.url).pathname;
const PYTHON = process.env.LAYA_TEST_PYTHON ?? "python3";
const HAVE_PYTHON = spawnSync(PYTHON, ["-c", "import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)"]).status === 0;
const opts = { skip: HAVE_PYTHON ? false : "no python3 on this machine" };

/** A folder holding a stub `laya` package, which the bridge imports instead of the real one. */
function stub() {
  const dir = mkdtempSync(join(tmpdir(), "laya-bridge-"));
  mkdirSync(join(dir, "laya"));
  writeFileSync(join(dir, "laya", "__init__.py"), `
import os, time

class Router:
    def __init__(self, models=None):
        if os.environ.get("STUB_LOG"):
            with open(os.environ["STUB_LOG"], "a") as f:
                f.write("load\\n")
        time.sleep(float(os.environ.get("STUB_LOAD_S", "0")))
        if os.path.exists(os.environ.get("STUB_FAIL_FILE", "/nonexistent")):
            raise RuntimeError("checkpoint weights are missing")

    def predict(self, state, questions, model=None):
        answers = {q: {"score": 1.0, "confidence": 0.5} for q in ("task_complexity", "reasoning_required", "tool_complexity")}
        answers["needs_judgment"] = {"noul": 0.2}
        answers["model_tier"] = {"choice": "claude-sonnet-5-5", "probabilities": {"claude-sonnet-5-5": 1.0}}
        return {"answers": answers}
`);
  return dir;
}

/** The bridge as a child process, with its output cut into JSON lines with the time each arrived. */
function bridge(t, { loadS = 0, eager = true, failFile = null, args = [] } = {}) {
  const dir = stub();
  const log = join(dir, "loads.log");
  writeFileSync(log, "");
  const child = spawn(PYTHON, [BRIDGE, ...args], {
    env: {
      PATH: process.env.PATH, PYTHONPATH: dir, STUB_LOAD_S: String(loadS), STUB_LOG: log,
      ...(failFile ? { STUB_FAIL_FILE: failFile } : {}), ...(eager ? {} : { LAYA_EAGER_LOAD: "0" }),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => { child.kill("SIGKILL"); rmSync(dir, { recursive: true, force: true }); });
  const t0 = Date.now();
  const out = [];
  const err = [];
  const garbled = [];
  const cut = (store, label) => {
    let buf = "";
    return (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        try { store.push({ at: Date.now() - t0, ...JSON.parse(line) }); } catch { garbled.push(`${label}: ${line.slice(0, 80)}`); }
      }
    };
  };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", cut(out, "stdout"));
  child.stderr.on("data", cut(err, "stderr"));
  let exited = null;
  child.on("exit", (code, signal) => { exited = { code, signal, at: Date.now() - t0 }; });
  const send = (id, extra = {}) => child.stdin.write(`${JSON.stringify({ id, state: "Add pagination.", current_model: "claude-sonnet-5-5", context_tokens: 100, models: [{ id: "claude-sonnet-5-5", tier: "sonnet" }], ...extra })}\n`);
  const until = async (pred, what, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const hit = pred();
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 15));
    }
    throw new Error(`timed out waiting for ${what}. stdout ${JSON.stringify(out)} stderr ${JSON.stringify(err)} garbled ${JSON.stringify(garbled)}`);
  };
  return { child, out, err, garbled, send, until, loads: () => readFileSync(log, "utf8").split("\n").filter(Boolean).length, get exited() { return exited; }, t0 };
}

const event = (b, name) => b.out.find((l) => l.event === name);

test("the model is loaded at start with no request at all, and the caller is told when it is ready", opts, async (t) => {
  const b = bridge(t, { loadS: 0.4 });
  const loading = await b.until(() => event(b, "loading"), "a loading event");
  assert.ok(loading.at < 1500, `loading is announced at once, not after the load (${loading.at} ms)`);
  const ready = await b.until(() => event(b, "ready"), "a ready event");
  assert.ok(ready.at - loading.at >= 350, `ready only after the load had run (${ready.at - loading.at} ms later)`);
  assert.ok(ready.ms >= 350, `and it says how long the load took (${ready.ms} ms)`);
  assert.equal(b.loads(), 1, "the model was constructed exactly once");
  assert.deepEqual(b.out.map((l) => l.event), ["loading", "ready"], "and nothing else was said, with no request made");
});

test("a request made while the model is loading is echoed at once and answered after the load", opts, async (t) => {
  const b = bridge(t, { loadS: 1.2 });
  await b.until(() => event(b, "loading"), "loading");
  const sentAt = Date.now() - b.t0;
  b.send(7);
  const echo = await b.until(() => b.out.find((l) => l.id === 7 && Object.keys(l).length === 2), "the echo");
  assert.ok(echo.at - sentAt < 400, `the echo does not wait for the model (${echo.at - sentAt} ms) although the load takes 1200 ms`);
  assert.ok(!b.out.some((l) => l.id === 7 && l.answers), "no answer yet: the model is still loading");
  const answer = await b.until(() => b.out.find((l) => l.id === 7 && l.answers), "the answer");
  assert.ok(answer.at >= event(b, "ready").at, "the answer comes after the model is ready");
  assert.equal(answer.id, 7);
  assert.equal(b.loads(), 1, "the request did not start a second load");
});

test("ready means a routing request was answered, not only that the model was built", opts, async (t) => {
  // A stub whose Router builds fine and whose predict() raises: construction alone would say "ready".
  const dir = mkdtempSync(join(tmpdir(), "laya-bridge-"));
  mkdirSync(join(dir, "laya"));
  writeFileSync(join(dir, "laya", "__init__.py"), `
class Router:
    def __init__(self, models=None):
        pass
    def predict(self, state, questions, model=None):
        raise RuntimeError("the model loaded but cannot answer")
`);
  const child = spawn(PYTHON, [BRIDGE], { env: { PATH: process.env.PATH, PYTHONPATH: dir }, stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => { child.kill("SIGKILL"); rmSync(dir, { recursive: true, force: true }); });
  let text = "";
  child.stdout.on("data", (c) => (text += c));
  const end = Date.now() + 8000;
  while (Date.now() < end && !/"event": "(ready|failed)"/.test(text)) await new Promise((r) => setTimeout(r, 25));
  assert.match(text, /"event": "failed"/, "a model that cannot answer is not announced as ready");
  assert.match(text, /cannot answer/, "and the reason is in the line");
  assert.doesNotMatch(text, /"event": "ready"/);
});

test("a load that fails says so in a line, and the next request tries the load again", opts, async (t) => {
  const failFile = join(mkdtempSync(join(tmpdir(), "laya-fail-")), "fail");
  writeFileSync(failFile, "x");
  const b = bridge(t, { loadS: 0.1, failFile });
  const failed = await b.until(() => event(b, "failed"), "a failed event");
  assert.match(failed.error, /checkpoint weights are missing/, "with the reason, for the person to read");
  assert.equal(b.loads(), 1);
  assert.ok(!event(b, "ready"));
  // The weights arrive (a download finished, a disk came back). Nothing has to be restarted.
  rmSync(failFile);
  b.send(3);
  const answer = await b.until(() => b.out.find((l) => l.id === 3 && l.answers), "an answer after the weights came back", 8000);
  assert.equal(b.loads(), 2, "the second request tried the load again");
  assert.equal(answer.id, 3);
});

test("a request that fails is reported on stderr with its id and does not stop the next one", opts, async (t) => {
  const b = bridge(t, { loadS: 0 });
  await b.until(() => event(b, "ready"), "ready");
  b.send(1, { models: [] }); // "no models available" raises in handle()
  b.send(2);
  const bad = await b.until(() => b.err.find((l) => l.id === 1), "the error line");
  assert.match(bad.error, /no models available/);
  const good = await b.until(() => b.out.find((l) => l.id === 2 && l.answers), "the next answer");
  assert.equal(good.id, 2);
});

test("with eager loading off, nothing loads until the first request, and no event is sent", opts, async (t) => {
  const b = bridge(t, { loadS: 0.2, eager: false });
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(b.loads(), 0, "nothing was loaded at start");
  assert.deepEqual(b.out, [], "and nothing was said");
  b.send(5);
  const answer = await b.until(() => b.out.find((l) => l.id === 5 && l.answers), "an answer");
  assert.equal(b.loads(), 1);
  assert.equal(answer.id, 5);
  assert.ok(!b.out.some((l) => l.event), "still no event: the old protocol, exactly");
});

/** For every id: its echo came before its answer on the wire, and each came once. */
function assertEchoBeforeAnswer(b, ids) {
  for (const id of ids) {
    const echoAt = b.out.findIndex((l) => l.id === id && Object.keys(l).length === 2); // {id, at}
    const answerAt = b.out.findIndex((l) => l.id === id && l.answers);
    assert.ok(echoAt >= 0 && answerAt >= 0, `id ${id}: both an echo and an answer were sent`);
    assert.ok(echoAt < answerAt, `id ${id}: the echo (line ${echoAt}) came before the answer (line ${answerAt}); the caller treats the echo as "I read your line"`);
  }
}

test("many requests while the model loads are answered in the order they came, one answer each", opts, async (t) => {
  const b = bridge(t, { loadS: 0.5 });
  for (let id = 100; id < 140; id++) b.send(id);
  await b.until(() => b.out.filter((l) => l.answers).length === 40, "forty answers", 15000);
  const answered = b.out.filter((l) => l.answers).map((l) => l.id);
  assert.deepEqual(answered, Array.from({ length: 40 }, (_, i) => 100 + i), "in order, none lost, none twice");
  assert.equal(b.out.filter((l) => l.id !== undefined && Object.keys(l).length === 2).length, 40, "and each was echoed exactly once");
  assertEchoBeforeAnswer(b, Array.from({ length: 40 }, (_, i) => 100 + i));
  assert.deepEqual(b.garbled, [], "and no line was cut in half by a line from the other thread");
  assert.equal(b.loads(), 1);
});

test("output from the two threads is never interleaved", opts, async (t) => {
  // The reader echoes while the worker answers. Every line must parse, under a hammering.
  const b = bridge(t, { loadS: 0 });
  await b.until(() => event(b, "ready"), "ready");
  for (let round = 0; round < 6; round++) for (let id = 1000 + round * 50; id < 1050 + round * 50; id++) b.send(id);
  await b.until(() => b.out.filter((l) => l.answers).length === 300, "three hundred answers", 30000);
  assertEchoBeforeAnswer(b, Array.from({ length: 300 }, (_, i) => 1000 + Math.floor(i / 50) * 50 + (i % 50)));
  assert.deepEqual(b.garbled, [], "every line was whole");
  const ids = new Set(b.out.filter((l) => l.answers).map((l) => l.id));
  assert.equal(ids.size, 300);
});

test("closing stdin ends the process at once, even in the middle of a load", opts, async (t) => {
  const b = bridge(t, { loadS: 30 });
  await b.until(() => event(b, "loading"), "loading");
  const closedAt = Date.now() - b.t0;
  b.child.stdin.end();
  await b.until(() => b.exited, "the process to exit", 4000);
  assert.ok(b.exited.at - closedAt < 3000, `it did not wait for a 30 s load (${b.exited.at - closedAt} ms)`);
  assert.equal(b.exited.code, 0);
});

test("a bad line is reported and skipped, and the next request is still answered", opts, async (t) => {
  const b = bridge(t, { loadS: 0 });
  await b.until(() => event(b, "ready"), "ready");
  b.child.stdin.write("this is not json\n");
  b.send(9);
  const bad = await b.until(() => b.err.find((l) => /bad request json/.test(l.error ?? "")), "the complaint");
  assert.equal(bad.id, null);
  const good = await b.until(() => b.out.find((l) => l.id === 9 && l.answers), "the answer");
  assert.equal(good.id, 9);
});

test("--warm loads, answers once, and exits 0; it exits non-zero when the load fails", opts, () => {
  const run = (fail) => {
    const dir = stub();
    const failFile = join(dir, "fail");
    if (fail) writeFileSync(failFile, "x");
    const r = spawnSync(PYTHON, [BRIDGE, "--warm"], { env: { PATH: process.env.PATH, PYTHONPATH: dir, STUB_FAIL_FILE: failFile }, encoding: "utf8", timeout: 30000 });
    rmSync(dir, { recursive: true, force: true });
    return r;
  };
  const ok = run(false);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, "", "and it says nothing: setup reads the exit code");
  const bad = run(true);
  assert.notEqual(bad.status, 0, "a broken install must fail the setup probe");
  assert.match(bad.stderr, /checkpoint weights are missing/);
  assert.ok(existsSync(BRIDGE));
});
