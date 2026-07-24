#!/usr/bin/env node
import assert from "node:assert/strict";
import { dump as dumpYaml, load as loadYaml } from "js-yaml";
import { GOOGLE_AUTH_ACTION, PLAN_JOB_CONDITION } from "./constants.mjs";
import { validFixtureFiles } from "./fixtures.mjs";
import { validateWorkflowContract } from "./workflow.mjs";

const alertsRules = ".github/workflows/alerts-rules.yml";
const alertsInfra = ".github/workflows/alerts-infra.yml";
const drift = ".github/workflows/terraform-drift.yml";
const trustedCondition =
  "github.ref == 'refs/heads/main' && (github.event_name == 'push' || github.event_name == 'workflow_dispatch')";
const refreshTarget =
  "org-terraform-refresh-readonly@mento-terraform-seed-ffac.iam.gserviceaccount.com";
const providerTarget =
  "${{ github.event_name == 'pull_request' && 'org-terraform-plan-readonly@mento-terraform-seed-ffac.iam.gserviceaccount.com' || 'org-terraform-refresh-readonly@mento-terraform-seed-ffac.iam.gserviceaccount.com' }}";

function validate(files) {
  const errors = [];
  validateWorkflowContract(files, errors);
  return errors;
}

function mutate(files, filePath, from, to, occurrence = 0) {
  const contents = files[filePath];
  let index = -1;
  for (let count = 0; count <= occurrence; count += 1) {
    index = contents.indexOf(from, index + 1);
    assert(index >= 0, `${filePath}: fixture mutation source missing: ${from}`);
  }
  return {
    ...files,
    [filePath]: `${contents.slice(0, index)}${to}${contents.slice(index + from.length)}`,
  };
}

function expectFailure(files, expectedMessage) {
  const errors = validate(files);
  assert(
    errors.some((error) => error.includes(expectedMessage)),
    `expected refresh-routing failure containing "${expectedMessage}", got:\n${errors.join("\n")}`,
  );
}

function mutateParsed(files, filePath, mutateWorkflow) {
  const workflow = loadYaml(files[filePath]);
  mutateWorkflow(workflow);
  return {
    ...files,
    [filePath]: dumpYaml(workflow, {
      lineWidth: -1,
      noCompatMode: true,
      noRefs: true,
    }),
  };
}

const validFiles = validFixtureFiles();
assert.deepEqual(validate(validFiles), []);
assert.equal(
  loadYaml(validFiles[alertsRules]).jobs.plan.if,
  PLAN_JOB_CONDITION,
);

for (const condition of [
  true,
  `${PLAN_JOB_CONDITION}\n|| github.event_name == 'workflow_dispatch'`,
]) {
  expectFailure(
    mutateParsed(validFiles, alertsRules, (workflow) => {
      workflow.jobs.plan.if = condition;
    }),
    "plan job must use the exact eligible-PR and trusted-main guard",
  );
}

expectFailure(
  mutateParsed(validFiles, alertsRules, (workflow) => {
    const auth = workflow.jobs.plan.steps.find(
      (step) =>
        step.with?.service_account ===
        "${{ secrets.GCP_SERVICE_ACCOUNT_PLAN }}",
    );
    auth.uses = "google-github-actions/auth@main";
  }),
  "PR plan auth must use the generic provider and state-only account",
);

expectFailure(
  mutateParsed(validFiles, alertsRules, (workflow) => {
    const auth = workflow.jobs.plan.steps.find(
      (step) =>
        step.with?.service_account ===
        "${{ vars.GCP_TERRAFORM_REFRESH_SERVICE_ACCOUNT }}",
    );
    assert.equal(auth.uses, GOOGLE_AUTH_ACTION);
    auth.uses = "google-github-actions/auth@main";
  }),
  "trusted-main auth must use the refresh variables",
);

expectFailure(
  mutate(
    validFiles,
    alertsRules,
    `        if: ${trustedCondition}`,
    "        if: github.event_name == 'pull_request'",
  ),
  "trusted-main auth must use the refresh variables",
);

expectFailure(
  mutate(
    validFiles,
    alertsRules,
    `impersonate_service_account=${refreshTarget}`,
    "impersonate_service_account=org-terraform@mento-terraform-seed-ffac.iam.gserviceaccount.com",
  ),
  "trusted-main init must use its read-only backend identity",
);

expectFailure(
  mutate(
    validFiles,
    alertsRules,
    "-lock=false -refresh=false -target=terraform_data.pr_plan_secretless_guard",
    "-lock=false -target=terraform_data.pr_plan_secretless_guard",
  ),
  "PR plans must keep targets",
);

expectFailure(
  mutateParsed(validFiles, alertsRules, (workflow) => {
    const plan = workflow.jobs.plan.steps.find((step) => step.name === "Plan");
    plan.run = plan.run.replace(
      "-lock=false -refresh=false",
      "-lock=false # -refresh=false",
    );
  }),
  "PR plans must keep targets",
);

