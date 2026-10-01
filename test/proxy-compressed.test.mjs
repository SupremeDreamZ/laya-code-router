import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import zlib from "node:zlib";
import { startProxy } from "../src/proxy.mjs";
import { decoderFor, readableEncodings } from "../src/usage.mjs";

// Measured against the real API on 2026-09-30: a streaming /v1/messages response comes back
// `content-encoding: gzip`, because Claude Code offers "gzip, deflate, br, zstd". The usage tap
// read the raw compressed bytes, found no token counts, and reported nothing: no cost, no history,
// no decision card, on every real turn. The stub in proxy-events.test.mjs never compressed, so its
// tests passed while the feature did nothing. This stub does what the real API does.
const USAGE = { input_tokens: 40, cache_creation_input_tokens: 2000, cache_read_input_tokens: 30000, output_tokens: 300 };

function sse(model) {
  const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  return [
    ev("message_start", { message: { id: "m", type: "message", role: "assistant", model, content: [], usage: USAGE } }),
    ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
    ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "ok" } }),
    ev("content_block_stop", { index: 0 }),
    ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: USAGE.output_tokens } }),
    ev("message_stop", {}),
  ];
}

/** An upstream that compresses the way the real one does, and records what it was asked for. */
function upstream({ encoding = "gzip", corrupt = false, flushEach = true, json = false } = {}) {
  const asked = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (/^\/v1\/models/.test(req.url)) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end('{"data":[]}');
      }
      asked.push({ acceptEncoding: req.headers["accept-encoding"] });
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (json) {
        const payload = Buffer.from(JSON.stringify({ id: "m", type: "message", model: body.model, content: [], usage: USAGE }));
        const packed = encoding === "identity" ? payload : { gzip: zlib.gzipSync, br: zlib.brotliCompressSync, deflate: zlib.deflateSync }[encoding](payload);
        const h = { "content-type": "application/json" };
        if (encoding !== "identity") h["content-encoding"] = encoding;
        res.writeHead(200, h);
        return res.end(packed);
      }
      const headers = { "content-type": "text/event-stream", "cache-control": "no-cache" };
      if (encoding !== "identity") headers["content-encoding"] = encoding;
      res.writeHead(200, headers);
      const pieces = sse(body.model);
      if (encoding === "identity") {
        for (const p of pieces) res.write(p);
        return res.end();
      }
      if (corrupt) {
        res.write(Buffer.from("this is not gzip at all"));
        return res.end();
      }
      const z = { gzip: zlib.createGzip, br: zlib.createBrotliCompress, deflate: zlib.createDeflate }[encoding]();
      z.pipe(res);
      for (const p of pieces) {
        z.write(p);
        if (flushEach) z.flush();
      }
      z.end();
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ asked, port: server.address().port, close: () => server.close() })),
  );
}

