// Is Claude Code signed in? Laya asks Claude Code itself and keeps only what the app can use.
//
// Sign-in is Claude Code's own: Laya never sees, stores or asks for a credential. `claude auth
// status` is also chatty (it prints the account's email, organisation and config path), none of
// which belongs in a snapshot that any local subscriber receives, so what comes out of here is
// checked against a whitelist and the tests scan for the personal fields by name.
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { claudeCandidates, describeAccount, exitCodeFor, findClaude, fixedInterval, nextCheckMs, readAccount, watchAccount } from "../src/account.mjs";
import { waitFor } from "./helpers.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const SYSTEM_PATH = "/usr/bin:/bin";

// What `claude auth status` really prints (field names from a live run), with invented values.
const SIGNED_IN = {
  loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max",
  email: "someone@example.com", orgId: "org-0000-invented", orgName: "Invented Studio LLC",
  configDirectory: "/Users/someone/.claude", projectsDirectory: "/Users/someone/.claude/projects", analyticsDisabled: false,
};
const SIGNED_OUT = { loggedIn: false, authMethod: "none" };
const PERSONAL = ["someone@example.com", "org-0000-invented", "Invented Studio", "/Users/someone", "max"];

const tmp = (label) => mkdtempSync(join(tmpdir(), `laya-acct-${label}-`));

/** A stand-in `claude` that prints `out` and exits `code`. Only shell builtins, so any PATH works. */
function claudeAt(dir, { out = "", code = 0, body } = {}) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "claude");
  const script = body ?? `printf '%s\\n' '${String(out).replaceAll("'", "'\\''")}'\nexit ${code}\n`;
  writeFileSync(file, `#!/bin/sh\n${script}`, { mode: 0o755 });
  chmodSync(file, 0o755);
  return file;
}

const json = (o) => JSON.stringify(o);

/**
 * Runs a check against a stand-in that writes its pid and then hangs, and reports what happened.
 *
 * The deadline cannot be a fixed 400 ms: under load a shell can take longer than that just to
 * start, and a stand-in killed before it has written its pid proves nothing about the code. So the
 * deadline is generous, and what is measured is the time from the stand-in being UP to the answer
 * arriving, which is the thing under test: how promptly a hung check is ended.
 */
async function hungCheck({ preamble = "", deadline = 1500 } = {}) {
  const dir = tmp("bin");
  const pidFile = join(dir, "pid");
  claudeAt(dir, { body: `${preamble}echo $$ > '${pidFile}'\nexec sleep 30\n` });
  const result = readAccount(isolated({ env: { PATH: `${dir}:${SYSTEM_PATH}` }, timeoutMs: deadline }));
  const up = await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim(), "the stand-in to start", 20_000);
  const cameUp = Date.now();
  const got = await result;
  const pid = Number(up);
  const gone = () => { try { process.kill(pid, 0); return false; } catch { return true; } };
  return { got, pid, gone, afterUp: Date.now() - cameUp, deadline };
}
const isolated = (extra = {}) => ({ env: { PATH: SYSTEM_PATH }, home: tmp("home"), system: [], ...extra });

// ------------------------------------------------------------------ finding claude

test("LAYA_CLAUDE_BIN names the binary and wins over the PATH", () => {
  const onPath = claudeAt(tmp("path"));
  const named = claudeAt(tmp("named"));
  const env = { PATH: `${join(onPath, "..")}:${SYSTEM_PATH}`, LAYA_CLAUDE_BIN: named };
  assert.equal(findClaude({ env, home: tmp("home"), system: [] }), named);
});

test("a LAYA_CLAUDE_BIN that cannot be run is ignored rather than trusted", () => {
  const dir = tmp("path");
  const real = claudeAt(dir);
  const notExecutable = join(tmp("noexec"), "claude");
  writeFileSync(notExecutable, "#!/bin/sh\n", { mode: 0o644 });
  for (const bad of [notExecutable, "/nonexistent/claude", tmp("adir"), ""]) {
    const env = { PATH: `${dir}:${SYSTEM_PATH}`, LAYA_CLAUDE_BIN: bad };
    assert.equal(findClaude({ env, home: tmp("home"), system: [] }), real, `for ${JSON.stringify(bad)}`);
  }
});

