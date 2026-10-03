import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startProxy } from "../src/proxy.mjs";

// End-to-end through the real proxy with a stub upstream that records exactly what it received
// and a scripted `route` standing in for LAYA. Bodies mirror what claude 2.1.285 sends.
const TOOLS = [{ name: "Bash", description: "x", input_schema: { type: "object", properties: {} } }];
const score = (s, confidence = 0.4) => async () => ({
  metrics: { taskComplexity: s, reasoningRequired: s, toolComplexity: s },
  confidence,
  ms: 1,
  request: {},
  response: {},
});

async function harness(t, route) {
  const seen = [];
  const stub = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString();
      if (req.url.startsWith("/v1/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end('{"data":[]}');
      }
      let body = {};
      try { body = JSON.parse(raw); } catch {}
      seen.push({ body, headers: req.headers });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "m", type: "message", role: "assistant", model: body.model, content: [], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }));
    });
  });
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  const previous = process.env.LAYA_CLAUDE_UPSTREAM;
  process.env.LAYA_CLAUDE_UPSTREAM = `http://127.0.0.1:${stub.address().port}`;
  const asked = [];
  const { port, close } = await startProxy({
    route: async (a) => { asked.push(a.prompt); return route(a); },
  });
  t.after(() => {
    close();
    stub.close();
    if (previous === undefined) delete process.env.LAYA_CLAUDE_UPSTREAM;
    else process.env.LAYA_CLAUDE_UPSTREAM = previous;
  });
  let n = 0;
  const post = async ({ session = "s1", cls = "main", messages, extra = {}, headers = {} }) => {
    seen.length = 0;
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-claude-code-session-id": session,
        ...(cls ? { "x-claude-code-request-class": cls } : {}),
        ...headers,
      },
      body: JSON.stringify({
        model: "laya-router",
        max_tokens: 128000,
        tools: TOOLS,
        messages,
        metadata: { user_id: JSON.stringify({ session_id: session }) },
        ...extra,
      }),
    });
    await res.text();
    return seen[0];
  };
  return { post, asked, seen };
}

const user = (text) => ({ role: "user", content: [{ type: "text", text }] });
const asst = (text) => ({ role: "assistant", content: [{ type: "text", text }] });

test("a request labelled auxiliary is never sent to LAYA and never changes the tier", async (t) => {
  const h = await harness(t, score(0.6));
  await h.post({ cls: "main", messages: [user("redesign the whole auth system")] }); // -> opus
  h.asked.length = 0;
  const aux = await h.post({ cls: "auxiliary", messages: [user("write a session title")] });
  assert.deepEqual(h.asked, [], "background work is not scored");
  assert.equal(aux.body.model, "claude-haiku-4-5-20251001", "background work goes to the cheap model");
  const again = await h.post({ cls: "main", messages: [user("redesign the whole auth system"), asst("ok"), { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "done" }] }] });
  assert.equal(again.body.model, "claude-opus-5-5", "the session keeps its tier");
});

test("a sub-agent is scored on its own task, and the main conversation keeps its tier", async (t) => {
  const scores = [0.6, 0.35];
  let i = 0;
  const h = await harness(t, async () => score(scores[i++])());
  await h.post({ cls: "main", messages: [user("redesign the whole auth system")] }); // -> opus
  const sub = await h.post({ cls: "subagent", messages: [user("explore the repo")] });
  assert.deepEqual(h.asked, ["redesign the whole auth system", "explore the repo"]);
  assert.equal(sub.body.model, "claude-haiku-4-5-20251001", "the sub-agent got its own tier");
  const main = await h.post({ cls: "main", messages: [user("redesign the whole auth system"), asst("ok"), { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "done" }] }] });
  assert.equal(main.body.model, "claude-opus-5-5", "the main conversation did not follow it down");
});

