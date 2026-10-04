// Laya, as a background app. One long-lived process that owns the router, so a session's ~85s
// cold start is paid once for the whole day instead of once per terminal. The UI never talks to
// Laya or the proxy directly: it calls the control socket below, and the proxies call back with
// decisions and token usage. The socket answers on 127.0.0.1 with a per-boot token, so another
// process on this Mac cannot read a routing history or change a setting without that token.
import { connect, createServer } from "node:net";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startProxy } from "./proxy.mjs";
import { startCodexProxy } from "./codex-proxy.mjs";
import { askTyped, sidecarTracker, warmSidecar } from "./router.mjs";
import { EFFORT, TIERS, scoreTierFor } from "./config.mjs";
import { ENGINES, loadPrefs, mergePrefs, savePrefs, HOME_DIR } from "./prefs.mjs";
import { createLedger } from "./usage.mjs";
import { costOf, pricesFor } from "./pricing.mjs";
import { activeWindows, loadLimits, mergeLimits, projectHit, saveLimits } from "./limits.mjs";
import { createAlerts } from "./alerts.mjs";
import { defaultEnvFiles, loadEnvFiles } from "./envfile.mjs";
import { homedir } from "node:os";
import { log } from "./log.mjs";
import { fixedInterval, watchAccount } from "./account.mjs";
import { foldPlanReading, planPollHandlers, planTickMs, watchPlanUsage } from "./plan-usage.mjs";
import { isMain } from "./is-main.mjs";

// The same settings files the command-line launcher reads. Without this, LAYA_PYTHON kept in
// ~/.laya-router.env (where setup records it) never reached the login-item daemon.
loadEnvFiles(defaultEnvFiles(homedir()));

const debug = (line) => process.env.LAYA_DEBUG && log(line);

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const LIVE = join(HOME_DIR(), "events.jsonl");
const RUN_FILE = join(HOME_DIR(), "run.json");
const CONTROL_PORT = Number(process.env.LAYA_CONTROL_PORT ?? 8790);
const KEEP_EVENTS = 2000;

export const RUNTIME_FILE = RUN_FILE;

/** The controller the menu-bar app talks to. Also the only thing that writes settings. */
class Controller {
  constructor({ prefs = loadPrefs() } = {}) {
    this.prefs = prefs;
    this.listeners = new Set();
    this.events = [];
    this.engines = { claude: { running: false, port: 0, sessions: 0, startedAt: null }, codex: { running: false, port: 0, sessions: 0, startedAt: null } };
    // What the routing model is actually doing, from the asks that reach it. "Warm" is only ever
    // claimed after an answer came back; a pinned turn (no decision) proves nothing about it.
    this.sidecarState = sidecarTracker.store.get();
    this.sidecarSince = null;
    sidecarTracker.store.subscribe((v) => {
      if (v.state !== this.sidecarState?.state) this.sidecarSince = Date.now();
      this.sidecarState = v;
      this.publish?.();
    });
    this.ledger = createLedger({ baselineTier: () => this.prefs.baselineTier });
    this.limits = loadLimits();
    // Whether Claude Code is signed in, as Claude Code itself says. Until the first check comes
    // back this is "unknown", which the app does not treat as a reason to ask anyone to sign in.
    this.account = { state: "unknown", method: null };
    this.alerts = createAlerts();
    this.limitsTimer = null;
    this.loadEvents();
  }

  /**
   * The plan's limits as the latest response reported them. Stored, checked for alerts, and
   * pushed to the app. The figure is written to disk a moment later rather than on every
   * response, since a busy session produces one every second or two.
   */
  ingestLimits(reading) {
    this.limits = mergeLimits(this.limits, reading);
    this.checkAlerts();
    this.publish();
    if (!this.limitsTimer) {
      this.limitsTimer = setTimeout(() => {
        this.limitsTimer = null;
        try {
          if (this.limits) saveLimits(this.limits);
        } catch {
          // Losing a usage figure is not worth a crash.
        }
      }, 1000);
      this.limitsTimer.unref?.();
    }
  }

