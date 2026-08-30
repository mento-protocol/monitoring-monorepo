#!/usr/bin/env node

import assert from "node:assert/strict";

import { collectMainRulesets, runCli } from "./read-main-rulesets.mjs";

const REPOSITORY = "mento-protocol/monitoring-monorepo";
const ENVIRONMENT = {
  can_admins_bypass: false,
  deployment_branch_policy: {
    custom_branch_policies: true,
    protected_branches: false,
  },
  name: "dependabot-merge",
};
const DEPLOYMENT_POLICIES = {
  branch_policies: [{ id: 71, name: "main", type: "branch" }],
  total_count: 1,
};
const ENVIRONMENT_SECRETS = {
  secrets: [
    { name: "DEPENDABOT_MERGE_APP_ID" },
    { name: "DEPENDABOT_MERGE_APP_PRIVATE_KEY" },
  ],
  total_count: 2,
};

function fixtureRunner({
  deploymentPolicies = DEPLOYMENT_POLICIES,
  details = new Map(),
  environment = ENVIRONMENT,
  environmentSecrets = ENVIRONMENT_SECRETS,
  pages = [[]],
} = {}) {
  const calls = [];
  const runGh = (args) => {
    calls.push(args);
    if (args.includes("--paginate")) return JSON.stringify(pages);
    const path = args.at(-1);
    let value;
    if (path.includes("/deployment-branch-policies?")) {
      value = deploymentPolicies;
    } else if (path.endsWith("/secrets?per_page=100")) {
      value = environmentSecrets;
    } else if (path.endsWith("/environments/dependabot-merge")) {
      value = environment;
    } else {
      const id = Number(path.split("/").at(-1));
      if (!details.has(id)) throw new Error("SENSITIVE_DETAIL_ERROR_CANARY");
      value = details.get(id);
    }
    if (value instanceof Error) throw value;
    return typeof value === "string" ? value : JSON.stringify(value);
  };
  return { calls, runGh };
}

const paginated = fixtureRunner({
  pages: [[{ id: 11 }], [{ id: 22 }]],
  details: new Map([
    [11, { id: 11, name: "main" }],
    [22, { id: 22, name: "controlled-main-lifecycle" }],
  ]),
});
assert.deepEqual(
  collectMainRulesets({ repository: REPOSITORY, runGh: paginated.runGh }),
  {
    dependabotMergeDeploymentBranchPolicies: [
      { id: 71, name: "main", type: "branch" },
    ],
    dependabotMergeEnvironment: ENVIRONMENT,
    dependabotMergeEnvironmentSecretNames: [
      "DEPENDABOT_MERGE_APP_ID",
      "DEPENDABOT_MERGE_APP_PRIVATE_KEY",
    ],
    rulesets: [
      { id: 11, name: "main" },
      { id: 22, name: "controlled-main-lifecycle" },
    ],
  },
);
assert.deepEqual(paginated.calls[0], [
  "api",
  "--paginate",
  "--slurp",
  `repos/${REPOSITORY}/rulesets?includes_parents=false&per_page=100`,
]);
assert.deepEqual(paginated.calls.slice(1), [
  ["api", `repos/${REPOSITORY}/environments/dependabot-merge`],
  [
    "api",
    `repos/${REPOSITORY}/environments/dependabot-merge/deployment-branch-policies?per_page=100`,
  ],
  [
    "api",
    `repos/${REPOSITORY}/environments/dependabot-merge/secrets?per_page=100`,
  ],
  ["api", `repos/${REPOSITORY}/rulesets/11`],
  ["api", `repos/${REPOSITORY}/rulesets/22`],
]);

function expectFailure(options, expected) {
  assert.throws(
    () => collectMainRulesets({ repository: REPOSITORY, ...options }),
    (error) => error.message === expected,
  );
}

for (const pages of [
  [{ id: 1 }],
  [[{ id: "1" }]],
  [[{ id: 0 }]],
  [[{ id: 1 }, { id: 1 }]],
]) {
  const fixture = fixtureRunner({ pages });
  expectFailure(
    { runGh: fixture.runGh },
    Array.isArray(pages[0])
      ? "repository ruleset list contained an invalid or duplicate ID"
      : "repository ruleset list had an unexpected shape",
  );
}

expectFailure(
  { runGh: () => "not json" },
  "repository ruleset list was not valid JSON",
);
expectFailure(
  {
    runGh: () =>
      JSON.stringify([
        Array.from({ length: 101 }, (_, index) => ({ id: index + 1 })),
      ]),
  },
  "repository ruleset list exceeded the safety limit",
);