expectFailure(
  mutateParsed(validFiles, alertsRules, (workflow) => {
    workflow.jobs.plan.env = {
      TF_CLI_ARGS_plan: "-refresh=false",
    };
  }),
  "plan job must not reference the TF_CLI_ control namespace",
);

expectFailure(
  mutateParsed(validFiles, alertsRules, (workflow) => {
    const plan = workflow.jobs.plan.steps.find((step) => step.name === "Plan");
    plan.env.TF_CLI_ARGS = "-refresh=false";
  }),
  "plan job must not reference the TF_CLI_ control namespace",
);

assert.deepEqual(
  validate(
    mutateParsed(validFiles, alertsRules, (workflow) => {
      const plan = workflow.jobs.plan.steps.find(
        (step) => step.name === "Plan",
      );
      plan.run = plan.run.replace(
        "set +e",
        "# TF_CLI_ARGS is forbidden\nset +e",
      );
    }),
  ),
  [],
);

expectFailure(
  mutateParsed(validFiles, alertsRules, (workflow) => {
    const plan = workflow.jobs.plan.steps.find((step) => step.name === "Plan");
    plan.run = plan.run.replace(
      "set +e",
      'export TF_CLI_"ARGS_plan"=-refresh=false\nset +e',
    );
  }),
  "plan job must not reference the TF_CLI_ control namespace",
);

expectFailure(
  mutate(
    validFiles,
    alertsRules,
    " -target=grafana_rule_group.trading_modes",
    "",
  ),
  "PR plans must keep targets",
);

expectFailure(
  mutate(
    validFiles,
    alertsRules,
    "-lock=false > /tmp/tf-plan.raw",
    "-lock-timeout=2m > /tmp/tf-plan.raw",
  ),
  "trusted-main must full-refresh with -lock=false",
);

expectFailure(
  mutate(
    validFiles,
    alertsRules,
    "-lock=false > /tmp/tf-plan.raw",
    "-lock=false -refresh=false > /tmp/tf-plan.raw",
  ),
  "trusted-main must full-refresh with -lock=false",
);

expectFailure(
  mutate(
    validFiles,
    alertsInfra,
    providerTarget,
    providerTarget.replace(
      refreshTarget,
      "org-terraform@mento-terraform-seed-ffac.iam.gserviceaccount.com",
    ),
  ),
  "Google provider plans must select the PR or refresh identity",
);

expectFailure(
  mutate(
    validFiles,
    alertsInfra,
    "          service_account: ${{ vars.GCP_TERRAFORM_REFRESH_SERVICE_ACCOUNT }}",
    "          service_account: ${{ secrets.GCP_SERVICE_ACCOUNT }}",
  ),
  "plan paths must not use a write identity",
);

expectFailure(
  mutate(
    validFiles,
    drift,
    `    if: github.ref == 'refs/heads/main' && needs.discover.outputs.has-stacks == 'true'`,
    "    if: needs.discover.outputs.has-stacks == 'true'",
  ),
  "drift-check must be restricted to main",
);

expectFailure(
  mutate(
    validFiles,
    drift,
    `      TF_VAR_terraform_service_account: ${refreshTarget}`,
    "      TF_VAR_terraform_service_account: org-terraform@mento-terraform-seed-ffac.iam.gserviceaccount.com",
  ),
  "drift must use the refresh backend and provider identity",
);

expectFailure(
  mutate(
    validFiles,
    drift,
    "    runs-on: ubuntu-latest",
    "    runs-on: ubuntu-latest\n    planSa: readonly",
  ),
  "drift must full-refresh every stack with -lock=false",
);

expectFailure(
  mutateParsed(validFiles, drift, (workflow) => {
    workflow.jobs["drift-check"].env.TF_CLI_ARGS_plan = "-refresh=false";
  }),
  "drift-check must not reference the TF_CLI_ control namespace",
);

expectFailure(
  mutateParsed(validFiles, drift, (workflow) => {
    workflow.env = { TF_CLI_ARGS: "-refresh=false" };
  }),
  "drift-check must not reference the TF_CLI_ control namespace",
);

expectFailure(
  mutate(
    validFiles,
    drift,
    "-lock=false > /tmp/tf-plan.raw",
    "-lock-timeout=2m > /tmp/tf-plan.raw",
  ),
  "drift must full-refresh every stack with -lock=false",
);

expectFailure(
  mutate(
    validFiles,
    alertsRules,
    "      - name: Plan\n",
    `      - name: Leak refresh selector
        env:
          LEAK: \${{ vars.GCP_TERRAFORM_REFRESH_SERVICE_ACCOUNT }}
        run: echo ignored
      - name: Plan
`,
  ),
  "both refresh identity variables must appear exactly once",
);

console.log("production infrastructure refresh routing tests passed");