  /**
   * Writes what is still waiting to be written. The day's ledger and the plan's limits are saved a
   * moment after they change (a busy session produces a reading every second or two), so a stop
   * that skipped this would lose up to two seconds of figures, and always the newest ones.
   */
  persist() {
    try {
      if (this.limits) saveLimits(this.limits);
    } catch (err) {
      debug(`could not save the plan's limits: ${err?.message ?? err}`);
    }
    this.ledger.flush();
  }

  /**
   * Takes a fresh reading of the sign-in state. A reading that is not a clear answer leaves the
   * last clear one in place: one unreadable reply must not turn a signed-in panel into a prompt.
   * The app is told only when something changed.
   */
  setAccount(reading) {
    if (reading.state === "unknown") return false;
    if (reading.state === this.account.state && reading.method === this.account.method) return false;
    this.account = { state: reading.state, method: reading.method };
    this.publish();
    return true;
  }

  /**
   * A reading taken from Claude Code itself, not from a response that passed through here.
   *
   * This keeps the figure on screen when no turn is going through Laya: on a new machine there may
   * never be one, and on any machine the last response's window ends within five hours. What the
   * probe cannot say (whether a window is blocked, which one is binding, whether overage was
   * refused) stays as the response headers last reported it, since an unknown is not a "no";
   * `foldPlanReading` says exactly what is carried. Anything that is not a recent reading is
   * ignored, and the last real one is left to age on its own.
   */
  ingestPlanUsage(reading) {
    const folded = foldPlanReading(this.limits, reading);
    if (!folded) return false;
    this.ingestLimits(folded);
    return true;
  }

  /** Runs the alert rules against the current figure. Also called on a timer, for resets. */
  checkAlerts() {
    try {
      return this.alerts.evaluate({ limits: this.limits, prefs: this.prefs.alerts });
    } catch (err) {
      debug(`alerts failed: ${err.message}`);
      return [];
    }
  }

  /** Restores the feed from the last run, so the panel is not empty after a restart. */
  loadEvents(file = LIVE) {
    try {
      const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
      this.events = lines.map((line) => JSON.parse(line)).slice(-KEEP_EVENTS);
    } catch {
      this.events = [];
    }
  }

  get running() {
    return Object.values(this.engines).some((e) => e.running);
  }

  subscribe(send) {
    this.listeners.add(send);
    send(this.snapshot());
    return () => this.listeners.delete(send);
  }

  publish() {
    const snap = this.snapshot();
    for (const send of this.listeners) {
      try {
        send(snap);
      } catch {
        this.listeners.delete(send);
      }
    }
  }

  /** Tiers the router may pick, from prefs rather than the environment. */
  tiers() {
    return TIERS.filter((t) => this.prefs.tiers[t.name]).map((t) => t.name);
  }

  /**
   * What anyone on this Mac may see without the token: that this is Laya and where its proxy is,
   * which is all `laya-claude` needs to join it. Prompts, history, spend and settings are not here.
   */
  publicSnapshot() {
    return { laya: true, engines: this.engines };
  }

  snapshot() {
    const usage = this.ledger.snapshot();
    const now = Date.now();
    const live = this.limits
      ? {
          ...this.limits,
          // A window past its reset no longer describes the plan; the app should not draw it.
          // `pace` is when a steady rate would empty the window, or null. Computed here, once, so
          // the app draws a number it was handed instead of reimplementing the arithmetic.
          windows: Object.fromEntries(
            activeWindows(this.limits, now).map(({ key, ...w }) => [key, { ...w, pace: projectHit({ key, ...w }, now) }]),
          ),
        }
      : null;
    return {
      laya: true,
      limits: live,
      alerts: this.alerts.recent(),
      account: this.account,
      prefs: this.prefs,
      engines: this.engines,
      sidecar: { state: this.sidecarState.state, since: this.sidecarSince, lastError: this.sidecarState.error },
      tiers: this.tiers(),
      usage,
      // The cuts routing uses now, which the preset shifts (Balanced is SCORE_TIER itself).
      thresholds: { ...scoreTierFor(this.prefs.preset), effort: EFFORT },
      models: TIERS.map((t) => ({ tier: t.name, id: t.id, thinking: t.thinking, effort: t.effort })),
      events: this.events.slice(-120),
      now,
    };
  }