for (const [options, expected] of [
  [
    { environment: { ...ENVIRONMENT, name: "wrong" } },
    "Dependabot merge Environment did not match its requested name",
  ],
  [
    {
      deploymentPolicies: {
        branch_policies: DEPLOYMENT_POLICIES.branch_policies,
        total_count: 2,
      },
    },
    "Dependabot merge deployment-policy list count or pagination shape was inconsistent",
  ],
  [
    {
      deploymentPolicies: {
        branch_policies: [{ id: 0, name: "main", type: "branch" }],
        total_count: 1,
      },
    },
    "Dependabot merge deployment-policy list contained malformed metadata",
  ],
  [
    {
      environmentSecrets: {
        secrets: ENVIRONMENT_SECRETS.secrets,
        total_count: 3,
      },
    },
    "Dependabot merge Environment secret list count or pagination shape was inconsistent",
  ],
  [
    {
      environmentSecrets: {
        secrets: [
          { name: "DEPENDABOT_MERGE_APP_ID" },
          { name: "DEPENDABOT_MERGE_APP_ID" },
        ],
        total_count: 2,
      },
    },
    "Dependabot merge Environment secret list contained malformed or duplicate names",
  ],
]) {
  const fixture = fixtureRunner(options);
  expectFailure({ runGh: fixture.runGh }, expected);
}

const oversizedCapture = fixtureRunner({
  pages: [[{ id: 1 }, { id: 2 }]],
  details: new Map([
    [1, { id: 1, name: "x".repeat(8 * 1024 * 1024) }],
    [2, { id: 2, name: "y".repeat(8 * 1024 * 1024) }],
  ]),
});
expectFailure(
  { runGh: oversizedCapture.runGh },
  "repository ruleset capture exceeded the total safety limit",
);
expectFailure(
  {
    runGh: () => {
      throw new Error("SENSITIVE_LIST_ERROR_CANARY");
    },
  },
  "could not list repository rulesets",
);

const detailFailure = fixtureRunner({
  pages: [[{ id: 7 }]],
  details: new Map([[7, new Error("SENSITIVE_DETAIL_ERROR_CANARY")]]),
});
expectFailure(
  { runGh: detailFailure.runGh },
  "could not read a repository ruleset detail",
);

const malformedDetail = fixtureRunner({
  pages: [[{ id: 7 }]],
  details: new Map([[7, "not json"]]),
});
expectFailure(
  { runGh: malformedDetail.runGh },
  "repository ruleset detail was not valid JSON",
);

const mismatchedDetail = fixtureRunner({
  pages: [[{ id: 7 }]],
  details: new Map([[7, { id: 8 }]]),
});
expectFailure(
  { runGh: mismatchedDetail.runGh },
  "repository ruleset detail did not match its requested ID",
);

assert.throws(
  () => collectMainRulesets({ repository: "invalid", runGh: () => "[]" }),
  /repository identity is missing or malformed/u,
);

let stdout = "";
let stderr = "";
const cliFailure = runCli({
  environment: { REPO: REPOSITORY },
  runGh: () => {
    throw new Error("SENSITIVE_CLI_ERROR_CANARY");
  },
  stderr: { write: (value) => (stderr += value) },
  stdout: { write: (value) => (stdout += value) },
});
assert.equal(cliFailure, 1);
assert.equal(stdout, "");
assert.match(stderr, /could not list repository rulesets/u);
assert.doesNotMatch(stderr, /SENSITIVE_CLI_ERROR_CANARY/u);

stdout = "";
stderr = "";
const cliFixture = fixtureRunner({
  pages: [[{ id: 11 }]],
  details: new Map([[11, { id: 11, name: "main" }]]),
});
const cliSuccess = runCli({
  environment: { REPO: REPOSITORY },
  runGh: cliFixture.runGh,
  stderr: { write: (value) => (stderr += value) },
  stdout: { write: (value) => (stdout += value) },
});
assert.equal(cliSuccess, 0);
assert.equal(stderr, "");
assert.deepEqual(JSON.parse(stdout), {
  dependabotMergeDeploymentBranchPolicies: [
    { id: 71, name: "main", type: "branch" },
  ],
  dependabotMergeEnvironment: ENVIRONMENT,
  dependabotMergeEnvironmentSecretNames: [
    "DEPENDABOT_MERGE_APP_ID",
    "DEPENDABOT_MERGE_APP_PRIVATE_KEY",
  ],
  rulesets: [{ id: 11, name: "main" }],
});

stderr = "";
const outputFailure = runCli({
  environment: { REPO: REPOSITORY },
  runGh: cliFixture.runGh,
  stderr: { write: (value) => (stderr += value) },
  stdout: {
    write: () => {
      throw new Error("SENSITIVE_OUTPUT_ERROR_CANARY");
    },
  },
});
assert.equal(outputFailure, 1);
assert.match(stderr, /unexpected repository ruleset capture failure/u);
assert.doesNotMatch(stderr, /SENSITIVE_OUTPUT_ERROR_CANARY/u);
