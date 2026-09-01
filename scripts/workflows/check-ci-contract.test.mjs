#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CONDITIONAL_JOBS,
  FILTER_NAMES,
  FIXED_JOBS,
  aggregateViolations,
  concurrencyGroup,
  forceAllForChanges,
  loadCi,
  matchedFiles,
  workflowViolations,
} from "./check-ci-contract.mjs";

const LIVE = await loadCi();
const FORCE_ALL_GUARD = "needs.changes.outputs.forceAll == 'true'";
const UI_SOURCE = "ui-dashboard/src/app/page.tsx";

const FILTER_FIXTURES = Object.freeze([
  ["shared", "shared-config/chains.json", UI_SOURCE],
  ["ui", UI_SOURCE, "governance-watchdog/src/index.ts"],
  ["indexer", "indexer-envio/src/EventHandlers.ts", UI_SOURCE],
  ["bridge", "metrics-bridge/src/index.ts", UI_SOURCE],
  ["integrationProbes", "integration-probes/src/index.ts", UI_SOURCE],
  ["aegis", "aegis/src/index.ts", UI_SOURCE],
  ["terraform", "terraform/main.tf", UI_SOURCE],
  ["alerts", "alerts/infra/onchain-event-handler/src/index.ts", UI_SOURCE],
  ["govWatchdog", "governance-watchdog/src/index.ts", UI_SOURCE],
  ["codeHealth", ".dependency-cruiser.cjs", "docs/notes/example.md"],
  ["rootScripts", "scripts/workflows/check-ci-contract.mjs", UI_SOURCE],
  ["docs", "docs/notes/example.md", UI_SOURCE],
  ["autoreviewSuite", "scripts/agent-autoreview.sh", UI_SOURCE],
  ["autoreviewRootRuntime", "scripts/agent-autoreview.mjs", UI_SOURCE],
  ["versionSkew", "ui-dashboard/package.json", UI_SOURCE],
]);

function changed(path, status = "modified", previousPath) {
  return { path, status, ...(previousPath ? { previousPath } : {}) };
}

function pathFilterStep(workflow) {
  return workflow.jobs.changes.steps.find((step) => step.id === "filter");
}

function aggregateStep(workflow) {
  return workflow.jobs.ci.steps.find((step) =>
    String(step.uses ?? "").startsWith("re-actors/alls-green@"),
  );
}

function successfulResults() {
  return Object.fromEntries(
    FIXED_JOBS.map((name) => [name, { result: "success" }]),
  );
}

function assertAllConditionalJobsUseForceAll(decision) {
  assert.equal(decision.forceAll, true);
  for (const name of CONDITIONAL_JOBS) {
    assert.ok(
      String(LIVE.workflow.jobs[name].if).startsWith(`${FORCE_ALL_GUARD} ||`),
      `${name} must select when forceAll is true`,
    );
  }
}

test("the live workflow satisfies the closed CI contract", () => {
  assert.deepEqual(workflowViolations(LIVE.workflow, LIVE.filters), []);
  assert.deepEqual(
    FILTER_FIXTURES.map(([name]) => name),
    FILTER_NAMES,
    "the fixture table must cover every raw functional filter exactly once",
  );
});

