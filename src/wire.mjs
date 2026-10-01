// What Claude Code puts on the wire that a smaller model cannot take, and how to read what
// Claude Code says about each request. Every rule here was measured, not assumed:
//   - real claude 2.1.285 captured against a stub (request shape, headers)
//   - real api.anthropic.com for which model rejects what (Haiku 4.5 -> 400 on a system-role
//     message; Sonnet 5.5 and Opus 5.5 -> 200)
// The set of rules follows dirien/jev-router (Apache-2.0), the one Jev router live-tested
// against Claude Code; the code here is our own.

const isRecord = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Claude Code labels each request when CLAUDE_CODE_GATEWAY_HINT_HEADERS=1:
 * main | subagent | compaction | auxiliary | workflow. `undefined` means the client sent no
 * hint (hint headers off), so the caller has to work it out from the body.
 */
export function requestClass(headers) {
  const cls = headers?.["x-claude-code-request-class"];
  if (typeof cls === "string" && cls.trim()) return cls.trim().toLowerCase();
  if (headers?.["x-claude-code-agent-id"]) return "subagent";
  return undefined;
}

/** Models that accept `role: "system"` messages inside `messages` (measured, see above). */
const SYSTEM_MESSAGE_MODELS = /^claude-(sonnet-5|opus-5-5|fable-5-1)\b/;
export const takesSystemMessages = (model) => SYSTEM_MESSAGE_MODELS.test(String(model ?? ""));

/** Highest max_tokens each model accepts. Claude Code asks for 128000 because it believes it talks to Opus. */
const OUTPUT_LIMITS = [
  [/^claude-haiku-4-5\b/, 64000],
  [/^claude-(sonnet-5|opus-5|fable-5|mythos-5)\b/, 128000],
];
export const outputLimitFor = (model) => OUTPUT_LIMITS.find(([re]) => re.test(String(model ?? "")))?.[1];

/** Betas a model rejects even though Claude Code asks for them (Haiku 4.5, 1M context, subscription login). */
const REJECTED_BETAS = [[/^claude-haiku-4-5\b/, ["context-1m-2025-08-07"]]];

export function filterBetas(header, model) {
  if (typeof header !== "string") return header;
  const rejected = REJECTED_BETAS.find(([re]) => re.test(String(model ?? "")))?.[1];
  if (!rejected) return header;
  return header
    .split(",")
    .map((flag) => flag.trim())
    .filter((flag) => flag && !rejected.includes(flag))
    .join(",");
}

const reminder = (text) => (text.includes("<system-reminder>") ? text : `<system-reminder>\n${text}\n</system-reminder>`);
const blocksOf = (content) =>
  typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];

/** A tool addition inside a system message: a definition joins `tools`, a reference loads a deferred tool. */
function addTool(tools, block) {
  const tool = isRecord(block.tool) ? block.tool : undefined;
  if (tool?.type === "tool_definition" && isRecord(tool.definition)) {
    const definition = tool.definition;
    return tools.some((t) => isRecord(t) && t.name === definition.name) ? tools : [...tools, definition];
  }
  if (tool?.type !== "tool_reference") return tools;
  return tools.map((t) =>
    isRecord(t) && t.name === tool.name && t.defer_loading
      ? Object.fromEntries(Object.entries(t).filter(([k]) => k !== "defer_loading"))
      : t,
  );
}

/**
 * Folds each system-role message into the user message before it, as `<system-reminder>` text
 * at the end (tool results have to stay first). A system message that follows no user message
 * becomes one; one with nothing foldable disappears. Mutates `body`; returns the count folded.
 */
function foldSystemMessages(body) {
  const messages = body.messages;
  const count = Array.isArray(messages) ? messages.filter((m) => m?.role === "system").length : 0;
  if (!count) return 0;
  let tools = Array.isArray(body.tools) ? body.tools : [];
  const before = tools;
  const out = [];
  for (const message of messages) {
    if (message?.role !== "system") {
      out.push(message);
      continue;
    }
    const blocks = [];
    for (const b of blocksOf(message.content)) {
      if ((b.type === "text" || b.type === "connector_text") && typeof b.text === "string") {
        blocks.push({ ...b, type: "text", text: reminder(b.text) });
      } else if (b.type === "tool_addition") {
        tools = addTool(tools, b);
      }
    }
    if (!blocks.length) continue;
    const previous = out[out.length - 1];
    if (previous?.role === "user") out[out.length - 1] = { ...previous, content: [...blocksOf(previous.content), ...blocks] };
    else out.push({ role: "user", content: blocks });
  }
  body.messages = out;
  if (tools !== before) body.tools = tools;
  return count;
}

/** Lowers max_tokens to `limit`, keeping a thinking budget below it. Returns the limit if it changed anything. */
function capOutput(body, limit) {
  if (limit === undefined) return undefined;
  const asked = body.max_tokens;
  if (typeof asked !== "number" || asked <= limit) return undefined;
  body.max_tokens = limit;
  const thinking = body.thinking;
  if (isRecord(thinking) && typeof thinking.budget_tokens === "number" && thinking.budget_tokens >= limit) {
    body.thinking = { ...thinking, budget_tokens: limit - 1 };
  }
  return limit;
}

/**
 * Makes a request Claude Code shaped for Opus acceptable to `model`. Mutates `body`.
 * Fields a tier cannot take at all (thinking, effort, context management) are the tier
 * table's job in applyTier; this covers what is per-model rather than per-tier.
 * @returns {{ capped?: number, folded?: number }}
 */
export function adaptForModel(body, model) {
  const result = {};
  const capped = capOutput(body, outputLimitFor(model));
  if (capped !== undefined) result.capped = capped;
  if (!takesSystemMessages(model)) {
    const folded = foldSystemMessages(body);
    if (folded) result.folded = folded;
  }
  return result;
}
