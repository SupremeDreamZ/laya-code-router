import { askLaya, getSidecar } from "../src/router.mjs";
import { tierFromScores } from "../src/policy.mjs";

// Live routing against real local LAYA weights. The first call pays the ~40s model
// load; the rest run warm. $0, no key.
const models = [
  { id: "claude-haiku-4-5-20251001", tier: "haiku", description: "Claude Haiku 4.5" },
  { id: "claude-sonnet-5", tier: "sonnet", description: "Claude Sonnet 5" },
  { id: "claude-opus-5", tier: "opus", description: "Claude Opus 5" },
];
const prompts = [
  "fix the typo 'recieve' in README.md",
  "add a unit test for the existing formatDate helper",
  "users intermittently get logged out after deploy, figure out why",
  "migrate the entire monorepo from webpack to vite",
];
getSidecar(); // warm the sidecar; the load happens on the first ask
for (const prompt of prompts) {
  const a = await askLaya({ prompt, current: "sonnet", contextTokens: 3000, models });
  if (!a) {
    console.log(`FAIL  ${prompt}`);
    continue;
  }
  const tier = tierFromScores(a.metrics) ?? "?";
  const parts = [a.metrics.taskComplexity, a.metrics.reasoningRequired, a.metrics.toolComplexity]
    .map((v) => (v ?? 0).toFixed(2))
    .join(" ");
  console.log(
    `${tier.padEnd(7)} conf=${(a.confidence ?? 0).toFixed(2)} ${String(a.ms).padStart(6)}ms | scores ${parts} | ${prompt}`,
  );
}
// The sidecar child keeps Node's event loop alive; without this the script finishes its
// work and then hangs forever, leaking the loaded weights as an orphan process.
process.exit(0);
