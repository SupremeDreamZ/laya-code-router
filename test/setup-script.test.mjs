// setup.sh and the start script, run against a throwaway HOME with stand-ins for every tool that
// could touch this machine (launchctl, pkill, npm, open, swiftc...). Nothing here starts a real
// service, and each test reads back what was *called*, which is the only thing a stand-in can prove.
// What the real launchctl does with the same sequence is checked separately, against a real
// throwaway job, in the "real launchctl" test at the end.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

const REPO = new URL("..", import.meta.url).pathname;
const SETUP = join(REPO, "setup.sh");
const START = join(REPO, "apps", "LayaBar", "start.sh");
const LABEL = "io.github.supremedreamz.laya";
const OLD_LABEL = "com.supreme.laya";
const FAKE_CLAUDE = join(REPO, "test", "fixtures", "fake-claude");
const FAKE_LAUNCHCTL = join(REPO, "test", "fixtures", "fake-launchctl");

/**
 * A throwaway HOME whose PATH starts with stand-ins. `pkill`, `npm`, `open` and `sleep` only record
 * that they were called, and with what: a `sleep` that returns at once makes the pacing of a
 * script countable (how many pauses, how long each) instead of something only a clock could see. `launchctl` remembers whether the job is loaded and, like the real one, takes
 * a moment to finish removing a job after `bootout`; see test/fixtures/fake-launchctl.
 */
function sandbox({ tools = ["pkill", "npm", "open", "sleep"] } = {}) {
  const home = mkdtempSync(join(tmpdir(), "laya-setup-"));
  const shim = join(home, "shim");
  const log = join(home, "calls.log");
  mkdirSync(shim, { recursive: true });
  writeFileSync(log, "");
  for (const tool of tools) {
    writeFileSync(join(shim, tool), `#!/bin/sh\necho "${tool} $*" >> "${log}"\nexit 0\n`, { mode: 0o755 });
  }
  const launchd = join(home, "launchd");
  mkdirSync(launchd, { recursive: true });
  writeFileSync(join(shim, "launchctl"),
    `#!/bin/sh\nexport FAKE_LAUNCHCTL_DIR="${launchd}" FAKE_LAUNCHCTL_LOG="${log}"\nexec "${FAKE_LAUNCHCTL}" "$@"\n`, { mode: 0o755 });
  const agents = join(home, "Library", "LaunchAgents");
  mkdirSync(agents, { recursive: true });
  const data = join(home, ".laya-router");
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, "usage.json"), '{"days":{}}');
  writeFileSync(join(home, ".laya-router.env"), "LAYA_PYTHON=/somewhere/python\n");
  return {
    home, shim, log, agents, data,
    calls: () => readFileSync(log, "utf8").split("\n").filter(Boolean),
    count: (prefix) => readFileSync(log, "utf8").split("\n").filter((c) => c.startsWith(prefix)).length,
    pauses: () => readFileSync(log, "utf8").split("\n").filter((c) => c.startsWith("sleep ")).map((c) => c.slice(6)),
    /** Sets the scene for the stand-in launchctl: see its header for the names. */
    launchd: {
      set: (name, value) => writeFileSync(join(launchd, name), String(value)),
      loaded: () => existsSync(join(launchd, "loaded")),
    },
    env: (extra = {}) => ({
      HOME: home, PATH: `${shim}:/usr/bin:/bin:${process.execPath.replace(/\/node$/, "")}`,
      LAYA_START_PAUSE: "0.01", LAYA_START_TRIES: "40", // a pause measured in milliseconds, not the real quarter second
      ...extra,
    }),
  };
}
const run = (script, args, s, extra = {}) =>
  spawnSync("bash", [script, ...args], { env: s.env(extra), encoding: "utf8", timeout: 60_000 });

function installFakeApp(s) {
  mkdirSync(join(s.home, "Applications", "LayaBar.app", "Contents", "MacOS"), { recursive: true });
  writeFileSync(join(s.agents, `${LABEL}.plist`), "<plist/>");
}

// ------------------------------------------------------------------ --uninstall

test("--uninstall runs to the end and exits 0", () => {
  const s = sandbox();
  installFakeApp(s);
  const r = run(SETUP, ["--uninstall"], s);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(!/command not found/.test(r.stderr), r.stderr);
});

