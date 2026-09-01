#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";

import { isMapping, workflowJobSteps } from "../lib/workflow-yaml.mjs";

const DISPATCH = ".github/workflows/no-skip-audit.yml";
const CI = ".github/workflows/ci.yml";
const PNPM = ".github/actions/pnpm-install/action.yml";
const BASELINE = ".github/actions/resolve-eslint-baseline/action.yml";
// prettier-ignore
const CHECKOUT = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1", ALLS_GREEN = "re-actors/alls-green@b5b5b37504aa4183270bd3d855c52a67f212be35";
// prettier-ignore
const PNPM_ACTION = "$/.github/actions/pnpm-install", BASELINE_ACTION = "$/.github/actions/resolve-eslint-baseline";
// prettier-ignore
const AUDIT_SOURCE = "${{ inputs.no_skip_audit && inputs.audit_source_sha || github.sha }}", FULL_FETCH = "${{ inputs.no_skip_audit && '0' || '1' }}", CACHE_OFF = "${{ !inputs.no_skip_audit }}";
// prettier-ignore
const AUDIT_BASE = "${{ inputs.no_skip_audit && inputs.audit_base_sha || 'origin/main' }}", PR_OR_AUDIT = "github.event_name == 'pull_request' || inputs.no_skip_audit";
// prettier-ignore
const TRUST_REASON = "# GitHub resolves $/ from the running commit; actionlint lacks support.", CHECKOV_REASON = "# checkov:skip=CKV_GHA_7: inputs select immutable source and base objects after protected-main admission.";
// prettier-ignore
const FORCE_ALL = "${{ inputs.no_skip_audit || steps.filter.outputs.controlPlane == 'true' || steps.filter.outputs.all_count != steps.filter.outputs.routed_count || steps.filter.outputs.all_count != steps.filter.outputs.ordinary_count || (github.event_name == 'pull_request' && github.event.pull_request.changed_files >= 3000) }}";
// prettier-ignore
const CODECOV_IF = "${{ !inputs.no_skip_audit && !startsWith(github.event.pull_request.head.ref, 'sentry-autofix/') }}", WRITE_CACHE = "${{ !inputs.no_skip_audit && github.event_name == 'push' && github.ref == 'refs/heads/main' }}";
// prettier-ignore
const READ_SCOPES = Object.freeze({ actions: "read", contents: "read", "pull-requests": "read" });
// prettier-ignore
const ADMISSION_HASH = "4d7f93bcbbd354c4ade518fb9db9c36e211f5d9af39d5bc62ccfa8b8b52bdc3e", SUMMARY_HASH = "23691af2c65d242efe88a75d9ff73f55a9baf78fc2bd38fcc04e2956992e1f5e", BASELINE_HASH = "467641beda8b2b45d49d0c62429d8e95f62b05c1db96f6665b106012a09cef12";

// prettier-ignore
const DISPATCH_INPUTS = {
  pr_number: { description: "Open same-repository pull request number", required: true, type: "string" },
  source_sha: { description: "Full immutable pull request head SHA", required: true, type: "string" },
  base_sha: { description: "Full immutable protected main SHA recorded by the pull request", required: true, type: "string" },
};
// prettier-ignore
const CALL_INPUTS = {
  no_skip_audit: { description: "Run every deterministic job from the protected no-skip caller", required: false, default: false, type: "boolean" },
  audit_source_sha: { description: "Admitted immutable candidate SHA", required: false, default: "", type: "string" },
  audit_base_sha: { description: "Admitted immutable protected-main SHA", required: false, default: "", type: "string" },
};

