#!/usr/bin/env node
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { validFixtureFiles } from "./production-infra-identity-contract-fixtures.mjs";
import { validateWorkflowContract } from "./production-infra-identity-contract-workflow.mjs";

const workflowPath = ".github/workflows/alerts-rules.yml";
const validCheckoutStep =
  "      - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0";
const validProtectionStep = `      - name: Verify production-infra environment protection
        env:
          GITHUB_TOKEN: \${{ github.token }}
          GITHUB_ENVIRONMENT_NAME: production-infra
        run: node "$GITHUB_WORKSPACE/scripts/verify-github-environment-protection.mjs"`;
const validAuthStep = `      - name: Authenticate to Google Cloud
        uses: google-github-actions/auth@7c6bc770dae815cd3e89ee6cdf493a5fab2cc093
        with:
          workload_identity_provider: \${{ vars.GCP_PRODUCTION_INFRA_WORKLOAD_IDENTITY_PROVIDER }}
          service_account: \${{ vars.GCP_PRODUCTION_INFRA_SERVICE_ACCOUNT }}`;
const escapedProductionProviderDot =
  '"${{ vars.GCP_PRODUCTION_INFRA_WORKLOAD_IDENTITY_PROV\\u0049DER }}"';
const escapedProductionServiceAccountDot =
  '"${{ vars.GCP_PRODUCTION_INFRA_SERVICE_\\u0041CCOUNT }}"';
const escapedProductionServiceAccountBracket =
  '"${{ vars[\\"GCP_PRODUCTION_INFRA_SERVICE_\\u0041CCOUNT\\"] }}"';
const escapedRefreshServiceAccountDot =
  '"${{ vars.GCP_TERRAFORM_REFRESH_SERVICE_\\u0041CCOUNT }}"';
const validProductionEnvironment = `    environment:
      name: production-infra
      url: https://console.cloud.google.com/home/dashboard?project=mento-terraform-seed-ffac`;
const validApplyDefaults = `    defaults:
      run:
        working-directory: alerts/rules`;
const validApplyEnvironment = `    env:
      TF_VAR_grafana_service_account_token: \${{ secrets.TF_VAR_GRAFANA_SERVICE_ACCOUNT_TOKEN }}`;

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

function liveWorkflowFiles() {
  const workflowDirectory = new URL("../.github/workflows/", import.meta.url);
  const workflowFiles = Object.fromEntries(
    readdirSync(workflowDirectory)
      .filter((fileName) => /\.ya?ml$/u.test(fileName))
      .map((fileName) => [
        `.github/workflows/${fileName}`,
        readFileSync(new URL(fileName, workflowDirectory), "utf8"),
      ]),
  );
  return {
    ...workflowFiles,
    "scripts/sanitize-terraform-output.sh": readFileSync(
      new URL("./sanitize-terraform-output.sh", import.meta.url),
      "utf8",
    ),
    "scripts/verify-github-environment-protection.mjs": readFileSync(
      new URL("./verify-github-environment-protection.mjs", import.meta.url),
      "utf8",
    ),
  };
}

const validFiles = validFixtureFiles();
assert.deepEqual(validate(validFiles), []);
assert.deepEqual(validate(liveWorkflowFiles()), []);

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
      validApplyEnvironment,
      `    env:
      ${variableName}: ./attacker
      TF_VAR_grafana_service_account_token: \${{ secrets.TF_VAR_GRAFANA_SERVICE_ACCOUNT_TOKEN }}`,
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
    '        run: node "$GITHUB_WORKSPACE/scripts/verify-github-environment-protection.mjs"',
    '        run: node "$GITHUB_WORKSPACE/scripts/verify-github-environment-protection.mjs"\n          || true',
  ),
  "must verify environment protection exactly once before Google authentication",
);

