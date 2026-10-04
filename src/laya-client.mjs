// Ask the running daemon's warm Laya model typed questions. One client for every local tool that
// needs a judgment (the guard hook, the file inspector), so none of them loads its own 1.3 GB copy
// or waits ~40s for it. Fails with an Error when there is no daemon, no token, or no answer in time;
// every caller treats that as "Laya has no opinion" and falls back to its deterministic rules.
import { connect } from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HOME_DIR } from "./prefs.mjs";

export function readRun(home = HOME_DIR()) {
  const run = JSON.parse(readFileSync(join(home, "run.json"), "utf8"));
  if (!Number.isInteger(run?.port) || typeof run?.token !== "string") throw new Error("no daemon run file");
  return run;
}

/**
 * @param {string} state  what the questions are about, short and with the deciding facts first
 * @param {Record<string, {type: "noul"|"choice"|"score", instructions: string, criteria?: any}>} questions
 * @returns {Promise<Record<string, object>>} Laya's answers by question id
 */
export function askLaya(state, questions, { timeoutMs = 8000, home = HOME_DIR(), run = null } = {}) {
  const r = run ?? readRun(home);
  return new Promise((resolve, reject) => {
    const socket = connect(r.port, "127.0.0.1");
    let buf = "";
    const done = (fn, v) => {
      clearTimeout(timer);
      socket.destroy();
      fn(v);
    };
    const timer = setTimeout(() => done(reject, new Error(`laya: no answer in ${timeoutMs}ms`)), timeoutMs);
    socket.on("error", (err) => done(reject, err));
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ id: 1, action: "laya.ask", token: r.token, arg: { state, questions } })}\n`);
    });
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const i = buf.indexOf("\n");
      if (i < 0) return;
      let msg;
      try {
        msg = JSON.parse(buf.slice(0, i));
      } catch {
        return done(reject, new Error("laya: bad reply"));
      }
      if (msg.error) return done(reject, new Error(`laya: ${msg.error}`));
      done(resolve, msg.result ?? {});
    });
  });
}

/** A noul answer's probability, or null. */
export const yesOf = (a) => (a && Number.isFinite(Number(a.noul)) ? Number(a.noul) : null);
