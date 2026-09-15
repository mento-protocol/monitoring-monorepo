#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { load as loadYaml } from "js-yaml";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const terraformRegistry = JSON.parse(
  readFileSync(path.join(repositoryRoot, "terraform.stacks.json"), "utf8"),
);
const terraformStackPaths = terraformRegistry.stacks.map((stack) => stack.path);
const terraformWorkflowAdmissionPatterns =
  terraformRegistry.workflowAdmissionPatterns;
// Documented nested admission entries. `.github/workflows/**` is a directory
// the registry names file-by-file; the `scripts/` entries replace the former
// `scripts/**` boundary, which admitted 76% of first-parent `main` commits
// since 2026-08-12 while the registry routed 29%; these six admit 40%.
// Each entry must cover at least one stack changedPathPatterns entry; the
// subsumption assertion below proves coverage the other way only, so adding
// an entry here is a reviewed registration, not a checked one (issue #2406).
const NESTED_ADMISSION_EXCEPTIONS = new Set([
  ".github/workflows/**",
  "scripts/alerts/**",
  "scripts/lib/**",
  "scripts/production-infra-identity-contract/**",
  "scripts/terraform/**",
  "scripts/tf-stacks.mjs",
  "scripts/tf-stacks.test.mjs",
]);

function parseSimplePathPattern(pattern) {
  assert.equal(typeof pattern, "string", "path patterns must be strings");
  assert(pattern.length > 0, "path patterns must not be empty");
  const recursive = pattern.endsWith("/**");
  const base = recursive ? pattern.slice(0, -3) : pattern;
  assert(base.length > 0, `path pattern must name a base path: ${pattern}`);
  assert(
    !/[*?{}[\]]/u.test(base),
    `path pattern uses an unsupported glob shape: ${pattern}`,
  );
  return { base, recursive };
}

function admissionPatternSubsumes(admissionPattern, registryPattern) {
  const admission = parseSimplePathPattern(admissionPattern);
  const candidate = parseSimplePathPattern(registryPattern);
  if (!admission.recursive) {
    return !candidate.recursive && admission.base === candidate.base;
  }
  return (
    candidate.base === admission.base ||
    candidate.base.startsWith(`${admission.base}/`)
  );
}

function uncoveredRegistryPatterns(stacks, admissionPatterns) {
  return stacks.flatMap((stack) =>
    stack.changedPathPatterns
      .filter(
        (registryPattern) =>
          !admissionPatterns.some((admissionPattern) =>
            admissionPatternSubsumes(admissionPattern, registryPattern),
          ),
      )
      .map((pattern) => ({ pattern, stackId: stack.id })),
  );
}

function assertBroadAdmissionPatterns(patterns) {
  assert(Array.isArray(patterns), "workflowAdmissionPatterns must be an array");
  assert(patterns.length > 0, "workflowAdmissionPatterns must not be empty");
  assert.equal(
    new Set(patterns).size,
    patterns.length,
    "workflowAdmissionPatterns must not contain duplicates",
  );
  for (const pattern of patterns) {
    assert.notEqual(
      pattern,
      ".github/**",
      "workflow admission must not admit all .github metadata",
    );
    const parsed = parseSimplePathPattern(pattern);
    const isRootFile = !parsed.recursive && !parsed.base.includes("/");
    const isTopLevelBoundary = parsed.recursive && !parsed.base.includes("/");
    assert(
      isRootFile ||
        isTopLevelBoundary ||
        NESTED_ADMISSION_EXCEPTIONS.has(pattern),
      `workflow admission must use a top-level boundary, documented nested exception, or root file: ${pattern}`,
    );
  }
}

