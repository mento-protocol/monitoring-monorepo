#!/usr/bin/env node
/**
 * Fixture tests for scripts/check-github-action-pins.mjs.
 *
 * Run: `node scripts/check-github-action-pins.test.mjs`
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const SCRIPT = resolve("scripts/check-github-action-pins.mjs");
const PINNED_SHA = "0123456789abcdef0123456789abcdef01234567";

const tests = [];

/** @param {string} name @param {() => void} fn */
function test(name, fn) {
  tests.push({ name, fn });
}

/** @param {string} name */
function fixtureRoot(name) {
  return mkdtempSync(join(tmpdir(), `action-pin-${name}-`));
}

/** @param {string} root @param {string} path @param {string} content */
function write(root, path, content) {
  const fullPath = join(root, path);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content, "utf8");
}

/** @param {string} root */
function run(root) {
  return spawnSync(process.execPath, [SCRIPT], {
    cwd: resolve("."),
    env: { ...process.env, GITHUB_ACTION_PINS_ROOT: root },
    encoding: "utf8",
  });
}

/** @param {unknown} actual @param {unknown} expected @param {string} msg */
function equal(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg}: expected ${expected}, got ${actual}`);
  }
}

/** @param {string} haystack @param {string} needle @param {string} msg */
function contains(haystack, needle, msg) {
  if (!haystack.includes(needle)) {
    throw new Error(`${msg}: missing ${needle}\n${haystack}`);
  }
}

test("passes pinned external actions and local relative actions", () => {
  const root = fixtureRoot("pass");
  try {
    write(
      root,
      ".github/workflows/ci.yml",
      `
jobs:
  test:
    steps:
      - uses: actions/checkout@${PINNED_SHA} # v6.0.3
      - { uses: actions/cache@${PINNED_SHA} } # v5.0.5
      - uses: ./.github/actions/pnpm-install
`,
    );
    write(
      root,
      ".github/actions/pnpm-install/action.yml",
      `
runs:
  using: composite
  steps:
    - uses: 'actions/setup-node@${PINNED_SHA}' # v6.4.0
`,
    );

    const result = run(root);
    equal(result.status, 0, result.stderr);
    contains(
      result.stdout,
      "All 2 workflow/composite-action YAML files",
      "success output",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails mutable tags in workflow files", () => {
  const root = fixtureRoot("workflow-fail");
  try {
    write(
      root,
      ".github/workflows/ci.yml",
      `
jobs:
  test:
    steps:
      - uses: actions/checkout@v6
      - "uses": actions/setup-node@v4
      - uses: 'actions/cache@v4'
`,
    );

    const result = run(root);
    equal(result.status, 1, result.stdout);
    contains(
      result.stderr,
      ".github/workflows/ci.yml:5 uses: actions/checkout@v6",
      "failure location",
    );
    contains(
      result.stderr,
      ".github/workflows/ci.yml:6 uses: actions/setup-node@v4",
      "quoted key failure location",
    );
    contains(
      result.stderr,
      ".github/workflows/ci.yml:7 uses: actions/cache@v4",
      "quoted value failure location",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails mutable tags in composite actions under .github/actions", () => {
  const root = fixtureRoot("actions-fail");
  try {
    write(
      root,
      ".github/actions/pnpm-install/action.yml",
      `
runs:
  using: composite
  steps:
    - uses: actions/setup-node@v4
`,
    );

    const result = run(root);
    equal(result.status, 1, result.stdout);
    contains(
      result.stderr,
      ".github/actions/pnpm-install/action.yml:5 uses: actions/setup-node@v4",
      "failure location",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails mutable tags in composite actions under .trunk", () => {
  const root = fixtureRoot("trunk-fail");
  try {
    write(
      root,
      ".trunk/setup-ci/action.yaml",
      `
runs:
  using: composite
  steps:
    - uses: pnpm/action-setup@v4
`,
    );

    const result = run(root);
    equal(result.status, 1, result.stdout);
    contains(
      result.stderr,
      ".trunk/setup-ci/action.yaml:5 uses: pnpm/action-setup@v4",
      "failure location",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("discovers and fails mutable tags in local action targets", () => {
  const root = fixtureRoot("local-target-fail");
  try {
    write(
      root,
      ".github/workflows/ci.yml",
      `
jobs:
  test:
    steps:
      - uses: ./tools/actions/custom
`,
    );
    write(
      root,
      "tools/actions/custom/action.yml",
      `
runs:
  using: composite
  steps:
    - uses: actions/setup-node@v4
`,
    );

    const result = run(root);
    equal(result.status, 1, result.stdout);
    contains(
      result.stderr,
      "tools/actions/custom/action.yml:5 uses: actions/setup-node@v4",
      "local target failure location",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails mutable tags in flow-style workflow steps", () => {
  const root = fixtureRoot("flow-fail");
  try {
    write(
      root,
      ".github/workflows/ci.yml",
      `
jobs:
  test:
    steps:
      - { uses: actions/checkout@v6 }
      - { uses: actions/cache@v4 } # v4
`,
    );

    const result = run(root);
    equal(result.status, 1, result.stdout);
    contains(
      result.stderr,
      ".github/workflows/ci.yml:5 uses: actions/checkout@v6",
      "flow-style failure location",
    );
    contains(
      result.stderr,
      ".github/workflows/ci.yml:6 uses: actions/cache@v4",
      "commented flow-style failure location",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails pinned external actions without release-tag comments", () => {
  const root = fixtureRoot("missing-comment");
  try {
    write(
      root,
      ".github/workflows/ci.yml",
      `
jobs:
  test:
    steps:
      - uses: actions/checkout@${PINNED_SHA}
`,
    );

    const result = run(root);
    equal(result.status, 1, result.stdout);
    contains(
      result.stderr,
      `.github/workflows/ci.yml:5 uses: actions/checkout@${PINNED_SHA}`,
      "missing comment failure location",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails missing refs and short SHAs", () => {
  const root = fixtureRoot("bad-ref");
  try {
    write(
      root,
      ".github/workflows/ci.yml",
      `
jobs:
  test:
    steps:
      - uses: actions/cache
      - uses: actions/setup-node@0123456789abcdef
`,
    );

    const result = run(root);
    equal(result.status, 1, result.stdout);
    contains(result.stderr, "uses: actions/cache", "missing ref");
    contains(
      result.stderr,
      "uses: actions/setup-node@0123456789abcdef",
      "short ref",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

let failures = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failures++;
    console.error(`not ok - ${name}`);
    console.error(error instanceof Error ? error.stack : String(error));
  }
}

if (failures > 0) {
  process.exit(1);
}

console.log(`\n${tests.length} github action pin tests passed.`);
