import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// LAYA truncates its input at 512 tokens, so the bridge sends a short digest. For a long paste the
// ask is usually at the start or the end, so the digest keeps both ends instead of only the start.
const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

function digest(text) {
  const code = `
import json, sys
sys.path.insert(0, ${JSON.stringify(SRC)})
import laya_bridge as B
print(json.dumps(B.task_digest(json.loads(sys.stdin.read()))))
`;
  return JSON.parse(execFileSync(process.env.LAYA_PYTHON || "python3", ["-c", code], { input: JSON.stringify(text) }).toString());
}

test("a short prompt is passed through unchanged, whitespace squashed", () => {
  assert.equal(digest("Rename   getUsr\n to getUser."), "Rename getUsr to getUser.");
});

test("a prompt at the 600 character limit is not cut", () => {
  const text = "a".repeat(600);
  assert.equal(digest(text), text);
});

test("a long prompt keeps its first 300 and last 300 characters, so an ask at the end is seen", () => {
  const head = "HEAD-" + "x".repeat(400);
  const tail = "y".repeat(400) + "-TAIL: find the root cause across services.";
  const out = digest(head + " " + "filler ".repeat(500) + tail);
  assert.ok(out.startsWith("HEAD-"));
  assert.ok(out.endsWith("find the root cause across services."));
  assert.ok(out.includes("[...]"));
  assert.ok(out.length <= 620);
});

test("a long prompt's middle is dropped, not its ends", () => {
  const out = digest("START " + "m".repeat(5000) + " END");
  assert.ok(out.startsWith("START"));
  assert.ok(out.endsWith("END"));
  assert.ok(!out.includes("m".repeat(400)));
});
