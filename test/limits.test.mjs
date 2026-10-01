import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseLimitHeaders,
  mergeLimits,
  activeWindows,
  windowLength,
  projectHit,
  loadLimits,
  saveLimits,
  sameWindow,
} from "../src/limits.mjs";

// Captured from api.anthropic.com /v1/messages on 2026-09-30, Max plan, through a pass-through
// that logged response headers only. Nothing here is hand-written except the two synthetic
// cases at the bottom, which are labelled.
const REAL_HAIKU = {
  "anthropic-ratelimit-unified-5h-reset": "1790814600",
  "anthropic-ratelimit-unified-5h-status": "allowed",
  "anthropic-ratelimit-unified-5h-utilization": "0.01",
  "anthropic-ratelimit-unified-7d-reset": "1790838000",
  "anthropic-ratelimit-unified-7d-status": "allowed",
  "anthropic-ratelimit-unified-7d-utilization": "0.0",
  "anthropic-ratelimit-unified-fallback-percentage": "0.5",
  "anthropic-ratelimit-unified-overage-disabled-reason": "out_of_credits",
  "anthropic-ratelimit-unified-overage-status": "rejected",
  "anthropic-ratelimit-unified-representative-claim": "five_hour",
  "anthropic-ratelimit-unified-reset": "1790814600",
  "anthropic-ratelimit-unified-status": "allowed",
  "content-type": "text/event-stream",
};

// The same account on a Fable request: one extra window appears, named `7d_oi`.
const REAL_FABLE = {
  ...REAL_HAIKU,
  "anthropic-ratelimit-unified-5h-utilization": "0.02",
  "anthropic-ratelimit-unified-7d_oi-reset": "1790838000",
  "anthropic-ratelimit-unified-7d_oi-status": "allowed",
  "anthropic-ratelimit-unified-7d_oi-utilization": "0.0",
};

const H = 3600_000;
const D = 24 * H;

test("parses a real Max-plan response: both windows, status, reset, overage", () => {
  const got = parseLimitHeaders(REAL_HAIKU);
  assert.deepEqual(got.windows, {
    "5h": { utilization: 0.01, resetsAt: 1790814600_000, status: "allowed" },
    "7d": { utilization: 0, resetsAt: 1790838000_000, status: "allowed" },
  });
  assert.equal(got.status, "allowed");
  assert.equal(got.representative, "5h");
  assert.equal(got.resetsAt, 1790814600_000);
  assert.deepEqual(got.overage, { status: "rejected", reason: "out_of_credits" });
  assert.equal(got.fallbackPct, 0.5);
});

test("the Fable-only window is kept, and `overage` is never mistaken for a window", () => {
  const got = parseLimitHeaders(REAL_FABLE);
  assert.deepEqual(Object.keys(got.windows).sort(), ["5h", "7d", "7d_oi"]);
  assert.equal(got.windows["5h"].utilization, 0.02);
  assert.equal(got.windows["7d_oi"].utilization, 0);
  // `unified-overage-status` has the same shape as a window's status header.
  assert.equal(got.windows.overage, undefined);
});

test("a response with no rate-limit headers reports nothing", () => {
  assert.equal(parseLimitHeaders({ "content-type": "application/json" }), null);
  assert.equal(parseLimitHeaders({}), null);
  assert.equal(parseLimitHeaders(undefined), null);
  assert.equal(parseLimitHeaders(null), null);
});

test("hostile or malformed values are dropped, never stored", () => {
  const got = parseLimitHeaders({
    "anthropic-ratelimit-unified-5h-utilization": "abc",
    "anthropic-ratelimit-unified-5h-reset": "1790814600",
    "anthropic-ratelimit-unified-7d-utilization": "-0.3",
    "anthropic-ratelimit-unified-7d-reset": "1790838000",
    "anthropic-ratelimit-unified-7d_oi-utilization": "0.4",
    "anthropic-ratelimit-unified-7d_oi-reset": "not-a-time",
    "anthropic-ratelimit-unified-status": "<script>",
  });
  assert.equal(got.windows["5h"], undefined, "a non-numeric utilization is not a window");
  assert.equal(got.windows["7d"], undefined, "a negative utilization is not a window");
  assert.equal(got.windows["7d_oi"].utilization, 0.4, "a good utilization survives a bad reset");
  assert.equal(got.windows["7d_oi"].resetsAt, null);
  assert.equal(got.status, null, "an unknown status word is not passed on");
});

