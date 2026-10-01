import test from "node:test";
import assert from "node:assert/strict";
import { routerEnv } from "../src/settings.mjs";

// dirien/jev-router sets these for Claude Code behind a gateway; each one is measured there.
test("the launcher asks Claude Code to label every request, so only the user's messages are routed", () => {
  assert.equal(routerEnv({}).CLAUDE_CODE_GATEWAY_HINT_HEADERS, "1");
});

// Measured with claude 2.1.285 against a stub base URL: with tool search at its default the
// request carried 57 tools (30 of them MCP) and 137 KB; with ENABLE_TOOL_SEARCH=true, 14 tools
// and 73 KB. Claude Code turns tool search off for any base URL that is not Anthropic's.
test("the launcher turns tool search back on, which Claude Code disables behind any non-Anthropic base URL", () => {
  assert.equal(routerEnv({}).ENABLE_TOOL_SEARCH, "true");
});

test("a value the user already set wins over the launcher's default", () => {
  const out = routerEnv({ ENABLE_TOOL_SEARCH: "false", CLAUDE_CODE_GATEWAY_HINT_HEADERS: "0" });
  assert.equal(out.ENABLE_TOOL_SEARCH, undefined);
  assert.equal(out.CLAUDE_CODE_GATEWAY_HINT_HEADERS, undefined);
});

// The default effort is NOT set through CLAUDE_CODE_EFFORT_LEVEL. Measured with claude 2.1.285:
// that variable is first in Claude Code's precedence, so it overrides the user's own
// `--effort low` and `--effort high` (both were sent as `medium`). It is set as `effortLevel` in
// the --settings file instead (see settings.test.mjs), where an explicit --effort still wins.
test("the launcher does not use CLAUDE_CODE_EFFORT_LEVEL, which would override the user's --effort", () => {
  assert.equal("CLAUDE_CODE_EFFORT_LEVEL" in routerEnv({}), false);
});

test("the launcher never sets a credential or a model", () => {
  const out = routerEnv({});
  for (const key of ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_MODEL"]) {
    assert.equal(key in out, false, `${key} must not be set here`);
  }
});
