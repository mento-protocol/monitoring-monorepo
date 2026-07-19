#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(
  new URL("./agent-autoreview.mjs", import.meta.url),
);
const fixtureParent = process.env.AUTOREVIEW_TEST_TRUSTED_FIXTURE_PARENT;
assert.ok(
  fixtureParent,
  "AUTOREVIEW_TEST_TRUSTED_FIXTURE_PARENT must name the suite's private fixture directory",
);
const root = mkdtempSync(
  path.join(fixtureParent, "agent-autoreview-target-guard."),
);
const repo = path.join(root, "repo");
const bin = path.join(root, "bin");
const claude = path.join(bin, "claude");

function git(args) {
  const result = spawnSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(
    result.status,
    0,
    `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
  );
  return result.stdout.trim();
}

try {
  mkdirSync(repo);
  mkdirSync(bin);
  git(["init", "-q"]);
  git(["config", "user.email", "autoreview-test@example.com"]);
  git(["config", "user.name", "Autoreview Test"]);
  writeFileSync(path.join(repo, "reviewed.txt"), "base\n");
  git(["add", "reviewed.txt"]);
  git(["commit", "-q", "-m", "base"]);
  const base = git(["rev-parse", "HEAD"]);
  writeFileSync(path.join(repo, "reviewed.txt"), "base\nreviewed change\n");
  git(["add", "reviewed.txt"]);
  git(["commit", "-q", "-m", "change"]);
  const head = git(["rev-parse", "HEAD"]);

  writeFileSync(
    claude,
    `#!/bin/sh
case "\${1:-}" in
  --version)
    printf '%s\\n' '2.1.169'
    exit 0
    ;;
  --help)
    printf '%s\\n' '--safe-mode --setting-sources --strict-mcp-config --disallowedTools --tools'
    exit 0
    ;;
esac
cat >/dev/null
printf '%s\\n' 'unrelated local churn' >"$AUTOREVIEW_FAKE_MUTATE_REPO/unrelated.tmp"
printf '%s\\n' '{"findings":[],"overall_correctness":"patch is correct","overall_explanation":"fixture review","overall_confidence":1}'
`,
  );
  chmodSync(claude, 0o755);

  const result = spawnSync(
    process.execPath,
    [
      script,
      "--mode",
      "branch",
      "--base",
      base,
      "--engine",
      "claude",
      "--no-tools",
      "--frozen-target-mode",
      "branch",
      "--frozen-head-oid",
      head,
    ],
    {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...process.env,
        AUTOREVIEW_FAKE_MUTATE_REPO: repo,
        PATH: `${bin}${path.delimiter}${process.env.PATH || ""}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  assert.equal(
    result.status,
    0,
    `explicit frozen branch review rejected unrelated local churn:\n${result.stderr || result.stdout}`,
  );
  assert.match(
    result.stdout,
    /autoreview clean: no accepted\/actionable findings reported/,
  );

  const serialized = spawnSync(
    process.execPath,
    [script, "--serialize-untracked-file", "unrelated.tmp"],
    {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  assert.equal(
    serialized.status,
    0,
    `safe untracked serialization failed: ${serialized.stderr}`,
  );
  assert.match(serialized.stdout, /path: "unrelated\.tmp"/);
  assert.match(serialized.stdout, /unrelated local churn/);

  const outside = path.join(root, "outside.txt");
  writeFileSync(outside, "must not be serialized\n");
  symlinkSync(outside, path.join(repo, "linked.tmp"));
  const linked = spawnSync(
    process.execPath,
    [script, "--serialize-untracked-file", "linked.tmp"],
    {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  assert.notEqual(linked.status, 0);
  assert.match(linked.stderr, /symlinked|regular file/);
  assert.doesNotMatch(linked.stdout, /must not be serialized/);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("agent-autoreview target guard tests passed");
