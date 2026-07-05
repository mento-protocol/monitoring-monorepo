#!/usr/bin/env node
/**
 * Fixture + unit tests for scripts/override-prune-report.mjs.
 *
 * Most coverage imports the exported pure functions directly (fast, precise
 * assertions on the verdict heuristic). A couple of subprocess tests exercise
 * the CLI contract (exit code, table headers, multi-root graceful skip) the
 * same way scripts/lockfile-lint.test.mjs and
 * scripts/pnpm-audit-high-gate.test.mjs do.
 *
 * Run: node scripts/override-prune-report.test.mjs
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  compareVersions,
  evaluateExcludeEntry,
  evaluateOverride,
  extractOverridesMap,
  extractPackageInstances,
  floorFromReplacement,
  isShallowRepository,
  lineAgeDays,
  packageNameFromOverrideSelector,
  parseArgs,
  reportForRoot,
} from "./override-prune-report.mjs";

// ── helpers ──────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

/**
 * @param {string} name
 * @param {() => void} fn
 */
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

/**
 * @param {boolean} condition
 * @param {string} msg
 */
function assert(condition, msg) {
  if (!condition) throw new Error(msg);
}

const SCRIPT = new URL("./override-prune-report.mjs", import.meta.url).pathname;

/**
 * @param {{ overrides?: Record<string, string>; packages?: string[] }} opts
 */
function makeLockfile({ overrides = {}, packages = [] }) {
  const overridesLines = Object.entries(overrides)
    .map(([k, v]) => `  ${k}: ${v}`)
    .join("\n");
  const packagesLines = packages
    .map((key) => `  ${key}:\n    resolution: {integrity: sha512-x}\n`)
    .join("");
  return (
    "lockfileVersion: '9.0'\n\n" +
    "settings:\n  autoInstallPeers: true\n\n" +
    (overridesLines ? `overrides:\n${overridesLines}\n\n` : "") +
    `packages:\n${packagesLines}\nsnapshots:\n\n`
  );
}

/** @param {string} dir */
function initGitRepo(dir) {
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: dir });
}

/**
 * @param {string} dir
 * @param {string} relPath
 * @param {string} content
 * @param {number} daysAgo
 */
function commitFileAt(dir, relPath, content, daysAgo) {
  writeFileSync(join(dir, relPath), content, "utf8");
  const dateIso = new Date(Date.now() - daysAgo * 86400000).toISOString();
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
    GIT_AUTHOR_DATE: dateIso,
    GIT_COMMITTER_DATE: dateIso,
  };
  spawnSync("git", ["add", relPath], { cwd: dir, env });
  spawnSync("git", ["commit", "-q", "-m", "test"], { cwd: dir, env });
}

/**
 * @param {string} prefix
 * @param {(dir: string) => void} fn
 */
function withTempDir(prefix, fn) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("\noverride-prune-report.mjs tests\n");

// ── extractOverridesMap ──────────────────────────────────────────────────────

test("extractOverridesMap reads the flat overrides mirror block", () => {
  const text = makeLockfile({
    overrides: { esbuild: "0.28.1", "'@grpc/grpc-js'": "1.14.4" },
    packages: ["esbuild@0.28.1"],
  });
  const map = extractOverridesMap(text);
  assert(map.get("esbuild") === "0.28.1", "expected esbuild floor");
  assert(map.get("@grpc/grpc-js") === "1.14.4", "expected unquoted key");
});

test("extractOverridesMap returns empty map when section absent", () => {
  const map = extractOverridesMap(
    "lockfileVersion: '9.0'\n\npackages:\n\nsnapshots:\n",
  );
  assert(map.size === 0, "expected empty map");
});

// ── extractPackageInstances ───────────────────────────────────────────────────

test("extractPackageInstances groups scoped and unscoped package versions", () => {
  const text = makeLockfile({
    packages: ["form-data@2.5.6", "form-data@4.0.6", "'@grpc/grpc-js@1.14.4'"],
  });
  const instances = extractPackageInstances(text);
  assert(
    JSON.stringify(instances.get("form-data")) ===
      JSON.stringify(["2.5.6", "4.0.6"]),
    `expected both form-data instances, got ${JSON.stringify(instances.get("form-data"))}`,
  );
  assert(
    JSON.stringify(instances.get("@grpc/grpc-js")) ===
      JSON.stringify(["1.14.4"]),
    "expected scoped package instance",
  );
});

