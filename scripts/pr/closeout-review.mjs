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
 * The report is unscanned model output. It can quote credential-shaped diff
 * content, so it must stay out of Git; `--out` is refused unless the path is
 * outside the repository or ignored by it.
 *
 * `codex` stdout is written to the report file as it arrives, so a killed run
 * leaves the partial text instead of an empty file. The header block is
 * prepended once the run ends and the outcome is known.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const MODEL = "gpt-5.6-sol";
const EFFORT = "high";
const SANDBOX = "read-only";
const FINDINGS_MARKER = /^Full review comments:\s*$/m;
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

/** Fetch the base when it is a remote-tracking ref, then verify it resolves. */
function verifyBase(repoRoot, base, shouldFetch) {
  const parts = base.match(/^([^/]+)\/(.+)$/);
  if (shouldFetch && parts) {
    const remotes = run("git", ["remote"], repoRoot);
    if (remotes.ok && remotes.stdout.split("\n").includes(parts[1])) {
      run("git", ["fetch", "--quiet", parts[1], parts[2]], repoRoot);
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

/** Refuse a report path that Git would track. The report is unscanned output. */
function checkOutPath(repoRoot, outPath) {
  const resolved = path.resolve(outPath);
  if (!resolved.startsWith(`${repoRoot}${path.sep}`)) return resolved;
  const ignored = run("git", ["check-ignore", "-q", resolved], repoRoot);
  if (!ignored.ok) {
    fail(`--out ${outPath} is inside the repository and not ignored by Git`);
  }
  return resolved;
}

function utcStamp(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\..*/, "");
}

function shortstat(repoRoot, base) {
  const stat = run(
    "git",
    ["diff", "--no-ext-diff", "--shortstat", `${base}...HEAD`],
    repoRoot,
  );
  return stat.ok && stat.stdout ? stat.stdout : "0 files changed";
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
  const bodyFd = fs.openSync(reportPath, "w");
  const stderrFd = fs.openSync(`${reportPath}.stderr.log`, "w");
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
  } else if (FINDINGS_MARKER.test(body)) {
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
    verdict,
  });
  const footer = result.timedOut
    ? `\n\nTIMED OUT after ${options.timeoutSeconds}s\n`
    : "";
  fs.writeFileSync(reportPath, `${header}${body}${footer}`);

  if (reason) process.stderr.write(`closeout-review: ${reason}\n`);
  process.stdout.write(`report: ${reportPath}\n`);
  // Set the code rather than calling process.exit, so the last stdout line is
  // never truncated when stdout is a pipe.
  process.exitCode = exitCode;
}

await main();