test("node hands repeated headers over as arrays; the first value is used", () => {
  const got = parseLimitHeaders({
    "anthropic-ratelimit-unified-5h-utilization": ["0.42", "0.99"],
    "anthropic-ratelimit-unified-5h-reset": ["1790814600"],
  });
  assert.equal(got.windows["5h"].utilization, 0.42);
});

test("a figure above 1 is kept: going over a limit is information, not an error", () => {
  const got = parseLimitHeaders({
    "anthropic-ratelimit-unified-5h-utilization": "1.04",
    "anthropic-ratelimit-unified-5h-reset": "1790814600",
  });
  assert.equal(got.windows["5h"].utilization, 1.04);
});

test("window length is derived from its name", () => {
  assert.equal(windowLength("5h"), 5 * H);
  assert.equal(windowLength("7d"), 7 * D);
  assert.equal(windowLength("7d_oi"), 7 * D);
  assert.equal(windowLength("what"), null);
});

test("merging: a newer reading replaces its window and keeps the others", () => {
  const now = 1790800000_000;
  const first = mergeLimits(null, parseLimitHeaders(REAL_FABLE), now);
  assert.equal(first.at, now);
  // A Haiku turn does not carry the Fable window. It must not erase it.
  const second = mergeLimits(first, parseLimitHeaders({ ...REAL_HAIKU, "anthropic-ratelimit-unified-5h-utilization": "0.30" }), now + 1000);
  assert.equal(second.windows["5h"].utilization, 0.3);
  assert.ok(second.windows["7d_oi"], "the Fable window survives a reading that lacks it");
  assert.equal(second.at, now + 1000);
});

test("merging: a window past its reset time is dropped, as Claude Code drops it", () => {
  const before = mergeLimits(null, parseLimitHeaders(REAL_HAIKU), 1790800000_000);
  const later = mergeLimits(before, parseLimitHeaders({ "anthropic-ratelimit-unified-7d-utilization": "0.2", "anthropic-ratelimit-unified-7d-reset": "1790838000" }), 1790820000_000);
  assert.equal(later.windows["5h"], undefined, "the 5h window reset at 1790814600 and is gone");
  assert.ok(later.windows["7d"]);
});

test("activeWindows lists what is live: 5h first, weekly next, anything else after", () => {
  const state = mergeLimits(null, parseLimitHeaders(REAL_FABLE), 1790800000_000);
  assert.deepEqual(activeWindows(state, 1790800000_000).map((w) => w.key), ["5h", "7d", "7d_oi"]);
  assert.deepEqual(activeWindows(state, 1790820000_000).map((w) => w.key), ["7d", "7d_oi"]);
  assert.deepEqual(activeWindows(null, 1), []);
});

// ---- pace projection ---------------------------------------------------------------------
const win = (u, hoursLeft, now, key = "5h") => ({ key, utilization: u, resetsAt: now + hoursLeft * H });

test("projection: steady use that would run out before the reset is reported", () => {
  const now = 1790800000_000;
  // 2h into a 5h window at 50% -> 25%/h -> empty in 2h, reset is 3h away.
  const hit = projectHit(win(0.5, 3, now), now);
  assert.equal(hit.inMs, 2 * H);
  assert.equal(hit.atMs, now + 2 * H);
});

test("projection: pace that only just makes it to the reset is not an alarm", () => {
  const now = 1790800000_000;
  // 1h in at 20% -> empty exactly at the reset.
  assert.equal(projectHit(win(0.2, 4, now), now), null);
  // 1h in at 30% -> empty in ~2.33h, well before the reset.
  assert.equal(Math.round(projectHit(win(0.3, 4, now), now).inMs / 60000), 140);
});

