import http from "node:http";
import https from "node:https";
import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import {
  TIERS,
  tierOf,
  idOf,
  availableTiers,
  tierSpec,
  isAuto,
  shouldUseExactModel,
  EFFORT,
  EFFORT_LEVELS,
  THRESHOLDS,
  STEP_FRAMING,
} from "./config.mjs";
import { askLaya } from "./router.mjs";
import { decide, decideStep, effortWhy, settleEffort } from "./policy.mjs";
import {
  requestClass,
  adaptForModel,
  filterBetas,
  stepHazard,
  takesMessageEffort,
  hasEffortMessages,
  isEffortMessage,
  withEffortMessages,
  mergeBeta,
  EFFORT_BETA,
} from "./wire.mjs";
import { log } from "./log.mjs";
import { createUsageTap, decoderFor, readableEncodings } from "./usage.mjs";
import { parseLimitHeaders, loadLimits, paceCapActive } from "./limits.mjs";
import { PREFS_FILE, defaultPrefs, mergePrefs } from "./prefs.mjs";
import { writeDecision, writeStatus } from "./status.mjs";
import { TRIM_BETA, addTrim, clearedOf, heldTrim, planTrim } from "./trim.mjs";

// Upstream the proxy forwards to. Defaults to first-party Anthropic, which is what a Claude
// subscription login uses. Set LAYA_CLAUDE_UPSTREAM only to route through an Anthropic-dialect
// gateway; the tier ids in config.mjs are then that gateway's own slugs, not Anthropic's.
// Resolved when the proxy starts, not at import: bin/laya-claude.mjs imports this module
// before it loads ~/.laya-router.env, so a value kept in that file only exists after import.
const ANTHROPIC_BASE_URL = "https://api.anthropic.com";
const defaultUpstream = () => process.env.LAYA_CLAUDE_UPSTREAM || ANTHROPIC_BASE_URL;
const debug = (line) => process.env.LAYA_DEBUG && log(line);

/** A session idle this long has no warm prompt cache left to protect (Anthropic's is 5-60 min). */
const IDLE_RESET_MS = 10 * 60 * 1000;

/**
 * Claude Code converts draft-04 relics in MCP tool schemas before sending them first-party,
 * but skips that when ANTHROPIC_BASE_URL is set, so the API rejects the request. In draft
 * 2020-12 `exclusiveMinimum`/`exclusiveMaximum` are numbers, not booleans.
 */
export function sanitizeSchema(node) {
  if (Array.isArray(node)) return node.forEach(sanitizeSchema);
  if (!node || typeof node !== "object") return;
  for (const [key, bound] of [
    ["exclusiveMinimum", "minimum"],
    ["exclusiveMaximum", "maximum"],
  ]) {
    if (typeof node[key] === "boolean") {
      if (node[key] && typeof node[bound] === "number") {
        node[key] = node[bound];
        delete node[bound];
      } else {
        delete node[key];
      }
    }
  }
  for (const v of Object.values(node)) sanitizeSchema(v);
}

/**
 * The text of a genuinely new user turn, or null.
 *
 * A turn can continue for many requests while Claude works through tool calls, and those
 * continuations end in a `tool_result` rather than typed text. Routing them would re-ask
 * Laya on every tool call and let the model flip mid-task, so only the opening request of a
 * turn counts. Claude Code also injects `<system-reminder>` blocks into the user message,
 * which are noise to a router and measurably blunt Laya's confidence, so they are removed.
 */
export function newTurnPrompt(body) {
  if (!Array.isArray(body?.tools) || body.tools.length === 0) return null; // auxiliary call
  // Claude Code appends a system-role entry to `messages`, after the user's own message, so
  // the last conversational message is the last one that is not a system entry.
  const conversational = (body?.messages ?? []).filter((m) => m?.role !== "system");
  const last = conversational[conversational.length - 1];
  if (!last || last.role !== "user") return null;
  let text;
  if (typeof last.content === "string") {
    text = last.content;
  } else if (Array.isArray(last.content)) {
    if (last.content.some((b) => b.type === "tool_result")) return null;
    text = last.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
  } else {
    return null;
  }
  const prompt = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
  if (!prompt || SYNTHETIC_TURN.test(prompt)) return null;
  return prompt;
}

const conversationalOf = (body) => (Array.isArray(body?.messages) ? body.messages : []).filter((m) => m?.role !== "system");
const blocksOf = (content) => (typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : []);
/**
 * Rough token count of message content. Text is ~4 characters a token, but an image or a PDF sent as
 * base64 is not text: counted by its characters, one screenshot read as hundreds of thousands of
 * tokens (measured: step estimates of 148k-865k for a session whose real prompt never passed 116k,
 * all of it PNG frames the agent looked at). The API bills an image by its pixels, about 1,600 tokens
 * for a typical one, so media blocks count as a flat figure instead of their encoding.
 */
export const MEDIA_TOKENS = { image: 1600, document: 3000 };
export function tokensOf(value) {
  if (value == null) return 0;
  if (typeof value === "string") return value.length / 4;
  if (Array.isArray(value)) return value.reduce((n, v) => n + tokensOf(v), 0);
  if (typeof value === "object") {
    if ((value.type === "image" || value.type === "document") && value.source && typeof value.source === "object") {
      return MEDIA_TOKENS[value.type];
    }
    let n = 0;
    for (const [k, v] of Object.entries(value)) n += k.length / 4 + tokensOf(v);
    return n;
  }
  return String(value).length / 4;
}
/** Characters, for the per-step averages below: four per token, media at its token figure. */
const charsOf = (value) => Math.round(tokensOf(value) * 4);

/** Whether this request continues a tool loop: the last message hands back tool results. */
export function isToolContinuation(body) {
  const last = conversationalOf(body).at(-1);
  return last?.role === "user" && blocksOf(last.content).some((b) => b?.type === "tool_result");
}

