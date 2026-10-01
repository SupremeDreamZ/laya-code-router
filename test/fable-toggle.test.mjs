import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { availableTiers } from "../src/config.mjs";
import { startProxy } from "../src/proxy.mjs";

// Fable bills differently from the other models on some plans, so it starts off. The app has a
// switch for it, but until now that switch did nothing: the proxy decided from an environment
// variable only, and the Settings list never drew a Fable row at all.
const ALL_ON = { haiku: true, sonnet: true, opus: true, fable: true };
const FABLE_OFF = { ...ALL_ON, fable: false };

const withEnv = (value, fn) => {
  const prev = process.env.LAYA_ALLOW_FABLE;
  if (value === undefined) delete process.env.LAYA_ALLOW_FABLE;
  else process.env.LAYA_ALLOW_FABLE = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.LAYA_ALLOW_FABLE;
    else process.env.LAYA_ALLOW_FABLE = prev;
  }
};

test("with no app running, the environment variable still decides (the CLI behaves as before)", () => {
  assert.equal(withEnv(undefined, () => availableTiers()).includes("fable"), false);
  assert.equal(withEnv("1", () => availableTiers()).includes("fable"), true);
});

test("with the app running, its Fable switch decides: on", () => {
  assert.equal(withEnv(undefined, () => availableTiers(ALL_ON)).includes("fable"), true);
});

test("with the app running, its Fable switch decides: off beats the environment variable", () => {
  assert.equal(withEnv("1", () => availableTiers(FABLE_OFF)).includes("fable"), false);
});

test("the other three models are unaffected by the Fable switch", () => {
  for (const tiers of [undefined, ALL_ON, FABLE_OFF]) {
    const got = withEnv(undefined, () => availableTiers(tiers));
    for (const name of ["haiku", "sonnet", "opus"]) assert.ok(got.includes(name), `${name} with ${JSON.stringify(tiers)}`);
  }
});

// ---- end to end: what model actually goes upstream -----------------------------------------
function stub() {
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
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "message", model: body.model, content: [], usage: { input_tokens: 1, output_tokens: 1 } }));
    });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ seen, port: server.address().port, close: () => server.close() })));
}

