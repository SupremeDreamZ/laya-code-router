import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askFiles, expand, windows } from "../src/inspect.mjs";

test("windows cover the whole text, on line breaks where they can", () => {
  const text = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
  const w = windows(text, 300);
  assert.equal(w.join(""), text);
  assert.ok(w.every((p) => p.length <= 300));
  assert.deepEqual(windows(""), [""]);
});

test("expand takes files, directories and globs, and skips vendor dirs", () => {
  const dir = mkdtempSync(join(tmpdir(), "insp-"));
  mkdirSync(join(dir, "src", "deep"), { recursive: true });
  mkdirSync(join(dir, "node_modules", "x"), { recursive: true });
  for (const f of ["src/a.ts", "src/deep/b.ts", "src/c.js", "node_modules/x/d.ts"]) writeFileSync(join(dir, f), "x");
  const rel = (fs) => fs.map((f) => f.slice(dir.length + 1)).sort();
  assert.deepEqual(rel(expand(["src/**/*.ts"], dir)), ["src/a.ts", "src/deep/b.ts"]);
  assert.deepEqual(rel(expand(["src/*.ts"], dir)), ["src/a.ts"]);
  assert.deepEqual(rel(expand(["."], dir)), ["src/a.ts", "src/c.js", "src/deep/b.ts"]);
});

test("a file scores as its strongest window, ranked highest first; unreadable files say so", async () => {
  const dir = mkdtempSync(join(tmpdir(), "insp-"));
  writeFileSync(join(dir, "yes.txt"), `${"filler\n".repeat(400)}NEEDLE\n`);
  writeFileSync(join(dir, "no.txt"), "nothing here\n");
  const askLaya = async (state) => ({ q: { noul: state.includes("NEEDLE") ? 0.9 : 0.1 } });
  const r = await askFiles([join(dir, "no.txt"), join(dir, "yes.txt"), join(dir, "gone.txt")], "has a needle?", { askLaya, cwd: dir });
  assert.equal(r[0].file, "yes.txt");
  assert.equal(r[0].yes, 0.9);
  assert.ok(r[0].window > 1, "found in a later window, not just the head");
  assert.equal(r[1].yes, 0.1);
  assert.equal(r.at(-1).yes, null);
  assert.ok(r.at(-1).error);
});