test("--uninstall stops and removes the login item that install.sh actually writes", () => {
  const s = sandbox();
  installFakeApp(s);
  run(SETUP, ["--uninstall"], s);
  const stopped = s.calls().filter((c) => c.startsWith("launchctl"));
  assert.ok(stopped.some((c) => c.includes(LABEL)), `no launchctl call named ${LABEL}: ${stopped.join(" | ")}`);
  assert.ok(!existsSync(join(s.agents, `${LABEL}.plist`)), "the plist is still there");
});

test("--uninstall also clears the label the first private build used", () => {
  const s = sandbox();
  installFakeApp(s);
  writeFileSync(join(s.agents, `${OLD_LABEL}.plist`), "<plist/>");
  run(SETUP, ["--uninstall"], s);
  assert.ok(!existsSync(join(s.agents, `${OLD_LABEL}.plist`)));
});

test("--uninstall removes the app and the CLI links, and says so", () => {
  const s = sandbox();
  installFakeApp(s);
  const r = run(SETUP, ["--uninstall"], s);
  assert.ok(!existsSync(join(s.home, "Applications", "LayaBar.app")));
  assert.ok(s.calls().some((c) => /^pkill .*LayaBar/.test(c)), s.calls().join(" | "));
  assert.ok(s.calls().some((c) => /^npm unlink/.test(c)));
  assert.match(r.stdout, /Removed the app/);
});

test("--uninstall leaves the person's settings, usage and interpreter file alone", () => {
  const s = sandbox();
  installFakeApp(s);
  const r = run(SETUP, ["--uninstall"], s);
  assert.equal(readFileSync(join(s.data, "usage.json"), "utf8"), '{"days":{}}');
  assert.ok(existsSync(join(s.home, ".laya-router.env")));
  assert.match(r.stdout, /untouched/);
});

