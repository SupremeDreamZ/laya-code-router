// The tool gate: a Claude Code PreToolUse hook for routed sessions (bin/laya-guard.mjs runs it).
//
// Rules first, Laya second, and Laya can only make things stricter. Deterministic rules settle what
// they can: catastrophic commands are denied, read-only and rebuildable-output commands pass.
// Everything else goes to Laya with one yes/no question, "would this delete or overwrite data that
// cannot be restored?". Measured on the warm model (34 commands, 2026-10-04): at 0.75 it flagged 15
// of 16 destructive commands, including ones no deny list names (find ~ -delete, aws s3 rm
// --recursive, kubectl delete namespace, dropdb), with two false alarms (rm -rf dist, which a rule
// passes, and rm tmp.log). The one it missed, a bare `> file` truncation, is a rule here.
//
// "pass" never means "allow": the hook prints nothing and Claude Code's own permission rules still
// apply. A flagged command is "ask" when someone is there to answer, "deny" with the reason in a
// headless run, where an ask has nobody to answer it. If Laya cannot be reached, the rules alone
// decide; the gate never blocks a command because the model was down.

export const LAYA_FLAG_AT = 0.75;

const HOME = String.raw`(?:~|\$HOME|\$\{HOME\}|/Users/[^/\s]+|/home/[^/\s]+)`;
const REBUILDABLE = /^(?:\.\/)?(?:node_modules|dist|build|out|\.next|\.nuxt|\.cache|\.turbo|\.parcel-cache|coverage|__pycache__|\.pytest_cache|target|\.venv-cache|tmp)\/?$/;
const READ_ONLY = new Set([
  "ls", "cat", "head", "tail", "less", "grep", "rg", "pwd", "wc", "echo", "printf", "which", "type", "stat", "du", "df",
  "file", "tree", "date", "whoami", "uname", "env", "printenv", "diff", "cmp", "sort", "uniq", "cut", "jq", "realpath",
  "basename", "dirname", "sha256sum", "shasum", "md5", "true", "test", "ps", "lsof",
]);
const GIT_READ = /^git\s+(?:status|diff|log|show|branch(?:\s+(?:-a|-r|--list|-v|-vv))*\s*$|remote(?:\s+-v)?\s*$|rev-parse|ls-files|blame|describe|tag\s*$|config\s+--get)/;

const deny = (rule, reason) => ({ decision: "deny", rule, reason });
const ask = (rule, reason) => ({ decision: "ask", rule, reason });
const pass = (rule) => ({ decision: "pass", rule });

