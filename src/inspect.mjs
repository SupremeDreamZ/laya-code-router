// Ask yes/no questions about files without reading them into the agent's context (levels 8-9 of
// "10 levels of Jev"). The agent sends paths and a question; Laya answers per file and only the
// verdicts come back. Laya reads ~512 tokens per question, so a file is cut into windows and asked
// window by window; a file says "yes" when its strongest window does. Its answers are a filter for
// where to look, not proof: the agent still reads what it will change.
import { readFileSync, statSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export const WINDOW_CHARS = 1600;
export const MAX_FILES = 40;
export const MAX_WINDOWS_PER_FILE = 24;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".venv", "venv", "__pycache__", ".build", "coverage"]);

/** Cut text into windows of about `size` characters, on line breaks where it can. */
export function windows(text, size = WINDOW_CHARS) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(text.length, i + size);
    if (end < text.length) {
      const nl = text.lastIndexOf("\n", end);
      if (nl > i + size / 2) end = nl;
    }
    out.push(text.slice(i, end));
    i = end;
  }
  return out.length ? out : [""];
}

/** Expand paths and simple globs (`*`, `**`) under `cwd` into files, skipping build and vendor dirs. */
export function expand(patterns, cwd = process.cwd()) {
  const files = new Set();
  const toRe = (g) =>
    new RegExp(
      `^${g
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*\//g, "\u0001")
        .replace(/\*\*/g, "\u0002")
        .replace(/\*/g, "[^/]*")
        .replace(/\?/g, "[^/]")
        .replace(/\u0001/g, "(?:.*/)?")
        .replace(/\u0002/g, ".*")}$`,
    );
  const walk = (dir, visit) => {
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(join(dir, e.name), visit);
      } else if (e.isFile()) visit(join(dir, e.name));
    }
  };
  for (const p of patterns) {
    if (!/[*?]/.test(p)) {
      const full = resolve(cwd, p);
      try {
        if (statSync(full).isDirectory()) walk(full, (f) => files.add(f));
        else files.add(full);
      } catch {
        // A path that does not exist is reported by the caller as unreadable.
        files.add(full);
      }
      continue;
    }
    const re = toRe(p.replace(/^\.\//, ""));
    walk(cwd, (f) => {
      if (re.test(relative(cwd, f))) files.add(f);
    });
  }
  return [...files].slice(0, MAX_FILES);
}

/**
 * Ask `question` (yes/no) of each file. `askLaya(state, questions)` answers typed questions.
 * @returns {Promise<Array<{file: string, yes: number|null, window?: number, error?: string}>>}
 */
export async function askFiles(files, question, { askLaya, cwd = process.cwd() } = {}) {
  const q = { q: { type: "noul", instructions: question } };
  const results = [];
  for (const file of files) {
    const name = relative(cwd, file) || file;
    let text;
    try {
      if (statSync(file).size > 2_000_000) throw new Error("larger than 2 MB");
      text = readFileSync(file, "utf8");
    } catch (err) {
      results.push({ file: name, yes: null, error: err.message });
      continue;
    }
    const parts = windows(text).slice(0, MAX_WINDOWS_PER_FILE);
    let best = null;
    let at = 0;
    for (let i = 0; i < parts.length; i++) {
      try {
        const a = await askLaya(`File ${name} (part ${i + 1}/${parts.length}):\n${parts[i]}`, q);
        const p = Number(a?.q?.noul);
        if (Number.isFinite(p) && (best === null || p > best)) {
          best = p;
          at = i + 1;
        }
      } catch (err) {
        results.push({ file: name, yes: null, error: `laya: ${err.message}` });
        best = undefined;
        break;
      }
    }
    if (best !== undefined) results.push({ file: name, yes: best, window: at, windows: parts.length });
  }
  return results.sort((a, b) => (b.yes ?? -1) - (a.yes ?? -1));
}