/** One tool call as LAYA sees it: its name and the first part of each argument. */
function describeToolUse(block) {
  const input = block.input && typeof block.input === "object" ? block.input : {};
  const args = Object.entries(input)
    .map(([k, v]) => `${k}=${(typeof v === "string" ? v : JSON.stringify(v)).replace(/\s+/g, " ").slice(0, 120)}`)
    .join(", ");
  return `${block.name ?? "tool"}: ${args}`.slice(0, 300);
}

/**
 * What LAYA is asked at a step: the assistant's own intent, read from its latest message. Its text
 * and its tool calls (name and a short form of the arguments) say what it is about to do. Its
 * thinking is never sent (it is the model's private reasoning, and is often empty on the wire) and
 * neither is tool output, which describes the files, not the work. Null when there is nothing to
 * read, which skips the check.
 */
export function stepPrompt(body, maxChars = THRESHOLDS.stepPromptChars) {
  const assistant = conversationalOf(body).findLast((m) => m?.role === "assistant");
  if (!assistant) return null;
  const parts = [];
  for (const b of blocksOf(assistant.content)) {
    if (b?.type === "text" && typeof b.text === "string") {
      const text = b.text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
      if (text) parts.push(text);
    } else if (b?.type === "tool_use") {
      parts.push(describeToolUse(b));
    }
  }
  if (!parts.length) return null;
  return `${STEP_FRAMING}\n${parts.join("\n")}`.slice(0, maxChars);
}

/**
 * The average step of this conversation so far, in tokens (4 characters each, as elsewhere here):
 * `output` is what each assistant message wrote, `input` what each tool result brought back. It is
 * what a switch's saving is priced on.
 */
export function stepSize(body) {
  let output = 0;
  let input = 0;
  let steps = 0;
  for (const m of conversationalOf(body)) {
    const blocks = blocksOf(m.content);
    if (m.role === "assistant") {
      steps++;
      for (const b of blocks) {
        if (b?.type === "text") output += charsOf(b.text);
        else if (b?.type === "tool_use") output += charsOf(b.input) + charsOf(b.name);
      }
    } else {
      for (const b of blocks) if (b?.type === "tool_result") input += charsOf(b.content);
    }
  }
  if (!steps) return { input: 0, output: 0 };
  return { input: Math.round(input / 4 / steps), output: Math.round(output / 4 / steps) };
}

/**
 * Text Claude Code writes into the user role itself to continue a turn, which is not something
 * the user typed. Measured: after a reply hit the output cap, Claude Code sent "Output token
 * limit hit. Resume directly..." as a user message and it reached LAYA as the prompt.
 */
const SYNTHETIC_TURN = /^Output token limit hit\. Resume directly\b/;

/**
 * Points a request at a tier, removing request fields that tier cannot accept. Claude Code
 * composes the body for whatever model it thinks it is talking to, so downgrading to Haiku
 * while leaving `thinking: {type:"adaptive"}` in place is a hard 400.
 */
export function applyTier(body, tierName, model = idOf(tierName)) {
  const tier = tierSpec(tierName);
  if (!tier) return body;
  body.model = model;
  if (!tier.thinking) {
    delete body.thinking;
    // A context-management strategy that prunes thinking blocks is itself rejected once
    // thinking is gone, so it has to go with it.
    const edits = body.context_management?.edits;
    if (Array.isArray(edits)) {
      body.context_management.edits = edits.filter((e) => !/thinking/i.test(e?.type ?? ""));
      if (body.context_management.edits.length === 0) delete body.context_management;
    }
  }
  if (!tier.effort && body.output_config) {
    delete body.output_config.effort;
    if (Object.keys(body.output_config).length === 0) delete body.output_config;
  }
  return body;
}

/**
 * Exact Claude models reported by the account, newest first; static ids are the cold-start
 * fallback. OpenRouter's catalog also lists `<id>:batch` twins, which its messages endpoint
 * answers with a 404, and each one is offered to LAYA as a choice, so they are dropped here.
 *
 * `fillMissingTiers` is for a gateway, where the tier ids in config.mjs are the gateway's own
 * slugs. Some gateways answer Claude Code's discovery request with a curated catalog that
 * leaves a whole tier out (OpenRouter returns no Haiku and no Sonnet to it), and a tier that
 * is absent reads as unavailable, so every decision would step up to Opus. Against
 * first-party Anthropic the static ids are the wrong format, so this stays off there.
 */
export function claudeModels(catalog = [], { fillMissingTiers = false } = {}) {
  const models = catalog
    .filter((model) => tierOf(model?.id) && !String(model.id).endsWith(":batch"))
    .map((model) => ({
      id: model.id,
      tier: tierOf(model.id),
      description: [
        model.display_name,
        model.created_at && `released ${model.created_at.slice(0, 10)}`,
        model.max_input_tokens && `${model.max_input_tokens} input tokens`,
      ].filter(Boolean).join("; "),
    }));
  const staticFor = (tier) => ({ id: tier.id, tier: tier.name, description: tier.id });
  if (!models.length) return TIERS.map(staticFor);
  if (!fillMissingTiers) return models;
  const covered = new Set(models.map((model) => model.tier));
  return [...models, ...TIERS.filter((tier) => !covered.has(tier.name)).map(staticFor)];
}

const modelForTier = (models, tier) => models.find((model) => model.tier === tier)?.id ?? idOf(tier);

/**
 * One question to the router, as an answer or null. `askLaya` already returns null on failure, but
 * `route` is injectable, and a router that throws must cost a decision, never the request: an
 * exception here would forward the sentinel model name upstream unrewritten.
 */
