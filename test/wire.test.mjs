import test from "node:test";
import assert from "node:assert/strict";
import {
  requestClass,
  outputLimitFor,
  takesSystemMessages,
  adaptForModel,
  filterBetas,
} from "../src/wire.mjs";

const HAIKU = "claude-haiku-4-5-20251001";

// Measured with the real claude 2.1.285 (CLAUDE_CODE_GATEWAY_HINT_HEADERS=1): every request
// carries x-claude-code-request-class; a user's own message is "main".
test("reads the request class Claude Code labels each request with", () => {
  assert.equal(requestClass({ "x-claude-code-request-class": "main" }), "main");
  assert.equal(requestClass({ "x-claude-code-request-class": "Compaction" }), "compaction");
  assert.equal(requestClass({ "x-claude-code-request-class": "auxiliary" }), "auxiliary");
});

test("a request from a sub-agent is a sub-agent even without a class header", () => {
  assert.equal(requestClass({ "x-claude-code-agent-id": "agent-1" }), "subagent");
});

test("no hint headers means no class, so the caller falls back to reading the body", () => {
  assert.equal(requestClass({}), undefined);
  assert.equal(requestClass(undefined), undefined);
});

// Measured 2026-09-30 against api.anthropic.com: Haiku 4.5 answers 400 to
// "role 'system' is not supported on this model"; Sonnet 5.5 and Opus 5.5 answer 200.
test("only the Claude 5 models named by measurement take system messages inside the conversation", () => {
  assert.equal(takesSystemMessages("claude-sonnet-5-5"), true);
  assert.equal(takesSystemMessages("claude-opus-5-5"), true);
  assert.equal(takesSystemMessages("claude-fable-5-1"), true);
  assert.equal(takesSystemMessages(HAIKU), false);
  assert.equal(takesSystemMessages("claude-opus-4-8"), false);
});

test("output limits are the models' own: Haiku 64000, the Claude 5 models 128000, unknown none", () => {
  assert.equal(outputLimitFor(HAIKU), 64000);
  assert.equal(outputLimitFor("claude-sonnet-5-5"), 128000);
  assert.equal(outputLimitFor("claude-opus-5-5"), 128000);
  assert.equal(outputLimitFor("some-other-model"), undefined);
});

test("lowers a max_tokens Haiku cannot accept and keeps a thinking budget below it", () => {
  const body = { model: HAIKU, max_tokens: 128000, thinking: { type: "enabled", budget_tokens: 100000 }, messages: [] };
  const out = adaptForModel(body, HAIKU);
  assert.equal(body.max_tokens, 64000);
  assert.equal(body.thinking.budget_tokens, 63999);
  assert.equal(out.capped, 64000);
});

test("leaves a max_tokens the model already accepts alone", () => {
  const body = { model: HAIKU, max_tokens: 32000, messages: [] };
  const out = adaptForModel(body, HAIKU);
  assert.equal(body.max_tokens, 32000);
  assert.equal(out.capped, undefined);
});

const withSystem = () => ({
  model: HAIKU,
  max_tokens: 1000,
  tools: [{ name: "Bash" }, { name: "Lazy", defer_loading: true }],
  messages: [
    { role: "user", content: [{ type: "text", text: "fix the bug" }] },
    {
      role: "system",
      content: [
        { type: "text", text: "session instructions" },
        { type: "tool_addition", tool: { type: "tool_definition", definition: { name: "Added", description: "x" } } },
        { type: "tool_addition", tool: { type: "tool_reference", name: "Lazy" } },
      ],
    },
  ],
});

test("folds a system message into the user message before it, as a system-reminder", () => {
  const body = withSystem();
  const out = adaptForModel(body, HAIKU);
  assert.equal(out.folded, 1);
  assert.equal(body.messages.some((m) => m.role === "system"), false);
  assert.equal(body.messages.length, 1);
  const blocks = body.messages[0].content;
  assert.equal(blocks[0].text, "fix the bug", "the user's own text stays first");
  assert.match(blocks[1].text, /^<system-reminder>\nsession instructions\n<\/system-reminder>$/);
});

test("tool additions in a folded system message join tools, and a reference loads a deferred tool", () => {
  const body = withSystem();
  adaptForModel(body, HAIKU);
  assert.deepEqual(body.tools.map((t) => t.name), ["Bash", "Lazy", "Added"]);
  assert.equal("defer_loading" in body.tools.find((t) => t.name === "Lazy"), false);
});

test("does not fold for a model that takes system messages", () => {
  const body = withSystem();
  body.model = "claude-sonnet-5-5";
  const out = adaptForModel(body, "claude-sonnet-5-5");
  assert.equal(out.folded, undefined);
  assert.equal(body.messages.length, 2);
  assert.equal(body.messages[1].role, "system");
});

test("a system message that follows no user message becomes one instead of being lost", () => {
  const body = { model: HAIKU, max_tokens: 1, messages: [{ role: "system", content: [{ type: "text", text: "rules" }] }] };
  adaptForModel(body, HAIKU);
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].role, "user");
  assert.match(body.messages[0].content[0].text, /rules/);
});

test("a system message carrying only a tool removal leaves no empty message behind", () => {
  const body = {
    model: HAIKU,
    max_tokens: 1,
    messages: [
      { role: "user", content: "hi" },
      { role: "system", content: [{ type: "tool_removal", tool: { name: "x" } }] },
    ],
  };
  adaptForModel(body, HAIKU);
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].role, "user");
});

// Measured 2026-09-30: Claude Code sends the 1M-context beta once its model has a 1M window,
// and Haiku 4.5 rejects it on a subscription login.
test("drops the 1M-context beta for Haiku and keeps every other beta", () => {
  const header = "claude-code-20250219,oauth-2025-04-20,context-1m-2025-08-07,effort-2025-11-24";
  assert.equal(filterBetas(header, HAIKU), "claude-code-20250219,oauth-2025-04-20,effort-2025-11-24");
  assert.equal(filterBetas(header, "claude-sonnet-5-5"), header);
  assert.equal(filterBetas(undefined, HAIKU), undefined);
});
