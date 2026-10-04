// Trimming old tool results in long tool loops.
//
// What the router's own usage log showed (2026-10-03, 22 sessions): every session was ONE user turn
// followed by 50-260 tool-loop steps, and the context grew from ~22k to as much as 446k tokens
// without a break. The prompt cache was healthy (98.7% of input was cache reads), so the cost was
// not cache misses but the whole history being re-read on every step, most of it old tool results
// (file contents, command output) the model had already acted on.
//
// A "compact at the next user turn" advisor would never have fired on that log: there was no next
// user turn. So the lever is inside the loop, and the API already has one: server-side context
// editing (`clear_tool_uses_20250919`, beta `context-management-2025-06-27`). Past a size, the API
// replaces the oldest tool results with a placeholder before the prompt reaches the model. It is
// applied server-side, so Claude Code's own copy of the conversation is untouched, and on Opus 5.5
// and Fable 5.1 server-side edits never invalidate thinking blocks (platform docs, context editing).
//
// Whether to trim is a deterministic question (how big is the prompt), so it is answered with a
// number, not a LAYA call: code first, the classifier only where code cannot answer.

export const TRIM_BETA = "context-management-2025-06-27";
export const TRIM_EDIT_TYPE = "clear_tool_uses_20250919";

const envInt = (name, fallback) => {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/**
 * Measured live (test/live-trim.mjs, 2026-10-04): with a fixed `keep`, the API clears every tool use
 * but the last N on EVERY request, so the cleared boundary moves one tool use per step. A moved
 * boundary changes the prompt before Claude Code's cache breakpoint, so each step missed the cache
 * back to the system prompt and re-wrote everything after it (cacheRead pinned at 19,228, ~12k
 * written per step). Cache writes cost 12.5x reads, so at real sizes that is worse than not trimming.
 *
 * So the proxy holds the boundary still. It remembers how many tool uses are cleared and sets `keep`
 * to "everything after that", which clears exactly the same prefix on every request and lets the
 * cache build on it. The boundary only moves when the prompt the API last reported has grown past
 * `advanceAt` again; then it jumps forward to leave just `keepMin` whole. One cache rebuild per jump,
 * paid back by every later step that no longer re-reads what was cleared.
 */
export function trimSettings() {
  return {
    advanceAt: envInt("LAYA_TRIM_TRIGGER", 120_000),
    keepMin: envInt("LAYA_TRIM_KEEP", 8),
    // A jump must clear at least this many more tool uses, so a prompt that stays above `advanceAt`
    // after clearing does not move the boundary on every step (measured: it did, without this).
    jump: envInt("LAYA_TRIM_JUMP", 12),
    // And the prompt must have grown this much past its size right after the last jump. Same rule as
    // jerryfane/omp-jev-compaction's sticky mode (+40%), which measured 3 rewrites in 40 requests
    // and 0 prefix breaks replaying a real session: rewrite rarely, reuse the same cut in between.
    growth: 1.4,
  };
}

/** Tool uses in the conversation so far: what `keep` counts. */
export function toolUsesIn(body) {
  let n = 0;
  for (const m of body?.messages ?? []) {
    if (m?.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const b of m.content) if (b?.type === "tool_use") n++;
  }
  return n;
}

/**
 * Where the cleared boundary stands for this request. `state` is the conversation's routing state:
 * `trimmed` (tool uses cleared so far) and `prefixTokens` (prompt size the API last reported, after
 * clearing). Returns the number of tool uses to keep whole, or null when nothing is to be cleared.
 */
export function planTrim(state, body, settings = trimSettings()) {
  const uses = toolUsesIn(body);
  let cleared = state.trimmed ?? 0;
  // Fewer tool uses than were cleared: Claude Code compacted or the conversation was replaced.
  if (uses < cleared) {
    cleared = 0;
    state.trimBase = 0;
  }
  const size = state.prefixTokens ?? 0;
  // The first size reported after a jump is what the jump left; the next one is measured from it.
  if (state.trimPending) {
    state.trimBase = size;
    state.trimPending = false;
  }
  const grown = size >= Math.max(settings.advanceAt, (state.trimBase ?? 0) * settings.growth);
  if (grown && uses - settings.keepMin - cleared >= settings.jump) {
    cleared = uses - settings.keepMin;
    state.trimPending = true;
  }
  state.trimmed = cleared;
  return cleared > 0 ? uses - cleared : null;
}

/** The edit as the API takes it, clearing all but the last `keep` tool uses. */
export function trimEdit(keep) {
  return {
    type: TRIM_EDIT_TYPE,
    // The proxy already decided; this only has to be below any prompt that reaches it.
    trigger: { type: "input_tokens", value: 1024 },
    keep: { type: "tool_uses", value: keep },
  };
}

/**
 * Adds the trim edit to a request Claude Code built. Mutates `body`. Returns true when it was added.
 * Left alone: requests with no tools, and requests that already carry a tool-clearing edit, which is
 * the client managing its own context and not ours to override.
 */
export function addTrim(body, keep) {
  if (keep == null || !body || !Array.isArray(body.tools) || body.tools.length === 0) return false;
  const edits = Array.isArray(body.context_management?.edits) ? body.context_management.edits : [];
  if (edits.some((e) => e?.type === TRIM_EDIT_TYPE)) return false;
  body.context_management = { ...(body.context_management ?? {}), edits: [...edits, trimEdit(keep)] };
  return true;
}

/**
 * What the API reports it cleared, from the response's `context_management.applied_edits`.
 * Returns null when nothing was cleared.
 */
export function clearedOf(contextManagement) {
  const applied = contextManagement?.applied_edits;
  if (!Array.isArray(applied)) return null;
  let tokens = 0;
  let toolUses = 0;
  for (const e of applied) {
    if (e?.type !== TRIM_EDIT_TYPE) continue;
    if (Number.isFinite(e.cleared_input_tokens)) tokens += e.cleared_input_tokens;
    if (Number.isFinite(e.cleared_tool_uses)) toolUses += e.cleared_tool_uses;
  }
  return tokens || toolUses ? { tokens, toolUses } : null;
}
