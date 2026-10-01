import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startProxy } from "../src/proxy.mjs";
import { freePort } from "./helpers.mjs";

// The proxy sees every response, so the plan's rate-limit headers can be read as they pass. These
// pin the two things that matter: the figures reach the daemon, and the client gets the response
// byte for byte, limit headers included (Claude Code reads them itself).
const REAL_HEADERS = {
  "anthropic-ratelimit-unified-5h-reset": "1790814600",
  "anthropic-ratelimit-unified-5h-status": "allowed",
  "anthropic-ratelimit-unified-5h-utilization": "0.05",
  "anthropic-ratelimit-unified-7d-reset": "1790838000",
  "anthropic-ratelimit-unified-7d-status": "allowed",
  "anthropic-ratelimit-unified-7d-utilization": "0.01",
  "anthropic-ratelimit-unified-status": "allowed",
  "anthropic-ratelimit-unified-representative-claim": "five_hour",
};

function upstream(handler) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => handler(req, res, Buffer.concat(chunks).toString()));
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ port: server.address().port, close: () => server.close() })),
  );
}

async function withProxy(t, handler, opts = {}) {
  const up = await upstream(handler);
  const prev = process.env.LAYA_CLAUDE_UPSTREAM;
  process.env.LAYA_CLAUDE_UPSTREAM = `http://127.0.0.1:${up.port}`;
  const limits = [];
  const events = [];
  const proxy = await startProxy({
    route: async () => null,
    onEvent: (e) => events.push(e),
    onLimits: (l) => limits.push(l),
    ...opts,
  });
  t.after(() => {
    proxy.close();
    up.close();
    if (prev === undefined) delete process.env.LAYA_CLAUDE_UPSTREAM;
    else process.env.LAYA_CLAUDE_UPSTREAM = prev;
  });
  return { proxy, limits, events };
}

const post = (port, body) =>
  fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
    body: JSON.stringify(body),
  });

const EXPLICIT = { model: "claude-sonnet-5-5", max_tokens: 10, messages: [{ role: "user", content: "hi" }] };

test("limit headers on a response reach onLimits, parsed", async (t) => {
  const h = await withProxy(t, (req, res) => {
    res.writeHead(200, { "content-type": "application/json", ...REAL_HEADERS });
    res.end(JSON.stringify({ type: "message", content: [], usage: { input_tokens: 1, output_tokens: 1 } }));
  });
  await (await post(h.proxy.port, EXPLICIT)).text();
  assert.equal(h.limits.length, 1);
  assert.equal(h.limits[0].windows["5h"].utilization, 0.05);
  assert.equal(h.limits[0].windows["7d"].utilization, 0.01);
  assert.equal(h.limits[0].representative, "5h");
});

test("an explicit model choice reports limits too, though no routing decision was made", async (t) => {
  const h = await withProxy(t, (req, res) => {
    res.writeHead(200, { "content-type": "application/json", ...REAL_HEADERS });
    res.end("{}");
  });
  await (await post(h.proxy.port, EXPLICIT)).text();
  assert.equal(h.limits.length, 1);
  assert.equal(h.events.filter((e) => e.kind === "routed").length, 0, "nothing was routed, and none is claimed");
});

test("the client receives the limit headers and the body untouched", async (t) => {
  const h = await withProxy(t, (req, res) => {
    res.writeHead(200, { "content-type": "application/json", ...REAL_HEADERS });
    res.end('{"ok":true}');
  });
  const res = await post(h.proxy.port, EXPLICIT);
  assert.equal(res.headers.get("anthropic-ratelimit-unified-5h-utilization"), "0.05");
  assert.equal(res.headers.get("anthropic-ratelimit-unified-status"), "allowed");
  assert.equal(await res.text(), '{"ok":true}');
});

// Synthetic: the shape of a blocked response, not a capture. It has to survive the proxy because
// the moment you hit the limit is the moment the app most needs to hear about it.
test("a 429 that says the limit is hit is reported and passed through unchanged", async (t) => {
  const blocked = {
    ...REAL_HEADERS,
    "anthropic-ratelimit-unified-5h-status": "rejected",
    "anthropic-ratelimit-unified-5h-utilization": "1.0",
    "anthropic-ratelimit-unified-status": "rejected",
  };
  const h = await withProxy(t, (req, res) => {
    res.writeHead(429, { "content-type": "application/json", ...blocked });
    res.end('{"type":"error","error":{"type":"rate_limit_error","message":"limit"}}');
  });
  const res = await post(h.proxy.port, EXPLICIT);
  assert.equal(res.status, 429);
  assert.match(await res.text(), /rate_limit_error/);
  assert.equal(h.limits.length, 1);
  assert.equal(h.limits[0].windows["5h"].status, "rejected");
  assert.equal(h.limits[0].status, "rejected");
});

test("responses without limit headers report nothing", async (t) => {
  const h = await withProxy(t, (req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  await (await post(h.proxy.port, EXPLICIT)).text();
  assert.equal(h.limits.length, 0);
});

test("a listener that throws cannot break the response", async (t) => {
  const h = await withProxy(
    t,
    (req, res) => {
      res.writeHead(200, { "content-type": "application/json", ...REAL_HEADERS });
      res.end('{"ok":true}');
    },
    {
      onLimits: () => {
        throw new Error("boom");
      },
    },
  );
  const res = await post(h.proxy.port, EXPLICIT);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '{"ok":true}');
});

test("the proxy can be asked for a fixed port, so a running session survives a daemon restart", async (t) => {
  const free = await freePort();
  const h = await withProxy(t, (req, res) => res.end("{}"), { port: free });
  assert.equal(h.proxy.port, free);
});

test("a fixed port that is taken falls back to any free one instead of failing to start", async (t) => {
  const squatter = http.createServer();
  await new Promise((r) => squatter.listen(0, "127.0.0.1", r));
  t.after(() => squatter.close());
  const taken = squatter.address().port;
  const h = await withProxy(t, (req, res) => res.end("{}"), { port: taken });
  assert.notEqual(h.proxy.port, taken);
  assert.ok(h.proxy.port > 0);
});