const STATIC_MUTATIONS = [
  [
    "changed workflow name",
    /workflow name must remain CI/u,
    ({ workflow }) => (workflow.name = "Other"),
  ],
  [
    "deleted fixed job",
    /workflow jobs misses ui/u,
    ({ workflow }) => delete workflow.jobs.ui,
  ],
  [
    "unexpected fixed job",
    /workflow jobs has unexpected rogue/u,
    ({ workflow }) => {
      workflow.jobs.rogue = {
        name: "rogue",
        "runs-on": "ubuntu-latest",
        "timeout-minutes": 5,
        steps: [],
      };
    },
  ],
  [
    "job-level allowed failure",
    /ui must not use job-level continue-on-error/u,
    ({ workflow }) => (workflow.jobs.ui["continue-on-error"] = true),
  ],
  [
    "conditional job without registration",
    /conditional jobs has unexpected rogue/u,
    ({ workflow }) => {
      workflow.jobs.rogue = {
        name: "rogue",
        needs: "changes",
        if: `${FORCE_ALL_GUARD} || needs.changes.outputs.ui == 'true'`,
        "runs-on": "ubuntu-latest",
        "timeout-minutes": 5,
        steps: [],
      };
    },
  ],
  [
    "missing conditional guard",
    /conditional jobs misses ui/u,
    ({ workflow }) => delete workflow.jobs.ui.if,
  ],
  [
    "guard without forceAll",
    /ui has an invalid if guard/u,
    ({ workflow }) => {
      workflow.jobs.ui.if = "needs.changes.outputs.ui == 'true'";
    },
  ],
  [
    "changed forceAll expression",
    /changes\.forceAll output/u,
    ({ workflow }) => {
      workflow.jobs.changes.outputs.forceAll =
        "${{ steps.filter.outputs.controlPlane == 'true' }}";
    },
  ],
  [
    "changed functional output",
    /changes\.ui output changed/u,
    ({ workflow }) => (workflow.jobs.changes.outputs.ui = "true"),
  ],
  // prettier-ignore
  ["workflow runtime env", /workflow runtime/u, ({ workflow }) => { workflow.env = { NODE_OPTIONS: "--require=./hook.cjs" }; }],
  // prettier-ignore
  ["workflow run defaults", /workflow runtime/u, ({ workflow }) => { workflow.defaults = { run: { shell: "bash {0} || true" } }; }],
  // prettier-ignore
  ["changes job runtime env", /changes job runtime/u, ({ workflow }) => { workflow.jobs.changes.env = { NODE_OPTIONS: "--require=./hook.cjs" }; }],
  // prettier-ignore
  ["changes predecessor env writer", /changes steps/u, ({ workflow }) => { workflow.jobs.changes.steps.splice(1, 0, { run: "echo NODE_OPTIONS=--require=./hook.cjs >> $GITHUB_ENV" }); }],
  // prettier-ignore
  ["changes runner", /changes job runtime/u, ({ workflow }) => { workflow.jobs.changes["runs-on"] = "self-hosted"; }],
  // prettier-ignore
  ["changes permissions", /changes job runtime/u, ({ workflow }) => { workflow.jobs.changes.permissions = { contents: "write" }; }],
  // prettier-ignore
  ["package job runtime env", /ui job runtime/u, ({ workflow }) => { workflow.jobs.ui.env = { NODE_OPTIONS: "--require=./hook.cjs" }; }],
  // prettier-ignore
  ["package job run defaults", /ui job runtime/u, ({ workflow }) => { workflow.jobs.ui.defaults = { run: { shell: "bash {0} || true" } }; }],
  // prettier-ignore
  ["package predecessor env writer", /GITHUB_ENV/u, ({ workflow }) => { workflow.jobs.ui.steps.unshift({ run: "echo NODE_OPTIONS=--require=./hook.cjs >> $GITHUB_ENV" }); }],
  // prettier-ignore
  ["conditional job extra dependency", /ui job runtime/u, ({ workflow }) => { workflow.jobs.ui.needs = ["changes", "indexer"]; }],
  // prettier-ignore
  ["allowed package job env changed", /indexer job runtime/u, ({ workflow }) => { workflow.jobs.indexer.env.ENVIO_STRICT_START_BLOCK = "false"; }],
  // prettier-ignore
  ["changes checkout identity", /changes steps/u, ({ workflow }) => { workflow.jobs.changes.steps[0].uses = "actions/checkout@unreviewed"; }],
  // prettier-ignore
  ["changes timeline identity", /changes steps/u, ({ workflow }) => { workflow.jobs.changes.steps[2].uses = "Kesin11/actions-timeline@unreviewed"; }],
  // prettier-ignore
  ["changed paths-filter pin", /paths-filter action pin/u, ({ workflow }) => { pathFilterStep(workflow).uses = "dorny/paths-filter@unreviewed"; }],
  // prettier-ignore
  ["duplicated paths-filter step", /paths-filter step count/u, ({ workflow }) => { workflow.jobs.changes.steps.push(structuredClone(pathFilterStep(workflow))); }],
  // prettier-ignore
  ["conditional paths-filter step", /paths-filter step shape/u, ({ workflow }) => { pathFilterStep(workflow).if = false; }],
  // prettier-ignore
  ["nonfatal paths-filter step", /paths-filter step shape/u, ({ workflow }) => { pathFilterStep(workflow)["continue-on-error"] = true; }],
  // prettier-ignore
  ["paths-filter token override", /paths-filter inputs/u, ({ workflow }) => { pathFilterStep(workflow).with.token = ""; }],
  // prettier-ignore
  ["paths-filter base override", /paths-filter inputs/u, ({ workflow }) => { pathFilterStep(workflow).with.base = "HEAD"; }],
  // prettier-ignore
  ["file-list output", /paths-filter inputs/u, ({ workflow }) => { pathFilterStep(workflow).with["list-files"] = "json"; }],
  [
    "missing path filter",
    /path filters misses ui/u,
    ({ filters }) => delete filters.ui,
  ],
  // prettier-ignore
  ["unexpected path filter", /path filters has unexpected rogue/u, ({ filters }) => { filters.rogue = ["rogue/**"]; }],
  [
    "narrowed all filter",
    /all must match every path/u,
    ({ filters }) => {
      filters.all = ["src/**"];
    },
  ],
  [
    "empty control-plane filter",
    /controlPlane filter changed/u,
    ({ filters }) => {
      filters.controlPlane = [];
    },
  ],
  [
    "empty ordinary filter",
    /ordinary namespace filter changed/u,
    ({ filters }) => {
      filters.ordinary = [];
    },
  ],
  // prettier-ignore
  ["empty routed filter", /routed filter is not the functional-filter union/u, ({ filters }) => { filters.routed = []; }],
  // prettier-ignore
  ["functional exclusion rule", /ui must not use exclusion rules/u, ({ filters }) => filters.ui.push("!ui-dashboard/generated/**")],
  // prettier-ignore
  ["null functional filter", /ui must be an array/u, ({ filters }) => { filters.ui = null; filters.routed = FILTER_NAMES.map((name) => filters[name]); }],
  // prettier-ignore
  ["scalar functional filter", /ui must be an array/u, ({ filters }) => { filters.ui = "ui-dashboard/**"; filters.routed = FILTER_NAMES.map((name) => filters[name]); }],
  // prettier-ignore
  ["missing aggregate need", /ci\.needs misses scripts/u, ({ workflow }) => { workflow.jobs.ci.needs = workflow.jobs.ci.needs.filter((name) => name !== "scripts"); }],
  // prettier-ignore
  ["unexpected aggregate need", /ci\.needs has unexpected rogue/u, ({ workflow }) => { workflow.jobs.ci.needs.push("rogue"); }],
  // prettier-ignore
  ["changed aggregate pin", /alls-green action pin or split/u, ({ workflow }) => { aggregateStep(workflow).uses = "re-actors/alls-green@unreviewed"; }],
  // prettier-ignore
  ["ci job runtime env", /ci job runtime/u, ({ workflow }) => { workflow.jobs.ci.env = { NODE_OPTIONS: "--require=./hook.cjs" }; }],
  // prettier-ignore
  ["ci predecessor env writer", /ci steps/u, ({ workflow }) => { workflow.jobs.ci.steps.unshift({ run: "echo NODE_OPTIONS=--require=./hook.cjs >> $GITHUB_ENV" }); }],
  // prettier-ignore
  ["ci runner", /ci job runtime/u, ({ workflow }) => { workflow.jobs.ci["runs-on"] = "self-hosted"; }],
  // prettier-ignore
  ["ci permissions", /ci job runtime/u, ({ workflow }) => { workflow.jobs.ci.permissions = { contents: "write" }; }],
  // prettier-ignore
  ["ci timeline identity", /ci steps/u, ({ workflow }) => { workflow.jobs.ci.steps[2].uses = "Kesin11/actions-timeline@unreviewed"; }],
  // prettier-ignore
  ["missing allowed skip", /allowed-skips misses ui/u, ({ workflow }) => { const gate = aggregateStep(workflow); gate.with["allowed-skips"] = gate.with["allowed-skips"].split(",").filter((name) => name !== "ui").join(","); }],
  [
    "unexpected allowed skip",
    /allowed-skips has unexpected changes/u,
    ({ workflow }) => {
      aggregateStep(workflow).with["allowed-skips"] += ",changes";
    },
  ],
  [
    "allowed failure",
    /allowed-failures/u,
    ({ workflow }) => {
      aggregateStep(workflow).with["allowed-failures"] = "scripts";
    },
  ],
  [
    "changed aggregate jobs input",
    /reads.*instead of every job/u,
    ({ workflow }) => {
      aggregateStep(workflow).with.jobs = "${{ toJSON(needs.shared) }}";
    },
  ],
  // prettier-ignore
  ["changed timeout", /ui timeout-minutes must be 25/u, ({ workflow }) => { workflow.jobs.ui["timeout-minutes"] = 1; }],
  // prettier-ignore
  ["nonblocking required command", /ui no longer enforces VERCEL_DEPLOYMENT_ID/u, ({ workflow }) => { workflow.jobs.ui.steps.find((step) => step.name?.startsWith("Production build"))["continue-on-error"] = true; }],
  // prettier-ignore
  ["required command runtime env", /ui no longer enforces VERCEL_DEPLOYMENT_ID/u, ({ workflow }) => { workflow.jobs.ui.steps.find((step) => step.name?.startsWith("Production build")).env = { NODE_OPTIONS: "--require=./hook.cjs" }; }],
  // prettier-ignore
  ["required command shell", /ui no longer enforces VERCEL_DEPLOYMENT_ID/u, ({ workflow }) => { workflow.jobs.ui.steps.find((step) => step.name?.startsWith("Production build")).shell = "bash {0}"; }],
  // prettier-ignore
  ["required command working directory", /ui no longer enforces VERCEL_DEPLOYMENT_ID/u, ({ workflow }) => { workflow.jobs.ui.steps.find((step) => step.name?.startsWith("Production build"))["working-directory"] = "ui-dashboard"; }],
  [
    "cross-cancelling main concurrency",
    /workflow concurrency/u,
    ({ workflow }) => {
      workflow.concurrency.group = "${{ github.workflow }}-${{ github.ref }}";
    },
  ],
];

