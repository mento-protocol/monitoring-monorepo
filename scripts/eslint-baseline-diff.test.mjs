#!/usr/bin/env node
/**
 * Semantic tests for scripts/eslint-baseline-diff.mjs.
 *
 * Codex round-6 PASS_WITH_NOTES flagged that the wrapper is now the
 * source of truth for every package's Lint job but had no direct
 * behavioral coverage — only routing-level tests in
 * agent-quality-gate.test.sh. This file covers the matching, growth,
 * stale-detection, update-mode, line-proximity absorption, and
 * merge-base check paths against ESLint output injected via
 * `ESLINT_BASELINE_INPUT`.
 *
 * Runs without spawning a real ESLint pass — each test writes a canned
 * `--format json` payload to a temp dir, points the wrapper at it via
 * env var, and asserts on exit code + stderr substrings.
 */

import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const SCRIPT = resolve(__dirname, "eslint-baseline-diff.mjs");

let passed = 0;
let failed = 0;

function fail(name, msg) {
  failed += 1;
  process.stderr.write(`✗ ${name}\n  ${msg}\n`);
}
function pass(name) {
  passed += 1;
  process.stdout.write(`✓ ${name}\n`);
}

function mkTempCwd() {
  // realpathSync normalizes /var/folders → /private/var/folders on macOS
  // so the script's process.cwd() matches the filePath prefix in canned
  // ESLint output. Without this, file.filePath.replace(cwd + "/", "")
  // doesn't strip and the wrapper sees absolute paths.
  const dir = realpathSync(
    mkdtempSync(join(tmpdir(), "eslint-baseline-test-")),
  );
  // Place a tiny source file so linePreview() can read something. The
  // canned ESLint outputs reference filePath = `${dir}/sample.ts`.
  writeFileSync(
    join(dir, "sample.ts"),
    [
      "// Line 1",
      "function foo() {",
      "  return 1;",
      "}",
      "function bar() {",
      "  return 2;",
      "}",
      "function baz() {",
      "  return 3;",
      "}",
      "function qux() {",
      "  return 4;",
      "}",
      "function farFar() {", // line 14
      "  return 5;",
      "}",
      ...Array.from({ length: 50 }, (_, i) => `// padding ${i}`),
      "function veryFar() {", // line ~67
      "  return 6;",
      "}",
      "",
    ].join("\n"),
  );
  return dir;
}

function makeEslintOutput(dir, violations) {
  // Group violations by filePath; ESLint emits one entry per file.
  const byFile = new Map();
  for (const v of violations) {
    const fp = v.filePath ?? join(dir, "sample.ts");
    if (!byFile.has(fp)) byFile.set(fp, []);
    byFile.get(fp).push({
      ruleId: v.ruleId,
      severity: 2,
      message: v.message,
      line: v.line,
      column: v.column ?? 1,
    });
  }
  return [...byFile.entries()].map(([filePath, messages]) => ({
    filePath,
    messages,
  }));
}