test("extractPackageInstances strips parenthesized peer-dependency suffixes from versions", () => {
  // pnpm package keys can carry peer suffixes (`foo@1.0.0(peer@2.0.0)`);
  // the stored version must be the bare semver, or floor comparisons break.
  const text = makeLockfile({
    packages: [
      "vite@8.0.16(@types/node@24.10.1)(yaml@2.9.0)",
      "'@angular-devkit/core@19.2.17(chokidar@4.0.3)'",
    ],
  });
  const instances = extractPackageInstances(text);
  assert(
    JSON.stringify(instances.get("vite")) === JSON.stringify(["8.0.16"]),
    `expected bare vite version, got ${JSON.stringify(instances.get("vite"))}`,
  );
  assert(
    JSON.stringify(instances.get("@angular-devkit/core")) ===
      JSON.stringify(["19.2.17"]),
    `expected bare scoped version, got ${JSON.stringify(instances.get("@angular-devkit/core"))}`,
  );
});

test("extractPackageInstances skips file:/link: local sources", () => {
  const text =
    "lockfileVersion: '9.0'\n\npackages:\n" +
    "  shared-config@file:../shared-config:\n" +
    "    resolution: {directory: ../shared-config, type: directory}\n\n" +
    "snapshots:\n\n";
  const instances = extractPackageInstances(text);
  assert(
    instances.size === 0,
    `expected no instances, got ${[...instances.keys()]}`,
  );
});

// ── packageNameFromOverrideSelector ───────────────────────────────────────────

test("packageNameFromOverrideSelector handles bare, ranged, and path-qualified selectors", () => {
  assert(
    packageNameFromOverrideSelector("esbuild") === "esbuild",
    "bare selector",
  );
  assert(
    packageNameFromOverrideSelector("body-parser@<1.20.3") === "body-parser",
    "ranged selector",
  );
  assert(
    packageNameFromOverrideSelector("@lhci/utils>js-yaml") === "js-yaml",
    "path-qualified selector",
  );
  assert(
    packageNameFromOverrideSelector("@babel/core@>=7.0.0 <7.29.6") ===
      "@babel/core",
    "scoped ranged selector",
  );
});

// ── floorFromReplacement ──────────────────────────────────────────────────────

test("floorFromReplacement extracts the version, stripping range operators", () => {
  assert(floorFromReplacement("1.20.3") === "1.20.3", "exact");
  assert(floorFromReplacement("^2.0.3") === "2.0.3", "caret range");
  assert(floorFromReplacement(">=6.14.0") === "6.14.0", "gte range");
  assert(floorFromReplacement("not-a-version") === null, "no version found");
});

// ── compareVersions ────────────────────────────────────────────────────────────

test("compareVersions orders numeric segments (not lexically)", () => {
  assert(compareVersions("10.2.4", "9.0.9") > 0, "10.x > 9.x");
  assert(compareVersions("2.1.0", "2.0.3") > 0, "2.1.0 > 2.0.3");
  assert(compareVersions("1.0.0", "1.0.0") === 0, "equal");
});

// ── evaluateOverride ───────────────────────────────────────────────────────────

test("evaluateOverride: keep when a same-major instance sits exactly at the floor", () => {
  const instances = new Map([["esbuild", ["0.28.1"]]]);
  const row = evaluateOverride("esbuild", "0.28.1", instances);
  assert(
    row.verdict === "keep",
    `expected keep, got ${row.verdict}: ${row.evidence}`,
  );
});

test("evaluateOverride: keep when the floor instance appears only via a peer-suffixed key", () => {
  // Regression: with the peer suffix left on the parsed version, the
  // exact-floor comparison ("8.0.16(@types/node@24.10.1)" !== "8.0.16")
  // misreported this active override as possible-prune.
  const text = makeLockfile({
    packages: ["vite@8.0.16(@types/node@24.10.1)(yaml@2.9.0)"],
  });
  const row = evaluateOverride(
    "vite@>=8.0.0 <8.0.16",
    "8.0.16",
    extractPackageInstances(text),
  );
  assert(
    row.verdict === "keep",
    `expected keep for a peer-suffixed floor instance, got ${row.verdict}: ${row.evidence}`,
  );
});