test("--uninstall on a machine where nothing was installed is not an error", () => {
  const s = sandbox();
  const r = run(SETUP, ["--uninstall"], s);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("--uninstall only ever touches this HOME", () => {
  const s = sandbox();
  installFakeApp(s);
  run(SETUP, ["--uninstall"], s);
  // The real home is looked up, not written down: a test that names one person's account would carry
  // that name into every clone, and would pass on any other machine for the wrong reason.
  const realHome = userInfo().homedir;
  for (const call of s.calls()) assert.ok(!call.includes(realHome), call);
});

// ------------------------------------------------------------------ start.sh

test("start.sh refuses to start what was never installed, and says what to run first", () => {
  const s = sandbox();
  const r = run(START, [], s);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /install\.sh/);
  assert.equal(s.calls().length, 0, "it must not have called anything");
});

test("start.sh loads the login item into this person's session and opens the app", () => {
  const s = sandbox();
  installFakeApp(s);
  const r = run(START, [], s);
  assert.equal(r.status, 0, r.stderr);
  const calls = s.calls();
  const boot = calls.find((c) => c.startsWith("launchctl bootstrap"));
  assert.ok(boot, calls.join(" | "));
  assert.match(boot, /launchctl bootstrap gui\/\d+ .*io\.github\.supremedreamz\.laya\.plist$/);
  assert.ok(s.launchd.loaded(), "and the job is now loaded");
  assert.ok(calls.some((c) => c.startsWith("open ") && c.includes("LayaBar.app")), calls.join(" | "));
});

test("start.sh clears a copy that is already loaded first, so running it twice works", () => {
  const s = sandbox();
  installFakeApp(s);
  s.launchd.set("loaded", 1);
  const r = run(START, [], s);
  assert.equal(r.status, 0, r.stderr);
  const calls = s.calls();
  const out = calls.findIndex((c) => c.startsWith("launchctl bootout") && c.includes(LABEL));
  const inn = calls.findIndex((c) => c.startsWith("launchctl bootstrap"));
  assert.ok(out >= 0 && inn > out, `bootout must come before bootstrap: ${calls.join(" | ")}`);
  assert.ok(s.launchd.loaded());
});

test("start.sh carries on when there was nothing loaded to clear, and does not wait for nothing", () => {
  const s = sandbox();
  installFakeApp(s);
  const r = run(START, [], s);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(s.count("launchctl print"), 1, "one look to see that it is gone, and no waiting");
  assert.equal(s.count("launchctl bootstrap"), 1);
});

// Measured on a real Mac (2026-09-30): `bootout` returns in 50 ms while launchd is still removing
// the job, `print` still lists it, and a `bootstrap` in that window fails with "5: Input/output
// error". Quick enough to never show on a fast machine, certain to show on a slow one.
test("start.sh waits for the old copy to finish going away instead of racing it", () => {
  const s = sandbox();
  installFakeApp(s);
  s.launchd.set("loaded", 1);
  s.launchd.set("linger_after_bootout", 6);
  const r = run(START, [], s);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(s.launchd.loaded(), "the job is loaded in the end");
  assert.equal(s.count("launchctl print"), 7, "six looks that still saw it, then one that did not");
  assert.deepEqual(s.pauses(), Array(6).fill("0.01"), "one pause per look that still saw it");
  assert.equal(s.count("launchctl bootstrap"), 1, "it must not hammer bootstrap while the old copy is still going");
});

test("start.sh retries when launchd still refuses a moment after the listing says the job is gone", () => {
  const s = sandbox();
  installFakeApp(s);
  s.launchd.set("bootstrap_fail", 3);
  const r = run(START, [], s);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(s.count("launchctl bootstrap"), 4, "three refusals, then it took");
  assert.deepEqual(s.pauses(), Array(3).fill("0.01"), "a pause after each refusal, none after the success");
  assert.ok(s.launchd.loaded());
  assert.ok(s.calls().some((c) => c.startsWith("open ")), "and the app was opened once it had worked");
});

test("start.sh gives up after a bounded number of tries, and says what launchctl said", () => {
  const s = sandbox();
  installFakeApp(s);
  s.launchd.set("bootstrap_fail", 9999);
  const r = run(START, [], s, { LAYA_START_TRIES: "5" });
  assert.notEqual(r.status, 0);
  assert.equal(s.count("launchctl bootstrap"), 5, "exactly the number it was told to try");
  assert.match(r.stderr, /Bootstrap failed: 5: Input\/output error/, "launchctl's own words, not just ours");
  assert.match(r.stderr, /Login Items/);
  assert.ok(!s.calls().some((c) => c.startsWith("open ")), "it must not claim success by opening the app");
  assert.ok(!/router started/.test(r.stdout));
});

test("start.sh does not wait forever for a copy that will not go away", () => {
  const s = sandbox();
  installFakeApp(s);
  s.launchd.set("loaded", 1);
  s.launchd.set("linger_after_bootout", 9999);
  const r = run(START, [], s, { LAYA_START_TRIES: "6" });
  assert.notEqual(r.status, 0);
  assert.equal(s.count("launchctl print"), 6, "exactly the bound it was given");
  assert.equal(s.pauses().length, 5, "a pause between looks, none after the last");
  // Giving up means giving up: trying to load it anyway would double the wait and print a second,
  // different complaint about the same problem.
  assert.equal(s.count("launchctl bootstrap"), 0, "it went on to bootstrap after giving up on the wait");
  assert.match(r.stderr, /would not finish stopping/);
  assert.ok(!/Input\/output error/.test(r.stderr), "only one complaint, and it is the first one");
  assert.ok(!s.calls().some((c) => c.startsWith("open ")));
});

test("the pause is the one asked for in LAYA_START_PAUSE, and a quarter second when nothing is asked", () => {
  for (const [asked, expected] of [["0.37", "0.37"], [undefined, "0.25"]]) {
    const s = sandbox();
    installFakeApp(s);
    s.launchd.set("bootstrap_fail", 2);
    const env = s.env();
    if (asked === undefined) delete env.LAYA_START_PAUSE; else env.LAYA_START_PAUSE = asked;
    const r = spawnSync("sh", [START], { env, encoding: "utf8", timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(s.pauses(), [expected, expected], `asked ${asked}`);
  }
});

test("the number of tries is the one asked for in LAYA_START_TRIES, and sixty when nothing is asked", () => {
  const s = sandbox();
  installFakeApp(s);
  s.launchd.set("bootstrap_fail", 9999);
  const env = s.env();
  delete env.LAYA_START_TRIES;
  const r = spawnSync("sh", [START], { env, encoding: "utf8", timeout: 60_000 });
  assert.notEqual(r.status, 0);
  assert.equal(s.count("launchctl bootstrap"), 60);
});

test("start.sh does not retry what it was not asked to retry: an unknown failure is reported at once", () => {
  const s = sandbox();
  installFakeApp(s);
  writeFileSync(join(s.shim, "launchctl"), `#!/bin/sh\necho "launchctl $*" >> "${s.log}"\ncase "$1" in bootstrap) echo "Bootstrap failed: 113: Could not find specified service" >&2; exit 113;; esac\nexit 3\n`, { mode: 0o755 });
  const r = run(START, [], s);
  assert.notEqual(r.status, 0);
  assert.equal(s.count("launchctl bootstrap"), 1);
  assert.match(r.stderr, /Could not find specified service/);
});

test("start.sh without the app bundle still starts the router, and says the app is missing", () => {
  const s = sandbox();
  writeFileSync(join(s.agents, `${LABEL}.plist`), "<plist/>");
  const r = run(START, [], s);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(s.calls().some((c) => c.startsWith("launchctl bootstrap")));
  assert.ok(!s.calls().some((c) => c.startsWith("open ")));
  assert.match(r.stdout + r.stderr, /app/i);
});

// ------------------------------------------------------------------ --check (changes nothing)

function checkEnv(s, { claude, python = true } = {}) {
  if (python) {
    writeFileSync(join(s.shim, "python3"), '#!/bin/sh\ncase "$*" in *platform*) echo 3.12.1;; esac\nexit 0\n', { mode: 0o755 });
  }
  const extra = {};
  if (claude) extra.LAYA_CLAUDE_BIN = join(s.shim, "claude");
  return extra;
}

function fakeClaude(s, state) {
  const stateFile = join(s.home, "claude-state");
  writeFileSync(stateFile, state);
  writeFileSync(join(s.shim, "claude"), `#!/bin/sh\nexport FAKE_CLAUDE_STATE="${stateFile}"\nexec "${FAKE_CLAUDE}" "$@"\n`, { mode: 0o755 });
  chmodSync(join(s.shim, "claude"), 0o755);
}

test("--check says Claude Code is signed in, and stops before changing anything", () => {
  const s = sandbox();
  fakeClaude(s, "signed-in");
  const r = run(SETUP, ["--check"], s, checkEnv(s, { claude: true }));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Claude Code is signed in/);
  assert.ok(!/Installing|npm install|venv|Building/.test(r.stdout), "it went on to install");
  assert.equal(s.calls().filter((c) => /^npm /.test(c)).length, 0, s.calls().join(" | "));
});

test("--check on a signed-out machine says how to sign in, and still exits 0: it is a next step, not a failure", () => {
  const s = sandbox();
  fakeClaude(s, "signed-out");
  const r = run(SETUP, ["--check"], s, checkEnv(s, { claude: true }));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /not signed in/i);
  assert.match(r.stdout, /claude auth login/);
  assert.match(r.stdout, /menu-bar app/i);
});

test("--check with no Claude Code says how to install it and sign in", () => {
  const s = sandbox();
  const r = run(SETUP, ["--check"], s, { ...checkEnv(s), LAYA_CLAUDE_BIN: join(s.home, "nowhere", "claude") });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /npm install -g @anthropic-ai\/claude-code/);
  assert.match(r.stdout, /claude auth login/);
});

