import test from "node:test";
import assert from "node:assert/strict";
import { newTurnPrompt, conversationKey, isToolContinuation } from "../src/proxy.mjs";
import { takesMessageEffort, withEffortMessages, mergeBeta, isEffortMessage, adaptForModel, EFFORT_BETA } from "../src/wire.mjs";
import { defaultPrefs, mergePrefs } from "../src/prefs.mjs";
import { harness, user, score, effortInEffect } from "./effort-harness.mjs";

// Per-step effort. Anthropic's effort guide (platform.claude.com/docs/en/build-with-claude/effort,
// "Change effort mid-conversation"): on Fable 5.1, Mythos 5.1, Opus 5.5, Opus 5 and Sonnet 5.5, a
// `role: "system"` message with empty `content` and `output_config: {effort}` changes the level from
// the next user turn on, keeps the prompt cache, and needs the beta header
// `mid-conversation-output-config-2026-07-01`. A top-level change restarts the cache, so the
// top-level value stays what the conversation started with and the level moves per message. The
// message is placed once and replayed at the same spot on every later request (Claude Code does not
// know about it), which is what keeps the cached prefix identical.
const OPEN = "Audit the config loader and fix what is wrong with it.";
const SIG = "EosnCkYICxIMMb3LzNrMu";
const isStep = (p) => p.startsWith("Next step of an ongoing task:");
const BETAS = "claude-code-20250219,interleaved-thinking-2025-05-14";

/** The conversation after `n` tool calls, the way Claude Code sends it (thinking blocks included). */
function loopOf(n, opening = OPEN) {
  const messages = [user(opening)];
  for (let i = 1; i <= n; i++) {
    messages.push({
      role: "assistant",
      content: [
        { type: "thinking", thinking: `SECRET-THOUGHT-${i}`, signature: SIG },
        { type: "text", text: `Checking part ${i}.` },
        { type: "tool_use", id: `t${i}`, name: "Bash", input: { command: `cat part${i}.js` } },
      ],
    });
    messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `t${i}`, content: `OUT-${i}` }] });
  }
  return messages;
}
const effortMessages = (body) => body.messages.filter(isEffortMessage);
const strip = (body) => body.messages.filter((m) => !isEffortMessage(m));

/** The opening turn and `n` continuations; returns what upstream saw for each. */
async function run(h, n, opts) {
  const out = [await h.send([user(OPEN)], opts)];
  for (let i = 1; i <= n; i++) out.push(await h.send(loopOf(i), opts));
  return out;
}

// ---- wire helpers ----

test("per-message effort is for the models the guide names, and no others", () => {
  for (const m of ["claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5", "claude-fable-5-1", "claude-mythos-5-1", "claude-opus-5-5-20261001"]) {
    assert.equal(takesMessageEffort(m), true, m);
  }
  for (const m of ["claude-sonnet-5", "claude-fable-5", "claude-haiku-4-5-20251001", "claude-opus-4-8", "claude-opus-5-1", "laya-router", undefined]) {
    assert.equal(takesMessageEffort(m), false, String(m));
  }
});

test("an effort message is empty, system-role, and carries only the level", () => {
  const body = { messages: [user("a"), { role: "assistant", content: [{ type: "text", text: "b" }] }, user("c")] };
  assert.equal(withEffortMessages(body, [{ at: 2, effort: "low" }]), 1);
  assert.deepEqual(body.messages[2], { role: "system", content: [], output_config: { effort: "low" } });
  assert.equal(isEffortMessage(body.messages[2]), true);
  assert.equal(isEffortMessage({ role: "system", content: [{ type: "text", text: "x" }] }), false, "a real system message is not one");
  assert.equal(isEffortMessage(user("x")), false);
});

test("effort messages go before the message they were first placed at, even as the conversation grows", () => {
  const body = { messages: loopOf(5) };
  withEffortMessages(body, [{ at: 4, effort: "high" }, { at: 8, effort: "low" }]);
  const at = body.messages.map((m, i) => (isEffortMessage(m) ? [i, m.output_config.effort] : null)).filter(Boolean);
  assert.deepEqual(at, [[4, "high"], [9, "low"]]);
  assert.equal(body.messages[5].content[0].type, "tool_result", "the message it was placed before follows it");
});

