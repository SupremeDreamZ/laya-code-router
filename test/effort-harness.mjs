import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startProxy } from "../src/proxy.mjs";
import { savePrefs } from "../src/prefs.mjs";

// Shared by the effort tests (not a test file itself): the real proxy in front of a stub upstream
// that records exactly what it was sent, with a scripted `route` standing in for LAYA.
export const TOOLS = [{ name: "Bash", description: "x", input_schema: { type: "object", properties: {} } }];
export const user = (t) => ({ role: "user", content: [{ type: "text", text: t }] });
export const score = (mean, judgment) => ({
  metrics: { taskComplexity: mean, reasoningRequired: mean, toolComplexity: mean, judgment },
  confidence: 0.5, ms: 1, request: {}, response: {},
});

export async function harness(t, { route, prefs = null, env = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "laya-effort-"));
  const prevHome = process.env.LAYA_HOME;
  process.env.LAYA_HOME = dir;
  if (prefs) savePrefs(prefs, join(dir, "prefs.json"));
  const prevEnv = {};
  for (const [k, v] of Object.entries(env)) {
    prevEnv[k] = process.env[k];
    process.env[k] = v;
  }
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (/^\/v1\/models/.test(req.url)) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end('{"data":[]}');
      }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      seen.push({ body, headers: req.headers });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "m", type: "message", model: body.model, content: [], usage: { input_tokens: 1, output_tokens: 1 } }));
    });
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const asked = [];
  const events = [];
  const { port, close } = await startProxy({
    upstreamURL: `http://127.0.0.1:${upstream.address().port}`,
    route: async (input) => {
      asked.push(input.prompt);
      return route(input);
    },
    onEvent: (e) => events.push(e),
  });
  t.after(() => {
    close();
    upstream.close();
    if (prevHome === undefined) delete process.env.LAYA_HOME;
    else process.env.LAYA_HOME = prevHome;
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  const send = async (messages, { session = "ssssssss-1111-4222-8333-444444444444", cls = "main", headers = {}, extra = {} } = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-beta": "claude-code-20250219,interleaved-thinking-2025-05-14",
        "x-claude-code-session-id": session,
        "x-claude-code-request-class": cls,
        ...headers,
      },
      body: JSON.stringify({
        model: "laya-router", max_tokens: 128000, tools: TOOLS, messages,
        metadata: { user_id: JSON.stringify({ session_id: session }) },
        thinking: { type: "adaptive" },
        output_config: { effort: "medium" },
        ...extra,
      }),
    });
    await res.text();
    return seen.at(-1);
  };
  return { send, asked, events, seen };
}
