import test from "node:test";
import assert from "node:assert/strict";
import { describeFailure, createSidecarState, createSidecarTracker } from "../src/sidecar-state.mjs";

// A routing model that cannot start is the most likely first-run failure on a stranger's machine,
// and the raw error is a wall of Python. These pin the plain-language reason a person sees, and the
// small state machine that the app's status dot and cards are drawn from.
const PY = "/Users/someone/.laya-router/venv/bin/python";

test("a Python that does not exist: says where it looked and how to fix it", () => {
  const err = Object.assign(new Error(`spawn ${PY} ENOENT`), { code: "ENOENT", path: PY, syscall: `spawn ${PY}` });
  const msg = describeFailure(err, PY);
  assert.ok(msg.includes(PY), msg);
  assert.match(msg, /not found/i);
  assert.match(msg, /LAYA_PYTHON/);
});

test("a Python that cannot be run: permission, not absence", () => {
  const err = Object.assign(new Error(`spawn ${PY} EACCES`), { code: "EACCES", path: PY });
  assert.match(describeFailure(err, PY), /permission/i);
  assert.doesNotMatch(describeFailure(err, PY), /not found/i);
});

test("a Python without the laya package: names the package and the install command for THAT Python", () => {
  const tail = `Traceback (most recent call last):\n  File "laya_bridge.py", line 75, in _get_router\n    from laya import Router\nModuleNotFoundError: No module named 'laya'\n`;
  const msg = describeFailure(new Error(`laya failed: No module named 'laya'`), PY);
  assert.match(msg, /laya package/i);
  assert.ok(msg.includes(`${PY} -m pip install laya`), msg);
  const viaExit = describeFailure(new Error(`laya sidecar exited (1): ${tail}`), PY);
  assert.match(viaExit, /laya package/i);
});

test("a different missing Python package is named, not blamed on laya", () => {
  const tail = `Traceback (most recent call last):\n  File "x.py", line 1\nModuleNotFoundError: No module named 'torch'\n`;
  const msg = describeFailure(new Error(`laya sidecar exited (1): ${tail}`), PY);
  assert.match(msg, /torch/);
  assert.match(msg, /missing/i);
  assert.doesNotMatch(msg, /laya package/i);
});

test("a handled error from the bridge loses its internal prefix", () => {
  assert.equal(describeFailure(new Error("laya failed: checkpoint could not be loaded"), PY), "checkpoint could not be loaded");
});

test("a sidecar that never echoed: says it did not respond, with any last words it left", () => {
  assert.match(describeFailure(new Error("laya sidecar unresponsive: "), PY), /did not respond/i);
  const withWords = describeFailure(new Error("laya sidecar unresponsive: RuntimeError: out of memory"), PY);
  assert.match(withWords, /did not respond/i);
  assert.match(withWords, /out of memory/);
});

test("a process killed by a signal says so, and does not call the signal an exit code", () => {
  const msg = describeFailure(new Error("laya sidecar exited (SIGKILL): "), PY);
  assert.match(msg, /process was stopped \(SIGKILL\)/);
  assert.doesNotMatch(msg, /exit SIGKILL/, "SIGKILL is a signal, not an exit status");
  // What Node really reports for a killed child is `signal`, with a null exit code.
  const withWords = describeFailure(new Error("laya sidecar exited (SIGTERM): out of memory"), PY);
  assert.match(withWords, /process was stopped \(SIGTERM\)/);
  assert.match(withWords, /out of memory/);
});

test("a crash with no output at all says its exit code", () => {
  const msg = describeFailure(new Error("laya sidecar exited (1): "), PY);
  assert.match(msg, /exit 1/);
  assert.match(msg, /unexpectedly/);
});

test("a crash with a traceback keeps the last line, not the whole wall", () => {
  const tail = `Traceback (most recent call last):\n  File "a.py", line 1, in <module>\n    boom()\n  File "b.py", line 9, in boom\n    raise ValueError("bad thing")\nValueError: bad thing\n`;
  const msg = describeFailure(new Error(`laya sidecar exited (1): ${tail}`), PY);
  assert.match(msg, /ValueError: bad thing/);
  assert.doesNotMatch(msg, /Traceback|File "a.py"/);
});