test("a model that takes effort per message but not text system messages keeps effort messages when the rest are folded", () => {
  const text = { role: "system", content: [{ type: "text", text: "note" }] };
  const body = () => ({ messages: [user("a"), text, eff("low"), user("b")] });
  const opus5 = body();
  assert.equal(adaptForModel(opus5, "claude-opus-5").folded, 1);
  assert.deepEqual(opus5.messages.map((m) => (isEffortMessage(m) ? "effort" : m.role)), ["user", "effort", "user"]);
  const haiku = body();
  adaptForModel(haiku, "claude-haiku-4-5-20251001");
  assert.equal(haiku.messages.some(isEffortMessage), false, "a model that takes none loses them, as before");
});

test("a mark past the end of the conversation is dropped, never invented", () => {
  const body = { messages: [user("a")] };
  assert.equal(withEffortMessages(body, [{ at: 7, effort: "low" }]), 0);
  assert.equal(body.messages.length, 1);
});

test("the beta header is merged: nothing already there is lost, and it is not added twice", () => {
  assert.equal(mergeBeta("a,b", EFFORT_BETA), `a,b,${EFFORT_BETA}`);
  assert.equal(mergeBeta(`a, ${EFFORT_BETA} ,b`, EFFORT_BETA), `a, ${EFFORT_BETA} ,b`);
  assert.equal(mergeBeta(undefined, EFFORT_BETA), EFFORT_BETA);
  assert.equal(mergeBeta("", EFFORT_BETA), EFFORT_BETA);
});

// ---- not mistaken for a user turn ----

const TOOLS = [{ name: "Bash" }];
const eff = (effort) => ({ role: "system", content: [], output_config: { effort } });
const asst = (text) => ({ role: "assistant", content: [{ type: "text", text }] });

test("an effort message between turns is not a user turn, and does not hide the real one", () => {
  const body = { tools: TOOLS, messages: [user("first"), asst("ok"), eff("low"), user("second")] };
  assert.equal(newTurnPrompt(body), "second");
  assert.equal(newTurnPrompt({ tools: TOOLS, messages: [user("first"), eff("low")] }), "first");
  assert.equal(newTurnPrompt({ tools: TOOLS, messages: [user("first"), asst("ok"), eff("low")] }), null, "nothing the user typed last");
});

test("an effort message in front of a tool result leaves it a continuation, not a new turn", () => {
  const body = { tools: TOOLS, messages: [...loopOf(2).slice(0, 3), eff("high"), ...loopOf(2).slice(3)] };
  assert.equal(isToolContinuation(body), true);
  assert.equal(newTurnPrompt(body), null);
});

test("a conversation keeps its identity if an effort message ever leads the history", () => {
  const plain = { messages: [user("hello")] };
  const led = { messages: [eff("low"), user("hello")] };
  assert.equal(conversationKey(led), conversationKey(plain));
});

test("through the proxy: a new typed turn after an effort change is still routed as a turn", async (t) => {
  const h = await harness(t, { route: ({ prompt }) => (isStep(prompt) ? score(0.64, 0.3) : score(0.58, 0.3)) });
  await run(h, 4);
  const asked = h.asked.length;
  const next = [...loopOf(4), { role: "assistant", content: [{ type: "text", text: "Done." }] }, user("Now rename the loader.")];
  await h.send(next);
  assert.equal(h.asked.length, asked + 1, "the new message was scored");
  assert.equal(h.asked.at(-1), "Now rename the loader.");
});

// ---- the behaviour ----

test("the first request fixes the top-level level; no effort message, no beta header", async (t) => {
  const h = await harness(t, { route: () => score(0.58, 0.3) });
  const out = await h.send([user(OPEN)]);
  assert.equal(out.body.output_config.effort, "medium");
  assert.equal(effortMessages(out.body).length, 0);
  assert.equal(out.headers["anthropic-beta"], BETAS);
});