test("the PATH is searched in order", () => {
  const first = tmp("first");
  const second = tmp("second");
  const a = claudeAt(first);
  claudeAt(second);
  assert.equal(findClaude({ env: { PATH: `${first}:${second}:${SYSTEM_PATH}` }, home: tmp("home"), system: [] }), a);
});

test("the native installer's folder is found although launchd's PATH never lists it", () => {
  const home = tmp("home");
  const installed = claudeAt(join(home, ".local", "bin"));
  assert.equal(findClaude({ env: { PATH: SYSTEM_PATH }, home, system: [] }), installed);
});

test("the PATH is preferred to the guessed places", () => {
  const home = tmp("home");
  claudeAt(join(home, ".local", "bin"));
  const dir = tmp("path");
  const onPath = claudeAt(dir);
  assert.equal(findClaude({ env: { PATH: `${dir}:${SYSTEM_PATH}` }, home, system: [] }), onPath);
});

test("the other usual homes are found: ~/.claude/local, npm's prefix, nvm, volta, asdf, and the system folders", () => {
  const places = [
    (home) => join(home, ".claude", "local"),
    (home) => join(home, ".npm-global", "bin"),
    (home) => join(home, ".nvm", "versions", "node", "v22.3.0", "bin"),
    (home) => join(home, ".volta", "bin"),
    (home) => join(home, ".asdf", "shims"),
  ];
  for (const place of places) {
    const home = tmp("home");
    const at = claudeAt(place(home));
    assert.equal(findClaude({ env: { PATH: SYSTEM_PATH }, home, system: [] }), at, place(home));
  }
  const sys = tmp("system");
  const at = claudeAt(sys);
  assert.equal(findClaude({ env: { PATH: SYSTEM_PATH }, home: tmp("home"), system: [sys] }), at);
});

test("with several node versions installed, the newest one that has claude wins", () => {
  const home = tmp("home");
  const base = join(home, ".nvm", "versions", "node");
  claudeAt(join(base, "v9.11.2", "bin")); // "v9" sorts after "v22" as text, which is what a naive sort gets wrong
  claudeAt(join(base, "v18.20.0", "bin"));
  const newest = claudeAt(join(base, "v22.3.0", "bin"));
  mkdirSync(join(base, "v23.0.0", "bin"), { recursive: true }); // newer, but no claude in it
  assert.equal(findClaude({ env: { PATH: SYSTEM_PATH }, home, system: [] }), newest);
});

test("a folder that happens to be named claude is not a binary", () => {
  const home = tmp("home");
  mkdirSync(join(home, ".local", "bin", "claude"), { recursive: true });
  assert.equal(findClaude({ env: { PATH: SYSTEM_PATH }, home, system: [] }), null);
});

test("nothing anywhere: not found, and no error", () => {
  assert.equal(findClaude(isolated()), null);
});

test("candidates are listed without touching the disk, in the order they are tried", () => {
  const list = claudeCandidates({ env: { PATH: "/a:/b:/a", LAYA_CLAUDE_BIN: "/a/claude" }, home: "/h", system: ["/s", "/b"] });
  assert.deepEqual(list.slice(0, 2), ["/a/claude", "/b/claude"], "named first, then the PATH in order, each once");
  assert.ok(list.indexOf("/h/.local/bin/claude") > list.indexOf("/b/claude"));
  assert.ok(list.includes("/s/claude"));
  assert.equal(new Set(list).size, list.length, "the same place listed three ways is tried once");
});

// ------------------------------------------------------------------ reading the state

test("signed in: says so, and names the method", async () => {
  const dir = tmp("bin");
  claudeAt(dir, { out: json(SIGNED_IN) });
  const got = await readAccount(isolated({ env: { PATH: `${dir}:${SYSTEM_PATH}` } }));
  assert.deepEqual(got, { state: "signed-in", method: "claude.ai" });
});

test("signed in: nothing personal, and not even the plan, comes out", async () => {
  const dir = tmp("bin");
  claudeAt(dir, { out: json(SIGNED_IN) });
  const got = JSON.stringify(await readAccount(isolated({ env: { PATH: `${dir}:${SYSTEM_PATH}` } })));
  for (const secret of PERSONAL) assert.ok(!got.includes(secret), `${secret} leaked: ${got}`);
  // The CLI's plan figure is cached from the moment of login, so it can be out of date.
  assert.ok(!/plan|subscription|email|org/i.test(Object.keys(JSON.parse(got)).join(",")), got);
});

