import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnvFiles, defaultEnvFiles } from "../src/envfile.mjs";

// The command-line launcher has always read ~/.laya-router.env. The background daemon did not, so
// anything a person put there (most importantly LAYA_PYTHON, which setup.sh writes) was invisible
// to the login-item daemon: routing would silently fail open on every machine but the author's.
const dir = () => mkdtempSync(join(tmpdir(), "laya-env-"));
const scrub = (...names) => names.forEach((n) => delete process.env[n]);

test("loads KEY=value pairs from the files that exist", () => {
  const d = dir();
  writeFileSync(join(d, "a.env"), "LAYA_TEST_ENV_A=one\nLAYA_TEST_ENV_B=\"two words\"\n");
  scrub("LAYA_TEST_ENV_A", "LAYA_TEST_ENV_B");
  const loaded = loadEnvFiles([join(d, "a.env"), join(d, "missing.env")]);
  assert.deepEqual(loaded, [join(d, "a.env")]);
  assert.equal(process.env.LAYA_TEST_ENV_A, "one");
  assert.equal(process.env.LAYA_TEST_ENV_B, "two words");
  scrub("LAYA_TEST_ENV_A", "LAYA_TEST_ENV_B");
});

test("a variable already in the environment wins over the file", () => {
  const d = dir();
  writeFileSync(join(d, "a.env"), "LAYA_TEST_ENV_C=from-file\n");
  process.env.LAYA_TEST_ENV_C = "from-shell";
  loadEnvFiles([join(d, "a.env")]);
  assert.equal(process.env.LAYA_TEST_ENV_C, "from-shell");
  scrub("LAYA_TEST_ENV_C");
});

test("the earlier file wins over a later one, as the launcher's order implies", () => {
  const d = dir();
  writeFileSync(join(d, "first.env"), "LAYA_TEST_ENV_D=first\n");
  writeFileSync(join(d, "second.env"), "LAYA_TEST_ENV_D=second\n");
  scrub("LAYA_TEST_ENV_D");
  loadEnvFiles([join(d, "first.env"), join(d, "second.env")]);
  assert.equal(process.env.LAYA_TEST_ENV_D, "first");
  scrub("LAYA_TEST_ENV_D");
});

test("nothing to load is not an error", () => {
  assert.deepEqual(loadEnvFiles([]), []);
  assert.deepEqual(loadEnvFiles([join(dir(), "nope.env")]), []);
});

test("a directory or garbage where a file should be is skipped, not thrown", () => {
  const d = dir();
  assert.deepEqual(loadEnvFiles([d]), []);
});

test("default files: the shared one first, then the legacy Claude-only one", () => {
  assert.deepEqual(defaultEnvFiles("/home/someone"), ["/home/someone/.laya-router.env", "/home/someone/.laya-claude.env"]);
});