test("a compaction request keeps the session's tier and is not treated as the user's message", async (t) => {
  const h = await harness(t, score(0.6));
  await h.post({ messages: [user("redesign the whole auth system")] });
  h.asked.length = 0;
  const c = await h.post({ cls: "compaction", messages: [user("summarise the conversation so far")] });
  assert.deepEqual(h.asked, []);
  assert.equal(c.body.model, "claude-opus-5-5");
});

test("Claude Code's synthetic 'output token limit' message is not mistaken for the user's prompt", async (t) => {
  const h = await harness(t, score(0.47));
  await h.post({ messages: [user("fix the failing test")] });
  h.asked.length = 0;
  await h.post({ cls: "main", messages: [user("fix the failing test"), asst("partial"), user("Output token limit hit. Resume directly — no apology, no recap of what you were doing.")] });
  assert.deepEqual(h.asked, [], "a synthetic continuation is not a new human message");
});

test("the ratchet: a hard turn then an easy turn stays on the hard turn's tier within a session", async (t) => {
  const scores = [0.6, 0.35];
  let i = 0;
  const h = await harness(t, async () => score(scores[i++])());
  const first = await h.post({ messages: [user("redesign the whole auth system")] });
  assert.equal(first.body.model, "claude-opus-5-5");
  const second = await h.post({ messages: [user("redesign the whole auth system"), asst("ok"), user("thanks!")] });
  assert.equal(second.body.model, "claude-opus-5-5", "a quick 'thanks' does not send the session back down");
});

test("a new session is decided fresh, so an easy first message can start cheap", async (t) => {
  const h = await harness(t, score(0.35));
  const first = await h.post({ messages: [user("what is 2+2?")] });
  assert.equal(first.body.model, "claude-haiku-4-5-20251001");
});

test("an explicit 'use haiku' still moves an ongoing session down", async (t) => {
  const h = await harness(t, score(0.6));
  await h.post({ messages: [user("redesign the whole auth system")] });
  const d = await h.post({ messages: [user("redesign the whole auth system"), asst("ok"), user("use haiku: list the files")] });
  assert.equal(d.body.model, "claude-haiku-4-5-20251001");
});

test("a request routed to Haiku is adapted: system messages folded, max_tokens capped, 1M beta dropped", async (t) => {
  const h = await harness(t, score(0.35));
  const out = await h.post({
    messages: [user("what is 2+2?"), { role: "system", content: [{ type: "text", text: "session rules" }] }],
    headers: { "anthropic-beta": "claude-code-20250219,context-1m-2025-08-07,effort-2025-11-24" },
    extra: { thinking: { type: "adaptive" }, output_config: { effort: "high" } },
  });
  assert.equal(out.body.model, "claude-haiku-4-5-20251001");
  assert.equal(out.body.messages.some((m) => m.role === "system"), false, "Haiku rejects system-role messages");
  assert.equal(out.body.max_tokens, 64000, "Haiku accepts at most 64000");
  assert.equal(out.body.thinking, undefined);
  assert.equal(out.headers["anthropic-beta"], "claude-code-20250219,effort-2025-11-24");
});

test("a request routed to Sonnet keeps its system message untouched", async (t) => {
  const h = await harness(t, score(0.47));
  const out = await h.post({
    messages: [user("fix the failing test"), { role: "system", content: [{ type: "text", text: "session rules" }] }],
  });
  assert.equal(out.body.model, "claude-sonnet-5-5");
  assert.equal(out.body.messages.at(-1).role, "system");
  assert.equal(out.body.max_tokens, 128000);
});

test("without hint headers the proxy still routes (class is unknown, the body decides)", async (t) => {
  const h = await harness(t, score(0.47));
  const out = await h.post({ cls: null, messages: [user("fix the failing test")] });
  assert.equal(out.body.model, "claude-sonnet-5-5");
  assert.equal(h.asked.length, 1);
});

// The judgment question travels in metrics; the proxy must hand it to the policy untouched.
const scoreWithJudgment = (mean, judgment) => async () => ({
  metrics: { taskComplexity: mean, reasoningRequired: mean, toolComplexity: mean, judgment },
  confidence: 0.4,
  ms: 1,
  request: {},
  response: {},
});

