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
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  checkOutPath,
  codexEnv,
  discoverRoot,
  fail,
  realOrSelf,
  resolveCodex,
  run,
  sanitizedPath,
  setSafePath,
} from "./closeout-review-exec.mjs";
import {
  mergeBase,
  resolveBase,
  shortstat,
  treeFingerprint,
  verifyBase,
} from "./closeout-review-git.mjs";

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

function utcStamp(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\..*/, "");
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
    let wasInterrupted = false;
    const interrupted = (signal) => {
      wasInterrupted = true;
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
      if (outcome.timedOut || wasInterrupted) kill("SIGKILL");
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

  // The root comes off the filesystem, so PATH is sanitized before this
  // process runs anything at all. Git then confirms the directory really is
  // the top level, on the clean PATH.
  const repoRoot = discoverRoot();
  setSafePath(sanitizedPath(repoRoot));
  const toplevel = run("git", ["rev-parse", "--show-toplevel"], process.cwd());
  if (!toplevel.ok) fail("not inside a Git repository");
  if (realOrSelf(toplevel.stdout) !== repoRoot) {
    fail(
      `the nearest .git is at ${repoRoot} but Git reports ${toplevel.stdout}`,
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
    // The pid keeps two runs started in the same second on the same commit
    // from opening each other's report with "w" and reading back the wrong
    // body.
    `closeout-review-${utcStamp(started)}-${head.stdout.slice(0, 7)}-${process.pid}.md`,
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
  // `!ok` counts as moved: an unreadable HEAD is not evidence that it held.
  const moved = !headAtFinish.ok || headAtFinish.stdout !== head.stdout;
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
  } else if (targetChanged || baseMoved || moved) {
    // `moved` is checked on its own because HEAD is read before the base is
    // resolved and fetched: a commit landing in that window is already in
    // `targetBefore`, so the fingerprints agree while `head_sha` names the
    // commit codex never saw.
    reason =
      `the review target moved while codex read it (${targetChanged || moved ? "head or working tree" : `base ${base}`}); ` +
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
    ...(targetChanged || baseMoved || moved ? { target_moved: "yes" } : {}),
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