test("a due step that scores harder raises the level with a message, and the top-level value never moves", async (t) => {
  const h = await harness(t, { route: ({ prompt }) => (isStep(prompt) ? score(0.64, 0.3) : score(0.58, 0.3)) });
  const reqs = await run(h, 5);
  for (const i of [0, 1, 2, 3]) assert.equal(effortMessages(reqs[i].body).length, 0, `request ${i} is before the check`);
  const at4 = reqs[4].body;
  assert.equal(at4.output_config.effort, "medium", "top-level stays what the conversation started with");
  const msgs = effortMessages(at4);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].output_config.effort, "high");
  const last = at4.messages.length - 1;
  assert.equal(at4.messages[last - 1], msgs[0], "placed just before the last (tool-result) message");
  assert.equal(at4.messages[last].content[0].type, "tool_result");
  assert.equal(reqs[4].headers["anthropic-beta"], `${BETAS},${EFFORT_BETA}`, "every beta Claude Code sent is kept");
  assert.deepEqual(effortInEffect(at4), { top: "medium", inEffect: "high" });
  // The next request is not a check, and the message is replayed where it was.
  assert.equal(reqs[5].body.output_config.effort, "medium");
  assert.deepEqual(effortInEffect(reqs[5].body), { top: "medium", inEffect: "high" });
  assert.equal(reqs[5].headers["anthropic-beta"], `${BETAS},${EFFORT_BETA}`);
});

test("the cached prefix is identical from one request to the next, effort messages included", async (t) => {
  const h = await harness(t, { route: ({ prompt }) => (isStep(prompt) ? score(0.64, 0.3) : score(0.58, 0.3)) });
  const reqs = await run(h, 9);
  for (let i = 1; i < reqs.length; i++) {
    const before = reqs[i - 1].body.messages;
    assert.deepEqual(reqs[i].body.messages.slice(0, before.length), before, `request ${i} extends request ${i - 1}`);
  }
});

test("effort moves down as well as up inside a tool loop", async (t) => {
  const steps = [score(0.64, 0.3), score(0.52, 0.3)];
  const h = await harness(t, { route: ({ prompt }) => (isStep(prompt) ? steps.shift() : score(0.58, 0.3)) });
  const reqs = await run(h, 8);
  assert.deepEqual(effortInEffect(reqs[4].body), { top: "medium", inEffect: "high" });
  assert.deepEqual(effortInEffect(reqs[7].body), { top: "medium", inEffect: "high" });
  assert.deepEqual(effortInEffect(reqs[8].body), { top: "medium", inEffect: "medium" }, "the second check lowers it again");
  assert.deepEqual(effortMessages(reqs[8].body).map((m) => m.output_config.effort), ["high", "medium"]);
  assert.deepEqual(h.events.filter((e) => e.class === "step").map((e) => [e.effort, e.effortReason]), [
    ["high", "step-opus-hard-reasoning"],
    ["medium", "step-opus-default"],
  ]);
});

test("a later turn moves the level either way with no ratchet, and the top-level value still holds", async (t) => {
  const turns = [score(0.64, 0.3), score(0.58, 0.3), score(0.64, 0.3)];
  const h = await harness(t, { route: () => turns.shift() });
  const a = await h.send([user("Work out why the scheduler double-runs jobs.")]);
  const b = await h.send([user("Work out why the scheduler double-runs jobs."), asst("ok"), user("Now rename the loader.")]);
  const c = await h.send([user("Work out why the scheduler double-runs jobs."), asst("ok"), user("Now rename the loader."), asst("ok"), user("Now find the race.")]);
  assert.deepEqual(effortInEffect(a.body), { top: "high", inEffect: "high" });
  assert.deepEqual(effortInEffect(b.body), { top: "high", inEffect: "medium" });
  assert.deepEqual(effortInEffect(c.body), { top: "high", inEffect: "high" });
  assert.deepEqual(h.events.map((e) => e.effort), ["high", "medium", "high"]);
});