test("the message is one short line whatever it is given", () => {
  const huge = `laya sidecar exited (1): ${"x".repeat(5000)}\n${"y".repeat(5000)}`;
  const msg = describeFailure(new Error(huge), PY);
  assert.ok(msg.length <= 240, `length ${msg.length}`);
  assert.doesNotMatch(msg, /\n/);
});

test("anything odd is tolerated", () => {
  for (const bad of [null, undefined, "a string", 42, {}, { message: 7 }, new Error("")]) {
    const msg = describeFailure(bad, PY);
    assert.equal(typeof msg, "string");
    assert.ok(msg.length > 0, `empty for ${String(bad)}`);
  }
  assert.equal(typeof describeFailure(new Error("x"), undefined), "string");
});

// ---- the state store ---------------------------------------------------------------------------
test("a new store is stopped with no error", () => {
  assert.deepEqual(createSidecarState().get(), { state: "stopped", error: null });
});

test("changing state notifies once; repeating it does not", () => {
  const s = createSidecarState();
  const seen = [];
  s.subscribe((v) => seen.push(v.state));
  s.set("starting");
  s.set("starting");
  s.set("warm");
  s.set("warm");
  assert.deepEqual(seen, ["stopped", "starting", "warm"], "first entry is the current state, delivered on subscribe");
});

test("a different error message is a change, the same one is not", () => {
  const s = createSidecarState();
  const seen = [];
  s.subscribe((v) => seen.push(v.error));
  s.set("error", "first");
  s.set("error", "first");
  s.set("error", "second");
  assert.deepEqual(seen, [null, "first", "second"]);
});

test("leaving the error state clears the message", () => {
  const s = createSidecarState();
  s.set("error", "broken");
  s.set("warm");
  assert.deepEqual(s.get(), { state: "warm", error: null });
});

test("a listener that throws does not stop the others or the store", () => {
  const s = createSidecarState();
  const seen = [];
  s.subscribe(() => {
    throw new Error("boom");
  });
  s.subscribe((v) => seen.push(v.state));
  assert.doesNotThrow(() => s.set("warm"));
  assert.deepEqual(seen, ["stopped", "warm"]);
});

test("unsubscribing stops delivery", () => {
  const s = createSidecarState();
  const seen = [];
  const off = s.subscribe((v) => seen.push(v.state));
  off();
  s.set("warm");
  assert.deepEqual(seen, ["stopped"]);
});

test("only the three known states are accepted", () => {
  const s = createSidecarState();
  assert.throws(() => s.set("on fire"), /unknown/i);
  assert.deepEqual(s.get(), { state: "stopped", error: null });
});

test("get() returns a copy, so a caller cannot change the store by editing it", () => {
  const s = createSidecarState();
  const v = s.get();
  v.state = "warm";
  assert.equal(s.get().state, "stopped");
});

// ---- the tracker: what each ask did to the state --------------------------------------------------
const tracker = () => {
  const t = createSidecarTracker();
  const seen = [];
  t.store.subscribe((v) => seen.push(`${v.state}${v.error ? `:${v.error}` : ""}`));
  return { t, seen, now: () => t.store.get() };
};

test("the first ask takes it from stopped to starting, and an answer makes it warm", () => {
  const { t, now } = tracker();
  const a = t.begin();
  assert.equal(now().state, "starting");
  t.succeed(a);
  assert.equal(now().state, "warm");
});

test("a failed ask is an error with its message", () => {
  const { t, now } = tracker();
  t.fail(t.begin(), "no laya package");
  assert.deepEqual(now(), { state: "error", error: "no laya package" });
});

test("asking while warm does not flicker back to starting", () => {
  const { t, seen } = tracker();
  t.succeed(t.begin());
  const before = seen.length;
  t.succeed(t.begin());
  t.succeed(t.begin());
  assert.equal(seen.length, before, "no state change, so nothing was announced to the app");
});

test("a retry after an error shows starting, with the old message gone", () => {
  const { t, now } = tracker();
  t.fail(t.begin(), "old problem");
  t.begin();
  assert.deepEqual(now(), { state: "starting", error: null });
});

