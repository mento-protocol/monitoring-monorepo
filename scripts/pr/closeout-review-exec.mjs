/**
 * Closeout review: the process boundary. Everything the tool runs and
 * everything it writes passes through here — the sanitized PATH, the
 * allowlisted environment `codex` gets, the `codex` executable itself, and the
 * refusal to write a report Git would track. `scripts/pr/closeout-review.mjs`
 * owns the flow; this module owns the boundary.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Environment for `codex`, built by allowlist rather than inherited: the
 * operator shell holds GitHub, cloud and provider credentials the reviewing
 * model has no use for. The fixed values below scrub the operator's global Git
 * configuration, so `codex` sees a plain `git diff` rather than a
 * difftastic-rendered one.
 */
const ENV_ALLOWLIST = [
  "HOME",
  "PATH",
  "TMPDIR",
  "USER",
  "SHELL",
  "TERM",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_ORGANIZATION",
  "OPENAI_PROJECT",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_ENDPOINT",
  "CODEX_HOME",
];

const ENV_FIXED = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_EXTERNAL_DIFF: "",
  GIT_PAGER: "cat",
  PAGER: "cat",
  GIT_TERMINAL_PROMPT: "0",
};

/** Exit 2 with a one-line reason. Every preflight failure lands here. */
export function fail(reason) {
  process.stderr.write(`closeout-review: ${reason}\n`);
  process.exit(2);
}

/**
 * The PATH every subprocess gets, with directories the branch under review
 * controls removed. Under `pnpm run` the repository's own `node_modules/.bin`
 * is the first entry on PATH, so a dependency shipping a `git` or `gh` shim
 * would otherwise decide the base, the diff and the fingerprint this tool
 * reports — and would see the operator's environment while doing it. Set once
 * the repository root is known; `resolveCodex` refuses such an entry outright
 * rather than skipping past it, because a silently different reviewer is worse
 * than a stop.
 */
let SAFE_PATH = null;

/** Record the sanitized PATH once the repository root is known. */
export function setSafePath(value) {
  SAFE_PATH = value;
}

/** A path with its links resolved, or the path itself when that fails. */
export function realOrSelf(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    return target;
  }
}

/**
 * The repository root, found on the filesystem rather than by running a
 * program. Nothing may execute off the inherited PATH before it is sanitized:
 * under `pnpm run` the repository's own `node_modules/.bin` comes first, and a
 * shim there would otherwise receive the operator's whole environment on the
 * very first call. Walk up from the working directory to the nearest `.git`
 * instead — a directory in a normal clone, a file in a worktree or submodule.
 */
export function discoverRoot() {
  let directory = realOrSelf(process.cwd());
  for (;;) {
    if (fs.existsSync(path.join(directory, ".git"))) return directory;
    const parent = path.dirname(directory);
    if (parent === directory) fail("not inside a Git repository");
    directory = parent;
  }
}

export function sanitizedPath(root) {
  const kept = [];
  for (const entry of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!entry) continue;
    let resolved;
    try {
      resolved = fs.realpathSync(path.resolve(entry));
    } catch {
      resolved = path.resolve(entry);
    }
    if (resolved === root || resolved.startsWith(`${root}${path.sep}`)) {
      continue;
    }
    kept.push(entry);
  }
  return kept.join(path.delimiter);
}

/**
 * The environment `codex` gets: the allowlist above over the fixed scrub. Built
 * once and used for every `codex` call, the version probe included, so no
 * invocation of that executable ever sees the operator's whole shell.
 */
export function codexEnv() {
  const env = { ...ENV_FIXED };
  for (const name of ENV_ALLOWLIST) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  if (SAFE_PATH !== null) env.PATH = SAFE_PATH;
  return env;
}

/**
 * Variables that redirect what Git and `gh` read and write. `codex` runs
 * under an allowlist that omits them, so leaving them in this process's own
 * Git environment would let the header and the fingerprint describe a
 * different index or object store from the one the reviewer sees.
 */
const GIT_AMBIENT = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CEILING_DIRECTORIES",
  // `gh` reads these to address a repository other than the checkout, which
  // would make the base come from somewhere the branch was never on.
  "GH_REPO",
  "GH_HOST",
];

/**
 * Git's environment-injected configuration: `GIT_CONFIG_COUNT` with its
 * `GIT_CONFIG_KEY_<n>`/`GIT_CONFIG_VALUE_<n>` pairs, and the internal
 * `GIT_CONFIG_PARAMETERS`. `codex` runs under an allowlist that omits them, so
 * an injected `core.filemode=false` would hide a change from this process's
 * fingerprint while the reviewer still saw it.
 */