  update(patch) {
    const next = mergePrefs(this.prefs, patch);
    const changed = JSON.stringify(next) !== JSON.stringify(this.prefs);
    if (!changed) return this.prefs;
    this.prefs = next;
    savePrefs(next);
    this.publish();
    // Tiers and the master switch are read per turn by the proxies, so nothing to restart; the
    // paused tier and the preset are re-read the same way. The file is the notification.
    return this.prefs;
  }

  record(event) {
    this.events.push(event);
    if (this.events.length > KEEP_EVENTS) this.events.splice(0, this.events.length - KEEP_EVENTS);
    try {
      mkdirSync(dirname(LIVE), { recursive: true, mode: 0o700 });
      writeFileSync(LIVE, this.events.map((e) => JSON.stringify(e)).join("\n"), { mode: 0o600 });
    } catch {
      // The live feed is cosmetic.
    }
  }
}

const controller = new Controller();

/** The engine a request names, or the configured one. Anything else is refused by name. */
function engineArg(arg) {
  const engine = arg?.engine ?? controller.prefs.launch.engine;
  if (!ENGINES.includes(engine)) throw new Error(`unknown engine ${JSON.stringify(String(engine)).slice(0, 40)}`);
  return engine;
}

/** The wire the UI and the proxies use. One JSON object in, one JSON object out. */
function handle(action, arg) {
  switch (action) {
    case "snapshot":
      return controller.snapshot();
    case "ping":
      return { pong: true };
    case "prefs.update":
      return controller.update(arg);
    case "alerts.test": {
      const a = controller.alerts.test();
      controller.publish();
      return a;
    }
    case "laya.ask": {
      // Typed questions for local tools (the guard hook, the file inspector) on the model this
      // daemon already holds warm, so none of them pays the ~40s load. Token-gated like every change.
      const { state, questions } = arg ?? {};
      return askTyped(String(state ?? "").slice(0, 4000), questions);
    }
    case "usage.reset":
      controller.ledger.reset();
      controller.publish();
      return controller.snapshot();
    case "engine.start":
      return startEngine(engineArg(arg));
    case "engine.stop":
      return stopEngine(engineArg(arg));
    case "event": {
      const { kind, tier, model, effort, effortReason, reason, usage, prompt, ms, confidence, session, class: cls, step, status, cleared } = arg ?? {};
      const at = Date.now();
      const entry = {
        at,
        kind,
        // main | subagent | auxiliary | step: which conversation, or which mid-task check, this was.
        class: cls,
        tier,
        model,
        effort,
        // Why that level: the rule in policy.effortWhy, "user-chosen", or "effort-auto-off".
        effortReason,
        reason,
        ms,
        confidence,
        prompt: controller.prefs.showPrompts ? prompt : undefined,
        session,
        // A step check: from/to, whether it switched, and the saving and cache rebuild it weighed.
        // What LAYA was asked is the assistant's own words, so it follows the prompt setting.
        step: step ? { ...step, prompt: controller.prefs.showPrompts ? step.prompt : undefined } : undefined,
        // The upstream HTTP status: a 400 here is a request the routed model refused.
        status,
        // The token counts travel with the event, so the app can show them and the ledger can
        // price the turn without a second call into the proxy.
        usage: usage ?? null,
        // Old tool results the API trimmed from this request's prompt (src/trim.mjs), when it did.
        ...(cleared ? { cleared } : {}),
        // Priced here, from the same table the ledger uses, so the number on a decision card can
        // never disagree with the day's total. The app displays it and does no arithmetic of its own.
        ...(usage ? { cost: costOf(usage, pricesFor(model, tier)) } : {}),
      };
      // One place records, one place totals: an event and its cost can never disagree.
      controller.record(entry);
      if (usage) {
        controller.ledger.record({ tier, model, usage, routed: kind === "routed", cleared });
      }
      controller.publish();
      return null;
    }
    case "quit":
      // After the reply has gone out, so the app that asked is told it worked.
      setTimeout(() => shutdown("quit"), 20);
      return { ok: true };
    default:
      throw new Error(`unknown action ${action}`);
  }
}

