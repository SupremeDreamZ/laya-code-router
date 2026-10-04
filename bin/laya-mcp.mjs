#!/usr/bin/env node
// MCP server (stdio) giving a routed Claude Code session one tool: laya_rank_files. The agent asks a
// yes/no question about many files and gets them ranked, without the files entering its context.
// Measured on this repository (27 files, grep as ground truth, 2026-10-04): ranking AUC 0.96 for
// "opens a network socket", 0.88 "reads run.json", 0.80 "computes token prices", 0.70 for an exact
// function name (use grep for names). About 1.5 s per file. The scores rank; they do not prove.
import { createInterface } from "node:readline";
import { askFiles, expand } from "../src/inspect.mjs";
import { askLaya } from "../src/laya-client.mjs";

const TOOL = {
  name: "laya_rank_files",
  description:
    "Rank files by how likely each one is to match a yes/no question about its CONTENT, without reading them into your context. " +
    "Use it to narrow a search by meaning (\"does this file handle authentication?\", \"does this file write to the database?\") " +
    "before reading the top few yourself. Not for exact names or strings: use grep for those. Scores are a ranking, not proof. " +
    "About 1.5 seconds per file; at most 40 files per call.",
  inputSchema: {
    type: "object",
    properties: {
      paths: { type: "array", items: { type: "string" }, description: "Files, directories or globs (e.g. src/**/*.ts), relative to the working directory." },
      question: { type: "string", description: "A yes/no question about a file's content." },
      top: { type: "number", description: "How many ranked files to return (default 10)." },
    },
    required: ["paths", "question"],
  },
};

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);

async function call(args) {
  const files = expand(Array.isArray(args.paths) ? args.paths : [String(args.paths ?? "")]);
  if (!files.length) return "No files matched.";
  const ranked = await askFiles(files, String(args.question ?? ""), {
    askLaya: (s, q) => askLaya(s, q, { timeoutMs: 15000 }),
  });
  const top = Math.max(1, Math.min(Number(args.top) || 10, ranked.length));
  const lines = ranked.slice(0, top).map((r) => (r.yes == null ? `- ${r.file}: unreadable (${r.error})` : `- ${r.file}: ${r.yes.toFixed(2)}`));
  return `Ranked ${ranked.length} file(s) for: ${args.question}\n${lines.join("\n")}\nScores rank the files; read the top ones before relying on them.`;
}

const rl = createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = msg;
  if (method === "initialize") {
    return send({
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "laya", version: "0.1.0" },
      },
    });
  }
  if (method === "tools/list") return send({ id, result: { tools: [TOOL] } });
  if (method === "tools/call") {
    if (params?.name !== TOOL.name) return send({ id, error: { code: -32602, message: `unknown tool ${params?.name}` } });
    try {
      const text = await call(params.arguments ?? {});
      return send({ id, result: { content: [{ type: "text", text }] } });
    } catch (err) {
      return send({ id, result: { content: [{ type: "text", text: `laya_rank_files failed: ${err.message}. Is the Laya app running?` }], isError: true } });
    }
  }
  if (method === "ping") return send({ id, result: {} });
  if (id !== undefined) send({ id, error: { code: -32601, message: `method not found: ${method}` } });
});
