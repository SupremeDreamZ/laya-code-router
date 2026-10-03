import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { startProxy } from "../src/proxy.mjs";

// The daemon needs to be told what the proxy did, so it can show a live feed and total the cost
// from the usage the API reports. These tests pin the shape of that callback and the usage
// numbers, without a Laya process: `route` is scripted, and the stub upstream answers like the
// Messages API, streaming usage on message_start and message_delta.
const TOOLS = [{ name: "Bash", description: "x", input_schema: { type: "object", properties: {} } }];
const user = (text) => ({ role: "user", content: [{ type: "text", text }] });

function stubUpstream({ usage, stream = true }) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (/^\/v1\/models/.test(req.url)) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end('{"data":[]}');
      }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      seen.push(body);
      if (!stream) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(
          JSON.stringify({
            id: "m", type: "message", role: "assistant", model: body.model, content: [{ type: "text", text: "ok" }],
            stop_reason: "end_turn", usage,
          }),
        );
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      ev("message_start", { message: { id: "m", type: "message", role: "assistant", model: body.model, content: [], usage } });
      ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
      ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "ok" } });
      ev("content_block_stop", { index: 0 });
      ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: usage.output_tokens } });
      ev("message_stop", {});
      res.end();
    });
  });
  const stub = {
    server,
    seen,
    port: 0,
    listen: () => new Promise((r) => server.listen(0, "127.0.0.1", () => r((stub.port = server.address().port)))),
    close: () => server.close(),
  };
  return stub;
}

async function withProxy(t, { route, upstream }) {
  const prev = process.env.LAYA_CLAUDE_UPSTREAM;
  process.env.LAYA_CLAUDE_UPSTREAM = `http://127.0.0.1:${upstream.port}`;
  const events = [];
  const { port, close } = await startProxy({ route, onEvent: (e) => events.push(e) });
  t.after(() => {
    close();
    upstream.close();
    if (prev === undefined) delete process.env.LAYA_CLAUDE_UPSTREAM;
    else process.env.LAYA_CLAUDE_UPSTREAM = prev;
  });
  return { port, events };
}

const send = async (port, body, headers = {}) => {
  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-claude-code-session-id": "s1", ...headers },
    body: JSON.stringify(body),
  });
  await res.text();
};

const routed = async (t, { tier = "sonnet", model = "claude-sonnet-5-5", prompt = "Add pagination." } = {}) => {
  const upstream = stubUpstream({ usage: { input_tokens: 40, cache_creation_input_tokens: 2000, cache_read_input_tokens: 30000, output_tokens: 300 } });
  await upstream.listen();
  const h = await withProxy(t, {
    upstream,
    route: async () => ({
      metrics: { taskComplexity: 0.5, reasoningRequired: 0.5, toolComplexity: 0.5, judgment: 0.4 },
      confidence: 0.4, ms: 5, request: {}, response: {},
    }),
  });
  await send(h.port, { model: "laya-router", max_tokens: 128000, tools: TOOLS, messages: [user(prompt)] });
  return { h, upstream };
};

// The proxy reports what it decided; stamping the time is the daemon's job, so it can date the
// event once from one clock rather than two.
test("onEvent: a routed turn reports tier, model, effort, and the usage the API reported", async (t) => {
  const { h } = await routed(t);
  const e = h.events.find((x) => x.kind === "routed");
  assert.ok(e, "an event was emitted for the routed turn");
  assert.equal(e.tier, "sonnet");
  assert.equal(e.model, "claude-sonnet-5-5");
  assert.equal(e.usage.cacheRead, 30000);
  // This request carried no output_config, so the router had nothing to replace and the
  // event reports the effort that was actually sent: none.
  assert.equal(e.effort, null);
  assert.equal(e.usage.output, 300);
  assert.equal(e.usage.input, 40);
  assert.equal(e.reason, "laya");
  assert.equal(e.prompt, "Add pagination.");
});

test("onEvent: background work routed to the cheap model is reported as such, not as a user turn", async (t) => {
  const upstream = stubUpstream({ usage: { input_tokens: 5, output_tokens: 2 } });
  await upstream.listen();
  const h = await withProxy(t, {
    upstream,
    route: async () => {
      throw new Error("LAYA must not be asked for background work");
    },
  });
  await send(h.port, { model: "laya-router", max_tokens: 100, tools: TOOLS, messages: [user("title")] }, { "x-claude-code-request-class": "auxiliary" });
  const e = h.events.find((x) => x.kind === "routed");
  assert.equal(e.tier, "haiku");
  assert.equal(e.reason, "background");
  assert.equal(e.prompt, undefined, "background work has no user prompt to show");
});