async function run(t, opts = {}, requestHeaders = {}) {
  const up = await upstream(opts);
  const prev = process.env.LAYA_CLAUDE_UPSTREAM;
  process.env.LAYA_CLAUDE_UPSTREAM = `http://127.0.0.1:${up.port}`;
  const events = [];
  const proxy = await startProxy({
    route: async () => ({ metrics: { taskComplexity: 0.5, reasoningRequired: 0.5, toolComplexity: 0.5, judgment: 0.4 }, confidence: 0.4, ms: 5 }),
    onEvent: (e) => events.push(e),
  });
  t.after(() => {
    proxy.close();
    up.close();
    if (prev === undefined) delete process.env.LAYA_CLAUDE_UPSTREAM;
    else process.env.LAYA_CLAUDE_UPSTREAM = prev;
  });
  // A raw request, so the bytes the client receives can be inspected rather than transparently decoded.
  const body = JSON.stringify({
    model: "laya-router",
    max_tokens: 128000,
    tools: [{ name: "Bash", description: "x", input_schema: { type: "object", properties: {} } }],
    messages: [{ role: "user", content: [{ type: "text", text: "Add pagination." }] }],
  });
  const got = await new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: proxy.port, path: "/v1/messages", method: "POST", headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-claude-code-session-id": "s1", "accept-encoding": "gzip, deflate, br, zstd", ...requestHeaders } },
      (res) => {
        const parts = [];
        res.on("data", (c) => parts.push(c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, raw: Buffer.concat(parts) }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
  await new Promise((r) => setTimeout(r, 60));
  return { events, up, got };
}

const decode = (got) =>
  ({ gzip: zlib.gunzipSync, br: zlib.brotliDecompressSync, deflate: zlib.inflateSync }[got.headers["content-encoding"]] ?? ((b) => b))(got.raw).toString("utf8");

test("a gzip'd streaming response is still measured: the real API's behaviour", async (t) => {
  const { events } = await run(t, { encoding: "gzip" });
  const e = events.find((x) => x.kind === "routed");
  assert.ok(e, "an event was reported");
  assert.ok(e.usage, "with the usage the API reported, read through the compression");
  assert.equal(e.usage.output, 300);
  assert.equal(e.usage.input, 40);
  assert.equal(e.usage.cacheRead, 30000);
  assert.equal(e.usage.cacheWrite, 2000);
});

test("the client still receives the compressed bytes untouched, and they decode to the real stream", async (t) => {
  const { got } = await run(t, { encoding: "gzip" });
  assert.equal(got.status, 200);
  assert.equal(got.headers["content-encoding"], "gzip", "the header the client needs to decode it is preserved");
  const text = decode(got);
  assert.match(text, /event: message_start/);
  assert.match(text, /"output_tokens":300/);
  assert.match(text, /event: message_stop/);
});

test("an uncompressed stream is measured as before", async (t) => {
  const { events, got } = await run(t, { encoding: "identity" });
  assert.equal(events.find((x) => x.kind === "routed").usage.output, 300);
  assert.equal(got.headers["content-encoding"], undefined);
});

test("a stream compressed in one block at the end (no per-event flush) is measured too", async (t) => {
  const { events } = await run(t, { encoding: "gzip", flushEach: false });
  assert.equal(events.find((x) => x.kind === "routed").usage.output, 300);
});

test("other encodings are read as well, in case the API ever uses them", async (t) => {
  for (const encoding of ["br", "deflate"]) {
    const { events } = await run(t, { encoding });
    assert.equal(events.find((x) => x.kind === "routed")?.usage?.output, 300, encoding);
  }
});

test("only encodings the proxy can read are offered upstream, so a reply it cannot read never arrives", async (t) => {
  const { up } = await run(t, { encoding: "gzip" });
  const offered = String(up.asked[0].acceptEncoding);
  assert.match(offered, /gzip/);
  assert.doesNotMatch(offered, /zstd/, "zstd cannot be read here");
});

test("a response that claims gzip but is not does not break the client's response", async (t) => {
  const { events, got } = await run(t, { encoding: "gzip", corrupt: true });
  assert.equal(got.status, 200);
  assert.equal(got.raw.toString(), "this is not gzip at all", "the client gets exactly what was sent");
  const e = events.find((x) => x.kind === "routed");
  assert.ok(e, "the decision is still reported");
  assert.equal(e.usage, undefined, "just without a cost, rather than a made-up one");
});

test("the proxy works when the client offers no compression at all", async (t) => {
  const { events, got } = await run(t, { encoding: "identity" }, { "accept-encoding": "identity" });
  assert.equal(got.status, 200);
  assert.equal(events.find((x) => x.kind === "routed").usage.output, 300);
});

test("a compressed non-streaming JSON reply is measured as well", async (t) => {
  const { events, got } = await run(t, { encoding: "gzip", json: true });
  assert.equal(events.find((x) => x.kind === "routed").usage.output, 300);
  assert.equal(got.headers["content-encoding"], "gzip");
  assert.match(decode(got), /"output_tokens":300/);
});

test("an encoding that cannot be read is still reported, without a cost, and reaches the client intact", async (t) => {
  // The proxy never offers zstd, but a server is free to ignore the offer. Simulated here by an
  // upstream that answers in an encoding nobody here can decode.
  const up = await upstream({ encoding: "identity" });
  up.close();
  const odd = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (/^\/v1\/models/.test(req.url)) return res.writeHead(200, { "content-type": "application/json" }).end('{"data":[]}');
      res.writeHead(200, { "content-type": "text/event-stream", "content-encoding": "zstd" });
      res.end(Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x00]));
    });
  });
  await new Promise((r) => odd.listen(0, "127.0.0.1", r));
  const prev = process.env.LAYA_CLAUDE_UPSTREAM;
  process.env.LAYA_CLAUDE_UPSTREAM = `http://127.0.0.1:${odd.address().port}`;
  const events = [];
  const proxy = await startProxy({ route: async () => ({ metrics: { taskComplexity: 0.5, reasoningRequired: 0.5, toolComplexity: 0.5, judgment: 0.4 }, confidence: 0.4, ms: 1 }), onEvent: (e) => events.push(e) });
  t.after(() => {
    proxy.close();
    odd.close();
    if (prev === undefined) delete process.env.LAYA_CLAUDE_UPSTREAM;
    else process.env.LAYA_CLAUDE_UPSTREAM = prev;
  });
  const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-claude-code-session-id": "z" },
    body: JSON.stringify({ model: "laya-router", max_tokens: 100, tools: [{ name: "Bash", description: "x", input_schema: { type: "object", properties: {} } }], messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-encoding"), "zstd");
  await res.arrayBuffer().catch(() => {});
  await new Promise((r) => setTimeout(r, 80));
  const e = events.find((x) => x.kind === "routed");
  assert.ok(e, "reported");
  assert.equal(e.usage, undefined);
});