test("signed out: exits non-zero with the state on stdout, and that is still a clear answer", async () => {
  const dir = tmp("bin");
  claudeAt(dir, { out: json(SIGNED_OUT), code: 1 });
  const got = await readAccount(isolated({ env: { PATH: `${dir}:${SYSTEM_PATH}` } }));
  assert.deepEqual(got, { state: "signed-out", method: null });
});

test("the exit code does not decide it: the answer in the output does", async () => {
  const a = tmp("a");
  claudeAt(a, { out: json(SIGNED_OUT), code: 0 });
  assert.equal((await readAccount(isolated({ env: { PATH: `${a}:${SYSTEM_PATH}` } }))).state, "signed-out");
  const b = tmp("b");
  claudeAt(b, { out: json(SIGNED_IN), code: 3 });
  assert.equal((await readAccount(isolated({ env: { PATH: `${b}:${SYSTEM_PATH}` } }))).state, "signed-in");
});

test("not installed: missing", async () => {
  assert.deepEqual(await readAccount(isolated()), { state: "missing", method: null });
});

test("a crash, garbage, or a reply that does not say is unknown, never a guess either way", async () => {
  const cases = {
    "crashes with no output": { body: "echo 'keychain is locked' >&2\nexit 2\n" },
    "prints prose": { out: "You are logged in as someone" },
    "prints JSON without the answer": { out: json({ authMethod: "claude.ai" }) },
    "prints the answer as text": { out: json({ loggedIn: "yes" }) },
    "prints nothing": { out: "" },
    "prints an array": { out: "[true]" },
  };
  for (const [name, spec] of Object.entries(cases)) {
    const dir = tmp("bin");
    claudeAt(dir, spec);
    const got = await readAccount(isolated({ env: { PATH: `${dir}:${SYSTEM_PATH}` } }));
    assert.deepEqual(got, { state: "unknown", method: null }, name);
  }
});

test("the method is shown only if it looks like a method", async () => {
  const methods = { "claude.ai": "claude.ai", api_key: "api_key", "": null, [" padded "]: null, [`${"x".repeat(40)}`]: null, "a/b": null, "<b>": null };
  for (const [sent, want] of Object.entries(methods)) {
    const dir = tmp("bin");
    claudeAt(dir, { out: json({ loggedIn: true, authMethod: sent }) });
    const got = await readAccount(isolated({ env: { PATH: `${dir}:${SYSTEM_PATH}` } }));
    assert.equal(got.method, want, JSON.stringify(sent));
  }
  const dir = tmp("bin");
  claudeAt(dir, { out: json({ loggedIn: true, authMethod: { nested: 1 } }) });
  assert.equal((await readAccount(isolated({ env: { PATH: `${dir}:${SYSTEM_PATH}` } }))).method, null);
});

test("a method is never claimed for someone who is signed out", async () => {
  const dir = tmp("bin");
  claudeAt(dir, { out: json({ loggedIn: false, authMethod: "claude.ai" }) });
  assert.equal((await readAccount(isolated({ env: { PATH: `${dir}:${SYSTEM_PATH}` } }))).method, null);
});

test("a check that hangs ends at the deadline as unknown, and the process is killed", async () => {
  const { got, gone, afterUp, deadline } = await hungCheck();
  assert.deepEqual(got, { state: "unknown", method: null });
  assert.ok(afterUp < deadline + 3000, `${afterUp}ms after the check started: the hang was waited out, not ended`);
  await waitFor(gone, "the hung check to be killed", 5000);
});

test("a flood of output is cut off as unknown instead of filling memory", async () => {
  const dir = tmp("bin");
  claudeAt(dir, { body: "exec head -c 4000000 /dev/zero\n" });
  const got = await readAccount(isolated({ env: { PATH: `${dir}:${SYSTEM_PATH}` } }));
  assert.deepEqual(got, { state: "unknown", method: null });
});

test("the check does not wait for input", async () => {
  const dir = tmp("bin");
  // Would block forever if stdin were left open and readable.
  claudeAt(dir, { body: `read line\nprintf '%s\\n' '${json(SIGNED_IN)}'\n` });
  const got = await readAccount(isolated({ env: { PATH: `${dir}:${SYSTEM_PATH}` }, timeoutMs: 4000 }));
  assert.equal(got.state, "signed-in");
});