test("onEvent: a request whose usage the API did not report is still reported, with no cost", async (t) => {
  const upstream = stubUpstream({ usage: { input_tokens: 0, output_tokens: 0 } });
  await upstream.listen();
  const h = await withProxy(t, {
    upstream,
    route: async () => ({ metrics: { taskComplexity: 0.5, reasoningRequired: 0.5, toolComplexity: 0.5 }, confidence: 0.4, ms: 1, request: {}, response: {} }),
  });
  await send(h.port, { model: "laya-router", max_tokens: 100, tools: TOOLS, messages: [user("hi")] });
  const e = h.events.filter((x) => x.kind === "routed").at(-1);
  assert.equal(e.usage.output, 0);
});

test("onEvent: a non-streaming response is measured too", async (t) => {
  const upstream = stubUpstream({ usage: { input_tokens: 11, output_tokens: 22 }, stream: false });
  await upstream.listen();
  const h = await withProxy(t, {
    upstream,
    route: async () => ({ metrics: { taskComplexity: 0.5, reasoningRequired: 0.5, toolComplexity: 0.5 }, confidence: 0.4, ms: 1, request: {}, response: {} }),
  });
  const res = await fetch(`http://127.0.0.1:${h.port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-claude-code-session-id": "s2" },
    body: JSON.stringify({ model: "laya-router", max_tokens: 100, tools: TOOLS, messages: [user("hi")] }),
  });
  await res.json();
  const e = h.events.filter((x) => x.kind === "routed").at(-1);
  assert.equal(e.usage.input, 11);
  assert.equal(e.usage.output, 22);
});


test("onEvent: the effort actually sent is reported, and the launcher's default is replaced", async (t) => {
  const upstream = stubUpstream({ usage: { input_tokens: 8, output_tokens: 4 } });
  await upstream.listen();
  const h = await withProxy(t, {
    upstream,
    route: async () => ({
      metrics: { taskComplexity: 0.49, reasoningRequired: 0.49, toolComplexity: 0.49, judgment: 0.15 },
      confidence: 0.4, ms: 5, request: {}, response: {},
    }),
  });
  await send(h.port, {
    model: "laya-router", max_tokens: 128000, tools: TOOLS,
    messages: [user("Bump the lodash version.")],
    output_config: { effort: "medium" },
  });
  const e = h.events.find((x) => x.kind === "routed");
  assert.equal(e.tier, "sonnet");
  assert.equal(e.effort, "low", "a stated task on sonnet runs at low effort");
});


// The app's settings are a file the daemon writes and the proxy reads. Two things matter: the
// proxy must obey them the moment they change (not a second later, which is the difference
// between "I turned it off and it still routed" and it feeling reliable), and with no file at
// all the proxy must behave exactly as the command-line launcher does.
import { savePrefs, defaultPrefs, mergePrefs } from "../src/prefs.mjs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const withPrefs = async (t, prefs) => {
  const dir = mkdtempSync(join(tmpdir(), "laya-prefs-"));
  const prev = process.env.LAYA_HOME;
  process.env.LAYA_HOME = dir;
  if (prefs) savePrefs(prefs, join(dir, "prefs.json"));
  t.after(() => { if (prev === undefined) delete process.env.LAYA_HOME; else process.env.LAYA_HOME = prev; });
  return dir;
};

const askTurn = async (port, prompt) => {
  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-claude-code-session-id": "s", "x-claude-code-request-class": "main" },
    body: JSON.stringify({ model: "laya-router", max_tokens: 100, tools: TOOLS, messages: [user(prompt)], output_config: { effort: "medium" } }),
  });
  await res.text();
};

test("prefs: with no settings file the proxy routes exactly as before", async (t) => {
  await withPrefs(t, null);
  const upstream = stubUpstream({ usage: { input_tokens: 5, output_tokens: 1 } });
  await upstream.listen();
  const h = await withProxy(t, {
    upstream,
    route: async () => ({ metrics: { taskComplexity: 0.6, reasoningRequired: 0.6, toolComplexity: 0.6 }, confidence: 0.4, ms: 1, request: {}, response: {} }),
  });
  await askTurn(h.port, "redesign the auth system");
  assert.equal(upstream.seen[0].model, "claude-opus-5-5", "no file means no app, so the router runs");
  assert.equal(h.events.find((e) => e.kind === "routed")?.tier, "opus");
});

test("prefs: routing off sends every turn to the paused tier, on the very next turn", async (t) => {
  const dir = await withPrefs(t, mergePrefs(defaultPrefs(), { enabled: false, pausedTier: "sonnet" }));
  const upstream = stubUpstream({ usage: { input_tokens: 5, output_tokens: 1 } });
  await upstream.listen();
  const h = await withProxy(t, {
    upstream,
    route: async () => {
      throw new Error("LAYA must not be asked while routing is paused");
    },
  });
  await askTurn(h.port, "redesign the auth system");
  assert.equal(upstream.seen[0].model, "claude-sonnet-5-5");
  assert.equal(h.events.find((e) => e.kind === "paused")?.reason, "routing is off");
});

test("prefs: turning routing back on takes effect on the next turn, not after a delay", async (t) => {
  const dir = await withPrefs(t, mergePrefs(defaultPrefs(), { enabled: false, pausedTier: "sonnet" }));
  const upstream = stubUpstream({ usage: { input_tokens: 5, output_tokens: 1 } });
  await upstream.listen();
  const h = await withProxy(t, {
    upstream,
    route: async () => ({ metrics: { taskComplexity: 0.6, reasoningRequired: 0.6, toolComplexity: 0.6 }, confidence: 0.4, ms: 1, request: {}, response: {} }),
  });
  await askTurn(h.port, "first, while paused");
  assert.equal(upstream.seen[0].model, "claude-sonnet-5-5", "paused");
  // The app writes the change; no restart, no sleep, no cache to expire.
  savePrefs(mergePrefs(defaultPrefs(), { enabled: true }), join(dir, "prefs.json"));
  await askTurn(h.port, "second, now routed");
  assert.equal(upstream.seen[1].model, "claude-opus-5-5", "routing resumed on the very next turn");
});

test("prefs: a tier switched off is never chosen, and work steps up instead", async (t) => {
  await withPrefs(t, mergePrefs(defaultPrefs(), { tiers: { haiku: false } }));
  const upstream = stubUpstream({ usage: { input_tokens: 5, output_tokens: 1 } });
  await upstream.listen();
  const h = await withProxy(t, {
    upstream,
    route: async () => ({ metrics: { taskComplexity: 0.45, reasoningRequired: 0.45, toolComplexity: 0.45, judgment: 0.1 }, confidence: 0.4, ms: 1, request: {}, response: {} }),
  });
  await askTurn(h.port, "Fix the typo in the README.");
  assert.equal(upstream.seen[0].model, "claude-sonnet-5-5", "would have been Haiku, so it stepped up");
});

test("prefs: the preset chosen in the app changes where the same scores land", async (t) => {
  const route = async () => ({ metrics: { taskComplexity: 0.53, reasoningRequired: 0.53, toolComplexity: 0.53, judgment: 0.3 }, confidence: 0.4, ms: 1, request: {}, response: {} });
  const landing = {};
  for (const preset of ["savings", "balanced", "careful"]) {
    await withPrefs(t, mergePrefs(defaultPrefs(), { preset }));
    const upstream = stubUpstream({ usage: { input_tokens: 5, output_tokens: 1 } });
    await upstream.listen();
    const h = await withProxy(t, { upstream, route });
    await askTurn(h.port, `Refactor the retry helper (${preset}).`);
    landing[preset] = upstream.seen[0].model;
  }
  assert.deepEqual(landing, { savings: "claude-sonnet-5-5", balanced: "claude-opus-5-5", careful: "claude-opus-5-5" });
});

test("prefs: effort off leaves the level Claude Code chose", async (t) => {
  await withPrefs(t, mergePrefs(defaultPrefs(), { effortAuto: false }));
  const upstream = stubUpstream({ usage: { input_tokens: 5, output_tokens: 1 } });
  await upstream.listen();
  const h = await withProxy(t, {
    upstream,
    route: async () => ({ metrics: { taskComplexity: 0.49, reasoningRequired: 0.49, toolComplexity: 0.49, judgment: 0.15 }, confidence: 0.4, ms: 1, request: {}, response: {} }),
  });
  await askTurn(h.port, "Bump the lodash version.");
  assert.equal(upstream.seen[0].output_config.effort, "medium", "left exactly as sent");
});