const engines = {};

/**
 * The one way the daemon ends, whether launchd asked (SIGTERM: a logout, a restart, an upgrade), a
 * terminal closed (SIGHUP), someone pressed ^C (SIGINT) or the app's Quit button was pressed.
 * Node's default for a signal is to die on the spot and run no exit handler, which lost the newest
 * figures and left the routing model running with no one to answer to. Exits 0: a requested stop is
 * not a crash, and launchd restarts a job that exits non-zero.
 *
 * Synchronous on purpose. Saving is two small file writes, so there is nothing to wait for, and
 * nothing for a second signal to interleave with. A session that is mid-stream is cut off, as it
 * would be by any restart; it reconnects to the same proxy port when the daemon is back.
 */
function shutdown(why) {
  debug(`stopping (${why})`);
  controller.persist();
  process.exit(0); // runs the exit handlers, one of which ends the routing model
}

/**
 * Starts the shared proxy for an engine. The proxy is the only thing that talks to Laya, so
 * every session on this Mac shares one sidecar and one warm model.
 */
async function startEngine(engine) {
  if (engines[engine]?.running) return controller.engines[engine];
  const info = controller.engines[engine];
  info.running = true;
  info.startedAt = Date.now();
  try {
    if (engine === "claude") {
      // A fixed port, so a session that is already running keeps working across a daemon restart
      // (its base URL was fixed when it started). 0 asks for any free port.
      const wanted = Number(process.env.LAYA_CLAUDE_PROXY_PORT ?? 8791);
      const { port, close } = await startProxy({
        onEvent: (e) => handle("event", e),
        onLimits: (r) => controller.ingestLimits(r),
        port: Number.isInteger(wanted) && wanted >= 0 && wanted <= 65535 ? wanted : 0,
      });
      engines.claude = { close };
      info.port = port;
    } else {
      const { port, close } = await startCodexProxy({ onEvent: (e) => handle("event", e) });
      engines.codex = { close };
      info.port = port;
    }
  } catch (err) {
    info.running = false;
    throw err;
  }
  warmSidecar();
  controller.publish();
  return info;
}

async function stopEngine(engine) {
  const e = engines[engine];
  if (e?.close) await e.close();
  delete engines[engine];
  const info = controller.engines[engine];
  info.running = false;
  info.port = 0;
  info.startedAt = null;
  controller.publish();
  return info;
}

/** How the control socket authenticates: a token only this process knows, on 127.0.0.1. */
function readToken() {
  try {
    return JSON.parse(readFileSync(RUN_FILE, "utf8")).token;
  } catch {
    return null;
  }
}

/**
 * Asks whoever is listening on the control port whether they are Laya. A bind failure alone
 * cannot tell "another Laya" from "some other program": the run file is per-LAYA_HOME while the
 * port is global, so a second instance pointed at a different home cannot see the first one's
 * run file even though the first one is right there holding the port. Probing answers it.
 */