test("static contract mutations fail closed with a precise reason", () => {
  for (const [label, expected, mutate] of STATIC_MUTATIONS) {
    const fixture = {
      workflow: structuredClone(LIVE.workflow),
      filters: structuredClone(LIVE.filters),
    };
    mutate(fixture);
    assert.match(
      workflowViolations(fixture.workflow, fixture.filters).join("\n"),
      expected,
      label,
    );
  }
});

for (const [name, positive, negative] of FILTER_FIXTURES) {
  test(`${name} routes positive, deletion, and rename fixtures only`, async () => {
    assert.deepEqual(
      await matchedFiles(LIVE.filters, name, [changed(positive)]),
      [positive],
      "positive fixture",
    );
    assert.deepEqual(
      await matchedFiles(LIVE.filters, name, [changed(negative)]),
      [],
      "negative fixture",
    );
    assert.deepEqual(
      await matchedFiles(LIVE.filters, name, [changed(positive, "deleted")]),
      [positive],
      "deleted path",
    );
    assert.deepEqual(
      await matchedFiles(LIVE.filters, name, [
        changed(negative, "renamed", positive),
      ]),
      [positive],
      "rename away from the routed path",
    );
  });
}

test("unknown, control-plane, and mixed diffs select every conditional job", async () => {
  const unknown = await forceAllForChanges(LIVE.filters, [
    changed("new-service/src/index.ts"),
  ]);
  assert.deepEqual(unknown.unknown, ["new-service/src/index.ts"]);
  assertAllConditionalJobsUseForceAll(unknown);

  const globalMarkdown = await forceAllForChanges(LIVE.filters, [
    changed("new-service/README.md"),
  ]);
  assert.deepEqual(globalMarkdown.unknown, ["new-service/README.md"]);
  assertAllConditionalJobsUseForceAll(globalMarkdown);

  for (const path of [
    "ui-dashboard/package.json",
    "ui-dashboard/tsconfig.json",
    "ui-dashboard/eslint.config.mjs",
    "ui-dashboard/vitest.config.ts",
    "ui-dashboard/react-doctor.config.json",
  ]) {
    const controlPlane = await forceAllForChanges(LIVE.filters, [
      changed(path),
    ]);
    assert.deepEqual(controlPlane.controlPlane, [path]);
    assertAllConditionalJobsUseForceAll(controlPlane);
  }

  const mixed = await forceAllForChanges(LIVE.filters, [
    changed("ui-dashboard/src/app/page.tsx"),
    changed("new-service/README.md"),
  ]);
  assert.deepEqual(mixed.unknown, ["new-service/README.md"]);
  assertAllConditionalJobsUseForceAll(mixed);
});

