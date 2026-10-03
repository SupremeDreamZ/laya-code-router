// Loaded before every test file (`--import` in package.json). The suite runs on machines where the
// router is in daily use, often from inside a `laya-claude` session, so it must not read that
// person's settings, plan usage or debug switch: a proxy test that found the real prefs.json with
// step routing on, or the real limits.json at 90%, would test their state instead of the code.
// A test that wants a home of its own still sets LAYA_HOME itself, after this has run.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.LAYA_HOME) process.env.LAYA_HOME = mkdtempSync(join(tmpdir(), "laya-suite-"));
// Inherited from a `laya-claude` shell. Under it the proxy asks upstream for an uncompressed
// stream, which is exactly what the compression tests check it does not do.
delete process.env.LAYA_DEBUG;
delete process.env.LAYA_STEP_ROUTING;
