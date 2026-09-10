import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
  symlinkSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareRecovery, parseRecoveryArgs } from "./pr-stack-recover.mjs";

function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), "stack-recovery-test-"));
  const repo = join(root, "source");
  mkdirSync(repo);
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const commit = (file, text, message = file) => {
    writeFileSync(join(repo, file), text);
    git("add", file);
    git("commit", "-m", message);
    return git("rev-parse", "HEAD");
  };
  try {
    git("init", "-b", "main");
    git("config", "user.email", "fixture@example.invalid");
    git("config", "user.name", "Recovery fixture");
    git("config", "commit.gpgsign", "false");
    const base = commit("base.txt", "base\n");
    git("switch", "-c", "parent");
    const oldParent = commit("parent.txt", "producer\n");
    git("switch", "-c", "child");
    const oldHead = commit("child.txt", "consumer\n");
    const options = {
      repo,
      oldParent,
      oldHead,
      newBase: base,
      branch: "candidate",
      worktree: join(root, "candidate"),
    };
    run({ root, repo, git, commit, base, oldParent, oldHead, options });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

fixture(({ repo, git, base, options }) => {
  git("switch", "main");
  git("merge", "--squash", "parent");
  git("commit", "-m", "squashed producer");
  options.newBase = git("rev-parse", "HEAD");
  git("switch", "child");
  writeFileSync(join(repo, "untracked.txt"), "keep me\n");
  writeFileSync(join(repo, "base.txt"), "dirty source\n");
  const before = git("show-ref");
  const receipt = prepareRecovery(options);
  assert.equal(receipt.status, "prepared");
  assert.equal(receipt.replayed.length, 1);
  assert.deepEqual(receipt.remaining, []);
  assert.equal(git("rev-parse", "HEAD"), options.oldHead);
  assert.equal(readFileSync(join(repo, "base.txt"), "utf8"), "dirty source\n");
  assert.equal(readFileSync(join(repo, "untracked.txt"), "utf8"), "keep me\n");
  assert.equal(
    readFileSync(join(options.worktree, "parent.txt"), "utf8"),
    "producer\n",
  );
  assert.equal(
    readFileSync(join(options.worktree, "child.txt"), "utf8"),
    "consumer\n",
  );
  for (const line of before.split("\n"))
    assert.ok(git("show-ref").includes(line));
  for (const [key, ref] of Object.entries(receipt.backupRefs))
    assert.equal(git("rev-parse", ref), options[key]);
  assert.match(
    readFileSync(`${options.worktree}.receipt/range-diff.txt`, "utf8"),
    / = /,
  );
  assert.deepEqual(receipt.artifactErrors, []);
  assert.equal(git("rev-parse", "main"), options.newBase);
  assert.notEqual(base, options.newBase);
});

fixture(({ git, commit, options, oldParent }) => {
  const first = options.oldHead;
  const second = commit("second.txt", "second\n");
  options.oldHead = second;
  git("switch", "-c", "fixed-parent", oldParent);
  commit("parent-fix.txt", "fix\n");
  git("cherry-pick", first);
  options.newBase = git("rev-parse", "HEAD");
  const receipt = prepareRecovery(options);
  assert.equal(receipt.status, "prepared");
  assert.equal(receipt.skipped[0].commit, first);
  assert.equal(receipt.skipped[0].proof, "git-cherry-equivalent");
  assert.match(receipt.cherryProof, new RegExp(`- ${first}`));
  assert.equal(receipt.replayed.length, 1);
  assert.equal(
    readFileSync(join(options.worktree, "second.txt"), "utf8"),
    "second\n",
  );
  assert.equal(
    readFileSync(join(options.worktree, "parent-fix.txt"), "utf8"),
    "fix\n",
  );
});

fixture(({ git, commit, options, oldParent }) => {
  options.oldHead = commit("parent.txt", "child changes parent\n");
  git("switch", "-c", "conflicting-parent", oldParent);
  options.newBase = commit("parent.txt", "parent fix\n");
  const receipt = prepareRecovery(options);
  assert.equal(receipt.status, "blocked");
  assert.deepEqual(receipt.conflicts, ["parent.txt"]);
  assert.equal(receipt.failure.kind, "conflict");
  assert.match(receipt.artifactScope, /committed-prefix-only/);
  assert.match(receipt.candidateStatus, /UU parent.txt/);
  assert.match(
    readFileSync(`${options.worktree}.receipt/working-tree.patch`, "utf8"),
    /parent.txt/,
  );
  assert.match(
    readFileSync(`${options.worktree}.receipt/index.patch`, "utf8"),
    /parent.txt/,
  );
  assert.deepEqual(receipt.remaining, [options.oldHead]);
  assert.equal(receipt.replayed.length, 1);
  assert.equal(git("rev-parse", "child"), options.oldHead);
  assert.equal(
    spawnSync("git", ["rev-parse", "CHERRY_PICK_HEAD"], {
      cwd: options.worktree,
    }).status,
    0,
  );
  assert.equal(
    JSON.parse(readFileSync(`${options.worktree}.receipt/receipt.json`, "utf8"))
      .status,
    "blocked",
  );
});

fixture(({ git, commit, options, base, oldParent }) => {
  const assertRefused = (changes, pattern) => {
    const refs = git("show-ref");
    assert.throws(() => prepareRecovery({ ...options, ...changes }), pattern);
    assert.equal(git("show-ref"), refs);
    assert.equal(existsSync(options.worktree), false);
    assert.equal(existsSync(`${options.worktree}.receipt`), false);
  };
  assertRefused({ oldParent: "main" }, /full commit SHA/);
  assertRefused({ oldParent: options.oldHead, oldHead: oldParent }, /ancestor/);
  assertRefused({ oldHead: oldParent }, /nonempty linear/);
  assertRefused({ newBase: options.oldHead }, /already contains/);
  assertRefused({ branch: "child" }, /already exists/);
  assertRefused({ branch: "--bad" }, /valid new branch/);
  assertRefused({ worktree: join(options.repo, "nested") }, /outside/);
  options.oldHead = commit("second.txt", "second\n");
  assertRefused(
    { newBase: git("rev-parse", "HEAD^") },
    /inside the child range/,
  );
  git("switch", "-c", "side", base);
  commit("side.txt", "side\n");
  git("switch", "child");
  git("merge", "--no-ff", "side", "-m", "merge side");
  assertRefused({ oldHead: git("rev-parse", "HEAD") }, /linear/);
});

fixture(({ options, git }) => {
  mkdirSync(`${options.worktree}.receipt`);
  writeFileSync(`${options.worktree}.receipt/keep.txt`, "preserve");
  const before = git("show-ref");
  assert.throws(() => prepareRecovery(options), /already exists/);
  assert.equal(git("show-ref"), before);
  assert.equal(
    readFileSync(`${options.worktree}.receipt/keep.txt`, "utf8"),
    "preserve",
  );
});

fixture(({ git, commit, options, oldParent }) => {
  git("switch", "-c", "equivalent-base", oldParent);
  commit("other.txt", "base change\n");
  git("cherry-pick", options.oldHead);
  options.newBase = git("rev-parse", "HEAD");
  assert.throws(() => prepareRecovery(options), /already represented/);
  assert.equal(existsSync(options.worktree), false);
});

fixture(({ root, git, options }) => {
  const other = join(root, "other-worktree");
  git("worktree", "add", "--detach", other, options.oldParent);
  assert.throws(
    () => prepareRecovery({ ...options, worktree: join(other, "nested") }),
    /outside/,
  );
  symlinkSync(join(root, "missing"), options.worktree);
  assert.throws(() => prepareRecovery(options), /already exists/);
});

fixture(({ root, repo, git, options }) => {
  const prior = process.env.GIT_INDEX_FILE;
  const poisoned = join(root, "foreign-index");
  process.env.GIT_INDEX_FILE = poisoned;
  try {
    const receipt = prepareRecovery(options);
    assert.equal(receipt.status, "prepared");
    assert.equal(existsSync(poisoned), false);
  } finally {
    if (prior === undefined) delete process.env.GIT_INDEX_FILE;
    else process.env.GIT_INDEX_FILE = prior;
  }
  assert.equal(git("rev-parse", "HEAD"), options.oldHead);
  assert.equal(readFileSync(join(repo, "child.txt"), "utf8"), "consumer\n");
});

fixture(({ root, git, options }) => {
  const marker = join(root, "external-executed");
  const command = join(root, "external-diff");
  writeFileSync(
    command,
    `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv));\nprocess.stdout.write("NOT A PATCH");\n`,
  );
  chmodSync(command, 0o755);
  git("config", "diff.external", command);
  git("config", "diff.trap.textconv", command);
  writeFileSync(
    join(options.repo, ".git", "info", "attributes"),
    "*.txt diff=trap\n",
  );
  const injected = {
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "diff.external",
    GIT_CONFIG_VALUE_0: command,
    GIT_CONFIG_KEY_1: "diff.trap.textconv",
    GIT_CONFIG_VALUE_1: command,
  };
  const previous = Object.fromEntries(
    Object.keys(injected).map((key) => [key, process.env[key]]),
  );
  let receipt;
  try {
    Object.assign(process.env, injected);
    receipt = prepareRecovery(options);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  assert.equal(receipt.status, "prepared");
  assert.equal(
    existsSync(marker),
    false,
    existsSync(marker) ? readFileSync(marker, "utf8") : "",
  );
  assert.match(
    readFileSync(`${options.worktree}.receipt/new-base.patch`, "utf8"),
    /^diff --git /,
  );
  assert.match(
    readFileSync(`${options.worktree}.receipt/range-diff.txt`, "utf8"),
    / = /,
  );
  assert.deepEqual(receipt.artifactErrors, []);
  assert.match(receipt.candidateTree, /^[0-9a-f]{40}$/);
  assert.equal(receipt.candidateStatus, "");
});

fixture(({ root, git, options }) => {
  const hooks = join(root, "hooks");
  mkdirSync(hooks);
  const hook = join(hooks, "post-checkout");
  writeFileSync(hook, '#!/bin/sh\nprintf "hook output" > hook-output.txt\n');
  chmodSync(hook, 0o755);
  git("config", "core.hooksPath", hooks);
  const receipt = prepareRecovery(options);
  assert.equal(receipt.status, "blocked");
  assert.match(receipt.error, /uncommitted changes/);
  assert.match(receipt.candidateStatus, /\?\? hook-output.txt/);
  assert.equal(
    readFileSync(join(options.worktree, "hook-output.txt"), "utf8"),
    "hook output",
  );
});

fixture(({ git, commit, options }) => {
  options.oldParent = options.oldHead;
  const failed = commit("parent.txt", "child conflict\n");
  options.oldHead = commit("suffix.txt", "unattempted\n");
  git("switch", "-c", "new-parent", options.oldParent);
  options.newBase = commit("parent.txt", "parent correction\n");
  const receipt = prepareRecovery(options);
  assert.equal(receipt.status, "blocked");
  assert.deepEqual(receipt.remaining, [failed, options.oldHead]);
  assert.deepEqual(receipt.replayed, []);
  assert.equal(existsSync(join(options.worktree, "suffix.txt")), false);
  assert.equal(
    spawnSync("git", ["rev-parse", "CHERRY_PICK_HEAD"], {
      cwd: options.worktree,
      encoding: "utf8",
    }).stdout.trim(),
    failed,
  );
});

fixture(({ root, repo, git, options }) => {
  const stale = join(root, "stale");
  git("worktree", "add", "--detach", stale, options.oldParent);
  const metadata = join(repo, ".git", "worktrees", "stale", "gitdir");
  const before = readFileSync(metadata, "utf8");
  rmSync(stale, { recursive: true });
  assert.match(git("worktree", "list", "--porcelain"), /prunable/);
  const receipt = prepareRecovery(options);
  assert.equal(receipt.status, "prepared");
  assert.equal(readFileSync(metadata, "utf8"), before);
  assert.match(git("worktree", "list", "--porcelain"), /prunable/);
  assert.equal(existsSync(stale), false);
});

fixture(({ root, git, options }) => {
  const missing = join(root, "locked");
  git("worktree", "add", "--detach", missing, options.oldParent);
  git("worktree", "lock", missing);
  rmSync(missing, { recursive: true });
  const refs = git("show-ref");
  assert.throws(() => prepareRecovery(options), /ENOENT/);
  assert.equal(git("show-ref"), refs);
  assert.equal(existsSync(options.worktree), false);
});

fixture(({ git, commit, options }) => {
  const first = options.oldHead;
  const combinedEnd = commit("second.txt", "combined second patch\n");
  options.oldHead = commit("suffix.txt", "not applied upstream\n");
  git("switch", "-c", "combined-base", options.oldParent);
  git("merge", "--squash", combinedEnd);
  git("commit", "-m", "combine first two patches");
  options.newBase = git("rev-parse", "HEAD");
  const receipt = prepareRecovery(options);
  assert.equal(receipt.status, "blocked");
  assert.equal(receipt.failure.kind, "empty-cherry-pick");
  assert.equal(receipt.failure.cherryPickHead, first);
  assert.equal(receipt.failure.indexTree, receipt.failure.headTree);
  assert.deepEqual(receipt.remaining, [first, combinedEnd, options.oldHead]);
  assert.deepEqual(receipt.skipped, []);
  assert.deepEqual(receipt.conflicts, []);
  assert.equal(receipt.candidateStatus, "");
  assert.match(receipt.cherryProof, new RegExp(`\\+ ${first}`));
  assert.equal(receipt.candidateHead, options.newBase);
  assert.equal(existsSync(join(options.worktree, "suffix.txt")), false);
  assert.equal(
    spawnSync("git", ["rev-parse", "CHERRY_PICK_HEAD"], {
      cwd: options.worktree,
      encoding: "utf8",
    }).stdout.trim(),
    first,
  );
  assert.ok(
    receipt.failure.proofCommands.some(
      (args) => args.includes(`${first}^`) && args.includes(first),
    ),
  );
  assert.ok(
    receipt.failure.operatorOptions.some((option) => option.includes("--skip")),
  );
  assert.ok(
    receipt.failure.operatorOptions.some((option) =>
      option.includes("--allow-empty"),
    ),
  );
});

assert.throws(() => parseRecoveryArgs(["--push", "yes"]), /Invalid/);
assert.throws(
  () => parseRecoveryArgs(["--branch", "a", "--branch", "b"]),
  /duplicate/,
);
assert.throws(() => parseRecoveryArgs(["--old-head"]), /Invalid/);
console.log("stack recovery disposable Git fixtures passed");
