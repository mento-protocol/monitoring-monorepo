/**
 * Suite for `scripts/pr/closeout-review.mjs`.
 *
 * No network and no real `codex`. Each case builds a throwaway Git repository
 * and puts a generated fake `codex` first on PATH, so the script's own
 * behaviour — exit codes, the report file, the header, the argv it sends, and
 * the environment allowlist — is what gets asserted.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./closeout-review.mjs", import.meta.url));

/** The real `git`, so a case can build a PATH that holds git and nothing else. */
const GIT_BIN =
  spawnSync("sh", ["-c", "command -v git"], {
    encoding: "utf8",
  }).stdout.trim() || "/usr/bin/git";

/** A directory whose only executable is `git`. Used to prove the codex preflight. */
function gitOnlyDir(root) {
  const dir = path.join(root, "git-only");
  fs.mkdirSync(dir, { recursive: true });
  fs.symlinkSync(GIT_BIN, path.join(dir, "git"));
  return dir;
}

/** Git with the operator's global configuration out of the way. */
function git(cwd, ...args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  assert.equal(
    result.status,
    0,
    `git ${args.join(" ")} failed: ${result.stderr}`,
  );
  return result.stdout.trim();
}

/**
 * A repository with one commit on `base`, one on `HEAD`, and `.reviews/`
 * ignored, plus an empty `bin/` for the fake `codex`.
 */
function makeRepo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "closeout-review-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  const bin = path.join(root, "bin");
  fs.mkdirSync(repo);
  fs.mkdirSync(bin);

  git(repo, "init", "--quiet", "--initial-branch=main");
  git(repo, "config", "user.email", "test@example.invalid");
  git(repo, "config", "user.name", "Closeout Review Test");
  fs.writeFileSync(path.join(repo, ".gitignore"), ".reviews/\n");
  fs.writeFileSync(path.join(repo, "math.js"), "export const sum = () => 0;\n");
  git(repo, "add", "-A");
  git(repo, "commit", "--quiet", "-m", "base");
  git(repo, "branch", "base");
  fs.writeFileSync(path.join(repo, "math.js"), "export const sum = () => 1;\n");
  git(repo, "add", "-A");
  git(repo, "commit", "--quiet", "-m", "head");

  return { root, repo, bin };
}

/** Write a fake `codex` that answers `--version` and then runs `body`. */
function fakeCodex(bin, body) {
  const file = path.join(bin, "codex");
  fs.writeFileSync(
    file,
    [
      "#!/bin/sh",
      'if [ "$1" = "--version" ]; then',
      '  echo "codex-cli 9.9.9-fake"',
      "  exit 0",
      "fi",
      body,
    ].join("\n") + "\n",
  );
  fs.chmodSync(file, 0o755);
}

/** Run the script under test. Its PATH finds the fake `codex` first. */
function runScript({ repo, bin }, args = [], extraEnv = {}, pathValue = null) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: repo,
    encoding: "utf8",
    env: {
      PATH: pathValue ?? `${bin}:${process.env.PATH}`,
      HOME: process.env.HOME,
      GH_TOKEN: "secret-gh-token",
      OPENAI_API_KEY: "secret-openai-key",
      ...extraEnv,
    },
  });
  const lines = result.stdout.trim().split("\n");
  const reportLine = lines[lines.length - 1];
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    lastLine: reportLine,
    reportPath: reportLine?.startsWith("report: ")
      ? reportLine.slice("report: ".length)
      : null,
  };
}

test("a clean report exits 0 and prints the report path last", (t) => {
  const repo = makeRepo(t);
  fakeCodex(repo.bin, 'echo "No issues found in this patch."');

  const run = runScript(repo, ["--base", "base", "--no-fetch"]);

  assert.equal(run.status, 0);
  assert.match(run.stdout, /^diff: .* against base \([0-9a-f]{7}\)$/m);
  assert.ok(run.reportPath, `no report path in: ${run.stdout}`);
  const report = fs.readFileSync(run.reportPath, "utf8");
  assert.match(report, /^verdict: clean$/m);
  assert.match(report, /No issues found in this patch\./);
});

test("a report naming findings exits 1", (t) => {
  const repo = makeRepo(t);
  fakeCodex(
    repo.bin,
    [
      'echo "The patch breaks the exported API."',
      'echo ""',
      'echo "Full review comments:"',
      'echo ""',
      'echo "- [P1] Stop the loop early — math.js:10-10"',
    ].join("\n"),
  );

  const run = runScript(repo, ["--base", "base", "--no-fetch"]);

  assert.equal(run.status, 1);
  const report = fs.readFileSync(run.reportPath, "utf8");
  assert.match(report, /^verdict: findings$/m);
  assert.match(report, /^Full review comments:$/m);
});

