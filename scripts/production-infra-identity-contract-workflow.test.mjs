#!/usr/bin/env node
import assert from "node:assert/strict";
import { validFixtureFiles } from "./production-infra-identity-contract-fixtures.mjs";
import { validateWorkflowContract } from "./production-infra-identity-contract-workflow.mjs";

const workflowPath = ".github/workflows/alerts-rules.yml";
const validCheckoutStep =
  "      - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0";
const validProtectionStep = `      - name: Verify production-infra environment protection
        run: node scripts/verify-github-environment-protection.mjs`;
const validAuthStep = `      - uses: google-github-actions/auth@pinned
        with:
          workload_identity_provider: \${{ vars.GCP_PRODUCTION_INFRA_WORKLOAD_IDENTITY_PROVIDER }}
          service_account: \${{ vars.GCP_PRODUCTION_INFRA_SERVICE_ACCOUNT }}`;
const githubTokenEnvironmentKey = ["GITHUB", "TOKEN"].join("_");
const validApplyHeader = `  apply:
    environment:
      name: production-infra
    runs-on: ubuntu-latest`;

function validate(files) {
  const errors = [];
  validateWorkflowContract(files, errors);
  return errors;
}

function expectFailure(files, expectedMessage) {
  const errors = validate(files);
  assert(
    errors.some((error) => error.includes(expectedMessage)),
    `expected workflow-contract failure containing "${expectedMessage}", got:\n${errors.join("\n")}`,
  );
}

function replaceWorkflow(files, from, to) {
  const contents = files[workflowPath];
  assert(contents.includes(from), `fixture mutation source missing:\n${from}`);
  return {
    ...files,
    [workflowPath]: contents.replace(from, to),
  };
}

const validFiles = validFixtureFiles();
assert.deepEqual(validate(validFiles), []);
assert.deepEqual(
  validate(
    replaceWorkflow(
      validFiles,
      validProtectionStep,
      `      - name: Verify production-infra environment protection
        env:
          ${githubTokenEnvironmentKey}: \${{ github.token }}
          GITHUB_ENVIRONMENT_NAME: production-infra
        run: node scripts/verify-github-environment-protection.mjs`,
    ),
  ),
  [],
);

expectFailure(
  replaceWorkflow(
    validFiles,
    validAuthStep,
    `      - uses: google-github-actions/auth@pinned
        env:
          workload_identity_provider: \${{ vars.GCP_PRODUCTION_INFRA_WORKLOAD_IDENTITY_PROVIDER }}
          service_account: \${{ vars.GCP_PRODUCTION_INFRA_SERVICE_ACCOUNT }}
        with:
          workload_identity_provider: projects/wrong/providers/provider
          service_account: wrong@example.com`,
  ),
  "apply auth must use only the production provider and service account variables",
);

expectFailure(
  replaceWorkflow(
    validFiles,
    "          service_account: ${{ vars.GCP_PRODUCTION_INFRA_SERVICE_ACCOUNT }}",
    "          service_account: wrong@example.com",
  ),
  "apply auth must use only the production provider and service account variables",
);

expectFailure(
  replaceWorkflow(
    validFiles,
    validAuthStep,
    `      - uses: google-github-actions/auth@pinned
        with: *production_credentials`,
  ),
  "workflow YAML must be valid and duplicate-free",
);

expectFailure(
  replaceWorkflow(
    validFiles,
    "          service_account: ${{ vars.GCP_PRODUCTION_INFRA_SERVICE_ACCOUNT }}",
    "          service_account: ${{ vars.GCP_PRODUCTION_INFRA_SERVICE_ACCOUNT }}\n          credentials_json: decoy",
  ),
  "apply auth must use only the production provider and service account variables",
);

expectFailure(
  replaceWorkflow(
    validFiles,
    validAuthStep,
    `${validAuthStep}
        with:
          workload_identity_provider: \${{ vars.GCP_PRODUCTION_INFRA_WORKLOAD_IDENTITY_PROVIDER }}
          service_account: \${{ vars.GCP_PRODUCTION_INFRA_SERVICE_ACCOUNT }}`,
  ),
  "workflow YAML must be valid and duplicate-free",
);

