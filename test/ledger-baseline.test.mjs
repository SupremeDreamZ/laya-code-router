import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLedger } from "../src/usage.mjs";
import { costOf, pricesFor } from "../src/pricing.mjs";

// "What savings are measured against" is a setting, and a setting that only applies to turns
// recorded after it was changed is a lie on the card: the label says "against Opus" over a figure
// that was priced against Fable (measured on 2026-09-30: flipping Fable to Opus left today's saved
// figure at $0.11 when the same tokens priced against Opus are $0.04). The ledger therefore keeps
// each turn's baseline under every candidate, and the setting chooses which one is shown.
const DAY = Date.UTC(2026, 8, 30, 12, 0, 0);
const USAGE = { input: 5807, cacheWrite: 0, cacheRead: 7872, output: 32 };
const fileIn = () => join(mkdtempSync(join(tmpdir(), "laya-ledger-")), "usage.json");

function ledger(opts = {}) {
  const state = { baseline: opts.baseline ?? "opus", t: opts.now ?? DAY };
  const l = createLedger({ file: opts.file ?? fileIn(), now: () => state.t, baselineTier: () => state.baseline });
  return { l, state };
}

const priced = (tier) => costOf(USAGE, pricesFor(null, tier));

test("changing the baseline re-prices turns that were already recorded", () => {
  const { l, state } = ledger({ baseline: "fable" });
  l.record({ tier: "haiku", model: "claude-haiku-4-5-20251001", usage: USAGE });
  const cost = costOf(USAGE, pricesFor("claude-haiku-4-5-20251001", "haiku"));
  assert.ok(Math.abs(l.snapshot().today.baseline - priced("fable")) < 1e-12, "against Fable");
  state.baseline = "opus";
  assert.ok(Math.abs(l.snapshot().today.baseline - priced("opus")) < 1e-12, "against Opus, same turn");
  state.baseline = "sonnet";
  assert.ok(Math.abs(l.snapshot().today.baseline - priced("sonnet")) < 1e-12, "against Sonnet, same turn");
  assert.ok(Math.abs(l.snapshot().today.cost - cost) < 1e-12, "what it actually cost never moves");
  assert.ok(priced("fable") > priced("opus") && priced("opus") > priced("sonnet"), "the three baselines really differ");
});

test("the series and the all-time total follow the baseline too", () => {
  const { l, state } = ledger({ baseline: "fable" });
  l.record({ tier: "haiku", model: "claude-haiku-4-5-20251001", usage: USAGE });
  state.t = DAY + 86400000;
  l.record({ tier: "haiku", model: "claude-haiku-4-5-20251001", usage: USAGE });
  state.baseline = "opus";
  const s = l.snapshot(2);
  assert.ok(Math.abs(s.series[0].baseline - priced("opus")) < 1e-12);
  assert.ok(Math.abs(s.series[1].baseline - priced("opus")) < 1e-12);
  assert.ok(Math.abs(s.all.baseline - 2 * priced("opus")) < 1e-12);
});

test("a turn the router did not choose has no savings under any baseline", () => {
  const { l, state } = ledger();
  l.record({ tier: "opus", model: "claude-opus-5-5", usage: USAGE, routed: false });
  const cost = costOf(USAGE, pricesFor("claude-opus-5-5", "opus"));
  for (const b of ["sonnet", "opus", "fable"]) {
    state.baseline = b;
    assert.ok(Math.abs(l.snapshot().today.baseline - cost) < 1e-12, `${b}: baseline equals cost`);
  }
});

test("the baseline is never below the cost, for each baseline separately", () => {
  const { l, state } = ledger();
  // A Fable turn measured against Sonnet would show negative savings; it must show none.
  l.record({ tier: "fable", model: "claude-fable-5-1", usage: USAGE });
  const cost = costOf(USAGE, pricesFor("claude-fable-5-1", "fable"));
  state.baseline = "sonnet";
  assert.ok(Math.abs(l.snapshot().today.baseline - cost) < 1e-12, "clamped up to cost");
  state.baseline = "fable";
  assert.ok(Math.abs(l.snapshot().today.baseline - cost) < 1e-12, "and equal against itself");
  assert.ok(l.snapshot().today.baseline >= l.snapshot().today.cost);
});

test("it survives a restart and can still be switched afterwards", () => {
  const file = fileIn();
  const a = ledger({ file, baseline: "fable" });
  a.l.record({ tier: "haiku", model: "claude-haiku-4-5-20251001", usage: USAGE });
  a.l.flush();
  const b = ledger({ file, baseline: "fable" });
  assert.ok(Math.abs(b.l.snapshot().today.baseline - priced("fable")) < 1e-12);
  b.state.baseline = "opus";
  assert.ok(Math.abs(b.l.snapshot().today.baseline - priced("opus")) < 1e-12, "re-priced after reload");
});

test("a usage file written before this change still loads, at the baseline it was recorded against", () => {
  const file = fileIn();
  writeFileSync(file, JSON.stringify({ days: { "2026-09-30": { n: 2, cost: 0.0135, baseline: 0.1235, byTier: {} } } }));
  const { l, state } = ledger({ file, baseline: "opus" });
  assert.equal(l.snapshot().today.baseline, 0.1235, "old figures are kept as recorded; they cannot be re-priced");
  state.baseline = "sonnet";
  assert.equal(l.snapshot().today.baseline, 0.1235);
});

test("new turns on top of old ones re-price, and the old ones stay put", () => {
  const file = fileIn();
  writeFileSync(file, JSON.stringify({ days: { "2026-09-30": { n: 2, cost: 0.0135, baseline: 0.1235, byTier: {} } } }));
  const { l, state } = ledger({ file, baseline: "opus" });
  l.record({ tier: "haiku", model: "claude-haiku-4-5-20251001", usage: USAGE });
  assert.ok(Math.abs(l.snapshot().today.baseline - (0.1235 + priced("opus"))) < 1e-12);
  state.baseline = "fable";
  assert.ok(Math.abs(l.snapshot().today.baseline - (0.1235 + priced("fable"))) < 1e-12, "only the new turn moved");
  assert.equal(l.snapshot().today.n, 3);
});

test("the per-baseline totals are saved as plain numbers and nothing else", () => {
  const file = fileIn();
  const { l } = ledger({ file });
  l.record({ tier: "haiku", model: "claude-haiku-4-5-20251001", usage: USAGE });
  l.flush();
  const saved = JSON.parse(readFileSync(file, "utf8"));
  const day = saved.days["2026-09-30"];
  assert.deepEqual(Object.keys(day.base).sort(), ["fable", "opus", "sonnet"]);
  for (const v of Object.values(day.base)) assert.equal(typeof v, "number");
});

test("reset clears the per-baseline totals as well", () => {
  const { l } = ledger();
  l.record({ tier: "haiku", model: "claude-haiku-4-5-20251001", usage: USAGE });
  l.reset();
  assert.equal(l.snapshot().today.baseline, 0);
  assert.equal(l.snapshot().all.baseline, 0);
});

test("an unknown baseline name falls back to the default rather than producing NaN", () => {
  const { l, state } = ledger();
  l.record({ tier: "haiku", model: "claude-haiku-4-5-20251001", usage: USAGE });
  state.baseline = "gpt-9";
  const b = l.snapshot().today.baseline;
  assert.ok(Number.isFinite(b) && b > 0, `baseline was ${b}`);
});