test("the binary that is asked is the one that was found, run with `auth status`", async () => {
  const dir = tmp("bin");
  const log = join(dir, "args");
  claudeAt(dir, { body: `printf '%s' "$*" > '${log}'\nprintf '%s\\n' '${json(SIGNED_IN)}'\n` });
  await readAccount(isolated({ env: { PATH: `${dir}:${SYSTEM_PATH}` } }));
  assert.equal(readFileSync(log, "utf8"), "auth status");
});

// ------------------------------------------------------------------ what it will not trust

test("an answer that arrives and is then followed by a hang is not trusted: unknown", async () => {
  const dir = tmp("bin");
  claudeAt(dir, { body: `printf '%s\\n' '${json(SIGNED_IN)}'\nexec sleep 30\n` });
  const got = await readAccount(isolated({ env: { PATH: `${dir}:${SYSTEM_PATH}` }, timeoutMs: 1500 }));
  assert.deepEqual(got, { state: "unknown", method: null });
});

test("an answer buried in a flood of output is not trusted: unknown", async () => {
  const dir = tmp("bin");
  // A valid reply first, then far more than the limit. Cut at the limit, the first part still
  // parses, which is why the cut itself has to count as "no clear answer".
  claudeAt(dir, { body: `printf '%s\\n' '${json(SIGNED_IN)}'\nexec head -c 4000000 /dev/zero | tr '\\0' ' '\n` });
  const got = await readAccount(isolated({ env: { PATH: `${dir}:${SYSTEM_PATH}` } }));
  assert.deepEqual(got, { state: "unknown", method: null });
});

test("a check that ignores polite requests to stop is still stopped", async () => {
  // `trap '' TERM` makes the signal ignored, and an ignored signal stays ignored across exec.
  const { got, gone, afterUp, deadline } = await hungCheck({ preamble: "trap '' TERM\n" });
  assert.deepEqual(got, { state: "unknown", method: null });
  assert.ok(afterUp < deadline + 3000, `${afterUp}ms after the check started: it was waited out, not stopped`);
  await waitFor(gone, "the stubborn check to be killed", 5000);
});

test("a relative or empty PATH entry is never searched, so a file named claude in the working folder is not run", () => {
  const here = tmp("cwd");
  claudeAt(here);
  const before = process.cwd();
  process.chdir(here);
  try {
    for (const PATH of [":/usr/bin", `/usr/bin${delimiter}${delimiter}/bin`, ".", "./", `.${delimiter}/bin`, "claude-dir"]) {
      assert.equal(findClaude({ env: { PATH }, home: tmp("home"), system: [] }), null, JSON.stringify(PATH));
    }
    assert.equal(findClaude({ env: { PATH: SYSTEM_PATH, LAYA_CLAUDE_BIN: "claude" }, home: tmp("home"), system: [] }), null, "a relative LAYA_CLAUDE_BIN");
  } finally {
    process.chdir(before);
  }
  const all = claudeCandidates({ env: { PATH: `:rel${delimiter}/abs`, LAYA_CLAUDE_BIN: "rel/claude" }, home: "/h", system: [] });
  assert.ok(all.length > 0 && all.every((c) => isAbsolute(c)), all.join(" "));
});

test("the check runs with node's own folder on its PATH, since a claude installed by npm starts with `env node`", async () => {
  const dir = tmp("bin");
  const emptyPath = tmp("empty");
  // launchd gives the daemon almost no PATH. A claude script that starts `#!/usr/bin/env node`
  // exits 127 there unless the node that runs Laya is findable.
  const stub = claudeAt(dir, { body: `command -v node >/dev/null 2>&1 || exit 127\nprintf '%s\\n' '${json(SIGNED_IN)}'\n` });
  const got = await readAccount({ env: { PATH: emptyPath, LAYA_CLAUDE_BIN: stub }, home: tmp("home"), system: [] });
  assert.equal(got.state, "signed-in");
});

test("the check sees the environment it is given, such as which config folder to read", async () => {
  const dir = tmp("bin");
  claudeAt(dir, { body: `if [ "$CLAUDE_CONFIG_DIR" = "/somewhere/else" ]; then printf '%s\\n' '${json(SIGNED_OUT)}'; exit 1; fi\nprintf '%s\\n' '${json(SIGNED_IN)}'\n` });
  const base = { PATH: `${dir}:${SYSTEM_PATH}` };
  assert.equal((await readAccount(isolated({ env: base }))).state, "signed-in");
  assert.equal((await readAccount(isolated({ env: { ...base, CLAUDE_CONFIG_DIR: "/somewhere/else" } }))).state, "signed-out");
});

