import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startProxy, stepPrompt, stepSize } from "../src/proxy.mjs";
import { stepHazard } from "../src/wire.mjs";
import { savePrefs, defaultPrefs, mergePrefs } from "../src/prefs.mjs";

// Step routing: "decide which model to use in between each thought". When it is on, the proxy may
// re-ask LAYA at a tool-loop continuation, about what the assistant is doing next. It is off by
// default, it asks at most every `stepEvery` continuations and never twice in a row, and every
// check (switch or stay) is reported so the owner can measure it.
const TOOLS = [{ name: "Bash", description: "x", input_schema: { type: "object", properties: {} } }];
const SESSION = "bbbbbbbb-1111-4222-8333-444444444444";
const metadata = { user_id: JSON.stringify({ session_id: SESSION }) };
const OPENING = "Audit the config loader and fix what is wrong with it.";
const user = (t) => ({ role: "user", content: [{ type: "text", text: t }] });
const at = (score, confidence = 0.5) => ({
  metrics: { taskComplexity: score, reasoningRequired: score, toolComplexity: score, judgment: 0.1 },
  confidence, ms: 2, request: {}, response: {},
});
const SIG = "EosnCkYICxIMMb3LzNrMu";

/** The conversation after `n` tool calls, the way Claude Code sends it with Opus thinking on. */
function loopOf(n, { thinking = true, opening = OPENING } = {}) {
  const messages = [user(opening)];
  for (let i = 1; i <= n; i++) {
    const content = [];
    if (thinking) content.push({ type: "thinking", thinking: `SECRET-THOUGHT-${i}`, signature: SIG });
    content.push({ type: "text", text: `Checking part ${i}.` });
    content.push({ type: "tool_use", id: `t${i}`, name: "Bash", input: { command: `cat part${i}.js`, description: "read it" } });
    messages.push({ role: "assistant", content });
    messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `t${i}`, content: `TOOL-OUTPUT-${i} `.repeat(50) }] });
  }
  return messages;
}

async function harness(t, { route, prefs = null, env = {}, stepDeadlineMs, usage = { input_tokens: 1, output_tokens: 1 } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "laya-step-"));
  const prevHome = process.env.LAYA_HOME;
  process.env.LAYA_HOME = dir;
  if (prefs) savePrefs(prefs, join(dir, "prefs.json"));
  const prevEnv = {};
  for (const [k, v] of Object.entries(env)) {
    prevEnv[k] = process.env[k];
    process.env[k] = v;
  }
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (/^\/v1\/models/.test(req.url)) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end('{"data":[]}');
      }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      seen.push({ body, headers: req.headers });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "m", type: "message", model: body.model, content: [], usage }));
    });
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const asked = [];
  const events = [];
  const { port, close } = await startProxy({
    upstreamURL: `http://127.0.0.1:${upstream.address().port}`,
    route: async (input) => {
      asked.push(input.prompt);
      return route(input);
    },
    onEvent: (e) => events.push(e),
    ...(stepDeadlineMs ? { stepDeadlineMs } : {}),
  });
  t.after(() => {
    close();
    upstream.close();
    if (prevHome === undefined) delete process.env.LAYA_HOME;
    else process.env.LAYA_HOME = prevHome;
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  const send = async (messages, { cls = "main", headers = {}, extra = {} } = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-beta": "claude-code-20250219,context-1m-2025-08-07,interleaved-thinking-2025-05-14",
        "x-claude-code-session-id": SESSION,
        "x-claude-code-request-class": cls,
        ...headers,
      },
      body: JSON.stringify({
        model: "laya-router", max_tokens: 128000, tools: TOOLS, metadata, messages,
        thinking: { type: "adaptive" },
        output_config: { effort: "medium" },
        context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] },
        ...extra,
      }),
    });
    await res.text();
    return seen.at(-1);
  };
  /** The opening turn, then `n` tool-loop continuations. Returns what upstream saw for each. */
  const run = async (n, opts) => {
    const out = [await send([user(OPENING)], opts)];
    for (let i = 1; i <= n; i++) out.push(await send(loopOf(i), opts));
    return out;
  };
  return { send, run, asked, events, seen };
}

const isStep = (prompt) => prompt.startsWith("Next step of an ongoing task:");
const opusThenHaiku = ({ prompt }) => (isStep(prompt) ? at(0.37) : at(0.6));
const ON = mergePrefs(defaultPrefs(), { stepRouting: true });

// ---- what LAYA is asked ----

test("the step prompt is the assistant's own intent: its text and tool calls, never its thinking or the tool output", () => {
  const p = stepPrompt({ messages: loopOf(3) });
  assert.match(p, /^Next step of an ongoing task:/);
  assert.match(p, /Checking part 3\./);
  assert.match(p, /Bash/);
  assert.match(p, /cat part3\.js/);
  assert.doesNotMatch(p, /SECRET-THOUGHT/, "thinking blocks are never sent");
  assert.doesNotMatch(p, /TOOL-OUTPUT/, "tool output is never sent");
  assert.doesNotMatch(p, /part2/, "only the latest assistant message");
});

