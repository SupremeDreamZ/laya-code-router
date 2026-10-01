// Is Claude Code signed in? Asked of Claude Code itself.
//
// Sign-in is Claude Code's own: Laya never sees, stores or asks for a credential. This runs
// `claude auth status` and keeps the two facts the app can use, whether there is a sign-in and by
// what method. The rest of that output (email address, organisation, config path, a cached plan
// name) is dropped here, because this result goes into a snapshot every local subscriber gets.
import { execFile } from "node:child_process";
import { accessSync, constants, readdirSync, statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { isMain } from "./is-main.mjs";

const SYSTEM_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"];

// launchd starts the daemon with almost no PATH, and the native installer puts `claude` in
// ~/.local/bin, which that PATH never lists. So the usual homes are tried by name.
const HOME_DIRS = [".local/bin", ".claude/local", ".npm-global/bin", ".volta/bin", ".asdf/shims"];
const NVM = ".nvm/versions/node";

const UNKNOWN = Object.freeze({ state: "unknown", method: null });
const MISSING = Object.freeze({ state: "missing", method: null });

const isBinary = (path) => {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * Every place `claude` may be, in the order they are tried. Touches nothing on disk.
 * Only absolute paths: an empty or relative PATH entry means "the folder I happen to be in", and
 * running whatever is named `claude` there is not something a background service should do.
 */
export function claudeCandidates({ env = process.env, home = homedir(), system = SYSTEM_DIRS } = {}) {
  const dirs = [...(env.PATH ?? "").split(delimiter), ...HOME_DIRS.map((d) => join(home, d)), ...system];
  const list = [env.LAYA_CLAUDE_BIN, ...dirs.map((d) => join(d, "claude"))].filter((p) => p && isAbsolute(p));
  return [...new Set(list)];
}

/** The first runnable `claude`, or null. Node versions under nvm are tried newest first. */
export function findClaude(options = {}) {
  const { home = homedir() } = options;
  const found = claudeCandidates(options).find(isBinary);
  if (found) return found;
  try {
    const base = join(home, NVM);
    const versions = readdirSync(base).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    return versions.map((v) => join(base, v, "bin", "claude")).find(isBinary) ?? null;
  } catch {
    return null;
  }
}

// A method is a short word like "claude.ai". Anything else is not shown.
const METHOD = /^[\w.-]{1,32}$/;

function parse(stdout) {
  let reply;
  try {
    reply = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (typeof reply?.loggedIn !== "boolean") return null;
  if (!reply.loggedIn) return { state: "signed-out", method: null };
  return { state: "signed-in", method: METHOD.test(reply.authMethod) ? reply.authMethod : null };
}

/**
 * @returns {Promise<{state: "signed-in"|"signed-out"|"missing"|"unknown", method: ?string}>}
 * "unknown" means Claude Code was asked and did not give a clear answer. It is never a guess.
 */
export function readAccount({ env = process.env, home = homedir(), system, timeoutMs = 10_000 } = {}) {
  const bin = findClaude({ env, home, system });
  if (!bin) return Promise.resolve(MISSING);
  // A claude installed by npm is a script that starts `#!/usr/bin/env node`, and a background
  // service has no node on its PATH. The node running this is added after the PATH, as a fallback:
  // where the person has a node of their own, `claude` gets the one it gets in their terminal.
  // `claude auth status` reports "signed out" when USER is missing, whoever is signed in (measured
  // 2026-09-30), so a stripped environment must not be read as the person having no sign-in.
  const childEnv = {
    ...env,
    USER: env.USER || userInfo().username,
    PATH: [env.PATH, dirname(process.execPath)].filter(Boolean).join(delimiter),
  };
  return new Promise((resolve) => {
    const child = execFile(
      bin,
      ["auth", "status"],
      { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 256 * 1024, env: childEnv },
      (err, stdout) => {
        // A non-zero exit still carries an answer (signed out, it prints one and exits 1), so the
        // output decides. Every other way of failing (a deadline, a signal, too much output, a
        // script that cannot start) leaves no answer to trust, even if some of it parses.
        if (err && typeof err.code !== "number") return resolve(UNKNOWN);
        resolve(parse(String(stdout ?? "")) ?? UNKNOWN);
      },
    );
    child.stdin?.end();
  });
}

/** For scripts: 0 signed in, 1 signed out, 2 not installed, 3 cannot tell. */
export const exitCodeFor = (state) => ({ "signed-in": 0, "signed-out": 1, missing: 2 })[state] ?? 3;

/**
 * How long to wait before asking again. Someone signed out (or without Claude Code) is probably
 * about to fix that, so the panel should notice within seconds; someone signed in is checked
 * rarely, since each check starts a process; an unreadable reply is retried at a middle pace.
 */
export const nextCheckMs = (state, { fast = 3000, middle = 15000, slow = 60000 } = {}) =>
  ({ "signed-in": slow, "signed-out": fast, missing: fast })[state] ?? middle;

// Node turns a timer it cannot hold (past 2^31-1 ms, or Infinity) into a 1 ms one, and every tick
// starts a process. Below 50 ms is not a pace anyone means. Both ends are refused.
const TIMER_MAX = 2 ** 31 - 1;
const TIMER_MIN = 50;

/**
 * The interval a person asked for in LAYA_ACCOUNT_TICK_MS, or null to use the normal pace.
 * Only a string or a number is read: `Number()` would turn an array or an object into one. The
 * range does the rest, since NaN, Infinity and the 0 that an empty value becomes all fall outside it.
 * An empty value is easy to end up with in ~/.laya-router.env.
 */
export function fixedInterval(raw) {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const ms = Number(raw);
  return ms >= TIMER_MIN && ms <= TIMER_MAX ? ms : null;
}

/**
 * Keeps asking, at the pace `nextMs` gives for what the last answer was. Each check finishes before
 * the next is scheduled, so a slow one can never pile up behind itself, and a check that throws is
 * reported and the loop carries on. `every` fixes the interval (tests, and anyone who wants it
 * quieter or quicker). Returns a function that stops it.
 */
export function watchAccount({ read = readAccount, onReading, onError = () => {}, nextMs = nextCheckMs, every = null }) {
  let timer = null;
  let stopped = false;
  const loop = async () => {
    let state = "unknown";
    try {
      const reading = await read();
      if (stopped) return; // asked before stop() and answered after it: not wanted any more
      state = reading.state;
      onReading(reading);
    } catch (err) {
      if (stopped) return;
      onError(err);
    }
    if (stopped) return;
    timer = setTimeout(loop, every ?? nextMs(state));
    timer.unref?.();
  };
  loop();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

/** What to tell a person, and what to do next. Plain words: this is printed by setup. */
export function describeAccount({ state, method } = {}) {
  switch (state) {
    case "signed-in":
      return { line: `Claude Code is signed in${method ? ` (${method})` : ""}.`, next: null };
    case "signed-out":
      return {
        line: "Claude Code is not signed in yet.",
        next: "Run  claude auth login  (it opens your browser and uses your Claude plan), or click Sign in in the menu-bar app.",
      };
    case "missing":
      return {
        line: "Claude Code is not installed.",
        next: "Install it with  npm install -g @anthropic-ai/claude-code , then run  claude auth login .",
      };
    default:
      return { line: "Could not tell whether Claude Code is signed in.", next: "Run  claude auth status  to see." };
  }
}

if (isMain(import.meta.url)) {
  const account = await readAccount();
  if (process.argv.includes("--hint")) {
    const { line, next } = describeAccount(account);
    console.log(line);
    if (next) console.log(next);
  } else {
    console.log(account.method ? `${account.state} ${account.method}` : account.state);
  }
  process.exit(exitCodeFor(account.state));
}
