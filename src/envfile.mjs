// The settings files the command-line launcher has always read, shared so the background daemon
// reads the same ones. Without this the daemon ignored anything in ~/.laya-router.env, which is
// where setup.sh records the Python that has `laya` installed: on any machine but the author's
// the login-item daemon would start with no sidecar and silently route nothing.
import { join } from "node:path";

/** Earlier files win over later ones, and a real environment variable wins over both. */
export const defaultEnvFiles = (home) => [join(home, ".laya-router.env"), join(home, ".laya-claude.env")];

/**
 * Loads each file that exists into process.env, never overwriting a variable that is already set.
 * `process.loadEnvFile` leaves existing variables alone, which gives "first file wins" for free.
 * A missing, unreadable or non-file path is skipped; configuration is optional.
 * @returns {string[]} the files that were actually read
 */
export function loadEnvFiles(files) {
  const read = [];
  for (const file of files) {
    try {
      process.loadEnvFile(file);
      read.push(file);
    } catch {
      // Not there, or not a file. Carry on.
    }
  }
  return read;
}
