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

const HERE = dirname(fileURLToPath(import.meta.url));

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
    this.nextId = 1;
    this.buffer = "";
    this.errBuffer = "";
    this.child = spawn(
      process.env.LAYA_PYTHON ?? "python3",
      [join(HERE, "laya_bridge.py")],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: (() => {
          // A PYTHONPATH exported for another tool (the laya-crypto server shim) makes the
          // sidecar import `laya` from the wrong tree and hang, so the child gets a clean
          // environment: the venv interpreter carries its own site-packages.
          const env = { ...process.env };
          delete env.PYTHONPATH;
          return env;
        })(),
      },
    );
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
    this.child.on("exit", (code, signal) => {
      const err = new Error(`laya sidecar exited (${signal ?? code}): ${this.errBuffer.trim()}`);
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
    });
    this.child.on("error", (err) => {
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
    });
    // The launcher exits when the CLI exits; without this the sidecar would survive as an
    // orphan holding the whole model in memory for every session that ever ran.
    process.on("exit", () => {
      try {
        this.child.kill();
      } catch {
        // Already gone.
      }
    });
  }

  #onStdout(chunk) {
    this.buffer += chunk;
    for (;;) {
      const end = this.buffer.indexOf("\n");
      if (end < 0) return;
      const line = this.buffer.slice(0, end).trim();
      this.buffer = this.buffer.slice(end + 1);
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.id == null) continue; // noise
        const entry = this.pending.get(parsed.id);
        if (!entry) continue;
        // An ack echo is the bare `{"id": N}` line the sidecar sends before running the
        // model; only the full result line (any other shape) resolves the ask. This is
        // what lets the sidecar pay its model load after the echo instead of before it.
        if (Object.keys(parsed).length === 1 && !entry.sawAck) {
          entry.sawAck = true;
          if (entry.ackTimer) {
            clearTimeout(entry.ackTimer);
            entry.ackTimer = null;
          }
          continue;
        }
        this.pending.delete(parsed.id);
        if (entry.ackTimer) {
          clearTimeout(entry.ackTimer);
          entry.ackTimer = null;
        }
        entry.resolve(parsed);
      } catch {
        // Unparseable line; keep going.
      }
    }
  }

  ask(request) {
    const id = this.nextId++;
    const payload = { ...request, id };
    return new Promise((resolve, reject) => {
      const entry = { id, resolve, reject, ackTimer: null };
      this.pending.set(id, entry);
      // The sidecar echoes the id before running the model, so a missing echo within a
      // short window means it crashed on the request line — fail fast instead of waiting
      // out the full model deadline. A pending failure is rejected from the stderr path
      // (which carries the id), never from here.
      entry.ackTimer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`laya sidecar unresponsive: ${this.errBuffer.trim()}`));
        }
      }, THRESHOLDS.ackMs);
      this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    });
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
  try {
    const result = await getSidecar().ask(request);
    // The bridge normalises rubric scores to 0..1 and computes the mean score-question
    // confidence itself; its metrics arrive ready for the policy and explanation layers.
    // `confidence` is set explicitly AFTER the spread: the N-way model answer carries its
    // own near-flat confidence (0.02-0.05 on wide sets), and letting it win through the
    // spread would neuter the policy's confidence gate.
    const { model: answer, task_complexity, reasoning_required, tool_complexity } = result.answers;
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
    return null;
  }
}

let sidecar;
export function getSidecar() {
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