test("projection: too little history, too little use, or already full all stay quiet", () => {
  const now = 1790800000_000;
  assert.equal(projectHit({ key: "5h", utilization: 0.5, resetsAt: now + 5 * H - 5 * 60000 }, now), null, "5 minutes in is noise");
  assert.equal(projectHit(win(0.05, 3, now), now), null, "under 10% is noise");
  assert.equal(projectHit(win(1.0, 3, now), now), null, "already at the limit");
  assert.equal(projectHit(win(0.6, 3, now, "wat"), now), null, "a window of unknown length cannot be paced");
  assert.equal(projectHit({ key: "5h", utilization: 0.6, resetsAt: null }, now), null);
});

// ---- persistence -------------------------------------------------------------------------
test("limits survive a restart, minus anything that has since reset", () => {
  const dir = mkdtempSync(join(tmpdir(), "laya-limits-"));
  const file = join(dir, "limits.json");
  const state = mergeLimits(null, parseLimitHeaders(REAL_HAIKU), 1790800000_000);
  saveLimits(state, file);
  const same = loadLimits(file, 1790800000_000 + 1000);
  assert.deepEqual(Object.keys(same.windows), ["5h", "7d"]);
  const later = loadLimits(file, 1790820000_000);
  assert.deepEqual(Object.keys(later.windows), ["7d"]);
});

test("a missing or corrupt limits file is an empty state, not a crash", () => {
  const dir = mkdtempSync(join(tmpdir(), "laya-limits-"));
  assert.equal(loadLimits(join(dir, "nope.json"), 1), null);
  writeFileSync(join(dir, "bad.json"), "{not json");
  assert.equal(loadLimits(join(dir, "bad.json"), 1), null);
  writeFileSync(join(dir, "weird.json"), JSON.stringify({ windows: { "5h": { utilization: "x" } } }));
  assert.equal(loadLimits(join(dir, "weird.json"), 1), null, "a file that parses but holds nonsense is discarded");
});

test("the limits file holds figures only, nothing that identifies the account", () => {
  const dir = mkdtempSync(join(tmpdir(), "laya-limits-"));
  const file = join(dir, "limits.json");
  saveLimits(mergeLimits(null, parseLimitHeaders(REAL_HAIKU), 1790800000_000), file);
  const text = readFileSync(file, "utf8");
  assert.doesNotMatch(text, /authorization|bearer|sk-|token|email/i);
});

// ---- one window, as two sources give it

test("sameWindow: resets a few seconds apart are one window, anything further apart is not", () => {
  const R = 1790832600000;
  assert.equal(sameWindow(R, R - 311), true, "the cache keeps fractions of a second, the headers do not");
  assert.equal(sameWindow(R, R + 5000), true, "exactly the limit");
  assert.equal(sameWindow(R, R + 5001), false);
  assert.equal(sameWindow(R, R + 5 * 3600_000), false, "the next window");
  for (const bad of [null, undefined, NaN, Infinity, "1790832600000"]) {
    assert.equal(sameWindow(R, bad), false, String(bad));
    assert.equal(sameWindow(bad, R), false, String(bad));
  }
});

test("merging: one window read from two sources that round its reset differently stays one window", () => {
  const R = 1790832600000;
  const t = R - 3600_000;
  const first = mergeLimits(null, { windows: { "5h": { utilization: 0.5, resetsAt: R, status: "allowed" } }, status: "allowed" }, t);
  const second = mergeLimits(first, { windows: { "5h": { utilization: 0.55, resetsAt: R - 311, status: null } }, status: "allowed" }, t + 1000);
  assert.equal(second.windows["5h"].resetsAt, R, "the instant already in use is kept, so alerts see one window");
  assert.equal(second.windows["5h"].utilization, 0.55, "while the figure is the newer one");
});

test("merging: a reset that really moved is a new window and replaces the old one", () => {
  const R = 1790832600000;
  const first = mergeLimits(null, { windows: { "5h": { utilization: 1, resetsAt: R, status: "rejected" } }, status: "rejected" }, R - 60_000);
  const next = mergeLimits(first, { windows: { "5h": { utilization: 0.03, resetsAt: R + 5 * 3600_000, status: null } }, status: "allowed" }, R + 60_000);
  assert.equal(next.windows["5h"].resetsAt, R + 5 * 3600_000);
  assert.equal(next.windows["5h"].utilization, 0.03);
});
