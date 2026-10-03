import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startProxy } from "../src/proxy.mjs";

// Sub-agents are routed, but pinned separately (dirien/jev-router). Claude Code runs each sub-agent
// as its own conversation through the same endpoint and labels its requests `subagent`. Its opening
// request carries the task the main agent handed it, which is a prompt LAYA can score like any
// other; its tool loop then rides the tier chosen for it. None of it may touch the main
// conversation's tier, and when LAYA cannot answer, the sub-agent runs on what its parent runs on.
const TOOLS = [{ name: "Bash", description: "x", input_schema: { type: "object", properties: {} } }];
const SESSION = "aaaaaaaa-1111-4222-8333-444444444444";
const metadata = { user_id: JSON.stringify({ session_id: SESSION }) };
const text = (t) => ({ role: "user", content: [{ type: "text", text: t }] });
const at = (score, judgment = 0.1) => ({
  metrics: { taskComplexity: score, reasoningRequired: score, toolComplexity: score, judgment },
  confidence: 0.5, ms: 1, request: {}, response: {},
});

async function harness(t, route) {
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
      seen.push(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "m", type: "message", model: body.model, content: [], usage: { input_tokens: 1, output_tokens: 1 } }));
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
  });
  t.after(() => {
    close();
    upstream.close();
  });
  const send = async (messages, cls) => {
    const headers = { "content-type": "application/json", "x-claude-code-session-id": SESSION };
    if (cls === "agent-id") headers["x-claude-code-agent-id"] = "agent-1";
    else if (cls) headers["x-claude-code-request-class"] = cls;
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "laya-router", max_tokens: 1000, tools: TOOLS, metadata, messages }),
    });
    await res.text();
    return seen.at(-1).model;
  };
  return { send, asked, events, seen };
}

const MAIN = [text("Redesign the session store so it survives a restart.")];
const SUB = [text("Find every file that imports the session store and list them.")];
const loop = (opening) => [
  ...opening,
  { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "a.js" }] },
];
const scoreFor = ({ prompt }) => (prompt.startsWith("Redesign") ? at(0.6) : at(0.37));

test("a sub-agent's opening request is scored on its own task and pinned for its tool loop", async (t) => {
  const h = await harness(t, scoreFor);
  assert.equal(await h.send(MAIN, "main"), "claude-opus-5-5");
  assert.equal(await h.send(SUB, "subagent"), "claude-haiku-4-5-20251001", "the sub-agent's task is Haiku-shaped");
  assert.deepEqual(h.asked, [MAIN[0].content[0].text, SUB[0].content[0].text], "LAYA saw the sub-agent's task text");
  assert.equal(await h.send(loop(SUB), "subagent"), "claude-haiku-4-5-20251001", "its tool loop rides its own tier");
  assert.equal(await h.send(loop(MAIN), "main"), "claude-opus-5-5", "the main conversation is untouched");
  assert.equal(h.asked.length, 2, "tool-loop requests are not scored");
});

test("a request carrying only an agent id is a sub-agent too", async (t) => {
  const h = await harness(t, scoreFor);
  await h.send(MAIN, "main");
  assert.equal(await h.send(SUB, "agent-id"), "claude-haiku-4-5-20251001");
  assert.equal(h.events.at(-1).class, "subagent");
});

test("a sub-agent's choice never changes the main conversation's tier", async (t) => {
  // Main is cheap work; the sub-agent is hard. The sub-agent goes up, the main does not follow.
  const h = await harness(t, ({ prompt }) => (prompt.startsWith("Redesign") ? at(0.37) : at(0.6)));
  assert.equal(await h.send(MAIN, "main"), "claude-haiku-4-5-20251001");
  assert.equal(await h.send(SUB, "subagent"), "claude-opus-5-5");
  assert.equal(await h.send(loop(MAIN), "main"), "claude-haiku-4-5-20251001");
});

test("fail-open: when LAYA has no answer, a sub-agent runs on its parent's tier, not the placeholder", async (t) => {
  const h = await harness(t, ({ prompt }) => (prompt.startsWith("Redesign") ? at(0.47, 0.6) : null));
  assert.equal(await h.send(MAIN, "main"), "claude-sonnet-5-5");
  assert.equal(await h.send(SUB, "subagent"), "claude-sonnet-5-5", "the parent's tier, not opus");
  assert.match(h.events.at(-1).reason, /laya-unavailable/);
});

test("fail-open: a router that throws still leaves the sub-agent on its parent's tier", async (t) => {
  const h = await harness(t, ({ prompt }) => {
    if (prompt.startsWith("Redesign")) return at(0.47, 0.6);
    throw new Error("sidecar died");
  });
  await h.send(MAIN, "main");
  assert.equal(await h.send(SUB, "subagent"), "claude-sonnet-5-5");
});

test("background work still goes to haiku without asking LAYA", async (t) => {
  const h = await harness(t, () => {
    throw new Error("LAYA must not be asked for background work");
  });
  assert.equal(await h.send([text("write a title")], "auxiliary"), "claude-haiku-4-5-20251001");
  assert.equal(h.events.at(-1).class, "auxiliary");
});

test("every routed event says which kind of conversation it served", async (t) => {
  const h = await harness(t, scoreFor);
  await h.send(MAIN, "main");
  await h.send(SUB, "subagent");
  await h.send(loop(SUB), "subagent");
  await h.send(loop(MAIN));
  const routed = h.events.filter((e) => e.kind === "routed");
  assert.deepEqual(routed.map((e) => e.class), ["main", "subagent", "subagent", "main"]);
});
