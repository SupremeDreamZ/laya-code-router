// "Was this file started directly, rather than imported?" for the two modules that are both a library
// and a command (the daemon and the sign-in check).
//
// Both used to compare the module's URL with the path they were started with, as plain text. That is
// false for any path that is not already in its canonical form, and the answer was silence: the
// process ran, found nothing to do, and exited with no output. Measured on 2026-10-01: a fresh clone
// under macOS's temporary folder (/var is a symlink to /private/var) printed nothing from
// `account.mjs --hint`, so `setup.sh` showed a blank where the sign-in status belongs, and a daemon
// started from a folder with a space in its name, or through a symlink, never started at all.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * @param {string} moduleUrl  the calling module's `import.meta.url`
 * @param {string} [started]  the script the process was started with, `process.argv[1]`
 */
export function isMain(moduleUrl, started = process.argv[1]) {
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(started);
  } catch {
    // Nothing started, a path that cannot be resolved (a script run from a pipe, a file just deleted),
    // a value that is not a path, or a URL that is not a file: none of those is a module started directly.
    return false;
  }
}
