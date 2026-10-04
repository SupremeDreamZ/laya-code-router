#!/usr/bin/env node
// Claude Code PreToolUse hook: the Laya tool gate (src/guard.mjs). Reads the hook payload on stdin,
// prints a deny/ask decision or nothing, and reports any block to the menu-bar app's feed.
// Never fails a tool call by crashing: any error here exits 0 with no output (Claude Code's own
// permissions then apply as if the hook were absent).
import { decide, hookOutput } from "../src/guard.mjs";
import { askLaya, readRun } from "../src/laya-client.mjs";
import { connect } from "node:net";

function report(event) {
  return new Promise((resolve) => {
    try {
      const run = readRun();
      const socket = connect(run.port, "127.0.0.1", () => {
        socket.end(`${JSON.stringify({ id: 1, action: "event", token: run.token, arg: event })}\n`);
      });
      socket.on("close", resolve);
      socket.on("error", resolve);
      setTimeout(resolve, 800);
    } catch {
      resolve();
    }
  });
}

try {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  const payload = JSON.parse(raw || "{}");
  const tool = payload.tool_name;
  const input = payload.tool_input ?? {};
  const verdict = await decide(tool, input, {
    askLaya: (state, questions) => askLaya(state, questions, { timeoutMs: 4000 }),
    headless: process.env.LAYA_GUARD_HEADLESS === "1",
  });
  const out = hookOutput(verdict);
  if (out) {
    // The decision goes out first: reporting to the app is cosmetic and must never hold it back.
    process.stdout.write(JSON.stringify(out));
    await report({
      kind: "guard",
      reason: `${verdict.decision === "deny" ? "blocked" : "asked"}: ${verdict.reason}`,
      prompt: String(input.command ?? input.file_path ?? "").slice(0, 300),
      session: payload.session_id,
      confidence: verdict.p ?? null,
    });
  }
} catch {
  // Fail open: the gate must never be the reason a session breaks.
}
process.exit(0);
