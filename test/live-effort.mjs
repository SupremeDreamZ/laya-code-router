// Live per-step effort against the real API, through the real launcher and real local LAYA weights.
// One short headless `laya-claude -p` run on a private proxy (LAYA_NO_DAEMON=1), so it runs this
// checkout's code whatever the app's daemon is running, with its events kept in a file. The prompt
// makes several read-only Bash calls, so the tool loop reaches the continuations where LAYA is asked
// about effort (the 4th, 8th, ...). A handful of small requests on your plan; no API key.
//
// What it checks, from the events the proxy wrote: at least two effort levels within the one session,
// no request refused (status >= 400), and, for each request after a change of level, the cache write
// next to the cache read, because a level change must not make the whole prefix a cache write.
//
//   node test/live-effort.mjs                     events go to $TMPDIR/laya-live-effort-events.jsonl
//   node test/live-effort.mjs --design            a design-worded task whose opening turn scores hard
//   node test/live-effort.mjs --steps 9           how many read-only calls (default 6)
//   LAYA_EVENTS_FILE=/path node test/live-effort.mjs
import { spawn } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const events = process.env.LAYA_EVENTS_FILE || join(tmpdir(), "laya-live-effort-events.jsonl");
rmSync(events, { force: true });

const design = process.argv.includes("--design");
const stepsAt = process.argv.indexOf("--steps");
const steps = stepsAt > 0 ? Number(process.argv[stepsAt + 1]) : 6;
const files = ["src/pricing.mjs", "src/prefs.mjs", "src/wire.mjs", "src/limits.mjs", "src/policy.mjs", "src/status.mjs", "src/log.mjs", "src/timing.mjs", "src/usage.mjs"].slice(0, steps);
const investigate = process.argv.includes("--investigate");
const prompt = investigate
  ? "Users report that routing decisions sometimes silently stop being applied, and nobody knows why: the cause is unknown " +
    "and could be in any of several modules. Investigate it. Read these files with cat, each as its own separate Bash tool " +
    `call, one at a time, waiting for each result before the next: ${files.join(", ")}. Then say which module you suspect and what you would check next.`
  : design
  ? "Review the routing design in this repository for cross-module race conditions and design flaws. Read these files " +
    `with cat, each as its own separate Bash tool call, one at a time, waiting for each result before the next: ${files.join(", ")}. ` +
    "Then give a three-sentence assessment."
  : `Read these files with cat, each as its own separate Bash tool call, one at a time, waiting for each result before the next: ${files.join(", ")}. ` +
    "Then reply with one short line naming the file with the most lines.";

// A run started from inside another Claude Code session must not look like a child of it.
const env = { ...process.env, LAYA_NO_DAEMON: "1", LAYA_EVENTS_FILE: events };
delete env.LAYA_STEP_ROUTING;
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
    "--max-turns", String(steps + 6),
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
let previous = null;
for (const [i, e] of lines.entries()) {
  const changed = previous !== null && e.effort !== previous;
  previous = e.effort;
  console.log(
    [
      String(i + 1).padStart(2),
      String(e.status ?? "?"),
      String(e.class).padEnd(9),
      String(e.model).padEnd(18),
      `effort=${String(e.effort).padEnd(6)}`,
      `top=${String(e.effortTop ?? e.effort).padEnd(6)}`,
      `msgs=${e.effortMsgs ?? 0}`,
      String(e.effortReason).padEnd(34),
      e.usage ? `cacheRead=${e.usage.cacheRead} cacheWrite=${e.usage.cacheWrite} in=${e.usage.input} out=${e.usage.output}` : "usage=?",
      changed ? "<- level changed on this request" : "",
    ].join("  "),
  );
}
const levels = new Set(lines.map((e) => e.effort).filter(Boolean));
const refused = lines.filter((e) => e.status >= 400);
const ok = code === 0 && result && !result.is_error && levels.size >= 2 && refused.length === 0;
console.log(`\n${ok ? "PASS" : "FAIL"}: effort levels seen ${JSON.stringify([...levels])}, ${refused.length} request(s) with status >= 400, run ${result?.is_error ? "errored" : "completed"}`);
process.exit(ok ? 0 : 1);
