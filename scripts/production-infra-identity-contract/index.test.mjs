#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  lstatSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validFixtureFiles } from "./fixtures.mjs";
import { REFRESH_PROVIDER_CONDITION } from "./constants.mjs";
import {
  assertProductionInfraIdentityContract,
  validateProductionInfraIdentityContract,
} from "./index.mjs";
import "./security.test.mjs";
import "./workflow.test.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

function expectContractFailure(files, expectedMessage) {
  const errors = validateProductionInfraIdentityContract(files);
  assert(
    errors.some((error) => error.includes(expectedMessage)),
    `expected identity-contract failure containing "${expectedMessage}", got:\n${errors.join("\n")}`,
  );
}

function mutateFile(files, filePath, from, to) {
  assert(
    files[filePath].includes(from),
    `fixture mutation source missing: ${from}`,
  );
  return {
    ...files,
    [filePath]: files[filePath].replace(from, to),
  };
}

function mutateFileOccurrence(files, filePath, from, to, occurrence) {
  const contents = files[filePath];
  let index = -1;
  for (let count = 0; count <= occurrence; count += 1) {
    index = contents.indexOf(from, index + 1);
    assert(
      index >= 0,
      `fixture mutation occurrence ${occurrence} missing: ${from}`,
    );
  }
  return {
    ...files,
    [filePath]: `${contents.slice(0, index)}${to}${contents.slice(index + from.length)}`,
  };
}

function testOidcProviders(validFiles) {
  const oidcBlock = `  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
`;
  for (const [occurrence, label] of [
    [0, "terraform: generic GitHub WIF provider"],
    [1, "terraform: production WIF provider"],
  ]) {
    expectContractFailure(
      mutateFileOccurrence(
        validFiles,
        "terraform/ci-wif.tf",
        oidcBlock,
        "",
        occurrence,
      ),
      `${label}: provider must contain exactly one oidc block`,
    );
    expectContractFailure(
      mutateFileOccurrence(
        validFiles,
        "terraform/ci-wif.tf",
        oidcBlock,
        oidcBlock.replace(
          "https://token.actions.githubusercontent.com",
          "https://issuer.example.com",
        ),
        occurrence,
      ),
      `${label}: oidc: issuer_uri must be exactly`,
    );
    expectContractFailure(
      mutateFileOccurrence(
        validFiles,
        "terraform/ci-wif.tf",
        oidcBlock,
        `${oidcBlock}${oidcBlock}`,
        occurrence,
      ),
      `${label}: provider must contain exactly one oidc block`,
    );
  }
}

function testHeredocParsing(validFiles) {
  const realHeredocFiles = {
    ...validFiles,
    "terraform/heredoc.tf": `
locals {
  rendered = <<HCL
resource "google_iam_workload_identity_pool_provider" "heredoc_text" {
  workload_identity_pool_id = "not-a-resource"
}
HCL
}
`,
  };
  assert.deepEqual(
    validateProductionInfraIdentityContract(realHeredocFiles),
    [],
  );

  expectContractFailure(
    mutateFile(
      validFiles,
      "terraform/ci-wif.tf",
      '  account_id = "production-infra-applier"',
      `  description = <<EOF
  account_id = "production-infra-applier"
EOF`,
    ),
    "production applier: account_id must be exactly",
  );

  expectContractFailure(
    {
      ...validFiles,
      "terraform/extra.tf": `
locals {
  quoted_marker = "literal <<NOT_A_HEREDOC"
}
resource "google_iam_workload_identity_pool_provider" "quoted_marker_bypass" {
  workload_identity_pool_id = local.untrusted_pool_id
}
`,
    },
    "workload identity provider inventory must contain exactly",
  );

  expectContractFailure(
    {
      ...validFiles,
      "terraform/extra.tf": `
locals {
  broken = <<UNTERMINATED
body
}
`,
    },
    "unterminated HCL heredoc UNTERMINATED",
  );
}

function testProviderInventory(validFiles) {
  expectContractFailure(
    {
      ...validFiles,
      "terraform/extra.tf": `
resource "google_iam_workload_identity_pool_provider" "function_bypass" {
  workload_identity_pool_id = try(google_iam_workload_identity_pool.github_production_infra.workload_identity_pool_id, "fallback")
}
`,
    },
    "workload identity provider inventory must contain exactly",
  );

  expectContractFailure(
    {
      ...validFiles,
      "terraform/extra.tf": `
locals {
  aliased_pool_id = google_iam_workload_identity_pool.github_actions.workload_identity_pool_id
}
resource "google_iam_workload_identity_pool_provider" "local_alias_bypass" {
  workload_identity_pool_id = local.aliased_pool_id
}
`,
    },
    "workload identity provider inventory must contain exactly",
  );
}