async function routeOnce(t, { prefs, prompt }) {
  const up = await stub();
  const home = mkdtempSync(join(tmpdir(), "laya-fable-"));
  if (prefs) {
    // Written the way the daemon writes it: through the validator, so `enabled` and every other
    // field are present. A bare `{ tiers }` reads as "routing is off", which is a different test.
    const { mergePrefs, DEFAULT_PREFS } = await import("../src/prefs.mjs");
    writeFileSync(join(home, "prefs.json"), JSON.stringify(mergePrefs(DEFAULT_PREFS, { tiers: prefs })));
  }
  const prevHome = process.env.LAYA_HOME;
  const prevUp = process.env.LAYA_CLAUDE_UPSTREAM;
  const prevAllow = process.env.LAYA_ALLOW_FABLE;
  process.env.LAYA_HOME = home;
  process.env.LAYA_CLAUDE_UPSTREAM = `http://127.0.0.1:${up.port}`;
  delete process.env.LAYA_ALLOW_FABLE;
  const events = [];
  const proxy = await startProxy({
    route: async () => ({ metrics: { taskComplexity: 0.5, reasoningRequired: 0.5, toolComplexity: 0.5, judgment: 0.4 }, confidence: 0.5, ms: 1 }),
    onEvent: (e) => events.push(e),
  });
  t.after(() => {
    proxy.close();
    up.close();
    for (const [k, v] of [["LAYA_HOME", prevHome], ["LAYA_CLAUDE_UPSTREAM", prevUp], ["LAYA_ALLOW_FABLE", prevAllow]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-claude-code-session-id": `s-${Math.random()}` },
    body: JSON.stringify({
      model: "laya-router",
      max_tokens: 1000,
      tools: [{ name: "Bash", description: "x", input_schema: { type: "object", properties: {} } }],
      messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
    }),
  });
  await res.text();
  return { sent: up.seen[0], events };
}

test("Fable switched on in the app: asking for it by name reaches Fable", async (t) => {
  const { sent, events } = await routeOnce(t, { prefs: ALL_ON, prompt: "use fable for this refactor" });
  assert.equal(sent.model, "claude-fable-5-1");
  assert.equal(events.find((e) => e.kind === "routed").tier, "fable");
});

test("Fable switched off in the app: asking for it lands on Opus, and says why", async (t) => {
  const { sent, events } = await routeOnce(t, { prefs: FABLE_OFF, prompt: "use fable for this refactor" });
  assert.equal(sent.model, "claude-opus-5-5");
  assert.match(events.find((e) => e.kind === "routed").reason, /unavailable/);
});

test("Fable is never picked unasked: an ordinary turn does not reach it even when it is on", async (t) => {
  const { sent } = await routeOnce(t, { prefs: ALL_ON, prompt: "Add a retry to the upload function." });
  assert.notEqual(sent.model, "claude-fable-5-1");
});

// Found while writing the tests above: the proxy reads prefs.json raw, and treated a file that
// lacked `enabled` as "routing is off". The daemon always writes the field, but a hand-edited or
// older file may not, and the safe reading of "no opinion" is the default, which is on.
test("a prefs file with no `enabled` field does not silently turn routing off", async (t) => {
  const up = await stub();
  const home = mkdtempSync(join(tmpdir(), "laya-bare-"));
  writeFileSync(join(home, "prefs.json"), JSON.stringify({ tiers: { haiku: true, sonnet: true, opus: true, fable: false } }));
  const saved = { h: process.env.LAYA_HOME, u: process.env.LAYA_CLAUDE_UPSTREAM };
  process.env.LAYA_HOME = home;
  process.env.LAYA_CLAUDE_UPSTREAM = `http://127.0.0.1:${up.port}`;
  const events = [];
  const proxy = await startProxy({
    route: async () => ({ metrics: { taskComplexity: 0.5, reasoningRequired: 0.5, toolComplexity: 0.5, judgment: 0.4 }, confidence: 0.5, ms: 1 }),
    onEvent: (e) => events.push(e),
  });
  t.after(() => {
    proxy.close();
    up.close();
    for (const [k, v] of [["LAYA_HOME", saved.h], ["LAYA_CLAUDE_UPSTREAM", saved.u]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  await (await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-claude-code-session-id": "bare" },
    body: JSON.stringify({ model: "laya-router", max_tokens: 1000, messages: [{ role: "user", content: [{ type: "text", text: "Add a retry to the upload function." }] }] }),
  })).text();
  const ev = events.find((e) => e.kind === "routed" || e.kind === "paused");
  assert.equal(ev.kind, "routed", `expected a routing decision, got ${ev.kind}: ${ev.reason}`);
});

test("an explicit `enabled: false` still pauses routing", async (t) => {
  const up = await stub();
  const home = mkdtempSync(join(tmpdir(), "laya-off-"));
  writeFileSync(join(home, "prefs.json"), JSON.stringify({ enabled: false, pausedTier: "sonnet", tiers: { haiku: true, sonnet: true, opus: true, fable: false } }));
  const saved = { h: process.env.LAYA_HOME, u: process.env.LAYA_CLAUDE_UPSTREAM };
  process.env.LAYA_HOME = home;
  process.env.LAYA_CLAUDE_UPSTREAM = `http://127.0.0.1:${up.port}`;
  const events = [];
  const proxy = await startProxy({ route: async () => null, onEvent: (e) => events.push(e) });
  t.after(() => {
    proxy.close();
    up.close();
    for (const [k, v] of [["LAYA_HOME", saved.h], ["LAYA_CLAUDE_UPSTREAM", saved.u]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  await (await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-claude-code-session-id": "off" },
    body: JSON.stringify({ model: "laya-router", max_tokens: 1000, messages: [{ role: "user", content: [{ type: "text", text: "anything" }] }] }),
  })).text();
  assert.equal(up.seen[0].model, "claude-sonnet-5-5");
  assert.equal(events.find((e) => e.kind === "paused")?.tier, "sonnet");
});
