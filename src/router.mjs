import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  CONTEXT_WINDOW_TOKENS,
  SCORE_QUESTIONS,
  THRESHOLDS,
  questionForModels,
} from "./config.mjs";
import { log } from "./log.mjs";
import { createSidecarTracker, describeFailure } from "./sidecar-state.mjs";
import { deadlineMs, loadDeadlineMs, loadGiveUpMs } from "./timing.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/** What the routing model is doing, for whoever wants to show it (the background app). */
export const sidecarTracker = createSidecarTracker();

/**
 * A long-lived LAYA sidecar: one child process per proxy, kept warm for the whole CLI
 * session so the ~40s model load is paid once and each decision costs ~35-50ms on MPS.
 *
 * Line protocol: one JSON request per line on stdin; the answer comes back as a
 * `{"id": ...}` line followed by the full result line (NDJSON). The id round-trip is
 * what keeps concurrent routing calls from matching each other's answers. A malformed
 * line or a LAYA failure produces a `{"id": ..., "error": ...}` line on stderr, which
 * the caller reads as "keep the current model" — routing must never block a prompt.
 */
class LayaSidecar {
  constructor() {
    this.pending = new Map();
    this.dead = false;
    this.restarting = false;
    this.nextId = 1;
    this.buffer = "";
    this.errBuffer = "";
    this.python = process.env.LAYA_PYTHON ?? "python3";
    this.startedAt = Date.now();
    this.proven = false; // it has said "ready" or answered a request, so its model is known to work
    this.lastOutputAt = 0; // when it last sent anything but the bare echo, which any reader thread can send
    this.inflight = new Map(); // every request it has been given and not answered, abandoned or not: id -> sent at
    this.child = spawn(this.python, [join(HERE, "laya_bridge.py")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: (() => {
        // A PYTHONPATH exported for another tool (the laya-crypto server shim) makes the
        // sidecar import `laya` from the wrong tree and hang, so the child gets a clean
        // environment: the venv interpreter carries its own site-packages.
        const env = { ...process.env };
        delete env.PYTHONPATH;
        return env;
      })(),
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.#onStdout(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      this.errBuffer = (this.errBuffer + chunk).slice(-4000);
      for (const line of chunk.split("\n")) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.id != null) {
            this.#heardFrom(parsed.id);
            const { reject } = this.pending.get(parsed.id) ?? {};
            if (reject) {
              this.pending.delete(parsed.id);
              reject(new Error(parsed.error ?? "laya failed"));
            }
          }
        } catch {
          // Human-readable crash text (tracebacks) waits in errBuffer for the timeout path.
        }
      }
    });
    // Writing to a child that has just died is an EPIPE on this stream, and a stream error nobody
    // listens for is an uncaught exception: it would take the whole daemon down with the sidecar.
    // The exit and error handlers below already say what happened to anyone waiting.
    this.child.stdin.on("error", () => {});
    this.child.on("exit", (code, signal) => {
      this.dead = true;
      const err = this.restarting
        ? new Error("laya sidecar restarted: it stopped answering")
        : new Error(`laya sidecar exited (${signal ?? code}): ${this.errBuffer.trim()}`);
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
      // It may die with nobody waiting on it (a crash while the model loads, before any prompt), and
      // a status that said "starting" would then say so forever. A restart we asked for is no failure.
      if (!this.restarting) sidecarTracker.failed(describeFailure(err, this.python));
    });
    this.child.on("error", (err) => {
      this.dead = true;
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
      sidecarTracker.failed(describeFailure(err, this.python));
    });
    // The launcher exits when the CLI exits; without this the sidecar would survive as an
    // orphan holding the whole model in memory for every session that ever ran. The hook is
    // removed when the child goes, so a daemon that replaces sidecars does not pile them up.
    const killChild = () => {
      try {
        this.child.kill();
      } catch {
        // Already gone.
      }
    };
    process.on("exit", killChild);
    this.child.on("exit", () => process.off("exit", killChild));
  }

  /** It sent something other than the echo, so its worker is alive; that request, and any before it, are done with. */
  #heardFrom(id) {
    this.lastOutputAt = Date.now();
    for (const sent of this.inflight.keys()) {
      if (sent > id) break;
      this.inflight.delete(sent);
    }
  }

  #onStdout(chunk) {
    // Output from a process that has been replaced is no longer anyone's business.
    if (this.restarting) return;
    this.buffer += chunk;
    for (;;) {
      const end = this.buffer.indexOf("\n");
      if (end < 0) return;
      const line = this.buffer.slice(0, end).trim();
      this.buffer = this.buffer.slice(end + 1);
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.event) {
          this.#onEvent(parsed);
          continue;
        }
        if (parsed.id == null) continue; // noise
        // An ack echo is the bare `{"id": N}` line the sidecar sends before running the
        // model; only the full result line (any other shape) resolves the ask. This is
        // what lets the sidecar pay its model load after the echo instead of before it.
        const isEcho = Object.keys(parsed).length === 1;
        // A result is proof the model works even when nobody is waiting for it any more (a request
        // given up on that finished late), and that is what keeps a slow model from being replaced.
        if (!isEcho) {
          this.proven = true;
          this.#heardFrom(parsed.id);
        }
        const entry = this.pending.get(parsed.id);
        if (!entry) continue;
        if (isEcho && !entry.sawAck) {
          entry.sawAck = true;
          if (entry.ackTimer) {
            clearTimeout(entry.ackTimer);
            entry.ackTimer = null;
          }
          continue;
        }
        this.pending.delete(parsed.id);
        entry.resolve(parsed);
      } catch {
        // Unparseable line; keep going.
      }
    }
  }

  /** The sidecar's own account of its model: loading, ready, or failed. Nothing here is a request. */
  #onEvent(event) {
    // Any line from the sidecar is proof it is alive and reading, so every ask still waiting for its
    // echo has one. It is the loading model, not a dead process, that is keeping the rest waiting.
    for (const entry of this.pending.values()) {
      if (entry.ackTimer) {
        clearTimeout(entry.ackTimer);
        entry.ackTimer = null;
      }
    }
    if (event.event === "loading") sidecarTracker.loading();
    else if (event.event === "ready") {
      this.proven = true;
      this.lastOutputAt = Date.now();
      sidecarTracker.ready();
    } else if (event.event === "failed") {
      this.lastOutputAt = Date.now();
      sidecarTracker.failed(describeFailure(new Error(String(event.error ?? "laya failed")), this.python));
    }
  }

  /**
   * One request. It ends one of four ways, and the caller needs only to know it ended: an answer, an
   * error from the sidecar, no echo within `ackMs` (it cannot read its input), or no answer within
   * `deadline` (the model is stuck, or starved). The last is what keeps a prompt from waiting
   * forever on a model that never comes back. A model that has not answered anything yet is loading
   * rather than stalled, so it gets the longer loading allowance until it has.
   */
  ask(request, { deadline = this.proven ? deadlineMs() : loadDeadlineMs() } = {}) {
    const id = this.nextId++;
    const payload = { ...request, id };
    return new Promise((resolve, reject) => {
      const entry = { id, resolve, reject, ackTimer: null, deadlineTimer: null };
      this.pending.set(id, entry);
      this.inflight.set(id, Date.now());
      // Neither timer is cleared when the ask ends some other way. Each looks for its ask in `pending`
      // when it fires, finds it gone (ids are never reused), and does nothing; and they are unref'd,
      // so they cannot keep a process alive. Only the echo clears the echo timer, because the ask is
      // still waiting then and the timer would otherwise fail it.
      //
      // The sidecar echoes the id before running the model, so a missing echo within a short window
      // means it cannot read its input: fail fast instead of waiting out the full deadline.
      entry.ackTimer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        const replaced = this.#stalled(THRESHOLDS.ackMs);
        reject(new Error(`laya sidecar unresponsive${replaced ? ` (restarting: ${replaced})` : ""}: ${this.errBuffer.trim()}`));
      }, THRESHOLDS.ackMs);
      entry.deadlineTimer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        const replaced = this.#stalled(deadline);
        const seconds = Math.max(1, Math.round(deadline / 1000));
        reject(new Error(`laya sidecar deadline: no answer in ${seconds}s${replaced ? ` (restarting: ${replaced})` : ""}`));
      }, deadline);
      entry.ackTimer.unref?.();
      entry.deadlineTimer.unref?.();
      this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }

  /**
   * A request ran out of time (`window` is the timer that fired). Whether the model is stuck or only
   * starved cannot be told from outside, so this waits for the evidence, and the evidence is silence:
   * a model that has answered before is stuck once it has sent nothing for `wedgedAfterDeadlines`
   * windows while holding a request, and one that never came up is stuck once it has had `loadGiveUpMs`
   * to. Then it is killed, and a fresh one starts loading at once so the next prompt does not wait for
   * a process that was only just started.
   *
   * The silence is counted from the oldest request it holds, not the newest, so prompts that pile up
   * behind a stuck one do not keep restarting the clock; and from its last output if that is later, so
   * a model that is slow but working, whose late answers keep arriving, is never replaced.
   *
   * @returns {?string} why this sidecar is being replaced ("stuck" or "never-loaded"), or null if it is not
   */
  #stalled(window) {
    const now = Date.now();
    const oldest = this.inflight.values().next().value ?? now;
    const silentFor = now - Math.max(this.lastOutputAt, oldest);
    const why = this.proven
      ? silentFor >= THRESHOLDS.wedgedAfterDeadlines * window && "stuck"
      : now - this.startedAt > loadGiveUpMs() && "never-loaded";
    if (!why) return null;
    this.restarting = true;
    this.dead = true;
    this.child.kill("SIGKILL");
    setImmediate(warmSidecar);
    return why;
  }
}