test("ordinary package and documentation diffs keep affected selection", async () => {
  for (const path of [
    "ui-dashboard/src/app/page.tsx",
    "docs/notes/example.md",
    "README.md",
  ]) {
    assert.equal(
      (await forceAllForChanges(LIVE.filters, [changed(path)])).forceAll,
      false,
      path,
    );
  }
  const unroutedDocsAsset = await forceAllForChanges(LIVE.filters, [
    changed("docs/notes/example.json"),
  ]);
  assert.equal(unroutedDocsAsset.forceAll, true);
  assert.deepEqual(unroutedDocsAsset.unknown, ["docs/notes/example.json"]);
  const narrowed = structuredClone(LIVE.filters);
  narrowed.ui = ["ui-dashboard/src/**"];
  narrowed.routed = FILTER_NAMES.map((name) => narrowed[name]);
  // prettier-ignore
  assertAllConditionalJobsUseForceAll(await forceAllForChanges(narrowed, [changed("ui-dashboard/public/logo.svg")]));
});

test("overlapping functional filters count one changed path once", async () => {
  const changes = [changed("shared-config/chains.json")];
  assert.deepEqual(await matchedFiles(LIVE.filters, "all", changes), [
    "shared-config/chains.json",
  ]);
  assert.deepEqual(await matchedFiles(LIVE.filters, "routed", changes), [
    "shared-config/chains.json",
  ]);
  const decision = await forceAllForChanges(LIVE.filters, changes);
  assert.equal(decision.forceAll, true);
  assert.deepEqual(decision.unknown, ["shared-config/chains.json"]);
});

