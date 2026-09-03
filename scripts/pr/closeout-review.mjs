#!/usr/bin/env node
/**
 * Closeout review: run the second-model source review over the branch diff and
 * write its report to a file. Operating-card step 4 owns the flow; this script
 * owns the invocation.
 *
 * It is a thin exec of the finder argv the review eval measures
 * (`docs/evals/review-skill-fixtures.json`), plus `sandbox_mode="read-only"` so
 * the reviewing model cannot write the tree it reviews.
 *
 * Exit codes carry the verdict, because `codex exec review` always exits 0:
 *   0  the review ran and reported no findings
 *   1  the review ran and reported findings
 *   2  the tool did not run, or ran and produced nothing usable, or it threw
 *
 * Exit 0 is the absence of a findings heading, not a positive clean verdict:
 * `codex exec review` prints no marker a clean run can be recognized by, so an
 * unrecognized body — a refusal, a truncated answer — reads as clean. Read the
 * report, never only the exit code; operating-card step 4 says so too.
 *
 * The report is unscanned model output. It can quote credential-shaped diff
 * content, so it must stay out of Git; `--out` is refused unless the path is
 * outside the repository or ignored by it, and both files are written 0600 so
 * other accounts on a shared host cannot read them.
 *
 * `codex` stdout is written to the report file as it arrives, so a killed run
 * leaves the partial text instead of an empty file. The header block is
 * prepended once the run ends and the outcome is known.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const MODEL = "gpt-5.6-sol";
const EFFORT = "high";
const SANDBOX = "read-only";
// `codex exec review` heads its findings with either spelling, and every
// finding is a `- [P<n>] <title> — <path>:<start>-<end>` bullet. Match both, so
// a single-finding report cannot read as clean. The six frozen finder reports
// in docs/evals/review-skill-finder-reports/ are the shapes under test.
const FINDINGS_HEADING = /^(?:Full review comments|Review comments?):\s*$/m;
const FINDING_BULLET = /^- \[P\d+\] /m;
const DEFAULT_TIMEOUT_SECONDS = 3600;

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
function fail(reason) {
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

/** A path with its links resolved, or the path itself when that fails. */
function realOrSelf(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    return target;
  }
}

/**
 * The repository root, checked against the filesystem rather than taken on
 * trust. `git rev-parse --show-toplevel` answered on the inherited PATH, so a
 * shim could name any directory; the root has to hold this process's working
 * directory and carry a `.git` entry of its own.
 */
function verifiedRoot(reported) {
  const root = realOrSelf(reported);
  const cwd = realOrSelf(process.cwd());
  if (cwd !== root && !cwd.startsWith(`${root}${path.sep}`)) {
    fail(`the reported repository root ${reported} does not contain ${cwd}`);
  }
  if (!fs.existsSync(path.join(root, ".git"))) {
    fail(`the reported repository root ${reported} carries no .git`);
  }
  return root;
}

function sanitizedPath(root) {
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
function codexEnv() {
  const env = { ...ENV_FIXED };
  for (const name of ENV_ALLOWLIST) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  if (SAFE_PATH !== null) env.PATH = SAFE_PATH;
  return env;
}

/**
 * Run a command and capture its output. Never throws on a non-zero exit.
 * `env` defaults to the operator's environment plus the Git scrub, which is
 * right for `git` and `gh`; `codex` is passed `codexEnv()` instead.
 */
function run(command, args, cwd, env) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    // A whole working-tree diff passes through here for the fingerprint below,
    // and the 1 MiB default would report a large one as a failed command.
    maxBuffer: 64 * 1024 * 1024,
    env: env ?? {
      ...process.env,
      ...ENV_FIXED,
      ...(SAFE_PATH === null ? {} : { PATH: SAFE_PATH }),
    },
  });
  return {
    ok: !result.error && result.status === 0,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
  };
}