test("a failure while warm turns it into an error", () => {
  const { t, now } = tracker();
  t.succeed(t.begin());
  t.fail(t.begin(), "it died");
  assert.equal(now().state, "error");
});

test("recovering clears the error", () => {
  const { t, now } = tracker();
  t.fail(t.begin(), "x");
  t.succeed(t.begin());
  assert.deepEqual(now(), { state: "warm", error: null });
});

// The ack timer is five seconds and asks queue behind one another, so an old ask can settle after
// a newer one. Newer information wins, in both directions.
test("a slow old failure does not overwrite a newer success", () => {
  const { t, now } = tracker();
  const old = t.begin();
  const fresh = t.begin();
  t.succeed(fresh);
  t.fail(old, "timed out long ago");
  assert.equal(now().state, "warm");
});

test("a slow old success does not hide a newer failure", () => {
  const { t, now } = tracker();
  const old = t.begin();
  const fresh = t.begin();
  t.fail(fresh, "it is broken now");
  t.succeed(old);
  assert.equal(now().state, "error");
});

test("results settle in any order without losing the newest", () => {
  const { t, now } = tracker();
  const a = t.begin(), b = t.begin(), c = t.begin();
  t.succeed(b);
  t.fail(c, "latest failed");
  t.succeed(a);
  assert.deepEqual(now(), { state: "error", error: "latest failed" });
});

test("tickets are unique and increasing", () => {
  const { t } = tracker();
  const ids = [t.begin(), t.begin(), t.begin()];
  assert.deepEqual(ids, [...ids].sort((x, y) => x - y));
  assert.equal(new Set(ids).size, 3);
});

test("two trackers do not share state", () => {
  const one = createSidecarTracker();
  const two = createSidecarTracker();
  one.fail(one.begin(), "only mine");
  assert.equal(two.store.get().state, "stopped");
});

test("a message handed to a healthy state is discarded, not kept to resurface later", () => {
  const store = createSidecarState();
  store.set("warm", "a stale message from an earlier failure");
  assert.deepEqual(store.get(), { state: "warm", error: null });
  store.set("starting", "another");
  assert.deepEqual(store.get(), { state: "starting", error: null });
  store.set("stopped", "and another");
  assert.deepEqual(store.get(), { state: "stopped", error: null });
});

test("an error state with no message still carries something readable", () => {
  const store = createSidecarState();
  store.set("error");
  assert.equal(typeof store.get().error, "string");
  assert.ok(store.get().error.length > 0);
});


// ---------------------------------------------------------------- what a person is told when the model is slow, stuck or replaced
//
// Each of these sentences is the whole of what the status card says, so each is pinned in full: the
// sentences are the product here, and a loose match would let one of them drift into a stack trace.

const said = (message) => describeFailure(new Error(message), PY);

test("a missed deadline: says how long it waited, that the turn went on, and that the model is asked again", () => {
  assert.equal(said("laya sidecar deadline: no answer in 15s"), "The routing model took longer than 15 seconds, so that turn kept its current model. It is asked again on the next one.");
});

test("a missed deadline of one second says 'second', not 'seconds'", () => {
  assert.equal(said("laya sidecar deadline: no answer in 1s"), "The routing model took longer than 1 second, so that turn kept its current model. It is asked again on the next one.");
  assert.match(said("laya sidecar deadline: no answer in 2s"), /longer than 2 seconds,/);
  assert.match(said("laya sidecar deadline: no answer in 10s"), /longer than 10 seconds,/);
});

test("a model that went quiet is restarted, and the sentence says so without blaming a number", () => {
  const msg = said("laya sidecar deadline: no answer in 15s (restarting: stuck)");
  assert.equal(msg, "The routing model stopped answering, so it is being restarted. That turn kept its current model.");
  assert.doesNotMatch(msg, /\d/, "no seconds, no counts: the rule behind the restart is not the person's business");
});

test("a model that never finished loading is restarted, and says loading, not answering", () => {
  assert.equal(said("laya sidecar deadline: no answer in 15s (restarting: never-loaded)"), "The routing model never finished loading, so it is being restarted. That turn kept its current model.");
});