// prettier-ignore
const stable = (value) => JSON.stringify(value, (_key, item) => isMapping(item) ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
// prettier-ignore
const hash = (value) => createHash("sha256").update(String(value ?? "")).digest("hex");
// prettier-ignore
const expression = (value) => String(value ?? "").replace(/^\$\{\{\s*/u, "").replace(/\s*\}\}$/u, "").trim();
const add = (errors, valid, message) => {
  if (!valid) errors.push(message);
};
const yaml = (root, path) => load(readFileSync(join(root, path), "utf8"));
// prettier-ignore
const stepsOf = (workflow) => Object.entries(workflow.jobs ?? {}).flatMap(([job, value]) => workflowJobSteps(value).map((step) => [job, step]));

// prettier-ignore
export function auditAggregateViolations(results, expected) {
  const errors = [];
  for (const name of Object.keys(results)) if (!expected.includes(name)) errors.push(`unexpected job: ${name}`);
  for (const name of expected) {
    if (!(name in results)) { errors.push(`missing job: ${name}`); continue; }
    const result = typeof results[name] === "string" ? results[name] : results[name]?.result;
    if (result !== "success") errors.push(`invalid job result: ${name}=${String(result)}`);
  }
  return errors;
}

// prettier-ignore
function checkDispatcher(root, errors) {
  const raw = readFileSync(join(root, DISPATCH), "utf8"), workflow = yaml(root, DISPATCH);
  add(errors, raw.includes(`workflow_dispatch:\n    ${CHECKOV_REASON}\n    inputs:`), "dispatch inputs need the narrow protected-admission Checkov exception");
  add(errors, raw.includes(`${TRUST_REASON}\n    # trunk-ignore(actionlint/workflow-call)\n    uses: $/.github/workflows/ci.yml`) && (raw.match(/trunk-ignore\(actionlint\//gu) ?? []).length === 1, "protected workflow call needs only its line-scoped actionlint exception");
  add(errors, workflow.name === "No-skip audit" && workflow["run-name"] === "No-skip audit PR #${{ inputs.pr_number }} at ${{ inputs.source_sha }}", "no-skip audit identity changed");
  add(errors, stable(workflow.on) === stable({ workflow_dispatch: { inputs: DISPATCH_INPUTS } }), "no-skip audit must expose only the three manual immutable inputs");
  add(errors, workflow.permissions === "read-all", "no-skip audit workflow must remain read-only");
  add(errors, workflow.concurrency === undefined, "no-skip dispatcher must omit redundant concurrency");
  add(errors, Object.keys(workflow.jobs ?? {}).join() === "admit,audit", "no-skip audit must contain only admission and reusable-CI jobs");
  const admit = workflow.jobs?.admit ?? {};
  add(errors, Object.keys(admit).sort().join() === "name,permissions,runs-on,steps,timeout-minutes" && admit["runs-on"] === "blacksmith-2vcpu-ubuntu-2404-arm" && admit["timeout-minutes"] === 5 && stable(admit.permissions) === stable({ contents: "read", "pull-requests": "read" }), "admission job runtime or authority changed");
  const [validate, checkout, summary] = admit.steps ?? [];
  add(errors, admit.steps?.length === 3 && validate?.uses === "actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3" && stable(validate.env) === stable({ PR_NUMBER: "${{ inputs.pr_number }}", SOURCE_SHA: "${{ inputs.source_sha }}", BASE_SHA: "${{ inputs.base_sha }}" }) && Object.keys(validate.with ?? {}).join() === "script" && hash(validate.with?.script) === ADMISSION_HASH, "immutable PR admission script changed");
  add(errors, checkout?.uses === CHECKOUT && stable(checkout.with) === stable({ ref: "${{ inputs.source_sha }}", "fetch-depth": 0, "persist-credentials": false }), "admission must check out the exact source with full history and no credentials");
  add(errors, summary?.shell === "bash" && stable(summary.env) === stable({ SOURCE_SHA: "${{ inputs.source_sha }}", BASE_SHA: "${{ inputs.base_sha }}", PR_NUMBER: "${{ inputs.pr_number }}" }) && hash(summary.run) === SUMMARY_HASH, "admission object proof or operational summary changed");
  const audit = workflow.jobs?.audit ?? {};
  add(errors, stable(audit) === stable({ name: "Full deterministic no-skip audit", needs: "admit", permissions: READ_SCOPES, uses: "$/.github/workflows/ci.yml", with: { no_skip_audit: true, audit_source_sha: "${{ inputs.source_sha }}", audit_base_sha: "${{ inputs.base_sha }}" } }), "audit job must depend on admission and call protected CI with exact inputs");
  add(errors, !stable(workflow).includes("secrets") && !stable(workflow).includes("write"), "no-skip caller must not receive secrets or write authority");
}

// prettier-ignore
function checkCandidateGraph(root, errors) {
  const raw = readFileSync(join(root, CI), "utf8"), ci = yaml(root, CI), call = ci.on?.workflow_call ?? {};
  add(errors, stable(call.inputs) === stable(CALL_INPUTS) && stable(call.secrets) === stable({ CODECOV_TOKEN: { description: "Optional upload token for ordinary reusable calls", required: false } }), "reusable CI audit inputs or optional Codecov secret changed");
  add(errors, stable(ci.concurrency) === stable({ group: "${{ inputs.no_skip_audit && format('ci-no-skip-{0}', github.run_id) || format('{0}-{1}', github.workflow, github.event_name == 'pull_request' && github.ref || github.sha) }}", "cancel-in-progress": "${{ !inputs.no_skip_audit }}" }), "reusable CI must keep audit runs independent");
  add(errors, ci.jobs?.changes?.outputs?.forceAll === FORCE_ALL, "audit mode must force every routed job");
  const changesCheckout = workflowJobSteps(ci.jobs?.changes).filter((step) => String(step.uses ?? "").startsWith("actions/checkout@"));
  const filter = workflowJobSteps(ci.jobs?.changes).find((step) => step.id === "filter");
  add(errors, changesCheckout.length === 1 && changesCheckout[0].uses === CHECKOUT && changesCheckout[0].if === CACHE_OFF && stable(changesCheckout[0].with) === stable({ "persist-credentials": false }) && filter?.if === CACHE_OFF, "audit must bypass mutable change selection and force every routed job");
  const caller = yaml(root, DISPATCH).jobs?.audit ?? {}, allowedScopes = new Set(Object.keys(READ_SCOPES));
  add(errors, stable(ci.permissions) === stable(READ_SCOPES) && stable(caller.permissions) === stable(READ_SCOPES), "no-skip caller and reusable CI permission ceilings must match exact read-only scopes");
  add(errors, Object.values(ci.jobs ?? {}).every((job) => isMapping(job.permissions) && Object.keys(job.permissions).length > 0 && Object.entries(job.permissions).every(([scope, access]) => allowedScopes.has(scope) && access === "read")), "every reusable CI job must keep explicit narrow read-only permissions");
  const candidateJobs = Object.entries(ci.jobs ?? {}).filter(([name]) => !["changes", "ci"].includes(name));
  for (const [name, job] of candidateJobs) {
    const list = workflowJobSteps(job), checkouts = list.filter((step) => String(step.uses ?? "").startsWith("actions/checkout@")), checkout = checkouts[0];
    const allowedCheckoutKeys = new Set(["ref", "fetch-depth", "persist-credentials", "submodules"]);
    add(errors, checkouts.length === 1 && list[0] === checkout && checkout.uses === CHECKOUT && checkout.with?.ref === AUDIT_SOURCE && checkout.with?.["persist-credentials"] === false && [0, FULL_FETCH].includes(checkout.with?.["fetch-depth"]) && Object.keys(checkout.with ?? {}).every((key) => allowedCheckoutKeys.has(key)), `${name} must first check out the exact candidate with full audit history`);
    if (job.needs === "changes") add(errors, String(job.if ?? "").startsWith("needs.changes.outputs.forceAll == 'true'"), `${name} can skip during a no-skip audit`);
  }
  const expectedNeeds = ["changes", ...candidateJobs.map(([name]) => name)].sort();
  add(errors, stable([...(ci.jobs?.ci?.needs ?? [])].sort()) === stable(expectedNeeds), "audit aggregate does not need every fixed CI job");
  const gates = workflowJobSteps(ci.jobs?.ci).filter((step) => String(step.uses ?? "").startsWith("re-actors/alls-green@"));
  const ordinary = gates.find((step) => step.if === "${{ !inputs.no_skip_audit }}"), audit = gates.find((step) => step.if === "${{ inputs.no_skip_audit }}");
  add(errors, gates.length === 2 && gates.every((step) => step.uses === ALLS_GREEN) && ordinary?.with?.["allowed-skips"] && stable(audit) === stable({ name: "Require every no-skip job to pass", if: "${{ inputs.no_skip_audit }}", uses: ALLS_GREEN, with: { jobs: "${{ toJSON(needs) }}" } }), "audit aggregate must reject every skipped, missing, or failed job");
  const allSteps = stepsOf(ci), runs = allSteps.map(([, step]) => String(step.run ?? ""));
  add(errors, runs.every((run) => !run.includes("${{ inputs.audit_")), "audit inputs must enter shell steps through quoted environment variables");
  const selfActions = allSteps.filter(([, step]) => /(?:^\.\/|^\$\/)\.github\/actions\//u.test(String(step.uses ?? "")));
  add(errors, selfActions.length === 21 && selfActions.every(([, step]) => [PNPM_ACTION, BASELINE_ACTION].includes(step.uses)), "CI must resolve every self action from the protected running commit");
  const actionlintBindings = raw.match(/# GitHub resolves \$\/ from the running commit; actionlint lacks support\.\n\s*# trunk-ignore\(actionlint\/action\)\n\s*(?:- )?uses: \$\/\.github\/actions\//gu) ?? [];
  add(errors, actionlintBindings.length === 21 && (raw.match(/trunk-ignore\(actionlint\//gu) ?? []).length === 21, "protected self actions need only line-scoped actionlint exceptions");
  const pnpm = selfActions.filter(([, step]) => step.uses === PNPM_ACTION);
  add(errors, pnpm.length === 15 && pnpm.every(([job, step]) => stable(step.with) === stable(job === "production-infra-contract" ? { "restore-cache": CACHE_OFF, "write-cache": WRITE_CACHE } : { "restore-cache": CACHE_OFF })), "every audit pnpm install must disable persistent cache reads and writes");
}

// prettier-ignore
function checkNormalizedChecks(root, errors) {
  const ci = yaml(root, CI), allSteps = stepsOf(ci);
  const baselineCalls = allSteps.filter(([, step]) => step.uses === BASELINE_ACTION);
  add(errors, stable(baselineCalls.map(([, step]) => step.with?.["package-path"]).sort()) === stable(["aegis", "indexer-envio", "integration-probes", "metrics-bridge", "shared-config", "ui-dashboard"]) && baselineCalls.every(([, step]) => step.if === PR_OR_AUDIT && step.with?.["baseline-ref"] === AUDIT_BASE && ["false", "${{ inputs.no_skip_audit && 'false' || 'true' }}"].includes(step.with?.["fetch-main"])), "ESLint baselines must use the admitted base in audit mode");
  const baseline = yaml(root, BASELINE);
  add(errors, baseline.inputs?.["baseline-ref"]?.default === "origin/main" && baseline.runs?.steps?.[1]?.env?.BASELINE_REF === "${{ inputs.baseline-ref }}" && hash(baseline.runs?.steps?.[1]?.run) === BASELINE_HASH, "baseline action no longer reads the exact caller-owned base");
  const react = allSteps.find(([, step]) => step.name === "React Doctor (diff vs base)")?.[1];
  add(errors, react?.if === PR_OR_AUDIT && stable(react.env) === stable({ BASELINE_REF: "${{ inputs.no_skip_audit && inputs.audit_base_sha || format('origin/{0}', github.base_ref) }}" }) && react.run === "git switch -c __react_doctor_scan\npnpm --filter @mento-protocol/ui-dashboard react-doctor --diff \"$BASELINE_REF\" --fail-on warning --annotations --offline\n", "React Doctor must compare the candidate with the admitted base");
  const peg = allSteps.filter(([, step]) => step.name === "Peg registry integrity");
  add(errors, peg.length === 2 && peg.every(([, step]) => stable(step.env) === stable({ PEG_POLICY_BASE_REF: "${{ inputs.no_skip_audit && inputs.audit_base_sha || format('origin/{0}', github.base_ref || 'main') }}" }) && step.run === "node scripts/alerts/check-peg-registry-integrity.mjs"), "Peg policy lineage must use the admitted base in audit mode");
  const terraform = allSteps.find(([, step]) => step.name === "Validate changed stacks")?.[1];
  add(errors, terraform?.env?.NO_SKIP_AUDIT === "${{ inputs.no_skip_audit }}" && terraform.env?.AUDIT_BASE_SHA === "${{ inputs.audit_base_sha }}" && terraform.env?.AUDIT_SOURCE_SHA === "${{ inputs.audit_source_sha }}" && String(terraform.run).includes('changed --base "$AUDIT_BASE_SHA" --head "$AUDIT_SOURCE_SHA" --json'), "Terraform selection must compare the admitted source and base");
  const pegTerraform = allSteps.find(([, step]) => step.name === "Test Peg rule definitions")?.[1];
  add(errors, pegTerraform?.if === PR_OR_AUDIT, "PR-only Terraform tests must run in audit mode");
  const adr = allSteps.find(([, step]) => step.name === "ADR reminder")?.[1];
  add(errors, stable(adr?.env) === stable({ AGENT_QUALITY_BASE: AUDIT_BASE }) && adr?.run === "pnpm adr:check", "ADR reminder must compare with the admitted base in audit mode");
}

// prettier-ignore
function checkColdAuthority(root, errors) {
  const ci = yaml(root, CI), allSteps = stepsOf(ci);
  const codecov = allSteps.filter(([, step]) => String(step.uses ?? "").startsWith("codecov/codecov-action@"));
  add(errors, codecov.length === 9 && codecov.every(([, step]) => step.if === CODECOV_IF && step.with?.token === "${{ secrets.CODECOV_TOKEN }}"), "Codecov must remain unavailable to audit calls");
  const timeline = allSteps.filter(([, step]) => String(step.uses ?? "").startsWith("Kesin11/actions-timeline@"));
  add(errors, timeline.length === 19 && timeline.every(([, step]) => step.if === "always() && !inputs.no_skip_audit"), "post-candidate timeline actions must not run in audit mode");
  const artifacts = allSteps.filter(([, step]) => String(step.uses ?? "").startsWith("actions/upload-artifact@"));
  add(errors, artifacts.length === 1 && artifacts[0][1].if === "failure() && !inputs.no_skip_audit", "UI failure artifacts must not run in audit mode");
  const restores = allSteps.filter(([, step]) => String(step.uses ?? "").startsWith("actions/cache/restore@"));
  const saves = allSteps.filter(([, step]) => String(step.uses ?? "").startsWith("actions/cache/save@"));
  add(errors, restores.length === 1 && restores[0][1].if === CACHE_OFF && saves.length === 1 && expression(saves[0][1].if) === "!inputs.no_skip_audit && github.event_name == 'push' && github.ref == 'refs/heads/main' && steps.playwright-cache.outputs.cache-hit != 'true'", "Playwright cache reads and writes must be disabled in audit mode");
  const foundry = allSteps.filter(([, step]) => String(step.uses ?? "").startsWith("foundry-rs/foundry-toolchain@"));
  add(errors, foundry.length === 1 && foundry[0][1].with?.cache === "${{ !inputs.no_skip_audit && github.event_name == 'push' && github.ref == 'refs/heads/main' }}", "Foundry cache must be limited to protected-main pushes");
  const turbo = allSteps.find(([, step]) => step.name === "Production build and bundle-size budget")?.[1];
  add(errors, stable(turbo?.env) === stable({ TURBO_CACHE_POLICY: "${{ inputs.no_skip_audit && 'local:,remote:' || 'local:rw' }}" }) && turbo?.run === 'VERCEL_DEPLOYMENT_ID=ci pnpm exec turbo run size-limit --filter=@mento-protocol/ui-dashboard --cache="$TURBO_CACHE_POLICY"', "Turbo cache reads and writes must be disabled in audit mode");
  const pnpm = yaml(root, PNPM);
  add(errors, pnpm.inputs?.["restore-cache"]?.default === "true" && pnpm.runs?.steps?.find((step) => step.id === "pnpm-cache")?.if === "inputs.restore-cache == 'true'" && expression(pnpm.runs?.steps?.find((step) => String(step.uses ?? "").startsWith("actions/cache/save@"))?.if).startsWith("inputs.restore-cache == 'true' && inputs.write-cache == 'true'"), "protected pnpm action no longer disables both cache directions");
}

export function noSkipAuditViolations(root = process.cwd()) {
  const errors = [];
  checkDispatcher(root, errors);
  checkCandidateGraph(root, errors);
  checkNormalizedChecks(root, errors);
  checkColdAuthority(root, errors);
  return [...new Set(errors)];
}

function main() {
  const errors = noSkipAuditViolations();
  for (const error of errors) console.error(`FAIL: ${error}`);
  if (errors.length > 0) process.exitCode = 1;
  else console.log("No-skip audit contract passes.");
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main();