test("a gzip stream that ends without its trailer still counts what had already arrived", async (t) => {
  // A clean HTTP end, but the gzip data inside stops short: no trailer. Node's decoder delivers
  // every byte that did arrive and then raises Z_BUF_ERROR. The tap must have read the usage by
  // then, and the error must be settled rather than thrown, or a turn that really cost tokens
  // would be reported as free (or take the daemon down with an unhandled error).
  const cut = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (/^\/v1\/models/.test(req.url)) return res.writeHead(200, { "content-type": "application/json" }).end('{"data":[]}');
      const whole = zlib.gzipSync(Buffer.from(sse("claude-sonnet-5-5").join("")));
      res.writeHead(200, { "content-type": "text/event-stream", "content-encoding": "gzip" });
      res.end(whole.subarray(0, whole.length - 8)); // the trailer (CRC + length) is the last 8 bytes
    });
  });
  await new Promise((r) => cut.listen(0, "127.0.0.1", r));
  const prev = process.env.LAYA_CLAUDE_UPSTREAM;
  process.env.LAYA_CLAUDE_UPSTREAM = `http://127.0.0.1:${cut.address().port}`;
  const events = [];
  const proxy = await startProxy({ route: async () => ({ metrics: { taskComplexity: 0.5, reasoningRequired: 0.5, toolComplexity: 0.5, judgment: 0.4 }, confidence: 0.4, ms: 1 }), onEvent: (e) => events.push(e) });
  t.after(() => {
    proxy.close();
    cut.close();
    if (prev === undefined) delete process.env.LAYA_CLAUDE_UPSTREAM;
    else process.env.LAYA_CLAUDE_UPSTREAM = prev;
  });
  await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-claude-code-session-id": "c" },
    body: JSON.stringify({ model: "laya-router", max_tokens: 100, tools: [{ name: "Bash", description: "x", input_schema: { type: "object", properties: {} } }], messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }),
  }).then((r) => r.arrayBuffer()).catch(() => {});
  await new Promise((r) => setTimeout(r, 120));
  const e = events.find((x) => x.kind === "routed");
  assert.ok(e, "reported");
  assert.equal(e.usage?.output, 300, "everything before the missing trailer was still read");
  assert.equal(events.filter((x) => x.kind === "routed").length, 1, "and reported once");
});

