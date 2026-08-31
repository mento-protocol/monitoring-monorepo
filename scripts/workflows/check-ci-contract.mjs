#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseActionList,
  sentinelBlockers,
} from "../sentry/ci-wiring/check-sentry-suites-in-ci-core.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FORCE_ALL = "needs.changes.outputs.forceAll == 'true'";
const DORNY_PIN = "dorny/paths-filter@ceb8a2b8f2d89434be7ff52d3de7ec3738c5cc9d";
const ALLS_GREEN_PIN =
  "re-actors/alls-green@b5b5b37504aa4183270bd3d855c52a67f212be35";
// prettier-ignore
const ORDINARY = "*.md|aegis/**|alerts/**|docs/**|governance-watchdog/**|indexer-envio/**|integration-probes/**|metrics-bridge/**|terraform/**|ui-dashboard/**".split("|");
// prettier-ignore
const CONTROL_PLANE = "**/package.json|**/pnpm-lock.yaml|**/pnpm-workspace.yaml|**/.npmrc|**/tsconfig*.json|**/eslint.config.*|**/vitest*.{js,cjs,mjs,ts,cts,mts}|**/knip.json|**/react-doctor.config.json".split("|");
export const FORCE_ALL_OUTPUT =
  "${{ steps.filter.outputs.controlPlane == 'true' || steps.filter.outputs.all_count != steps.filter.outputs.routed_count || steps.filter.outputs.all_count != steps.filter.outputs.ordinary_count || (github.event_name == 'pull_request' && github.event.pull_request.changed_files >= 3000) }}";

// prettier-ignore
export const FILTER_NAMES = Object.freeze("shared|ui|indexer|bridge|integrationProbes|aegis|terraform|alerts|govWatchdog|codeHealth|rootScripts|docs|autoreviewSuite|autoreviewRootRuntime|versionSkew".split("|"));
// prettier-ignore
export const CONDITIONAL_JOBS = Object.freeze("shared|ui|indexer|bridge|integration-probes|aegis|alerts|gov-watchdog|terraform|deps|scripts|docs-checks|autoreview-suite|autoreview-root-runtime|version-skew".split("|"));

export const FIXED_JOBS = Object.freeze([
  "changes",
  ...CONDITIONAL_JOBS,
  "guardrail-prose",
  "production-infra-contract",
  "sentry-suites",
]);

const EXPECTED_CONDITIONS = Object.freeze({
  shared: `${FORCE_ALL} || needs.changes.outputs.shared == 'true'`,
  ui: `${FORCE_ALL} || needs.changes.outputs.ui == 'true'`,
  indexer: `${FORCE_ALL} || needs.changes.outputs.indexer == 'true'`,
  bridge: `${FORCE_ALL} || needs.changes.outputs.bridge == 'true'`,
  "integration-probes": `${FORCE_ALL} || needs.changes.outputs.integrationProbes == 'true'`,
  aegis: `${FORCE_ALL} || needs.changes.outputs.aegis == 'true'`,
  alerts: `${FORCE_ALL} || needs.changes.outputs.alerts == 'true'`,
  "gov-watchdog": `${FORCE_ALL} || needs.changes.outputs.govWatchdog == 'true'`,
  terraform: `${FORCE_ALL} || needs.changes.outputs.terraform == 'true'`,
  deps: `${FORCE_ALL} || needs.changes.outputs.shared == 'true' || needs.changes.outputs.ui == 'true' || needs.changes.outputs.indexer == 'true' || needs.changes.outputs.bridge == 'true' || needs.changes.outputs.integrationProbes == 'true' || needs.changes.outputs.aegis == 'true' || needs.changes.outputs.codeHealth == 'true'`,
  scripts: `${FORCE_ALL} || needs.changes.outputs.rootScripts == 'true'`,
  "docs-checks": `${FORCE_ALL} || needs.changes.outputs.docs == 'true'`,
  "autoreview-suite": `${FORCE_ALL} || needs.changes.outputs.autoreviewSuite == 'true'`,
  "autoreview-root-runtime": `${FORCE_ALL} || needs.changes.outputs.autoreviewRootRuntime == 'true'`,
  "version-skew": `${FORCE_ALL} || needs.changes.outputs.versionSkew == 'true'`,
});