expectFailure(
  replaceWorkflow(
    validFiles,
    validProtectionStep,
    `      - name: node scripts/verify-github-environment-protection.mjs
        run: echo skipped`,
  ),
  "must verify environment protection exactly once before Google authentication",
);

expectFailure(
  replaceWorkflow(
    validFiles,
    validCheckoutStep,
    "      - uses: actions/checkout@main",
  ),
  "must verify environment protection exactly once before Google authentication",
);

expectFailure(
  replaceWorkflow(
    validFiles,
    validCheckoutStep,
    `${validCheckoutStep}
        with:
          path: decoy`,
  ),
  "must verify environment protection exactly once before Google authentication",
);

for (const variableName of ["PATH", "NODE_OPTIONS", "BASH_ENV"]) {
  expectFailure(
    replaceWorkflow(
      validFiles,
      "jobs:",
      `env:
  ${variableName}: ./attacker
jobs:`,
    ),
    "workflow env must be absent",
  );

  expectFailure(
    replaceWorkflow(
      validFiles,
      validApplyHeader,
      `${validApplyHeader}
    env:
      ${variableName}: ./attacker`,
    ),
    "apply job env may contain only TF_VAR_ variables",
  );
}

expectFailure(
  replaceWorkflow(
    validFiles,
    `${validCheckoutStep}
${validProtectionStep}`,
    `${validCheckoutStep}
      - run: echo executable-before-verifier
${validProtectionStep}`,
  ),
  "must verify environment protection exactly once before Google authentication",
);

expectFailure(
  replaceWorkflow(
    validFiles,
    "        run: node scripts/verify-github-environment-protection.mjs",
    "        run: node scripts/verify-github-environment-protection.mjs\n          || true",
  ),
  "must verify environment protection exactly once before Google authentication",
);

expectFailure(
  replaceWorkflow(
    validFiles,
    "        run: node scripts/verify-github-environment-protection.mjs",
    "        run: node scripts/verify-github-environment-protection.mjs || true",
  ),
  "must verify environment protection exactly once before Google authentication",
);

expectFailure(
  replaceWorkflow(
    validFiles,
    validProtectionStep,
    `      - name: Verify production-infra environment protection
        env:
          NODE_OPTIONS: --require=./scripts/exit-zero.cjs
        run: node scripts/verify-github-environment-protection.mjs`,
  ),
  "must verify environment protection exactly once before Google authentication",
);

expectFailure(
  replaceWorkflow(
    validFiles,
    validProtectionStep,
    `      - name: Verify production-infra environment protection
        working-directory: decoy
        run: node scripts/verify-github-environment-protection.mjs`,
  ),
  "must verify environment protection exactly once before Google authentication",
);

expectFailure(
  replaceWorkflow(
    validFiles,
    validProtectionStep,
    `${validProtectionStep}
        timeout-minutes: 1`,
  ),
  "must verify environment protection exactly once before Google authentication",
);

expectFailure(
  replaceWorkflow(
    validFiles,
    validProtectionStep,
    `${validProtectionStep}
        continue-on-error: true`,
  ),
  "must verify environment protection exactly once before Google authentication",
);

expectFailure(
  replaceWorkflow(
    validFiles,
    validAuthStep,
    `      - uses: google-github-actions/auth@pinned
        if: false
        with:
          workload_identity_provider: \${{ vars.GCP_PRODUCTION_INFRA_WORKLOAD_IDENTITY_PROVIDER }}
          service_account: \${{ vars.GCP_PRODUCTION_INFRA_SERVICE_ACCOUNT }}`,
  ),
  "apply auth must use only the production provider and service account variables",
);