function testIdentityReferenceInventory(validFiles) {
  expectContractFailure(
    {
      ...validFiles,
      "terraform/extra.tf": `
locals {
  production_applier_alias = google_service_account.production_infra_applier.email
}
`,
    },
    "production applier: identity references are allowed only",
  );

  expectContractFailure(
    {
      ...validFiles,
      "terraform/extra.tf": `
module "identity_sink" {
  source                = "./identity-sink"
  service_account_email = "org-terraform-refresh-readonly@mento-terraform-seed-ffac.iam.gserviceaccount.com"
}
`,
    },
    "refresh target: identity references are allowed only",
  );
}

function testBootstrapLegacyBinding(validFiles) {
  const binding = `resource "google_service_account_iam_member" "ci_alerts_org_terraform_token_creator" {
  service_account_id = "projects/mento-terraform-seed-ffac/serviceAccounts/\${var.terraform_service_account}"
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:\${google_service_account.metrics_bridge_deployer.email}"
}
`;
  expectContractFailure(
    mutateFile(validFiles, "terraform/ci-wif.tf", binding, ""),
    "bootstrap legacy deployer token creator: required resource",
  );
  expectContractFailure(
    mutateFile(
      validFiles,
      "terraform/ci-wif.tf",
      binding,
      binding.replace(
        "${var.terraform_service_account}",
        "org-terraform-wrong@example.invalid",
      ),
    ),
    "bootstrap legacy deployer token creator: service_account_id must be exactly",
  );
  expectContractFailure(
    mutateFile(
      validFiles,
      "terraform/ci-wif.tf",
      binding,
      binding.replace(
        "roles/iam.serviceAccountTokenCreator",
        "roles/iam.serviceAccountUser",
      ),
    ),
    "bootstrap legacy deployer token creator: role must be exactly",
  );
  expectContractFailure(
    mutateFile(
      validFiles,
      "terraform/ci-wif.tf",
      binding,
      binding.replace(
        "google_service_account.metrics_bridge_deployer.email",
        "google_service_account.production_infra_applier.email",
      ),
    ),
    "bootstrap legacy deployer token creator: member must be exactly",
  );
}

