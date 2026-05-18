#!/usr/bin/env node
/**
 * Fixture-driven tests for scripts/lockfile-lint.mjs.
 *
 * Each test writes a minimal synthetic pnpm-lock.yaml (and optional .npmrc /
 * pnpm-workspace.yaml) to a temp directory, then runs the script against it
 * via spawnSync. Asserts on exit code and stdout/stderr substrings.
 *
 * Run: node scripts/lockfile-lint.test.mjs
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── helpers ───────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

/**
 * @param {string} name
 * @param {() => void} fn
 */
function test(name, fn) {
  try {
    fn();
    console.log(`  [32m✔[0m ${name}`);
    passed++;
  } catch (/** @type {unknown} */ err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  [31m✖[0m ${name}`);
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

const SCRIPT = new URL("./lockfile-lint.mjs", import.meta.url).pathname;

/** A valid sha512 hash that passes the length + format check. */
const VALID_SHA512 =
  "sha512-nhCBV3quEgesuf7c7KYfperqSS14T8bYuvJ8PcLJp6znkZpFc0AuW4qBtr8eKVyPPe/8RSr7sglCWPU5eaxwKQ==";

/**
 * Builds a minimal pnpm v9 lockfile string.
 *
 * @param {Array<{name: string, integrity?: string}>} pkgs
 * @returns {string}
 */
function makeLockfile(pkgs) {
  const entries = pkgs
    .map(({ name, integrity }) => {
      const res = integrity
        ? `    resolution: {integrity: ${integrity}}`
        : `    resolution: {}`;
      return `\n  ${name}:\n${res}\n`;
    })
    .join("");

  return (
    `lockfileVersion: '9.0'\n\nimporters:\n\n  .:` +
    `\n    devDependencies:\n      typescript:\n        specifier: ^5.0.0\n        version: 5.0.0\n` +
    `\npackages:\n${entries}\nsnapshots:\n\n  typescript@5.0.0: {}\n`
  );
}

/**
 * Run the lockfile-lint script in a temp directory.
 *
 * @param {string} lockfileContent
 * @param {Record<string, string>} [extraFiles]  rel-path → content
 * @returns {{ exitCode: number; stdout: string; stderr: string }}
 */
function run(lockfileContent, extraFiles = {}) {
  const dir = mkdtempSync(join(tmpdir(), "lockfile-lint-test-"));
  try {
    writeFileSync(join(dir, "pnpm-lock.yaml"), lockfileContent, "utf8");
    // Minimal pnpm-workspace.yaml (no registries: block).
    if (!extraFiles["pnpm-workspace.yaml"]) {
      writeFileSync(
        join(dir, "pnpm-workspace.yaml"),
        "packages:\n  - shared-config\n",
        "utf8",
      );
    }
    for (const [rel, content] of Object.entries(extraFiles)) {
      const abs = join(dir, rel);
      mkdirSync(/** @type {string} */ (abs.split("/").slice(0, -1).join("/")), {
        recursive: true,
      });
      writeFileSync(abs, content, "utf8");
    }
    const result = spawnSync(process.execPath, [SCRIPT], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, LOCKFILE_LINT_ROOT: dir },
    });
    return {
      exitCode: result.status ?? 1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── tests ─────────────────────────────────────────────────────────────────────

console.log("\nlockfile-lint.mjs fixture tests\n");

// 1. Happy path — single valid package.
test("passes for a valid lockfile with sha512 integrity", () => {
  const { exitCode, stdout } = run(
    makeLockfile([{ name: "typescript@5.0.0", integrity: VALID_SHA512 }]),
  );
  assert(exitCode === 0, `Expected exit 0, got ${exitCode}`);
  assert(stdout.includes("valid sha512"), `stdout: ${stdout}`);
  assert(stdout.includes("passed"), `stdout: ${stdout}`);
});

// 2. Multiple packages all valid.
test("passes for multiple packages all with valid sha512", () => {
  const { exitCode } = run(
    makeLockfile([
      { name: "typescript@5.0.0", integrity: VALID_SHA512 },
      { name: "zod@3.0.0", integrity: VALID_SHA512 },
    ]),
  );
  assert(exitCode === 0, `Expected exit 0, got ${exitCode}`);
});

// 3. Missing integrity — resolution block without integrity key.
test("fails when a package has no integrity field", () => {
  const lockfile = `lockfileVersion: '9.0'\n\nimporters:\n\npackages:\n\n  typescript@5.0.0:\n    resolution: {}\n\nsnapshots:\n`;
  const { exitCode, stdout, stderr } = run(lockfile);
  assert(exitCode !== 0, `Expected non-zero exit, got ${exitCode}`);
  const out = stdout + stderr;
  assert(
    out.includes("resolution block without a sha512"),
    `expected missing-integrity error, got: ${out}`,
  );
});

// 4. Invalid integrity format — sha256 instead of sha512.
// The PKG_ENTRY regex requires "sha512-" in the integrity field, so a sha256
// hash won't match and falls through to the cross-check: totalResolutions ≠
// totalPackages. The resulting error message calls out the missing hash.
test("fails when integrity is sha256 (wrong hash type)", () => {
  const { exitCode, stderr, stdout } = run(
    makeLockfile([
      {
        name: "typescript@5.0.0",
        integrity: "sha256-abc123==",
      },
    ]),
  );
  assert(exitCode !== 0, `Expected non-zero exit, got ${exitCode}`);
  const out = stdout + stderr;
  assert(
    out.includes("resolution block without a sha512") ||
      out.includes("Invalid integrity"),
    `expected integrity error, got: ${out}`,
  );
});

// 5. Custom registry in root .npmrc.
test("fails when root .npmrc has a non-npmjs registry", () => {
  const { exitCode, stderr, stdout } = run(
    makeLockfile([{ name: "typescript@5.0.0", integrity: VALID_SHA512 }]),
    { ".npmrc": "registry=https://registry.verdaccio.local/\n" },
  );
  assert(exitCode !== 0, `Expected non-zero exit, got ${exitCode}`);
  const out = stdout + stderr;
  assert(
    out.includes("non-npmjs registry detected"),
    `expected registry error: ${out}`,
  );
});

// 6. Official registry in .npmrc — should pass.
test("passes when .npmrc sets registry=https://registry.npmjs.org", () => {
  const { exitCode } = run(
    makeLockfile([{ name: "typescript@5.0.0", integrity: VALID_SHA512 }]),
    { ".npmrc": "registry=https://registry.npmjs.org\n" },
  );
  assert(exitCode === 0, `Expected exit 0, got ${exitCode}`);
});

// 7. Official registry with trailing slash — should pass.
test("passes when .npmrc sets registry=https://registry.npmjs.org/", () => {
  const { exitCode } = run(
    makeLockfile([{ name: "typescript@5.0.0", integrity: VALID_SHA512 }]),
    { ".npmrc": "registry=https://registry.npmjs.org/\n" },
  );
  assert(exitCode === 0, `Expected exit 0, got ${exitCode}`);
});

// 8. Scoped registry pointing off-npmjs.
test("fails when .npmrc has a scoped non-npmjs registry", () => {
  const { exitCode, stderr, stdout } = run(
    makeLockfile([{ name: "typescript@5.0.0", integrity: VALID_SHA512 }]),
    { ".npmrc": "@myorg:registry=https://private.npm.myorg.com/\n" },
  );
  assert(exitCode !== 0, `Expected non-zero exit, got ${exitCode}`);
  const out = stdout + stderr;
  assert(
    out.includes("scope-specific non-npmjs registry"),
    `expected scope-registry error: ${out}`,
  );
});

// 9. pnpm-workspace.yaml with registries: block.
test("fails when pnpm-workspace.yaml has a registries: block", () => {
  const { exitCode, stderr, stdout } = run(
    makeLockfile([{ name: "typescript@5.0.0", integrity: VALID_SHA512 }]),
    {
      "pnpm-workspace.yaml":
        "packages:\n  - shared-config\nregistries:\n  default: https://private.registry.example/\n",
    },
  );
  assert(exitCode !== 0, `Expected non-zero exit, got ${exitCode}`);
  const out = stdout + stderr;
  assert(
    out.includes("registries:"),
    `expected registries block error: ${out}`,
  );
});

// 10. .npmrc with a comment — should not false-positive.
test("ignores commented-out registry lines in .npmrc", () => {
  const { exitCode } = run(
    makeLockfile([{ name: "typescript@5.0.0", integrity: VALID_SHA512 }]),
    { ".npmrc": "# registry=https://verdaccio.example.com\n" },
  );
  assert(exitCode === 0, `Expected exit 0, got ${exitCode}`);
});

// 11. Wrong lockfile version — should fail fast.
test("fails when lockfile version is not 9.x", () => {
  const { exitCode, stderr, stdout } = run(
    `lockfileVersion: '6.0'\n\npackages:\n\n  typescript@5.0.0:\n    resolution: {integrity: ${VALID_SHA512}}\n\nsnapshots:\n`,
  );
  assert(exitCode !== 0, `Expected non-zero exit, got ${exitCode}`);
  const out = stdout + stderr;
  assert(
    out.includes("Unexpected lockfile version"),
    `expected version error: ${out}`,
  );
});

// 12. Sub-package .npmrc (e.g. indexer-envio/.npmrc) is checked too.
test("fails when a sub-package .npmrc has a non-npmjs registry", () => {
  const { exitCode, stderr, stdout } = run(
    makeLockfile([{ name: "typescript@5.0.0", integrity: VALID_SHA512 }]),
    {
      "indexer-envio/.npmrc":
        "registry=https://my-private-registry.example.com/\n",
    },
  );
  assert(exitCode !== 0, `Expected non-zero exit, got ${exitCode}`);
  const out = stdout + stderr;
  assert(
    out.includes("non-npmjs registry detected"),
    `expected sub-package registry error: ${out}`,
  );
});

// 13. Missing pnpm-lock.yaml — should fail cleanly.
test("fails cleanly when pnpm-lock.yaml does not exist", () => {
  const dir = mkdtempSync(join(tmpdir(), "lockfile-lint-test-"));
  try {
    // No lockfile written — only workspace.yaml.
    writeFileSync(
      join(dir, "pnpm-workspace.yaml"),
      "packages:\n  - shared-config\n",
      "utf8",
    );
    const result = spawnSync(process.execPath, [SCRIPT], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, LOCKFILE_LINT_ROOT: dir },
    });
    const exitCode = result.status ?? 1;
    assert(exitCode !== 0, `Expected non-zero exit, got ${exitCode}`);
    const out = (result.stdout ?? "") + (result.stderr ?? "");
    assert(out.includes("not found"), `expected not-found error: ${out}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 14. Lookalike scoped registry must be rejected even though its host
// starts with `registry.npmjs.org`. Prefix-match would let it through;
// exact-canonical-host validation rejects it.
test("fails when scope-specific registry is a lookalike (registry.npmjs.org.evil.com)", () => {
  const { exitCode, stdout, stderr } = run(
    makeLockfile([{ name: "typescript@5.0.0", integrity: VALID_SHA512 }]),
    {
      ".npmrc":
        "@mento-protocol:registry=https://registry.npmjs.org.evil.com/\n",
    },
  );
  assert(exitCode !== 0, `Expected non-zero exit, got ${exitCode}`);
  const out = stdout + stderr;
  assert(
    out.includes("scope-specific non-npmjs registry"),
    `expected lookalike rejection: ${out}`,
  );
});

// 15. A nested workspace `.npmrc` deeper than any fixed allowlist
// (e.g. `tools/some-pkg/.npmrc`) must still be discovered via repo walk.
test("discovers .npmrc in any nested workspace directory", () => {
  const { exitCode, stdout, stderr } = run(
    makeLockfile([{ name: "typescript@5.0.0", integrity: VALID_SHA512 }]),
    {
      "tools/some-future-pkg/.npmrc":
        "registry=https://my-private-registry.example.com/\n",
    },
  );
  assert(exitCode !== 0, `Expected non-zero exit, got ${exitCode}`);
  const out = stdout + stderr;
  assert(
    out.includes("non-npmjs registry detected"),
    `expected nested-npmrc detection: ${out}`,
  );
});

// 16. A package entry with NO `resolution:` block at all must fail —
// neither the integrity counter nor the resolution counter would catch
// it without an explicit top-level entry count.
test("fails when a package entry has no resolution block", () => {
  // Hand-craft the lockfile so one package omits `resolution:` entirely.
  const lockfile = `lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n\npackages:\n\n  typescript@5.0.0:\n    resolution: {integrity: ${VALID_SHA512}}\n\n  no-resolution-pkg@1.0.0:\n    engines: {node: '>=18'}\n\nsnapshots:\n`;
  const { exitCode, stdout, stderr } = run(lockfile);
  assert(exitCode !== 0, `Expected non-zero exit, got ${exitCode}`);
  const out = stdout + stderr;
  assert(
    out.includes("NO resolution block"),
    `expected missing-resolution detection: ${out}`,
  );
});

// 17. pnpm v9 writes local `file:` / `link:` dependencies under `packages:`
// keyed as `<name>@file:<path>` with `resolution: {directory: ..., type:
// directory}` — no integrity hash. Those entries must be exempted from
// the integrity gate, not flagged as "resolution block without sha512".
test("passes when packages: contains a local file: dependency without integrity", () => {
  const lockfile = `lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n\npackages:\n\n  typescript@5.0.0:\n    resolution: {integrity: ${VALID_SHA512}}\n\n  internal-pkg@file:packages/internal-pkg:\n    resolution: {directory: packages/internal-pkg, type: directory}\n\nsnapshots:\n`;
  const { exitCode, stdout, stderr } = run(lockfile);
  assert(
    exitCode === 0,
    `Expected exit 0, got ${exitCode}\n${stdout}\n${stderr}`,
  );
  assert(
    stdout.includes("local file:/link:/git deps exempted") ||
      stdout.includes("registry-tarball packages"),
    `expected file-dep exemption message: ${stdout}`,
  );
});

// 18. The pnpm-workspace.yaml top-level `registry:` key (singular) is
// resolved by `pnpm config get registry --location project` and overrides
// the default registry for the whole workspace. Must be rejected when it
// points off-npmjs, same as a `.npmrc` registry= line.
test("fails when pnpm-workspace.yaml top-level registry: points off-npmjs", () => {
  const { exitCode, stdout, stderr } = run(
    makeLockfile([{ name: "typescript@5.0.0", integrity: VALID_SHA512 }]),
    {
      "pnpm-workspace.yaml":
        "packages:\n  - shared-config\nregistry: https://evil.example.com/\n",
    },
  );
  assert(exitCode !== 0, `Expected non-zero exit, got ${exitCode}`);
  const out = stdout + stderr;
  assert(
    out.includes("non-npmjs default registry"),
    `expected top-level registry rejection: ${out}`,
  );
});

// ── summary ───────────────────────────────────────────────────────────────────

console.log(
  `\n${passed + failed} tests: [32m${passed} passed[0m${failed > 0 ? `, [31m${failed} failed[0m` : ""}\n`,
);

if (failed > 0) {
  process.exit(1);
}