test("--check prints nothing personal from the sign-in check", () => {
  const s = sandbox();
  fakeClaude(s, "signed-in");
  const r = run(SETUP, ["--check"], s, checkEnv(s, { claude: true }));
  for (const secret of ["someone@example.com", "org-0000-invented", "Invented Studio", "/Users/someone"]) {
    assert.ok(!(r.stdout + r.stderr).includes(secret), `${secret} was printed`);
  }
});

// ------------------------------------------------------------------ the wording a stranger reads last

test("setup asks Claude Code's state twice, at the start and again at the end, from the one place that words it", () => {
  const text = readFileSync(SETUP, "utf8");
  const asks = text.split("\n").filter((l) => l.includes("src/account.mjs") && l.includes("--hint"));
  assert.equal(asks.length, 2, asks.join("\n"));
  // Signing in can happen while the model downloads, so the last thing printed must be fresh.
  assert.ok(text.lastIndexOf("--hint") > text.indexOf("Warming the model"), "the final check must come after the long steps");
  assert.ok(!/claude auth login/.test(text), "the sign-in wording belongs in src/account.mjs, not copied here");
});

test("the label of the first private build appears only where it is being retired", () => {
  const lines = readFileSync(SETUP, "utf8").split("\n").filter((l) => l.includes("com.supreme.laya"));
  assert.equal(lines.length, 1, lines.join("\n"));
  assert.match(lines[0], /^OLD_LABEL=/);
});

test("nothing in setup.sh asks anyone to paste a key or a token into it", () => {
  const text = readFileSync(SETUP, "utf8");
  assert.ok(!/read -s|read -p|ANTHROPIC_API_KEY|sk-ant/.test(text));
});

// ------------------------------------------------------------------ the real launchctl

