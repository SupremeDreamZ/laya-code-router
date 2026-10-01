import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import net from "node:net";
import { isMain } from "../src/is-main.mjs";
import { freePort, wait, waitFor } from "./helpers.mjs";

// Both the daemon and `account.mjs` are a library and a command at once, and decide which they are by
// asking this. It was a plain string comparison, so any path that was not already canonical made them
// do nothing and say nothing. These run the real files from the awkward places a person's machine has.
const REPO = new URL("..", import.meta.url).pathname;

const area = mkdtempSync(join(tmpdir(), "laya-ismain-"));
const real = realpathSync(area);
const file = join(real, "a", "tool.mjs");
mkdirSync(join(real, "a"));
writeFileSync(file, "export {};\n");
mkdirSync(join(real, "my folder"));
writeFileSync(join(real, "my folder", "tool.mjs"), "export {};\n");
symlinkSync(join(real, "a"), join(real, "link"));
symlinkSync(file, join(real, "filelink.mjs"));
const url = pathToFileURL(file).href;

test.after(() => rmSync(area, { recursive: true, force: true }));

test("the same file by its own path is main", () => assert.equal(isMain(url, file), true));

test("the same file through a symlinked folder is main", () => assert.equal(isMain(url, join(real, "link", "tool.mjs")), true));

test("the same file through a symlink to the file itself is main", () => assert.equal(isMain(url, join(real, "filelink.mjs")), true));

test("a folder with a space in its name: the module URL escapes it, the started path does not, and they are still the same file", () => {
  const spaced = join(real, "my folder", "tool.mjs");
  assert.match(pathToFileURL(spaced).href, /my%20folder/, "the URL form is escaped");
  assert.equal(isMain(pathToFileURL(spaced).href, spaced), true);
});

test("a path with ../ in it is main", () => assert.equal(isMain(url, join(real, "a", "..", "a", "tool.mjs")), true));

test("a relative path from the current folder is main", () => {
  const was = process.cwd();
  try {
    process.chdir(join(real, "a"));
    assert.equal(isMain(url, "./tool.mjs"), true);
  } finally {
    process.chdir(was);
  }
});

test("a module URL that reaches the file through a symlink is main too", () => {
  assert.equal(isMain(pathToFileURL(join(real, "link", "tool.mjs")).href, file), true);
});

test("a different file is not main", () => {
  assert.equal(isMain(url, join(real, "my folder", "tool.mjs")), false);
});

test("nothing started, or something that is not a path, is not main", () => {
  for (const started of [undefined, null, "", 0, {}, [], 5n, () => file]) assert.equal(isMain(url, started), false, String(typeof started));
});

test("a path that does not exist is not main, and does not throw", () => {
  assert.equal(isMain(url, join(real, "nowhere", "tool.mjs")), false);
  assert.equal(isMain(pathToFileURL(join(real, "nowhere.mjs")).href, join(real, "nowhere.mjs")), false, "even when both name the same missing file");
});

test("a module URL that is not a file URL is not main, and does not throw", () => {
  assert.equal(isMain("https://example.com/tool.mjs", file), false);
  assert.equal(isMain("not a url", file), false);
});

test("the default is the path this process was started with", () => {
  writeFileSync(join(real, "a", "probe.mjs"), `import { isMain } from ${JSON.stringify(pathToFileURL(join(REPO, "src", "is-main.mjs")).href)};\nconsole.log(isMain(import.meta.url));\n`);
  const direct = spawnSync(process.execPath, [join(real, "a", "probe.mjs")], { encoding: "utf8" });
  assert.equal(direct.stdout.trim(), "true", "run directly");
  const viaLink = spawnSync(process.execPath, [join(real, "link", "probe.mjs")], { encoding: "utf8" });
  assert.equal(viaLink.stdout.trim(), "true", "run through a symlink: the case that used to print nothing");
  writeFileSync(join(real, "a", "importer.mjs"), `import ${JSON.stringify(pathToFileURL(join(real, "a", "probe.mjs")).href)};\n`);
  const imported = spawnSync(process.execPath, [join(real, "a", "importer.mjs")], { encoding: "utf8" });
  assert.equal(imported.stdout.trim(), "false", "imported by another file: not main");
});

// ---------------------------------------------------------------- the two real commands, from awkward places

