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
 *   2  the tool did not run, or ran and produced nothing usable
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

/** Run a command and capture its output. Never throws on a non-zero exit. */
function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    // A whole working-tree diff passes through here for the fingerprint below,
    // and the 1 MiB default would report a large one as a failed command.
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...ENV_FIXED },
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

/** `owner/name` for a remote URL, or null when the URL names no GitHub repo. */
function repoFromRemoteUrl(url) {
  const match = url.match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/);
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
    ["repo", "view", "--json", "nameWithOwner,parent"],
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
  const baseRef = mine.length === 1 ? mine[0].baseRefName : "main";
  return `${baseRemote}/${baseRef}`;
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
 * Refuse a report path that Git would track. Both the report and its sibling
 * `.stderr.log` are unscanned model output, so both have to be ignored.
 */
function checkOutPath(repoRoot, outPath) {
  const resolved = path.resolve(outPath);
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
 * The size codex will see. It diffs the working tree against the base, not
 * `base...HEAD`, so this uses the same two-dot form. Untracked files appear in
 * neither; the `dirty` header field is the flag for uncommitted work.
 */
function shortstat(repoRoot, base) {
  const stat = run(
    "git",
    ["diff", "--no-ext-diff", "--shortstat", base],
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

/** Spawn codex in its own process group so a timeout can kill the whole tree. */
function runCodex(repoRoot, base, reportPath, timeoutSeconds) {
  const env = { ...ENV_FIXED };
  for (const name of ENV_ALLOWLIST) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
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
  // fchmod covers one that already exists under a re-used `--out` path.
  const bodyFd = fs.openSync(reportPath, "w", 0o600);
  const stderrFd = fs.openSync(`${reportPath}.stderr.log`, "w", 0o600);
  fs.fchmodSync(bodyFd, 0o600);
  fs.fchmodSync(stderrFd, 0o600);
  const child = spawn("codex", argv, {
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
    const settle = (outcome) => {
      if (settled) return;
      settled = true;
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
  const repoRoot = toplevel.stdout;

  if (process.env.CODEX_SANDBOX || process.env.CODEX_THREAD_ID) {
    fail(
      "refusing to run inside an active Codex session: nested `codex exec` is unavailable",
    );
  }
  const version = run("codex", ["--version"], repoRoot);
  if (!version.ok) {
    fail("codex is not on PATH; see operating-card step 4 for the fallback");
  }

  const status = run("git", ["status", "--porcelain"], repoRoot);
  if (!status.ok) fail("cannot read the working-tree state");
  const head = run("git", ["rev-parse", "HEAD"], repoRoot);
  if (!head.ok) fail("cannot read HEAD");
  const branch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"], repoRoot);

  const base = options.base ?? resolveBase(repoRoot);
  const baseSha = verifyBase(repoRoot, base, options.fetch);
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
    `diff: ${shortstat(repoRoot, base)} against ${base} (${baseSha.slice(0, 7)})\n`,
  );

  const result = await runCodex(
    repoRoot,
    base,
    reportPath,
    options.timeoutSeconds,
  );
  const body = fs.readFileSync(reportPath, "utf8");
  const stderrTail = fs
    .readFileSync(`${reportPath}.stderr.log`, "utf8")
    .split("\n")
    .slice(-20)
    .join("\n");

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
    reason = `codex exited ${result.code}\n${stderrTail}`;
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
    head_sha: head.stdout,
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

await main();