test("a step cannot drop more than one level below the level the turn opened at", async (t) => {
  const h = await harness(t, { route: ({ prompt }) => (isStep(prompt) ? score(0.49, 0.1) : score(0.49, 0.8)) });
  const reqs = await run(h, 4);
  assert.equal(reqs[0].body.model, "claude-sonnet-5-5");
  assert.deepEqual(effortInEffect(reqs[0].body), { top: "high", inEffect: "high" });
  assert.deepEqual(effortInEffect(reqs[4].body), { top: "high", inEffect: "medium" }, "low was wanted, one level down is allowed");
  const step = h.events.find((e) => e.class === "step");
  assert.equal(step.effortReason, "step-sonnet-mechanical/floor");
});

test("LAYA is asked about effort at the same pace as a step check: every fourth continuation", async (t) => {
  const h = await harness(t, { route: () => score(0.58, 0.3) });
  await run(h, 8);
  assert.equal(h.asked.filter(isStep).length, 2);
  assert.equal(h.events.filter((e) => e.class === "step").length, 2);
});

test("a sub-agent's loop is re-scored as a sub-agent: low by default, up only when the step is hard", async (t) => {
  const h = await harness(t, { route: ({ prompt }) => (isStep(prompt) ? score(0.64, 0.3) : score(0.52, 0.3)) });
  const reqs = await run(h, 4, { cls: "subagent" });
  assert.deepEqual(effortInEffect(reqs[0].body), { top: "low", inEffect: "low" });
  assert.deepEqual(effortInEffect(reqs[4].body), { top: "low", inEffect: "high" });
});

test("a level the user chose is never touched, and no LAYA call is spent on it", async (t) => {
  const h = await harness(t, { route: () => score(0.64, 0.3) });
  const reqs = await run(h, 4, { extra: { output_config: { effort: "high" } } });
  assert.equal(h.asked.filter(isStep).length, 0);
  for (const r of reqs) {
    assert.equal(r.body.output_config.effort, "high");
    assert.equal(effortMessages(r.body).length, 0);
    assert.equal(r.headers["anthropic-beta"], BETAS);
  }
});

test("with effort off in the app nothing is touched and nothing is asked", async (t) => {
  const h = await harness(t, { route: () => score(0.64, 0.3), prefs: mergePrefs(defaultPrefs(), { effortAuto: false }) });
  const reqs = await run(h, 4);
  assert.equal(h.asked.filter(isStep).length, 0);
  for (const r of reqs) assert.equal(effortMessages(r.body).length, 0);
});

test("per-step effort can be switched off: the turn's level holds, nothing is asked", async (t) => {
  for (const setting of [{ env: { LAYA_EFFORT_STEPS: "0" } }, { prefs: mergePrefs(defaultPrefs(), { effortSteps: false }) }]) {
    const h = await harness(t, { route: ({ prompt }) => (isStep(prompt) ? score(0.64, 0.3) : score(0.58, 0.3)), ...setting });
    const reqs = await run(h, 4);
    assert.equal(h.asked.filter(isStep).length, 0);
    assert.deepEqual(effortInEffect(reqs[4].body), { top: "medium", inEffect: "medium" });
  }
});

test("a client that manages effort messages itself is left alone", async (t) => {
  const h = await harness(t, { route: () => score(0.64, 0.3) });
  const mine = [user(OPEN), asst("ok"), eff("low"), user("next")];
  const out = await h.send(mine);
  assert.deepEqual(out.body.messages, mine);
  assert.equal(h.events[0].effortReason, "client-managed");
});

test("fail-open: no answer at a step keeps the level, and a router that throws costs nothing", async (t) => {
  for (const bad of [() => null, () => { throw new Error("boom"); }]) {
    const h = await harness(t, { route: ({ prompt }) => (isStep(prompt) ? bad() : score(0.58, 0.3)) });
    const reqs = await run(h, 4);
    assert.equal(effortMessages(reqs[4].body).length, 0);
    assert.deepEqual(effortInEffect(reqs[4].body), { top: "medium", inEffect: "medium" });
    assert.equal(h.events.filter((e) => e.status >= 400).length, 0);
  }
});

