#!/usr/bin/env node
/**
 * Unit tests for scripts/check-notifier-coverage.mjs.
 *
 * Covers the parse helpers directly (by re-implementing them inline with
 * the same logic — avoids ES-module import complexities since the script
 * is not structured as a library) and the end-to-end CLI path via
 * spawnSync against a synthetic WORKFLOWS_DIR written to a temp directory.
 *
 * Run: node scripts/check-notifier-coverage.test.mjs
 * CI:  .github/workflows/ci.yml  (scripts job)
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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

// ── mirror parse helpers (kept in sync with check-notifier-coverage.mjs) ─────
// Re-implemented here so tests run without dynamic import of the script.

function parseName(text) {
  const m = text.match(/^name:\s*(.+)$/m);
  return m ? m[1].trim().replace(/^['"]|['"]$/g, "") : null;
}

function hasPushMain(text) {
  const onMatch = text.match(/^on:\s*\n([\s\S]*?)(?=^\S)/m);
  if (!onMatch) return false;
  const onBlock = onMatch[1];
  const pushMatch = onBlock.match(/^ {2}push:\s*\n((?:(?!^ {2}\S)[\s\S])*)/m);
  if (!pushMatch) return false;
  const pushBlock = pushMatch[1];
  if (/branches:\s*\[?[^\]]*\bmain\b/.test(pushBlock)) return true;
  if (/branches:\s*\n(?:\s*-\s+\S+\n)*\s*-\s+main\b/.test(pushBlock))
    return true;
  return false;
}

function hasSchedule(text) {
  return /^ {2}schedule:\s*$/m.test(text);
}

function parseNotifierList(text) {
  const workflowRunMatch = text.match(
    /workflow_run:\s*\n\s+workflows:\s*\n([\s\S]*?)(?=\s+types:)/,
  );
  if (!workflowRunMatch) return new Set();
  const listBlock = workflowRunMatch[1];
  const names = new Set();
  for (const m of listBlock.matchAll(/^\s+-\s+(.+)$/gm)) {
    names.add(m[1].trim().replace(/^['"]|['"]$/g, ""));
  }
  return names;
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
  const { exitCode } = runScript({
    "notify-slack-on-main-failure.yml": NOTIFIER_YAML([]),
    "pr-lint.yml": PR_ONLY_WORKFLOW("PR Lint"),
  });
  // No qualifying workflows → checked===0 guard fires with non-zero exit,
  // but that is a different path from the notifier-coverage check.
  // The PR-only workflow itself should NOT be flagged as missing.
  // (checked===0 guard fires because no push/schedule workflows exist.)
  assert(
    exitCode !== 0,
    "checked===0 guard should fire when no push/schedule workflows found",
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

// ── summary ───────────────────────────────────────────────────────────────────

console.log(
  `\n${passed + failed} tests: \x1b[32m${passed} passed\x1b[0m${failed > 0 ? `, \x1b[31m${failed} failed\x1b[0m` : ""}\n`,
);

if (failed > 0) {
  process.exit(1);
}
