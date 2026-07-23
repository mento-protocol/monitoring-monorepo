#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { load as loadYaml } from "js-yaml";
import {
  APPLY_WORKFLOWS,
  SERVICE_AND_DRIFT_WORKFLOWS,
} from "./production-infra-identity-contract-constants.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const gatePath = path.join(repositoryRoot, "scripts/agent-quality-gate.sh");
const scratchDirectory = mkdtempSync(
  path.join(os.tmpdir(), "production-identity-routing-"),
);
const changedPathsFile = path.join(scratchDirectory, "changed-paths.txt");

function qualityGatePlan(changedPath) {
  writeFileSync(changedPathsFile, `${changedPath}\n`);
  return execFileSync(
    gatePath,
    ["--changed-paths-file", changedPathsFile, "--base", "HEAD"],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        AGENT_QUALITY_ALLOW_PACKAGE_SCRIPT_CHANGES: "false",
      },
      maxBuffer: 10 * 1024 * 1024,
    },
  );
}

function assertRoutesIdentityContract(changedPath) {
  const plan = qualityGatePlan(changedPath);
  const routedCommands = plan.match(/^- pnpm tf:test \([^)]*\)$/gmu) ?? [];
  assert.equal(
    routedCommands.length,
    1,
    `${changedPath} must route exactly one pnpm tf:test command:\n${plan}`,
  );
}

function assertRoutesAgentGateSelfTest(changedPath) {
  const plan = qualityGatePlan(changedPath);
  const routedCommands =
    plan.match(/^- pnpm agent:quality-gate:test \([^)]*\)$/gmu) ?? [];
  assert.equal(
    routedCommands.length,
    1,
    `${changedPath} must route exactly one agent gate self-test:\n${plan}`,
  );
}

try {
  const ciWorkflow = loadYaml(
    readFileSync(path.join(repositoryRoot, ".github/workflows/ci.yml"), "utf8"),
  );
  const filterStep = ciWorkflow.jobs.changes.steps.find(
    (step) => step.id === "filter",
  );
  assert(filterStep, "ci.yml changes job must define the filter step");
  const filters = loadYaml(filterStep.with.filters);
  const rootScripts = filters.rootScripts;
  assert(Array.isArray(rootScripts), "ci.yml must define rootScripts paths");

  for (const requiredPattern of [
    "terraform/**",
    "aegis/terraform/**",
    "alerts/infra/**",
    "alerts/rules/**",
    "governance-watchdog/infra/**",
    ".github/workflows/**",
    "scripts/**/*.mjs",
    "scripts/**/*.sh",
  ]) {
    assert(
      rootScripts.includes(requiredPattern),
      `ci.yml rootScripts must include ${requiredPattern}`,
    );
  }

  assert.match(
    String(ciWorkflow.jobs.scripts.if),
    /needs\.changes\.outputs\.rootScripts == 'true'/u,
    "ci.yml scripts job must run when rootScripts changes",
  );
  assert(
    ciWorkflow.jobs.scripts.steps.some(
      (step) => String(step.run).trim() === "pnpm tf:test",
    ),
    "ci.yml scripts job must run pnpm tf:test",
  );

  for (const changedPath of [
    "terraform/ci-wif.tf",
    "aegis/terraform/main.tf",
    "alerts/infra/main.tf",
    "alerts/infra/scripts/common.sh",
    "alerts/rules/main.tf",
    "governance-watchdog/infra/main.tf",
    ...APPLY_WORKFLOWS,
    ...SERVICE_AND_DRIFT_WORKFLOWS,
    ".github/workflows/future-production-infra.yml",
    "scripts/production-infra-identity-contract-identity.mjs",
    "scripts/sanitize-terraform-output.sh",
    "scripts/verify-github-environment-protection.mjs",
  ]) {
    assertRoutesIdentityContract(changedPath);
  }
  assertRoutesAgentGateSelfTest(
    "scripts/production-infra-identity-contract-routing.test.mjs",
  );
} finally {
  rmSync(scratchDirectory, { recursive: true, force: true });
}

console.log("production infrastructure identity contract routing tests passed");
