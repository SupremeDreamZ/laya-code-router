import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { costOf, pricesFor } from "../src/pricing.mjs";
import { mergePrefs, defaultPrefs, loadPrefs, savePrefs } from "../src/prefs.mjs";
import { createLedger, createUsageTap } from "../src/usage.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "laya-app-"));
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

// ---- pricing: list prices from platform.claude.com/docs/en/about-claude/pricing ----
test("pricing: 1M tokens of each kind cost the published rate", () => {
  near(costOf({ input: 1e6 }, pricesFor(null, "opus")), 4);
  near(costOf({ output: 1e6 }, pricesFor(null, "opus")), 20);
  near(costOf({ cacheRead: 1e6 }, pricesFor(null, "opus")), 0.2);
  near(costOf({ cacheWrite: 1e6 }, pricesFor(null, "opus")), 5);
  near(costOf({ input: 1e6, output: 1e6 }, pricesFor(null, "haiku")), 1 + 5);
  near(costOf({ input: 1e6, output: 1e6 }, pricesFor(null, "sonnet")), 2 + 10);
});

test("pricing: the 1-hour cache write rate applies to its share of the writes only", () => {
  const p = pricesFor(null, "sonnet");
  near(costOf({ cacheWrite: 1e6, cacheWrite1h: 1e6 }, p), 4);
  near(costOf({ cacheWrite: 1e6, cacheWrite1h: 4e5 }, p), 0.4 * 4 + 0.6 * 2.5);
  near(costOf({ cacheWrite: 1e6, cacheWrite1h: 9e9 }, p), 4, 1e-9); // never more than were written
});

test("pricing: older Opus and Sonnet versions cost what they cost, not the 5.5 rate", () => {
  near(costOf({ input: 1e6 }, pricesFor("claude-opus-5", "opus")), 5);
  near(costOf({ input: 1e6 }, pricesFor("claude-opus-4-8", "opus")), 5);
  near(costOf({ input: 1e6 }, pricesFor("claude-sonnet-4-6", "sonnet")), 3);
  near(costOf({ input: 1e6 }, pricesFor("claude-opus-5-5", "opus")), 4);
});

test("pricing: an unknown tier costs nothing rather than a made-up number", () => {
  assert.equal(costOf({ input: 1e6 }, pricesFor("mystery", "nope")), 0);
});

// ---- prefs ----
test("prefs: defaults are the documented ones", () => {
  const d = defaultPrefs();
  assert.equal(d.enabled, true);
  assert.equal(d.preset, "balanced");
  assert.deepEqual(d.tiers, { haiku: true, sonnet: true, opus: true, fable: false });
  assert.equal(d.effortAuto, true);
});

test("prefs: a valid partial patch changes only what it names", () => {
  const out = mergePrefs(defaultPrefs(), { preset: "savings", tiers: { haiku: false } });
  assert.equal(out.preset, "savings");
  assert.deepEqual(out.tiers, { haiku: false, sonnet: true, opus: true, fable: false });
  assert.equal(out.enabled, true);
});

test("prefs: invalid values are dropped, valid siblings survive", () => {
  const out = mergePrefs(defaultPrefs(), { preset: "yolo", enabled: "yes", effortAuto: false, nonsense: 1 });
  assert.equal(out.preset, "balanced");
  assert.equal(out.enabled, true);
  assert.equal(out.effortAuto, false);
  assert.equal("nonsense" in out, false);
});

test("prefs: the router must always keep sonnet or opus on", () => {
  const out = mergePrefs(defaultPrefs(), { tiers: { sonnet: false, opus: false } });
  assert.deepEqual(out.tiers, { haiku: true, sonnet: true, opus: true, fable: false });
  const ok = mergePrefs(defaultPrefs(), { tiers: { sonnet: false } });
  assert.equal(ok.tiers.sonnet, false);
});

test("prefs: launch directory must be an absolute path without control characters", () => {
  assert.equal(mergePrefs(defaultPrefs(), { launch: { dir: "/Users/me/proj" } }).launch.dir, "/Users/me/proj");
  assert.equal(mergePrefs(defaultPrefs(), { launch: { dir: "relative/x" } }).launch.dir, null);
  assert.equal(mergePrefs(defaultPrefs(), { launch: { dir: "/tmp/a\nb" } }).launch.dir, null);
  assert.equal(mergePrefs(defaultPrefs(), { launch: { engine: "rm -rf" } }).launch.engine, "claude");
  assert.equal(mergePrefs(defaultPrefs(), { launch: { terminal: "iTerm; rm" } }).launch.terminal, "terminal");
});

test("prefs: a corrupt or missing file loads the defaults", () => {
  const dir = tmp();
  assert.deepEqual(loadPrefs(join(dir, "none.json")), defaultPrefs());
  writeFileSync(join(dir, "bad.json"), "{not json");
  assert.deepEqual(loadPrefs(join(dir, "bad.json")), defaultPrefs());
});