function runScript(dir, eslintViolations, mode = "check", extraEnv = {}) {
  const inputPath = join(dir, "eslint-input.json");
  writeFileSync(
    inputPath,
    JSON.stringify(makeEslintOutput(dir, eslintViolations)),
  );
  const result = spawnSync("node", [SCRIPT, mode], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      ESLINT_BASELINE_INPUT: inputPath,
      ...extraEnv,
    },
  });
  return {
    code: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function writeBaseline(dir, entries) {
  writeFileSync(
    join(dir, "eslint-baseline.json"),
    JSON.stringify(entries, null, 2) + "\n",
  );
}

function readBaseline(dir) {
  const p = join(dir, "eslint-baseline.json");
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8"));
}

function test(name, fn) {
  const dir = mkTempCwd();
  try {
    fn(dir);
    pass(name);
  } catch (err) {
    fail(name, err.message);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// --- Tests ---

test("check: empty baseline + no violations → exit 0", (dir) => {
  const r = runScript(dir, []);
  assert(r.code === 0, `expected 0, got ${r.code}\nstderr: ${r.stderr}`);
});

test("check: violations + no baseline file → exit 1 with seed hint", (dir) => {
  const r = runScript(dir, [
    {
      ruleId: "complexity",
      message: "Function foo has a complexity of 11.",
      line: 2,
    },
  ]);
  assert(r.code === 1, `expected 1, got ${r.code}`);
  assert(
    /run `pnpm lint:baseline:update` to seed/.test(r.stderr),
    `expected seed hint, got: ${r.stderr}`,
  );
});

test("check: violation present in baseline → exit 0", (dir) => {
  writeBaseline(dir, [
    {
      file: "sample.ts",
      ruleId: "complexity",
      message: "Function foo has a complexity of 11.",
      line: 2,
      linePreview: "// Line 1 | function foo() { | return 1;",
    },
  ]);
  const r = runScript(dir, [
    {
      ruleId: "complexity",
      message: "Function foo has a complexity of 11.",
      line: 2,
    },
  ]);
  assert(r.code === 0, `expected 0, got ${r.code}\nstderr: ${r.stderr}`);
});

test("check: new violation not in baseline → exit 1", (dir) => {
  writeBaseline(dir, [
    {
      file: "sample.ts",
      ruleId: "complexity",
      message: "Function foo has a complexity of 11.",
      line: 2,
      linePreview: "// Line 1 | function foo() { | return 1;",
    },
  ]);
  const r = runScript(dir, [
    {
      ruleId: "complexity",
      message: "Function foo has a complexity of 11.",
      line: 2,
    },
    // Far from any baselined violation (line 67 vs baseline at line 2).
    {
      ruleId: "complexity",
      message: "Function veryFar has a complexity of 12.",
      line: 67,
    },
  ]);
  assert(r.code === 1, `expected 1, got ${r.code}\nstderr: ${r.stderr}`);
  assert(
    /new ESLint violation/.test(r.stderr),
    `expected new-violation message, got: ${r.stderr}`,
  );
});

test("check: stale baseline entry (not in current) → exit 1", (dir) => {
  writeBaseline(dir, [
    {
      file: "sample.ts",
      ruleId: "complexity",
      message: "Function gone has a complexity of 99.",
      line: 50,
      linePreview: "// padding 36 | // padding 37 | // padding 38",
    },
  ]);
  const r = runScript(dir, []);
  assert(r.code === 1, `expected 1, got ${r.code}\nstderr: ${r.stderr}`);
  assert(
    /stale baseline entries/.test(r.stderr),
    `expected stale message, got: ${r.stderr}`,
  );
});

test("check: line-proximity absorption (within window) passes", (dir) => {
  writeBaseline(dir, [
    {
      file: "sample.ts",
      ruleId: "complexity",
      message: "Function foo has a complexity of 11.",
      line: 2,
      linePreview: "// Line 1 | function foo() { | return 1;",
    },
  ]);
  // Same stripped key, line shifted by 20 (within ABSORB_LINE_DISTANCE=30).
  const r = runScript(dir, [
    {
      ruleId: "complexity",
      message: "Function foo has a complexity of 11.",
      line: 22,
    },
  ]);
  assert(
    r.code === 0,
    `expected 0 (absorbed), got ${r.code}\nstderr: ${r.stderr}`,
  );
});

test("check: line-proximity rejected beyond window", (dir) => {
  writeBaseline(dir, [
    {
      file: "sample.ts",
      ruleId: "complexity",
      message: "Function foo has a complexity of 11.",
      line: 2,
      linePreview: "// Line 1 | function foo() { | return 1;",
    },
  ]);
  // Same stripped key, line shifted by 65 (well outside the window).
  // Stale (baseline line 2 has no current near-match) + new (line 67
  // has no baseline near-match).
  const r = runScript(dir, [
    {
      ruleId: "complexity",
      message: "Function foo has a complexity of 11.",
      line: 67,
    },
  ]);
  assert(r.code === 1, `expected 1, got ${r.code}\nstderr: ${r.stderr}`);
  assert(
    /new ESLint violation/.test(r.stderr) &&
      /stale baseline entries/.test(r.stderr),
    `expected both new + stale messages, got: ${r.stderr}`,
  );
});

test("update: prunes stale entries cleanly", (dir) => {
  writeBaseline(dir, [
    {
      file: "sample.ts",
      ruleId: "complexity",
      message: "Function gone has a complexity of 99.",
      line: 50,
      linePreview: "// padding 36 | // padding 37 | // padding 38",
    },
    {
      file: "sample.ts",
      ruleId: "complexity",
      message: "Function foo has a complexity of 11.",
      line: 2,
      linePreview: "// Line 1 | function foo() { | return 1;",
    },
  ]);
  const r = runScript(
    dir,
    [
      {
        ruleId: "complexity",
        message: "Function foo has a complexity of 11.",
        line: 2,
      },
    ],
    "update",
  );
  assert(r.code === 0, `expected 0, got ${r.code}\nstderr: ${r.stderr}`);
  const post = readBaseline(dir);
  assert(post.length === 1, `expected 1 entry post-prune, got ${post.length}`);
  assert(
    post[0].message === "Function foo has a complexity of 11.",
    `expected foo entry, got ${JSON.stringify(post[0])}`,
  );
});

test("update: rejects genuine baseline growth (new stripped key)", (dir) => {
  writeBaseline(dir, [
    {
      file: "sample.ts",
      ruleId: "complexity",
      message: "Function foo has a complexity of 11.",
      line: 2,
      linePreview: "// Line 1 | function foo() { | return 1;",
    },
  ]);
  const r = runScript(
    dir,
    [
      {
        ruleId: "complexity",
        message: "Function foo has a complexity of 11.",
        line: 2,
      },
      {
        ruleId: "complexity",
        message: "Function veryFar has a complexity of 12.",
        line: 67,
      },
    ],
    "update",
  );
  assert(r.code === 1, `expected 1, got ${r.code}\nstderr: ${r.stderr}`);
  assert(
    /no nearby reference entry/.test(r.stderr),
    `expected growth-reject message, got: ${r.stderr}`,
  );
});

test("update: absorbs line-shift refactor without growth", (dir) => {
  writeBaseline(dir, [
    {
      file: "sample.ts",
      ruleId: "complexity",
      message: "Function foo has a complexity of 11.",
      line: 2,
      linePreview: "// Line 1 | function foo() { | return 1;",
    },
  ]);
  // Same stripped key, line shifted by 8 (within window).
  const r = runScript(
    dir,
    [
      {
        ruleId: "complexity",
        message: "Function foo has a complexity of 11.",
        line: 10,
      },
    ],
    "update",
  );
  assert(r.code === 0, `expected 0, got ${r.code}\nstderr: ${r.stderr}`);
  const post = readBaseline(dir);
  assert(post.length === 1, `expected 1 entry, got ${post.length}`);
  assert(post[0].line === 10, `expected line 10, got ${post[0].line}`);
});

test("merge-base: ESLINT_BASELINE_MAIN rejects hand-grown HEAD baseline", (dir) => {
  // HEAD baseline has an entry that "main" doesn't have, distant from
  // any main entry — simulates a hand-edit that admitted a new violation.
  writeBaseline(dir, [
    {
      file: "sample.ts",
      ruleId: "complexity",
      message: "Function foo has a complexity of 11.",
      line: 2,
      linePreview: "// Line 1 | function foo() { | return 1;",
    },
    {
      file: "sample.ts",
      ruleId: "complexity",
      message: "Function veryFar has a complexity of 99.",
      line: 67,
      linePreview: "// padding 49 | function veryFar() { | return 6;",
    },
  ]);
  // Main baseline (separate file) has only the foo entry.
  const mainPath = join(dir, "main-baseline.json");
  writeFileSync(
    mainPath,
    JSON.stringify([
      {
        file: "sample.ts",
        ruleId: "complexity",
        message: "Function foo has a complexity of 11.",
        line: 2,
        linePreview: "// Line 1 | function foo() { | return 1;",
      },
    ]),
  );
  const r = runScript(
    dir,
    [
      {
        ruleId: "complexity",
        message: "Function foo has a complexity of 11.",
        line: 2,
      },
      {
        ruleId: "complexity",
        message: "Function veryFar has a complexity of 99.",
        line: 67,
      },
    ],
    "check",
    { ESLINT_BASELINE_MAIN: mainPath },
  );
  assert(r.code === 1, `expected 1, got ${r.code}\nstderr: ${r.stderr}`);
  assert(
    /added vs origin\/main/.test(r.stderr),
    `expected merge-base growth message, got: ${r.stderr}`,
  );
});

test("merge-base: empty main file (new package) → check passes", (dir) => {
  writeBaseline(dir, [
    {
      file: "sample.ts",
      ruleId: "complexity",
      message: "Function foo has a complexity of 11.",
      line: 2,
      linePreview: "// Line 1 | function foo() { | return 1;",
    },
  ]);
  const mainPath = join(dir, "main-baseline.json");
  writeFileSync(mainPath, ""); // empty file — package didn't exist on main
  const r = runScript(
    dir,
    [
      {
        ruleId: "complexity",
        message: "Function foo has a complexity of 11.",
        line: 2,
      },
    ],
    "check",
    { ESLINT_BASELINE_MAIN: mainPath },
  );
  assert(r.code === 0, `expected 0, got ${r.code}\nstderr: ${r.stderr}`);
});

// --- Summary ---

if (failed > 0) {
  process.stderr.write(`\n${failed} test(s) failed, ${passed} passed.\n`);
  process.exit(1);
}
process.stdout.write(`\n${passed} tests passed.\n`);