/** Split a command line into its simple commands (on ; && || | and newlines), roughly. */
export function segments(command) {
  return String(command)
    .split(/\|\||&&|;|\n|\|/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function rmTargets(seg) {
  const words = seg.split(/\s+/).slice(1);
  const flags = words.filter((w) => w.startsWith("-")).join("");
  const targets = words.filter((w) => !w.startsWith("-"));
  return { recursive: /r|R|--recursive/.test(flags), targets };
}

/** One simple command against the rules. Returns a verdict, or null when the rules have no answer. */
function ruleFor(seg) {
  const s = seg.replace(/^(?:sudo|command|exec|nohup|time)\s+/, "");
  if (/:\(\)\s*\{\s*:\|:&\s*\};:/.test(s)) return deny("fork-bomb", "fork bomb");
  if (/\bmkfs(?:\.\w+)?\b|\bdiskutil\s+(?:erase|zero|secureErase|partitionDisk)|\bdd\b.*\bof=\/dev\//.test(s)) return deny("disk", "formats or overwrites a disk");
  if (/--no-preserve-root/.test(s)) return deny("rm-root", "rm with --no-preserve-root");
  if (/^rm\s/.test(s)) {
    const { recursive, targets } = rmTargets(s);
    const home = new RegExp(`^${HOME}/?\\*?$`);
    for (const t of targets) {
      if (t === "/" || t === "/*" || home.test(t) || t === "~/*" || t === ".." || t === "../" || t === "." || t === "./" || t === "*") {
        return deny("rm-broad", `rm on ${t}`);
      }
      if (recursive && /(?:^|\/)\.git\/?$/.test(t)) return deny("rm-git", "deletes a repository's history (.git)");
    }
    if (recursive && targets.length && targets.every((t) => REBUILDABLE.test(t))) return pass("rm-rebuildable");
    // Plain deletes of scratch files: logs, temp files, backups, compiled leftovers.
    if (!recursive && targets.length && targets.every((t) => !t.includes("*") && (/\.(?:log|tmp|temp|bak|swp|pyc|o)$/.test(t) || /^(?:\.\/)?(?:tmp|temp)\//.test(t))))
      return pass("rm-scratch");
    return null;
  }
  if (/^git\s+push\b/.test(s) && /\s(?:-f|--force)(?:\s|$)/.test(s)) {
    if (/\b(?:main|master|production|prod|release)\b/.test(s) || !/\s\S+\s+\S+/.test(s.replace(/^git\s+push/, "").replace(/\s-\S+/g, "")))
      return deny("force-push", "force-push to a shared branch");
    return ask("force-push", "force-push");
  }
  if (/^git\s+push\b/.test(s) && /--force-with-lease/.test(s)) return ask("force-push", "force-push (with lease)");
  if (/^chmod\s+-R\s+0*0?0?\s/.test(s) || new RegExp(`^ch(?:mod|own)\\s+-R\\s+\\S+\\s+(?:/|${HOME}/?)\\s*$`).test(s)) return deny("perm-broad", "recursive permission change on / or home");
  if (/^:?\s*>\s*\S/.test(s)) return ask("truncate", "truncates a file to empty");
  const first = s.split(/\s+/)[0];
  if (READ_ONLY.has(first) && !/(?:^|[^>])>(?!&)|>>|\btee\b|-delete\b|-exec\b/.test(s)) return pass("read-only");
  if (first === "find" && !/-delete\b|-exec\b|-execdir\b|-ok\b/.test(s)) return pass("read-only");
  if (GIT_READ.test(s)) return pass("read-only");
  return null;
}

const SECRET_PATH = /(?:^|\/)(?:\.env(?:\.[\w.-]+)?|[^/]*\.pem|[^/]*\.key|id_(?:rsa|ed25519|ecdsa)|\.npmrc|\.netrc|credentials(?:\.json)?|\.aws\/credentials|secrets?\.(?:json|ya?ml|toml))$/i;

/**
 * What the rules say about one tool call: `deny`, `ask`, `pass`, or `laya` (no rule decided; ask Laya).
 * @param {string} tool  Claude Code's tool name
 * @param {object} input its tool_input
 */
export function classify(tool, input = {}) {
  if (tool === "Bash") {
    const command = String(input.command ?? "");
    if (!command.trim()) return pass("empty");
    // Whole-line rules, before the line is split at its pipes.
    if (/\b(?:curl|wget)\b[^|]*\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b/.test(command)) return ask("pipe-to-shell", "runs a script straight from the internet");
    const verdicts = segments(command).map(ruleFor);
    const strongest = (d) => verdicts.find((v) => v?.decision === d);
    if (strongest("deny")) return strongest("deny");
    if (strongest("ask")) return strongest("ask");
    if (verdicts.every((v) => v?.decision === "pass")) return pass(verdicts[0]?.rule ?? "read-only");
    return { decision: "laya", command };
  }
  if (tool === "Write" || tool === "Edit" || tool === "MultiEdit" || tool === "NotebookEdit") {
    const path = String(input.file_path ?? input.notebook_path ?? "");
    if (SECRET_PATH.test(path) && !/\.(?:example|sample|template)$/i.test(path)) return ask("secret-file", `writes a secrets file (${path.split("/").pop()})`);
    return pass("write");
  }
  return pass("other-tool");
}

export const DESTRUCTIVE_QUESTION = {
  destructive: {
    type: "noul",
    instructions: "Would running this shell command delete or overwrite data that cannot be restored?",
  },
};

/**
 * The full decision for one tool call. `askLaya(state, questions)` answers typed questions (the
 * daemon's warm model); any failure there leaves the rules' answer standing, which for an unruled
 * command is "pass".
 * @returns {Promise<{decision: "deny"|"ask"|"pass", rule: string, reason?: string, p?: number}>}
 */
export async function decide(tool, input, { askLaya, headless = false, flagAt = LAYA_FLAG_AT } = {}) {
  const ruled = classify(tool, input);
  let verdict = ruled;
  if (ruled.decision === "laya") {
    let p = null;
    try {
      const a = await askLaya(`Shell command: ${ruled.command.slice(0, 600)}`, DESTRUCTIVE_QUESTION);
      p = Number(a?.destructive?.noul);
    } catch {
      p = null;
    }
    if (!Number.isFinite(p)) return pass("laya-unavailable");
    verdict = p >= flagAt
      ? { decision: "ask", rule: "laya", reason: `Laya: likely destroys data that cannot be restored (p=${p.toFixed(2)})`, p }
      : { ...pass("laya"), p };
  }
  // Nobody can answer an ask in a headless run, so there it is a deny the agent can read and work around.
  if (verdict.decision === "ask" && headless) return { ...verdict, decision: "deny" };
  return verdict;
}

/** What Claude Code reads from a PreToolUse hook's stdout. `pass` prints nothing at all. */
export function hookOutput(verdict) {
  if (verdict.decision !== "deny" && verdict.decision !== "ask") return null;
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: verdict.decision,
      permissionDecisionReason:
        `Laya guard (${verdict.rule}): ${verdict.reason}.` +
        (verdict.decision === "deny" ? " Use a reversible alternative, or leave this step for the user." : ""),
    },
  };
}