{
  assertBroadAdmissionPatterns(terraformWorkflowAdmissionPatterns);
  assert.deepEqual(
    uncoveredRegistryPatterns(
      terraformRegistry.stacks,
      terraformWorkflowAdmissionPatterns,
    ),
    [],
    "every stack changedPathPatterns entry must fit the workflow admission boundary",
  );
  assert.equal(
    admissionPatternSubsumes("scripts/**", "scripts/tf-stacks.mjs"),
    true,
    "recursive workflow admission must cover a nested literal",
  );
  assert.equal(
    admissionPatternSubsumes("alerts/**", "alerts/rules/**"),
    true,
    "recursive workflow admission must cover a nested recursive pattern",
  );
  assert.equal(
    admissionPatternSubsumes("alerts/rules/**", "alerts/**"),
    false,
    "a narrow recursive admission must not cover its parent pattern",
  );
  assert.throws(
    () => assertBroadAdmissionPatterns(["metrics-bridge/peg-registry.json"]),
    /top-level boundary/u,
    "workflow admission must reject nested one-file enumeration",
  );
  assert.throws(
    () => assertBroadAdmissionPatterns(["alerts/rules/**"]),
    /top-level boundary/u,
    "workflow admission must reject nested stack-specific recursion",
  );
  assert.throws(
    () => assertBroadAdmissionPatterns([".github/**"]),
    /must not admit all \.github metadata/u,
    "workflow admission must reject unrelated GitHub metadata",
  );
  assert.doesNotThrow(
    () => assertBroadAdmissionPatterns([".github/workflows/**"]),
    "workflow admission must allow the documented workflow-directory exception",
  );
  assert.deepEqual(
    uncoveredRegistryPatterns(
      terraformRegistry.stacks,
      terraformWorkflowAdmissionPatterns.filter(
        (pattern) => pattern !== "metrics-bridge/**",
      ),
    ),
    [
      {
        pattern: "metrics-bridge/peg-registry.json",
        stackId: "peg-policy-publication",
      },
    ],
    "removing a workflow boundary must expose the registry path it strands",
  );
  assert.deepEqual(
    uncoveredRegistryPatterns(
      [
        {
          id: "future-stack",
          changedPathPatterns: ["future-root/input.json"],
        },
      ],
      terraformWorkflowAdmissionPatterns,
    ),
    [{ pattern: "future-root/input.json", stackId: "future-stack" }],
    "a future registry root must fail until workflow admission covers it",
  );

  const ciWorkflow = loadYaml(
    readFileSync(path.join(repositoryRoot, ".github/workflows/ci.yml"), "utf8"),
  );
  const ciTriggers = ciWorkflow.on ?? ciWorkflow[true];
  for (const eventName of ["pull_request", "push"]) {
    const trigger = ciTriggers[eventName];
    assert(trigger, `ci.yml must define the ${eventName} trigger`);
    assert.equal(
      trigger.paths,
      undefined,
      `required ci.yml ${eventName} trigger must not use paths`,
    );
    assert.equal(
      trigger["paths-ignore"],
      undefined,
      `required ci.yml ${eventName} trigger must not use paths-ignore`,
    );
  }
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

  // This filter decides whether registry classification runs. The registry
  // owns the boundary, and every stack-specific path must fit it.
  assert.deepEqual(
    filters.terraform,
    terraformWorkflowAdmissionPatterns,
    "ci.yml terraform filter must equal terraform.stacks.json workflowAdmissionPatterns",
  );
  assert.deepEqual(
    uncoveredRegistryPatterns(terraformRegistry.stacks, filters.terraform),
    [],
    "ci.yml terraform filter must admit every stack changedPathPatterns entry",
  );
  assert.equal(
    ciWorkflow.jobs.changes.outputs.terraform,
    "${{ steps.filter.outputs.terraform }}",
    "ci.yml changes job must publish the Terraform admission result",
  );
  const terraformJob = ciWorkflow.jobs.terraform;
  assert(terraformJob, "ci.yml must define the Terraform validation job");
  assert.equal(
    terraformJob.needs,
    "changes",
    "ci.yml Terraform validation must depend on change detection",
  );
  assert.equal(
    terraformJob.if,
    "needs.changes.outputs.forceAll == 'true' || needs.changes.outputs.terraform == 'true'",
    "ci.yml Terraform validation must use the fail-closed fallback or registry-backed admission result",
  );
  const ciValidateChangedStacks = terraformJob.steps.find(
    (step) => step.name === "Validate changed stacks",
  );
  assert(
    ciValidateChangedStacks,
    "ci.yml Terraform validation must classify and validate changed stacks",
  );
  assert.match(
    String(ciValidateChangedStacks.run),
    /scripts\/tf-stacks\.mjs changed/u,
    "ci.yml Terraform validation must classify stacks through the registry",
  );
  assert.match(
    String(ciValidateChangedStacks.run),
    /scripts\/tf-stacks\.mjs validate/u,
    "ci.yml Terraform validation must validate each classified stack",
  );
  assert.match(
    String(ciValidateChangedStacks.run),
    /GITHUB_STEP_SUMMARY/u,
    "ci.yml Terraform validation must publish the per-stack summary table",
  );
  assert.match(
    String(ciValidateChangedStacks.run),
    /failed=1/u,
    "ci.yml Terraform validation must collect every failing stack instead of stopping at the first",
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
      (step) => step.uses === "$/.github/actions/pnpm-install",
    ),
    "production-infra-contract must install dependencies locally",
  );
  const productionInfraValidatorIndex = productionInfraContract.steps.findIndex(
    (step) =>
      String(step.run).trim() ===
      "node scripts/check-agent-quality-gate-package-scripts.mjs",
  );
  const productionInfraInstallIndex = productionInfraContract.steps.findIndex(
    (step) => step.uses === "$/.github/actions/pnpm-install",
  );
  assert.equal(
    productionInfraValidatorIndex,
    productionInfraInstallIndex - 1,
    "production-infra-contract must validate trusted package scripts immediately before dependency installation and package aliases",
  );
  assert(
    productionInfraContract.steps.some(
      (step) => String(step.run).trim() === "pnpm tf:test",
    ),
    "production-infra-contract must run pnpm tf:test",
  );
  assert.deepEqual(
    productionInfraContract.steps.filter(
      (step) => String(step.run).trim() === "pnpm issue:board:test",
    ),
    [
      {
        name: "Issue board owner-mutation confinement contract",
        if: "${{ !cancelled() }}",
        run: "pnpm issue:board:test",
      },
    ],
    "production-infra-contract must run the issue-board owner-mutation proof after ordinary step failures",
  );
  assert(
    ciWorkflow.jobs.ci.needs.includes("production-infra-contract"),
    "ci sentinel must require production-infra-contract",
  );
  assert(
    ciWorkflow.jobs.ci.needs.includes("terraform"),
    "ci sentinel must include the Terraform validation job",
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
}

console.log("production infrastructure identity contract routing tests passed");
