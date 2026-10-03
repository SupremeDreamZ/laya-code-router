import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paceCapActive, saveLimits } from "../src/limits.mjs";
import { decide, decideStep } from "../src/policy.mjs";
import { THRESHOLDS } from "../src/config.mjs";
import { startProxy } from "../src/proxy.mjs";

// Plan-aware pacing. Several workers share one Max plan, and the 5-hour window is the one that
// stops them all at once. Near its limit, with the reset still a while off, a NEW decision that
// would land on Opus gets Sonnet instead. A conversation already on Opus is never moved down by it,
// a tier the user named is never capped, and a missing reading changes nothing.
const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);
const HOUR = 3600_000;
const limitsAt = (utilization, resetInMs, key = "5h") => ({ windows: { [key]: { utilization, resetsAt: NOW + resetInMs, status: "allowed" } } });

test("pacing config: caps at 85% of the 5-hour window, unless it resets within 20 minutes", () => {
  assert.equal(THRESHOLDS.paceCapAt, 0.85);
  assert.equal(THRESHOLDS.paceMinResetMs, 20 * 60_000);
});

test("paceCapActive: only a 5-hour window at or over the cap, with its reset more than 20 minutes away", () => {
  assert.equal(paceCapActive(limitsAt(0.9, 2 * HOUR), NOW), true);
  assert.equal(paceCapActive(limitsAt(0.85, 2 * HOUR), NOW), true, "at the cap counts");
  assert.equal(paceCapActive(limitsAt(0.84, 2 * HOUR), NOW), false);
  assert.equal(paceCapActive(limitsAt(0.95, 10 * 60_000), NOW), false, "about to reset: spend it");
  assert.equal(paceCapActive(limitsAt(0.95, 2 * HOUR, "7d"), NOW), false, "the weekly window does not pace");
  assert.equal(paceCapActive(limitsAt(0.95, -1000), NOW), false, "a window that already reset");
  assert.equal(paceCapActive({ windows: { "5h": { utilization: 0.95, resetsAt: null } } }, NOW), false, "no reset time, no proof");
  assert.equal(paceCapActive(null, NOW), false, "no reading at all");
  assert.equal(paceCapActive({}, NOW), false);
});

const ALL = ["haiku", "sonnet", "opus"];
const at = (score, confidence = 0.5) => ({ metrics: { taskComplexity: score, reasoningRequired: score, toolComplexity: score, judgment: 0.3 }, confidence });
const base = { prompt: "redesign the session store", available: ALL, contextTokens: 0 };

test("decide: a fresh decision that would land on opus gets sonnet", () => {
  const d = decide({ ...base, laya: at(0.6), current: "opus", fresh: true, paceCap: true });
  assert.equal(d.tier, "sonnet");
  assert.match(d.reason, /plan-pace-cap/);
});

test("decide: an upgrade to opus in an ongoing conversation is capped at sonnet", () => {
  const d = decide({ ...base, laya: at(0.6), current: "sonnet", paceCap: true });
  assert.equal(d.tier, "sonnet");
  assert.match(d.reason, /plan-pace-cap/);
});

test("decide: a conversation already on opus is never moved down by pacing", () => {
  assert.equal(decide({ ...base, laya: at(0.6), current: "opus", paceCap: true }).tier, "opus");
  assert.equal(decide({ ...base, laya: null, current: "opus", paceCap: true }).tier, "opus");
});

test("decide: an explicit 'use opus' is never capped", () => {
  const d = decide({ ...base, prompt: "use opus to redesign this", laya: at(0.6), current: "sonnet", paceCap: true });
  assert.equal(d.tier, "opus");
  assert.equal(d.reason, "override");
});

test("decide: with sonnet switched off there is nothing to cap to, so opus stays", () => {
  assert.equal(decide({ ...base, available: ["haiku", "opus"], laya: at(0.6), current: "haiku", paceCap: true }).tier, "opus");
});

test("decide: pacing leaves cheaper decisions alone", () => {
  assert.equal(decide({ ...base, laya: at(0.5), current: "opus", fresh: true, paceCap: true }).reason, "laya");
});