// prettier-ignore
const EXPECTED_TIMEOUTS = Object.freeze({ changes: 2, shared: 10, ui: 25, indexer: 20, bridge: 10, "integration-probes": 10, alerts: 10, "gov-watchdog": 10, terraform: 10, aegis: 15, scripts: 40, "guardrail-prose": 5, "docs-checks": 10, "production-infra-contract": 5, "sentry-suites": 5, "autoreview-suite": 90, "autoreview-root-runtime": 5, "version-skew": 5, deps: 5, ci: 2 });
// prettier-ignore
const REQUIRED_COMMANDS = Object.freeze({ ui: [["VERCEL_DEPLOYMENT_ID=ci pnpm exec turbo run size-limit --filter=@mento-protocol/ui-dashboard --cache=local:rw", null]], scripts: [["node scripts/workflows/check-ci-contract.mjs", null], ["pnpm adr:check", null], ["pnpm adr:check:test", null]], "production-infra-contract": [["pnpm ci:contract:test", "${{ !cancelled() }}"]] });

function list(value) {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function setErrors(label, actual, expected) {
  const missing = expected.filter((entry) => !actual.includes(entry));
  const extra = actual.filter((entry) => !expected.includes(entry));
  return [
    ...missing.map((entry) => `${label} misses ${entry}`),
    ...extra.map((entry) => `${label} has unexpected ${entry}`),
  ];
}

export function aggregateViolations(results) {
  const errors = [];
  const allowedSkips = new Set(CONDITIONAL_JOBS);
  for (const name of Object.keys(results)) {
    if (!FIXED_JOBS.includes(name)) errors.push(`unexpected job: ${name}`);
  }
  for (const name of FIXED_JOBS) {
    if (!(name in results)) {
      errors.push(`missing job: ${name}`);
      continue;
    }
    const value = results[name];
    const result = typeof value === "string" ? value : value?.result;
    if (result === "success") continue;
    if (result === "skipped" && allowedSkips.has(name)) continue;
    errors.push(`invalid job result: ${name}=${String(result)}`);
  }
  return errors;
}

export function concurrencyGroup({ workflow = "CI", eventName, ref, sha }) {
  return `${workflow}-${eventName === "pull_request" ? ref : sha}`;
}

export async function loadCi(root = ROOT) {
  const { load } = await import("js-yaml");
  const workflow = load(
    readFileSync(join(root, ".github/workflows/ci.yml"), "utf8"),
  );
  const filterStep = workflow.jobs?.changes?.steps?.find(
    (step) => step.id === "filter",
  );
  return { workflow, filters: load(filterStep?.with?.filters ?? "") };
}

export async function matchedFiles(filters, name, changes) {
  const { default: picomatch } = await import("picomatch");
  const rules = filters[name];
  if (!Array.isArray(rules)) throw new Error(`filter ${name} is missing`);
  const flattened = rules.flat(Infinity);
  if (flattened.some((rule) => typeof rule !== "string")) {
    throw new Error(`filter ${name} contains a non-string rule`);
  }
  const matchers = flattened.map((rule) => picomatch(rule, { dot: true }));
  const paths = changes.flatMap((change) =>
    change.status === "renamed" && change.previousPath
      ? [change.previousPath, change.path]
      : [change.path],
  );
  return [
    ...new Set(paths.filter((path) => matchers.some((match) => match(path)))),
  ];
}

export async function forceAllForChanges(filters, changes, reportedCount) {
  const [all, routed, ordinary, controlPlane] = await Promise.all([
    matchedFiles(filters, "all", changes),
    matchedFiles(filters, "routed", changes),
    matchedFiles(filters, "ordinary", changes),
    matchedFiles(filters, "controlPlane", changes),
  ]);
  const ordinarySet = new Set(ordinary);
  const routedSet = new Set(routed);
  return {
    forceAll:
      controlPlane.length > 0 ||
      all.length !== routed.length ||
      all.length !== ordinary.length ||
      Number(reportedCount ?? all.length) >= 3000,
    controlPlane: controlPlane.sort(),
    unknown: all
      .filter((path) => !ordinarySet.has(path) || !routedSet.has(path))
      .sort(),
  };
}

export function workflowViolations(workflow, filters) {
  const errors = [];
  const jobs = workflow.jobs ?? {};
  if (workflow.name !== "CI") errors.push("workflow name must remain CI");
  errors.push(
    ...setErrors("workflow jobs", Object.keys(jobs), [...FIXED_JOBS, "ci"]),
  );
  for (const name of [...FIXED_JOBS, "ci"]) {
    if (jobs[name]?.["continue-on-error"] !== undefined) {
      errors.push(`${name} must not use job-level continue-on-error`);
    }
  }
  errors.push(
    ...setErrors(
      "conditional jobs",
      Object.entries(jobs)
        .filter(([name, job]) => name !== "ci" && job?.if !== undefined)
        .map(([name]) => name),
      CONDITIONAL_JOBS,
    ),
  );
  for (const [name, expected] of Object.entries(EXPECTED_CONDITIONS)) {
    if (jobs[name]?.if !== expected)
      errors.push(`${name} has an invalid if guard`);
  }
  for (const [name, timeout] of Object.entries(EXPECTED_TIMEOUTS)) {
    if (jobs[name]?.["timeout-minutes"] !== timeout) {
      errors.push(`${name} timeout-minutes must be ${timeout}`);
    }
  }
  const changes = jobs.changes ?? {};
  errors.push(
    ...setErrors("changes outputs", Object.keys(changes.outputs ?? {}), [
      ...FILTER_NAMES,
      "forceAll",
    ]),
  );
  if (changes.outputs?.forceAll !== FORCE_ALL_OUTPUT) {
    errors.push("changes.forceAll output is not pinned to fail-closed counts");
  }
  for (const name of FILTER_NAMES) {
    if (changes.outputs?.[name] !== `\${{ steps.filter.outputs.${name} }}`)
      errors.push(`changes.${name} output changed`);
  }
  const filter = changes.steps?.find((step) => step.id === "filter");
  if (filter?.uses !== DORNY_PIN)
    errors.push("paths-filter action pin changed");
  if (filter?.with?.["list-files"] !== undefined) {
    errors.push("paths-filter must not export duplicated file lists");
  }
  errors.push(
    ...setErrors("path filters", Object.keys(filters ?? {}), [
      ...FILTER_NAMES,
      "controlPlane",
      "routed",
      "ordinary",
      "all",
    ]),
  );
  if (JSON.stringify(filters?.all) !== JSON.stringify(["**"])) {
    errors.push("all must match every path");
  }
  if (JSON.stringify(filters?.controlPlane) !== JSON.stringify(CONTROL_PLANE))
    errors.push("controlPlane filter changed");
  if (JSON.stringify(filters?.ordinary) !== JSON.stringify(ORDINARY))
    errors.push("ordinary namespace filter changed");
  if (
    JSON.stringify(filters?.routed) !==
    JSON.stringify(FILTER_NAMES.map((name) => filters?.[name]))
  )
    errors.push("routed filter is not the functional-filter union");
  for (const name of [...FILTER_NAMES, "controlPlane"]) {
    const rules = filters?.[name];
    if (!Array.isArray(rules)) {
      errors.push(`${name} must be an array`);
      continue;
    }
    if (rules.flat(Infinity).some((rule) => String(rule).startsWith("!"))) {
      errors.push(`${name} must not use exclusion rules`);
    }
  }
  for (const [name, commands] of Object.entries(REQUIRED_COMMANDS)) {
    for (const [command, condition] of commands) {
      const step = (jobs[name]?.steps ?? []).find(
        (candidate) => candidate.run === command,
      );
      if (
        !step ||
        (step.if ?? null) !== condition ||
        step["continue-on-error"] != null
      )
        errors.push(`${name} no longer enforces ${command}`);
    }
  }
  const ci = jobs.ci ?? {};
  errors.push(...setErrors("ci.needs", list(ci.needs), FIXED_JOBS));
  try {
    const trusted = new Map(
      FIXED_JOBS.map((name) => [
        name,
        CONDITIONAL_JOBS.includes(name) ? jobs[name]?.if : null,
      ]),
    );
    errors.push(...sentinelBlockers(workflow, trusted));
  } catch (error) {
    errors.push(`ci sentinel is malformed: ${error.message}`);
  }
  const gate = ci.steps?.find((step) =>
    String(step.uses ?? "").startsWith("re-actors/alls-green@"),
  );
  if (gate?.uses !== ALLS_GREEN_PIN)
    errors.push("alls-green action pin changed");
  errors.push(
    ...setErrors(
      "allowed-skips",
      parseActionList(gate?.with?.["allowed-skips"]),
      CONDITIONAL_JOBS,
    ),
  );
  const expectedGroup =
    "${{ github.workflow }}-${{ github.event_name == 'pull_request' && github.ref || github.sha }}";
  if (
    workflow.concurrency?.group !== expectedGroup ||
    workflow.concurrency?.["cancel-in-progress"] !== true
  ) {
    errors.push("workflow concurrency no longer uses PR refs and main SHAs");
  }
  return [...new Set(errors)];
}

async function main() {
  const { workflow, filters } = await loadCi();
  const errors = workflowViolations(workflow, filters);
  if (errors.length > 0) {
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log("CI contract OK");
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
