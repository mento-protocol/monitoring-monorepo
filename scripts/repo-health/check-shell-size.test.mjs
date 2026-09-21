// Smoke test for the shell size gate. The checker itself is a byte-identical
// copy of scripts/check-shell-size.mjs in github.com/mento-protocol/agents,
// where its full suite lives. This file proves the copy works here: that it
// runs, reads its baseline, ratchets against a base ref, and reports the
// repository's own tracked shell files.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CHECKER_RELATIVE = "scripts/repo-health/check-shell-size.mjs";
const BASELINE_RELATIVE = "scripts/repo-health/shell-size-baseline.txt";
const BASELINE_HEADER = "# fixture baseline\n";

// Git inherits GIT_DIR and friends from the parent process, which would point
// every fixture command back at this checkout.
function fixtureEnvironment(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"])
    delete env[name];
  return env;
}

function runGit(root, args) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: fixtureEnvironment(),
  });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

// A shell function declaration of exactly `lines` physical lines.
function shellFunction(name, lines) {
  const body = Array.from({ length: lines - 2 }, (_, index) => `  : ${index}`);
  return [`${name}() {`, ...body, "}"].join("\n");
}

// A throwaway repository holding the checker at its real relative path, this
// checkout's node_modules, and the given files. Everything is committed, so
// `git ls-files` sees the shell files the checker measures.
function makeFixture(files) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "check-shell-size-")));
  runGit(root, ["init", "-q", "-b", "main"]);
  mkdirSync(join(root, dirname(CHECKER_RELATIVE)), { recursive: true });
  copyFileSync(
    join(HERE, "check-shell-size.mjs"),
    join(root, CHECKER_RELATIVE),
  );
  symlinkSync(
    join(REPOSITORY_ROOT, "node_modules"),
    join(root, "node_modules"),
  );
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(join(root, dirname(path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  }
  runGit(root, ["add", "-A"]);
  runGit(root, [
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "fixture",
  ]);
  assert.equal(runGit(root, ["rev-parse", "--show-toplevel"]), root);
  return root;
}

function runChecker(root, extraEnvironment = {}) {
  const result = spawnSync(process.execPath, [join(root, CHECKER_RELATIVE)], {
    cwd: root,
    encoding: "utf8",
    env: fixtureEnvironment(extraEnvironment),
  });
  return { status: result.status, out: result.stdout, error: result.stderr };
}

test("a tree inside both limits passes", () => {
  const root = makeFixture({
    "tools/small.sh": `${shellFunction("small_one", 20)}\n`,
  });
  const run = runChecker(root);
  assert.equal(run.status, 0, run.error);
  assert.match(run.out, /check-shell-size: ok/u);
});

test("a function over the limit fails and names the function", () => {
  const root = makeFixture({
    "tools/big.sh": `${shellFunction("big_one", 60)}\n`,
  });
  const run = runChecker(root);
  assert.equal(run.status, 1);
  assert.match(run.error, /tools\/big\.sh:1: function big_one is 60 lines/u);
});

test("a function row exempts that function", () => {
  const root = makeFixture({
    "tools/big.sh": `${shellFunction("big_one", 60)}\n`,
    [BASELINE_RELATIVE]: `${BASELINE_HEADER}tools/big.sh big_one 60\n`,
  });
  const run = runChecker(root);
  assert.equal(run.status, 0, run.error);
  assert.match(run.out, /check-shell-size: ok/u);
});

test("a row the base ref lacks is refused", () => {
  const root = makeFixture({
    "tools/big.sh": `${shellFunction("big_one", 60)}\n`,
    [BASELINE_RELATIVE]: BASELINE_HEADER,
  });
  writeFileSync(
    join(root, BASELINE_RELATIVE),
    `${BASELINE_HEADER}tools/big.sh big_one 60\n`,
  );
  const run = runChecker(root, { SHELL_SIZE_BASE: "HEAD" });
  assert.equal(run.status, 1);
  assert.match(run.error, /big_one is not listed in HEAD/u);
});

test("a function below its row passes with an advisory line", () => {
  const root = makeFixture({
    "tools/big.sh": `${shellFunction("big_one", 55)}\n`,
    [BASELINE_RELATIVE]: `${BASELINE_HEADER}tools/big.sh big_one 60\n`,
  });
  const run = runChecker(root);
  assert.equal(run.status, 0, run.error);
  assert.match(run.out, /function big_one is 55 lines.*lower the entry to 55/u);
  assert.match(run.out, /check-shell-size: ok/u);
});

test("this repository's own tracked shell files pass the gate", () => {
  const result = spawnSync(
    process.execPath,
    [join(HERE, "check-shell-size.mjs")],
    {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
      env: fixtureEnvironment(),
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /check-shell-size: ok/u);
});