test("a model without per-message effort keeps today's behaviour: top-level, and it only goes up", async (t) => {
  const old = { id: "claude-opus-4-8", display_name: "Opus 4.8", created_at: "2026-01-01T00:00:00Z" };
  const levels = [score(0.58, 0.3), score(0.64, 0.3), score(0.58, 0.3)];
  const h = await harness(t, { route: () => ({ ...levels.shift(), choice: "claude-opus-4-8" }), models: [old] });
  await h.models();
  const a = await h.send([user("Work out why jobs run twice.")]);
  const b = await h.send([user("Work out why jobs run twice."), asst("ok"), user("Now find the race in it.")]);
  const c = await h.send([user("Work out why jobs run twice."), asst("ok"), user("Now find the race in it."), asst("ok"), user("Rename x.")]);
  assert.equal(a.body.model, "claude-opus-4-8");
  assert.deepEqual([a, b, c].map((r) => r.body.output_config.effort), ["medium", "high", "high"], "ratcheted");
  for (const r of [a, b, c]) {
    assert.equal(effortMessages(r.body).length, 0);
    assert.equal(r.headers["anthropic-beta"], BETAS);
  }
});

test("Sonnet 5.5 with between_tools thinking is not given a per-message level, which would be a 400", async (t) => {
  const h = await harness(t, { route: ({ prompt }) => (isStep(prompt) ? score(0.49, 0.8) : score(0.49, 0.4)) });
  const reqs = await run(h, 4, { extra: { thinking: { type: "between_tools" } } });
  assert.equal(reqs[0].body.model, "claude-sonnet-5-5");
  for (const r of reqs) assert.equal(effortMessages(r.body).length, 0);
});

test("a 400 on a request that carried an effort message turns per-step effort off for the rest of the run", async (t) => {
  let reject = true;
  const h = await harness(t, {
    route: ({ prompt }) => (isStep(prompt) ? score(0.64, 0.3) : score(0.58, 0.3)),
    status: (body) => (reject && body.messages.some(isEffortMessage) ? 400 : 200),
  });
  const reqs = await run(h, 5);
  assert.equal(effortMessages(reqs[4].body).length, 1);
  assert.equal(h.events.find((e) => e.status === 400)?.class, "step");
  assert.equal(effortMessages(reqs[5].body).length, 0, "the next request goes out as before");
  reject = false;
  const more = await h.send(loopOf(8));
  assert.equal(effortMessages(more.body).length, 0, "and it stays off");
});

test("with step routing also on, one LAYA answer serves both: a switch and its effort", async (t) => {
  const steps = [score(0.37, 0.1)];
  const h = await harness(t, {
    route: ({ prompt }) => (isStep(prompt) ? steps.shift() : score(0.64, 0.3)),
    prefs: mergePrefs(defaultPrefs(), { stepRouting: true }),
  });
  const reqs = await run(h, 4);
  assert.equal(h.asked.filter(isStep).length, 1, "asked once");
  for (const r of reqs.filter((r) => r.body.model.startsWith("claude-haiku"))) {
    assert.equal(r.body.output_config, undefined, "Haiku takes no effort");
    assert.equal(effortMessages(r.body).length, 0, "and no effort message is sent to a model that would reject it");
  }
  const step = h.events.find((e) => e.class === "step");
  assert.ok(step && step.step.switched !== undefined, "the check is one event");
});

test("a turn the user pinned with 'use opus' keeps its model but still has its effort re-decided", async (t) => {
  const h = await harness(t, { route: ({ prompt }) => (isStep(prompt) ? score(0.37, 0.1) : score(0.58, 0.3)), prefs: mergePrefs(defaultPrefs(), { stepRouting: true }) });
  const opening = "use opus: " + OPEN;
  await h.send([user(opening)]);
  let last;
  for (let i = 1; i <= 4; i++) last = await h.send(loopOf(i, opening));
  assert.equal(last.body.model, "claude-opus-5-5", "the model the user named");
  assert.equal(h.asked.filter(isStep).length, 1, "asked about effort");
  assert.equal(effortInEffect(last.body).inEffect, "medium");
});

test("per-step effort is a setting, on by default, and only a boolean is accepted", () => {
  assert.equal(defaultPrefs().effortSteps, true);
  assert.equal(mergePrefs(defaultPrefs(), { effortSteps: false }).effortSteps, false);
  assert.equal(mergePrefs(defaultPrefs(), { effortSteps: "no" }).effortSteps, true);
});