function runFixtureTests() {
  const validFiles = validFixtureFiles();
  const genericProviderCondition =
    'attribute.repository == \\"mento-protocol/monitoring-monorepo\\" && attribute.repository_id == \\"1172025835\\"';
  const productionProviderCondition =
    'assertion.repository_id == \\"1172025835\\" && assertion.repository == \\"mento-protocol/monitoring-monorepo\\" && assertion.ref == \\"refs/heads/main\\" && assertion.sub == \\"repo:mento-protocol/monitoring-monorepo:environment:production-infra\\"';
  const refreshProviderCondition = REFRESH_PROVIDER_CONDITION.replaceAll(
    '"',
    '\\"',
  );
  assert.deepEqual(validateProductionInfraIdentityContract(validFiles), []);
  testOidcProviders(validFiles);
  testHeredocParsing(validFiles);
  testProviderInventory(validFiles);
  testIdentityReferenceInventory(validFiles);
  testBootstrapLegacyBinding(validFiles);

  for (const weakenedCondition of [
    'assertion.repository == \\"mento-protocol/monitoring-monorepo\\" || true',
    'assertion.repository_id == \\"1172025835\\" && assertion.repository == \\"mento-protocol/monitoring-monorepo\\" && assertion.ref == \\"refs/heads/main\\" && (assertion.sub == \\"repo:mento-protocol/monitoring-monorepo:environment:production-infra\\" || assertion.actor == \\"trusted\\")',
  ]) {
    expectContractFailure(
      mutateFile(
        validFiles,
        "terraform/ci-wif.tf",
        productionProviderCondition,
        weakenedCondition,
      ),
      "exact non-bypassable condition",
    );
  }

  expectContractFailure(
    mutateFile(
      validFiles,
      "terraform/ci-wif.tf",
      refreshProviderCondition,
      refreshProviderCondition.replace(
        ' || assertion.workflow_ref == \\"mento-protocol/monitoring-monorepo/.github/workflows/terraform-drift.yml@refs/heads/main\\"',
        "",
      ),
    ),
    "refresh WIF provider: attribute_condition",
  );

  for (const { condition, withoutRepositoryId, wrongRepositoryId, label } of [
    {
      condition: genericProviderCondition,
      withoutRepositoryId:
        'attribute.repository == \\"mento-protocol/monitoring-monorepo\\"',
      wrongRepositoryId:
        'attribute.repository == \\"mento-protocol/monitoring-monorepo\\" && attribute.repository_id == \\"999999999\\"',
      label: "generic GitHub WIF provider",
    },
    {
      condition: productionProviderCondition,
      withoutRepositoryId:
        'assertion.repository == \\"mento-protocol/monitoring-monorepo\\" && assertion.ref == \\"refs/heads/main\\" && assertion.sub == \\"repo:mento-protocol/monitoring-monorepo:environment:production-infra\\"',
      wrongRepositoryId:
        'assertion.repository_id == \\"999999999\\" && assertion.repository == \\"mento-protocol/monitoring-monorepo\\" && assertion.ref == \\"refs/heads/main\\" && assertion.sub == \\"repo:mento-protocol/monitoring-monorepo:environment:production-infra\\"',
      label: "production WIF provider",
    },
    {
      condition: refreshProviderCondition,
      withoutRepositoryId: refreshProviderCondition.replace(
        'assertion.repository_id == \\"1172025835\\" && ',
        "",
      ),
      wrongRepositoryId: refreshProviderCondition.replace(
        'assertion.repository_id == \\"1172025835\\"',
        'assertion.repository_id == \\"999999999\\"',
      ),
      label: "refresh WIF provider",
    },
  ]) {
    for (const weakenedCondition of [withoutRepositoryId, wrongRepositoryId]) {
      expectContractFailure(
        mutateFile(
          validFiles,
          "terraform/ci-wif.tf",
          condition,
          weakenedCondition,
        ),
        `${label}: attribute_condition`,
      );
    }
  }

  const repositoryIdMapping =
    '    "attribute.repository_id" = "assertion.repository_id"';
  for (const [occurrence, label] of [
    [0, "generic GitHub WIF provider"],
    [1, "production WIF provider"],
    [2, "refresh WIF provider"],
  ]) {
    expectContractFailure(
      mutateFileOccurrence(
        validFiles,
        "terraform/ci-wif.tf",
        repositoryIdMapping,
        "",
        occurrence,
      ),
      `${label}: attribute_mapping must be exactly`,
    );
    expectContractFailure(
      mutateFileOccurrence(
        validFiles,
        "terraform/ci-wif.tf",
        repositoryIdMapping,
        repositoryIdMapping.replace(
          "assertion.repository_id",
          "assertion.repository_owner_id",
        ),
        occurrence,
      ),
      `${label}: attribute_mapping must be exactly`,
    );
  }
  expectContractFailure(
    mutateFileOccurrence(
      validFiles,
      "terraform/ci-wif.tf",
      repositoryIdMapping,
      `${repositoryIdMapping}
    "__proto__"              = "assertion.actor"`,
      0,
    ),
    "generic GitHub WIF provider: attribute_mapping must be exactly",
  );
  expectContractFailure(
    mutateFile(
      validFiles,
      "terraform/ci-wif.tf",
      '    "attribute.workflow_ref"  = "assertion.workflow_ref"',
      "",
    ),
    "refresh WIF provider: attribute_mapping must be exactly",
  );

  expectContractFailure(
    {
      ...validFiles,
      "terraform/extra.tf": `
resource "google_iam_workload_identity_pool_provider" "production_bypass" {
  workload_identity_pool_id = google_iam_workload_identity_pool.github_production_infra.workload_identity_pool_id
}
`,
    },
    "exactly one provider in the github-production-infra pool",
  );

  expectContractFailure(
    {
      ...validFiles,
      "terraform/extra.tf": `
resource "google_iam_workload_identity_pool_provider" "generic_bypass" {
  workload_identity_pool_id = google_iam_workload_identity_pool.github_actions.workload_identity_pool_id
}
`,
    },
    "exactly one provider in the github-actions pool",
  );

  expectContractFailure(
    {
      ...validFiles,
      "terraform/extra.tf": `
resource "google_iam_workload_identity_pool_provider" "refresh_bypass" {
  workload_identity_pool_id = google_iam_workload_identity_pool.github_terraform_refresh.workload_identity_pool_id
}
`,
    },
    "exactly one provider in the github-terraform-refresh pool",
  );

  expectContractFailure(
    {
      ...validFiles,
      "terraform/extra.tf": `
resource "google_project_iam_member" "production_applier_admin" {
  project = google_project.monitoring.project_id
  role    = "roles/storage.admin"
  member  = "serviceAccount:$\{google_service_account.production_infra_applier.email}"
}
`,
    },
    "production applier: unexpected IAM grants",
  );

  expectContractFailure(
    {
      ...validFiles,
      "terraform/extra.tf": `
resource "google_service_account_iam_member" "production_applier_generic_pool" {
  service_account_id = google_service_account.production_infra_applier.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/$\{google_iam_workload_identity_pool.github_actions.name}/attribute.ref/refs/heads/main"
}
`,
    },
    "production applier: unexpected IAM grants",
  );

  expectContractFailure(
    {
      ...validFiles,
      "terraform/extra.tf": `
resource "google_service_account_iam_member" "refresh_can_write" {
  service_account_id = "projects/mento-terraform-seed-ffac/serviceAccounts/org-terraform@mento-terraform-seed-ffac.iam.gserviceaccount.com"
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:$\{google_service_account.terraform_refresh_readonly.email}"
}
`,
    },
    "refresh WIF identity: unexpected IAM grants",
  );

  expectContractFailure(
    mutateFile(
      validFiles,
      "terraform/ci-wif.tf",
      `resource "google_service_account" "terraform_refresh_readonly" {
  project    = "mento-terraform-seed-ffac"
  account_id = "terraform-refresh-readonly"
}`,
      `resource "google_service_account" "terraform_refresh_readonly" {
  project    = google_project.monitoring.project_id
  account_id = "terraform-refresh-readonly"
}`,
    ),
    "refresh WIF identity: project must be exactly",
  );

  expectContractFailure(
    mutateFile(
      validFiles,
      ".github/workflows/alerts-rules.yml",
      "      - name: Authenticate to Google Cloud\n        uses: google-github-actions/auth@7c6bc770dae815cd3e89ee6cdf493a5fab2cc093\n        with:\n          workload_identity_provider: ${{ vars.GCP_PRODUCTION_INFRA_WORKLOAD_IDENTITY_PROVIDER }}\n          service_account: ${{ vars.GCP_PRODUCTION_INFRA_SERVICE_ACCOUNT }}",
      "      - name: Authenticate to Google Cloud\n        uses: google-github-actions/auth@7c6bc770dae815cd3e89ee6cdf493a5fab2cc093\n        with:\n          workload_identity_provider: ${{ vars.GCP_PRODUCTION_INFRA_WORKLOAD_IDENTITY_PROVIDER }}\n          service_account: ${{ vars.GCP_PRODUCTION_INFRA_SERVICE_ACCOUNT }}\n      - uses: google-github-actions/auth@second",
    ),
    "exactly one Google auth action",
  );

  expectContractFailure(
    mutateFile(
      validFiles,
      ".github/workflows/alerts-rules.yml",
      "          service_account: ${{ vars.GCP_PRODUCTION_INFRA_SERVICE_ACCOUNT }}",
      "          service_account: ${{ vars.GCP_PRODUCTION_INFRA_SERVICE_ACCOUNT }}\n          legacy: ${{ secrets.GCP_SERVICE_ACCOUNT }}",
    ),
    "must not fall back to a generic or plan identity",
  );

  expectContractFailure(
    {
      ...validFiles,
      ".github/workflows/unlisted.yml":
        "env:\n  BAD: ${{ vars.GCP_PRODUCTION_INFRA_SERVICE_ACCOUNT }}\n",
    },
    "production identity variables are allowed only",
  );

  expectContractFailure(
    {
      ...validFiles,
      ".github/workflows/unlisted.yaml":
        "env:\n  BAD: ${{ vars['GCP_TERRAFORM_REFRESH_SERVICE_ACCOUNT'] }}\n",
    },
    "must not be used during bootstrap",
  );

  expectContractFailure(
    {
      ...validFiles,
      ".github/workflows/unlisted-refresh-provider.yml":
        "env:\n  BAD: ${{ vars.GCP_TERRAFORM_REFRESH_WORKLOAD_IDENTITY_PROVIDER }}\n",
    },
    "must not be used during bootstrap",
  );

  expectContractFailure(
    mutateFile(
      validFiles,
      ".github/workflows/alerts-infra.yml",
      "  plan:\n    runs-on: ubuntu-latest",
      "  plan:\n    env:\n      BAD: ${{ vars.GCP_PRODUCTION_INFRA_SERVICE_ACCOUNT }}\n    runs-on: ubuntu-latest",
    ),
    "must appear exactly once and only in the apply auth step",
  );

  expectContractFailure(
    mutateFile(
      validFiles,
      "alerts/infra/main.tf",
      "project  = local.project_id",
      "project  = google_project.monitoring.project_id",
    ),
    "project must be exactly local.project_id",
  );

  expectContractFailure(
    mutateFile(
      validFiles,
      "alerts/infra/main.tf",
      '    "roles/storage.bucketViewer",',
      '    "roles/storage.admin",',
    ),
    "exact curated role set",
  );

  expectContractFailure(
    {
      ...validFiles,
      "alerts/infra/extra.tf": `
resource "google_project_iam_member" "refresh_extra" {
  project = local.project_id
  role    = "roles/viewer"
  member  = "serviceAccount:org-terraform-refresh-readonly@mento-terraform-seed-ffac.iam.gserviceaccount.com"
}
`,
    },
    "refresh target: unexpected IAM grants",
  );

  expectContractFailure(
    {
      ...validFiles,
      "terraform/extra.tf": `
resource "google_project_iam_member" "refresh_platform_viewer" {
  project = google_project.monitoring.project_id
  role    = "roles/browser"
  member  = "serviceAccount:org-terraform-refresh-readonly@mento-terraform-seed-ffac.iam.gserviceaccount.com"
}
`,
    },
    "refresh target: unexpected IAM grants",
  );

  expectContractFailure(
    mutateFile(
      validFiles,
      "alerts/infra/oncall-announcer/main.tf",
      "    splunk_api = google_secret_manager_secret.splunk_on_call_api_key.secret_id\n",
      "",
    ),
    "exact secret set",
  );

  expectContractFailure(
    mutateFile(
      validFiles,
      "governance-watchdog/infra/storage.tf",
      "google_storage_bucket.watchdog_notifications_function.name",
      "google_storage_bucket.logging.name",
    ),
    "bucket must be exactly",
  );

  expectContractFailure(
    mutateFile(
      validFiles,
      "terraform/github-variables.tf",
      "    google_storage_bucket_iam_member.state_bucket_refresh_readonly,\n",
      "",
    ),
    "depends_on must contain the exact bootstrap IAM chain",
  );
}

