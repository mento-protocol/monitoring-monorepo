#!/usr/bin/env node
/**
 * Focused regression tests for scripts/code-health-history.mjs markdown output.
 */

import { fmtRow } from "./code-health-history.mjs";

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    process.stdout.write(`✓ ${name}\n`);
    passed += 1;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`✗ ${name}\n  ${msg}\n`);
    failed += 1;
  }
}

function assertEqual(actual, expected) {
  if (actual !== expected) {
    throw new Error(
      `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

test("fmtRow escapes pipes and newlines in every table cell", () => {
  assertEqual(
    fmtRow(["rank|1", "Alice\nBob", "src/a|b.ts\r\nnext"]),
    "| rank\\|1 | Alice<br>Bob | src/a\\|b.ts<br>next |",
  );
});

test("fmtRow stringifies non-string cells before escaping", () => {
  assertEqual(fmtRow([1, 42, "ok|yes"]), "| 1 | 42 | ok\\|yes |");
});

if (failed > 0) {
  process.stderr.write(`\n${failed} failed, ${passed} passed\n`);
  process.exit(1);
}

process.stdout.write(`\n${passed} passed\n`);