async function probeForLaya(port) {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    let buf = "";
    const finish = (answer) => {
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(1500, () => finish(null));
    socket.on("error", () => finish(null));
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      try {
        const msg = JSON.parse(buf.slice(0, nl));
        // `snapshot` needs no token, so this doubles as a liveness check.
        // `laya: true` is what this version answers with; an older daemon answers a snapshot with
        // the full one, which has `prefs`. Both are Laya.
        finish(msg.result?.laya === true || msg.result?.prefs ? msg.result : null);
      } catch {
        finish(null);
      }
    });
    socket.on("connect", () => socket.write(`${JSON.stringify({ id: 1, action: "snapshot" })}\n`));
  });
}

function startControl() {
  const token = process.env.LAYA_TOKEN || readToken() || `t-${Date.now()}-${process.pid}`;
  const server = createServer((socket) => {
    // A client can vanish at any instant — the menu-bar app is force-quit, a terminal is
    // closed — and an unhandled 'error' on the socket would take the whole daemon down with
    // it, discarding a 1.3GB warm model. Errors are per-connection and never fatal.
    socket.on("error", (err) => debug(`control socket: ${err.code ?? err.message}`));
    let buf = "";
    // Writing to a socket the peer has already reset throws EPIPE/ECONNRESET. The only thing
    // the daemon wants from a dead connection is nothing, so writes are guarded.
    const reply = (payload) => {
      if (socket.destroyed || !socket.writable) return;
      try {
        socket.write(`${JSON.stringify(payload)}\n`);
      } catch (err) {
        debug(`control write failed: ${err.code ?? err.message}`);
        socket.destroy();
      }
    };
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          reply({ id: null, error: "bad json" });
          continue;
        }
        // Every reply names the request it answers: the app matches them up by this id.
        const answer = (payload) => reply({ id: msg.id, ...payload });
        const trusted = msg.token === token;
        // A look at whether Laya is there needs no credential and returns almost nothing.
        // Everything else, including the full snapshot, is for the local UI holding the token.
        if (msg.action === "snapshot" && !trusted) {
          answer({ result: controller.publicSnapshot() });
          continue;
        }
        if (!trusted) {
          answer({ error: "forbidden" });
          continue;
        }
        if (msg.action === "subscribe") {
          const off = controller.subscribe((snap) => answer({ event: snap }));
          // `once` for the detach, so a client that both closes and errors still unsubscribes
          // exactly once and the listener set cannot grow a leak per reconnect.
          socket.once("close", off);
          socket.once("error", off);
          answer({ ok: true });
          continue;
        }
        // Some actions are asynchronous (starting or stopping a proxy). Answering with the raw
        // return value sent `{}` for a promise, and a rejection nobody caught ended the process,
        // which throws away the warm model. A real promise is awaited and both outcomes answered.
        // An ordinary value is answered on the spot, so replies to quick requests keep arriving in
        // the order they were asked: only a request that genuinely takes time may be overtaken.
        try {
          const out = handle(msg.action, msg.arg);
          if (out && typeof out.then === "function") {
            out.then(
              (result) => answer({ result }),
              (err) => answer({ error: err?.message ?? String(err) }),
            );
          } else {
            answer({ result: out });
          }
        } catch (err) {
          answer({ error: err.message });
        }
      }
    });
  });
  return new Promise((resolve, reject) => {
    // A server that cannot bind must say why in one line and stop. Without this handler Node
    // rethrows EADDRINUSE as an unhandled 'error' event and prints a stack trace, which is a
    // terrible answer to "Laya is already running" — a completely ordinary situation when
    // launchctl starts the login item while someone runs bin/laya-daemon by hand.
    server.once("error", (err) => {
      if (err.code !== "EADDRINUSE") return reject(err);
      // Someone has the port. Find out whether it is Laya before saying anything, because the
      // two cases need opposite advice: "you already have one" versus "pick another port".
      const known = runningInfo();
      probeForLaya(CONTROL_PORT).then((theirs) => {
        const alreadyRunning = Boolean(known) || Boolean(theirs);
        reject(
          Object.assign(
            new Error(
              alreadyRunning
                ? `Laya is already running on port ${CONTROL_PORT}. Nothing to do.` +
                  (known ? ` (pid ${known.pid})` : "")
                : `Port ${CONTROL_PORT} on 127.0.0.1 is in use by something other than Laya. ` +
                  `Set LAYA_CONTROL_PORT to a free port to run a second one.`,
            ),
            { code: err.code, port: CONTROL_PORT, alreadyRunning },
          ),
        );
      });
    });
    server.listen(CONTROL_PORT, "127.0.0.1", () => {
      const info = { token, port: CONTROL_PORT, pid: process.pid, startedAt: Date.now(), root: ROOT };
      mkdirSync(HOME_DIR(), { recursive: true, mode: 0o700 });
      // Written whole and renamed into place: the launcher, the guard hook and the file tool read
      // this file at any moment, and a half-written one parsed as an error (seen in the test suite).
      const tmp = `${RUN_FILE}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(info), { mode: 0o600 });
      renameSync(tmp, RUN_FILE);
      controller.publish();
      resolve(info);
    });
  });
}

/** Reads the run file if a daemon is already there, so the UI can attach instead of failing. */
export function runningInfo() {
  try {
    const info = JSON.parse(readFileSync(RUN_FILE, "utf8"));
    return info.pid && processExists(info.pid) ? info : null;
  } catch {
    return null;
  }
}

const processExists = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

if (isMain(import.meta.url)) {
  const already = runningInfo();
  if (already && already.pid !== process.pid) {
    process.stderr.write(`[laya] a daemon is already running (pid ${already.pid})\n`);
    process.exit(0);
  }
  // Refusing to start is a normal outcome, not a crash: another Laya is already up, or the port
  // is taken. One line, a sensible exit code, no stack trace. The login item reads a non-zero
  // exit as a crash and logs it, so "already running" exits 0.
  let info;
  try {
    info = await startControl();
  } catch (err) {
    process.stderr.write(`[laya] ${err.message}\n`);
    process.exit(err.alreadyRunning ? 0 : 1);
  }
  const { port } = info;
  // The app's own reason for existing: one router, warm, for the whole day.
  if (controller.prefs.launch.engine) await startEngine(controller.prefs.launch.engine).catch(() => {});
  process.stderr.write(`[laya] control socket on 127.0.0.1:${port}\n`);
  // (No timer decides the routing model's state any more. It used to flip to "starting" two
  // minutes after the last turn whether or not anything was wrong, which left the dot wrong most
  // of the time. The state now follows the outcome of each ask, in router.mjs.)
  // A reset happens whether or not anything is being sent, so it is noticed on a timer rather
  // than waiting for the next response to arrive. Cheap: it only reads state already in memory.
  const tick = Number(process.env.LAYA_ALERT_TICK_MS ?? 30000);
  const alertClock = setInterval(() => {
    if (controller.checkAlerts().length) controller.publish();
  }, Number.isFinite(tick) && tick >= 50 ? tick : 30000);
  alertClock.unref?.();
  watchAccount({
    onReading: (reading) => controller.setAccount(reading),
    onError: (err) => debug(`account check failed: ${err?.message ?? err}`),
    every: fixedInterval(process.env.LAYA_ACCOUNT_TICK_MS), // quieter or quicker than the default, if asked
  });
  // The plan's usage, asked of Claude Code on a timer, so the menu bar and the panel have the figure
  // whether or not a turn is going through Laya. Only for someone who is signed in: for anyone else
  // the probe would answer with a session summary and no limits, and spawn a process for nothing.
  const planEvery = planTickMs(process.env.LAYA_PLAN_TICK_MS); // null: switched off
  if (planEvery !== null) {
    watchPlanUsage({
      ...planPollHandlers({ ingest: (reading) => controller.ingestPlanUsage(reading), log }),
      every: planEvery,
      enabled: () => controller.account.state === "signed-in",
    });
  }
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => shutdown(signal));
}
