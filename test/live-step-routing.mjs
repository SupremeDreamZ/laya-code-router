// Live step routing against the real API, through the real launcher and real local LAYA weights.
// One short `laya-claude -p` run with step routing on, on a private proxy (LAYA_NO_DAEMON=1) so it
// runs this checkout's code whatever the app's daemon is running, with its events kept in a file.
// The prompt makes five read-only Bash calls, so the tool loop reaches the 4th continuation where a
// step check is due. A handful of small requests on your plan; no API key.
//
//   node test/live-step-routing.mjs            events go to $TMPDIR/laya-live-step-events.jsonl
//   LAYA_EVENTS_FILE=/path node test/live-step-routing.mjs
import { spawn } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const events = process.env.LAYA_EVENTS_FILE || join(tmpdir(), "laya-live-step-events.jsonl");
rmSync(events, { force: true });

// `--read-files`: a design-worded task (scored hard, so it starts high) whose steps read whole files.
// Big steps are what let a downgrade pay for its cache rebuild, so this is the run that can show a
// real mid-loop switch away from a model with thinking on. It costs more than the default run.
const readFiles = process.argv.includes("--read-files");
const prompt = readFiles
  ? "Review the routing design in this repository for cross-module race conditions. First read these five files " +
    "with cat, each as its own separate Bash tool call, one at a time, waiting for each result before the next: " +
    "src/pricing.mjs, src/prefs.mjs, src/wire.mjs, src/limits.mjs, src/policy.mjs. Then give a three-sentence assessment."
  : "Run these five shell commands, each as its own separate Bash tool call, one at a time, waiting for each " +
    "result before the next: `pwd`, then `ls`, then `ls src`, then `wc -l README.md`, then `date`. " +
    "Then reply with one short line saying how many lines README.md has.";

// A run started from inside another Claude Code session must not look like a child of it.
const env = { ...process.env, LAYA_NO_DAEMON: "1", LAYA_STEP_ROUTING: "1", LAYA_EVENTS_FILE: events };
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
    "--allowedTools", "Bash(pwd),Bash(ls:*),Bash(wc:*),Bash(date),Bash(cat src/*)",
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
console.log(`exit ${code} in ${Math.round((Date.now() - started) / 1000)}s`);
if (result) {
  console.log(`is_error=${result.is_error} subtype=${result.subtype} num_turns=${result.num_turns} result=${JSON.stringify(String(result.result ?? "").slice(0, 200))}`);
}

let lines = [];
try {
  lines = readFileSync(events, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
} catch {
  console.log(`no events at ${events}`);
}
console.log(`\n${lines.length} routed requests (events in ${events}):`);
for (const e of lines) {
  const s = e.step;
  console.log(
    [
      String(e.status ?? "?"),
      String(e.class).padEnd(9),
      String(e.model).padEnd(26),
      String(e.reason).padEnd(30),
      e.confidence != null ? `p=${e.confidence.toFixed(2)}` : "p=-   ",
      s ? `step ${s.from}->${s.to} (laya: ${s.target ?? s.from}) switched=${s.switched} saving=$${s.saving.toFixed(4)} rebuild=$${s.rebuild.toFixed(4)} ctx=${s.contextTokens} step=${JSON.stringify(s.stepTokens)}` : "",
      e.usage ? `usage in=${e.usage.input} out=${e.usage.output} cacheRead=${e.usage.cacheRead} cacheWrite=${e.usage.cacheWrite}` : "usage=?",
    ].join("  "),
  );
}
const steps = lines.filter((e) => e.class === "step");
const refused = lines.filter((e) => e.status >= 400);
const ok = code === 0 && result && !result.is_error && steps.length > 0 && refused.length === 0;
console.log(`\n${ok ? "PASS" : "FAIL"}: ${steps.length} step check(s), ${refused.length} request(s) with status >= 400, run ${result?.is_error ? "errored" : "completed"}`);
process.exit(ok ? 0 : 1);
