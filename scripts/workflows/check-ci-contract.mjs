#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// prettier-ignore
import { envMutationBlockers, parseActionList, sentinelBlockers } from "../sentry/ci-wiring/check-sentry-suites-in-ci-core.mjs";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FORCE_ALL = "needs.changes.outputs.forceAll == 'true'";
const DORNY_PIN = "dorny/paths-filter@ceb8a2b8f2d89434be7ff52d3de7ec3738c5cc9d";
const ALLS_GREEN_PIN =
  "re-actors/alls-green@b5b5b37504aa4183270bd3d855c52a67f212be35";
// prettier-ignore
const ORDINARY_GATE_IF = "${{ !inputs.no_skip_audit }}", AUDIT_GATE_IF = "${{ inputs.no_skip_audit }}";
// prettier-ignore
const CHECKOUT_STEP = Object.freeze({ uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1", if: "${{ !inputs.no_skip_audit }}", with: { "persist-credentials": false } }), TIMELINE_STEP = Object.freeze({ uses: "Kesin11/actions-timeline@57fc93f20c6da7fbc14063c6d24a2a5627c799ad", if: "always() && !inputs.no_skip_audit" });
// prettier-ignore
const ORDINARY = "*.md|aegis/**|alerts/**|docs/**|governance-watchdog/**|indexer-envio/**|integration-probes/**|metrics-bridge/**|terraform/**|ui-dashboard/**".split("|");
// prettier-ignore
const CONTROL_PLANE = ".node-version|**/package.json|**/package.json5|**/package.yaml|**/pnpm-workspace.yaml|**/pnpm-lock.yaml|**/.npmrc|**/.pnpmfile.cjs|**/pnpmfile.cjs|**/patches|**/patches/**|**/node_modules|**/node_modules/**|**/tsconfig*.json|**/eslint.config.*|**/vitest*.{js,cjs,mjs,ts,cts,mts}|**/knip.json|**/react-doctor.config.json".split("|");
export const FORCE_ALL_OUTPUT =
  "${{ inputs.no_skip_audit || steps.filter.outputs.controlPlane == 'true' || steps.filter.outputs.all_count != steps.filter.outputs.routed_count || steps.filter.outputs.all_count != steps.filter.outputs.ordinary_count || (github.event_name == 'pull_request' && github.event.pull_request.changed_files >= 3000) }}";
// prettier-ignore
export const FILTER_NAMES = Object.freeze("shared|ui|indexer|bridge|integrationProbes|aegis|terraform|alerts|govWatchdog|codeHealth|rootScripts|docs|autoreviewSuite|autoreviewRootRuntime|versionSkew".split("|"));
// prettier-ignore
export const CONDITIONAL_JOBS = Object.freeze("shared|ui|indexer|bridge|integration-probes|aegis|alerts|gov-watchdog|terraform|deps|scripts|docs-checks|autoreview-suite|autoreview-root-runtime|version-skew".split("|"));

// prettier-ignore
export const FIXED_JOBS = Object.freeze(["changes", ...CONDITIONAL_JOBS, "guardrail-prose", "production-infra-contract", "sentry-suites"]);

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
const EXPECTED_TIMEOUTS = Object.freeze({ changes: 2, shared: 10, ui: 25, indexer: 20, bridge: 10, "integration-probes": 10, alerts: 10, "gov-watchdog": 10, terraform: 10, aegis: 15, scripts: 55, "guardrail-prose": 5, "docs-checks": 10, "production-infra-contract": 5, "sentry-suites": 5, "autoreview-suite": 90, "autoreview-root-runtime": 5, "version-skew": 5, deps: 5, ci: 2 });
// prettier-ignore
const EXPECTED_RUNNERS = Object.freeze({ changes: "blacksmith-2vcpu-ubuntu-2404-arm", shared: "blacksmith-2vcpu-ubuntu-2404", ui: "blacksmith-4vcpu-ubuntu-2404", indexer: "blacksmith-4vcpu-ubuntu-2404", bridge: "blacksmith-2vcpu-ubuntu-2404", "integration-probes": "blacksmith-2vcpu-ubuntu-2404", aegis: "blacksmith-2vcpu-ubuntu-2404", alerts: "blacksmith-2vcpu-ubuntu-2404", "gov-watchdog": "blacksmith-4vcpu-ubuntu-2404", terraform: "blacksmith-2vcpu-ubuntu-2404-arm", deps: "blacksmith-2vcpu-ubuntu-2404", scripts: "blacksmith-2vcpu-ubuntu-2404", "docs-checks": "blacksmith-2vcpu-ubuntu-2404", "autoreview-suite": "ubuntu-latest", "autoreview-root-runtime": "blacksmith-2vcpu-ubuntu-2404", "version-skew": "blacksmith-2vcpu-ubuntu-2404", "guardrail-prose": "ubuntu-latest", "production-infra-contract": "blacksmith-2vcpu-ubuntu-2404", "sentry-suites": "ubuntu-latest", ci: "ubuntu-latest" });
// prettier-ignore
const EXPECTED_JOB_ENV = Object.freeze({ indexer: { ENVIO_STRICT_START_BLOCK: "true" }, aegis: { FOUNDRY_PROFILE: "ci" } });
// prettier-ignore
const REQUIRED_COMMANDS = Object.freeze({ ui: [["VERCEL_DEPLOYMENT_ID=ci pnpm exec turbo run size-limit --filter=@mento-protocol/ui-dashboard --cache=\"$TURBO_CACHE_POLICY\"", null, { TURBO_CACHE_POLICY: "${{ inputs.no_skip_audit && 'local:,remote:' || 'local:rw' }}" }]], scripts: [["node scripts/workflows/check-ci-contract.mjs", null], ["pnpm adr:check", null, { AGENT_QUALITY_BASE: "${{ inputs.no_skip_audit && inputs.audit_base_sha || 'origin/main' }}" }], ["pnpm adr:check:test", null]], "production-infra-contract": [["pnpm ci:contract:test", "${{ !cancelled() }}"]] });

function list(value) {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function setErrors(label, actual, expected) {
  const missing = expected.filter((entry) => !actual.includes(entry));
  const extra = actual.filter((entry) => !expected.includes(entry));
  // prettier-ignore
  return [...missing.map((entry) => `${label} misses ${entry}`), ...extra.map((entry) => `${label} has unexpected ${entry}`)];
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
  // prettier-ignore
  const filterStep = workflow.jobs?.changes?.steps?.find((step) => step.id === "filter");
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
  // prettier-ignore
  return [...new Set(paths.filter((path) => matchers.some((match) => match(path))))];
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
  if (workflow.env !== undefined || workflow.defaults !== undefined)
    errors.push("workflow runtime changed");
  errors.push(
    ...setErrors("workflow jobs", Object.keys(jobs), [...FIXED_JOBS, "ci"]),
  );
  for (const name of [...FIXED_JOBS, "ci"]) {
    const job = jobs[name] ?? {};
    if (jobs[name]?.["continue-on-error"] !== undefined) {
      errors.push(`${name} must not use job-level continue-on-error`);
    }
    // prettier-ignore
    if (job["runs-on"] !== EXPECTED_RUNNERS[name] || JSON.stringify(job.env ?? null) !== JSON.stringify(EXPECTED_JOB_ENV[name] ?? null) || ["defaults", "strategy", "container", "services", "uses", "environment", "secrets", "with"].some((key) => job[key] !== undefined) || (CONDITIONAL_JOBS.includes(name) && job.needs !== "changes")) errors.push(`${name} job runtime changed`);
    errors.push(...envMutationBlockers(job.steps, name));
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
  // prettier-ignore
  for (const [name, expected] of Object.entries(EXPECTED_CONDITIONS)) if (jobs[name]?.if !== expected) errors.push(`${name} has an invalid if guard`);
  // prettier-ignore
  for (const [name, timeout] of Object.entries(EXPECTED_TIMEOUTS)) if (jobs[name]?.["timeout-minutes"] !== timeout) errors.push(`${name} timeout-minutes must be ${timeout}`);
  const changes = jobs.changes ?? {};
  // prettier-ignore
  if (Object.keys(changes).sort().join() !== "name,outputs,permissions,runs-on,steps,timeout-minutes" || changes["runs-on"] !== "blacksmith-2vcpu-ubuntu-2404-arm" || JSON.stringify(changes.permissions) !== '{"contents":"read","actions":"read","pull-requests":"read"}') errors.push("changes job runtime changed");
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
  // prettier-ignore
  const filterSteps = list(changes.steps).filter((step) => step.id === "filter");
  const filter = filterSteps[0];
  if (filterSteps.length !== 1) errors.push("paths-filter step count changed");
  // prettier-ignore
  if (Object.keys(filter ?? {}).sort().join() !== "id,if,uses,with" || filter?.if !== "${{ !inputs.no_skip_audit }}") errors.push("paths-filter step shape changed");
  if (Object.keys(filter?.with ?? {}).join() !== "filters")
    errors.push("paths-filter inputs changed");
  if (filter?.uses !== DORNY_PIN)
    errors.push("paths-filter action pin changed");
  // prettier-ignore
  if (changes.steps?.length !== 3 || JSON.stringify(changes.steps[0]) !== JSON.stringify(CHECKOUT_STEP) || changes.steps[1] !== filter || JSON.stringify(changes.steps[2]) !== JSON.stringify(TIMELINE_STEP)) errors.push("changes steps changed");
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
    for (const [command, condition, environment] of commands) {
      const step = (jobs[name]?.steps ?? []).find(
        (candidate) => candidate.run === command,
      );
      // prettier-ignore
      if (!step || (step.if ?? null) !== condition || JSON.stringify(step.env ?? null) !== JSON.stringify(environment ?? null) || Object.keys(step).sort().join() !== [condition == null ? null : "if", environment == null ? null : "env", "name", "run"].filter(Boolean).sort().join()) errors.push(`${name} no longer enforces ${command}`);
    }
  }
  const ci = jobs.ci ?? {};
  // prettier-ignore
  if (Object.keys(ci).sort().join() !== "if,name,needs,permissions,runs-on,steps,timeout-minutes" || ci["runs-on"] !== "ubuntu-latest" || JSON.stringify(ci.permissions) !== '{"contents":"read","actions":"read"}') errors.push("ci job runtime changed");
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
  const gates =
    ci.steps?.filter((step) =>
      String(step.uses ?? "").startsWith("re-actors/alls-green@"),
    ) ?? [];
  const gate = gates.find((step) => step.if === ORDINARY_GATE_IF);
  const auditGate = gates.find((step) => step.if === AUDIT_GATE_IF);
  if (gates.length !== 2 || gates.some((step) => step.uses !== ALLS_GREEN_PIN))
    errors.push("alls-green action pin or split changed");
  // prettier-ignore
  if (ci.steps?.length !== 3 || ci.steps[0] !== gate || ci.steps[1] !== auditGate || JSON.stringify(ci.steps[2]) !== JSON.stringify(TIMELINE_STEP) || Object.keys(gate ?? {}).sort().join() !== "if,uses,with" || Object.keys(auditGate ?? {}).sort().join() !== "if,name,uses,with" || auditGate?.name !== "Require every no-skip job to pass" || JSON.stringify(auditGate?.with) !== '{"jobs":"${{ toJSON(needs) }}"}') errors.push("ci steps changed");
  errors.push(
    ...setErrors(
      "allowed-skips",
      parseActionList(gate?.with?.["allowed-skips"]),
      CONDITIONAL_JOBS,
    ),
  );
  // prettier-ignore
  const expectedGroup = "${{ inputs.no_skip_audit && format('ci-no-skip-{0}', github.run_id) || format('{0}-{1}', github.workflow, github.event_name == 'pull_request' && github.ref || github.sha) }}";
  // prettier-ignore
  if (workflow.concurrency?.group !== expectedGroup || workflow.concurrency?.["cancel-in-progress"] !== "${{ !inputs.no_skip_audit }}") errors.push("workflow concurrency no longer separates audit runs, PR refs, and main SHAs");
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