test("evaluateOverride: possible-prune when the package is entirely absent", () => {
  const instances = new Map();
  const row = evaluateOverride("esbuild", "0.28.1", instances);
  assert(
    row.verdict === "possible-prune",
    `expected possible-prune, got ${row.verdict}`,
  );
  assert(row.evidence.includes("no lockfile instance"), row.evidence);
});

test("evaluateOverride: possible-prune when no instance shares the floor's major", () => {
  const instances = new Map([["form-data", ["2.5.6", "4.0.6"]]]);
  const row = evaluateOverride("form-data@>=3.0.0 <3.0.5", "3.0.5", instances);
  assert(
    row.verdict === "possible-prune",
    `expected possible-prune, got ${row.verdict}`,
  );
  assert(row.evidence.includes("no same-major"), row.evidence);
});

test("evaluateOverride: possible-prune when same-major instances all resolve above an exact-pin floor", () => {
  const instances = new Map([["handlebars", ["4.7.10"]]]);
  const row = evaluateOverride("handlebars@<4.7.9", "4.7.9", instances);
  assert(
    row.verdict === "possible-prune",
    `expected possible-prune, got ${row.verdict}`,
  );
  assert(row.evidence.includes("exact-pin floor"), row.evidence);
});

test("evaluateOverride: keep (not possible-prune) when a RANGE replacement resolves above its own floor", () => {
  // A range replacement (e.g. `^10.2.3`) only forces membership in the
  // range; resolving above its minimum is the expected healthy state for an
  // override still doing active work, not evidence it's dead.
  const instances = new Map([["minimatch", ["10.2.4", "10.2.5"]]]);
  const row = evaluateOverride("minimatch@^10.0.0", "^10.2.3", instances);
  assert(
    row.verdict === "keep",
    `expected keep for a range replacement, got ${row.verdict}: ${row.evidence}`,
  );
  assert(row.evidence.includes("range floor"), row.evidence);
});

test("evaluateOverride: needs-review when a same-major instance sits below the floor", () => {
  const instances = new Map([["path-to-regexp", ["0.1.10", "8.4.2"]]]);
  const row = evaluateOverride("path-to-regexp@<0.1.13", "0.1.13", instances);
  assert(
    row.verdict === "needs-review",
    `expected needs-review, got ${row.verdict}`,
  );
  assert(row.evidence.includes("below the floor"), row.evidence);
});

test("evaluateOverride: manual-review when the replacement has no parseable version", () => {
  const instances = new Map([["foo", ["1.0.0"]]]);
  const row = evaluateOverride("foo", "false", instances);
  assert(
    row.verdict === "manual-review",
    `expected manual-review, got ${row.verdict}`,
  );
});

test("evaluateOverride: cross-major instances of the same package name don't contaminate the verdict", () => {
  // express@<4.20.0 -> 4.22.1 should ignore an unrelated express@5.x instance.
  const instances = new Map([["express", ["4.22.1", "5.1.0"]]]);
  const row = evaluateOverride("express@<4.20.0", "4.22.1", instances);
  assert(
    row.verdict === "keep",
    `expected keep, got ${row.verdict}: ${row.evidence}`,
  );
});

// ── minimumReleaseAgeExclude age check ────────────────────────────────────────

test("lineAgeDays returns null outside a git repository", () => {
  withTempDir("override-prune-report-nongit-", (dir) => {
    writeFileSync(
      join(dir, "pnpm-workspace.yaml"),
      "minimumReleaseAgeExclude:\n  - esbuild\n",
      "utf8",
    );
    const age = lineAgeDays(dir, "pnpm-workspace.yaml", 2);
    assert(age === null, `expected null, got ${age}`);
  });
});