test("the header records the run's provenance", (t) => {
  const repo = makeRepo(t);
  fakeCodex(repo.bin, 'echo "clean"');

  const run = runScript(repo, ["--base", "base", "--no-fetch"]);
  const report = fs.readFileSync(run.reportPath, "utf8");

  assert.match(report, /^tool: scripts\/pr\/closeout-review\.mjs$/m);
  assert.match(report, /^codex_version: codex-cli 9\.9\.9-fake$/m);
  assert.match(report, /^model: gpt-5\.6-sol$/m);
  assert.match(report, /^reasoning_effort: high$/m);
  assert.match(report, /^sandbox: read-only$/m);
  assert.match(report, /^base_ref: base$/m);
  assert.equal(
    report.match(/^base_sha: ([0-9a-f]{40})$/m)[1],
    git(repo.repo, "rev-parse", "base"),
  );
  assert.equal(
    report.match(/^head_sha: ([0-9a-f]{40})$/m)[1],
    git(repo.repo, "rev-parse", "HEAD"),
  );
  assert.match(report, /^branch: main$/m);
  assert.match(report, /^dirty: no$/m);
  assert.match(report, /^codex_exit_code: 0$/m);
  assert.match(report, /^---$/m);
});

test("a commit landing during the run is recorded in the header", (t) => {
  const repo = makeRepo(t);
  // The fake codex commits while the script is waiting on it.
  fakeCodex(
    repo.bin,
    [
      `cd ${JSON.stringify(repo.repo)}`,
      'echo "moved" > moved.txt',
      "git add -A",
      "git commit --quiet -m during-run",
      'echo "clean"',
    ].join("\n"),
  );

  const run = runScript(repo, ["--base", "base", "--no-fetch"]);

  const report = fs.readFileSync(run.reportPath, "utf8");
  assert.equal(
    report.match(/^head_sha_at_finish: ([0-9a-f]{40})$/m)[1],
    git(repo.repo, "rev-parse", "HEAD"),
  );
});

test("a dirty working tree is recorded in the header", (t) => {
  const repo = makeRepo(t);
  fakeCodex(repo.bin, 'echo "clean"');
  fs.writeFileSync(path.join(repo.repo, "math.js"), "export const sum = 2;\n");

  const run = runScript(repo, ["--base", "base", "--no-fetch"]);

  assert.match(fs.readFileSync(run.reportPath, "utf8"), /^dirty: yes$/m);
});

test("codex receives the pinned argv and an allowlisted environment", (t) => {
  const repo = makeRepo(t);
  const argvDump = path.join(repo.root, "argv.txt");
  const envDump = path.join(repo.root, "env.txt");
  fakeCodex(
    repo.bin,
    [
      `for arg in "$@"; do echo "$arg" >> ${JSON.stringify(argvDump)}; done`,
      `env > ${JSON.stringify(envDump)}`,
      'echo "clean"',
    ].join("\n"),
  );

  const run = runScript(repo, ["--base", "base", "--no-fetch"]);
  assert.equal(run.status, 0);

  assert.deepEqual(fs.readFileSync(argvDump, "utf8").trim().split("\n"), [
    "exec",
    "review",
    "--base",
    "base",
    "-m",
    "gpt-5.6-sol",
    "-c",
    'model_reasoning_effort="high"',
    "-c",
    'sandbox_mode="read-only"',
  ]);

  const env = new Map(
    fs
      .readFileSync(envDump, "utf8")
      .split("\n")
      .map((line) => {
        const at = line.indexOf("=");
        return at === -1 ? null : [line.slice(0, at), line.slice(at + 1)];
      })
      .filter(Boolean),
  );
  assert.equal(env.has("GH_TOKEN"), false, "GH_TOKEN reached codex");
  assert.equal(env.get("OPENAI_API_KEY"), "secret-openai-key");
  assert.equal(env.get("GIT_CONFIG_GLOBAL"), "/dev/null");
  assert.equal(env.get("GIT_CONFIG_SYSTEM"), "/dev/null");
  assert.equal(env.get("GIT_EXTERNAL_DIFF"), "");
  assert.equal(env.get("GIT_TERMINAL_PROMPT"), "0");
});

test("every frozen finder report shape is read as findings", (t) => {
  // Three of the six use the singular `Review comment:` heading. A detector
  // that only knows `Full review comments:` reports those as clean.
  const dir = fileURLToPath(
    new URL("../../docs/evals/review-skill-finder-reports/", import.meta.url),
  );
  const reports = fs.readdirSync(dir).filter((name) => name.endsWith(".md"));
  assert.equal(reports.length, 6);

  for (const name of reports) {
    const repo = makeRepo(t);
    fakeCodex(repo.bin, `cat ${JSON.stringify(path.join(dir, name))}`);
    const run = runScript(repo, ["--base", "base", "--no-fetch"]);
    assert.equal(run.status, 1, `${name} was not read as findings`);
  }
});

test("the printed diff size counts uncommitted work, as codex does", (t) => {
  const repo = makeRepo(t);
  fakeCodex(repo.bin, 'echo "clean"');
  // Tracked and modified but not committed: `base...HEAD` would miss it.
  fs.appendFileSync(path.join(repo.repo, ".gitignore"), "extra/\n");

  const run = runScript(repo, ["--base", "base", "--no-fetch"]);

  assert.match(run.stdout, /^diff: 2 files changed/m);
});