test("a slow machine is given time: the default deadline is not a blink", async () => {
  const dir = tmp("bin");
  claudeAt(dir, { body: `sleep 1\nprintf '%s\\n' '${json(SIGNED_IN)}'\n` });
  const got = await readAccount(isolated({ env: { PATH: `${dir}:${SYSTEM_PATH}` } })); // no timeoutMs: the default
  assert.equal(got.state, "signed-in");
});

test("a check that answers and is then killed from outside is not trusted: unknown", async () => {
  const dir = tmp("bin");
  claudeAt(dir, { body: `printf '%s\\n' '${json(SIGNED_IN)}'\nkill -9 $$\n` });
  assert.deepEqual(await readAccount(isolated({ env: { PATH: `${dir}:${SYSTEM_PATH}` } })), { state: "unknown", method: null });
});

test("a claude that exists but cannot start is unknown, not missing", async () => {
  const dir = tmp("bin");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "claude"), "#!/nonexistent/interpreter\n", { mode: 0o755 });
  assert.deepEqual(await readAccount(isolated({ env: { PATH: `${dir}:${SYSTEM_PATH}` } })), { state: "unknown", method: null });
});

test("the person's own node wins over the fallback, as it does in their terminal", async () => {
  const theirs = tmp("their-node");
  const answer = join(theirs, "which");
  const stub = claudeAt(tmp("bin"), { body: `command -v node > '${answer}'\nprintf '%s\\n' '${json(SIGNED_IN)}'\n` });
  writeFileSync(join(theirs, "node"), "#!/bin/sh\n", { mode: 0o755 });
  await readAccount({ env: { PATH: theirs, LAYA_CLAUDE_BIN: stub }, home: tmp("home"), system: [] });
  assert.equal(readFileSync(answer, "utf8").trim(), join(theirs, "node"));
});

// ------------------------------------------------------------------ the loop