test("lineAgeDays returns null in a shallow clone instead of a false-recent boundary-commit age", () => {
  // Regression coverage for the exact CI failure mode this heuristic must
  // avoid: actions/checkout's default fetch-depth: 1 leaves `git blame`
  // attributing every line to the boundary (HEAD) commit, which would read
  // as "just changed" for every entry. Reproduce it with a real shallow
  // clone rather than mocking git, since the bug is in git's own blame
  // behavior on truncated history.
  withTempDir("override-prune-report-shallow-origin-", (origin) => {
    initGitRepo(origin);
    commitFileAt(
      origin,
      "pnpm-workspace.yaml",
      "minimumReleaseAgeExclude:\n  - old-pkg\n",
      200,
    );
    commitFileAt(
      origin,
      "pnpm-workspace.yaml",
      "minimumReleaseAgeExclude:\n  - old-pkg\n  - newest-pkg\n",
      1,
    );

    withTempDir("override-prune-report-shallow-clone-", (parentDir) => {
      const clone = join(parentDir, "shallow");
      const cloneResult = spawnSync(
        "git",
        ["clone", "-q", "--depth", "1", `file://${origin}`, clone],
        { encoding: "utf8" },
      );
      assert(
        cloneResult.status === 0,
        `git clone --depth 1 failed: ${cloneResult.stderr}`,
      );

      assert(
        isShallowRepository(clone) === true,
        "expected the clone to be detected as shallow",
      );

      const age = lineAgeDays(clone, "pnpm-workspace.yaml", 2);
      assert(
        age === null,
        `expected null in a shallow clone (not a false-recent age), got ${age}`,
      );

      const row = evaluateExcludeEntry(
        clone,
        "pnpm-workspace.yaml",
        { value: "old-pkg", line: 2 },
        90,
      );
      assert(
        row.verdict === "unknown",
        `expected unknown verdict in a shallow clone, got ${row.verdict}`,
      );
    });
  });
});

test("evaluateExcludeEntry: unknown verdict when age can't be determined", () => {
  withTempDir("override-prune-report-nongit-", (dir) => {
    writeFileSync(
      join(dir, "pnpm-workspace.yaml"),
      "minimumReleaseAgeExclude:\n  - esbuild\n",
      "utf8",
    );
    const row = evaluateExcludeEntry(
      dir,
      "pnpm-workspace.yaml",
      { value: "esbuild", line: 2 },
      90,
    );
    assert(row.verdict === "unknown", `expected unknown, got ${row.verdict}`);
  });
});

test("evaluateExcludeEntry: recent vs stale classification via real git history", () => {
  withTempDir("override-prune-report-git-", (dir) => {
    initGitRepo(dir);
    commitFileAt(
      dir,
      "pnpm-workspace.yaml",
      "minimumReleaseAgeExclude:\n  - old-pkg\n  - untouched-pkg\n",
      200,
    );
    // Re-commit appends a new line only; blame still attributes lines 2-3 to
    // the original 200d-old commit, while line 4 is fresh at 1 day old.
    commitFileAt(
      dir,
      "pnpm-workspace.yaml",
      "minimumReleaseAgeExclude:\n  - old-pkg\n  - untouched-pkg\n  - newest-pkg\n",
      1,
    );

    const oldRow = evaluateExcludeEntry(
      dir,
      "pnpm-workspace.yaml",
      { value: "old-pkg", line: 2 },
      90,
    );
    assert(
      oldRow.verdict === "stale",
      `expected old-pkg to be 200d-old stale, got ${oldRow.verdict}`,
    );

    const newestRow = evaluateExcludeEntry(
      dir,
      "pnpm-workspace.yaml",
      { value: "newest-pkg", line: 4 },
      90,
    );
    assert(
      newestRow.verdict === "recent",
      `expected newest-pkg to be 1d-old recent, got ${newestRow.verdict}`,
    );
  });
});

// ── reportForRoot ──────────────────────────────────────────────────────────────

test("reportForRoot skips gracefully when lockfile/workspace files are missing", () => {
  withTempDir("override-prune-report-empty-", (dir) => {
    const report = reportForRoot(dir, "empty-root", 90);
    assert(report.includes("Skipped: pnpm-lock.yaml not found"), report);
    assert(report.includes("Skipped: pnpm-workspace.yaml not found"), report);
  });
});

