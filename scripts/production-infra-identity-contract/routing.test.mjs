#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { load as loadYaml } from "js-yaml";
import { APPLY_WORKFLOWS, SERVICE_AND_DRIFT_WORKFLOWS } from "./constants.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const terraformStackPaths = JSON.parse(
  readFileSync(path.join(repositoryRoot, "terraform.stacks.json"), "utf8"),
).stacks.map((stack) => stack.path);
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
    ...terraformStackPaths.map((stackPath) => `${stackPath}/**`),
    ".github/workflows/**",
    "scripts/**/*.mjs",
    "scripts/**/*.sh",
    "aegis/bin/deploy.sh",
    "aegis/grafana-agent/deploy.sh",
    "aegis/grafana-agent/cloudbuild.yaml",
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
  const productionInfraContract = ciWorkflow.jobs["production-infra-contract"];
  assert(
    productionInfraContract,
    "ci.yml must define the production-infra-contract job",
  );
  assert.equal(
    productionInfraContract.if,
    undefined,
    "production-infra-contract must not be path-filtered or skipped",
  );
  assert.deepEqual(
    productionInfraContract.permissions,
    { contents: "read", actions: "read" },
    "production-infra-contract must keep the PR-head test job read-only",
  );
  assert(
    productionInfraContract.steps.some(
      (step) =>
        step.uses ===
          "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1" &&
        step.with?.["persist-credentials"] === false,
    ),
    "production-infra-contract must use credential-free pinned checkout",
  );
  assert(
    productionInfraContract.steps.some(
      (step) => step.uses === "./.github/actions/pnpm-install",
    ),
    "production-infra-contract must install dependencies locally",
  );
  assert(
    productionInfraContract.steps.some(
      (step) => String(step.run).trim() === "pnpm tf:test",
    ),
    "production-infra-contract must run pnpm tf:test",
  );
  assert(
    ciWorkflow.jobs.ci.needs.includes("production-infra-contract"),
    "ci sentinel must require production-infra-contract",
  );
  const allGreenStep = ciWorkflow.jobs.ci.steps.find((step) =>
    step.uses?.startsWith("re-actors/alls-green@"),
  );
  assert(allGreenStep, "ci sentinel must use the all-green aggregation step");
  assert(
    !String(allGreenStep.with?.["allowed-skips"] ?? "").includes(
      "production-infra-contract",
    ),
    "ci sentinel must not allow production-infra-contract to skip",
  );

  for (const changedPath of [
    ...terraformStackPaths.map((stackPath) => `${stackPath}/contract-probe.tf`),
    "alerts/infra/scripts/common.sh",
    "terraform.stacks.json",
    ...APPLY_WORKFLOWS,
    ...SERVICE_AND_DRIFT_WORKFLOWS,
    ".github/workflows/future-production-infra.yml",
    "scripts/production-infra-identity-contract/identity.mjs",
    "scripts/sanitize-terraform-output.sh",
    "scripts/verify-github-environment-protection.mjs",
    "aegis/bin/deploy.sh",
    "aegis/grafana-agent/deploy.sh",
    "aegis/grafana-agent/cloudbuild.yaml",
  ]) {
    assertRoutesIdentityContract(changedPath);
  }
  assertRoutesAgentGateSelfTest(
    "scripts/production-infra-identity-contract/routing.test.mjs",
  );
} finally {
  rmSync(scratchDirectory, { recursive: true, force: true });
}

console.log("production infrastructure identity contract routing tests passed");