/** A `read` that answers from a script, one entry per call; an Error entry rejects. */
function scripted(answers, { ms = 0 } = {}) {
  let calls = 0, running = 0, mostAtOnce = 0;
  const read = async () => {
    const answer = answers[Math.min(calls++, answers.length - 1)];
    mostAtOnce = Math.max(mostAtOnce, ++running);
    if (ms) await new Promise((r) => setTimeout(r, ms));
    running--;
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { read, calls: () => calls, mostAtOnce: () => mostAtOnce };
}
const reading = (state) => ({ state, method: null });

test("the first check runs at once, not after a wait", async (t) => {
  const s = scripted([reading("signed-in")]);
  const stop = watchAccount({ read: s.read, onReading() {}, every: 60_000 });
  t.after(stop);
  await waitFor(() => s.calls() === 1, "the first check");
});

test("each reading is handed over, in order", async (t) => {
  const seen = [];
  const s = scripted([reading("signed-out"), reading("signed-in"), reading("signed-out")]);
  t.after(watchAccount({ read: s.read, onReading: (r) => seen.push(r.state), every: 5 }));
  await waitFor(() => seen.length >= 3, "three readings");
  assert.deepEqual(seen.slice(0, 3), ["signed-out", "signed-in", "signed-out"]);
});

test("a check that throws is reported, paced as unknown, and the loop carries on", async (t) => {
  const errors = [], seen = [], paced = [];
  const s = scripted([new Error("boom"), reading("signed-in")]);
  t.after(watchAccount({ read: s.read, onReading: (r) => seen.push(r.state), onError: (e) => errors.push(e.message), nextMs: (st) => (paced.push(st), 5) }));
  await waitFor(() => seen.length >= 1, "a reading after the failure");
  assert.deepEqual(errors, ["boom"]);
  assert.equal(paced[0], "unknown", "a failed check is not paced like a good answer");
});

test("a handler that throws does not stop the loop, and the pace still follows what was read", async (t) => {
  const errors = [], paced = [];
  const s = scripted([reading("signed-out")]);
  t.after(watchAccount({
    read: s.read, onError: (e) => errors.push(e.message), nextMs: (st) => (paced.push(st), 5),
    onReading() { throw new Error("handler broke"); },
  }));
  await waitFor(() => s.calls() >= 3, "more checks after the handler threw");
  assert.equal(errors[0], "handler broke");
  assert.equal(paced[0], "signed-out", "the handler's failure must not turn a real reading into 'unknown'");
});

test("a slow check never overlaps the next, however short the interval", async (t) => {
  const s = scripted([reading("signed-in")], { ms: 40 });
  t.after(watchAccount({ read: s.read, onReading() {}, every: 1 }));
  await waitFor(() => s.calls() >= 4, "four checks");
  assert.equal(s.mostAtOnce(), 1, "two checks ran at the same time");
});

test("the pace comes from what was just read", async (t) => {
  const paced = [];
  const s = scripted([reading("signed-in"), reading("signed-out"), reading("missing"), reading("unknown")]);
  t.after(watchAccount({ read: s.read, onReading() {}, nextMs: (st) => (paced.push(st), 5) }));
  await waitFor(() => paced.length >= 4, "four paces");
  assert.deepEqual(paced.slice(0, 4), ["signed-in", "signed-out", "missing", "unknown"]);
});

test("a fixed interval overrides the pace entirely", async (t) => {
  let asked = 0;
  const s = scripted([reading("signed-in")]);
  t.after(watchAccount({ read: s.read, onReading() {}, every: 5, nextMs: () => (asked++, 60_000) }));
  await waitFor(() => s.calls() >= 3, "three checks");
  assert.equal(asked, 0);
});

test("after stop() no further check is started", async () => {
  const s = scripted([reading("signed-in")]);
  const stop = watchAccount({ read: s.read, onReading() {}, every: 5 });
  await waitFor(() => s.calls() >= 2, "a running loop");
  stop();
  const at = s.calls();
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(s.calls(), at, `${s.calls() - at} more checks after stop`);
});

test("a check already in flight when stop() is called is not delivered, nor is its failure", async () => {
  const seen = [], errors = [];
  let release;
  const gate = new Promise((r) => (release = r));
  const stop = watchAccount({
    read: async () => { await gate; return reading("signed-in"); },
    onReading: (r) => seen.push(r.state), onError: (e) => errors.push(e.message), every: 5,
  });
  stop();
  release();
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(seen, [], "a reading was delivered after stop");

  let fail;
  const failing = new Promise((_, reject) => (fail = reject));
  const stop2 = watchAccount({ read: () => failing, onReading() {}, onError: (e) => errors.push(e.message), every: 5 });
  stop2();
  fail(new Error("late failure"));
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(errors, [], "a failure was reported after stop");
});

test("stop() called from inside the handler ends it there: nothing is scheduled after", async () => {
  let stop;
  const s = scripted([reading("signed-in")]);
  stop = watchAccount({ read: s.read, onReading: () => stop?.(), every: 5 });
  await waitFor(() => s.calls() >= 1, "the first check");
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(s.calls(), 1, `${s.calls() - 1} more checks after the handler stopped it`);
});

test("stop() called from inside the error handler ends it there too", async () => {
  let stop;
  const s = scripted([new Error("boom")]);
  stop = watchAccount({ read: s.read, onReading() {}, onError: () => stop?.(), every: 5 });
  await waitFor(() => s.calls() >= 1, "the first check");
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(s.calls(), 1, `${s.calls() - 1} more checks after the error handler stopped it`);
});

test("stopping twice, or before the first check finishes, is harmless", async () => {
  const s = scripted([reading("signed-in")], { ms: 30 });
  const stop = watchAccount({ read: s.read, onReading() {}, every: 5 });
  stop();
  stop();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(s.calls(), 1);
});

// ------------------------------------------------------------------ a bad interval must never become a tight loop

test("the interval setting is accepted only between 50 ms and what a timer can hold", () => {
  assert.equal(fixedInterval("50"), 50);
  assert.equal(fixedInterval("250"), 250);
  assert.equal(fixedInterval("2147483647"), 2147483647);
  assert.equal(fixedInterval(1500), 1500, "a number as well as text");
  assert.equal(fixedInterval("50.5"), 50.5);
});

test("anything else is ignored, because Node turns a timer it cannot hold into 1 ms", () => {
  const coercible = [[250], ["250"], { valueOf: () => 250 }, new Number(250), new String("250")]; // Number() turns each into 250
  for (const bad of [undefined, null, "", " ", "\t\n", "0", "-5", "49", "49.9", "10", "abc", "NaN", "Infinity", "-Infinity", "3e9", "2147483648", "1e400", "0x10", {}, [], true, false, NaN, Infinity, -Infinity, ...coercible]) {
    assert.equal(fixedInterval(bad), null, `${JSON.stringify(bad)} (${typeof bad})`);
  }
});

// Measured on a real Mac (2026-09-30): `claude auth status` with HOME and PATH but no USER says
// {"loggedIn": false} for someone who is signed in. USER (not LOGNAME, TMPDIR or SHELL) is what it
// needs, most likely to find the account's keychain entry. A background service started with a
// stripped environment would otherwise tell a signed-in person to sign in.
test("a missing USER is filled in, so a signed-in person is not told to sign in", async () => {
  const dir = tmp("bin");
  claudeAt(dir, { body: `if [ -z "$USER" ]; then printf '%s\\n' '${json(SIGNED_OUT)}'; exit 1; fi\nprintf '%s\\n' '${json(SIGNED_IN)}'\n` });
  const env = { PATH: `${dir}:${SYSTEM_PATH}` }; // no USER at all
  const got = await readAccount({ env, home: tmp("home"), system: [] });
  assert.equal(got.state, "signed-in", "the stand-in behaves like the real CLI: no USER, no sign-in");
});

test("an empty USER is treated as missing", async () => {
  const dir = tmp("bin");
  claudeAt(dir, { body: `if [ -z "$USER" ]; then printf '%s\\n' '${json(SIGNED_OUT)}'; exit 1; fi\nprintf '%s\\n' '${json(SIGNED_IN)}'\n` });
  const got = await readAccount({ env: { PATH: `${dir}:${SYSTEM_PATH}`, USER: "" }, home: tmp("home"), system: [] });
  assert.equal(got.state, "signed-in");
});

test("a USER that is already set is never replaced", async () => {
  const dir = tmp("bin");
  const log = join(dir, "user");
  claudeAt(dir, { body: `printf '%s' "$USER" > '${log}'\nprintf '%s\\n' '${json(SIGNED_IN)}'\n` });
  await readAccount({ env: { PATH: `${dir}:${SYSTEM_PATH}`, USER: "someone-else" }, home: tmp("home"), system: [] });
  assert.equal(readFileSync(log, "utf8"), "someone-else");
});

test("the filled-in USER is the account that is running this, not a made-up name", async () => {
  const dir = tmp("bin");
  const log = join(dir, "user");
  claudeAt(dir, { body: `printf '%s' "$USER" > '${log}'\nprintf '%s\\n' '${json(SIGNED_IN)}'\n` });
  await readAccount({ env: { PATH: `${dir}:${SYSTEM_PATH}` }, home: tmp("home"), system: [] });
  assert.equal(readFileSync(log, "utf8"), userInfo().username);
});

// ------------------------------------------------------------------ pacing and wording

test("signed out is checked quickly, signed in slowly, and an unreadable reply in between", () => {
  const pace = { fast: 1, middle: 2, slow: 3 };
  assert.equal(nextCheckMs("signed-out", pace), 1);
  assert.equal(nextCheckMs("missing", pace), 1);
  assert.equal(nextCheckMs("unknown", pace), 2);
  assert.equal(nextCheckMs("signed-in", pace), 3);
  assert.equal(nextCheckMs("something else", pace), 2);
});

test("the default pace is seconds when signed out and about a minute when signed in", () => {
  assert.ok(nextCheckMs("signed-out") >= 1000 && nextCheckMs("signed-out") <= 5000);
  assert.ok(nextCheckMs("signed-in") >= 30000 && nextCheckMs("signed-in") <= 300000);
  assert.ok(nextCheckMs("unknown") > nextCheckMs("signed-out") && nextCheckMs("unknown") < nextCheckMs("signed-in"));
});

test("each state says what is true and what to do, in plain words", () => {
  const out = describeAccount({ state: "signed-out", method: null });
  assert.match(out.line, /not signed in/i);
  assert.match(out.next, /claude auth login/);
  assert.match(out.next, /menu-bar app/i);

  const missing = describeAccount({ state: "missing", method: null });
  assert.match(missing.line, /not installed/i);
  assert.match(missing.next, /npm install -g @anthropic-ai\/claude-code/);
  assert.match(missing.next, /claude auth login/);

  const fine = describeAccount({ state: "signed-in", method: "claude.ai" });
  assert.match(fine.line, /signed in \(claude\.ai\)/);
  assert.equal(fine.next, null, "nothing to do when it works");
  assert.match(describeAccount({ state: "signed-in", method: null }).line, /^Claude Code is signed in\.$/);

  for (const odd of [{ state: "unknown" }, {}, undefined, { state: "weird" }]) {
    const u = describeAccount(odd);
    assert.match(u.line, /could not tell/i);
    assert.match(u.next, /claude auth status/);
  }
});

test("the hint never tells anyone to paste a code or a key anywhere but where Claude Code asks", () => {
  for (const state of ["signed-out", "missing", "unknown"]) {
    const { line, next } = describeAccount({ state });
    assert.ok(!/paste|api key|token|password|sk-/i.test(`${line} ${next}`), `${state}: ${line} ${next}`);
  }
});

// ------------------------------------------------------------------ for setup.sh

test("exit codes: signed in 0, signed out 1, not installed 2, can't tell 3", () => {
  assert.deepEqual(["signed-in", "signed-out", "missing", "unknown", "anything else"].map(exitCodeFor), [0, 1, 2, 3, 3]);
});

function cli(binDir) {
  return spawnSync(process.execPath, [join(REPO, "src", "account.mjs")], {
    env: { PATH: SYSTEM_PATH, HOME: tmp("home"), LAYA_CLAUDE_BIN: join(binDir, "claude") },
    encoding: "utf8",
  });
}

test("the command line reports the state on one line and in the exit code", () => {
  const a = tmp("bin");
  claudeAt(a, { out: json(SIGNED_IN) });
  const signedIn = cli(a);
  assert.equal(signedIn.stdout.trim(), "signed-in claude.ai");
  assert.equal(signedIn.status, 0);

  const b = tmp("bin");
  claudeAt(b, { out: json(SIGNED_OUT), code: 1 });
  const signedOut = cli(b);
  assert.equal(signedOut.stdout.trim(), "signed-out");
  assert.equal(signedOut.status, 1);

  const c = tmp("bin");
  claudeAt(c, { out: "???" });
  const unknown = cli(c);
  assert.equal(unknown.stdout.trim(), "unknown");
  assert.equal(unknown.status, 3);
  for (const r of [signedIn, signedOut, unknown]) for (const secret of PERSONAL) assert.ok(!r.stdout.includes(secret));
});

test("`--hint` prints the plain-words version for setup, with the same exit code", () => {
  const out = tmp("bin");
  claudeAt(out, { out: json(SIGNED_OUT), code: 1 });
  const r = spawnSync(process.execPath, [join(REPO, "src", "account.mjs"), "--hint"], {
    env: { PATH: SYSTEM_PATH, HOME: tmp("home"), LAYA_CLAUDE_BIN: join(out, "claude") }, encoding: "utf8",
  });
  assert.equal(r.status, 1);
  const lines = r.stdout.trim().split("\n");
  assert.equal(lines[0], "Claude Code is not signed in yet.");
  assert.match(lines[1], /claude auth login/);

  const ok = tmp("ok");
  claudeAt(ok, { out: json(SIGNED_IN) });
  const fine = spawnSync(process.execPath, [join(REPO, "src", "account.mjs"), "--hint"], {
    env: { PATH: SYSTEM_PATH, HOME: tmp("home"), LAYA_CLAUDE_BIN: join(ok, "claude") }, encoding: "utf8",
  });
  assert.equal(fine.status, 0);
  assert.equal(fine.stdout.trim(), "Claude Code is signed in (claude.ai).");
  for (const secret of PERSONAL) assert.ok(!fine.stdout.includes(secret));
});

test("importing the module runs no check", () => {
  const r = spawnSync(process.execPath, ["-e", `import(${JSON.stringify(join(REPO, "src", "account.mjs"))}).then(() => console.log("imported"))`], {
    env: { PATH: SYSTEM_PATH, HOME: tmp("home"), LAYA_CLAUDE_BIN: "/nonexistent" }, encoding: "utf8", timeout: 5000,
  });
  assert.equal(r.stdout.trim(), "imported");
  assert.ok(existsSync(join(REPO, "src", "account.mjs")));
});
