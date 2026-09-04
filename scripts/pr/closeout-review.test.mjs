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

import { RUN_TIMEOUT_MS, run } from "./closeout-review-exec.mjs";

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
  assert.match(
    run.stdout,
    /^diff: .* against base \(merge base [0-9a-f]{7}\)$/m,
  );
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

test("a commit landing during the run voids the report", (t) => {
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

  assert.equal(run.status, 2);
  assert.match(run.stderr, /the review target moved while codex read it/);
  const report = fs.readFileSync(run.reportPath, "utf8");
  assert.equal(
    report.match(/^head_sha_at_finish: ([0-9a-f]{40})$/m)[1],
    git(repo.repo, "rev-parse", "HEAD"),
  );
  assert.match(report, /^target_moved: yes$/m);
  assert.match(report, /^verdict: failed$/m);
});

test("an edit to an already-modified file during the run voids the report", (t) => {
  const repo = makeRepo(t);
  const tracked = path.join(repo.repo, "math.js");
  // Dirty before the run, and dirty differently after it: `dirty` and the
  // status lines are identical at both ends, so only the content fingerprint
  // can tell that codex read something else.
  fs.writeFileSync(tracked, "export const sum = () => 2;\n");
  fakeCodex(
    repo.bin,
    [
      `printf 'export const sum = () => 3;\\n' > ${JSON.stringify(tracked)}`,
      'echo "clean"',
    ].join("\n"),
  );

  const run = runScript(repo, ["--base", "base", "--no-fetch"]);

  assert.equal(run.status, 2);
  const report = fs.readFileSync(run.reportPath, "utf8");
  assert.match(report, /^dirty: yes$/m);
  assert.doesNotMatch(report, /^head_sha_at_finish:/m);
  assert.match(report, /^target_moved: yes$/m);
});

test("a base ref moving during the run voids the report", (t) => {
  const repo = makeRepo(t);
  // The fake codex advances the base branch the header pins.
  fakeCodex(
    repo.bin,
    [
      `cd ${JSON.stringify(repo.repo)}`,
      "git branch -f base HEAD",
      'echo "clean"',
    ].join("\n"),
  );
  const baseShaBefore = git(repo.repo, "rev-parse", "base");

  const run = runScript(repo, ["--base", "base", "--no-fetch"]);

  assert.equal(run.status, 2);
  assert.match(run.stderr, /the review target moved while codex read it/);
  const report = fs.readFileSync(run.reportPath, "utf8");
  assert.match(report, new RegExp(`^base_sha: ${baseShaBefore}$`, "m"));
  assert.equal(
    report.match(/^base_sha_at_finish: ([0-9a-f]{40})$/m)[1],
    git(repo.repo, "rev-parse", "HEAD"),
  );
  assert.match(report, /^target_moved: yes$/m);
});

