// Live tool-result trimming against the real API, through the real launcher, on your plan (no API key).
// One `laya-claude -p` run on a private proxy (LAYA_NO_DAEMON=1, this checkout's code) with a LOW
// trim trigger so a handful of file reads crosses it. The prompt reads six source files, one Bash
// call each, so the prompt grows past the trigger and the API should report what it cleared.
//
//   node test/live-trim.mjs                 trimming on (the thing under test)
//   node test/live-trim.mjs --off           same run with trimming off, for the usage comparison
import { spawn } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const off = process.argv.includes("--off");
const events = process.env.LAYA_EVENTS_FILE || join(tmpdir(), `laya-live-trim${off ? "-off" : ""}-events.jsonl`);
rmSync(events, { force: true });

const files = ["src/proxy.mjs", "src/daemon.mjs", "src/router.mjs", "src/policy.mjs", "src/laya_bridge.py", "src/wire.mjs"];
const prompt =
  "use sonnet. Read these files with cat, each as its own separate Bash tool call, one at a time, waiting for each " +
  `result before the next: ${files.join(", ")}. Then reply with one line naming the file that defines startProxy.`;

const env = {
  ...process.env,
  LAYA_NO_DAEMON: "1",
  LAYA_EVENTS_FILE: events,
  LAYA_TRIM: off ? "0" : "1",
  LAYA_TRIM_TRIGGER: "25000",
  LAYA_TRIM_KEEP: "1",
  LAYA_TRIM_JUMP: "3",
};
for (const key of Object.keys(env)) {
  if (key === "CLAUDECODE" || key === "CLAUDE_PID" || /^CLAUDE_CODE_(SESSION|CHILD|MESSAGING|ENTRYPOINT)/.test(key)) delete env[key];
}

const started = Date.now();
const child = spawn(
  process.execPath,
  [
    join(ROOT, "bin", "laya-claude.mjs"),
    "-p", prompt,
    "--output-format", "json",
    "--max-turns", "12",
    "--allowedTools", "Bash(cat src/*)",
  ],
  { cwd: ROOT, env, stdio: ["ignore", "pipe", "inherit"] },
);
let stdout = "";
child.stdout.on("data", (c) => (stdout += c));
const code = await new Promise((resolve) => child.on("exit", (c) => resolve(c)));

let result = null;
try {
  result = JSON.parse(stdout);
} catch {
  console.log(`could not read the run's JSON output:\n${stdout.slice(0, 2000)}`);
}
console.log(`trim ${off ? "OFF" : "ON"}: exit ${code} in ${Math.round((Date.now() - started) / 1000)}s`);
if (result) console.log(`is_error=${result.is_error} num_turns=${result.num_turns} result=${JSON.stringify(String(result.result ?? "").slice(0, 160))}`);

let lines = [];
try {
  lines = readFileSync(events, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
} catch {
  console.log(`no events at ${events}`);
}
console.log(`\n${lines.length} requests (events in ${events}):`);
let read = 0;
for (const e of lines) {
  const u = e.usage;
  if (u) read += u.input + u.cacheRead + u.cacheWrite;
  console.log(
    [
      String(e.status ?? "?"),
      String(e.class).padEnd(9),
      String(e.model).padEnd(20),
      e.trim ? "trim" : "    ",
      u ? `prompt=${u.input + u.cacheRead + u.cacheWrite} in=${u.input} cacheRead=${u.cacheRead} cacheWrite=${u.cacheWrite} out=${u.output}` : "usage=?",
      e.cleared ? `CLEARED ${e.cleared.tokens} tokens / ${e.cleared.toolUses} tool uses` : "",
    ].join("  "),
  );
}
const cleared = lines.filter((e) => e.cleared);
const refused = lines.filter((e) => e.status >= 400);
console.log(`\nprompt tokens summed over the run: ${read}`);
const ok = code === 0 && result && !result.is_error && refused.length === 0 && (off || cleared.length > 0);
console.log(`${ok ? "PASS" : "FAIL"}: ${cleared.length} request(s) trimmed, ${refused.length} with status >= 400`);
process.exit(ok ? 0 : 1);