/**
 * Asks local LAYA which tier fits this prompt. Returns null on any failure, which the policy
 * layer reads as "keep the current model" — routing must never block a prompt.
 *
 * @returns {Promise<?{choice: string, confidence: number, probabilities: object, metrics: object, ms: number}>}
 */
export async function askLaya({ prompt, current, contextTokens, models }) {
  if (!models?.length) return null;
  const started = Date.now();
  const request = {
    state: prompt,
    current_model: current,
    context_tokens: contextTokens,
    models: models.slice(0, 12),
    questions: {
      ...Object.fromEntries(
        Object.entries(SCORE_QUESTIONS).map(([id, q]) => [id, { type: "score", ...q }]),
      ),
      model: questionForModels(models.slice(0, 12)),
    },
  };
  const ticket = sidecarTracker.begin();
  try {
    const result = await getSidecar().ask(request);
    // The bridge normalises rubric scores to 0..1 and computes the mean score-question
    // confidence itself; its metrics arrive ready for the policy and explanation layers.
    // `confidence` is set explicitly AFTER the spread: the N-way model answer carries its
    // own near-flat confidence (0.02-0.05 on wide sets), and letting it win through the
    // spread would neuter the policy's confidence gate.
    const { model: answer, task_complexity, reasoning_required, tool_complexity } = result.answers;
    sidecarTracker.succeed(ticket);
    return {
      ...answer,
      confidence: result.confidence ?? null,
      request,
      response: result,
      metrics:
        result.metrics ?? {
          taskComplexity: task_complexity?.score ?? null,
          reasoningRequired: reasoning_required?.score ?? null,
          toolComplexity: tool_complexity?.score ?? null,
          contextSize: Math.min(contextTokens / CONTEXT_WINDOW_TOKENS, 1),
        },
      ms: Date.now() - started,
    };
  } catch (err) {
    log(`routing failed, keeping ${current}: ${err.message}`);
    sidecarTracker.fail(ticket, describeFailure(err, process.env.LAYA_PYTHON ?? "python3"));
    return null;
  }
}

let sidecar;
export function getSidecar() {
  // A sidecar whose process has exited is never going to answer again. Keeping it would leave
  // routing broken for the life of the long-running daemon, so the next ask starts a fresh one.
  if (sidecar?.dead) sidecar = undefined;
  sidecar ??= new LayaSidecar();
  return sidecar;
}

/**
 * Pre-warms the sidecar so the first real routing decision does not pay the model-load
 * cost while a CLI turn waits. Fire-and-forget: a warmup failure just means the first
 * decision pays the load instead.
 */
export function warmSidecar() {
  try {
    getSidecar();
  } catch {
    // Spawn errors surface on the first ask; nothing to pre-warm.
  }
}