test("real launchctl: the start sequence loads a job, runs it, and survives being run twice", { skip: process.platform !== "darwin" }, () => {
  const uid = spawnSync("id", ["-u"], { encoding: "utf8" }).stdout.trim();
  const label = `io.github.supremedreamz.laya-test-${process.pid}`;
  const dir = mkdtempSync(join(tmpdir(), "laya-launchd-"));
  const marker = join(dir, "ran");
  const plist = join(dir, `${label}.plist`);
  writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array><string>/bin/sh</string><string>-c</string><string>echo started >> '${marker}'; exec sleep 60</string></array>
  <key>RunAtLoad</key><true/>
</dict></plist>`);
  const launchctl = (...args) => spawnSync("launchctl", args, { encoding: "utf8" });
  try {
    for (const attempt of [1, 2]) {
      launchctl("bootout", `gui/${uid}/${label}`); // may have nothing to remove: that is allowed
      const loaded = launchctl("bootstrap", `gui/${uid}`, plist);
      assert.equal(loaded.status, 0, `attempt ${attempt}: ${loaded.stderr}`);
      const starts = () => (existsSync(marker) ? readFileSync(marker, "utf8").split("\n").filter(Boolean).length : 0);
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline && starts() < attempt) spawnSync("sleep", ["0.2"]);
      assert.equal(starts(), attempt, `attempt ${attempt}: the job did not start`);
    }
  } finally {
    launchctl("bootout", `gui/${uid}/${label}`);
  }
  assert.notEqual(launchctl("print", `gui/${uid}/${label}`).status, 0, "the job was not removed");
});

test("real launchd: running start.sh over a job that is slow to stop still ends with the job running", { skip: process.platform !== "darwin" }, () => {
  const uid = spawnSync("id", ["-u"], { encoding: "utf8" }).stdout.trim();
  const label = `io.github.supremedreamz.laya-race-${process.pid}`;
  const home = mkdtempSync(join(tmpdir(), "laya-race-"));
  const agents = join(home, "Library", "LaunchAgents");
  mkdirSync(agents, { recursive: true });
  const log = join(home, "log");
  // A job that takes 2 seconds to die once asked to, which is a daemon holding a warm model on a
  // busy machine as far as launchd can tell.
  const plist = join(agents, `${label}.plist`);
  writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array><string>/bin/sh</string><string>-c</string><string>echo up $$ >> '${log}'; trap 'sleep 2; echo down $$ >> "${log}"; exit 0' TERM; while :; do sleep 0.2; done</string></array>
  <key>RunAtLoad</key><true/>
</dict></plist>`);
  // The real script, with only the label changed to the throwaway one. Everything else is as shipped.
  const script = join(home, "start.sh");
  writeFileSync(script, readFileSync(START, "utf8").replace(/^LABEL=.*$/m, `LABEL="${label}"`), { mode: 0o755 });
  const launchctl = (...args) => spawnSync("launchctl", args, { encoding: "utf8" });
  const env = { HOME: home, PATH: process.env.PATH };
  const ups = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((l) => l.startsWith("up")).length : 0);
  try {
    const first = spawnSync("sh", [script], { env, encoding: "utf8", timeout: 60_000 });
    assert.equal(first.status, 0, `first start: ${first.stdout}${first.stderr}`);
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && ups() < 1) spawnSync("sleep", ["0.2"]);
    assert.equal(ups(), 1, "the first start did not run the job");

    const second = spawnSync("sh", [script], { env, encoding: "utf8", timeout: 60_000 });
    assert.equal(second.status, 0, `second start, straight after the first: ${second.stdout}${second.stderr}`);
    const deadline2 = Date.now() + 8000;
    while (Date.now() < deadline2 && ups() < 2) spawnSync("sleep", ["0.2"]);
    assert.equal(ups(), 2, "the second start did not leave a job running");
    assert.match(launchctl("print", `gui/${uid}/${label}`).stdout, /state = running/);
  } finally {
    launchctl("bootout", `gui/${uid}/${label}`);
  }
});

// ------------------------------------------------------------------ the login item's priority
//
// Measured on a real Mac (2026-10-01), the same daemon and routing model started as three real
// launchd jobs that differ only in ProcessType, on a machine with every core busy:
//   Background (what install.sh used to write)  one routing decision stalled 95.6 s, until the load ended
//   Standard                                    worst decision 2.9 s
//   Interactive                                 worst decision 0.27 s
// The same stall showed on the real daemon (31.7 s), and its 5-minute usage check took 8.6 s where a
// terminal takes 0.8 s. A routing decision sits in front of every prompt, so this job is not
// background work, and what is pinned here is the thing that matters: how the OS schedules the
// process launchd starts from the file install.sh writes, not what the file says.