test("the step prompt is capped, and is null when there is nothing to read", () => {
  const long = [user("x"), { role: "assistant", content: [{ type: "text", text: "y".repeat(10000) }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "z" }] }];
  assert.ok(stepPrompt({ messages: long }).length <= 1500);
  assert.equal(stepPrompt({ messages: [user("x")] }), null);
  assert.equal(stepPrompt({ messages: [user("x"), { role: "assistant", content: [{ type: "thinking", thinking: "t", signature: SIG }] }] }), null);
  assert.equal(stepPrompt({}), null);
});

test("the average step is measured from the conversation itself", () => {
  const s = stepSize({ messages: loopOf(4) });
  assert.ok(s.output > 0 && s.input > s.output, JSON.stringify(s));
  assert.deepEqual(stepSize({ messages: [user("x")] }), { input: 0, output: 0 });
});

// ---- off by default ----

test("off by default: a tool loop never asks LAYA again", async (t) => {
  const h = await harness(t, { route: opusThenHaiku });
  const out = await h.run(8);
  assert.equal(h.asked.length, 1, "only the opening turn");
  assert.ok(out.every((s) => s.body.model === "claude-opus-5-5"));
  assert.equal(h.events.some((e) => e.class === "step"), false);
});

// ---- rate limit ----

test("on: LAYA is asked every 4th continuation and never on two requests in a row", async (t) => {
  const h = await harness(t, { prefs: ON, route: ({ prompt }) => (isStep(prompt) ? at(0.6) : at(0.6)) });
  await h.run(9);
  const steps = h.asked.filter(isStep);
  assert.equal(steps.length, 2, `asked at continuations 4 and 8, got ${steps.length}`);
  const stepEvents = h.events.filter((e) => e.class === "step");
  assert.equal(stepEvents.length, 2);
});

test("on through LAYA_STEP_ROUTING=1, for headless runs without the app", async (t) => {
  const h = await harness(t, { env: { LAYA_STEP_ROUTING: "1" }, route: opusThenHaiku });
  await h.run(4);
  assert.equal(h.asked.filter(isStep).length, 1);
});

test("on through the x-laya-step-routing header a launcher sets, which never reaches Anthropic", async (t) => {
  const h = await harness(t, { route: opusThenHaiku });
  const out = await h.run(4, { headers: { "x-laya-step-routing": "1" } });
  assert.equal(h.asked.filter(isStep).length, 1);
  assert.equal(out.at(-1).headers["x-laya-step-routing"], undefined);
});

// ---- switching ----

test("a step switch from Opus with thinking to Haiku sends a body Haiku accepts", async (t) => {
  const h = await harness(t, { prefs: ON, route: opusThenHaiku });
  const out = await h.run(5);
  assert.equal(out[3].body.model, "claude-opus-5-5", "before the check");
  const switched = out[4];
  assert.equal(switched.body.model, "claude-haiku-4-5-20251001");
  assert.equal(switched.body.thinking, undefined, "Haiku takes no adaptive thinking");
  assert.equal(switched.body.output_config, undefined, "Haiku takes no effort");
  assert.equal(switched.body.context_management, undefined, "a thinking-clearing edit is rejected without thinking");
  assert.ok(switched.body.max_tokens <= 64000);
  assert.equal(switched.body.messages.some((m) => m.role === "system"), false);
  assert.doesNotMatch(switched.headers["anthropic-beta"], /context-1m/);
  // The API drops thinking blocks the target cannot read; they are passed back unchanged, as the
  // docs require, rather than edited here.
  assert.deepEqual(switched.body.messages[1].content[0], { type: "thinking", thinking: "SECRET-THOUGHT-1", signature: SIG });
  assert.equal(out[5].body.model, "claude-haiku-4-5-20251001", "the loop then rides the new tier");
});

test("every step check is reported: class step, reason, confidence, saving and rebuild", async (t) => {
  const h = await harness(t, { prefs: ON, route: opusThenHaiku });
  await h.run(4);
  const e = h.events.find((x) => x.class === "step");
  assert.ok(e, "a step event");
  assert.equal(e.kind, "routed");
  assert.equal(e.reason, "step-downgrade");
  assert.equal(e.confidence, 0.5);
  assert.equal(e.tier, "haiku");
  assert.equal(e.step.of, "main");
  assert.equal(e.step.from, "opus");
  assert.equal(e.step.to, "haiku");
  assert.equal(e.step.switched, true);
  assert.ok(Number.isFinite(e.step.saving) && Number.isFinite(e.step.rebuild));
  assert.ok(e.step.contextTokens > 0);
  assert.equal(e.status, 200, "the upstream status travels with the event, so a refused switch shows up");
});

test("a stay is reported too", async (t) => {
  const h = await harness(t, { prefs: ON, route: () => at(0.6) });
  await h.run(4);
  const e = h.events.find((x) => x.class === "step");
  assert.equal(e.step.switched, false);
  assert.equal(e.reason, "step-same-tier");
  assert.equal(e.tier, "opus");
});