expectFailure(
  replaceWorkflow(
    validFiles,
    '        run: node "$GITHUB_WORKSPACE/scripts/verify-github-environment-protection.mjs"',
    '        run: node "$GITHUB_WORKSPACE/scripts/verify-github-environment-protection.mjs" || true',
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
    validApplyDefaults,
    `${validApplyDefaults}
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
    validApplyDefaults,
    `    defaults:
      run:
        working-directory: decoy`,
  ),
  "apply job must match the exact protected semantic inventory",
);

expectFailure(
  replaceWorkflow(
    validFiles,
    validProductionEnvironment,
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

expectFailure(
  {
    ...validFiles,
    [workflowPath]: `${validFiles[workflowPath]}  shadow:
    environment: production-infra
    permissions:
      id-token: write
    runs-on: ubuntu-latest
    steps:
      - uses: google-github-actions/auth@7c6bc770dae815cd3e89ee6cdf493a5fab2cc093
        with:
          workload_identity_provider: ${escapedProductionProviderDot}
          service_account: ${escapedProductionServiceAccountDot}
`,
  },
  "production identity variables must appear exactly once and only in the apply auth step",
);

expectFailure(
  {
    ...validFiles,
    ".github/workflows/unlisted-escaped-selector.yml": `jobs:
  consume:
    runs-on: ubuntu-latest
    env:
      BAD: ${escapedProductionServiceAccountBracket}
`,
  },
  "production identity variables are allowed only in a protected apply auth step",
);

expectFailure(
  {
    ...validFiles,
    ".github/workflows/unlisted-escaped-key.yml": `jobs:
  consume:
    runs-on: ubuntu-latest
    env:
      ${escapedProductionProviderDot}: harmless
`,
  },
  "production identity variables are allowed only in a protected apply auth step",
);

expectFailure(
  {
    ...validFiles,
    ".github/workflows/unlisted-escaped-refresh.yml": `jobs:
  consume:
    runs-on: ubuntu-latest
    env:
      BAD: ${escapedRefreshServiceAccountDot}
`,
  },
  "must not be used during bootstrap",
);

expectFailure(
  replaceWorkflow(
    validFiles,
    validAuthStep,
    `${validAuthStep}
      - name: Hidden production mutation
        run: gcloud projects add-iam-policy-binding mento-monitoring --member=serviceAccount:attacker@example.com --role=roles/owner`,
  ),
  "apply job must match the exact protected semantic inventory",
);

expectFailure(
  replaceWorkflow(
    validFiles,
    "      - name: Set up Cloud SDK\n        uses: google-github-actions/setup-gcloud@aa5489c8933f4cc7a4f7d45035b3b1440c9c10db",
    "      - name: Set up Cloud SDK\n        uses: attacker/setup-gcloud@0123456789012345678901234567890123456789",
  ),
  "apply job must match the exact protected semantic inventory",
);

expectFailure(
  replaceWorkflow(
    validFiles,
    "      - name: Init\n        run: terraform init -input=false",
    "      - name: Init\n        run: terraform init -input=false && gcloud projects add-iam-policy-binding mento-monitoring",
  ),
  "apply job must match the exact protected semantic inventory",
);

const indirectBackdoorFiles = {
  ...validFiles,
  ".github/workflows/indirect-production-backdoor.yml": `jobs:
  mutate:
    environment: production-infra
    permissions:
      contents: read
      id-token: write
    runs-on: ubuntu-latest
    steps:
      - name: Export repository variables
        env:
          ALL_VARS: \${{ toJSON(vars) }}
        run: echo "ALL_VARS=$ALL_VARS" >> "$GITHUB_ENV"
      - uses: google-github-actions/auth@7c6bc770dae815cd3e89ee6cdf493a5fab2cc093
        with:
          workload_identity_provider: \${{ fromJSON(env.ALL_VARS)[format('GCP_{0}_WORKLOAD_IDENTITY_PROVIDER', 'PRODUCTION_INFRA')] }}
          service_account: \${{ fromJSON(env.ALL_VARS)[format('GCP_{0}_SERVICE_ACCOUNT', 'PRODUCTION_INFRA')] }}
      - run: gcloud projects add-iam-policy-binding mento-monitoring --member=serviceAccount:attacker@example.com --role=roles/owner
`,
};
expectFailure(
  indirectBackdoorFiles,
  "workflow job environments must match the exact registered inventory",
);
expectFailure(
  indirectBackdoorFiles,
  "workflow variable selectors must be literal and must not serialize vars",
);

expectFailure(
  {
    ...validFiles,
    "scripts/sanitize-terraform-output.sh": `${validFiles["scripts/sanitize-terraform-output.sh"]}
gcloud projects add-iam-policy-binding mento-monitoring --member=serviceAccount:attacker@example.com --role=roles/owner
`,
  },
  "post-auth apply helper must match its pinned content hash",
);

expectFailure(
  {
    ...validFiles,
    "scripts/verify-github-environment-protection.mjs": `${validFiles["scripts/verify-github-environment-protection.mjs"]}
process.exit(0);
`,
  },
  "pre-auth protection verifier must match its pinned content hash",
);

console.log(
  "production infrastructure identity workflow contract tests passed",
);