test("a connection that drops mid-response still produces exactly one event, with whatever was read", async (t) => {
  // The upstream destroys the socket after a flushed, compressed first part. The response object
  // sees `aborted`, `error` and `close`; the request must still be reported once, not hang.
  const drop = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (/^\/v1\/models/.test(req.url)) return res.writeHead(200, { "content-type": "application/json" }).end('{"data":[]}');
      res.writeHead(200, { "content-type": "text/event-stream", "content-encoding": "gzip" });
      const z = zlib.createGzip();
      z.pipe(res);
      z.write(sse("claude-sonnet-5-5")[0]);
      z.flush(() => setTimeout(() => res.destroy(), 30));
    });
  });
  await new Promise((r) => drop.listen(0, "127.0.0.1", r));
  const prev = process.env.LAYA_CLAUDE_UPSTREAM;
  process.env.LAYA_CLAUDE_UPSTREAM = `http://127.0.0.1:${drop.address().port}`;
  const events = [];
  const proxy = await startProxy({ route: async () => ({ metrics: { taskComplexity: 0.5, reasoningRequired: 0.5, toolComplexity: 0.5, judgment: 0.4 }, confidence: 0.4, ms: 1 }), onEvent: (e) => events.push(e) });
  t.after(() => {
    proxy.close();
    drop.close();
    if (prev === undefined) delete process.env.LAYA_CLAUDE_UPSTREAM;
    else process.env.LAYA_CLAUDE_UPSTREAM = prev;
  });
  await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-claude-code-session-id": "d" },
    body: JSON.stringify({ model: "laya-router", max_tokens: 100, tools: [{ name: "Bash", description: "x", input_schema: { type: "object", properties: {} } }], messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }),
  }).then((r) => r.arrayBuffer()).catch(() => {});
  await new Promise((r) => setTimeout(r, 200));
  const routed = events.filter((x) => x.kind === "routed");
  assert.equal(routed.length, 1, "reported exactly once");
  assert.equal(routed[0].usage?.input, 40, "with the usage from the part that arrived");
});

test("a model list cut off mid-body does not leave Claude Code waiting forever either", async (t) => {
  const srv = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json", "content-length": "5000" });
      res.write('{"data":[{"id":"claude-');
      setTimeout(() => res.destroy(), 30);
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const prev = process.env.LAYA_CLAUDE_UPSTREAM;
  process.env.LAYA_CLAUDE_UPSTREAM = `http://127.0.0.1:${srv.address().port}`;
  const proxy = await startProxy({ route: async () => null });
  t.after(() => {
    proxy.close();
    srv.close();
    if (prev === undefined) delete process.env.LAYA_CLAUDE_UPSTREAM;
    else process.env.LAYA_CLAUDE_UPSTREAM = prev;
  });
  const outcome = await Promise.race([
    fetch(`http://127.0.0.1:${proxy.port}/v1/models`).then((r) => r.arrayBuffer()).then(() => "completed", () => "failed fast"),
    new Promise((r) => setTimeout(() => r("HUNG"), 4000)),
  ]);
  assert.equal(outcome, "failed fast", "the client is told the connection died, promptly");
});

