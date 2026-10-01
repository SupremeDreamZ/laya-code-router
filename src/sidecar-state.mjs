// What the app is told about the routing model: one small state machine, and one function that turns
// the wall of Python a failure produces into a sentence a person can act on.
//
// Why this exists: "warm" used to be claimed the moment any request event arrived, including turns
// the user had pinned to a model, where no routing decision was made at all. Measured on
// 2026-09-30 with a Python that has no `laya` package: the daemon reported `warm` with no error
// after a pinned turn and again after a routed turn that had just failed. The state is now driven
// only by what the routing model itself did.

const STATES = ["stopped", "starting", "warm", "error"];
const MAX_LEN = 240;

/** A store for the state, with subscribers. Changes notify once; repeating a value does not. */
export function createSidecarState() {
  let current = { state: "stopped", error: null };
  const listeners = new Set();
  const snapshot = () => ({ ...current });
  return {
    get: snapshot,
    set(state, error = null) {
      if (!STATES.includes(state)) throw new Error(`unknown sidecar state: ${String(state)}`);
      const next = { state, error: state === "error" ? (error ?? "unknown error") : null };
      if (next.state === current.state && next.error === current.error) return;
      current = next;
      for (const fn of listeners) {
        try {
          fn(snapshot());
        } catch {
          // A subscriber's bug is not the routing model's problem.
        }
      }
    },
    subscribe(fn) {
      listeners.add(fn);
      try {
        fn(snapshot());
      } catch {
        // Same.
      }
      return () => listeners.delete(fn);
    },
  };
}

const oneLine = (text) => String(text ?? "").replace(/\s+/g, " ").trim();
const clip = (text) => (text.length > MAX_LEN ? `${text.slice(0, MAX_LEN - 1)}…` : text);

/** The last non-empty line of a Python traceback is the exception itself; the rest is where it was. */
function lastLine(tail) {
  const lines = String(tail ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.at(-1) ?? "";
}

/**
 * One line, in plain words, for why the routing model is not working, with the fix when there is
 * one. Never throws, never returns more than a line, and never includes a full traceback.
 * @param {unknown} err
 * @param {string} [python] the interpreter that was asked to run the model
 */
export function describeFailure(err, python) {
  const py = python || "python3";
  const code = err && typeof err === "object" ? err.code : undefined;
  const raw = err && typeof err === "object" && typeof err.message === "string" ? err.message : typeof err === "string" ? err : "";

  if (code === "ENOENT") {
    const where = (err && typeof err === "object" && typeof err.path === "string" && err.path) || py;
    return clip(`Python not found at ${where}. Run setup again, or set LAYA_PYTHON to a Python that has laya installed.`);
  }
  if (code === "EACCES") {
    const where = (err && typeof err === "object" && typeof err.path === "string" && err.path) || py;
    return clip(`Laya was refused permission to run ${where}. Check that file is executable, or set LAYA_PYTHON to another Python.`);
  }

  const missing = /No module named ['"]([\w.\-]+)['"]/.exec(raw);
  if (missing) {
    const pkg = missing[1].split(".")[0];
    if (pkg === "laya") {
      return clip(`The Python at ${py} does not have the laya package. Install it with: ${py} -m pip install laya`);
    }
    return clip(`A Python package the routing model needs is missing: ${pkg}. Run setup again to rebuild its environment.`);
  }

  const exited = /^laya sidecar exited \(([^)]*)\):?\s*([\s\S]*)$/.exec(raw);
  if (exited) {
    const [, how, tail] = exited;
    const last = lastLine(tail);
    if (/^SIG[A-Z0-9]+$/.test(how)) return clip(`The routing model process was stopped (${how}).${last ? ` ${oneLine(last)}` : ""}`);
    return clip(last ? `The routing model stopped: ${oneLine(last)}` : `The routing model stopped unexpectedly (exit ${how}).`);
  }

  const silent = /^laya sidecar unresponsive(?: \(restarting: ([a-z-]+)\))?:?\s*([\s\S]*)$/.exec(raw);
  if (silent) {
    const last = lastLine(silent[2]);
    const tail = last ? ` Last it said: ${oneLine(last)}` : "";
    if (silent[1] === "stuck") return clip(`The routing model stopped responding, so it is being restarted.${tail}`);
    if (silent[1] === "never-loaded") return clip("The routing model never finished starting, so it is being restarted.");
    return clip(`The routing model did not respond in time.${tail}`);
  }

  // The model was asked and never came back. The turn was not held up for it (it went on with the
  // model it had), and the next one asks again.
  const late = /^laya sidecar deadline: no answer in (\d+)s(?: \(restarting: ([a-z-]+)\))?/.exec(raw);
  if (late) {
    const seconds = `${late[1]} ${late[1] === "1" ? "second" : "seconds"}`;
    if (late[2] === "stuck") return clip("The routing model stopped answering, so it is being restarted. That turn kept its current model.");
    if (late[2] === "never-loaded") return clip("The routing model never finished loading, so it is being restarted. That turn kept its current model.");
    return clip(`The routing model took longer than ${seconds}, so that turn kept its current model. It is asked again on the next one.`);
  }
  if (/^laya sidecar restarted/.test(raw)) return clip("The routing model stopped answering, so it was restarted. It takes a few seconds to load again.");

  const plain = oneLine(raw.replace(/^laya failed:\s*/i, ""));
  return clip(plain || "The routing model failed for a reason it did not give.");
}

/**
 * Turns the outcome of each routing ask into the state the app is shown.
 *
 * `begin()` is called when an ask is sent and returns a ticket; `succeed`/`fail` are called with
 * that ticket when it settles. Asks queue behind one another (the failure timer is five seconds),
 * so an old ask can settle after a newer one, and the newer information must win in both
 * directions: a slow old failure must not turn a working model red, and a slow old success must not
 * hide a model that has just broken.
 */
export function createSidecarTracker() {
  const store = createSidecarState();
  let issued = 0;
  let decided = 0; // the newest ticket whose outcome has been applied
  return {
    store,
    // What the sidecar says about its own model, from the line it sends when the load begins, ends,
    // or fails. These are not asks, so they carry no ticket; what they must not do is overwrite what
    // an ask has since shown. Loading is news only where nothing better is known: at the start, or
    // after a failure (a process that replaced one that was stuck). A warm dot is not turned back to
    // starting by a model that says it is loading.
    loading() {
      const { state } = store.get();
      if (state === "stopped" || state === "error") store.set("starting");
    },
    ready() {
      store.set("warm");
    },
    failed(message) {
      store.set("error", message);
    },
    begin() {
      issued += 1;
      // Only an ask made while nothing is known (stopped, or after an error) shows "starting".
      // While warm, a routine ask must not flicker the dot to "starting" on every turn.
      const { state } = store.get();
      if (state === "stopped" || state === "error") store.set("starting");
      return issued;
    },
    succeed(ticket) {
      if (ticket < decided) return;
      decided = ticket;
      store.set("warm");
    },
    fail(ticket, message) {
      if (ticket < decided) return;
      decided = ticket;
      store.set("error", message);
    },
  };
}