test("an assistant message made only of thinking blocks refuses a cross-model switch, and says why", async (t) => {
  const h = await harness(t, { prefs: ON, route: opusThenHaiku });
  await h.send([user(OPENING)]);
  const messages = loopOf(4);
  // Its text and tool call travel in the next message; the API would drop this one's only blocks.
  messages.splice(1, 0, { role: "assistant", content: [{ type: "thinking", thinking: "x", signature: SIG }] }, user("go on"));
  for (let i = 1; i <= 3; i++) await h.send(loopOf(i));
  const out = await h.send(messages);
  assert.equal(out.body.model, "claude-opus-5-5");
  assert.equal(h.events.find((x) => x.class === "step").reason, "step-refused-thinking-only-message");
});

test("a step check that LAYA is too slow to answer keeps the tier and does not hold the request", async (t) => {
  const h = await harness(t, {
    prefs: ON,
    stepDeadlineMs: 200,
    route: ({ prompt }) => (isStep(prompt) ? new Promise(() => {}) : at(0.6)),
  });
  const started = Date.now();
  const out = await h.run(4);
  assert.ok(Date.now() - started < 3000);
  assert.equal(out.at(-1).body.model, "claude-opus-5-5");
  assert.equal(h.events.find((x) => x.class === "step").reason, "step-laya-unavailable");
});

test("a sub-agent's step switch is its own: the main conversation keeps its tier", async (t) => {
  const SUB = "List every caller of loadConfig.";
  const h = await harness(t, { prefs: ON, route: ({ prompt }) => (isStep(prompt) ? at(0.6) : prompt === SUB ? at(0.37) : at(0.5)) });
  await h.send([user(OPENING)]);
  await h.send([user(SUB)], { cls: "subagent" });
  let last;
  for (let i = 1; i <= 4; i++) last = await h.send(loopOf(i, { opening: SUB, thinking: false }), { cls: "subagent" });
  assert.equal(last.body.model, "claude-opus-5-5", "the sub-agent stepped up");
  assert.equal(h.events.find((x) => x.class === "step").step.of, "subagent");
  const main = await h.send(loopOf(1));
  assert.equal(main.body.model, "claude-sonnet-5-5", "the main conversation did not move");
});

// Measured live on 2026-10-03: the messages alone estimated 6,758 tokens while the API reported a
// 20,093-token cached prefix (system prompt and tools are cached too), so a rebuild priced on the
// messages was a third of the real one.
test("the cache a switch would discard is what the API last reported, not a guess from the messages", async (t) => {
  const h = await harness(t, {
    prefs: ON,
    route: opusThenHaiku,
    usage: { input_tokens: 2, cache_read_input_tokens: 45000, cache_creation_input_tokens: 500, output_tokens: 80 },
  });
  const out = await h.run(4);
  const e = h.events.find((x) => x.class === "step");
  assert.ok(e.step.contextTokens >= 45502, `contextTokens ${e.step.contextTokens}`);
  assert.equal(e.reason, "step-context-too-large");
  assert.equal(out.at(-1).body.model, "claude-opus-5-5");
});

test("a turn the user pinned with 'use opus' is not step-routed off it", async (t) => {
  const h = await harness(t, { prefs: ON, route: () => at(0.37) });
  await h.send([user(`use opus: ${OPENING}`)]);
  let last;
  for (let i = 1; i <= 4; i++) last = await h.send(loopOf(i, { opening: `use opus: ${OPENING}` }));
  assert.equal(last.body.model, "claude-opus-5-5");
  assert.equal(h.asked.filter(isStep).length, 0, "no step check inside a pinned turn");
});

// ---- the wire guard ----

test("stepHazard: a thinking-only assistant message refuses any switch", () => {
  const messages = [user("x"), { role: "assistant", content: [{ type: "redacted_thinking", data: "abc" }] }, user("y")];
  assert.equal(stepHazard({ messages }, "claude-haiku-4-5-20251001"), "thinking-only-message");
  assert.equal(stepHazard({ messages: loopOf(2) }, "claude-haiku-4-5-20251001"), null);
});

test("stepHazard: a model that checks thinking prefixes is refused when the proxy would rewrite its history", () => {
  // Opus 5.5, Sonnet 5.5 and Fable 5.1 reject (400) a thinking block whose earlier messages changed.
  // The proxy folds system-role messages for models that cannot take them; for a model that both
  // checks prefixes and needs folding, a switch would change the prefix under every thinking block.
  const messages = [...loopOf(2), { role: "system", content: [{ type: "text", text: "rules" }] }];
  assert.equal(stepHazard({ messages }, "claude-opus-5-5"), null, "Opus 5.5 takes system messages, nothing is rewritten");
  assert.equal(stepHazard({ messages }, "claude-opus-5-5-folding-test", { checksPrefix: () => true, takesSystem: () => false }), "thinking-prefix-would-change");
});
