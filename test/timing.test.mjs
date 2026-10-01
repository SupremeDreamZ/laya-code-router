import test from "node:test";
import assert from "node:assert/strict";
import { deadlineMs, loadDeadlineMs, loadGiveUpMs } from "../src/timing.mjs";
import { THRESHOLDS } from "../src/config.mjs";

// The two waits a person may change from the environment. A value is read only if it is a whole
// number of milliseconds inside a sane range; anything else is the default, because the alternative
// to a default here is a timer that fires at once and fails every routing decision.

const DEFAULT = THRESHOLDS.layaDeadlineMs;

test("the deadline is the default when nothing is set", () => {
  assert.equal(deadlineMs(undefined), DEFAULT);
  assert.equal(deadlineMs(""), DEFAULT);
  assert.equal(deadlineMs("   "), DEFAULT);
});

test("a whole number of milliseconds in range is read as given", () => {
  assert.equal(deadlineMs("1000"), 1000);
  assert.equal(deadlineMs("45000"), 45000);
  assert.equal(deadlineMs(" 20000 "), 20000);
  assert.equal(deadlineMs(30000), 30000, "a number as well as a string");
  assert.equal(deadlineMs("600000"), 600000, "ten minutes is the most");
});

test("the edges of the range: one under and one over are the default", () => {
  assert.equal(deadlineMs("999"), DEFAULT);
  assert.equal(deadlineMs("1000"), 1000);
  assert.equal(deadlineMs("600000"), 600000);
  assert.equal(deadlineMs("600001"), DEFAULT);
});

test("anything that is not a plain count of milliseconds is the default", () => {
  for (const bad of ["abc", "15s", "1e4", "0x3E8", "0b1111101000", "+5000", "1.5", "5000.0", "-5000", "0", "NaN", "Infinity", "-Infinity", "5000ms", "15,000", "1 000", "٥٠٠٠", "5000\n6000"]) {
    assert.equal(deadlineMs(bad), DEFAULT, `${JSON.stringify(bad)} is not a deadline`);
  }
});

test("a value that is not a string or a number is never turned into one", () => {
  for (const odd of [null, [], [5000], {}, { valueOf: () => 5000 }, true, false, () => 5000, 5000n, Symbol("x")]) {
    assert.equal(deadlineMs(odd), DEFAULT, `${typeof odd} ${String(odd?.toString?.() ?? odd)} is ignored`);
  }
  assert.equal(deadlineMs(NaN), DEFAULT);
  assert.equal(deadlineMs(Infinity), DEFAULT);
  assert.equal(deadlineMs(1500.5), DEFAULT, "half a millisecond is not a deadline");
  assert.equal(deadlineMs(Number.MAX_SAFE_INTEGER + 2), DEFAULT, "nor is a number too big to be exact");
  assert.equal(deadlineMs("99999999999999999999999"), DEFAULT, "nor is a string of digits too long to be exact");
});

test("the environment is what is read when no argument is given", () => {
  const before = process.env.LAYA_DEADLINE_MS;
  try {
    process.env.LAYA_DEADLINE_MS = "22000";
    assert.equal(deadlineMs(), 22000);
    process.env.LAYA_DEADLINE_MS = "nonsense";
    assert.equal(deadlineMs(), DEFAULT);
    delete process.env.LAYA_DEADLINE_MS;
    assert.equal(deadlineMs(), DEFAULT);
  } finally {
    if (before === undefined) delete process.env.LAYA_DEADLINE_MS;
    else process.env.LAYA_DEADLINE_MS = before;
  }
});

test("the load give-up time reads the same way, with its own default and range", () => {
  assert.equal(loadGiveUpMs(undefined), THRESHOLDS.loadGiveUpMs);
  assert.equal(loadGiveUpMs("120000"), 120000);
  assert.equal(loadGiveUpMs("999"), THRESHOLDS.loadGiveUpMs);
  assert.equal(loadGiveUpMs("3600000"), 3600000, "an hour is the most");
  assert.equal(loadGiveUpMs("3600001"), THRESHOLDS.loadGiveUpMs);
  assert.equal(loadGiveUpMs("soon"), THRESHOLDS.loadGiveUpMs);
});

test("the loading allowance reads the same way, with its own default and range", () => {
  assert.equal(loadDeadlineMs(undefined), THRESHOLDS.loadDeadlineMs);
  assert.equal(loadDeadlineMs("90000"), 90000);
  assert.equal(loadDeadlineMs("999"), THRESHOLDS.loadDeadlineMs);
  assert.equal(loadDeadlineMs("600000"), 600000, "ten minutes is the most");
  assert.equal(loadDeadlineMs("600001"), THRESHOLDS.loadDeadlineMs);
  assert.equal(loadDeadlineMs("1e5"), THRESHOLDS.loadDeadlineMs);
  assert.equal(loadDeadlineMs({}), THRESHOLDS.loadDeadlineMs);
  const before = process.env.LAYA_LOAD_DEADLINE_MS;
  try {
    process.env.LAYA_LOAD_DEADLINE_MS = "45000";
    assert.equal(loadDeadlineMs(), 45000, "and is read from its own variable, not the other one");
    assert.equal(deadlineMs(), THRESHOLDS.layaDeadlineMs, "which does not touch the steady deadline");
  } finally {
    if (before === undefined) delete process.env.LAYA_LOAD_DEADLINE_MS;
    else process.env.LAYA_LOAD_DEADLINE_MS = before;
  }
});

test("the defaults are the numbers the documentation states", () => {
  assert.equal(THRESHOLDS.layaDeadlineMs, 15_000);
  assert.equal(THRESHOLDS.loadDeadlineMs, 60_000);
  assert.ok(THRESHOLDS.loadDeadlineMs > THRESHOLDS.layaDeadlineMs, "a load is allowed longer than a decision"); 
  assert.equal(THRESHOLDS.loadGiveUpMs, 300_000);
  assert.equal(THRESHOLDS.wedgedAfterDeadlines, 3);
  assert.ok(THRESHOLDS.layaDeadlineMs > THRESHOLDS.ackMs, "the echo window ends before the deadline, or it could never fire first");
});