test("reportForRoot renders both tables end-to-end for a populated root", () => {
  withTempDir("override-prune-report-full-", (dir) => {
    writeFileSync(
      join(dir, "pnpm-lock.yaml"),
      makeLockfile({
        overrides: { esbuild: "0.28.1" },
        packages: ["esbuild@0.28.1"],
      }),
      "utf8",
    );
    initGitRepo(dir);
    commitFileAt(
      dir,
      "pnpm-workspace.yaml",
      "minimumReleaseAgeExclude:\n  - esbuild\n",
      5,
    );

    const report = reportForRoot(dir, "full-root", 90);
    assert(report.includes("full-root — pnpm.overrides"), report);
    assert(report.includes("| `esbuild` | `0.28.1` | keep |"), report);
    assert(report.includes("full-root — minimumReleaseAgeExclude"), report);
    assert(report.includes("recent"), report);
  });
});

// ── parseArgs ──────────────────────────────────────────────────────────────────

test("parseArgs: default max age, custom flag, and rejects bad input", () => {
  assert(parseArgs([]).maxAgeDays === 90, "expected default 90");
  assert(
    parseArgs(["--max-age-days", "30"]).maxAgeDays === 30,
    "expected custom 30",
  );
  let threw = false;
  try {
    parseArgs(["--max-age-days", "not-a-number"]);
  } catch {
    threw = true;
  }
  assert(threw, "expected throw on invalid --max-age-days value");

  threw = false;
  try {
    parseArgs(["--bogus"]);
  } catch {
    threw = true;
  }
  assert(threw, "expected throw on unknown argument");
});

// ── CLI subprocess contract ────────────────────────────────────────────────────

/**
 * @param {string[]} args
 * @param {Record<string, string>} [env]
 */
function runCli(dir, args = []) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, OVERRIDE_PRUNE_REPORT_ROOT: dir },
  });
}

test("CLI: always exits 0 and prints per-root tables, even with needs-review verdicts", () => {
  withTempDir("override-prune-report-cli-", (dir) => {
    mkdirSync(join(dir, "alerts/infra/onchain-event-handler"), {
      recursive: true,
    });
    writeFileSync(
      join(dir, "pnpm-lock.yaml"),
      makeLockfile({
        overrides: { "path-to-regexp@<0.1.13": "0.1.13" },
        packages: ["path-to-regexp@0.1.10"],
      }),
      "utf8",
    );
    const result = runCli(dir);
    assert(
      result.status === 0,
      `expected exit 0, got ${result.status}: ${result.stderr}`,
    );
    assert(result.stdout.includes("root — pnpm.overrides"), result.stdout);
    assert(result.stdout.includes("needs-review"), result.stdout);
    assert(
      result.stdout.includes(
        "alerts/infra/onchain-event-handler — pnpm.overrides",
      ),
      "expected missing standalone root to still print a skipped section",
    );
    assert(
      result.stdout.includes("Skipped: pnpm-lock.yaml not found"),
      result.stdout,
    );
  });
});

test("CLI: --max-age-days is honored and rejects invalid values", () => {
  withTempDir("override-prune-report-cli-age-", (dir) => {
    writeFileSync(join(dir, "pnpm-lock.yaml"), makeLockfile({}), "utf8");
    initGitRepo(dir);
    commitFileAt(
      dir,
      "pnpm-workspace.yaml",
      "minimumReleaseAgeExclude:\n  - esbuild\n",
      10,
    );

    const strict = runCli(dir, ["--max-age-days", "5"]);
    assert(strict.status === 0, `expected exit 0, got ${strict.status}`);
    assert(strict.stdout.includes("stale"), strict.stdout);

    const bad = runCli(dir, ["--max-age-days", "not-a-number"]);
    assert(
      bad.status !== 0,
      "expected non-zero exit for invalid --max-age-days",
    );
  });
});

// ── summary ───────────────────────────────────────────────────────────────────

console.log(
  `\n${passed + failed} tests: \x1b[32m${passed} passed\x1b[0m${failed > 0 ? `, \x1b[31m${failed} failed\x1b[0m` : ""}\n`,
);

if (failed > 0) {
  process.exit(1);
}