test("decideStep: a step upgrade to opus is capped, and a cap that leaves the tier unchanged is a recorded stay", () => {
  const step = { prompt: "Next step of an ongoing task:\nBash: ls", available: ALL, contextTokens: 1000, step: { input: 0, output: 0 }, paceCap: true };
  const fromHaiku = decideStep({ ...step, laya: at(0.6), current: "haiku" });
  assert.equal(fromHaiku.tier, "sonnet");
  assert.equal(fromHaiku.switched, true);
  assert.equal(fromHaiku.reason, "plan-pace-cap");
  const fromSonnet = decideStep({ ...step, laya: at(0.6), current: "sonnet" });
  assert.equal(fromSonnet.switched, false);
  assert.equal(fromSonnet.reason, "plan-pace-cap");
});

// ---- through the proxy ----

const TOOLS = [{ name: "Bash", description: "x", input_schema: { type: "object", properties: {} } }];
const user = (t) => ({ role: "user", content: [{ type: "text", text: t }] });

async function harness(t, { limits, route = async () => at(0.6) } = {}) {
  const home = mkdtempSync(join(tmpdir(), "laya-pace-"));
  const prev = process.env.LAYA_HOME;
  process.env.LAYA_HOME = home;
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (/^\/v1\/models/.test(req.url)) return res.end('{"data":[]}');
      seen.push(JSON.parse(Buffer.concat(chunks).toString()));
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"id":"m","type":"message","content":[],"usage":{"input_tokens":1,"output_tokens":1}}');
    });
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const events = [];
  const { port, close } = await startProxy({
    upstreamURL: `http://127.0.0.1:${upstream.address().port}`,
    route,
    onEvent: (e) => events.push(e),
    ...(limits ? { limits } : {}),
  });
  t.after(() => {
    close();
    upstream.close();
    if (prev === undefined) delete process.env.LAYA_HOME;
    else process.env.LAYA_HOME = prev;
  });
  const send = async (messages, model = "laya-router") => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-claude-code-request-class": "main" },
      body: JSON.stringify({ model, max_tokens: 1000, tools: TOOLS, messages }),
    });
    await res.text();
    return seen.at(-1).model;
  };
  return { send, events, home };
}

const live = (utilization, resetInMs = 2 * HOUR) => ({ windows: { "5h": { utilization, resetsAt: Date.now() + resetInMs } } });

test("proxy: near the limit, a new opus-shaped turn runs on sonnet and says why", async (t) => {
  const h = await harness(t, { limits: () => live(0.9) });
  assert.equal(await h.send([user("redesign the session store")]), "claude-sonnet-5-5");
  assert.equal(h.events.at(-1).reason, "plan-pace-cap");
});

test("proxy: the limits file is read through limits.mjs, and a missing file changes nothing", async (t) => {
  const h = await harness(t);
  assert.equal(await h.send([user("redesign the session store")]), "claude-opus-5-5", "no file: fail open");
  const h2 = await harness(t);
  saveLimits(live(0.92), join(h2.home, "limits.json"));
  assert.equal(await h2.send([user("redesign the cache layer")]), "claude-sonnet-5-5");
});

test("proxy: a conversation already on opus stays there when the window fills mid-session", async (t) => {
  let reading = live(0.2);
  const h = await harness(t, { limits: () => reading });
  const opening = user("redesign the session store");
  assert.equal(await h.send([opening]), "claude-opus-5-5");
  reading = live(0.95);
  const later = [opening, { role: "assistant", content: [{ type: "text", text: "done" }] }, user("now redesign the cache too")];
  assert.equal(await h.send(later), "claude-opus-5-5", "pacing never downgrades an ongoing conversation");
});

test("proxy: a model the user picked is passed through untouched", async (t) => {
  const h = await harness(t, { limits: () => live(0.95) });
  assert.equal(await h.send([user("redesign it")], "claude-opus-5-5"), "claude-opus-5-5");
});

test("proxy: a limits reader that throws keeps routing working", async (t) => {
  const h = await harness(t, {
    limits: () => {
      throw new Error("disk gone");
    },
  });
  assert.equal(await h.send([user("redesign the session store")]), "claude-opus-5-5");
});
