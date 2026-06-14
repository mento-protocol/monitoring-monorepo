#!/usr/bin/env node
/**
 * Unit tests for scripts/check-notifier-coverage.mjs.
 *
 * Imports parse helpers from check-notifier-coverage-helpers.mjs (the shared
 * module) so tests always exercise the real implementations without drift.
 * End-to-end CLI behaviour is tested via spawnSync against a synthetic
 * WORKFLOWS_DIR written to a temp directory.
 *
 * Run: node scripts/check-notifier-coverage.test.mjs
 * CI:  .github/workflows/ci.yml  (scripts job)
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseName,
  hasPushMain,
  hasSchedule,
  parseNotifierList,
} from "./check-notifier-coverage-helpers.mjs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const SCRIPT = join(__dirname, "check-notifier-coverage.mjs");

// ── helpers ───────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  \x1b[32m✔\x1b[0m ${name}`);
    passed++;
  } catch (/** @type {unknown} */ err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  \x1b[31m✖\x1b[0m ${name}`);
    console.error(`    ${msg}`);
    failed++;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg);
}

// ── helpers for end-to-end tests ──────────────────────────────────────────────

/**
 * Write a synthetic .github/workflows/ dir and run the script against it.
 * @param {Record<string, string>} files  filename → YAML content
 * @returns {{ exitCode: number; stdout: string; stderr: string }}
 */
function runScript(files) {
  const dir = mkdtempSync(join(tmpdir(), "notifier-coverage-test-"));
  const workflowsDir = join(dir, ".github", "workflows");
  mkdirSync(workflowsDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(workflowsDir, name), content, "utf8");
  }
  const result = spawnSync(process.execPath, [SCRIPT], {
    cwd: dir,
    encoding: "utf8",
  });
  rmSync(dir, { recursive: true, force: true });
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

// ── parseName tests ───────────────────────────────────────────────────────────

console.log("\nparseName");

test("returns unquoted name", () => {
  const name = parseName(
    "name: My Workflow\non:\n  push:\n    branches: [main]\n",
  );
  assert(
    name === "My Workflow",
    `expected "My Workflow", got ${JSON.stringify(name)}`,
  );
});

test("strips single-quoted name", () => {
  const name = parseName(
    "name: 'Quoted Workflow'\non:\n  push:\n    branches: [main]\n",
  );
  assert(
    name === "Quoted Workflow",
    `expected "Quoted Workflow", got ${JSON.stringify(name)}`,
  );
});

test("strips double-quoted name", () => {
  const name = parseName(
    'name: "Double Quoted"\non:\n  push:\n    branches: [main]\n',
  );
  assert(
    name === "Double Quoted",
    `expected "Double Quoted", got ${JSON.stringify(name)}`,
  );
});

test("returns null when no name: field", () => {
  const name = parseName("on:\n  push:\n    branches: [main]\n");
  assert(name === null, `expected null, got ${JSON.stringify(name)}`);
});

// ── hasPushMain tests ─────────────────────────────────────────────────────────

console.log("\nhasPushMain");

test("true for inline [main]", () => {
  assert(
    hasPushMain(
      "name: T\non:\n  push:\n    branches: [main]\njobs:\n  t:\n    runs-on: ubuntu-latest\n",
    ),
    "expected true for branches: [main]",
  );
});

test("true for block-sequence - main", () => {
  assert(
    hasPushMain(
      "name: T\non:\n  push:\n    branches:\n      - main\njobs:\n  t:\n    runs-on: ubuntu-latest\n",
    ),
    "expected true for block-sequence - main",
  );
});

test("false for push to other branch (inline)", () => {
  assert(
    !hasPushMain(
      "name: T\non:\n  push:\n    branches: [develop]\njobs:\n  t:\n    runs-on: ubuntu-latest\n",
    ),
    "expected false for branches: [develop]",
  );
});

test("false for push to other branch (block-sequence)", () => {
  assert(
    !hasPushMain(
      "name: T\non:\n  push:\n    branches:\n      - develop\njobs:\n  t:\n    runs-on: ubuntu-latest\n",
    ),
    "expected false for block-sequence - develop",
  );
});

test("false when only pull_request targets main (no push)", () => {
  assert(
    !hasPushMain(
      "name: T\non:\n  pull_request:\n    branches: [main]\njobs:\n  t:\n    runs-on: ubuntu-latest\n",
    ),
    "expected false for pull_request-only trigger",
  );
});

test("false when no on: block at all", () => {
  assert(
    !hasPushMain("name: T\njobs:\n  t:\n    runs-on: ubuntu-latest\n"),
    "expected false for missing on: block",
  );
});

test("true when push + pull_request both present and push targets main", () => {
  const yaml = [
    "name: T",
    "on:",
    "  pull_request:",
    "    branches: [main]",
    "  push:",
    "    branches: [main]",
    "jobs:",
    "  t:",
    "    runs-on: ubuntu-latest",
    "",
  ].join("\n");
  assert(
    hasPushMain(yaml),
    "expected true when push + pull_request both target main",
  );
});

test("true for branchless push: (no branches restriction — runs on all branches including main)", () => {
  // `on:\n  push:` with no branches key means every push, including main.
  const yaml = [
    "name: T",
    "on:",
    "  push:",
    "jobs:",
    "  t:",
    "    runs-on: ubuntu-latest",
    "",
  ].join("\n");
  assert(
    hasPushMain(yaml),
    "expected true for branchless push: (no branches restriction)",
  );
});

test("true for bare push: as last top-level key (on: last-key edge case)", () => {
  // on: is the last top-level key — the lookahead for ^\S fails because
  // nothing follows; the EOF fallback must capture the block.
  const yaml = ["name: T", "on:", "  push:", "    branches: [main]", ""].join(
    "\n",
  );
  assert(hasPushMain(yaml), "expected true when on: is the last top-level key");
});

// ── hasPushMain edge-case tests (js-yaml refactor) ───────────────────────────

console.log("\nhasPushMain (edge cases — js-yaml)");

test("true for scalar shorthand: on: push", () => {
  // GitHub supports bare `on: push` which runs on all branches including main.
  const yaml = "name: T\non: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n";
  assert(hasPushMain(yaml), "expected true for scalar on: push");
});

test("true for array shorthand: on: [push, schedule]", () => {
  // Array shorthand includes push → main-capable.
  const yaml =
    "name: T\non: [push, schedule]\njobs:\n  t:\n    runs-on: ubuntu-latest\n";
  assert(hasPushMain(yaml), "expected true for on: [push, schedule]");
});

test("true for array shorthand: on: [push] (push only)", () => {
  const yaml = "name: T\non: [push]\njobs:\n  t:\n    runs-on: ubuntu-latest\n";
  assert(hasPushMain(yaml), "expected true for on: [push]");
});

test("false for array shorthand without push: on: [schedule]", () => {
  const yaml =
    "name: T\non: [schedule]\njobs:\n  t:\n    runs-on: ubuntu-latest\n";
  assert(!hasPushMain(yaml), "expected false for on: [schedule] (no push)");
});

test("false for not-main branch — no word-boundary false match", () => {
  // The old \\bmain\\b regex matched 'not-main' because \\b sees the hyphen
  // boundary. The exact list match must return false here.
  const yaml = [
    "name: T",
    "on:",
    "  push:",
    "    branches: [not-main]",
    "jobs:",
    "  t:",
    "    runs-on: ubuntu-latest",
    "",
  ].join("\n");
  assert(!hasPushMain(yaml), "expected false for branches: [not-main]");
});

test("false for main-x branch — no substring false match", () => {
  const yaml = [
    "name: T",
    "on:",
    "  push:",
    "    branches: [main-x]",
    "jobs:",
    "  t:",
    "    runs-on: ubuntu-latest",
    "",
  ].join("\n");
  assert(!hasPushMain(yaml), "expected false for branches: [main-x]");
});

// ── hasPushMain glob branch filter tests ─────────────────────────────────────

console.log("\nhasPushMain (glob branch filters)");

test("true for branches: ['**'] — matches all branches including main", () => {
  const yaml = [
    "name: T",
    "on:",
    "  push:",
    "    branches: ['**']",
    "jobs:",
    "  t:",
    "    runs-on: ubuntu-latest",
    "",
  ].join("\n");
  assert(hasPushMain(yaml), "expected true for branches: ['**']");
});

test("true for branches: ['*'] — matches all top-level branches including main", () => {
  const yaml = [
    "name: T",
    "on:",
    "  push:",
    "    branches: ['*']",
    "jobs:",
    "  t:",
    "    runs-on: ubuntu-latest",
    "",
  ].join("\n");
  assert(hasPushMain(yaml), "expected true for branches: ['*']");
});

test("false for branches: ['releases/**'] — does not match main", () => {
  const yaml = [
    "name: T",
    "on:",
    "  push:",
    "    branches: ['releases/**']",
    "jobs:",
    "  t:",
    "    runs-on: ubuntu-latest",
    "",
  ].join("\n");
  assert(!hasPushMain(yaml), "expected false for branches: ['releases/**']");
});

test("false for branches-ignore: ['**'] — ignores all branches including main", () => {
  const yaml = [
    "name: T",
    "on:",
    "  push:",
    "    branches-ignore: ['**']",
    "jobs:",
    "  t:",
    "    runs-on: ubuntu-latest",
    "",
  ].join("\n");
  assert(
    !hasPushMain(yaml),
    "expected false for branches-ignore: ['**'] (main matched by glob)",
  );
});

test("true for branches-ignore: ['releases/**'] — main is not ignored", () => {
  const yaml = [
    "name: T",
    "on:",
    "  push:",
    "    branches-ignore: ['releases/**']",
    "jobs:",
    "  t:",
    "    runs-on: ubuntu-latest",
    "",
  ].join("\n");
  assert(
    hasPushMain(yaml),
    "expected true for branches-ignore: ['releases/**'] (main not matched)",
  );
});

test("true for branches-ignore without main (main is not ignored)", () => {
  // branches-ignore: [develop] → main is not in the ignore list → TRUE.
  const yaml = [
    "name: T",
    "on:",
    "  push:",
    "    branches-ignore: [develop]",
    "jobs:",
    "  t:",
    "    runs-on: ubuntu-latest",
    "",
  ].join("\n");
  assert(
    hasPushMain(yaml),
    "expected true for branches-ignore: [develop] (main not ignored)",
  );
});

test("false for branches-ignore that explicitly ignores main", () => {
  // branches-ignore: [main] → main is excluded → FALSE.
  const yaml = [
    "name: T",
    "on:",
    "  push:",
    "    branches-ignore: [main]",
    "jobs:",
    "  t:",
    "    runs-on: ubuntu-latest",
    "",
  ].join("\n");
  assert(
    !hasPushMain(yaml),
    "expected false for branches-ignore: [main] (main explicitly ignored)",
  );
});

test("false for tag-only push filter (no branches/branches-ignore)", () => {
  // push: tags: [...] without branches → does NOT run on branch pushes.
  const yaml = [
    "name: T",
    "on:",
    "  push:",
    "    tags: ['v*']",
    "jobs:",
    "  t:",
    "    runs-on: ubuntu-latest",
    "",
  ].join("\n");
  assert(
    !hasPushMain(yaml),
    "expected false for tag-only push (no branches filter)",
  );
});

test("false for tags-ignore-only push filter (no branches/branches-ignore)", () => {
  const yaml = [
    "name: T",
    "on:",
    "  push:",
    "    tags-ignore: ['v*']",
    "jobs:",
    "  t:",
    "    runs-on: ubuntu-latest",
    "",
  ].join("\n");
  assert(
    !hasPushMain(yaml),
    "expected false for tags-ignore-only push (no branches filter)",
  );
});

// ── hasSchedule edge-case tests ───────────────────────────────────────────────

test("true for array shorthand: on: [push, schedule] → hasSchedule", () => {
  const yaml =
    "name: T\non: [push, schedule]\njobs:\n  t:\n    runs-on: ubuntu-latest\n";
  assert(hasSchedule(yaml), "expected true for on: [push, schedule]");
});

test("false for array shorthand without schedule: on: [push]", () => {
  const yaml = "name: T\non: [push]\njobs:\n  t:\n    runs-on: ubuntu-latest\n";
  assert(!hasSchedule(yaml), "expected false for on: [push] (no schedule)");
});

// ── hasSchedule tests ─────────────────────────────────────────────────────────

console.log("\nhasSchedule");

test("true when schedule: key is present", () => {
  assert(
    hasSchedule("name: T\non:\n  schedule:\n    - cron: '0 6 * * *'\n"),
    "expected true for on.schedule",
  );
});

test("false when no schedule: key", () => {
  assert(
    !hasSchedule("name: T\non:\n  push:\n    branches: [main]\n"),
    "expected false for push-only workflow",
  );
});

test("false for pull_request-only workflow", () => {
  assert(
    !hasSchedule("name: T\non:\n  pull_request:\n    branches: [main]\n"),
    "expected false for pull_request-only",
  );
});

// ── parseNotifierList tests ───────────────────────────────────────────────────

console.log("\nparseNotifierList");

test("returns empty set on non-matching YAML (fail path)", () => {
  const names = parseNotifierList(
    "name: Random\non:\n  push:\n    branches: [main]\n",
  );
  assert(
    names.size === 0,
    `expected empty set (triggers fail path), got size ${names.size}`,
  );
});

test("parses a notifier list correctly", () => {
  const notifierYaml = [
    "name: Notify Slack",
    "on:",
    "  workflow_run:",
    "    workflows:",
    "      - CI",
    "      - Trunk",
    "      - Alerts Infra",
    "    types: [completed]",
    "",
  ].join("\n");
  const names = parseNotifierList(notifierYaml);
  assert(names.has("CI"), "expected CI in set");
  assert(names.has("Trunk"), "expected Trunk in set");
  assert(names.has("Alerts Infra"), "expected Alerts Infra in set");
  assert(names.size === 3, `expected 3 entries, got ${names.size}`);
});

test("strips quotes from notifier list entries", () => {
  const notifierYaml = [
    "name: Notify Slack",
    "on:",
    "  workflow_run:",
    "    workflows:",
    "      - 'Quoted Name'",
    "    types: [completed]",
    "",
  ].join("\n");
  const names = parseNotifierList(notifierYaml);
  assert(names.has("Quoted Name"), "expected unquoted 'Quoted Name' in set");
});

// ── end-to-end CLI tests ──────────────────────────────────────────────────────

console.log("\nend-to-end (spawnSync)");

const NOTIFIER_YAML = (workflows) =>
  [
    "name: Notify Slack on main-branch workflow failure",
    "on:",
    "  workflow_run:",
    "    workflows:",
    ...workflows.map((w) => `      - ${w}`),
    "    types: [completed]",
    "  workflow_dispatch:",
    "",
  ].join("\n");

const PUSH_WORKFLOW = (name) =>
  [
    `name: ${name}`,
    "on:",
    "  push:",
    "    branches: [main]",
    "jobs:",
    "  build:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: echo ok",
    "",
  ].join("\n");

const SCHEDULE_WORKFLOW = (name) =>
  [
    `name: ${name}`,
    "on:",
    "  schedule:",
    "    - cron: '0 6 * * *'",
    "jobs:",
    "  check:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: echo ok",
    "",
  ].join("\n");

const PR_ONLY_WORKFLOW = (name) =>
  [
    `name: ${name}`,
    "on:",
    "  pull_request:",
    "    branches: [main]",
    "jobs:",
    "  lint:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: echo ok",
    "",
  ].join("\n");

test("exits 0 when all push workflows are in notifier", () => {
  const { exitCode, stdout, stderr } = runScript({
    "notify-slack-on-main-failure.yml": NOTIFIER_YAML(["My CI"]),
    "ci.yml": PUSH_WORKFLOW("My CI"),
  });
  assert(
    exitCode === 0,
    `expected exit 0, got ${exitCode}\nstdout: ${stdout}\nstderr: ${stderr}`,
  );
});

test("exits 0 when all schedule workflows are in notifier", () => {
  const { exitCode, stdout, stderr } = runScript({
    "notify-slack-on-main-failure.yml": NOTIFIER_YAML(["Supply Chain"]),
    "supply-chain.yml": SCHEDULE_WORKFLOW("Supply Chain"),
  });
  assert(
    exitCode === 0,
    `expected exit 0, got ${exitCode}\nstdout: ${stdout}\nstderr: ${stderr}`,
  );
});

test("exits non-zero when qualifying workflow is missing from notifier", () => {
  // push workflow present but not in the notifier list → must fail.
  // The notifier must have at least one entry or the parse-guard fires first.
  const { exitCode, stderr } = runScript({
    "notify-slack-on-main-failure.yml": NOTIFIER_YAML(["Some Other Workflow"]),
    "ci.yml": PUSH_WORKFLOW("My CI"),
  });
  assert(exitCode !== 0, `expected non-zero exit, got ${exitCode}`);
  assert(
    stderr.includes("My CI") && stderr.includes("NOT listed"),
    `expected missing-workflow error, got: ${stderr}`,
  );
});

test("PR-only workflow is not required in notifier (no push, no schedule)", () => {
  // A push workflow is covered in the notifier; a PR-only workflow coexists.
  // The PR-only workflow must NOT be flagged as missing from the notifier.
  const { exitCode, stderr } = runScript({
    "notify-slack-on-main-failure.yml": NOTIFIER_YAML(["My CI"]),
    "ci.yml": PUSH_WORKFLOW("My CI"),
    "pr-lint.yml": PR_ONLY_WORKFLOW("PR Lint"),
  });
  assert(
    exitCode === 0,
    `expected exit 0 (PR-only workflow must not be flagged), got ${exitCode}\nstderr: ${stderr}`,
  );
  assert(
    !stderr.includes("PR Lint"),
    `PR-only workflow must not appear in error output, got: ${stderr}`,
  );
});

test("checked===0 guard fires when no push/schedule workflows found", () => {
  // Only a PR-only workflow — script must fail with the checked===0 error.
  const { exitCode, stderr } = runScript({
    "notify-slack-on-main-failure.yml": NOTIFIER_YAML(["Dummy"]),
    "pr-only.yml": PR_ONLY_WORKFLOW("PR Only"),
  });
  assert(exitCode !== 0, `expected non-zero exit, got ${exitCode}`);
  assert(
    stderr.includes("No push/schedule workflows found"),
    `expected checked===0 guard message, got: ${stderr}`,
  );
});

test("notifier itself is in EXCLUDED_NAMES and not self-required", () => {
  // Even if the notifier is the only file and isn't in its own list, it must
  // not fail (it's excluded by name).
  const { exitCode, stderr } = runScript({
    "notify-slack-on-main-failure.yml": NOTIFIER_YAML([]),
  });
  // Only file is the notifier (excluded). checked===0 fires.
  assert(
    exitCode !== 0,
    "checked===0 guard fires (no other qualifying workflows)",
  );
  assert(
    !stderr.includes("NOT listed"),
    "notifier itself must not appear in missing-workflow error",
  );
});

test("exits 0 when block-sequence push branches: - main workflow is covered", () => {
  const blockSeqWorkflow = [
    "name: Block Seq CI",
    "on:",
    "  push:",
    "    branches:",
    "      - main",
    "jobs:",
    "  build:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: echo ok",
    "",
  ].join("\n");
  const { exitCode, stdout, stderr } = runScript({
    "notify-slack-on-main-failure.yml": NOTIFIER_YAML(["Block Seq CI"]),
    "block-seq.yml": blockSeqWorkflow,
  });
  assert(
    exitCode === 0,
    `expected exit 0 for block-sequence branches form, got ${exitCode}\nstdout: ${stdout}\nstderr: ${stderr}`,
  );
});

test("exits 0 for branchless push workflow covered in notifier", () => {
  // `on:\n  push:` with no branches key means every push, so main is included.
  const branchlessPushWorkflow = [
    "name: Branchless Push CI",
    "on:",
    "  push:",
    "jobs:",
    "  build:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: echo ok",
    "",
  ].join("\n");
  const { exitCode, stdout, stderr } = runScript({
    "notify-slack-on-main-failure.yml": NOTIFIER_YAML(["Branchless Push CI"]),
    "branchless.yml": branchlessPushWorkflow,
  });
  assert(
    exitCode === 0,
    `expected exit 0 for branchless push, got ${exitCode}\nstdout: ${stdout}\nstderr: ${stderr}`,
  );
});

test("exits non-zero for branchless push workflow NOT in notifier", () => {
  const branchlessPushWorkflow = [
    "name: Branchless Push CI",
    "on:",
    "  push:",
    "jobs:",
    "  build:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: echo ok",
    "",
  ].join("\n");
  const { exitCode, stderr } = runScript({
    "notify-slack-on-main-failure.yml": NOTIFIER_YAML(["Other Workflow"]),
    "branchless.yml": branchlessPushWorkflow,
  });
  assert(exitCode !== 0, `expected non-zero exit, got ${exitCode}`);
  assert(
    stderr.includes("Branchless Push CI") && stderr.includes("NOT listed"),
    `expected missing-workflow error, got: ${stderr}`,
  );
});

test("scalar on: push is treated as main push (e2e)", () => {
  const scalarPushWorkflow = [
    "name: Scalar Push CI",
    "on: push",
    "jobs:",
    "  build:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: echo ok",
    "",
  ].join("\n");
  const { exitCode, stdout, stderr } = runScript({
    "notify-slack-on-main-failure.yml": NOTIFIER_YAML(["Scalar Push CI"]),
    "scalar.yml": scalarPushWorkflow,
  });
  assert(
    exitCode === 0,
    `expected exit 0 for scalar on: push, got ${exitCode}\nstdout: ${stdout}\nstderr: ${stderr}`,
  );
});

test("branches-ignore without main is treated as main-capable (e2e)", () => {
  const branchIgnoreWorkflow = [
    "name: Branch Ignore CI",
    "on:",
    "  push:",
    "    branches-ignore: [develop]",
    "jobs:",
    "  build:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: echo ok",
    "",
  ].join("\n");
  const { exitCode, stdout, stderr } = runScript({
    "notify-slack-on-main-failure.yml": NOTIFIER_YAML(["Branch Ignore CI"]),
    "branch-ignore.yml": branchIgnoreWorkflow,
  });
  assert(
    exitCode === 0,
    `expected exit 0 for branches-ignore without main, got ${exitCode}\nstdout: ${stdout}\nstderr: ${stderr}`,
  );
});

test("tag-only push workflow is NOT required in notifier (e2e)", () => {
  // A workflow that only runs on tag pushes should not need notifier coverage.
  const tagOnlyWorkflow = [
    "name: Tag Release",
    "on:",
    "  push:",
    "    tags: ['v*']",
    "jobs:",
    "  release:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: echo ok",
    "",
  ].join("\n");
  const { exitCode, stderr } = runScript({
    "notify-slack-on-main-failure.yml": NOTIFIER_YAML(["Some CI"]),
    "ci.yml": PUSH_WORKFLOW("Some CI"),
    "release.yml": tagOnlyWorkflow,
  });
  assert(
    exitCode === 0,
    `expected exit 0 (tag-only workflow must not be flagged), got ${exitCode}\nstderr: ${stderr}`,
  );
  assert(
    !stderr.includes("Tag Release"),
    `tag-only workflow must not appear in error output, got: ${stderr}`,
  );
});

test("not-main branch workflow is NOT required in notifier (e2e)", () => {
  // A workflow only targeting 'not-main' must not appear as missing coverage.
  const notMainWorkflow = [
    "name: Not Main CI",
    "on:",
    "  push:",
    "    branches: [not-main]",
    "jobs:",
    "  build:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: echo ok",
    "",
  ].join("\n");
  const { exitCode, stderr } = runScript({
    "notify-slack-on-main-failure.yml": NOTIFIER_YAML(["Some CI"]),
    "ci.yml": PUSH_WORKFLOW("Some CI"),
    "not-main.yml": notMainWorkflow,
  });
  assert(
    exitCode === 0,
    `expected exit 0 (not-main branch workflow must not be flagged), got ${exitCode}\nstderr: ${stderr}`,
  );
  assert(
    !stderr.includes("Not Main CI"),
    `not-main branch workflow must not appear in error output, got: ${stderr}`,
  );
});

// ── glob branch filter e2e tests ──────────────────────────────────────────────

console.log("\nglob branch filters (e2e)");

test("exits 0 for branches: ['**'] workflow covered in notifier", () => {
  const allBranchesWorkflow = [
    "name: All Branches CI",
    "on:",
    "  push:",
    "    branches: ['**']",
    "jobs:",
    "  build:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: echo ok",
    "",
  ].join("\n");
  const { exitCode, stdout, stderr } = runScript({
    "notify-slack-on-main-failure.yml": NOTIFIER_YAML(["All Branches CI"]),
    "all-branches.yml": allBranchesWorkflow,
  });
  assert(
    exitCode === 0,
    `expected exit 0 for branches: ['**'], got ${exitCode}\nstdout: ${stdout}\nstderr: ${stderr}`,
  );
});

test("exits 0 for branches: ['*'] workflow covered in notifier", () => {
  const starBranchWorkflow = [
    "name: Star Branch CI",
    "on:",
    "  push:",
    "    branches: ['*']",
    "jobs:",
    "  build:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: echo ok",
    "",
  ].join("\n");
  const { exitCode, stdout, stderr } = runScript({
    "notify-slack-on-main-failure.yml": NOTIFIER_YAML(["Star Branch CI"]),
    "star-branch.yml": starBranchWorkflow,
  });
  assert(
    exitCode === 0,
    `expected exit 0 for branches: ['*'], got ${exitCode}\nstdout: ${stdout}\nstderr: ${stderr}`,
  );
});

test("tag-only workflow with releases/** branch is NOT required in notifier", () => {
  const releasesWorkflow = [
    "name: Releases CI",
    "on:",
    "  push:",
    "    branches: ['releases/**']",
    "jobs:",
    "  build:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: echo ok",
    "",
  ].join("\n");
  const { exitCode, stderr } = runScript({
    "notify-slack-on-main-failure.yml": NOTIFIER_YAML(["Some CI"]),
    "ci.yml": PUSH_WORKFLOW("Some CI"),
    "releases.yml": releasesWorkflow,
  });
  assert(
    exitCode === 0,
    `expected exit 0 (releases/** does not match main), got ${exitCode}\nstderr: ${stderr}`,
  );
  assert(
    !stderr.includes("Releases CI"),
    `releases/** workflow must not appear in error output, got: ${stderr}`,
  );
});

// ── unnamed workflow e2e tests ────────────────────────────────────────────────

console.log("\nunnamed workflows (e2e)");

test("unnamed push-to-main workflow is flagged as missing when absent from notifier", () => {
  // A workflow without a name: field has its effective name derived from the
  // repo-relative file path (GitHub's documented fallback).
  const unnamedWorkflow = [
    "on:",
    "  push:",
    "    branches: [main]",
    "jobs:",
    "  build:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: echo ok",
    "",
  ].join("\n");
  const { exitCode, stderr } = runScript({
    // The notifier covers a DIFFERENT name — the unnamed workflow is uncovered.
    "notify-slack-on-main-failure.yml": NOTIFIER_YAML([
      "Some Other Workflow",
      // We need at least one non-unnamed push workflow so checked > 0
    ]),
    "ci.yml": PUSH_WORKFLOW("Some Other Workflow"),
    "unnamed.yml": unnamedWorkflow,
  });
  assert(
    exitCode !== 0,
    `expected non-zero exit for uncovered unnamed workflow, got ${exitCode}`,
  );
  assert(
    stderr.includes("NOT listed"),
    `expected missing-workflow error for unnamed workflow, got: ${stderr}`,
  );
  // The effective name should appear in the error and be the path form
  assert(
    stderr.includes("unnamed.yml"),
    `expected file path in error for unnamed workflow, got: ${stderr}`,
  );
});

test("unnamed push-to-main workflow is covered when notifier uses its path as name", () => {
  // If the notifier lists the workflow by its effective (path-derived) name,
  // the check must pass.
  const unnamedWorkflow = [
    "on:",
    "  push:",
    "    branches: [main]",
    "jobs:",
    "  build:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: echo ok",
    "",
  ].join("\n");
  // The effective name of the unnamed workflow when ROOT = tmpdir is
  // ".github/workflows/unnamed.yml"
  const { exitCode, stdout, stderr } = runScript({
    "notify-slack-on-main-failure.yml": NOTIFIER_YAML([
      "Some CI",
      ".github/workflows/unnamed.yml",
    ]),
    "ci.yml": PUSH_WORKFLOW("Some CI"),
    "unnamed.yml": unnamedWorkflow,
  });
  assert(
    exitCode === 0,
    `expected exit 0 when unnamed workflow covered by path name, got ${exitCode}\nstdout: ${stdout}\nstderr: ${stderr}`,
  );
});

// ── summary ───────────────────────────────────────────────────────────────────

console.log(
  `\n${passed + failed} tests: \x1b[32m${passed} passed\x1b[0m${failed > 0 ? `, \x1b[31m${failed} failed\x1b[0m` : ""}\n`,
);

if (failed > 0) {
  process.exit(1);
}
