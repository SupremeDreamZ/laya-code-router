import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AUTO_MODEL } from "./config.mjs";

export const USER_SETTINGS = join(homedir(), ".claude", "settings.json");

/**
 * Environment the launcher gives Claude Code so it works well behind the router. Each value
 * is only a default: anything the user already set wins, so they are only returned when unset.
 *  - CLAUDE_CODE_GATEWAY_HINT_HEADERS=1: Claude Code labels every request (main, subagent,
 *    compaction, auxiliary, workflow), so only the user's own messages are ever routed.
 *  - ENABLE_TOOL_SEARCH=true: Claude Code turns tool search off for any base URL that is not
 *    Anthropic's. Measured with claude 2.1.285 against a stub: 57 tools / 137 KB per request
 *    without it, 14 tools / 73 KB with it.
 * No credential and no model is ever set here.
 */
export function routerEnv(existing = process.env) {
  const defaults = { CLAUDE_CODE_GATEWAY_HINT_HEADERS: "1", ENABLE_TOOL_SEARCH: "true" };
  return Object.fromEntries(Object.entries(defaults).filter(([key]) => existing[key] === undefined));
}

/**
 * LAYA_STEP_ROUTING=1 as a request header (x-laya-step-routing, read and stripped by the proxy).
 * A session that joins the app's shared proxy does not share its environment, so the switch has to
 * travel with the requests. Claude Code sends ANTHROPIC_CUSTOM_HEADERS on every API request; any
 * the user already set are kept. Only this session is affected, never the app's setting.
 */
export function stepRoutingEnv(existing = process.env) {
  if (existing.LAYA_STEP_ROUTING !== "1") return {};
  const header = "x-laya-step-routing: 1";
  const own = existing.ANTHROPIC_CUSTOM_HEADERS;
  return { ANTHROPIC_CUSTOM_HEADERS: own ? `${own}\n${header}` : header };
}

/**
 * Settings the launcher passes with `--settings`. That flag layers over the user's own
 * settings.json, while the process environment does NOT: a user-level `env` block beats it.
 * Measured with claude 2.1.285 and ANTHROPIC_BASE_URL in ~/.claude/settings.json (the gateway
 * setup this router is used with): with the URL only in the process env, Claude Code ignored
 * the proxy and went straight to the gateway; with the same URL in a --settings env, every
 * request reached the proxy. Only the proxy URL is pinned here. The file lives in a shared
 * temp directory, so it never carries a credential, and auth stays wherever the user keeps it.
 */
export function sessionSettings({ baseURL, statusLineCommand } = {}) {
  // `effortLevel` sits below an explicit --effort / /effort / CLAUDE_CODE_EFFORT_LEVEL in Claude
  // Code's precedence, so it is a default the user can still override. Anthropic's documented
  // default for Opus 5.5 and Sonnet 5.5 is medium; with the sentinel model Claude Code would
  // otherwise send high (measured), and every routed request would spend more than a plain session.
  const settings = { env: { ANTHROPIC_BASE_URL: baseURL }, effortLevel: "medium" };
  if (statusLineCommand) settings.statusLine = { type: "command", command: statusLineCommand };
  return settings;
}

/**
 * The model saved as the user's default, ignoring a sentinel left behind by a session that
 * did not exit cleanly, which is not a preference worth restoring.
 */
export function readSavedModel(file = USER_SETTINGS) {
  try {
    const model = JSON.parse(readFileSync(file, "utf8")).model;
    return model === AUTO_MODEL ? undefined : model;
  } catch {
    return undefined;
  }
}

/**
 * Puts `previous` back if the settings file now holds the sentinel. Selecting a row with
 * Enter makes Claude Code save it as the default for new sessions, and a saved "laya-router"
 * would break plain `claude`, which has no proxy to resolve it. Anything other than an exact
 * sentinel match is left alone, so a real model chosen during the session survives.
 */
export function restoreSavedModel(previous, file = USER_SETTINGS) {
  try {
    const settings = JSON.parse(readFileSync(file, "utf8"));
    if (settings.model !== AUTO_MODEL) return false;
    if (previous === undefined) delete settings.model;
    else settings.model = previous;
    writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}