test("the pull-request file limit fails closed at 3,000", async () => {
  const ordinary = [changed("ui-dashboard/src/app/page.tsx")];
  assert.equal(
    (await forceAllForChanges(LIVE.filters, ordinary, 2_999)).forceAll,
    false,
  );
  assert.equal(
    (await forceAllForChanges(LIVE.filters, ordinary, 3_000)).forceAll,
    true,
  );
});

test("the aggregate accepts success and zero conditional executions", () => {
  assert.deepEqual(aggregateViolations(successfulResults()), []);
  const zeroConditional = successfulResults();
  for (const name of CONDITIONAL_JOBS) {
    zeroConditional[name] = { result: "skipped" };
  }
  assert.deepEqual(aggregateViolations(zeroConditional), []);
});

test("the aggregate names failed, cancelled, missing, unexpected, and skipped jobs", () => {
  const cases = [
    [
      "failure",
      (results) => (results.ui = { result: "failure" }),
      "invalid job result: ui=failure",
    ],
    [
      "cancellation",
      (results) => (results["sentry-suites"] = { result: "cancelled" }),
      "invalid job result: sentry-suites=cancelled",
    ],
    ["missing", (results) => delete results.scripts, "missing job: scripts"],
    [
      "unexpected",
      (results) => (results.rogue = { result: "success" }),
      "unexpected job: rogue",
    ],
    [
      "disallowed skip",
      (results) => (results.changes = { result: "skipped" }),
      "invalid job result: changes=skipped",
    ],
    [
      "unexpected result",
      (results) => (results.shared = { result: "neutral" }),
      "invalid job result: shared=neutral",
    ],
  ];
  for (const [label, mutate, expected] of cases) {
    const results = successfulResults();
    mutate(results);
    assert.ok(aggregateViolations(results).includes(expected), label);
  }
});

test("concurrency cancels stale PR heads but separates PRs and main SHAs", () => {
  const firstHead = concurrencyGroup({
    eventName: "pull_request",
    ref: "refs/pull/42/merge",
    sha: "head-one",
  });
  const nextHead = concurrencyGroup({
    eventName: "pull_request",
    ref: "refs/pull/42/merge",
    sha: "head-two",
  });
  const otherPr = concurrencyGroup({
    eventName: "pull_request",
    ref: "refs/pull/43/merge",
    sha: "head-two",
  });
  assert.equal(firstHead, nextHead, "a newer head cancels the stale PR run");
  assert.notEqual(firstHead, otherPr, "different PRs cannot cancel each other");

  const firstMain = concurrencyGroup({ eventName: "push", sha: "main-one" });
  const nextMain = concurrencyGroup({ eventName: "push", sha: "main-two" });
  assert.notEqual(firstMain, nextMain, "each main commit keeps its own run");
  assert.notEqual(
    firstMain,
    concurrencyGroup({ workflow: "Other", eventName: "push", sha: "main-one" }),
    "workflows cannot cancel each other",
  );
});

test("the replacement checker and tests stay within their size budgets", () => {
  const implementation = readFileSync(
    fileURLToPath(new URL("./check-ci-contract.mjs", import.meta.url)),
    "utf8",
  )
    .trimEnd()
    .split(/\r?\n/u).length;
  const tests = readFileSync(fileURLToPath(import.meta.url), "utf8")
    .trimEnd()
    .split(/\r?\n/u).length;
  assert.ok(implementation < 300, `${implementation} implementation lines`);
  assert.ok(tests < 500, `${tests} test lines`);
  assert.ok(
    tests < implementation * 2,
    `${tests} tests vs ${implementation} implementation`,
  );
});