/** A copy of the repo's source in a folder with a space in its name, and a symlink to that folder. */
function copyOfRepo() {
  const spaced = join(real, "my project");
  mkdirSync(spaced, { recursive: true });
  for (const d of ["src", "bin"]) cpSync(join(REPO, d), join(spaced, d), { recursive: true, dereference: true });
  cpSync(join(REPO, "package.json"), join(spaced, "package.json"));
  const link = join(real, "project-link");
  symlinkSync(spaced, link);
  return { spaced, link };
}
const { spaced, link } = copyOfRepo();
const FAKE_CLAUDE = join(REPO, "test", "fixtures", "fake-claude");

function hint(from) {
  return spawnSync(process.execPath, [join(from, "src", "account.mjs"), "--hint"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: real, LAYA_CLAUDE_BIN: FAKE_CLAUDE },
    timeout: 20000,
  });
}

test("account.mjs --hint says something when run from a folder with a space in its name", () => {
  const r = hint(spaced);
  assert.match(r.stdout, /signed in|sign/i, `it printed ${JSON.stringify(r.stdout)} ${r.stderr.slice(0, 120)}`);
});

test("account.mjs --hint says something when run through a symlink, as under macOS's /var", () => {
  const r = hint(link);
  assert.match(r.stdout, /signed in|sign/i, `it printed ${JSON.stringify(r.stdout)}`);
});

test("account.mjs imported by another file runs no check and prints nothing", () => {
  const importer = join(real, "a", "import-account.mjs");
  writeFileSync(importer, `import ${JSON.stringify(pathToFileURL(join(REPO, "src", "account.mjs")).href)};\n`);
  const r = spawnSync(process.execPath, [importer], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: real, LAYA_CLAUDE_BIN: FAKE_CLAUDE }, timeout: 10000 });
  assert.equal(r.stdout, "");
  assert.equal(r.status, 0);
});

const answers = (port) =>
  new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1", () => s.write(`${JSON.stringify({ id: 1, action: "ping", token: "t" })}\n`));
    s.on("data", () => { s.destroy(); resolve(true); });
    s.on("error", () => resolve(false));
    setTimeout(() => { s.destroy(); resolve(false); }, 1500);
  });

async function daemonFrom(t, from) {
  const port = await freePort();
  const home = mkdtempSync(join(tmpdir(), "laya-ismain-home-"));
  const child = spawn(process.execPath, [join(from, "src", "daemon.mjs")], {
    env: { PATH: process.env.PATH, HOME: home, LAYA_HOME: join(home, ".laya-router"), LAYA_TOKEN: "t", LAYA_CONTROL_PORT: String(port), LAYA_CLAUDE_PROXY_PORT: "0", LAYA_PYTHON: "/usr/bin/false", LAYA_EAGER_LOAD: "0" },
    stdio: "ignore",
  });
  t.after(() => { child.kill("SIGKILL"); rmSync(home, { recursive: true, force: true }); });
  return { child, port };
}

test("the daemon starts from a folder with a space in its name", async (t) => {
  const { port } = await daemonFrom(t, spaced);
  await waitFor(() => answers(port), "the daemon's control socket to answer", 10000);
});

test("the daemon starts through a symlink to its folder", async (t) => {
  const { port } = await daemonFrom(t, link);
  await waitFor(() => answers(port), "the daemon's control socket to answer", 10000);
});

test("the daemon imported as a library starts nothing", async (t) => {
  const port = await freePort();
  const importer = join(real, "a", "import-daemon.mjs");
  writeFileSync(importer, `import ${JSON.stringify(pathToFileURL(join(REPO, "src", "daemon.mjs")).href)};\nsetTimeout(() => process.exit(0), 10000);\n`);
  const child = spawn(process.execPath, [importer], { env: { PATH: process.env.PATH, HOME: real, LAYA_HOME: join(real, ".laya-x"), LAYA_CONTROL_PORT: String(port) }, stdio: "ignore" });
  t.after(() => child.kill("SIGKILL"));
  // A daemon that was going to start answers within a second or two (the tests above wait for it). The
  // importer is still alive when this looks: a port that is closed because the process is gone proves nothing.
  await wait(3000);
  assert.equal(child.exitCode, null, "the importer is still running, so a closed port means no daemon was started");
  assert.equal(await answers(port), false, "importing it must not open the control port");
});