test("the report and its transcript are readable only by their owner", (t) => {
  const repo = makeRepo(t);
  fakeCodex(repo.bin, 'echo "clean"');

  const run = runScript(repo, ["--base", "base", "--no-fetch"]);

  for (const file of [run.reportPath, `${run.reportPath}.stderr.log`]) {
    assert.equal(
      fs.statSync(file).mode & 0o777,
      0o600,
      `${file} is not owner-only`,
    );
  }
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
  // Absent, not empty: an empty value is a command name Git tries to run.
  assert.equal(env.has("GIT_EXTERNAL_DIFF"), false);
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

test("the printed diff size ignores commits only the base carries", (t) => {
  const repo = makeRepo(t);
  fakeCodex(repo.bin, 'echo "clean"');
  // Advance `base` past the merge base with a file HEAD never saw. The two-dot
  // form against the branch tip would count that file as a reversed deletion.
  const headSha = git(repo.repo, "rev-parse", "HEAD");
  git(repo.repo, "checkout", "--quiet", "base");
  fs.writeFileSync(
    path.join(repo.repo, "base-only.js"),
    "export const x = 1;\n",
  );
  git(repo.repo, "add", "-A");
  git(repo.repo, "commit", "--quiet", "-m", "base moves on");
  git(repo.repo, "checkout", "--quiet", headSha);
  git(repo.repo, "checkout", "--quiet", "-B", "work", headSha);

  const run = runScript(repo, ["--base", "base", "--no-fetch"]);

  assert.match(run.stdout, /^diff: 1 file changed/m);
  assert.match(run.stdout, /against base \(merge base [0-9a-f]{7}\)/);
  const report = fs.readFileSync(run.reportPath, "utf8");
  assert.equal(
    report.match(/^merge_base_sha: ([0-9a-f]{40})$/m)[1],
    git(repo.repo, "merge-base", "HEAD", "base"),
  );
  assert.notEqual(
    report.match(/^base_sha: ([0-9a-f]{40})$/m)[1],
    report.match(/^merge_base_sha: ([0-9a-f]{40})$/m)[1],
  );
});

test("the header carries a fingerprint of the reviewed tree", (t) => {
  const repo = makeRepo(t);
  fakeCodex(repo.bin, 'echo "clean"');
  fs.writeFileSync(path.join(repo.repo, "math.js"), "export const sum = 9;\n");

  const run = runScript(repo, ["--base", "base", "--no-fetch"]);

  assert.match(
    fs.readFileSync(run.reportPath, "utf8"),
    /^target_fingerprint: [0-9a-f]{64}$/m,
  );
});

test("an unwritable report path is a tool failure, not a finding", (t) => {
  const repo = makeRepo(t);
  fakeCodex(repo.bin, 'echo "clean"');
  // A directory where the report file belongs: the open throws. Exit 1 is
  // reserved for a review that ran and found things.
  const out = path.join(repo.repo, ".reviews", "taken.md");
  fs.mkdirSync(out, { recursive: true });

  const run = runScript(repo, ["--base", "base", "--no-fetch", "--out", out]);

  assert.equal(run.status, 2);
  assert.match(run.stderr, /closeout-review: unexpected failure/);
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
  // The transcript is named, not quoted: its content is unscanned model output
  // and quoted diff text, and this stderr reaches terminals and CI logs.
  assert.match(run.stderr, new RegExp(`${run.reportPath}\\.stderr\\.log`));
  assert.doesNotMatch(run.stderr, /boom/);
  assert.match(
    fs.readFileSync(`${run.reportPath}.stderr.log`, "utf8"),
    /boom/,
    "the transcript still holds what codex printed",
  );
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

test("a codex inside the tree under review is refused", (t) => {
  const repo = makeRepo(t);
  // Where `pnpm run` puts the repository's own bin directory: first on PATH.
  const shimDir = path.join(repo.repo, "node_modules", ".bin");
  fs.mkdirSync(shimDir, { recursive: true });
  fakeCodex(shimDir, 'echo "clean"');

  const run = runScript(
    repo,
    ["--base", "base", "--no-fetch"],
    {},
    `${shimDir}:${gitOnlyDir(repo.root)}`,
  );

  assert.equal(run.status, 2);
  assert.match(run.stderr, /refusing the repository-controlled codex/);
  assert.equal(run.reportPath, null);
});

test("the version probe runs under the same environment allowlist", (t) => {
  const repo = makeRepo(t);
  const envDump = path.join(repo.root, "version-env.txt");
  // A fake that dumps its environment from the `--version` branch, which the
  // shared helper answers before it can be observed.
  const file = path.join(repo.bin, "codex");
  fs.writeFileSync(
    file,
    [
      "#!/bin/sh",
      'if [ "$1" = "--version" ]; then',
      `  env > ${JSON.stringify(envDump)}`,
      '  echo "codex-cli 9.9.9-fake"',
      "  exit 0",
      "fi",
      'echo "clean"',
    ].join("\n") + "\n",
  );
  fs.chmodSync(file, 0o755);

  const run = runScript(repo, ["--base", "base", "--no-fetch"]);

  assert.equal(run.status, 0);
  const dumped = fs.readFileSync(envDump, "utf8");
  assert.doesNotMatch(dumped, /^GH_TOKEN=/m, "GH_TOKEN reached the probe");
  assert.match(dumped, /^OPENAI_API_KEY=secret-openai-key$/m);
  assert.match(dumped, /^GIT_CONFIG_GLOBAL=\/dev\/null$/m);
});

test("an unknown argument is refused with the usage line", (t) => {
  const repo = makeRepo(t);
  fakeCodex(repo.bin, 'echo "clean"');

  const run = runScript(repo, ["--engine", "claude"]);

  assert.equal(run.status, 2);
  assert.match(run.stderr, /unknown argument --engine/);
  assert.match(run.stderr, /usage: closeout-review/);
});

test("a duplicate --base is refused before it can replace the bound base", (t) => {
  const repo = makeRepo(t);
  fakeCodex(repo.bin, 'echo "clean"');

  const run = runScript(repo, [
    "--base",
    "base",
    "--base",
    "HEAD",
    "--no-fetch",
  ]);

  assert.equal(run.status, 2);
  assert.match(run.stderr, /--base can be provided only once/);
  assert.equal(run.reportPath, null);
});

/**
 * A fake `gh` answering the two queries `resolveBase` makes: `repo view` and
 * `pr list`. `defaultBranch` is what `repo view` reports; `pulls` is the JSON
 * array `pr list` returns.
 */
function fakeGh(bin, { defaultBranch, pulls }) {
  const view = JSON.stringify({
    nameWithOwner: "acme/widgets",
    parent: null,
    defaultBranchRef: defaultBranch ? { name: defaultBranch } : null,
  });
  const file = path.join(bin, "gh");
  fs.writeFileSync(
    file,
    [
      "#!/bin/sh",
      'if [ "$1" = "repo" ]; then',
      `  echo ${JSON.stringify(view)}`,
      "  exit 0",
      "fi",
      'if [ "$1" = "pr" ]; then',
      `  echo ${JSON.stringify(JSON.stringify(pulls))}`,
      "  exit 0",
      "fi",
      "exit 1",
    ].join("\n") + "\n",
  );
  fs.chmodSync(file, 0o755);
}

/** Point `origin` at a GitHub URL and give it a tracking ref for `branch`. */
function addOrigin(repo, branch) {
  git(repo, "remote", "add", "origin", "https://github.com/acme/widgets.git");
  git(repo, "update-ref", `refs/remotes/origin/${branch}`, "base");
}

test("with no open PR the base falls back to the repository default branch", (t) => {
  const repo = makeRepo(t);
  fakeCodex(repo.bin, 'echo "clean"');
  // A default branch that is deliberately not `main`: a hardcoded fallback
  // would review against the wrong ref here and say nothing.
  fakeGh(repo.bin, { defaultBranch: "trunk", pulls: [] });
  addOrigin(repo.repo, "trunk");

  const run = runScript(repo, ["--no-fetch"]);

  assert.equal(run.status, 0);
  assert.match(run.stdout, /against origin\/trunk /);
  assert.match(
    fs.readFileSync(run.reportPath, "utf8"),
    /^base_ref: origin\/trunk$/m,
  );
});

test("with one open PR the base is that PR own base branch", (t) => {
  const repo = makeRepo(t);
  fakeCodex(repo.bin, 'echo "clean"');
  fakeGh(repo.bin, {
    defaultBranch: "trunk",
    pulls: [
      {
        baseRefName: "release",
        headRepositoryOwner: { login: "acme" },
      },
    ],
  });
  addOrigin(repo.repo, "release");

  const run = runScript(repo, ["--no-fetch"]);

  assert.equal(run.status, 0);
  assert.match(
    fs.readFileSync(run.reportPath, "utf8"),
    /^base_ref: origin\/release$/m,
  );
});

test("a repository naming no default branch refuses instead of guessing", (t) => {
  const repo = makeRepo(t);
  fakeCodex(repo.bin, 'echo "clean"');
  fakeGh(repo.bin, { defaultBranch: null, pulls: [] });
  addOrigin(repo.repo, "trunk");

  const run = runScript(repo, ["--no-fetch"]);

  assert.equal(run.status, 2);
  assert.match(run.stderr, /names no default branch; pass --base/);
});

test("a repository-controlled git shim never runs at all", (t) => {
  const repo = makeRepo(t);
  fakeCodex(repo.bin, 'echo "clean"');
  // What `pnpm run` puts first on PATH. The shim records every call it gets,
  // so the marker proves whether it was consulted — including on the first
  // call, before the script knows where the repository root is.
  const shimDir = path.join(repo.repo, "node_modules", ".bin");
  fs.mkdirSync(shimDir, { recursive: true });
  const marker = path.join(repo.root, "shim-ran.txt");
  fs.writeFileSync(
    path.join(shimDir, "git"),
    [
      "#!/bin/sh",
      `echo "$@" >> ${JSON.stringify(marker)}`,
      `exec ${JSON.stringify(GIT_BIN)} "$@"`,
    ].join("\n") + "\n",
  );
  fs.chmodSync(path.join(shimDir, "git"), 0o755);

  const run = runScript(
    repo,
    ["--base", "base", "--no-fetch"],
    {},
    `${shimDir}:${repo.bin}:${process.env.PATH}`,
  );

  assert.equal(run.status, 0);
  assert.equal(fs.existsSync(marker), false, "the shim was executed");
});

test("a default report path is unique per process", (t) => {
  const repo = makeRepo(t);
  fakeCodex(repo.bin, 'echo "clean"');

  const run = runScript(repo, ["--base", "base", "--no-fetch"]);

  assert.equal(run.status, 0);
  assert.match(path.basename(run.reportPath), /-[0-9a-f]{7}-\d+\.md$/);
});

test("ambient Git redirection does not reach the fingerprint", (t) => {
  const repo = makeRepo(t);
  fakeCodex(repo.bin, 'echo "clean"');
  // An alternate index the reviewer would never see. Left in place, Git would
  // read and write it here, and the header would describe a tree codex did
  // not read.
  const index = path.join(repo.root, "alternate-index");

  const run = runScript(repo, ["--base", "base", "--no-fetch"], {
    GIT_INDEX_FILE: index,
  });

  assert.equal(run.status, 0);
  assert.equal(fs.existsSync(index), false, "Git used the alternate index");
});

test("a mirror remote is not read as the GitHub base repository", (t) => {
  const repo = makeRepo(t);
  fakeCodex(repo.bin, 'echo "clean"');
  fakeGh(repo.bin, { defaultBranch: "trunk", pulls: [] });
  // Same owner and name, different host: accepting it would let a mirror
  // supply the base the review diffs against.
  git(
    repo.repo,
    "remote",
    "add",
    "mirror",
    "https://mirror.example/acme/widgets.git",
  );

  const run = runScript(repo, ["--no-fetch"]);

  assert.equal(run.status, 2);
  assert.match(run.stderr, /0 remotes serve acme\/widgets/);
});

test("no merge base is a stop rather than a base-ref merge base", (t) => {
  const repo = makeRepo(t);
  fakeCodex(repo.bin, 'echo "clean"');
  // An orphan branch shares no history with HEAD, so `git merge-base` fails
  // exactly as it does in a shallow checkout.
  git(repo.repo, "checkout", "--quiet", "--orphan", "unrelated");
  git(repo.repo, "commit", "--quiet", "--allow-empty", "-m", "unrelated");
  git(repo.repo, "checkout", "--quiet", "main");

  const run = runScript(repo, ["--base", "unrelated", "--no-fetch"]);

  assert.equal(run.status, 2);
  assert.match(run.stderr, /no merge base between HEAD and unrelated/);
});

test("an --out symlink is refused before anything is written", (t) => {
  const repo = makeRepo(t);
  fakeCodex(repo.bin, 'echo "clean"');
  // Ignored by Git, so the lexical check passes; the link lands in a tracked
  // directory, which is where the report would actually be written.
  const reviews = path.join(repo.repo, ".reviews");
  fs.mkdirSync(reviews, { recursive: true });
  const target = path.join(repo.repo, "leaked.md");
  const link = path.join(reviews, "link.md");
  fs.symlinkSync(target, link);

  const run = runScript(repo, ["--base", "base", "--no-fetch", "--out", link]);

  assert.equal(run.status, 2);
  assert.match(run.stderr, /symbolic link|not ignored by Git/);
  assert.equal(fs.existsSync(target), false);
});

test("a codex symlinked into the tree under review is refused", (t) => {
  const repo = makeRepo(t);
  // The link sits outside the repository and points back into it, so only the
  // resolved target says the branch supplies its own reviewer.
  const inTree = path.join(repo.repo, "tools");
  fs.mkdirSync(inTree, { recursive: true });
  fakeCodex(inTree, 'echo "clean"');
  const linkDir = path.join(repo.root, "link-bin");
  fs.mkdirSync(linkDir, { recursive: true });
  fs.symlinkSync(path.join(inTree, "codex"), path.join(linkDir, "codex"));

  const run = runScript(
    repo,
    ["--base", "base", "--no-fetch"],
    {},
    `${linkDir}:${gitOnlyDir(repo.root)}`,
  );

  assert.equal(run.status, 2);
  assert.match(run.stderr, /refusing the repository-controlled codex/);
  assert.equal(run.reportPath, null);
});

test("environment-injected Git configuration does not reach the fingerprint", (t) => {
  const repo = makeRepo(t);
  fakeCodex(repo.bin, 'echo "clean"');
  // A dirty tracked file, so the diff behind the fingerprint has output the
  // injected `diff.noprefix` would reshape.
  fs.writeFileSync(
    path.join(repo.repo, "math.js"),
    "export const sum = () => 2;\n",
  );

  const plain = runScript(repo, ["--base", "base", "--no-fetch"]);
  const injected = runScript(repo, ["--base", "base", "--no-fetch"], {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "diff.noprefix",
    GIT_CONFIG_VALUE_0: "true",
  });

  assert.equal(plain.status, 0);
  assert.equal(injected.status, 0);
  const fingerprint = (run) =>
    fs
      .readFileSync(run.reportPath, "utf8")
      .match(/^target_fingerprint: (\S+)$/m)[1];
  assert.equal(
    fingerprint(injected),
    fingerprint(plain),
    "injected Git configuration reshaped the fingerprint",
  );
});

test("a HEAD that moves during base resolution is a stop", (t) => {
  const repo = makeRepo(t);
  fakeCodex(repo.bin, 'echo "clean"');
  fakeGh(repo.bin, { defaultBranch: "trunk", pulls: [] });
  addOrigin(repo.repo, "trunk");
  // `gh` runs after HEAD is read and before the fingerprint is taken, so a
  // commit landing here sits inside both fingerprints while `head_sha` still
  // names the commit codex never saw. The fingerprints agree and only the
  // saved HEAD differs, which is the case the fingerprint pair cannot see.
  const ghPath = path.join(repo.bin, "gh");
  const marker = path.join(repo.root, "committed");
  const ghScript = fs.readFileSync(ghPath, "utf8").split("\n");
  // Ahead of the query answers, because each branch exits before the end of
  // the file. The marker keeps the second `gh` call from re-running the block:
  // a second `git commit` with nothing staged writes to the stdout the script
  // under test parses as JSON.
  ghScript.splice(
    1,
    0,
    [
      `if [ ! -e ${JSON.stringify(marker)} ]; then`,
      `  : > ${JSON.stringify(marker)}`,
      `  ( cd ${JSON.stringify(repo.repo)} &&`,
      "    echo 'export const product = () => 6;' > product.js &&",
      "    git add -A && git commit --quiet -m mid-run ) >/dev/null 2>&1",
      "fi",
    ].join("\n"),
  );
  fs.writeFileSync(ghPath, ghScript.join("\n"));

  const run = runScript(repo, ["--no-fetch"]);

  assert.equal(run.status, 2);
  assert.match(run.stderr, /the review target moved while codex read it/);
  const report = fs.readFileSync(run.reportPath, "utf8");
  assert.match(report, /^target_moved: yes$/m);
  // The header names the commit the run started on and the report names the
  // one it ended on. Without the saved-HEAD check this run reads as clean.
  const headSha = report.match(/^head_sha: ([0-9a-f]{40})$/m)[1];
  const atFinish = report.match(/^head_sha_at_finish: ([0-9a-f]{40})$/m)[1];
  assert.notEqual(headSha, atFinish);
  assert.equal(atFinish, git(repo.repo, "rev-parse", "HEAD"));
});

test("a synchronous command that hangs fails on a bounded deadline", () => {
  const started = Date.now();
  const stalled = run(
    "sh",
    ["-c", "sleep 30"],
    process.cwd(),
    process.env,
    200,
  );

  assert.equal(stalled.ok, false, "a hung command reported success");
  assert.ok(Date.now() - started < 10_000, "the deadline never fired");
  assert.ok(Number.isFinite(RUN_TIMEOUT_MS) && RUN_TIMEOUT_MS > 0);
  // The default must still let an ordinary command through untouched.
  const quick = run("sh", ["-c", "echo hi"], process.cwd(), process.env);
  assert.equal(quick.ok, true);
  assert.equal(quick.stdout, "hi");
});

test("the sanitized PATH hands children absolute directories only", (t) => {
  const repo = makeRepo(t);
  const envDump = path.join(repo.root, "path-env.txt");
  fs.mkdirSync(path.join(repo.root, "outside-bin"), { recursive: true });
  const file = path.join(repo.bin, "codex");
  fs.writeFileSync(
    file,
    [
      "#!/bin/sh",
      'if [ "$1" = "--version" ]; then',
      `  env > ${JSON.stringify(envDump)}`,
      '  echo "codex-cli 9.9.9-fake"',
      "  exit 0",
      "fi",
      'echo "clean"',
    ].join("\n") + "\n",
  );
  fs.chmodSync(file, 0o755);

  // A relative entry that resolves outside the repository, so the filter keeps
  // it. Whoever searches PATH resolves it: this process from its own working
  // directory, children from the repository root `run` gives them.
  const run_ = runScript(
    repo,
    ["--base", "base", "--no-fetch"],
    {},
    `../outside-bin:${repo.bin}:${process.env.PATH}`,
  );

  assert.equal(run_.status, 0);
  const entries = fs
    .readFileSync(envDump, "utf8")
    .match(/^PATH=(.*)$/m)[1]
    .split(path.delimiter);
  assert.equal(
    entries.includes("../outside-bin"),
    false,
    "the relative entry reached the child unresolved",
  );
  assert.ok(
    entries.some(
      (entry) =>
        path.isAbsolute(entry) && entry.endsWith(`${path.sep}outside-bin`),
    ),
    `the vetted directory is missing from ${entries.join(path.delimiter)}`,
  );
});

test("a codex hard-linked to a file inside the tree under review is refused", (t) => {
  const repo = makeRepo(t);
  // A hard link is a second name for one inode, and realpath reports the name
  // it was reached by. Only the link count says the branch under review can
  // rewrite the reviewer's own bytes.
  const inTree = path.join(repo.repo, "tools");
  fs.mkdirSync(inTree, { recursive: true });
  fakeCodex(inTree, 'echo "clean"');
  const linkDir = path.join(repo.root, "hardlink-bin");
  fs.mkdirSync(linkDir, { recursive: true });
  fs.linkSync(path.join(inTree, "codex"), path.join(linkDir, "codex"));

  const run_ = runScript(
    repo,
    ["--base", "base", "--no-fetch"],
    {},
    `${linkDir}:${gitOnlyDir(repo.root)}`,
  );

  assert.equal(run_.status, 2);
  assert.match(run_.stderr, /refusing the multiply-linked codex/);
  assert.equal(run_.reportPath, null);
});

test("a codex replaced after it was resolved never runs", (t) => {
  const repo = makeRepo(t);
  // The `--version` probe renames another file over the approved pathname,
  // which makes the window between resolution and execution observable.
  const file = path.join(repo.bin, "codex");
  const replacement = path.join(repo.root, "replacement");
  fs.writeFileSync(replacement, '#!/bin/sh\necho "clean"\n');
  fs.chmodSync(replacement, 0o755);
  fs.writeFileSync(
    file,
    [
      "#!/bin/sh",
      'if [ "$1" = "--version" ]; then',
      `  mv ${JSON.stringify(replacement)} ${JSON.stringify(file)}`,
      '  echo "codex-cli 9.9.9-fake"',
      "  exit 0",
      "fi",
      'echo "clean"',
    ].join("\n") + "\n",
  );
  fs.chmodSync(file, 0o755);

  const run_ = runScript(repo, ["--base", "base", "--no-fetch"]);

  assert.equal(run_.status, 2);
  assert.match(run_.stderr, /changed identity after it was resolved/);
});

test("a descendant outliving codex cannot rewrite the accepted report", (t) => {
  const repo = makeRepo(t);
  // The background subshell inherits both the report descriptor and the
  // process group. codex exits 0 at once; without a sweep on every outcome the
  // descendant writes into the report after the verdict was taken from it.
  fakeCodex(
    repo.bin,
    [
      "( sleep 1; echo 'INJECTED AFTER EXIT' ) &",
      "echo 'No issues found in this patch.'",
    ].join("\n"),
  );

  const run_ = runScript(repo, ["--base", "base", "--no-fetch"]);

  assert.equal(run_.status, 0);
  // Past the descendant's own sleep, so a surviving one has had its chance.
  spawnSync("sh", ["-c", "sleep 2"]);
  const report = fs.readFileSync(run_.reportPath, "utf8");
  assert.doesNotMatch(report, /INJECTED AFTER EXIT/);
  assert.match(report, /^verdict: clean$/m);
});

test("an edit inside an already-dirty submodule voids the report", (t) => {
  const repo = makeRepo(t);
  // To the parent repository every edit under a checked-out submodule is the
  // same ` M <path>` status line and the same `-dirty` subproject marker, so
  // without the nested diff both fingerprints match and this run reads clean.
  const upstream = path.join(repo.root, "upstream");
  fs.mkdirSync(upstream);
  git(upstream, "init", "--quiet", "--initial-branch=main");
  git(upstream, "config", "user.email", "test@example.invalid");
  git(upstream, "config", "user.name", "Closeout Review Test");
  fs.writeFileSync(path.join(upstream, "a.txt"), "one\n");
  git(upstream, "add", "-A");
  git(upstream, "commit", "--quiet", "-m", "upstream");
  git(
    repo.repo,
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    "--quiet",
    upstream,
    "lib",
  );
  git(repo.repo, "add", "-A");
  git(repo.repo, "commit", "--quiet", "-m", "add submodule");
  const nested = path.join(repo.repo, "lib", "a.txt");
  fs.writeFileSync(nested, "two\n");
  fakeCodex(
    repo.bin,
    [`echo 'three' > ${JSON.stringify(nested)}`, "echo 'clean'"].join("\n"),
  );

  const run_ = runScript(repo, ["--base", "base", "--no-fetch"]);

  assert.equal(run_.status, 2);
  assert.match(run_.stderr, /the review target moved while codex read it/);
  assert.match(
    fs.readFileSync(run_.reportPath, "utf8"),
    /^target_moved: yes$/m,
  );
});