function collectFilesFromRoot(root, directory, files, predicate) {
  const directoryPath = path.join(root, directory);
  if (lstatSync(directoryPath).isSymbolicLink()) {
    throw new Error(
      `Terraform identity contract roots must not contain source symlinks: ${directory}`,
    );
  }
  for (const entry of readdirSync(directoryPath, {
    withFileTypes: true,
  })) {
    if (
      entry.isDirectory() &&
      (entry.name.startsWith(".terraform") || entry.name === "node_modules")
    ) {
      continue;
    }
    const relativePath = path.posix.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      const absolutePath = path.join(root, relativePath);
      let targetIsDirectory = true;
      try {
        targetIsDirectory = statSync(absolutePath).isDirectory();
      } catch {
        // A broken link cannot be a valid Terraform source.
      }
      if (targetIsDirectory || predicate(entry.name)) {
        throw new Error(
          `Terraform identity contract roots must not contain source symlinks: ${relativePath}`,
        );
      }
      continue;
    }
    if (entry.isDirectory()) {
      collectFilesFromRoot(root, relativePath, files, predicate);
    } else if (entry.isFile() && predicate(entry.name)) {
      files[relativePath] = readFileSync(path.join(root, relativePath), "utf8");
    }
  }
}

function collectFiles(directory, files, predicate) {
  collectFilesFromRoot(repoRoot, directory, files, predicate);
}

