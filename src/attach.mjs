// Lets `laya-claude` join the background app's proxy instead of running a private one.
//
// Measured on 2026-09-30: two real `laya-claude` turns left the app with 0 events, because the
// launcher started its own proxy with no reporting and the app never heard about them. Joining the
// daemon's proxy fixes three things at once: the app sees real sessions, the usage and limit
// figures include them, and there is one warm model instead of one per terminal.
//
// This must never make the launcher worse. Every failure here means "nothing to join" (null), and
// the launcher carries on exactly as it did before: a private proxy, its own model.
import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { HOME_DIR } from "./prefs.mjs";

const validPort = (n) => Number.isInteger(n) && n >= 1 && n <= 65535;

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to someone else, which is still "alive".
    return err.code === "EPERM";
  }
};

/** One request, one reply, or null on any failure or silence. Never throws, never hangs. */
function ask(port, message, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    let buf = "";
    const socket = connect({ host: "127.0.0.1", port });
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    socket.on("error", () => finish(null));
    socket.on("close", () => finish(null));
    socket.on("connect", () => socket.write(`${JSON.stringify(message)}\n`));
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      try {
        finish(JSON.parse(buf.slice(0, nl)));
      } catch {
        finish(null);
      }
    });
  });
}

/**
 * The daemon's Claude proxy, started if it was stopped, or null when there is no daemon to join.
 * @returns {Promise<{port: number, attached: true} | null>}
 */
export async function findDaemonProxy({ home = HOME_DIR(), timeoutMs = 1500, env = process.env } = {}) {
  if (env.LAYA_NO_DAEMON === "1") return null;

  let run;
  try {
    run = JSON.parse(readFileSync(join(home, "run.json"), "utf8"));
  } catch {
    return null;
  }
  if (!validPort(run?.port) || typeof run?.token !== "string" || !Number.isInteger(run?.pid) || !alive(run.pid)) return null;

  // A read-only look needs no credential, so none is sent.
  const look = await ask(run.port, { id: 1, action: "snapshot" }, timeoutMs);
  const claude = look?.result?.engines?.claude;
  if (!claude || typeof claude !== "object") return null;
  // Running but reporting a port that cannot be right is a daemon in a state it should not be in.
  // That is not "stopped", so asking it to start something would paper over the inconsistency;
  // the launcher is better off with its own proxy than with a guess.
  if (claude.running) return validPort(claude.port) ? { port: claude.port, attached: true } : null;

  // The proxy is stopped (the user switched it off in the app, or the app has not started it yet).
  // Asking to start it is a change, so it carries the token that only this user's files hold.
  const started = await ask(run.port, { id: 2, action: "engine.start", token: run.token, arg: { engine: "claude" } }, timeoutMs);
  const port = started?.result?.port;
  return validPort(port) ? { port, attached: true } : null;
}