test("a failed base fetch is fatal rather than silently stale", (t) => {
  const repo = makeRepo(t);
  fakeCodex(repo.bin, 'echo "clean"');
  git(repo.repo, "remote", "add", "gone", path.join(repo.root, "missing.git"));

  const run = runScript(repo, ["--base", "gone/main"]);

  assert.equal(run.status, 2);
  assert.match(run.stderr, /cannot fetch gone\/main/);
  assert.equal(run.reportPath, null);
});

test("an empty report exits 2", (t) => {
  const repo = makeRepo(t);
  fakeCodex(repo.bin, "exit 0");

  const run = runScript(repo, ["--base", "base", "--no-fetch"]);

  assert.equal(run.status, 2);
  assert.match(run.stderr, /empty report/);
  assert.ok(run.reportPath, "the report path is still printed");
});

test("a non-zero codex exit is a tool failure, not a finding", (t) => {
  const repo = makeRepo(t);
  fakeCodex(repo.bin, ['echo "boom" >&2', "exit 7"].join("\n"));

  const run = runScript(repo, ["--base", "base", "--no-fetch"]);

  assert.equal(run.status, 2);
  assert.match(run.stderr, /codex exited 7/);
  assert.match(run.stderr, /boom/);
  assert.match(fs.readFileSync(run.reportPath, "utf8"), /^verdict: failed$/m);
});

test("a timeout keeps the partial report and exits 2", (t) => {
  const repo = makeRepo(t);
  fakeCodex(repo.bin, ['echo "partial finding text"', "sleep 30"].join("\n"));

  const run = runScript(repo, [
    "--base",
    "base",
    "--no-fetch",
    "--timeout-seconds",
    "1",
  ]);

  assert.equal(run.status, 2);
  assert.match(run.stderr, /timed out after 1s/);
  const report = fs.readFileSync(run.reportPath, "utf8");
  assert.match(report, /partial finding text/);
  assert.match(report, /TIMED OUT after 1s/);
});

test("an unresolvable base exits 2 before codex runs", (t) => {
  const repo = makeRepo(t);
  fakeCodex(repo.bin, 'echo "clean"');

  const run = runScript(repo, ["--base", "no-such-ref", "--no-fetch"]);

  assert.equal(run.status, 2);
  assert.match(run.stderr, /base no-such-ref does not resolve/);
  assert.equal(run.reportPath, null);
});

test("an --out path Git would track is refused", (t) => {
  const repo = makeRepo(t);
  fakeCodex(repo.bin, 'echo "clean"');

  const tracked = runScript(repo, [
    "--base",
    "base",
    "--no-fetch",
    "--out",
    "report.md",
  ]);
  assert.equal(tracked.status, 2);
  assert.match(tracked.stderr, /not ignored by Git/);
  assert.equal(fs.existsSync(path.join(repo.repo, "report.md")), false);

  // The sibling stderr log is unscanned output too, so it must also be ignored.
  fs.appendFileSync(path.join(repo.repo, ".gitignore"), "kept.md\n");
  const halfIgnored = runScript(repo, [
    "--base",
    "base",
    "--no-fetch",
    "--out",
    "kept.md",
  ]);
  assert.equal(halfIgnored.status, 2);
  assert.match(halfIgnored.stderr, /not ignored by Git/);

  const ignored = runScript(repo, [
    "--base",
    "base",
    "--no-fetch",
    "--out",
    ".reviews/chosen.md",
  ]);
  assert.equal(ignored.status, 0);
  assert.equal(
    fs.realpathSync(ignored.reportPath),
    fs.realpathSync(path.join(repo.repo, ".reviews/chosen.md")),
  );
});

test("an active Codex session is refused", (t) => {
  const repo = makeRepo(t);
  fakeCodex(repo.bin, 'echo "clean"');

  for (const marker of ["CODEX_THREAD_ID", "CODEX_SANDBOX"]) {
    const run = runScript(repo, ["--base", "base", "--no-fetch"], {
      [marker]: "1",
    });
    assert.equal(run.status, 2, `${marker} did not refuse`);
    assert.match(run.stderr, /nested `codex exec` is unavailable/);
  }
});

test("a missing codex CLI is refused with the fallback pointer", (t) => {
  const repo = makeRepo(t);

  const run = runScript(
    repo,
    ["--base", "base", "--no-fetch"],
    {},
    `${repo.bin}:${gitOnlyDir(repo.root)}`,
  );

  assert.equal(run.status, 2);
  assert.match(run.stderr, /codex is not on PATH/);
});

test("an unknown argument is refused with the usage line", (t) => {
  const repo = makeRepo(t);
  fakeCodex(repo.bin, 'echo "clean"');

  const run = runScript(repo, ["--engine", "claude"]);

  assert.equal(run.status, 2);
  assert.match(run.stderr, /unknown argument --engine/);
  assert.match(run.stderr, /usage: closeout-review/);
});
