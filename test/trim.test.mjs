import test from "node:test";
import assert from "node:assert/strict";
import { addTrim, clearedOf, planTrim, toolUsesIn, trimEdit, TRIM_EDIT_TYPE } from "../src/trim.mjs";
import { trimOn } from "../src/proxy.mjs";
import { mergePrefs, defaultPrefs } from "../src/prefs.mjs";
import { createUsageTap } from "../src/usage.mjs";

const SETTINGS = { advanceAt: 100_000, keepMin: 8, jump: 12, growth: 1.4 };

/** A conversation with `n` tool uses, one per assistant message. */
function convo(n) {
  const messages = [{ role: "user", content: "do the thing" }];
  for (let i = 0; i < n; i++) {
    messages.push({ role: "assistant", content: [{ type: "tool_use", id: `t${i}`, name: "Bash", input: {} }] });
    messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `t${i}`, content: "x" }] });
  }
  return { tools: [{ name: "Bash" }], messages };
}

test("counts tool uses in assistant messages only", () => {
  assert.equal(toolUsesIn(convo(5)), 5);
  assert.equal(toolUsesIn({}), 0);
});

test("nothing is cleared below the size where trimming starts", () => {
  const state = { prefixTokens: 99_999 };
  assert.equal(planTrim(state, convo(40), SETTINGS), null);
});

test("past the size, the boundary jumps to leave keepMin tool uses whole", () => {
  const state = { prefixTokens: 150_000 };
  assert.equal(planTrim(state, convo(40), SETTINGS), 8);
  assert.equal(state.trimmed, 32);
});

test("the boundary holds still between jumps, so the same prefix is cleared every request", () => {
  // Measured live: a boundary that moved every step missed the cache on every step.
  const state = { prefixTokens: 150_000 };
  planTrim(state, convo(40), SETTINGS);
  state.prefixTokens = 130_000; // still above the size after clearing
  for (let n = 41; n < 52; n++) {
    assert.equal(planTrim(state, convo(n), SETTINGS), n - 32, `keep grows so 32 stay cleared at ${n}`);
    assert.equal(state.trimmed, 32);
  }
  // 52 tool uses is a full jump of tool uses, but the prompt has not grown 40% past what the
  // jump left (130k), so the cut holds.
  assert.equal(planTrim(state, convo(52), SETTINGS), 20);
  assert.equal(state.trimmed, 32);
  state.prefixTokens = 182_000; // 1.4 x 130k
  assert.equal(planTrim(state, convo(53), SETTINGS), 8);
  assert.equal(state.trimmed, 45);
});

test("a big prompt does not move the boundary until a full jump is available", () => {
  const state = { prefixTokens: 500_000, trimmed: 32 };
  assert.equal(planTrim(state, convo(45), SETTINGS), 13);
  assert.equal(state.trimmed, 32);
});

test("a conversation with fewer tool uses than were cleared starts over", () => {
  const state = { prefixTokens: 20_000, trimmed: 32 };
  assert.equal(planTrim(state, convo(5), SETTINGS), null, "after a compaction nothing is cleared");
  assert.equal(state.trimmed, 0);
});

test("the edit clears all but `keep` tool uses", () => {
  assert.deepEqual(trimEdit(13), {
    type: TRIM_EDIT_TYPE,
    trigger: { type: "input_tokens", value: 1024 },
    keep: { type: "tool_uses", value: 13 },
  });
});

test("adds the edit after Claude Code's own edits and keeps them", () => {
  const body = convo(3);
  body.context_management = { edits: [{ type: "clear_thinking_20251015", keep: "all" }] };
  assert.equal(addTrim(body, 2), true);
  assert.deepEqual(body.context_management.edits.map((e) => e.type), ["clear_thinking_20251015", TRIM_EDIT_TYPE]);
});

test("never overrides a client's own tool-clearing edit, and skips requests without tools", () => {
  const managed = convo(3);
  managed.context_management = { edits: [{ type: TRIM_EDIT_TYPE, keep: { type: "tool_uses", value: 1 } }] };
  assert.equal(addTrim(managed, 2), false);
  assert.equal(managed.context_management.edits.length, 1);
  const noTools = { messages: [] };
  assert.equal(addTrim(noTools, 2), false);
  assert.equal(noTools.context_management, undefined);
  assert.equal(addTrim(convo(3), null), false, "no plan, no edit");
});

test("reads what the API cleared", () => {
  assert.deepEqual(
    clearedOf({ applied_edits: [{ type: "clear_thinking_20251015", cleared_input_tokens: 9 }, { type: TRIM_EDIT_TYPE, cleared_tool_uses: 3, cleared_input_tokens: 15548 }] }),
    { tokens: 15548, toolUses: 3 },
  );
  assert.equal(clearedOf(null), null);
  assert.equal(clearedOf({ applied_edits: [] }), null);
});

test("the usage tap picks up context_management from a stream's message_delta", () => {
  let seen = null;
  const tap = createUsageTap((r) => (seen = r));
  const delta = { type: "message_delta", usage: { output_tokens: 5 }, context_management: { applied_edits: [{ type: TRIM_EDIT_TYPE, cleared_tool_uses: 2, cleared_input_tokens: 10 }] } };
  tap.push(`data: ${JSON.stringify({ type: "message_start", message: { model: "m", usage: { input_tokens: 1 } } })}\n`, "text/event-stream");
  tap.push(`data: ${JSON.stringify(delta)}\n`, "text/event-stream");
  tap.end();
  assert.deepEqual(clearedOf(seen.contextManagement), { tokens: 10, toolUses: 2 });
});

test("trimming is on by default, follows the app setting, and the env decides outright", () => {
  assert.equal(defaultPrefs().trimToolResults, true);
  assert.equal(trimOn(null, {}), true);
  assert.equal(trimOn({ trimToolResults: false }, {}), false);
  assert.equal(trimOn({ trimToolResults: false }, { LAYA_TRIM: "1" }), true);
  assert.equal(trimOn({ trimToolResults: true }, { LAYA_TRIM: "0" }), false);
  assert.equal(mergePrefs(defaultPrefs(), { trimToolResults: false }).trimToolResults, false);
  assert.equal(mergePrefs(defaultPrefs(), { trimToolResults: "no" }).trimToolResults, true, "invalid values are dropped");
});

test("the compaction request reuses the cut without moving it", async () => {
  const { heldTrim } = await import("../src/trim.mjs");
  const state = { prefixTokens: 500_000, trimmed: 32 };
  assert.equal(heldTrim(state, convo(60)), 28, "same 32 cleared, nothing new");
  assert.equal(state.trimmed, 32);
  assert.equal(heldTrim({ trimmed: 0 }, convo(60)), null, "nothing cut, nothing to hold");
  assert.equal(heldTrim({ trimmed: 32 }, convo(5)), null, "a conversation shorter than the cut is not this one");
});