test("Haiku-shaped work (low score, low judgment) is tried on Haiku end to end", async (t) => {
  const h = await harness(t, scoreWithJudgment(0.46, 0.15));
  const out = await h.post({ messages: [user("Fix the typo 'recieve' in the README.")] });
  assert.equal(out.body.model, "claude-haiku-4-5-20251001");
});

test("the same score with high judgment (unknown-cause work) is NOT sent to Haiku end to end", async (t) => {
  const h = await harness(t, scoreWithJudgment(0.46, 0.85));
  const out = await h.post({ messages: [user("There is a race condition somewhere in the job scheduler; jobs run twice.")] });
  assert.equal(out.body.model, "claude-sonnet-5-5");
});

// Effort. The launcher's settings make Claude Code send `medium` (the documented default for the
// Claude 5.5 models). That value is the marker for "the user did not choose": the router replaces
// it with its own level, and leaves any other value alone because the user chose it.
const scoreJ = (mean, judgment) => async () => ({
  metrics: { taskComplexity: mean, reasoningRequired: mean, toolComplexity: mean, judgment },
  confidence: 0.4, ms: 1, request: {}, response: {},
});
const withEffort = (effort) => ({ output_config: { effort } });

test("effort: a stated task on sonnet runs at low effort end to end", async (t) => {
  const h = await harness(t, scoreJ(0.49, 0.15));
  const out = await h.post({ messages: [user("Bump the lodash version in package.json.")], extra: withEffort("medium") });
  assert.equal(out.body.model, "claude-sonnet-5-5");
  assert.equal(out.body.output_config.effort, "low");
});

test("effort: hard open-ended work on opus runs at high effort end to end", async (t) => {
  const h = await harness(t, scoreJ(0.6, 0.8));
  const out = await h.post({ messages: [user("Design the whole billing system.")], extra: withEffort("medium") });
  assert.equal(out.body.model, "claude-opus-5-5");
  assert.equal(out.body.output_config.effort, "high");
});

test("effort: a level the user chose (anything but the launcher's medium) is left alone", async (t) => {
  const h = await harness(t, scoreJ(0.49, 0.15));
  const out = await h.post({ messages: [user("Bump the lodash version.")], extra: withEffort("max") });
  assert.equal(out.body.output_config.effort, "max");
});

test("effort: haiku gets no effort parameter", async (t) => {
  const h = await harness(t, scoreJ(0.46, 0.15));
  const out = await h.post({ messages: [user("Fix the typo in the README.")], extra: withEffort("medium") });
  assert.equal(out.body.model, "claude-haiku-4-5-20251001");
  assert.equal(out.body.output_config, undefined);
});

test("effort: follow-up tool calls in the same turn keep the level chosen for that turn", async (t) => {
  const h = await harness(t, scoreJ(0.49, 0.15));
  await h.post({ messages: [user("Bump the lodash version.")], extra: withEffort("medium") });
  const follow = await h.post({
    messages: [user("Bump the lodash version."), asst("ok"), { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "done" }] }],
    extra: withEffort("medium"),
  });
  assert.equal(follow.body.output_config.effort, "low");
});

test("effort: a later harder message in the same session raises it and an easier one does not lower it", async (t) => {
  let level = [0.49, 0.15];
  const h = await harness(t, async (a) => scoreJ(...level)(a));
  const first = await h.post({ messages: [user("Bump lodash.")], extra: withEffort("medium") });
  level = [0.52, 0.8];
  const harder = await h.post({ messages: [user("Bump lodash."), asst("ok"), user("Now find why jobs run twice.")], extra: withEffort("medium") });
  level = [0.49, 0.15];
  const easier = await h.post({ messages: [user("Bump lodash."), asst("ok"), user("Now find why jobs run twice."), asst("ok"), user("Rename x to y.")], extra: withEffort("medium") });
  assert.equal(first.body.output_config.effort, "low");
  assert.equal(harder.body.output_config.effort, "high");
  assert.equal(easier.body.output_config.effort, "high");
});
