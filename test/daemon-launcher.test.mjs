import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// bin/laya-daemon is what launchd runs. It has to find a Python that has `laya` installed, and on
// a stranger's Mac that is whatever setup.sh built, which is recorded in ~/.laya-router.env.
// Driven with a stand-in for node that prints what it was handed, so nothing real is started.
const REPO = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = join(REPO, "bin", "laya-daemon");

function world() {
  const home = mkdtempSync(join(tmpdir(), "laya-dmn-"));
  const node = join(home, "fake-node");
  writeFileSync(node, '#!/bin/sh\necho "PY=$LAYA_PYTHON"\n');
  chmodSync(node, 0o755);
  const exe = (rel) => {
    const p = join(home, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, "#!/bin/sh\n");
    chmodSync(p, 0o755);
    return p;
  };
  const run = (env = {}) => {
    const clean = { PATH: "/usr/bin:/bin", HOME: home, LAYA_NODE: node, ...env };
    return execFileSync("/bin/sh", [SCRIPT], { env: clean, encoding: "utf8" }).trim();
  };
  return { home, exe, run, envFile: (text) => writeFileSync(join(home, ".laya-router.env"), text) };
}

test("the interpreter named in ~/.laya-router.env is used", () => {
  const w = world();
  const py = w.exe("venvs/mine/bin/python");
  w.envFile(`LAYA_PYTHON=${py}\n`);
  assert.equal(w.run(), `PY=${py}`);
});

test("...and it beats an interpreter found by searching", () => {
  const w = world();
  w.exe("laya-venv/bin/python");
  const py = w.exe("venvs/mine/bin/python");
  w.envFile(`LAYA_PYTHON=${py}\n`);
  assert.equal(w.run(), `PY=${py}`);
});

test("a quoted path, with a space in it, is read correctly", () => {
  const w = world();
  const py = w.exe("my venvs/mine/bin/python");
  w.envFile(`LAYA_PYTHON="${py}"\n`);
  assert.equal(w.run(), `PY=${py}`);
});

test("the last LAYA_PYTHON line wins, and comments are ignored", () => {
  const w = world();
  const a = w.exe("a/bin/python");
  const b = w.exe("b/bin/python");
  w.envFile(`# LAYA_PYTHON=/nope\nLAYA_PYTHON=${a}\nLAYA_PYTHON=${b}\n`);
  assert.equal(w.run(), `PY=${b}`);
});

test("an environment variable beats the file", () => {
  const w = world();
  const fromFile = w.exe("f/bin/python");
  const fromEnv = w.exe("e/bin/python");
  w.envFile(`LAYA_PYTHON=${fromFile}\n`);
  assert.equal(w.run({ LAYA_PYTHON: fromEnv }), `PY=${fromEnv}`);
});

test("the venv setup.sh builds is found with no file at all", () => {
  const w = world();
  const py = w.exe(".laya-router/venv/bin/python");
  assert.equal(w.run(), `PY=${py}`);
});

test("a venv inside a custom LAYA_HOME is found too", () => {
  const w = world();
  const py = w.exe("elsewhere/venv/bin/python");
  assert.equal(w.run({ LAYA_HOME: join(w.home, "elsewhere") }), `PY=${py}`);
});

test("a file entry that points at nothing is skipped rather than trusted", () => {
  const w = world();
  const py = w.exe(".laya-router/venv/bin/python");
  w.envFile("LAYA_PYTHON=/definitely/not/here/python\n");
  assert.equal(w.run(), `PY=${py}`);
});

test("nothing found at all falls back to a system python3, never to an invented path", () => {
  const w = world();
  // The last resort is the system's own python3: either found on PATH by name, or at the fixed
  // Homebrew location the script has always tried. A test in a temp dir cannot hide a system
  // path, so both are legitimate; what must never happen is a path under the user's home that
  // does not exist.
  const got = w.run();
  assert.match(got, /^PY=(python3|\/opt\/homebrew\/bin\/python3)$/);
  assert.ok(!got.includes(w.home), "no path inside the (empty) home was invented");
});