test("a model that could not echo: the plain timeout, and when it is also restarted, the restart", () => {
  assert.equal(said("laya sidecar unresponsive: "), "The routing model did not respond in time.");
  assert.equal(said("laya sidecar unresponsive (restarting: stuck): "), "The routing model stopped responding, so it is being restarted.");
  assert.equal(said("laya sidecar unresponsive (restarting: never-loaded): "), "The routing model never finished starting, so it is being restarted.");
  assert.equal(said("laya sidecar unresponsive (restarting: stuck): RuntimeError: out of memory"), "The routing model stopped responding, so it is being restarted. Last it said: RuntimeError: out of memory");
  assert.equal(said("laya sidecar unresponsive: RuntimeError: out of memory"), "The routing model did not respond in time. Last it said: RuntimeError: out of memory");
});

test("a prompt that was waiting when the model was replaced is told it was restarted, not that it crashed", () => {
  assert.equal(said("laya sidecar restarted: it stopped answering"), "The routing model stopped answering, so it was restarted. It takes a few seconds to load again.");
});

test("none of the new sentences carries a trace, a path, or the internal wording", () => {
  for (const raw of [
    "laya sidecar deadline: no answer in 15s", "laya sidecar deadline: no answer in 15s (restarting: stuck)", "laya sidecar deadline: no answer in 15s (restarting: never-loaded)",
    "laya sidecar unresponsive: ", "laya sidecar unresponsive (restarting: stuck): ", "laya sidecar restarted: it stopped answering",
  ]) {
    const msg = said(raw);
    assert.doesNotMatch(msg, /laya sidecar|Traceback|\/Users|\(restarting/, `${raw} -> ${msg}`);
    assert.ok(msg.length < 160 && msg.endsWith("."), `short and a sentence: ${msg}`);
  }
});

// ---------------------------------------------------------------- what the sidecar says about itself

test("loading: a status that knows nothing becomes 'starting'; one that is warm stays warm", () => {
  const tracker = createSidecarTracker();
  tracker.loading();
  assert.equal(tracker.store.get().state, "starting");
  tracker.ready();
  assert.equal(tracker.store.get().state, "warm");
  tracker.loading();
  assert.equal(tracker.store.get().state, "warm", "a model that says it is loading, while the status already shows it answered, does not undo that");
});

test("loading after an error is a new attempt: 'starting', until it is ready or fails again", () => {
  const tracker = createSidecarTracker();
  tracker.failed("The routing model stopped answering, so it is being restarted.");
  assert.equal(tracker.store.get().state, "error");
  tracker.loading();
  assert.equal(tracker.store.get().state, "starting", "the replacement is on its way up");
  assert.equal(tracker.store.get().error, null, "and the old reason is not shown against it");
});

test("ready makes it warm and clears an old error; failed makes it an error with the reason", () => {
  const tracker = createSidecarTracker();
  tracker.failed("checkpoint weights are missing");
  assert.deepEqual([tracker.store.get().state, tracker.store.get().error], ["error", "checkpoint weights are missing"]);
  tracker.ready();
  assert.deepEqual([tracker.store.get().state, tracker.store.get().error], ["warm", null]);
  tracker.failed("again");
  assert.deepEqual([tracker.store.get().state, tracker.store.get().error], ["error", "again"]);
});

test("what the sidecar reports about itself is not overwritten by an ask that was answered earlier and arrives late", () => {
  const tracker = createSidecarTracker();
  const older = tracker.begin();
  const newer = tracker.begin();
  tracker.succeed(newer); // the newer ask is decided first
  tracker.failed("checkpoint weights are missing"); // then the sidecar says its load failed
  tracker.fail(older, "an older ask that failed late"); // a stale outcome, which must change nothing
  assert.deepEqual([tracker.store.get().state, tracker.store.get().error], ["error", "checkpoint weights are missing"]);
  tracker.succeed(older); // and neither may a stale success
  assert.deepEqual([tracker.store.get().state, tracker.store.get().error], ["error", "checkpoint weights are missing"]);
});