const GIT_CONFIG_INJECTION =
  /^GIT_CONFIG_(?:COUNT|PARAMETERS|KEY_\d+|VALUE_\d+)$/;

/** The environment local `git` and `gh` calls run under. */
export function localGitEnv() {
  const env = { ...process.env, ...ENV_FIXED };
  for (const name of GIT_AMBIENT) delete env[name];
  for (const name of Object.keys(env)) {
    if (GIT_CONFIG_INJECTION.test(name)) delete env[name];
  }
  if (SAFE_PATH !== null) env.PATH = SAFE_PATH;
  return env;
}

/**
 * Run a command and capture its output. Never throws on a non-zero exit.
 * `env` defaults to the operator's environment plus the Git scrub, which is
 * right for `git` and `gh`; `codex` is passed `codexEnv()` instead.
 */
export function run(command, args, cwd, env) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    // A whole working-tree diff passes through here for the fingerprint below,
    // and the 1 MiB default would report a large one as a failed command.
    maxBuffer: 64 * 1024 * 1024,
    env: env ?? localGitEnv(),
  });
  return {
    ok: !result.error && result.status === 0,
    // The trimmed form is what every caller reads; `raw` is for the target
    // fingerprint, where trailing whitespace is part of what codex sees.
    raw: result.stdout ?? "",
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
  };
}

/**
 * Where a write to `target` actually lands. `path.resolve` is lexical, so an
 * ignored `.reviews/link` pointing back into a tracked directory would pass
 * the check below and then be followed by `openSync`. Resolve the deepest
 * existing ancestor through its links, and refuse a final component that is
 * itself a link rather than guessing what truncating it would do.
 */
function realDestination(target) {
  const parent = path.dirname(target);
  let realParent;
  const missing = [];
  let probe = parent;
  for (;;) {
    try {
      realParent = fs.realpathSync(probe);
      break;
    } catch {
      const next = path.dirname(probe);
      if (next === probe) return target;
      missing.unshift(path.basename(probe));
      probe = next;
    }
  }
  const resolved = path.join(realParent, ...missing, path.basename(target));
  for (const candidate of [resolved, `${resolved}.stderr.log`]) {
    let stat;
    try {
      stat = fs.lstatSync(candidate);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) {
      fail(`--out ${target} is a symbolic link; pass a real path`);
    }
  }
  return resolved;
}

/**
 * Refuse a report path that Git would track. Both the report and its sibling
 * `.stderr.log` are unscanned model output, so both have to be ignored.
 */
export function checkOutPath(repoRoot, outPath) {
  const resolved = realDestination(path.resolve(outPath));
  if (!resolved.startsWith(`${repoRoot}${path.sep}`)) return resolved;
  for (const candidate of [resolved, `${resolved}.stderr.log`]) {
    if (!run("git", ["check-ignore", "-q", candidate], repoRoot).ok) {
      fail(`--out ${outPath} is inside the repository and not ignored by Git`);
    }
  }
  return resolved;
}

/** Whether `target` is the repository root or a path under it. */
function inside(target, root) {
  return target === root || target.startsWith(`${root}${path.sep}`);
}

/**
 * Locate `codex` on PATH before running it. A bare `spawn("codex")` resolves
 * through PATH after the process has already been handed an environment, and
 * under `pnpm run` the repository's own `node_modules/.bin` is the first entry
 * on that PATH. A shim there would be the executable this tool trusts, so
 * resolve the path first, refuse one inside the tree under review, and exec the
 * absolute path from then on.
 */
export function resolveCodex(repoRoot) {
  // Both sides are resolved through symlinks before the comparison: a temporary
  // or home directory is often itself a link, and `git rev-parse` already hands
  // back the resolved form.
  let root;
  try {
    root = fs.realpathSync(repoRoot);
  } catch {
    root = repoRoot;
  }
  for (const entry of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!entry) continue;
    const candidate = path.resolve(entry, "codex");
    let directory;
    let target;
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      fs.accessSync(candidate, fs.constants.X_OK);
      directory = fs.realpathSync(path.dirname(candidate));
      // The link target as well as the directory holding it: a `~/bin/codex`
      // symlink into the checkout is outside the repository by its path and
      // inside it by what runs.
      target = fs.realpathSync(candidate);
    } catch {
      continue;
    }
    if (inside(directory, root) || inside(target, root)) {
      fail(
        `refusing the repository-controlled codex at ${candidate}; ` +
          "the branch under review must not supply its own reviewer",
      );
    }
    return candidate;
  }
  return fail(
    "codex is not on PATH; see operating-card step 4 for the fallback",
  );
}