function collectTrackedAutomaticVariableFiles(files, root = repoRoot) {
  const filePaths = execFileSync(
    "git",
    [
      "ls-files",
      "-z",
      "--",
      "terraform",
      "aegis/terraform",
      "alerts/infra",
      "alerts/rules",
      "governance-watchdog/infra",
    ],
    { cwd: root, encoding: "utf8" },
  )
    .split("\0")
    .filter((filePath) =>
      /(?:^|\/)(?:terraform\.tfvars(?:\.json)?|[^/]*\.auto\.tfvars(?:\.json)?)$/u.test(
        filePath,
      ),
    );
  for (const filePath of filePaths) {
    files[filePath] = readFileSync(path.join(root, filePath), "utf8");
  }
}

function testCollectorRejectsSymlink() {
  const temporaryRoot = mkdtempSync(
    path.join(tmpdir(), "identity-contract-symlink-"),
  );
  try {
    mkdirSync(path.join(temporaryRoot, "terraform"));
    mkdirSync(path.join(temporaryRoot, "outside-module"));
    writeFileSync(
      path.join(temporaryRoot, "outside-module", "main.tf"),
      'resource "google_project_iam_member" "escaped" {}\n',
    );
    symlinkSync(
      "../outside-module",
      path.join(temporaryRoot, "terraform", "linked-module"),
      "dir",
    );
    assert.throws(
      () =>
        collectFilesFromRoot(temporaryRoot, "terraform", {}, (name) =>
          name.endsWith(".tf"),
        ),
      /Terraform identity contract roots must not contain source symlinks: terraform\/linked-module/u,
    );
    symlinkSync(
      "outside-module",
      path.join(temporaryRoot, "linked-root"),
      "dir",
    );
    assert.throws(
      () =>
        collectFilesFromRoot(temporaryRoot, "linked-root", {}, (name) =>
          name.endsWith(".tf"),
        ),
      /Terraform identity contract roots must not contain source symlinks: linked-root/u,
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function testCollectorIncludesDotAutomaticVariableFiles() {
  const temporaryRoot = mkdtempSync(
    path.join(tmpdir(), "identity-contract-auto-tfvars-"),
  );
  try {
    mkdirSync(path.join(temporaryRoot, "terraform"));
    mkdirSync(path.join(temporaryRoot, "alerts", "rules"), {
      recursive: true,
    });
    for (const fileName of [
      ".auto.tfvars",
      ".auto.tfvars.json",
      "ignored.tfvars",
    ]) {
      writeFileSync(path.join(temporaryRoot, "terraform", fileName), "{}\n");
    }
    writeFileSync(
      path.join(temporaryRoot, "alerts", "rules", ".auto.tfvars"),
      "{}\n",
    );
    execFileSync("git", ["init", "--quiet"], { cwd: temporaryRoot });
    execFileSync("git", ["add", "--", "terraform", "alerts/rules"], {
      cwd: temporaryRoot,
    });
    const files = {};
    collectTrackedAutomaticVariableFiles(files, temporaryRoot);
    assert.deepEqual(Object.keys(files).sort(), [
      "alerts/rules/.auto.tfvars",
      "terraform/.auto.tfvars",
      "terraform/.auto.tfvars.json",
    ]);
    expectContractFailure(
      { ...validFixtureFiles(), ...files },
      "checked-in automatic variable files are forbidden",
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function realRepositoryFiles() {
  const files = {};
  for (const directory of [
    "terraform",
    "aegis/terraform",
    "alerts/infra",
    "alerts/rules",
    "governance-watchdog/infra",
  ]) {
    collectFiles(
      directory,
      files,
      (name) => name.endsWith(".tf") || name.endsWith(".tf.json"),
    );
  }
  collectFiles("alerts/infra/scripts", files, (name) => name.endsWith(".sh"));
  for (const filePath of [
    "scripts/sanitize-terraform-output.sh",
    "scripts/verify-github-environment-protection.mjs",
  ]) {
    files[filePath] = readFileSync(path.join(repoRoot, filePath), "utf8");
  }
  collectTrackedAutomaticVariableFiles(files);
  collectFiles(
    ".github/workflows",
    files,
    (name) => name.endsWith(".yml") || name.endsWith(".yaml"),
  );
  return files;
}

testCollectorRejectsSymlink();
testCollectorIncludesDotAutomaticVariableFiles();
runFixtureTests();

if (process.argv.includes("--fixtures-only")) {
  console.log(
    "production infrastructure identity contract fixture tests passed (live repository check skipped)",
  );
} else {
  assertProductionInfraIdentityContract(realRepositoryFiles());
  console.log("production infrastructure identity contract tests passed");
}
