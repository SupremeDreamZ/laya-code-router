#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, accessSync, constants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startProxy } from "../src/proxy.mjs";
import { findDaemonProxy } from "../src/attach.mjs";
import { warmSidecar } from "../src/router.mjs";
import { AUTO_MODEL, routingEnabled } from "../src/config.mjs";
import { readSavedModel, restoreSavedModel, sessionSettings, routerEnv } from "../src/settings.mjs";
import { LOG_FILE } from "../src/log.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);

/**
 * Registers "Laya Router" as an extra row in Claude Code's /model picker and starts the session
 * on it. Claude Code sends the id verbatim because it does not validate model names behind a
 * custom base URL, which is what lets the proxy tell "route this" from "the user picked a
 * model". Capabilities are declared so Claude Code still composes thinking and effort for
 * the tiers that support them; the proxy strips what the routed model cannot accept.
 */
function autoModelEnv() {
  const env = {
    ANTHROPIC_CUSTOM_MODEL_OPTION: AUTO_MODEL,
    ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: "Laya Router",
    ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION: "Route each turn to the cheapest model that can do it",
    ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES:
      "thinking,adaptive_thinking,interleaved_thinking,effort,max_effort",
    // Some Claude Code versions validate the model client-side before it reaches the proxy;
    // this defers to the API so "laya-router" can pass through for rewriting.
    CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: "1",
  };
  // ANTHROPIC_MODEL applies to this session only and is never written to settings, so the
  // default costs the user nothing permanent. A model they set themselves still wins.
  if (!process.env.ANTHROPIC_MODEL) env.ANTHROPIC_MODEL = AUTO_MODEL;
  return env;
}

/**
 * Claude Code saves a picker row chosen with Enter as the default for new sessions, so the
 * value from before this session is captured now and put back on the way out.
 */
const savedModelBefore = readSavedModel();

/**
 * Claude Code's UI shows the model it asked for, never the one the proxy routed to, so a
 * status line is the only way to surface the decision. `--settings` merges rather than
 * replaces, but a status line the user configured themselves still takes priority: theirs
 * is a deliberate choice and silently overwriting it would be worse than showing nothing.
 */
function statusLineCommand() {
  if (process.env.LAYA_NO_STATUSLINE) return undefined;
  for (const dir of [join(process.cwd(), ".claude"), join(homedir(), ".claude")]) {
    try {
      if (JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")).statusLine) return undefined;
    } catch {
      // No settings file, or unreadable; nothing to preserve.
    }
  }
  return `"${process.execPath}" "${join(HERE, "laya-statusline.mjs")}"`;
}

/**
 * `--settings` args for one session. One file per proxy port, because two `laya-claude`
 * sessions share a temp directory and each has its own proxy URL to pin. Passed as a file
 * rather than inline JSON: on Windows the args go through a shell, and a JSON string
 * containing its own quotes does not survive that.
 */
function sessionSettingsArgs(port) {
  const file = join(tmpdir(), "laya-claude", `settings-${port}.json`);
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify(sessionSettings({ baseURL: `http://127.0.0.1:${port}`, statusLineCommand: statusLineCommand() })),
    );
  } catch {
    return [];
  }
  return ["--settings", file];
}

// Existing environment variables win, followed by project-local, shared user-level, then
// the legacy Claude-specific file.
for (const file of [
  join(process.cwd(), ".env"),
  join(homedir(), ".laya-router.env"),
  join(homedir(), ".laya-claude.env"),
]) {
  try {
    process.loadEnvFile(file);
  } catch {
    // Missing or unreadable; the key may still come from the real environment.
  }
}

/**
 * Finds the Claude Code executable on PATH. Resolving it here rather than leaning on the
 * shell means arguments are passed as an array (no quoting hazard, no DEP0190 warning) and
 * a missing install produces a useful message instead of a shell error. Older npm-based
 * installs are a `.cmd` shim, which Node still refuses to run without a shell.
 */
function resolveClaude() {
  const win = process.platform === "win32";
  const exts = win ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";") : [""];
  for (const dir of (process.env.PATH ?? "").split(win ? ";" : ":")) {
    if (!dir) continue;
    for (const ext of exts) {
      const file = join(dir.replace(/^"|"$/g, ""), `claude${ext}`);
      try {
        accessSync(file, constants.X_OK);
        return { file, shell: /\.(cmd|bat)$/i.test(file) };
      } catch {
        // Not here; keep looking.
      }
    }
  }
  return null;
}

const args = process.argv.slice(2);
args.push("--add-dir", ROOT);
const env = { ...process.env };

const claude = resolveClaude();
if (!claude) {
  process.stderr.write(
    "[laya] Claude Code is not installed, or `claude` is not on your PATH.\n" +
      "[laya] laya-claude runs the real Claude Code CLI; install it first:\n" +
      "[laya]   https://code.claude.com/docs/en/setup\n",
  );
  process.exit(1);
}

if (routingEnabled()) {
  // With the menu-bar app running, join its proxy: the app then sees this session's turns, the
  // usage and limit figures include them, and the warm model is shared instead of loaded again
  // here. With no app (or LAYA_NO_DAEMON=1) this is null and the session runs its own proxy and
  // model exactly as it always did.
  const shared = await findDaemonProxy();
  const proxy = shared ?? (await startProxy());
  const { port } = proxy;
  // A joined proxy belongs to the app, not to this session: leaving must not shut it down.
  const close = shared ? () => {} : proxy.close;
  // Pre-warm the LAYA sidecar so the ~40s model load happens while Claude Code starts,
  // not while the first turn waits on its routing decision. A joined proxy's model is already
  // warm (or warming) in the daemon, and a second load here would only compete with it.
  if (!shared) warmSidecar();
  env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
  env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = "1";
  Object.assign(env, routerEnv(process.env));
  Object.assign(env, autoModelEnv());
  process.on("exit", () => {
    close();
    restoreSavedModel(savedModelBefore);
  });
  args.push(...sessionSettingsArgs(port));
  if (process.env.LAYA_DEBUG && process.stdout.isTTY) {
    process.stderr.write(`[laya] routing decisions -> ${LOG_FILE}\n`);
  }
} else {
  process.stderr.write(
    `[laya] routing disabled (LAYA_DISABLE_ROUTING=1) - starting Claude Code without routing\n`,
  );
}

// On Windows a `.cmd` shim still needs a shell; a real executable does not.
const child = spawn(claude.file, claude.shell ? args.map((a) => (/\s/.test(a) ? `"${a}"` : a)) : args, {
  stdio: "inherit",
  shell: claude.shell,
  env,
});

child.on("error", (err) => {
  process.stderr.write(`[laya] could not start Claude Code: ${err.message}\n`);
  process.exit(1);
});
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
