#!/usr/bin/env node
// A stand-in for the Python sidecar, speaking the same line protocol as laya_bridge.py, so the
// router's behaviour around a failing, slow or dying sidecar can be tested without a 1 GB model.
//
// Behaviour is chosen per request from the file named by FAKE_SIDECAR_MODE, read fresh each time:
//   ok         answer with plausible scores
//   error      answer with an error line on stderr, like a handled exception in the bridge
//   crash      print a traceback and exit non-zero, like an unhandled one
//   silent     read the request and never answer or echo (a sidecar that cannot read its input)
//   hang       echo the request and then never answer (a model that is stuck)
//   slow:N     echo, wait N ms, then answer (a model under load)
//   slowerror:N  echo, wait N ms, then fail the request with an error line (slow, and not working)
//   cold:N     the first request this process answers waits N ms, later ones do not (a model that
//              loads on first use, as the real one did before it loaded at start)
// A missing or empty file means "ok". FAKE_SIDECAR_LOG, if set, gets one line per process start.
//
// Environment, for the way a process starts rather than how it answers:
//   FAKE_SIDECAR_EVENTS=1        say "loading" at start and "ready" when done, as the real bridge does
//   FAKE_SIDECAR_LOAD_MS=N       how long that load takes; requests wait behind it, as they do there
//   FAKE_SIDECAR_FAIL_LOAD=text  the load fails with this text (an event, then requests are answered)
//   FAKE_SIDECAR_CRASH_AT_START=1  die with a traceback before reading anything, mid-load
//
// The echo is sent the moment a line arrives, before anything else, as the real bridge's reader
// thread does; answers are produced one at a time in the order the requests came, as its worker does.
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

if (process.env.FAKE_SIDECAR_LOG) appendFileSync(process.env.FAKE_SIDECAR_LOG, `start ${process.pid}\n`);

const mode = () => {
  try {
    return readFileSync(process.env.FAKE_SIDECAR_MODE, "utf8").trim() || "ok";
  } catch {
    return "ok";
  }
};

// A real model that is mid-load reads nothing, so its stdin closing does not end it. This keeps the
// stand-in alive the same way, until it is told to stop (a signal still ends it, as it would a
// busy Python process).
if (process.env.FAKE_SIDECAR_STUBBORN) setInterval(() => {}, 1000);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let loaded = false;

async function answer(req) {
  const [kind, arg] = mode().split(":");
  if (kind === "hang") await new Promise(() => {});
  if (kind === "crash") {
    process.stderr.write(
      `Traceback (most recent call last):\n  File "/Users/someone/.laya-router/venv/lib/python3.12/site-packages/laya/router.py", line 12, in <module>\n    import torch\nModuleNotFoundError: No module named 'torch'\n`,
    );
    process.exit(1);
  }
  if (kind === "error") {
    process.stderr.write(`${JSON.stringify({ id: req.id, error: "checkpoint could not be loaded" })}\n`);
    return;
  }
  if (kind === "slowerror") {
    await sleep(Number(arg));
    process.stderr.write(`${JSON.stringify({ id: req.id, error: "checkpoint could not be loaded" })}\n`);
    return;
  }
  if (kind === "slow") await sleep(Number(arg));
  if (kind === "cold" && !loaded) await sleep(Number(arg));
  loaded = true;
  const metrics = { taskComplexity: 0.5, reasoningRequired: 0.5, toolComplexity: 0.5, judgment: 0.4, contextSize: 0.01 };
  process.stdout.write(
    `${JSON.stringify({ id: req.id, answers: { model: { choice: "claude-sonnet-5-5", confidence: 0.4 } }, metrics, confidence: 0.4 })}\n`,
  );
}

let queue = Promise.resolve();
if (process.env.FAKE_SIDECAR_CRASH_AT_START) {
  process.stderr.write(
    `Traceback (most recent call last):\n  File "/Users/someone/.laya-router/venv/lib/python3.12/site-packages/laya/router.py", line 12, in <module>\n    import torch\nModuleNotFoundError: No module named 'torch'\n`,
  );
  process.exit(1);
}
if (process.env.FAKE_SIDECAR_EVENTS) {
  process.stdout.write(`${JSON.stringify({ event: "loading" })}\n`);
  const began = Date.now();
  queue = sleep(Number(process.env.FAKE_SIDECAR_LOAD_MS ?? 0)).then(() => {
    if (process.env.FAKE_SIDECAR_FAIL_LOAD) {
      process.stdout.write(`${JSON.stringify({ event: "failed", error: `laya failed: ${process.env.FAKE_SIDECAR_FAIL_LOAD}` })}\n`);
      return;
    }
    loaded = true;
    process.stdout.write(`${JSON.stringify({ event: "ready", ms: Date.now() - began })}\n`);
  });
}
createInterface({ input: process.stdin }).on("line", (line) => {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  if (mode().split(":")[0] === "silent") return;
  // The real bridge echoes the id first, so a crash on the request line can be told from a slow model.
  process.stdout.write(`${JSON.stringify({ id: req.id })}\n`);
  queue = queue.then(() => answer(req));
});