/** The login item exactly as install.sh writes it, with its two shell variables filled in. */
function loginItemPlist(home) {
  const text = readFileSync(join(REPO, "apps", "LayaBar", "install.sh"), "utf8");
  const open = 'cat > "$AGENT" <<PLIST\n';
  const at = text.indexOf(open);
  assert.ok(at >= 0, "install.sh no longer writes the login item this way: update this test with it");
  const rest = text.slice(at + open.length);
  const end = rest.indexOf("\nPLIST\n");
  assert.ok(end >= 0, "could not find the end of the login item in install.sh");
  const r = spawnSync("sh", ["-c", `PLIST_BODY=/bin/sleep HOME='${home}'; cat <<PLIST\n${rest.slice(0, end)}\nPLIST\n`], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

test("real launchd: the login item install.sh writes is scheduled like an app, not throttled to background", { skip: process.platform !== "darwin" }, () => {
  const uid = spawnSync("id", ["-u"], { encoding: "utf8" }).stdout.trim();
  const dir = mkdtempSync(join(tmpdir(), "laya-prio-"));
  mkdirSync(join(dir, ".laya-router"), { recursive: true });
  const written = join(dir, "written.plist");
  writeFileSync(written, loginItemPlist(dir));
  const parsed = spawnSync("plutil", ["-convert", "json", "-o", "-", written], { encoding: "utf8" });
  assert.equal(parsed.status, 0, `the file install.sh writes is not a valid plist: ${parsed.stderr}`);
  const base = JSON.parse(parsed.stdout);
  assert.equal(base.Label, LABEL, "this is the login item that Laya starts at login");

  // The same job three times: as written, and as the two controls that say what the OS means by
  // Background and by Interactive on this machine. Only the program is changed (a sleep, so nothing
  // real starts) and the log paths (so nothing is written outside the temp folder).
  const variants = { written: base.ProcessType, background: "Background", interactive: "Interactive" };
  const labels = {};
  const pri = {};
  const launchctl = (...args) => spawnSync("launchctl", args, { encoding: "utf8" });
  try {
    for (const [name, processType] of Object.entries(variants)) {
      const label = `${LABEL}-prio-${name}-${process.pid}`;
      labels[name] = label;
      const job = { ...base, Label: label, ProgramArguments: ["/bin/sleep", "60"], StandardOutPath: "/dev/null", StandardErrorPath: "/dev/null" };
      if (processType === undefined) delete job.ProcessType; else job.ProcessType = processType;
      writeFileSync(join(dir, `${name}.json`), JSON.stringify(job));
      const made = spawnSync("plutil", ["-convert", "xml1", "-o", join(dir, `${name}.plist`), join(dir, `${name}.json`)], { encoding: "utf8" });
      assert.equal(made.status, 0, made.stderr);
      const loaded = launchctl("bootstrap", `gui/${uid}`, join(dir, `${name}.plist`));
      assert.equal(loaded.status, 0, `${name}: ${loaded.stderr}`);
    }
    for (const name of Object.keys(variants)) {
      let pid = null;
      for (const deadline = Date.now() + 8000; Date.now() < deadline && !pid; spawnSync("sleep", ["0.2"])) {
        pid = /\bpid = (\d+)/.exec(launchctl("print", `gui/${uid}/${labels[name]}`).stdout)?.[1] ?? null;
      }
      assert.ok(pid, `${name}: the job did not start`);
      pri[name] = Number(spawnSync("ps", ["-o", "pri=", "-p", pid], { encoding: "utf8" }).stdout.trim());
      assert.ok(Number.isFinite(pri[name]), `${name}: could not read its priority`);
    }
  } finally {
    for (const label of Object.values(labels)) launchctl("bootout", `gui/${uid}/${label}`);
  }
  assert.ok(pri.interactive > pri.background, `this machine does not tell Interactive (${pri.interactive}) from Background (${pri.background}), so this test proves nothing`);
  assert.ok(pri.written > pri.background, `the login item runs at the background priority (${pri.written}, the same as Background ${pri.background}): ${JSON.stringify(pri)}`);
  assert.ok(pri.written >= pri.interactive, `the login item runs below an app (${pri.written} against ${pri.interactive}): ${JSON.stringify(pri)}`);
});
