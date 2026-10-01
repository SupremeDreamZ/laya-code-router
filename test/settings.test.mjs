import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSavedModel, restoreSavedModel, sessionSettings } from "../src/settings.mjs";

const fileWith = (settings) => {
  const file = join(mkdtempSync(join(tmpdir(), "laya-settings-")), "settings.json");
  writeFileSync(file, JSON.stringify(settings, null, 2));
  return file;
};
const modelIn = (file) => JSON.parse(readFileSync(file, "utf8")).model;

test("reads the saved model, ignoring a leftover sentinel", () => {
  assert.equal(readSavedModel(fileWith({ model: "opus" })), "opus");
  assert.equal(readSavedModel(fileWith({ model: "laya-router" })), undefined);
  assert.equal(readSavedModel(fileWith({})), undefined);
  assert.equal(readSavedModel(join(tmpdir(), "does-not-exist.json")), undefined);
});

test("restores the previous model when the sentinel was saved", () => {
  const file = fileWith({ model: "laya-router", permissions: { deny: ["Bash(rm*)"] } });
  assert.equal(restoreSavedModel("opus", file), true);
  assert.equal(modelIn(file), "opus");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).permissions, { deny: ["Bash(rm*)"] });
});

test("removes the sentinel when there was no previous model", () => {
  const file = fileWith({ model: "laya-router" });
  assert.equal(restoreSavedModel(undefined, file), true);
  assert.equal(modelIn(file), undefined);
});

test("leaves a real model the user chose during the session alone", () => {
  const file = fileWith({ model: "claude-opus-4-6" });
  assert.equal(restoreSavedModel("sonnet", file), false);
  assert.equal(modelIn(file), "claude-opus-4-6");
});

test("a missing or unreadable settings file is not an error", () => {
  assert.equal(restoreSavedModel("opus", join(tmpdir(), "nope", "settings.json")), false);
});

// Measured with the real claude 2.1.285 binary: a user-level settings.json `env` block beats
// the process environment, so a launcher that only sets ANTHROPIC_BASE_URL in the process
// env is silently bypassed for anyone routing Claude Code through a gateway. Passing the
// same keys through --settings wins, and the proxy is reached.
test("session settings pin the proxy URL in env so a user-level base URL cannot bypass it", () => {
  const settings = sessionSettings({ baseURL: "http://127.0.0.1:5555" });
  assert.equal(settings.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:5555");
});

test("session settings do not overwrite the user's own auth or model configuration", () => {
  const { env } = sessionSettings({ baseURL: "http://127.0.0.1:5555" });
  // The token has to keep coming from the user's own settings; this file is written to a
  // shared temp directory and must never hold a credential.
  for (const key of ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_MODEL"]) {
    assert.equal(key in env, false, `${key} must not be set by the launcher`);
  }
});

test("session settings carry the status line only when asked to", () => {
  const command = "node /x/laya-statusline.mjs";
  assert.deepEqual(sessionSettings({ baseURL: "http://127.0.0.1:1", statusLineCommand: command }).statusLine, {
    type: "command",
    command,
  });
  assert.equal("statusLine" in sessionSettings({ baseURL: "http://127.0.0.1:1" }), false);
});

// Anthropic (code.claude.com/docs/en/model-config): effort defaults to `high` on every model that
// supports it EXCEPT Opus 5.5 and Sonnet 5.5, which default to `medium`; "in tests Opus 5.5 at
// medium matches or exceeds Opus 5 at high". Measured with claude 2.1.285: launched with the
// router's sentinel model, Claude Code sends `high` (it does not know the model), so every routed
// request would think harder and spend more than a plain `claude` session.
test("session settings restore the documented default effort, which the sentinel model loses", () => {
  assert.equal(sessionSettings({ baseURL: "http://127.0.0.1:1" }).effortLevel, "medium");
});