expectFailure(
  replaceWorkflow(
    validFiles,
    validAuthStep,
    `      - uses: google-github-actions/auth@pinned
        continue-on-error: true
        with:
          workload_identity_provider: \${{ vars.GCP_PRODUCTION_INFRA_WORKLOAD_IDENTITY_PROVIDER }}
          service_account: \${{ vars.GCP_PRODUCTION_INFRA_SERVICE_ACCOUNT }}`,
  ),
  "apply auth must use only the production provider and service account variables",
);

expectFailure(
  replaceWorkflow(
    validFiles,
    validAuthStep,
    `      - uses: google-github-actions/auth@pinned
        timeout-minutes: 1
        with:
          workload_identity_provider: \${{ vars.GCP_PRODUCTION_INFRA_WORKLOAD_IDENTITY_PROVIDER }}
          service_account: \${{ vars.GCP_PRODUCTION_INFRA_SERVICE_ACCOUNT }}`,
  ),
  "apply auth must use only the production provider and service account variables",
);

expectFailure(
  replaceWorkflow(
    validFiles,
    validApplyHeader,
    `${validApplyHeader}
    defaults:
      run:
        shell: /bin/true {0}`,
  ),
  "must verify environment protection exactly once before Google authentication",
);

expectFailure(
  replaceWorkflow(
    validFiles,
    "jobs:",
    `defaults:
  run:
    shell: /bin/true {0}
jobs:`,
  ),
  "must verify environment protection exactly once before Google authentication",
);

expectFailure(
  replaceWorkflow(
    validFiles,
    validApplyHeader,
    `${validApplyHeader}
    defaults:
      run:
        working-directory: decoy`,
  ),
  "must verify environment protection exactly once before Google authentication",
);

expectFailure(
  replaceWorkflow(
    validFiles,
    "    environment:\n      name: production-infra",
    "    environment: production-infra\n      staging",
  ),
  "apply job must use exactly the production-infra environment",
);

expectFailure(
  replaceWorkflow(
    validFiles,
    "      name: production-infra",
    "      name: production-infra\u00a0",
  ),
  "apply job must use exactly the production-infra environment",
);

expectFailure(
  replaceWorkflow(
    validFiles,
    "          service_account: ${{ vars.GCP_PRODUCTION_INFRA_SERVICE_ACCOUNT }}",
    "          service_account: ${{ vars.GCP_PRODUCTION_INFRA_SERVICE_ACCOUNT }}\u00a0",
  ),
  "apply auth must use only the production provider and service account variables",
);

expectFailure(
  replaceWorkflow(
    validFiles,
    `${validProtectionStep}
${validAuthStep}`,
    `${validProtectionStep}
      - run: echo intervening
${validAuthStep}`,
  ),
  "must verify environment protection exactly once before Google authentication",
);

expectFailure(
  replaceWorkflow(
    validFiles,
    "    environment:\n      name: production-infra",
    "    environment:\n      name: production-infra\n    environment: unprotected",
  ),
  "workflow YAML must be valid and duplicate-free",
);

expectFailure(
  replaceWorkflow(
    validFiles,
    "    environment:\n      name: production-infra",
    '    environment:\n      name: production-infra\n    "environment": unprotected',
  ),
  "workflow YAML must be valid and duplicate-free",
);

expectFailure(
  replaceWorkflow(
    validFiles,
    "      name: production-infra",
    "      name: production-infra\n      name: unprotected",
  ),
  "workflow YAML must be valid and duplicate-free",
);

expectFailure(
  {
    ...validFiles,
    [workflowPath]: `${validFiles[workflowPath]}
  apply:
    environment: unprotected
    runs-on: ubuntu-latest
    steps:
      - run: echo bypass
`,
  },
  "workflow YAML must be valid and duplicate-free",
);

expectFailure(
  {
    ...validFiles,
    [workflowPath]: `${validFiles[workflowPath]}    steps:
      - run: echo bypass
`,
  },
  "workflow YAML must be valid and duplicate-free",
);

console.log(
  "production infrastructure identity workflow contract tests passed",
);