async function ask(route, input, deadlineMs = null) {
  let timer;
  try {
    const answer = route(input);
    if (!deadlineMs) return (await answer) ?? null;
    const late = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), deadlineMs);
      timer.unref?.();
    });
    return (await Promise.race([answer, late])) ?? null;
  } catch (err) {
    debug(`routing failed, keeping the current model: ${err?.message ?? err}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Identifies the conversation a request belongs to. Claude Code runs sub-agents through the
 * same endpoint, so a single pinned model would let a sub-agent's choice leak into the main
 * conversation.
 *
 * Only stable fields may be used. Claude Code moves its `cache_control` breakpoint between
 * requests and rewrites message metadata, so the key is built from the session id plus the
 * text of the first message, which is fixed once a conversation starts and differs between
 * the main agent and each sub-agent.
 */
/**
 * Session id Claude Code embeds in request metadata, or "" when it isn't present.
 * `metadata.user_id` is a JSON string, not a plain id.
 */
export function sessionOf(body) {
  try {
    return JSON.parse(body?.metadata?.user_id ?? "{}").session_id ?? "";
  } catch {
    return "";
  }
}

export function conversationKey(body) {
  const session = sessionOf(body);
  // An effort message (wire.withEffortMessages) is never part of a conversation's identity.
  const content = (body?.messages ?? []).find((m) => !isEffortMessage(m))?.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("")
        : "";
  return createHash("sha1").update(`${session}|${text}`).digest("hex").slice(0, 12);
}

/**
 * Records the tier Claude Code is asking for and reports whether the user has taken manual
 * control. The first tier seen in a conversation is the baseline; any later change means the
 * user picked a model with /model, and an explicit choice must beat the router. Compared by
 * tier rather than exact model id, because Claude Code varies the id within a tier.
 */
export function observeModel(state, current) {
  state.baseline ??= current;
  if (current !== state.baseline) state.manual = true;
  return state.manual;
}


/**
 * The app's settings, read per request. A control file only exists when the background app is
 * running; without one the proxy behaves exactly as it did on its own, which is what the
 * command-line launcher relies on.
 */
/**
 * Header `laya-claude` asks Claude Code to send (ANTHROPIC_CUSTOM_HEADERS) when it was started with
 * LAYA_STEP_ROUTING=1. A worker that joins the app's shared proxy does not share its environment,
 * so the switch has to travel with the requests. Stripped before anything goes upstream.
 */
export const STEP_HEADER = "x-laya-step-routing";

/**
 * Header `laya-claude` asks Claude Code to send when it was started headless (-p / --print). The
 * proxy cannot otherwise tell a run nobody is steering from a terminal session, and that is the
 * signal xhigh effort needs (config.mjs, EFFORT). Stripped before anything goes upstream.
 */
export const HEADLESS_HEADER = "x-laya-headless";

/** Whether step routing is on for this request: the app's setting, the environment, or the header. */
const stepsOn = (prefs, headers) =>
  prefs?.stepRouting === true || process.env.LAYA_STEP_ROUTING === "1" || headers?.[STEP_HEADER] === "1";

/**
 * Whether effort is re-decided inside a tool loop: on unless the app's effortSteps is off or
 * LAYA_EFFORT_STEPS=0. It only ever applies to a model that can change effort per message.
 */
const effortStepsOn = (prefs) => prefs?.effortSteps !== false && process.env.LAYA_EFFORT_STEPS !== "0";

/**
 * Whether this request can carry effort as a per-message change. Sonnet 5.5 with `between_tools`
 * thinking returns a 400 for a level that differs from the one in effect, so it never gets one, and
 * a client that sends effort messages itself is managing effort and is left to it.
 */
const messageEffortOk = (body, model) =>
  takesMessageEffort(model) && body?.thinking?.type !== "between_tools" && !hasEffortMessages(body);

let prefsCache = { mtimeMs: 0, value: null };
/**
 * Whether old tool results are trimmed. `LAYA_TRIM=1`/`0` decides outright (the live test and the
 * command-line launcher without the app); otherwise the app's setting, on by default.
 */
export function trimOn(prefs, env = process.env) {
  if (env.LAYA_TRIM === "1") return true;
  if (env.LAYA_TRIM === "0") return false;
  return prefs?.trimToolResults !== false;
}

/**
 * Whether a sub-agent the parent pinned to a model is routed anyway. `LAYA_ROUTE_SUBAGENTS=1`/`0`
 * decides outright; otherwise the app's setting, on by default.
 */
export function subagentRoutingOn(prefs, env = process.env) {
  if (env.LAYA_ROUTE_SUBAGENTS === "1") return true;
  if (env.LAYA_ROUTE_SUBAGENTS === "0") return false;
  return prefs?.routeSubagents !== false;
}

function readPrefs() {
  if (process.env.LAYA_DISABLE_PREFS === "1") return null;
  try {
    // Cached on the file's mtime, not on a timer, so a setting changed in the app takes effect
    // on the very next turn instead of up to a second later. One stat per request.
    const { mtimeMs } = statSync(PREFS_FILE());
    if (mtimeMs === prefsCache.mtimeMs) return prefsCache.value;
    // Through the same validator the daemon writes with, so the two always agree on what a file
    // means: a field the file lacks takes its default (routing on), it is never read as "off".
    const value = mergePrefs(defaultPrefs(), JSON.parse(readFileSync(PREFS_FILE(), "utf8")));
    prefsCache = { mtimeMs, value };
    return value;
  } catch {
    prefsCache = { mtimeMs: 0, value: null };
    return null;
  }
}

export async function startProxy({
  upstreamURL = defaultUpstream(),
  route = askLaya,
  onEvent = null,
  onLimits = null,
  port: wantedPort = 0,
  stepDeadlineMs = THRESHOLDS.stepDeadlineMs,
  limits = null,
} = {}) {
  // The plan's limits as the daemon last saved them, for pacing. Read through limits.mjs and reused
  // for a few seconds (the daemon rewrites the file about once a second while turns run). A missing
  // or unreadable file is null, and null never caps anything.
  let limitsRead = { at: 0, value: null };
  const readLimits =
    limits ??
    (() => {
      if (Date.now() - limitsRead.at < THRESHOLDS.paceReadMs) return limitsRead.value;
      limitsRead = { at: Date.now(), value: loadLimits() };
      return limitsRead.value;
    });
  const pacing = () => {
    try {
      return paceCapActive(readLimits());
    } catch (err) {
      debug(`could not read the plan's limits, not pacing: ${err?.message ?? err}`);
      return false;
    }
  };
  // Tier routed for each conversation's turn in flight, reused by its follow-up requests and
  // by the cache-rebuild guard, which needs to know what the prompt cache was built on.
  const convos = new Map();
  const catalog = new Map();
  // Set when the API answers 400 to a request that carried an effort message. Per-message effort is
  // a beta; if this account or model refuses it, effort goes back to the top-level value, as before,
  // for the rest of this run, instead of failing every request that follows.
  let effortBroken = false;
  const stateFor = (key) => {
    let s = convos.get(key);
    if (!s) {
      if (convos.size > 50) convos.delete(convos.keys().next().value);
      convos.set(key, (s = { tier: null }));
    }
    return s;
  };
  // The main conversation's tier and model per session. A sub-agent that LAYA cannot score runs on
  // what its parent runs on: that is the tier the user's own turn was given, where the placeholder
  // would hand every unscored sub-agent the top tier.
  const parents = new Map();
  const recordParent = (session, tier, model) => {
    if (!session) return;
    if (!parents.has(session) && parents.size > 50) parents.delete(parents.keys().next().value);
    parents.set(session, { tier, model });
  };
  /**
   * The models a decision chooses between. Only a gateway needs its missing tiers filled in: the
   * static tier ids are that gateway's slugs, and against first-party Anthropic they are the wrong
   * format. The fill decides which tiers exist and what each resolves to; the options LAYA is
   * asked to choose between stay the account's real models. A tier switched off in the app is not
   * offered at all, so a decision can never land on it and the substitute steps up instead.
   */
  const choicesFor = (prefs) => {
    const inTier = (model) => availableTiers(prefs?.tiers).includes(model.tier);
    const catalogModels = claudeModels([...catalog.values()]).filter(inTier);
    const models = claudeModels([...catalog.values()], {
      fillMissingTiers: upstreamURL !== ANTHROPIC_BASE_URL,
    }).filter(inTier);
    const available = [...new Set(models.map((model) => model.tier))];
    const allowed = prefs?.tiers ? available.filter((t) => prefs.tiers[t] === true) : available;
    return { catalogModels, models, allowed: allowed.length ? allowed : available };
  };

  const server = http.createServer((req, res) => {
    // Claude Code probes the base URL before its first request.
    if (req.method === "HEAD") return res.writeHead(200).end();

    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      let out = Buffer.concat(chunks);
      let routedModel = null;
      let effortBeta = false;
      let trimBeta = false;
      // What this request is, for the app's live feed: a tap on the response reads the token
      // usage the API itself reports, and the rest is the decision already made above.
      let report = null;
      // The routed conversation this request belongs to, so its response's usage can be kept.
      let convo = null;
      const emit = (event) => {
        if (!onEvent) return;
        try {
          onEvent(event);
        } catch (err) {
          debug(`event hook failed: ${err.message}`);
        }
      };

      if (/^\/v1\/messages/.test(req.url ?? "")) {
        try {
          const body = JSON.parse(out.toString());
          // Claude Code's request shape is undocumented and moves; LAYA_DUMP captures it.
          if (process.env.LAYA_DUMP) {
            writeFileSync(`${process.env.LAYA_DUMP}.${Date.now()}.json`, JSON.stringify(body, null, 2));
          }
          body.tools?.forEach((t) => sanitizeSchema(t.input_schema));

          // Anything that is not the sentinel is a model the user chose, and an explicit
          // choice beats the router. That also covers Claude Code's own cheap Haiku calls
          // for titles and summaries, which must never be pinned up to the session's tier.
          // A sub-agent whose parent named a model for it is routed like any other: the name is the
          // parent agent's guess, not the user's choice (measured: a worker told "use opus" pinned
          // its sub-agent to Opus and 74 of 78 requests skipped routing). Turned off, the old rule
          // holds and a named model is never changed. Explicit text in the task ("use opus") still wins.
          const routePinnedSubagent =
            !isAuto(body.model) && requestClass(req.headers) === "subagent" && tierOf(body.model) && subagentRoutingOn(readPrefs());
          if (!isAuto(body.model) && !routePinnedSubagent) {
            debug(`passthrough, user selected ${body.model}`);
            // Only a real agent turn reflects the user's choice. Claude Code's own auxiliary
            // calls carry no tools and must not flip the status line to manual mid-session.
            if (Array.isArray(body.tools)) {
              writeStatus(sessionOf(body), { manual: true, at: Date.now() });
            }
            // A model named outright (by the user, or by an agent for its sub-agent) is never re-routed,
            // but trimming is not a model choice: a pinned sub-agent is often the longest tool loop
            // there is. Same held cut as a routed conversation (src/trim.mjs).
            const pinnedCls = requestClass(req.headers);
            if (Array.isArray(body.tools) && trimOn(readPrefs())) {
              const pinnedState = stateFor(conversationKey(body));
              convo = pinnedState;
              trimBeta = addTrim(body, pinnedCls === "compaction" ? heldTrim(pinnedState, body) : planTrim(pinnedState, body));
            }
            if (onEvent) {
              report = {
                kind: "manual",
                // main | subagent | ...: a sub-agent pinned by its parent reads differently from a user's pick.
                class: pinnedCls === "subagent" ? "subagent" : pinnedCls ?? undefined,
                model: body.model,
                tier: tierOf(body.model) ?? null,
                // The level Claude Code sent with it, so the app can show it; the proxy does not change it.
                effort: body.output_config?.effort ?? null,
                effortReason: body.output_config?.effort ? "client-chosen" : null,
                reason: pinnedCls === "subagent" ? "the agent chose this model for its sub-agent" : "you chose this model",
                session: sessionOf(body),
                ...(trimBeta ? { trim: true } : {}),
              };
            }
          } else {
            const key = conversationKey(body);
            const state = stateFor(key);
            convo = state;
            const session = sessionOf(body) || String(req.headers["x-claude-code-session-id"] ?? "");
            // Claude Code labels each request when CLAUDE_CODE_GATEWAY_HINT_HEADERS=1. A "main"
            // request can be a message the user wrote, and a sub-agent's opening request is the
            // task its parent wrote for it; both are scored, each for its own conversation.
            // Compaction and workflows ride the conversation's tier, background work goes to the
            // cheap model.
            const cls = requestClass(req.headers);
            const subagent = cls === "subagent";
            const humanTurn = cls === undefined || cls === "main" || subagent;
            // A sub-agent with no tier of its own yet stands on its parent's, so a sub-agent that
            // LAYA cannot score runs on what the main conversation runs on.
            // A pinned sub-agent that LAYA cannot score keeps the model its parent named for it.
            const parent =
              subagent && !state.tier
                ? routePinnedSubagent
                  ? { tier: tierOf(body.model), model: body.model }
                  : parents.get(session)
                : undefined;
            // What the prompt cache was built on, which is what a downgrade would discard.
            const current = state.tier ?? parent?.tier ?? "opus";
            const prompt = humanTurn ? newTurnPrompt(body) : null;
            const explaining = prompt?.includes("<laya-explain>");
            let fresh = null;
            let laya = null;
            let reason = null;
            let step = null;
            // `tier`/`model` are the pair this request is served by: the forced one for
            // background or paused work, otherwise the decision. Declared once here so the
            // routing branch and the rewrite below cannot disagree.
            let tier = state.forceTier ?? state.tier ?? current;
            let model = state.forceModel ?? state.model ?? parent?.model ?? idOf(tier);
            if (cls === "auxiliary") {
              state.forceModel = idOf("haiku");
              state.forceTier = "haiku";
              if (onEvent) report = { kind: "routed", tier: "haiku", reason: "background" };
            } else {
              state.forceModel = state.forceTier = undefined;
            }
            // The app's settings, when it is running: the master switch, which tiers the
            // router may pick, and whether the router chooses effort at all. Without the app
            // these are null and the proxy behaves exactly as the command-line launcher does.
            const prefs = readPrefs();
            // Step checks: whether the tier may move (step routing; never on a turn the user pinned with
            // `use <tier>`) and whether effort may (the model takes it per message, the level is ours to set).
            const stepRouting = stepsOn(prefs, req.headers) && !state.pinned;
            const effortSteps =
              effortStepsOn(prefs) &&
              !effortBroken &&
              prefs?.effortAuto !== false &&
              Boolean(state.effort) &&
              (body.output_config?.effort ?? EFFORT.launcherDefault) === EFFORT.launcherDefault &&
              messageEffortOk(body, state.model ?? idOf(state.tier));
            if (prefs && !prefs.enabled) {
              // Paused: every turn runs on one fixed model, untouched. The conversation's
              // routing state is cleared so that turning routing back on starts from the
              // router's own decision rather than inheriting what it decided before the pause.
              state.tier = state.model = undefined;
              state.effort = undefined;
              state.lastReason = "routing is off";
              const paused = idOf(prefs.pausedTier) ?? idOf("opus");
              state.forceTier = prefs.pausedTier;
              state.forceModel = paused;
              debug(`${key} routing paused, serving ${paused}`);
              if (onEvent) report = { kind: "paused", tier: prefs.pausedTier, reason: "routing is off", session: sessionOf(body) };
            } else if (prompt && !explaining) {
              const { catalogModels, models, allowed } = choicesFor(prefs);
              const currentModel = state.model ?? parent?.model ?? modelForTier(models, current);
              const contextTokens = Math.round(tokensOf(body.messages));
              laya = await ask(route, { prompt, current: currentModel, contextTokens, models: catalogModels });
              // No ongoing decision to protect: a session that is new, has been idle, or was
              // just compacted may move either way; otherwise the tier only goes up.
              const idleMs = Date.now() - (state.lastSeen ?? 0);
              const freshSession = state.tier === null || idleMs > IDLE_RESET_MS || state.freshNext === true;
              ({ tier, reason } = decide({
                prompt,
                laya,
                current,
                available: allowed,
                contextTokens,
                fresh: freshSession,
                preset: prefs?.preset,
                paceCap: pacing(),
              }));
              state.freshNext = false;
              // A new turn starts its own count of tool-loop steps, and a tier the user named for
              // it holds for the whole turn: step routing does not move it.
              state.continuations = state.stepAskedAt = 0;
              state.pinned = /^override\b/.test(reason ?? "");
              // The N-way pick is explanation-only for policy, but when the rubric decision
              // was accepted and the pick landed in the same tier, its exact model carries
              // LAYA's version preference within that tier.
              const picked = models.find((model) => model.id === laya?.choice);
              const model =
                picked && shouldUseExactModel(reason, picked.tier, tier)
                  ? picked.id
                  : tier === current
                    ? currentModel
                    : modelForTier(models, tier);
              // Effort is decided with the tier and held by the same ratchet, unless the
              // app has effort turned off, in which case the model keeps whatever it chose.
              const why = effortWhy(tier, laya?.metrics, subagent ? "subagent" : "main", {
                headless: req.headers[HEADLESS_HEADER] === "1",
                briefChars: prompt.length,
              });
              // A model that takes effort per message moves it either way, because that keeps the
              // cache; any other keeps the ratchet, since a top-level change restarts the cache.
              const perMessage = !effortBroken && messageEffortOk(body, model);
              state.effort = prefs?.effortAuto === false
                ? undefined
                : settleEffort({
                  target: why.level,
                  previous: state.effort ?? null,
                  fresh: freshSession || perMessage,
                  tierChanged: tier !== current,
                });
              state.effortReason = state.effort === why.level ? why.reason : `${why.reason}/ratchet-held`;
              // What a step later may drop from, and what xhigh judged the turn by.
              state.turnEffort = state.effort;
              state.briefChars = prompt.length;
              state.tier = tier;
              state.model = model;
              // A sub-agent's choice is its own; only the main conversation is a parent.
              if (!subagent) recordParent(session, tier, model);
              fresh = {
                effort: state.effort,
                prompt,
                model,
                confidence: laya?.confidence ?? null,
                metrics: laya?.metrics ?? null,
                reason,
                laya: laya ? { request: laya.request, response: laya.response } : null,
              };
              debug(
                `${key} ${laya && laya.confidence != null ? `${laya.ms}ms p=${laya.confidence.toFixed(2)}` : "no-laya"} ` +
                  `${current} -> ${tier} (${reason}) ctx~${contextTokens} | ${prompt.slice(0, 60)}`,
              );
            } else if (humanTurn && state.tier && isToolContinuation(body) && (stepRouting || effortSteps)) {
              // A step: the conversation is inside a tool loop on a tier it already has. Asked at
              // most every `stepEvery` continuations, never twice in a row, and only when the
              // assistant's last message says what it is doing. One answer serves both jobs: the
              // model switch (when step routing is on) and the effort level (when effort can move).
              state.continuations = (state.continuations ?? 0) + 1;
              const due = state.continuations - (state.stepAskedAt ?? 0) >= Math.max(2, THRESHOLDS.stepEvery);
              const stepText = due ? stepPrompt(body) : null;
              if (stepText) {
                state.stepAskedAt = state.continuations;
                const { catalogModels, models, allowed } = choicesFor(prefs);
                const currentModel = state.model ?? modelForTier(models, current);
                // The cache a switch throws away is the whole prefix, system prompt and tools
                // included, which the messages alone understate (measured: 6,758 estimated against
                // 20,093 cached). The size the API reported for the last response is the real one.
                // The size the API reported for the last response is the real one (the whole prefix,
                // after any trimming); only the newest message has to be added to it. Without that
                // figure, an estimate that counts images by their pixels, not their base64 text.
                const contextTokens = state.prefixTokens
                  ? state.prefixTokens + Math.round(tokensOf(body.messages?.at(-1)))
                  : Math.round(tokensOf(body.messages));
                laya = await ask(route, { prompt: stepText, current: currentModel, contextTokens, models: catalogModels }, stepDeadlineMs);
                const size = stepSize(body);
                const d = !stepRouting ? null : decideStep({
                  prompt: stepText,
                  laya,
                  current,
                  available: allowed,
                  contextTokens,
                  step: size,
                  hazard: (target) => stepHazard(body, modelForTier(models, target)),
                  preset: prefs?.preset,
                  paceCap: pacing(),
                });
                reason = d?.reason ?? "step-effort-check";
                if (d?.switched) {
                  state.tier = d.tier;
                  state.model = modelForTier(models, d.tier);
                  // A switch starts cold anyway, so the new tier's own effort costs nothing extra.
                  const why = effortWhy(d.tier, laya?.metrics, subagent ? "subagent" : "main");
                  state.effort = prefs?.effortAuto === false
                    ? undefined
                    : settleEffort({ target: why.level, previous: state.effort ?? null, fresh: false, tierChanged: true });
                  state.effortReason = state.effort === why.level ? why.reason : `${why.reason}/ratchet-held`;
                  if (!subagent) recordParent(session, state.tier, state.model);
                }
                // Effort for the next steps, from what LAYA made of this one. No ratchet: it moves
                // down as well as up. It may not fall more than EFFORT.stepMaxDrop levels below where
                // the turn opened, because a step is scored from its next tool call alone. No answer,
                // or an unsure one, keeps the level.
                let effortChange = null;
                if (effortSteps && laya && laya.confidence >= THRESHOLDS.minConfidence) {
                  const why = effortWhy(state.tier, laya.metrics, subagent ? "subagent" : "main", {
                    headless: req.headers[HEADLESS_HEADER] === "1",
                    briefChars: state.briefChars ?? 0,
                  });
                  if (why.level) {
                    const opened = EFFORT_LEVELS.indexOf(state.turnEffort ?? why.level);
                    const floor = Math.max(0, opened - EFFORT.stepMaxDrop);
                    const clamped = EFFORT_LEVELS.indexOf(why.level) < floor;
                    const level = clamped ? EFFORT_LEVELS[floor] : why.level;
                    effortChange = { from: state.effort, to: level };
                    state.effort = level;
                    state.effortReason = `step-${why.reason}${clamped ? "/floor" : ""}`;
                  }
                }
                step = {
                  of: subagent ? "subagent" : "main",
                  from: current,
                  to: state.tier,
                  switched: d?.switched ?? false,
                  target: d?.target ?? null,
                  saving: d?.saving ?? 0,
                  rebuild: d?.rebuild ?? 0,
                  contextTokens,
                  stepTokens: size,
                  prompt: stepText,
                  ...(effortChange ? { effort: effortChange } : {}),
                };
                debug(
                  `${key} step ${state.continuations} ${laya && laya.confidence != null ? `${laya.ms}ms p=${laya.confidence.toFixed(2)}` : "no-laya"} ` +
                    `${current} -> ${state.tier} (${reason}) save~$${(d?.saving ?? 0).toFixed(4)} rebuild~$${(d?.rebuild ?? 0).toFixed(4)} ctx~${contextTokens}` +
                    `${effortChange ? ` effort ${effortChange.from} -> ${effortChange.to}` : ""}`,
                );
              }
            }
            // The sentinel is not a real model, so every routed request must be rewritten,
            // including follow-ups that reuse the tier chosen for the turn.
            // Recomputed after the decision: the forced tier wins for background and paused
            // work, otherwise this is the tier the router chose for this turn.
            tier = state.forceTier ?? state.tier ?? current;
            model = state.forceModel ?? state.model ?? parent?.model ?? idOf(tier);
            debug(`${key} rewrite ${body.model} -> ${model}${cls ? ` [${cls}]` : ""}`);
            applyTier(body, tier, model);
            // Claude Code shaped this request for Opus. Whatever is per-model rather than
            // per-tier (system-role messages, max_tokens, betas) is fixed for the model chosen.
            const adapted = adaptForModel(body, model);
            if (adapted.folded || adapted.capped) {
              debug(`${key} adapted for ${model}: ${adapted.folded ? `folded ${adapted.folded} system message(s) ` : ""}${adapted.capped ? `max_tokens<=${adapted.capped}` : ""}`);
            }
            // Effort. Only the launcher's default marks "the user did not choose"; a level they set
            // themselves (/effort, --effort) is left exactly as sent. On a model that takes it per
            // message the top-level value is fixed at the conversation's first (a change would
            // restart the cache) and the level in effect moves by message; elsewhere it is top-level.
            // After adaptForModel, whose system-message folding must not see these messages.
            let effortReason = null;
            let effortTop = null;
            let effortMsgs = 0;
            let effortNow = null;
            const sent = body.output_config?.effort;
            if (!tierSpec(tier)?.effort) effortReason = "haiku-takes-none";
            else if (hasEffortMessages(body)) effortReason = "client-managed";
            else if (prefs?.effortAuto === false) effortReason = "effort-auto-off";
            else if (sent !== undefined && sent !== EFFORT.launcherDefault) effortReason = "user-chosen";
            else if (state.effort && sent === EFFORT.launcherDefault) {
              effortReason = state.effortReason ?? null;
              effortNow = state.effort;
              if (!effortBroken && messageEffortOk(body, model)) {
                if (state.effortModel !== model || !state.marks) {
                  // The first request on this model: its level is the conversation's top-level value.
                  Object.assign(state, { effortModel: model, effortTop: state.effort, effortNow: state.effort, marks: [] });
                }
                body.output_config.effort = state.effortTop;
                const conversational = conversationalOf(body);
                const lastAt = conversational.length - 1;
                if (state.effort !== state.effortNow && conversational[lastAt]?.role === "user") {
                  state.marks.push({ at: lastAt, effort: state.effort });
                  state.effortNow = state.effort;
                }
                effortMsgs = withEffortMessages(body, state.marks);
                effortBeta = effortMsgs > 0;
                effortTop = state.effortTop;
                effortNow = state.effortNow;
              } else {
                body.output_config.effort = state.effort;
              }
            }
            // Old tool results, trimmed server-side in stable jumps once the prompt is large (src/trim.mjs).
            // Claude Code's compaction request gets the same cut without moving it, so it reads the
            // cached prompt instead of re-writing the whole history.
            if (trimOn(prefs)) trimBeta = addTrim(body, cls === "compaction" ? heldTrim(state, body) : planTrim(state, body));
            routedModel = model;
            if (onEvent) {
              report = {
                ...(report ?? { kind: "routed" }),
                class: step ? "step" : cls === "auxiliary" ? "auxiliary" : subagent ? "subagent" : "main",
                ...(step ? { step } : {}),
                tier,
                model,
                // The level in effect for this request. With per-message effort the top-level value is
                // `effortTop` and stays fixed; `effortMsgs` is how many effort messages the request carries.
                effort: effortNow ?? body.output_config?.effort ?? null,
                effortReason,
                ...(effortMsgs ? { effortTop, effortMsgs } : {}),
                ...(trimBeta ? { trim: true } : {}),
                reason: report?.reason ?? reason ?? null,
                session: sessionOf(body),
                prompt: humanTurn ? (prompt ?? undefined) : undefined,
                ms: laya?.ms ?? null,
                confidence: laya?.confidence ?? null,
              };
            }
            if (cls === "compaction") state.freshNext = true;
            state.lastSeen = Date.now();
            // Publish what went out. Claude Code's UI shows the row you picked, not the tier
            // it resolved to, so the status line is the only place this is visible.
            // `claude -p` omits metadata on the first request of a session, so there is no
            // session id to file the decision under and it would be dropped. The conversation
            // key is stable for the same conversation and is already what `debug` prints, so
            // it is the identifier a user can pass to `laya-explain` for a print-mode run.
            if (fresh && !explaining) {
              writeDecision(sessionOf(body) || key, { tier, ...fresh, at: Date.now() });
            }
          }
          out = Buffer.from(JSON.stringify(body));
        } catch (err) {
          debug(`passthrough, could not process body: ${err.message}`);
        }
      }

      const target = new URL(upstreamURL);
      const transport = target.protocol === "http:" ? http : https;
      const headers = { ...req.headers, host: target.host };
      delete headers["content-length"];
      // The launcher's own switch, meant for this proxy only.
      delete headers[STEP_HEADER];
      delete headers[HEADLESS_HEADER];
      if (effortBeta) headers["anthropic-beta"] = mergeBeta(headers["anthropic-beta"], EFFORT_BETA);
      if (trimBeta) headers["anthropic-beta"] = mergeBeta(headers["anthropic-beta"], TRIM_BETA);
      if (routedModel && headers["anthropic-beta"]) {
        headers["anthropic-beta"] = filterBetas(headers["anthropic-beta"], routedModel);
      }
      if (req.method === "GET" && /^\/v1\/models(?:\?|$)/.test(req.url ?? "")) {
        delete headers["accept-encoding"];
      }
      // A turn is only measured if its response can be read, and the API compresses streams
      // (measured: content-encoding gzip). So when something is listening, offer the client's own
      // list cut down to what can be decoded here. With nothing listening the proxy stays a pure
      // pass-through and the header is left exactly as the client sent it.
      if (report) {
        const offer = readableEncodings(headers["accept-encoding"]);
        if (offer) headers["accept-encoding"] = offer;
        else delete headers["accept-encoding"];
      }
      // Under LAYA_DEBUG, ask for an uncompressed stream so the model the API reports can be
      // read back out of it. Not worth the bandwidth cost in normal operation.
      if (process.env.LAYA_DEBUG) delete headers["accept-encoding"];
      const upstream = transport.request(
        {
          hostname: target.hostname,
          port: target.port || undefined,
          path: `${target.pathname.replace(/\/$/, "")}${req.url}`,
          method: req.method,
          headers,
        },
        (up) => {
          const isModels = req.method === "GET" && /^\/v1\/models(?:\?|$)/.test(req.url ?? "");
          if (isModels) {
            const chunks = [];
            up.on("data", (chunk) => chunks.push(chunk));
            // This path waits for the whole body, so a cut-off one would wait forever.
            up.once("close", () => {
              if (!up.complete) res.destroy();
            });
            up.on("end", () => {
              const data = Buffer.concat(chunks);
              try {
                for (const model of JSON.parse(data.toString()).data ?? []) {
                  if (tierOf(model?.id)) catalog.set(model.id, model);
                }
              } catch (err) {
                debug(`could not read Claude model catalog: ${err.message}`);
              }
              const headers = { ...up.headers };
              delete headers["content-length"];
              res.writeHead(up.statusCode, headers);
              res.end(data);
            });
            return;
          }
          res.writeHead(up.statusCode, up.headers);
          // The plan's limits ride on every response. Reading them here is free (no extra call),
          // covers turns the user pinned to a model as well as routed ones, and covers a 429,
          // which is the moment the figure matters most. The client still gets the headers: Claude
          // Code reads them too. A listener that throws must never cost the user a response.
          if (onLimits) {
            try {
              const reading = parseLimitHeaders(up.headers);
              if (reading) onLimits(reading);
            } catch (err) {
              debug(`onLimits failed: ${err.message}`);
            }
          }
          // Report the model the API itself says it used, so the routing can be confirmed
          // from the wire rather than trusted from our own decision log. Claude Code's UI
          // always shows the model it asked for, never the one we rewrote to.
          if (process.env.LAYA_DEBUG) {
            let seen = false;
            up.on("data", (c) => {
              if (seen) return;
              const m = /"model"\s*:\s*"([^"]+)"/.exec(c.toString("utf8"));
              if (!m) return;
              seen = true;
              debug(`${up.statusCode} served by ${m[1]}`);
            });
          }
          up.pipe(res);
          // pipe() ends the client's response when the upstream finishes, and does nothing at all
          // when the upstream is cut off. Measured: a response dropped mid-stream left the client
          // waiting forever, with the committed proxy as well as this one. Closing the client's
          // connection is the honest answer: Claude Code sees a reset and retries, instead of
          // hanging on bytes that are never coming.
          // `close` is emitted after an abort as well as after a normal end (and after `error`), so
          // it is the one place that sees every way the upstream can stop; `complete` says whether
          // the whole message arrived.
          up.once("close", () => {
            if (!up.complete) res.destroy();
          });
          // Reading the response as it passes through is how the app learns what a turn
          // actually cost. The tap must not change what the client receives, so it observes
          // copies on a separate listener and the pipe is untouched.
          if (report) {
            // Exactly one event per request, whatever happens to the response: with its cost when
            // the usage could be read, without one when it could not. A decision that was made is
            // worth showing even when its price is unknown; dropping it made the feed look empty.
            let reported = false;
            const finish = (usage, model, contextManagement = null) => {
              if (reported) return;
              reported = true;
              if (up.statusCode === 400 && report.effortMsgs) {
                effortBroken = true;
                debug("the API refused a request that carried an effort message: per-step effort is off for this run");
              }
              if (usage && convo) convo.prefixTokens = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
              // The status says whether the model this was routed to accepted the request at all.
              const cleared = clearedOf(contextManagement);
              if (cleared) debug(`trimmed ${cleared.tokens} tokens (${cleared.toolUses} old tool results)`);
              emit({ ...report, model: report.model ?? model ?? undefined, status: up.statusCode, ...(usage ? { usage } : {}), ...(cleared ? { cleared } : {}), kind: report.kind ?? "routed" });
            };
            const tap = createUsageTap(({ usage, model, contextManagement }) => finish(usage, model, contextManagement));
            const settle = () => {
              tap.end();
              finish(null, null);
            };
            // The tap reads a COPY, undone from whatever compression the API used. The client's
            // own pipe above is untouched, so it still gets the compressed bytes it asked for.
            const decoder = decoderFor(up.headers["content-encoding"]);
            const contentType = String(up.headers["content-type"] ?? "");
            if (decoder) {
              decoder.on("data", (chunk) => tap.push(chunk, contentType));
              decoder.once("end", settle);
              decoder.once("error", settle);
              up.on("data", (chunk) => decoder.write(chunk));
              up.once("close", () => decoder.end());
            } else {
              // null: nothing to undo. undefined: an encoding that cannot be read, so the copy is
              // ignored and the request is reported without a cost.
              if (decoder === null) up.on("data", (chunk) => tap.push(chunk, contentType));
              up.once("close", settle);
            }
          }
        },
      );
      upstream.on("error", (e) => {
        debug(`upstream error: ${e.message}`);
        if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { message: e.message } }));
      });
      if (out.length) upstream.write(out);
      upstream.end();
    });
  });

  // A wanted port lets a session that is already running keep talking to the same address across
  // a daemon restart. If something else holds it, any free port is better than refusing to start.
  await new Promise((resolve, reject) => {
    const bind = (n, retry) => {
      const onError = (err) => {
        if (retry && err.code === "EADDRINUSE") return bind(0, false);
        reject(err);
      };
      server.once("error", onError);
      server.listen(n, "127.0.0.1", () => {
        server.off("error", onError);
        resolve();
      });
    };
    bind(wantedPort, wantedPort !== 0);
  });
  return { port: server.address().port, close: () => server.close() };
}
