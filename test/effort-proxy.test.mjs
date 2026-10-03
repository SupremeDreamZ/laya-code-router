import test from "node:test";
import assert from "node:assert/strict";
import { HEADLESS_HEADER } from "../src/proxy.mjs";
import { defaultPrefs, mergePrefs } from "../src/prefs.mjs";
import { headlessEnv } from "../src/settings.mjs";
import { harness, user, score } from "./effort-harness.mjs";

// Effort end to end through the real proxy. Effort follows Anthropic's effort guide (config.mjs,
// EFFORT): Opus starts at its documented default, medium, and a sub-agent is low unless its own
// task scores hard.

test("a typical hard turn on opus runs at medium, the documented default, not high", async (t) => {
  const h = await harness(t, { route: () => score(0.58, 0.7) });
  const out = await h.send([user("Refactor the config loader to share one parser.")]);
  assert.equal(out.body.model, "claude-opus-5-5");
  assert.equal(out.body.output_config.effort, "medium");
});

test("hard reasoning on opus runs at high, and the event says why", async (t) => {
  const h = await harness(t, { route: () => score(0.64, 0.3) });
  const out = await h.send([user("Work out why the scheduler double-runs jobs.")]);
  assert.equal(out.body.output_config.effort, "high");
  assert.equal(h.events[0].effort, "high");
  assert.equal(h.events[0].effortReason, "opus-hard-reasoning");
  assert.equal(h.events[0].class, "main");
});

test("a sub-agent is scored on its own task and runs at low unless that task is hard", async (t) => {
  const h = await harness(t, { route: ({ prompt }) => (/audit/i.test(prompt) ? score(0.64, 0.5) : score(0.52, 0.3)) });
  const easy = await h.send([user("List the files under src.")], { cls: "subagent", session: "sub-easy" });
  assert.equal(easy.body.model, "claude-opus-5-5");
  assert.equal(easy.body.output_config.effort, "low");
  const hard = await h.send([user("Audit the whole retry design for races.")], { cls: "subagent", session: "sub-hard" });
  assert.equal(hard.body.output_config.effort, "high");
  assert.deepEqual(h.events.map((e) => [e.class, e.effort, e.effortReason]), [
    ["subagent", "low", "subagent-default"],
    ["subagent", "high", "subagent-hard"],
  ]);
});

test("xhigh: a headless run, a long brief and high judgment; the marker header never goes upstream", async (t) => {
  const h = await harness(t, { route: () => score(0.64, 0.9) });
  const brief = `Migrate every service to the new queue and prove it. ${"Details of the work. ".repeat(150)}`;
  const out = await h.send([user(brief)], { headers: { [HEADLESS_HEADER]: "1" } });
  assert.equal(out.body.output_config.effort, "xhigh");
  assert.equal(out.headers[HEADLESS_HEADER], undefined);
  assert.equal(h.events[0].effortReason, "opus-long-horizon");
});

test("the same long brief in a session someone is watching is high, not xhigh", async (t) => {
  const h = await harness(t, { route: () => score(0.64, 0.9) });
  const brief = `Migrate every service to the new queue and prove it. ${"Details of the work. ".repeat(150)}`;
  const out = await h.send([user(brief)]);
  assert.equal(out.body.output_config.effort, "high");
});

test("a level the user chose is left alone and the event says so", async (t) => {
  const h = await harness(t, { route: () => score(0.64, 0.9) });
  const out = await h.send([user("Design the billing system.")], { extra: { output_config: { effort: "max" } } });
  assert.equal(out.body.output_config.effort, "max");
  assert.equal(h.events[0].effortReason, "user-chosen");
});

test("with effort off in the app nothing is touched", async (t) => {
  const h = await harness(t, { route: () => score(0.64, 0.9), prefs: mergePrefs(defaultPrefs(), { effortAuto: false }) });
  const out = await h.send([user("Design the billing system.")]);
  assert.equal(out.body.output_config.effort, "medium");
  assert.equal(h.events[0].effortReason, "effort-auto-off");
});

test("the launcher marks a headless run: -p and --print add the header, and the user's own headers are kept", () => {
  assert.deepEqual(headlessEnv(["-p", "hi"], {}), { ANTHROPIC_CUSTOM_HEADERS: "x-laya-headless: 1" });
  assert.deepEqual(headlessEnv(["--print"], { ANTHROPIC_CUSTOM_HEADERS: "x-team: blue" }), {
    ANTHROPIC_CUSTOM_HEADERS: "x-team: blue\nx-laya-headless: 1",
  });
  assert.deepEqual(headlessEnv(["--add-dir", "/x"], {}), {});
  assert.deepEqual(headlessEnv(undefined, {}), {});
});