test("prefs: saved privately and read back identically", () => {
  const file = join(tmp(), "sub", "prefs.json");
  const p = mergePrefs(defaultPrefs(), { preset: "careful", showPrompts: false });
  savePrefs(p, file);
  assert.deepEqual(loadPrefs(file), p);
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

// ---- usage tap: reads the tokens the API reports ----
const sse = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");

test("usage tap: reads input from message_start and the final output from message_delta", () => {
  let got;
  const tap = createUsageTap((x) => (got = x));
  tap.push(sse([
    { type: "message_start", message: { model: "claude-sonnet-5-5", usage: { input_tokens: 12, cache_creation_input_tokens: 3000, cache_read_input_tokens: 40000, output_tokens: 1 } } },
    { type: "content_block_delta", delta: { text: "hi" } },
    { type: "message_delta", usage: { output_tokens: 250 } },
  ]), "text/event-stream");
  tap.end();
  assert.equal(got.model, "claude-sonnet-5-5");
  assert.deepEqual(got.usage, { input: 12, cacheWrite: 3000, cacheRead: 40000, cacheWrite1h: 0, output: 250 });
});

test("usage tap: a line split across chunks is still read", () => {
  let got;
  const tap = createUsageTap((x) => (got = x));
  const text = sse([
    { type: "message_start", message: { model: "m", usage: { input_tokens: 5, output_tokens: 1 } } },
    { type: "message_delta", usage: { output_tokens: 9 } },
  ]);
  for (let i = 0; i < text.length; i += 7) tap.push(Buffer.from(text.slice(i, i + 7)), "text/event-stream");
  tap.end();
  assert.equal(got.usage.input, 5);
  assert.equal(got.usage.output, 9);
});

test("usage tap: a non-streaming JSON response is read too", () => {
  let got;
  const tap = createUsageTap((x) => (got = x));
  tap.push(JSON.stringify({ model: "claude-haiku-4-5-20251001", usage: { input_tokens: 7, output_tokens: 3, cache_creation: { ephemeral_1h_input_tokens: 2 }, cache_creation_input_tokens: 2 } }), "application/json");
  tap.end();
  assert.equal(got.model, "claude-haiku-4-5-20251001");
  assert.equal(got.usage.output, 3);
  assert.equal(got.usage.cacheWrite1h, 2);
});

test("usage tap: a response with no usage reports nothing", () => {
  let called = false;
  const tap = createUsageTap(() => (called = true));
  tap.push(sse([{ type: "ping" }]), "text/event-stream");
  tap.end();
  assert.equal(called, false);
});

// ---- ledger ----
const usage = (o = {}) => ({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0, ...o });

test("ledger: cost is what was used; baseline is the same tokens on the baseline model", () => {
  const l = createLedger({ file: join(tmp(), "u.json"), baselineTier: () => "opus" });
  l.record({ tier: "haiku", model: "claude-haiku-4-5-20251001", usage: usage({ input: 1e6 }) });
  const s = l.snapshot();
  near(s.today.cost, 1);
  near(s.today.baseline, 4);
  assert.equal(s.today.n, 1);
  assert.equal(s.today.byTier.haiku.n, 1);
});

test("ledger: a turn the router did not choose has no savings, and baseline never drops below cost", () => {
  const l = createLedger({ file: join(tmp(), "u.json"), baselineTier: () => "sonnet" });
  l.record({ tier: "opus", model: "claude-opus-5-5", usage: usage({ input: 1e6 }), routed: false });
  near(l.snapshot().today.cost, 4);
  near(l.snapshot().today.baseline, 4);
  // baseline set BELOW the routed tier's own cost must not produce negative savings
  l.record({ tier: "opus", model: "claude-opus-5-5", usage: usage({ input: 1e6 }), routed: true });
  assert.ok(l.snapshot().today.baseline >= l.snapshot().today.cost);
});

test("ledger: the week series is oldest first with empty days filled in", () => {
  let t = Date.parse("2026-09-30T12:00:00");
  const l = createLedger({ file: join(tmp(), "u.json"), now: () => t });
  l.record({ tier: "sonnet", model: "claude-sonnet-5-5", usage: usage({ input: 1e6 }) });
  t += 86400000;
  l.record({ tier: "sonnet", model: "claude-sonnet-5-5", usage: usage({ input: 1e6 }) });
  const s = l.snapshot(3);
  assert.equal(s.series.length, 3);
  assert.equal(s.series[0].n, 0);
  assert.equal(s.series[1].n, 1);
  assert.equal(s.series[2].n, 1);
  assert.ok(s.series[0].date < s.series[2].date);
});

test("ledger: totals survive a restart and stay private to the owner", () => {
  const file = join(tmp(), "u.json");
  const a = createLedger({ file });
  a.record({ tier: "haiku", model: "claude-haiku-4-5-20251001", usage: usage({ input: 1e6 }) });
  a.flush();
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const b = createLedger({ file });
  near(b.snapshot().all.cost, 1);
  b.reset();
  assert.equal(createLedger({ file }).snapshot().all.n, 0);
});

test("ledger: only the last 120 days are kept", () => {
  let t = Date.parse("2026-01-01T12:00:00");
  const l = createLedger({ file: join(tmp(), "u.json"), now: () => t });
  for (let i = 0; i < 130; i++) {
    l.record({ tier: "haiku", model: "m", usage: usage({ input: 1 }) });
    t += 86400000;
  }
  assert.equal(l.snapshot().all.n, 120);
});

test("ledger: trimmed tokens add up per day and start at zero", () => {
  const l = createLedger({ file: join(tmp(), "u.json"), baselineTier: () => "opus" });
  assert.equal(l.snapshot().today.trimmed, 0);
  l.record({ tier: "sonnet", model: "claude-sonnet-5-5", usage: usage({ cacheRead: 1 }), cleared: { tokens: 1000, toolUses: 2 } });
  l.record({ tier: "sonnet", model: "claude-sonnet-5-5", usage: usage({ cacheRead: 1 }), cleared: { tokens: 500, toolUses: 1 } });
  l.record({ tier: "sonnet", model: "claude-sonnet-5-5", usage: usage({ cacheRead: 1 }) });
  assert.equal(l.snapshot().today.trimmed, 1500);
});
