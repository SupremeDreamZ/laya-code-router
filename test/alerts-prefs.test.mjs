import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PREFS, defaultPrefs, mergePrefs } from "../src/prefs.mjs";

test("alert defaults: on, at 75% and 90%, limit and reset notices, both windows, pace off", () => {
  const a = defaultPrefs().alerts;
  assert.equal(a.enabled, true);
  assert.deepEqual(a.thresholds, [75, 90]);
  assert.equal(a.limit, true);
  assert.equal(a.reset, true);
  assert.equal(a.pace, false);
  assert.deepEqual(a.windows, { fiveHour: true, weekly: true });
  assert.equal(defaultPrefs().showUsageInMenuBar, false);
});

test("thresholds: whole percentages from 1 to 99, sorted, no repeats", () => {
  const out = mergePrefs(DEFAULT_PREFS, { alerts: { thresholds: [90, 50, 75, 50] } });
  assert.deepEqual(out.alerts.thresholds, [50, 75, 90]);
});

test("thresholds: bad entries are dropped one by one, the good ones survive", () => {
  const out = mergePrefs(DEFAULT_PREFS, { alerts: { thresholds: [60, 0, 100, 1.5, "80", null, -5, 85] } });
  assert.deepEqual(out.alerts.thresholds, [60, 85]);
});

test("thresholds: a non-list is rejected and the current ones stay", () => {
  for (const bad of ["75", 75, null, { a: 1 }]) {
    assert.deepEqual(mergePrefs(DEFAULT_PREFS, { alerts: { thresholds: bad } }).alerts.thresholds, [75, 90]);
  }
});

test("thresholds: at most six, and an empty list is allowed (limit and reset notices only)", () => {
  assert.equal(mergePrefs(DEFAULT_PREFS, { alerts: { thresholds: [10, 20, 30, 40, 50, 60, 70, 80] } }).alerts.thresholds.length, 6);
  assert.deepEqual(mergePrefs(DEFAULT_PREFS, { alerts: { thresholds: [] } }).alerts.thresholds, []);
});

test("one alert setting changes without touching its siblings", () => {
  const out = mergePrefs(DEFAULT_PREFS, { alerts: { pace: true } });
  assert.equal(out.alerts.pace, true);
  assert.deepEqual(out.alerts.thresholds, [75, 90]);
  assert.equal(out.alerts.limit, true);
  const w = mergePrefs(DEFAULT_PREFS, { alerts: { windows: { weekly: false } } });
  assert.deepEqual(w.alerts.windows, { fiveHour: true, weekly: false });
});

test("only true booleans are accepted for the switches", () => {
  const out = mergePrefs(DEFAULT_PREFS, { alerts: { enabled: "no", limit: 0, reset: null, pace: "yes", windows: { weekly: "x" } } });
  assert.deepEqual(out.alerts, defaultPrefs().alerts);
});

test("the menu-bar figure is a plain boolean at the top level", () => {
  assert.equal(mergePrefs(DEFAULT_PREFS, { showUsageInMenuBar: true }).showUsageInMenuBar, true);
  assert.equal(mergePrefs(DEFAULT_PREFS, { showUsageInMenuBar: "true" }).showUsageInMenuBar, false);
});

test("a prefs file from before alerts existed still loads, with alert defaults filled in", () => {
  const old = { enabled: true, preset: "careful", tiers: { haiku: true, sonnet: true, opus: true, fable: false } };
  const out = mergePrefs(defaultPrefs(), old);
  assert.equal(out.preset, "careful");
  assert.deepEqual(out.alerts, defaultPrefs().alerts);
});

test("Fable can be switched on and off like any model", () => {
  assert.equal(mergePrefs(DEFAULT_PREFS, { tiers: { fable: true } }).tiers.fable, true);
  const on = mergePrefs(DEFAULT_PREFS, { tiers: { fable: true } });
  assert.equal(mergePrefs(on, { tiers: { fable: false } }).tiers.fable, false);
});