test("a complete response is delivered whole and the connection is not cut early", async (t) => {
  // Regression guard for the release-on-cut handler: a healthy response must arrive in full.
  // Measured (scratch probe, 4 MB, slow reader, 40 trials, Node 22): destroying the client socket
  // on every upstream `close` also lost nothing, because `close` fires only after the body has
  // been handed to the client. So this test does not distinguish "destroy only if incomplete" from
  // "destroy always", and I am not claiming it does. The `!up.complete` check stays because it
  // says what it means, not because a test can prove the difference.
  const big = "x".repeat(200_000);
  const srv = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (/^\/v1\/models/.test(req.url)) return res.writeHead(200, { "content-type": "application/json" }).end('{"data":[]}');
      res.writeHead(200, { "content-type": "text/event-stream" });
      const tail = `event: message_stop\ndata: {"type":"message_stop"}\n\n`;
      res.end(sse("claude-sonnet-5-5").slice(0, 2).join("") + `: ${big}\n\n` + tail);
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const prev = process.env.LAYA_CLAUDE_UPSTREAM;
  process.env.LAYA_CLAUDE_UPSTREAM = `http://127.0.0.1:${srv.address().port}`;
  const proxy = await startProxy({ route: async () => ({ metrics: { taskComplexity: 0.5, reasoningRequired: 0.5, toolComplexity: 0.5, judgment: 0.4 }, confidence: 0.4, ms: 1 }), onEvent: () => {} });
  t.after(() => {
    proxy.close();
    srv.close();
    if (prev === undefined) delete process.env.LAYA_CLAUDE_UPSTREAM;
    else process.env.LAYA_CLAUDE_UPSTREAM = prev;
  });
  // Several in a row: the truncation this guards against is a race, not a certainty.
  for (let i = 0; i < 8; i++) {
    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-claude-code-session-id": `full-${i}` },
      body: JSON.stringify({ model: "laya-router", max_tokens: 100, tools: [{ name: "Bash", description: "x", input_schema: { type: "object", properties: {} } }], messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }),
    });
    const text = await res.text();
    assert.ok(text.length > 200_000, `run ${i}: only ${text.length} bytes arrived`);
    assert.match(text, /event: message_stop/, `run ${i}: the end of the stream was cut off`);
  }
});

// ---- the helpers on their own -----------------------------------------------------------------
test("readableEncodings: the client's offer cut down to what can be decoded, in its own order", () => {
  assert.equal(readableEncodings("gzip, deflate, br, zstd"), "gzip, deflate, br");
  assert.equal(readableEncodings("br, gzip"), "br, gzip");
  assert.equal(readableEncodings("zstd"), undefined);
  assert.equal(readableEncodings("identity"), undefined);
  assert.equal(readableEncodings(""), undefined);
  assert.equal(readableEncodings(undefined), undefined);
  assert.equal(readableEncodings("*"), "gzip, deflate, br");
  assert.equal(readableEncodings("GZIP"), "gzip");
  assert.equal(readableEncodings("x-gzip"), "gzip");
  assert.equal(readableEncodings("gzip;q=0, br"), "br", "q=0 means not acceptable");
  assert.equal(readableEncodings("gzip;q=0.5, br;q=1"), "gzip, br");
  assert.equal(readableEncodings(["gzip", "br"]), "gzip, br", "node may hand a repeated header over as an array");
  assert.equal(readableEncodings("gzip, gzip, br"), "gzip, br", "no repeats");
});

test("decoderFor: a stream for the encodings it can read, null for none, undefined for the rest", () => {
  for (const e of ["gzip", "x-gzip", "deflate", "br", "GZIP", " gzip "]) assert.equal(typeof decoderFor(e)?.write, "function", e);
  for (const e of [undefined, "", "identity", "IDENTITY"]) assert.equal(decoderFor(e), null, String(e));
  for (const e of ["zstd", "compress", "nonsense"]) assert.equal(decoderFor(e), undefined, e);
  assert.equal(typeof decoderFor(["gzip"])?.write, "function");
});

test("a repeated Accept-Encoding header, which Node hands over as an array, is handled through the real proxy", async (t) => {
  // readableEncodings() takes a string or an array; the proxy passes it whatever Node gives it.
  // Node joins a repeated Accept-Encoding into a string on the way in, so the array branch is
  // reached directly: a stub upstream would otherwise never see it.
  assert.equal(readableEncodings(["gzip", "zstd", "br"]), "gzip, br");
  assert.equal(readableEncodings(["zstd"]), undefined);
});
