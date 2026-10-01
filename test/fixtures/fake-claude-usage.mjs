#!/usr/bin/env node
// Stand-in for `claude`, for tests. It answers `auth status`, and the usage probe `-p /usage` the
// way the real one behaves, as measured on 2026-09-30:
//   - a probe that can reach Anthropic refreshes the usage cache in the config file, with the time
//     it was fetched beside it, and prints a text that is NOT what is read (so a test that reads
//     the text instead of the cache fails);
//   - offline, or with CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC set, it leaves the cache as it was
//     and prints the old figure without saying so.
//
//   FAKE_USAGE_SCENARIO  JSON file the test rewrites between calls:
//                        { fetch: false to behave offline, five, week (percent), fiveInMs, weekInMs
//                          (until each resets), fiveAtMs / weekAtMs (an exact reset instant,
//                          which wins over the "until"), signedOut, hangMs, exitCode }
//   FAKE_CLAUDE_LOG      file that gets one line of arguments per call
//   FAKE_USAGE_ENVLOG    file that gets one line per probe naming the variables the probe was given
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const argv = process.argv.slice(2);
const env = process.env;
if (env.FAKE_CLAUDE_LOG) appendFileSync(env.FAKE_CLAUDE_LOG, `${argv.join(" ")}\n`);

let scenario = {};
try {
  scenario = JSON.parse(readFileSync(env.FAKE_USAGE_SCENARIO, "utf8"));
} catch {
  // no scenario: the defaults below
}

if (!(argv[0] === "-p" && argv[1] === "/usage")) {
  // `auth status`. Personal-looking fields are printed on purpose, so a test can prove none get through.
  if (scenario.signedOut) {
    process.stdout.write('{"loggedIn":false,"authMethod":"none"}\n');
    process.exit(1);
  }
  process.stdout.write('{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max","email":"PERSONAL@example.com"}\n');
  process.exit(0);
}

const quiet = env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC === "1";
if (env.FAKE_USAGE_ENVLOG) {
  appendFileSync(env.FAKE_USAGE_ENVLOG, `${JSON.stringify({ telemetry: env.DISABLE_TELEMETRY ?? null, errors: env.DISABLE_ERROR_REPORTING ?? null, quiet: env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC ?? null, user: env.USER ?? null })}\n`);
}
if (scenario.hangMs) await new Promise((r) => setTimeout(r, scenario.hangMs));

const file = join(env.CLAUDE_CONFIG_DIR || homedir(), ".claude.json");
if (scenario.fetch !== false && !quiet) {
  let config = {};
  try {
    config = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    // a fresh machine: the file is made
  }
  const at = Date.now();
  const iso = (ms) => new Date(ms).toISOString().replace("Z", "+00:00");
  const win = (pct, inMs, atMs) => (pct == null ? null : { utilization: pct, resets_at: iso(atMs ?? at + inMs), limit_dollars: null });
  config.cachedUsageUtilization = {
    fetchedAtMs: at,
    accountUuid: "PERSONAL-UUID",
    utilization: {
      five_hour: win(scenario.five ?? 42, scenario.fiveInMs ?? 2 * 3600_000, scenario.fiveAtMs),
      seven_day: win(scenario.week ?? 12, scenario.weekInMs ?? 3 * 86400_000, scenario.weekAtMs),
      seven_day_opus: null,
      extra_usage: { is_enabled: false },
    },
  };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(config));
}

// The text is deliberately wrong (99%), because it is not what is read. A parser that reads it
// instead of the cache shows 99% and fails the tests.
process.stdout.write(`${JSON.stringify({
  type: "result", is_error: false, subtype: "success", local_command: "usage",
  num_turns: 0, total_cost_usd: 0, modelUsage: {},
  result: "Current session: 99% used · resets Jan 1 at 1am (UTC)\nCurrent week (all models): 99% used · resets Jan 1 at 1am (UTC)",
})}\n`);
process.exit(scenario.exitCode ?? 0);
