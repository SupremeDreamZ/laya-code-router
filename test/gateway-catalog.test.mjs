import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { claudeModels, startProxy } from "../src/proxy.mjs";

// Measured 2026-09-30 against OpenRouter with the real claude 2.1.285 request replayed and one
// header dropped at a time: the User-Agent Claude Code sends makes GET /v1/models return a
// curated 10-entry catalog with NO Haiku and NO Sonnet (dropping only that header returns all
// 431 entries). The proxy forwards that request, so behind a gateway it sees only Opus and
// Fable; Fable is off by default, leaving one tier, and every decision steps up to Opus.
const CURATED = [
  { id: "anthropic/claude-fable-5.1[1m]" },
  { id: "anthropic/claude-opus-5.5[1m]" },
  { id: "anthropic/openai/gpt-6.1-sol[1m]" },
  { id: "anthropic/claude-fable-5[1m]" },
];

test("gateway mode fills tiers the catalog does not list with the static tier ids", () => {
  const models = claudeModels(CURATED, { fillMissingTiers: true });
  const byTier = (t) => models.filter((m) => m.tier === t).map((m) => m.id);
  assert.deepEqual(byTier("haiku"), ["claude-haiku-4-5-20251001"]);
  assert.deepEqual(byTier("sonnet"), ["claude-sonnet-5-5"]);
  assert.deepEqual(byTier("opus"), ["anthropic/claude-opus-5.5[1m]"], "a tier the catalog has is not duplicated");
});

test("without gateway mode a tier missing from the catalog stays missing", () => {
  const tiers = new Set(claudeModels(CURATED).map((m) => m.tier));
  assert.equal(tiers.has("haiku"), false);
  assert.equal(tiers.has("sonnet"), false);
});

test("filling never adds a tier the catalog already covers", () => {
  const full = [
    { id: "anthropic/claude-haiku-4.5" },
    { id: "anthropic/claude-sonnet-5.5" },
    { id: "anthropic/claude-opus-5.5" },
    { id: "anthropic/claude-fable-5.1" },
  ];
  assert.equal(claudeModels(full, { fillMissingTiers: true }).length, full.length);
});

test("behind a gateway whose catalog omits Sonnet, an ordinary turn is routed to Sonnet", async () => {
  const seen = [];
  const stub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.method === "GET" && req.url.startsWith("/v1/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ data: CURATED }));
      }
      try { seen.push(JSON.parse(body).model); } catch {}
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"id":"m","type":"message","role":"assistant","model":"x","content":[],"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}');
    });
  });
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  const previous = process.env.LAYA_CLAUDE_UPSTREAM;
  process.env.LAYA_CLAUDE_UPSTREAM = `http://127.0.0.1:${stub.address().port}`;
  // A rubric mean of 0.5 is the ordinary band: above weakFloor, below strongFloor.
  const route = async () => ({
    metrics: { taskComplexity: 0.5, reasoningRequired: 0.5, toolComplexity: 0.5 },
    confidence: 0.5,
    ms: 1,
    request: {},
    response: {},
  });
  const { port, close } = await startProxy({ route });
  try {
    const H = { "content-type": "application/json", authorization: "Bearer x", "anthropic-version": "2023-06-01" };
    await (await fetch(`http://127.0.0.1:${port}/v1/models`, { headers: H })).text();
    await (
      await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST",
        headers: H,
        body: JSON.stringify({
          model: "laya-router",
          max_tokens: 8,
          messages: [{ role: "user", content: "fix the failing test" }],
          tools: [{ name: "Bash", description: "x", input_schema: { type: "object", properties: {} } }],
          metadata: { user_id: JSON.stringify({ session_id: "gw-1" }) },
        }),
      })
    ).text();
    assert.deepEqual(seen, ["claude-sonnet-5-5"]);
  } finally {
    close();
    stub.close();
    if (previous === undefined) delete process.env.LAYA_CLAUDE_UPSTREAM;
    else process.env.LAYA_CLAUDE_UPSTREAM = previous;
  }
});
