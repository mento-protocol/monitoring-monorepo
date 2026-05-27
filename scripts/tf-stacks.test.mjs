#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const script = path.join(repoRoot, "scripts/tf-stacks.mjs");

function run(args) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(
      `tf-stacks ${args.join(" ")} failed:\n${result.stderr}\n${result.stdout}`,
    );
  }
  return result.stdout;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const registry = JSON.parse(run(["list", "--json"]));
const stackIds = registry.stacks.map((stack) => stack.id);
assert(
  JSON.stringify(stackIds) ===
    JSON.stringify(["platform", "alerts-rules", "alerts-delivery", "aegis"]),
  `unexpected stack ids: ${stackIds.join(", ")}`,
);

for (const stack of registry.stacks) {
  assert(
    stack.path && stack.state?.prefix && Array.isArray(stack.providers),
    `invalid stack: ${stack.id}`,
  );
  assert(
    stack.changedPathPatterns.includes("terraform.stacks.json"),
    `${stack.id} must react to registry edits`,
  );
  assert(
    stack.changedPathPatterns.includes("scripts/tf-stacks.mjs"),
    `${stack.id} must react to wrapper edits`,
  );
}

const tempDir = mkdtempSync(path.join(tmpdir(), "tf-stacks-test-"));
try {
  const pathsFile = path.join(tempDir, "paths.txt");

  writeFileSync(pathsFile, "alerts/rules/rules-fpmms.tf\n");
  let matrix = JSON.parse(
    run(["changed", "--paths-file", pathsFile, "--json"]),
  );
  assert(
    matrix.include.length === 1,
    "alerts/rules change should map to one stack",
  );
  assert(
    matrix.include[0].id === "alerts-rules",
    "alerts/rules change should map to alerts-rules",
  );

  writeFileSync(pathsFile, "terraform.stacks.json\n");
  matrix = JSON.parse(run(["changed", "--paths-file", pathsFile, "--json"]));
  assert(
    matrix.include.length === 4,
    "registry change should validate every stack",
  );

  writeFileSync(pathsFile, "docs/terraform.md\n");
  matrix = JSON.parse(run(["changed", "--paths-file", pathsFile, "--json"]));
  assert(
    matrix.include.length === 0,
    "docs-only Terraform overview should not run Terraform validate",
  );
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

console.log("tf-stacks tests passed");
