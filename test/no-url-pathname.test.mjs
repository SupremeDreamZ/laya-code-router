import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/// A file URL's `.pathname` is still percent-encoded, so a folder with a space in its name turns into
/// `my%20clone` and every path built from it points nowhere. Found 2026-10-01 by running the suite from a
/// fresh clone in such a folder: 193 tests failed, all from this one idiom in 14 test files.
/// Use `fileURLToPath(new URL(...))`, which decodes it.
const here = fileURLToPath(new URL(".", import.meta.url));
const SKIP = new Set(["no-url-pathname.test.mjs"]);

test("no test builds a file path from a URL's .pathname", () => {
  const offenders = [];
  for (const f of readdirSync(here).filter((n) => n.endsWith(".mjs") && !SKIP.has(n))) {
    readFileSync(join(here, f), "utf8").split("\n").forEach((line, i) => {
      if (/import\.meta\.url\)\s*\.pathname/.test(line)) offenders.push(`${f}:${i + 1}`);
    });
  }
  assert.deepEqual(offenders, []);
});

test("the guard can see the idiom it forbids", () => {
  assert.ok(/import\.meta\.url\)\s*\.pathname/.test('const A = new URL("..", import.meta.url).pathname;'));
  assert.ok(!/import\.meta\.url\)\s*\.pathname/.test('const A = fileURLToPath(new URL("..", import.meta.url));'));
});