function parseArgs(argv) {
  const options = {
    base: null,
    out: null,
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
    fetch: true,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--no-fetch") {
      options.fetch = false;
    } else if (flag === "--base" && value) {
      options.base = value;
      index += 1;
    } else if (flag === "--out" && value) {
      options.out = value;
      index += 1;
    } else if (flag === "--timeout-seconds" && value) {
      const seconds = Number(value);
      if (!Number.isFinite(seconds) || seconds <= 0) {
        fail(`--timeout-seconds needs a positive number, got ${value}`);
      }
      options.timeoutSeconds = seconds;
      index += 1;
    } else {
      fail(
        `unknown argument ${flag}; usage: closeout-review [--base <ref>] ` +
          `[--out <path>] [--timeout-seconds <n>] [--no-fetch]`,
      );
    }
  }
  return options;
}

/**
 * `owner/name` for a remote URL, or null when the URL does not name a
 * repository on `github.com`. The host is part of the identity: a mirror at
 * `https://mirror.example/<owner>/<name>.git` carries the same last two path
 * segments as the GitHub repository `gh` resolved, and accepting it would let
 * a stale or third-party copy supply the base the review diffs against.
 */
function repoFromRemoteUrl(url) {
  const scp = url.match(/^(?:[^@/]+@)?([^:/]+):(.+)$/);
  let host;
  let repoPath;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    host = parsed.hostname;
    repoPath = parsed.pathname;
  } else if (scp) {
    host = scp[1];
    repoPath = scp[2];
  } else {
    return null;
  }
  if (host.toLowerCase() !== "github.com") return null;
  const match = repoPath.match(/^\/?([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  return match ? `${match[1]}/${match[2]}` : null;
}

/** The one configured remote serving `repo`. More than one is a stop. */
function remoteForRepo(repoRoot, repo) {
  const remotes = run("git", ["remote", "-v"], repoRoot);
  if (!remotes.ok) fail("cannot read the configured remotes");
  const names = new Set();
  for (const line of remotes.stdout.split("\n")) {
    const [name, url] = line.split(/\s+/);
    if (!name || !url) continue;
    if (repoFromRemoteUrl(url)?.toLowerCase() === repo.toLowerCase()) {
      names.add(name);
    }
  }
  if (names.size !== 1) {
    fail(
      `cannot resolve base: ${names.size} remotes serve ${repo}; pass --base`,
    );
  }
  return [...names][0];
}

/**
 * Mirror operating-card step 5: resolve the base repository from evidence, then
 * the remote serving it, then this branch's open PR on that repository. A
 * failed query is never read as "no PR"; it is a stop.
 */
function resolveBase(repoRoot) {
  const view = run(
    "gh",
    ["repo", "view", "--json", "nameWithOwner,parent,defaultBranchRef"],
    repoRoot,
  );
  if (!view.ok) fail("cannot resolve base: gh repo view failed; pass --base");
  let repoInfo;
  try {
    repoInfo = JSON.parse(view.stdout);
  } catch {
    fail("cannot resolve base: gh repo view returned no JSON; pass --base");
  }
  const currentRepo = repoInfo.nameWithOwner;
  const baseRepo = repoInfo.parent?.nameWithOwner ?? currentRepo;
  if (!currentRepo || !baseRepo) {
    fail("cannot resolve base: gh named no repository; pass --base");
  }
  const baseRemote = remoteForRepo(repoRoot, baseRepo);

  const branch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"], repoRoot);
  if (!branch.ok || branch.stdout === "HEAD") {
    fail("cannot resolve base: HEAD is detached; pass --base");
  }
  const list = run(
    "gh",
    [
      "pr",
      "list",
      "--repo",
      baseRepo,
      "--head",
      branch.stdout,
      "--state",
      "open",
      "--json",
      "baseRefName,headRepositoryOwner",
    ],
    repoRoot,
  );
  if (!list.ok) fail("cannot resolve base: gh pr list failed; pass --base");
  let pulls;
  try {
    pulls = JSON.parse(list.stdout);
  } catch {
    fail("cannot resolve base: gh pr list returned no JSON; pass --base");
  }
  const headOwner = currentRepo.split("/")[0].toLowerCase();
  const mine = pulls.filter(
    (pull) => pull.headRepositoryOwner?.login?.toLowerCase() === headOwner,
  );
  if (mine.length > 1) {
    fail(
      `cannot resolve base: ${mine.length} open PRs match ${branch.stdout}; pass --base`,
    );
  }
  const baseRef =
    mine.length === 1
      ? mine[0].baseRefName
      : defaultBranchOf(repoRoot, baseRepo, currentRepo, repoInfo);
  return `${baseRemote}/${baseRef}`;
}

/**
 * The base repository's default branch. Card step 4 runs before the PR exists,
 * so zero open PRs is the normal first pass, not an error; the branch it falls
 * back to is read from the repository rather than assumed to be `main`.
 */
function defaultBranchOf(repoRoot, baseRepo, currentRepo, repoInfo) {
  let branch;
  if (baseRepo === currentRepo) {
    branch = repoInfo.defaultBranchRef?.name ?? null;
  } else {
    const view = run(
      "gh",
      ["repo", "view", baseRepo, "--json", "defaultBranchRef"],
      repoRoot,
    );
    if (!view.ok) {
      fail(`cannot resolve base: gh repo view ${baseRepo} failed; pass --base`);
    }
    try {
      branch = JSON.parse(view.stdout).defaultBranchRef?.name ?? null;
    } catch {
      branch = null;
    }
  }
  if (!branch) {
    fail(
      `cannot resolve base: no open PR for this branch and ${baseRepo} names ` +
        "no default branch; pass --base",
    );
  }
  return branch;
}

/**
 * Fetch the base when it is a remote-tracking ref, then verify it resolves. A
 * failed fetch is fatal: a stale tracking ref still resolves, so continuing
 * would review the wrong base without saying so.
 */
function verifyBase(repoRoot, base, shouldFetch) {
  const parts = base.match(/^([^/]+)\/(.+)$/);
  if (shouldFetch && parts) {
    const remotes = run("git", ["remote"], repoRoot);
    if (remotes.ok && remotes.stdout.split("\n").includes(parts[1])) {
      const fetched = run(
        "git",
        ["fetch", "--quiet", parts[1], parts[2]],
        repoRoot,
      );
      if (!fetched.ok) {
        fail(`cannot fetch ${base}: ${fetched.stderr || "git fetch failed"}`);
      }
    }
  }
  const sha = run(
    "git",
    ["rev-parse", "--verify", "--quiet", `${base}^{commit}`],
    repoRoot,
  );
  if (!sha.ok || !sha.stdout) fail(`base ${base} does not resolve to a commit`);
  return sha.stdout;
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
function checkOutPath(repoRoot, outPath) {
  const resolved = realDestination(path.resolve(outPath));
  if (!resolved.startsWith(`${repoRoot}${path.sep}`)) return resolved;
  for (const candidate of [resolved, `${resolved}.stderr.log`]) {
    if (!run("git", ["check-ignore", "-q", candidate], repoRoot).ok) {
      fail(`--out ${outPath} is inside the repository and not ignored by Git`);
    }
  }
  return resolved;
}

function utcStamp(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\..*/, "");
}

/**
 * The commit codex reviews from. Its own report summaries say "against the
 * specified merge base", so a base holding commits HEAD does not have — a base
 * that moved after the last merge forward — must not be diffed directly: the
 * two-dot form would count those base-only changes in reverse and overstate
 * the branch. No merge base is a stop: a shallow or single-branch checkout can
 * resolve the base ref and still hold no common ancestry, and the header hands
 * `merge_base_sha` to the reviewer as a commit naming the reviewed range.
 */
function mergeBase(repoRoot, base) {
  const found = run("git", ["merge-base", "HEAD", base], repoRoot);
  if (!found.ok || !/^[0-9a-f]{40}$/.test(found.stdout)) {
    fail(
      `no merge base between HEAD and ${base}; deepen the checkout ` +
        "(git fetch --unshallow) or pass a --base that shares history",
    );
  }
  return found.stdout;
}

/**
 * The size codex will see. It diffs the working tree against the merge base,
 * not `base...HEAD`, so this uses the two-dot form against that commit.
 * Untracked files appear in neither; the `dirty` header field is the flag for
 * uncommitted work.
 */
function shortstat(repoRoot, from) {
  const stat = run(
    "git",
    ["diff", "--no-ext-diff", "--shortstat", from],
    repoRoot,
  );
  return stat.ok && stat.stdout ? stat.stdout : "0 files changed";
}

/**
 * What the reviewer is reading: HEAD, the index and working-tree state, and the
 * tracked content that differs from HEAD. It is taken before the run and again
 * after it, so a target that shifts under the reviewer is caught instead of
 * being reported as reviewed. `dirty` alone cannot do this: an edit to an
 * already-modified file leaves the flag and the status lines unchanged.
 * Untracked content is outside the fingerprint exactly as it is outside
 * `--base`; the status listing still names those paths.
 */
function treeFingerprint(repoRoot) {
  const parts = [
    run("git", ["rev-parse", "HEAD"], repoRoot),
    run("git", ["status", "--porcelain"], repoRoot),
    run("git", ["diff", "--no-ext-diff", "HEAD"], repoRoot),
  ];
  if (parts.some((part) => !part.ok)) return null;
  return createHash("sha256")
    .update(parts.map((part) => part.stdout).join("\0"))
    .digest("hex");
}

/**
 * Locate `codex` on PATH before running it. A bare `spawn("codex")` resolves
 * through PATH after the process has already been handed an environment, and
 * under `pnpm run` the repository's own `node_modules/.bin` is the first entry
 * on that PATH. A shim there would be the executable this tool trusts, so
 * resolve the path first, refuse one inside the tree under review, and exec the
 * absolute path from then on.
 */
function resolveCodex(repoRoot) {
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
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      fs.accessSync(candidate, fs.constants.X_OK);
      directory = fs.realpathSync(path.dirname(candidate));
    } catch {
      continue;
    }
    // The directory, not the executable: a link inside the repository still
    // lets the branch choose what runs, wherever it points.
    if (directory === root || directory.startsWith(`${root}${path.sep}`)) {
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

/** Spawn codex in its own process group so a timeout can kill the whole tree. */
function runCodex(repoRoot, codexBin, base, reportPath, timeoutSeconds) {
  const env = codexEnv();
  const argv = [
    "exec",
    "review",
    "--base",
    base,
    "-m",
    MODEL,
    "-c",
    `model_reasoning_effort="${EFFORT}"`,
    "-c",
    `sandbox_mode="${SANDBOX}"`,
  ];
  // Both files hold unscanned model output that can quote the diff, so keep
  // them owner-only. The mode argument applies to a file this call creates;
  // fchmod covers one that already exists under a reused `--out` path.
  const bodyFd = fs.openSync(reportPath, "w", 0o600);
  const stderrFd = fs.openSync(`${reportPath}.stderr.log`, "w", 0o600);
  fs.fchmodSync(bodyFd, 0o600);
  fs.fchmodSync(stderrFd, 0o600);
  const child = spawn(codexBin, argv, {
    cwd: repoRoot,
    env,
    detached: true,
    stdio: ["ignore", bodyFd, stderrFd],
  });

  return new Promise((resolve) => {
    let timedOut = false;
    // A failed spawn can emit both "error" and "close"; settle once, so the
    // two descriptors are never closed twice.
    let settled = false;
    const kill = (signal) => {
      try {
        process.kill(-child.pid, signal);
      } catch {
        /* the group is already gone */
      }
    };
    const deadline = setTimeout(() => {
      timedOut = true;
      kill("SIGTERM");
      setTimeout(() => kill("SIGKILL"), 5000).unref();
    }, timeoutSeconds * 1000);
    // The child is in its own process group, so a Ctrl-C or a SIGTERM aimed at
    // this wrapper never reaches it: without these handlers an hour-long paid
    // review keeps running, and keeps writing the report, after the command
    // appears cancelled.
    let interruptTimer = null;
    const interrupted = (signal) => {
      kill("SIGTERM");
      if (interruptTimer) return;
      // A last resort for a child that ignores SIGTERM: the normal path is the
      // "close" event below, which settles and lets the caller report the run.
      interruptTimer = setTimeout(() => {
        kill("SIGKILL");
        process.exit(signal === "SIGINT" ? 130 : 143);
      }, 2000);
      interruptTimer.unref();
    };
    const handlers = ["SIGINT", "SIGTERM", "SIGHUP"].map((signal) => {
      const handler = () => interrupted(signal);
      process.on(signal, handler);
      return [signal, handler];
    });
    const settle = (outcome) => {
      if (settled) return;
      settled = true;
      for (const [signal, handler] of handlers) {
        process.removeListener(signal, handler);
      }
      if (interruptTimer) clearTimeout(interruptTimer);
      clearTimeout(deadline);
      // codex can exit on SIGTERM while a descendant ignores it, so sweep the
      // group again rather than trusting an unreferenced escalation timer.
      if (outcome.timedOut) kill("SIGKILL");
      fs.closeSync(bodyFd);
      fs.closeSync(stderrFd);
      resolve(outcome);
    };
    child.on("error", (error) =>
      settle({ code: null, timedOut: false, spawnError: error.message }),
    );
    child.on("close", (code) => settle({ code, timedOut, spawnError: null }));
  });
}

function renderHeader(fields) {
  const lines = Object.entries(fields).map(
    ([key, value]) => `${key}: ${value}`,
  );
  return `${lines.join("\n")}\n---\n\n`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  const toplevel = run("git", ["rev-parse", "--show-toplevel"], process.cwd());
  if (!toplevel.ok) fail("not inside a Git repository");
  // This first call still ran on the inherited PATH, which under `pnpm run`
  // starts with the repository's own `node_modules/.bin`. Check the answer
  // against the filesystem, sanitize PATH against it, then read the root again
  // through the sanitized PATH: a shim that lies about the root is caught by
  // one of the two, and everything after this point runs on the clean PATH.
  const repoRoot = verifiedRoot(toplevel.stdout);
  SAFE_PATH = sanitizedPath(repoRoot);
  const recheck = run("git", ["rev-parse", "--show-toplevel"], process.cwd());
  if (!recheck.ok || realOrSelf(recheck.stdout) !== repoRoot) {
    fail(
      "the repository root disagrees between the inherited and sanitized PATH",
    );
  }

  if (process.env.CODEX_SANDBOX || process.env.CODEX_THREAD_ID) {
    fail(
      "refusing to run inside an active Codex session: nested `codex exec` is unavailable",
    );
  }
  const codexBin = resolveCodex(repoRoot);
  const version = run(codexBin, ["--version"], repoRoot, codexEnv());
  if (!version.ok) {
    fail(`codex at ${codexBin} does not answer --version`);
  }

  const status = run("git", ["status", "--porcelain"], repoRoot);
  if (!status.ok) fail("cannot read the working-tree state");
  const head = run("git", ["rev-parse", "HEAD"], repoRoot);
  if (!head.ok) fail("cannot read HEAD");
  const branch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"], repoRoot);

  const base = options.base ?? resolveBase(repoRoot);
  const baseSha = verifyBase(repoRoot, base, options.fetch);
  const mergeBaseSha = mergeBase(repoRoot, base);
  const targetBefore = treeFingerprint(repoRoot);
  if (targetBefore === null) fail("cannot fingerprint the review target");

  const started = new Date();
  const defaultOut = path.join(
    repoRoot,
    ".reviews",
    `closeout-review-${utcStamp(started)}-${head.stdout.slice(0, 7)}.md`,
  );
  const reportPath = checkOutPath(repoRoot, options.out ?? defaultOut);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });

  process.stdout.write(
    `diff: ${shortstat(repoRoot, mergeBaseSha)} against ${base} (merge base ${mergeBaseSha.slice(0, 7)})\n`,
  );

  const result = await runCodex(
    repoRoot,
    codexBin,
    base,
    reportPath,
    options.timeoutSeconds,
  );
  const body = fs.readFileSync(reportPath, "utf8");

  // codex re-reads the tree and re-resolves the base ref while it runs, so a
  // commit, an edit or a sibling fetch landing mid-run moves what the report
  // actually covers. Compare both ends before believing the report.
  const headAtFinish = run("git", ["rev-parse", "HEAD"], repoRoot);
  const baseAtFinish = run(
    "git",
    ["rev-parse", "--verify", "--quiet", `${base}^{commit}`],
    repoRoot,
  );
  const targetAfter = treeFingerprint(repoRoot);
  const moved = headAtFinish.ok && headAtFinish.stdout !== head.stdout;
  const baseMoved = !baseAtFinish.ok || baseAtFinish.stdout !== baseSha;
  const targetChanged = targetAfter === null || targetAfter !== targetBefore;

  let verdict = "failed";
  let exitCode = 2;
  let reason = null;
  if (result.spawnError) {
    reason = `codex did not start: ${result.spawnError}`;
  } else if (result.timedOut) {
    reason = `codex timed out after ${options.timeoutSeconds}s; the partial report is kept`;
  } else if (result.code !== 0) {
    // The transcript holds unscanned model output and quoted diff text. Name
    // the owner-only file rather than copying its tail into a terminal or a CI
    // log that keeps it.
    reason =
      `codex exited ${result.code}; its transcript is ` +
      `${reportPath}.stderr.log`;
  } else if (body.trim() === "") {
    reason = "codex produced an empty report";
  } else if (targetChanged || baseMoved) {
    reason =
      `the review target moved while codex read it (${targetChanged ? "head or working tree" : `base ${base}`}); ` +
      "the report does not describe the diff in its header";
  } else if (FINDINGS_HEADING.test(body) || FINDING_BULLET.test(body)) {
    verdict = "findings";
    exitCode = 1;
  } else {
    verdict = "clean";
    exitCode = 0;
  }

  const header = renderHeader({
    tool: "scripts/pr/closeout-review.mjs",
    codex_version: version.stdout.split("\n")[0],
    model: MODEL,
    reasoning_effort: EFFORT,
    sandbox: SANDBOX,
    base_ref: base,
    base_sha: baseSha,
    merge_base_sha: mergeBaseSha,
    head_sha: head.stdout,
    // `head_sha` plus `dirty` does not name the bytes codex read when the tree
    // carries uncommitted work. This does, and it is checkable: re-run the
    // fingerprint over the same three inputs and compare.
    target_fingerprint: targetBefore,
    branch: branch.ok ? branch.stdout : "unknown",
    dirty: status.stdout === "" ? "no" : "yes",
    started: started.toISOString(),
    finished: new Date().toISOString(),
    codex_exit_code: result.code === null ? "none" : result.code,
    ...(moved ? { head_sha_at_finish: headAtFinish.stdout } : {}),
    ...(baseMoved && baseAtFinish.ok
      ? { base_sha_at_finish: baseAtFinish.stdout }
      : {}),
    ...(targetChanged || baseMoved ? { target_moved: "yes" } : {}),
    verdict,
  });
  const footer = result.timedOut
    ? `\n\nTIMED OUT after ${options.timeoutSeconds}s\n`
    : "";
  fs.writeFileSync(reportPath, `${header}${body}${footer}`, { mode: 0o600 });

  if (reason) process.stderr.write(`closeout-review: ${reason}\n`);
  process.stdout.write(`report: ${reportPath}\n`);
  // Set the code rather than calling process.exit, so the last stdout line is
  // never truncated when stdout is a pipe.
  process.exitCode = exitCode;
}

// Exit 1 means "the review ran and found things". Nothing else may produce it,
// so an unexpected throw — an unwritable `--out` directory, a full disk — lands
// on the tool-failure code rather than reading as findings.
try {
  await main();
} catch (error) {
  fail(`unexpected failure: ${error?.stack ?? error}`);
}
