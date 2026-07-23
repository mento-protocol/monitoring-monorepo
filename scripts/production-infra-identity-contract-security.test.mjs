#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validFixtureFiles } from "./production-infra-identity-contract-fixtures.mjs";
import { terraformTopLevelBlocks } from "./production-infra-identity-contract-hcl.mjs";
import {
  assertProductionInfraIdentityContract,
  validateProductionInfraIdentityContract,
} from "./production-infra-identity-contract.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function expectFailure(files, expectedMessage) {
  const errors = validateProductionInfraIdentityContract(files);
  assert(
    errors.some((error) => error.includes(expectedMessage)),
    `expected failure containing "${expectedMessage}", got:\n${errors.join("\n")}`,
  );
}

function expectCompleteFailure(files, expectedMessage) {
  assert.throws(
    () => assertProductionInfraIdentityContract(files),
    (error) => {
      assert(error instanceof Error);
      assert(
        error.message.includes(expectedMessage),
        `expected complete-inventory failure containing "${expectedMessage}", got:\n${error.message}`,
      );
      return true;
    },
  );
}

function withTerraformFile(filePath, contents) {
  return {
    ...validFixtureFiles(),
    [filePath]: contents,
  };
}

function withAppendedTerraform(filePath, contents) {
  const files = validFixtureFiles();
  assert(files[filePath]);
  files[filePath] = `${files[filePath]}\n${contents}`;
  return files;
}

function mutateCiWif(from, to) {
  const files = validFixtureFiles();
  assert(files["terraform/ci-wif.tf"].includes(from));
  files["terraform/ci-wif.tf"] = files["terraform/ci-wif.tf"].replace(from, to);
  return files;
}

function liveRepositoryFiles() {
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
      ".github/workflows",
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  )
    .split("\0")
    .filter(
      (filePath) =>
        filePath.endsWith(".tf") ||
        filePath.endsWith(".tf.json") ||
        filePath.endsWith(".yml") ||
        filePath.endsWith(".yaml") ||
        filePath.endsWith(".sh") ||
        /(?:^|\/)(?:terraform\.tfvars(?:\.json)?|[^/]*\.auto\.tfvars(?:\.json)?)$/u.test(
          filePath,
        ),
    )
    .concat([
      "scripts/sanitize-terraform-output.sh",
      "scripts/verify-github-environment-protection.mjs",
    ]);
  return Object.fromEntries(
    filePaths.map((filePath) => [
      filePath,
      readFileSync(path.join(repositoryRoot, filePath), "utf8"),
    ]),
  );
}

function withoutTopLevelBlock(files, filePath, predicate) {
  const parseErrors = [];
  const matches = terraformTopLevelBlocks(
    { [filePath]: files[filePath] },
    parseErrors,
  ).filter(predicate);
  assert.deepEqual(parseErrors, []);
  assert.equal(matches.length, 1);
  const [block] = matches;
  return {
    ...files,
    [filePath]: `${files[filePath].slice(0, block.start)}${files[filePath].slice(block.end)}`,
  };
}

const registeredGrafanaDashboardModule = `module "grafana_dashboard" {
  source                        = "./grafana-dashboard"
  grafana_service_account_token = var.grafana_service_account_token
  aegis_folder                  = grafana_folder.aegis
}
`;

const registeredDevStorageAdmin = `resource "google_project_iam_member" "dev_storage_admin" {
  for_each = toset(var.gcp_dev_members)
  project  = google_project.monitoring.project_id
  role     = "roles/storage.admin"
  member   = each.value

  depends_on = [google_project_iam_member.terraform_owner]
}
`;

const registeredMetricsBridgeDeployer = `resource "google_service_account" "metrics_bridge_deployer" {
  project      = google_project.monitoring.project_id
  account_id   = "metrics-bridge-deployer"
  display_name = "metrics-bridge CI deployer"
  description  = "Impersonated by GitHub Actions via WIF to deploy the bridge"

  depends_on = [google_project_service.iam]
}
`;

const registeredAegisLocals = `locals {
  aegis_app_engine_default_service_account = "\${google_project.monitoring.project_id}@appspot.gserviceaccount.com"

  grafana_agent_secret_ids = toset([
    "grafana-agent-endpoint",
    "grafana-agent-username",
    "grafana-agent-password",
  ])

  grafana_agent_cloudbuild_service_accounts = {
    legacy  = "\${google_project.monitoring.number}@cloudbuild.gserviceaccount.com"
    compute = "\${google_project.monitoring.number}-compute@developer.gserviceaccount.com"
  }

  grafana_agent_cloudbuild_project_roles = toset([
    "roles/appengine.appAdmin",
    "roles/artifactregistry.writer",
    "roles/cloudbuild.builds.editor",
    "roles/logging.viewer",
    "roles/storage.admin",
  ])
}
`;

assert.deepEqual(
  validateProductionInfraIdentityContract(
    withTerraformFile(
      "aegis/terraform/main.tf",
      registeredGrafanaDashboardModule,
    ),
  ),
  [],
);
assert.deepEqual(
  validateProductionInfraIdentityContract(
    withTerraformFile("terraform/project-iam.tf", registeredDevStorageAdmin),
  ),
  [],
);
assert.deepEqual(
  validateProductionInfraIdentityContract(
    withAppendedTerraform(
      "terraform/ci-wif.tf",
      registeredMetricsBridgeDeployer,
    ),
  ),
  [],
);
assert.deepEqual(
  validateProductionInfraIdentityContract(
    withTerraformFile("terraform/aegis-bootstrap.tf", registeredAegisLocals),
  ),
  [],
);

expectFailure(
  withTerraformFile(
    "terraform/extra.tf",
    `locals {
  hidden = "\${format("#%s", google_service_account.production_infra_applier.email)}"
}
`,
  ),
  "production applier: identity references are allowed only",
);

expectFailure(
  withTerraformFile(
    "terraform/extra.tf",
    `locals {
  parser_depth = "\${format("{", 1)}"
}
resource "google_iam_workload_identity_pool_provider" "template_bypass" {
  workload_identity_pool_id = "github-actions"
}`,
  ),
  "workload identity provider inventory must contain exactly",
);

expectFailure(
  withTerraformFile(
    "terraform/extra.tf",
    `locals {
  nested = {
}`,
  ),
  "unterminated top-level locals block",
);

expectFailure(
  withTerraformFile(
    "terraform/extra.tf",
    `locals {
  hidden = google_service_account /* separator */ .
    production_infra_applier . email
}
`,
  ),
  "production applier: identity references are allowed only",
);

expectFailure(
  withTerraformFile(
    "terraform/extra.tf",
    String.raw`resource "google_project_iam_member" "escaped_identity_grant" {
  project = google_project.monitoring.project_id
  role    = "roles/storage.admin"
  member  = "serviceAccount:production-infra-\u0061pplier@mento-terraform-seed-ffac.iam.gserviceaccount.com"
}
`,
  ),
  "production applier: identity references are allowed only",
);

expectFailure(
  withTerraformFile(
    "terraform/composed-join.tf",
    `resource "google_project_iam_member" "composed_production_admin" {
  project = google_project.monitoring.project_id
  role    = "roles/owner"
  member  = join("", ["serviceAccount:production-infra-", "applier@mento-terraform-seed-ffac.iam.gserviceaccount.com"])
}
`,
  ),
  "unregistered IAM grant sinks are forbidden",
);

expectFailure(
  withTerraformFile(
    "terraform/composed-format.tf",
    `resource "google_project_iam_member" "composed_refresh_admin" {
  project = google_project.monitoring.project_id
  role    = "roles/owner"
  member  = format("serviceAccount:%s%s", "terraform-refresh-", "readonly@mento-monitoring.iam.gserviceaccount.com")
}
`,
  ),
  "unregistered IAM grant sinks are forbidden",
);

expectFailure(
  withTerraformFile(
    "terraform/composed-local.tf",
    `locals {
  composed_refresh_target = join("", ["serviceAccount:org-terraform-refresh-", "readonly@mento-terraform-seed-ffac.iam.gserviceaccount.com"])
}
resource "google_project_iam_member" "local_refresh_admin" {
  project = google_project.monitoring.project_id
  role    = "roles/owner"
  member  = local.composed_refresh_target
}
`,
  ),
  "unregistered IAM grant sinks are forbidden",
);

expectFailure(
  withTerraformFile(
    "terraform/composed-binding.tf",
    `resource "google_project_iam_binding" "composed_production_admin" {
  project = google_project.monitoring.project_id
  role    = "roles/owner"
  members = [
    join("", ["serviceAccount:production-infra-", "applier@mento-terraform-seed-ffac.iam.gserviceaccount.com"]),
  ]
}
`,
  ),
  "unregistered IAM grant sinks are forbidden",
);

expectFailure(
  withTerraformFile(
    "terraform/composed-policy.tf",
    `data "google_iam_policy" "composed_production_admin" {
  binding {
    role = "roles/owner"
    members = [
      format("serviceAccount:%s%s", "production-infra-", "applier@mento-terraform-seed-ffac.iam.gserviceaccount.com"),
    ]
  }
}
resource "google_project_iam_policy" "composed_production_admin" {
  project     = google_project.monitoring.project_id
  policy_data = data.google_iam_policy.composed_production_admin.policy_data
}
`,
  ),
  "unregistered IAM grant sinks are forbidden",
);

expectFailure(
  withTerraformFile(
    "terraform/module-bypass.tf",
    `module "project_iam_bypass" {
  source   = "terraform-google-modules/iam/google//modules/projects_iam"
  version  = "8.1.0"
  projects = [google_project.monitoring.project_id]
  mode     = "additive"
  bindings = {
    "roles/owner" = [
      join("", ["serviceAccount:production-infra-", "applier@mento-terraform-seed-ffac.iam.gserviceaccount.com"]),
    ]
  }
}
`,
  ),
  "unregistered Terraform module calls are forbidden",
);

for (const [provisioner, commandAttribute] of [
  [
    "local-exec",
    'command = join("", ["gcloud projects add-iam-policy-binding mento-monitoring --member=serviceAccount:production-infra-", "applier@mento-terraform-seed-ffac.iam.gserviceaccount.com --role=roles/owner"])',
  ],
  [
    "remote-exec",
    'inline = [join("", ["gcloud projects add-iam-policy-binding mento-monitoring --member=serviceAccount:production-infra-", "applier@mento-terraform-seed-ffac.iam.gserviceaccount.com --role=roles/owner"])]',
  ],
]) {
  expectFailure(
    withTerraformFile(
      `terraform/${provisioner}-bypass.tf`,
      `resource "terraform_data" "${provisioner.replace("-", "_")}_iam_bypass" {
  provisioner "${provisioner}" {
    ${commandAttribute}
  }
}
`,
    ),
    "unregistered imperative Terraform execution blocks are forbidden",
  );
}

expectFailure(
  withTerraformFile(
    "terraform/escaped-provisioner-bypass.tf",
    String.raw`resource "terraform_data" "escaped_provisioner_iam_bypass" {
  provisioner "local\u002dexec" {
    command = join("", ["gcloud projects add-iam-policy-binding mento-monitoring --member=serviceAccount:production-infra-", "applier@mento-terraform-seed-ffac.iam.gserviceaccount.com --role=roles/owner"])
  }
}
`,
  ),
  "unregistered imperative Terraform execution blocks are forbidden",
);

expectFailure(
  withTerraformFile(
    "terraform/external-data-bypass.tf",
    `data "external" "iam_bypass" {
  program = [
    "bash",
    "-c",
    format("gcloud projects add-iam-policy-binding mento-monitoring --member=serviceAccount:%s%s --role=roles/owner", "production-infra-", "applier@mento-terraform-seed-ffac.iam.gserviceaccount.com"),
  ]
}
`,
  ),
  "external data execution is forbidden",
);

expectFailure(
  withTerraformFile(
    "alerts/infra/http-iam-bypass.tf",
    `data "http" "iam_bypass" {
  url    = "https://cloudresourcemanager.googleapis.com/v1/projects/mento-monitoring:setIamPolicy"
  method = "POST"
  request_headers = {
    Content-Type = "application/json"
  }
  request_body = jsonencode({
    policy = {
      bindings = [{
        role    = join("", ["roles/", "owner"])
        members = [join("", ["serviceAccount:production-infra-", "applier@mento-terraform-seed-ffac.iam.gserviceaccount.com"])]
      }]
    }
  })
}
`,
  ),
  "unregistered arbitrary HTTP mutation blocks are forbidden",
);

expectFailure(
  withTerraformFile(
    "alerts/infra/restapi-iam-bypass.tf",
    `provider "restapi" {
  alias = "iam_bypass"
  uri   = "https://cloudresourcemanager.googleapis.com/v1"
  headers = {
    Content-Type = "application/json"
  }
  write_returns_object = true
}

resource "restapi_object" "iam_bypass" {
  provider = restapi.iam_bypass
  path     = "/projects/mento-monitoring:setIamPolicy"
  data = jsonencode({
    policy = {
      bindings = [{
        role    = join("", ["roles/", "owner"])
        members = [join("", ["serviceAccount:production-infra-", "applier@mento-terraform-seed-ffac.iam.gserviceaccount.com"])]
      }]
    }
  })
}
`,
  ),
  "unregistered arbitrary HTTP mutation blocks are forbidden",
);

expectFailure(
  withTerraformFile(
    "terraform/service-account-key-bypass.tf",
    `resource "google_service_account_key" "production_applier_bypass" {
  service_account_id = join("", [
    "projects/mento-terraform-seed-ffac/serviceAccounts/production-infra-",
    "applier@mento-terraform-seed-ffac.iam.gserviceaccount.com",
  ])
}
`,
  ),
  "service-account credential grant resources are forbidden unless explicitly audited",
);

expectFailure(
  withTerraformFile(
    "terraform/custom-provider-bypass.tf",
    `terraform {
  required_providers {
    shell = {
      source  = "scottwinkler/shell"
      version = "1.7.10"
    }
  }
}

provider "shell" {}

resource "shell_script" "iam_bypass" {
  lifecycle_commands {
    create = join("", ["gcloud projects add-iam-policy-binding mento-monitoring --member=serviceAccount:production-infra-", "applier@mento-terraform-seed-ffac.iam.gserviceaccount.com --role=roles/owner"])
  }
}
`,
  ),
  "unregistered Terraform resource/data blocks are forbidden",
);

expectFailure(
  withTerraformFile(
    "terraform/google-compute-bypass.tf",
    `resource "google_compute_instance" "iam_bypass" {
  name         = "iam-bypass"
  machine_type = "e2-micro"
  zone         = "europe-west1-b"
  boot_disk {
    initialize_params {
      image = "debian-cloud/debian-12"
    }
  }
  network_interface {
    network = "default"
  }
  service_account {
    email  = google_service_account.metrics_bridge_deployer.email
    scopes = ["cloud-platform"]
  }
  metadata_startup_script = join("", ["gcloud projects add-iam-policy-binding mento-monitoring --member=serviceAccount:production-infra-", "applier@mento-terraform-seed-ffac.iam.gserviceaccount.com --role=roles/owner"])
}
`,
  ),
  "unregistered Terraform resource/data blocks are forbidden",
);

expectFailure(
  withTerraformFile(
    "terraform/nested-check-bypass.tf",
    `check "iam_bypass" {
  data "external" "iam_bypass" {
    program = ["bash", "-c", "gcloud projects add-iam-policy-binding mento-monitoring --role=roles/owner"]
  }
  assert {
    condition     = data.external.iam_bypass.result.ok
    error_message = "IAM request failed"
  }
}
`,
  ),
  "unsupported top-level blocks are forbidden",
);

for (const kind of ["data", "ephemeral"]) {
  expectFailure(
    withTerraformFile(
      `terraform/${kind}-credential-bypass.tf`,
      `${kind} "google_service_account_access_token" "iam_bypass" {
  target_service_account = join("", ["production-infra-", "applier@mento-terraform-seed-ffac.iam.gserviceaccount.com"])
  scopes                 = ["cloud-platform"]
}
`,
    ),
    "Google credential-producing blocks are forbidden unless explicitly audited",
  );
}

expectFailure(
  withTerraformFile(
    "aegis/terraform/main.tf",
    registeredGrafanaDashboardModule.replace(
      'source                        = "./grafana-dashboard"',
      'source                        = "git::https://example.invalid/grafana-dashboard.git?ref=unreviewed"',
    ),
  ),
  "Terraform module calls must match its exact audited shape",
);

expectFailure(
  withTerraformFile(
    "aegis/terraform/main.tf",
    registeredGrafanaDashboardModule.replace(
      'module "grafana_dashboard" {',
      'module "grafana_dashboard" {\n  count                         = 0',
    ),
  ),
  "Terraform module calls must match its exact audited shape",
);

expectFailure(
  withTerraformFile(
    "terraform/project-iam.tf",
    registeredDevStorageAdmin.replace(
      "toset(var.gcp_dev_members)",
      'toset([join("", ["serviceAccount:production-infra-", "applier@mento-terraform-seed-ffac.iam.gserviceaccount.com"])])',
    ),
  ),
  "IAM grant sinks must match its exact audited shape",
);

expectFailure(
  withAppendedTerraform(
    "terraform/ci-wif.tf",
    registeredMetricsBridgeDeployer
      .replace(
        "google_project.monitoring.project_id",
        '"mento-terraform-seed-ffac"',
      )
      .replace(
        '"metrics-bridge-deployer"',
        'join("", ["production-infra-", "applier"])',
      ),
  ),
  "IAM identity source resources must match its exact audited shape",
);

expectFailure(
  withTerraformFile(
    "terraform/aegis-bootstrap.tf",
    registeredAegisLocals.replace(
      '"${google_project.monitoring.project_id}@appspot.gserviceaccount.com"',
      'join("", ["production-infra-", "applier@mento-terraform-seed-ffac.iam.gserviceaccount.com"])',
    ),
  ),
  "IAM local source blocks must match its exact audited shape",
);

const composedDevMemberFiles = liveRepositoryFiles();
const devMemberDefault = '  default     = ["group:eng@mentolabs.xyz"]';
assert(
  composedDevMemberFiles["terraform/variables.tf"].includes(devMemberDefault),
);
composedDevMemberFiles["terraform/variables.tf"] = composedDevMemberFiles[
  "terraform/variables.tf"
].replace(
  devMemberDefault,
  [
    "  default = [",
    '    "serviceAccount:production-infra-${"applier"}@mento-terraform-seed-ffac.iam.gserviceaccount.com",',
    "  ]",
  ].join("\n"),
);
expectFailure(
  composedDevMemberFiles,
  "terraform:variable.gcp_dev_members: IAM variable source block must match its exact audited shape",
);

const composedCiRoleFiles = liveRepositoryFiles();
const ciDeployerRole = '    "roles/storage.admin",';
assert(composedCiRoleFiles["terraform/ci-wif.tf"].includes(ciDeployerRole));
composedCiRoleFiles["terraform/ci-wif.tf"] = composedCiRoleFiles[
  "terraform/ci-wif.tf"
].replace(ciDeployerRole, '    join("", ["roles/", "owner"]),');
expectFailure(
  composedCiRoleFiles,
  "terraform:local.ci_deployer_roles: IAM local source blocks must match its exact audited shape",
);

const githubVariableCollisionFiles = liveRepositoryFiles();
const sentryArchiveVariable = `  variable_name = "SENTRY_ARCHIVE_ENABLED"
  value         = var.sentry_archive_enabled`;
assert(
  githubVariableCollisionFiles["terraform/github-variables.tf"].includes(
    sentryArchiveVariable,
  ),
);
githubVariableCollisionFiles["terraform/github-variables.tf"] =
  githubVariableCollisionFiles["terraform/github-variables.tf"].replace(
    sentryArchiveVariable,
    `  variable_name = "GCP_PRODUCTION_INFRA_SERVICE_ACCOUNT"
  value         = google_service_account.metrics_bridge_deployer.email`,
  );
expectFailure(
  githubVariableCollisionFiles,
  "identity-bearing resource blocks must match its exact audited shape",
);

const githubSecretCollisionFiles = liveRepositoryFiles();
const githubResourceNameKey = ["secret", "name"].join("_");
const sentryArchiveEntry = `  ${githubResourceNameKey} = "SENTRY_ARCHIVE_TOKEN"
  value       = var.sentry_archive_token`;
assert(
  githubSecretCollisionFiles["terraform/github-secrets.tf"].includes(
    sentryArchiveEntry,
  ),
);
githubSecretCollisionFiles["terraform/github-secrets.tf"] =
  githubSecretCollisionFiles["terraform/github-secrets.tf"].replace(
    sentryArchiveEntry,
    `  ${githubResourceNameKey} = "GCP_SERVICE_ACCOUNT"
  value       = google_service_account.metrics_bridge_deployer.email`,
  );
expectFailure(
  githubSecretCollisionFiles,
  "identity-bearing resource blocks must match its exact audited shape",
);

const vercelSecretPayloadFiles = liveRepositoryFiles();
const publicHasuraEnvironmentValue = `  key        = "NEXT_PUBLIC_HASURA_URL"
  value      = var.hasura_url`;
assert(
  vercelSecretPayloadFiles["terraform/dashboard.tf"].includes(
    publicHasuraEnvironmentValue,
  ),
);
vercelSecretPayloadFiles["terraform/dashboard.tf"] = vercelSecretPayloadFiles[
  "terraform/dashboard.tf"
].replace(
  publicHasuraEnvironmentValue,
  `  key        = "NEXT_PUBLIC_GITHUB_TOKEN"
  value      = var.github_token`,
);
expectFailure(
  vercelSecretPayloadFiles,
  "secret-payload sink blocks must match its exact audited shape",
);

const secretManagerPayloadFiles = liveRepositoryFiles();
const discordSecretPayload = `  secret      = google_secret_manager_secret.discord_webhook_url.id
  secret_data = var.discord_webhook_url`;
assert(
  secretManagerPayloadFiles[
    "governance-watchdog/infra/secret-manager.tf"
  ].includes(discordSecretPayload),
);
secretManagerPayloadFiles["governance-watchdog/infra/secret-manager.tf"] =
  secretManagerPayloadFiles[
    "governance-watchdog/infra/secret-manager.tf"
  ].replace(
    discordSecretPayload,
    `  secret      = google_secret_manager_secret.discord_webhook_url.id
  secret_data = var.github_token`,
  );
expectFailure(
  secretManagerPayloadFiles,
  "secret-payload sink blocks must match its exact audited shape",
);

const workloadIdentityAttachmentFiles = liveRepositoryFiles();
const runtimeIdentity =
  "    service_account_email          = google_service_account.function_runtime.email";
assert(
  workloadIdentityAttachmentFiles[
    "alerts/infra/onchain-event-handler/main.tf"
  ].includes(runtimeIdentity),
);
workloadIdentityAttachmentFiles["alerts/infra/onchain-event-handler/main.tf"] =
  workloadIdentityAttachmentFiles[
    "alerts/infra/onchain-event-handler/main.tf"
  ].replace(
    runtimeIdentity,
    '    service_account_email          = "metrics-bridge-deployer@mento-monitoring.iam.gserviceaccount.com"',
  );
expectFailure(
  workloadIdentityAttachmentFiles,
  "identity-bearing resource blocks must match its exact audited shape",
);

const outputExfiltrationFiles = liveRepositoryFiles();
outputExfiltrationFiles["terraform/credential-exfiltration.tf"] = `
output "diagnostic_reference" {
  value = nonsensitive(base64encode(var.github_token))
}
`;
expectFailure(
  outputExfiltrationFiles,
  "unregistered Terraform output blocks are forbidden",
);

const preconditionExfiltrationFiles = liveRepositoryFiles();
const projectServiceHeader = `resource "google_project_service" "run" {`;
assert(
  preconditionExfiltrationFiles["terraform/gcp-project.tf"].includes(
    projectServiceHeader,
  ),
);
preconditionExfiltrationFiles["terraform/gcp-project.tf"] =
  preconditionExfiltrationFiles["terraform/gcp-project.tf"].replace(
    projectServiceHeader,
    `${projectServiceHeader}
  lifecycle {
    precondition {
      condition = var.github_token == ""
      error_message = <<EOT
\${nonsensitive /* hidden declassification */ (base64encode(var.github_token))}
EOT
    }
  }`,
  );
expectFailure(
  preconditionExfiltrationFiles,
  "unregistered Terraform declassification blocks are forbidden",
);

const sensitivityDowngradeFiles = liveRepositoryFiles();
const githubTokenVariable = /^variable "github_token" \{[\s\S]*?^\}/mu.exec(
  sensitivityDowngradeFiles["terraform/variables.tf"],
)?.[0];
assert(githubTokenVariable);
sensitivityDowngradeFiles["terraform/variables.tf"] = sensitivityDowngradeFiles[
  "terraform/variables.tf"
].replace(githubTokenVariable, "");
sensitivityDowngradeFiles["terraform/moved-sensitive-variable.tf"] =
  githubTokenVariable.replace("  sensitive   = true", "  sensitive   = false");
sensitivityDowngradeFiles["terraform/gcp-project.tf"] =
  sensitivityDowngradeFiles["terraform/gcp-project.tf"].replace(
    projectServiceHeader,
    `${projectServiceHeader}
  lifecycle {
    precondition {
      condition     = var.github_token == ""
      error_message = base64encode(var.github_token)
    }
  }`,
  );
expectFailure(
  sensitivityDowngradeFiles,
  "sensitive Terraform variable blocks must match its exact audited shape",
);

const completeInventoryFiles = liveRepositoryFiles();
for (const { filePath, predicate, expectedMessage } of [
  {
    filePath: "terraform/providers.tf",
    predicate: (block) =>
      block.kind === "provider" && block.labels[0] === "google",
    expectedMessage: "provider configuration blocks are missing",
  },
  {
    filePath: "terraform/providers.tf",
    predicate: (block) => block.kind === "terraform",
    expectedMessage: "Terraform configuration blocks are missing",
  },
  {
    filePath: "terraform/outputs.tf",
    predicate: (block) =>
      block.kind === "output" && block.labels[0] === "gcp_project_id",
    expectedMessage: "Terraform output blocks are missing",
  },
  {
    filePath: "terraform/project-iam.tf",
    predicate: (block) =>
      block.kind === "resource" &&
      block.type === "google_project_iam_member" &&
      block.name === "dev_logging_viewer",
    expectedMessage: "IAM grant sinks are missing",
  },
  {
    filePath: "aegis/terraform/main.tf",
    predicate: (block) =>
      block.kind === "module" && block.labels[0] === "grafana_dashboard",
    expectedMessage: "Terraform module calls are missing",
  },
  {
    filePath: "terraform/agent-readonly.tf",
    predicate: (block) =>
      block.kind === "resource" &&
      block.type === "google_service_account" &&
      block.name === "agent_readonly",
    expectedMessage: "IAM identity source resources are missing",
  },
  {
    filePath: "alerts/infra/onchain-event-handler/local-dotenv-file.tf",
    predicate: (block) =>
      block.kind === "resource" &&
      block.type === "terraform_data" &&
      block.name === "env_file",
    expectedMessage: "imperative Terraform execution blocks are missing",
  },
]) {
  expectCompleteFailure(
    withoutTopLevelBlock(completeInventoryFiles, filePath, predicate),
    expectedMessage,
  );
}

const inlineHeredocBypassFiles = liveRepositoryFiles();
for (const [sourceLine, payloadLine] of [
  [
    "        # Helper script lives in the module's sibling scripts/ dir. Resolve",
    "        p=production-infra-",
  ],
  [
    "        # via TF interpolation rather than $BASH_SOURCE since the heredoc is",
    '        p="$p"applier@mento-terraform-seed-ffac.iam.gserviceaccount.com',
  ],
  [
    '        "${path.module}/../scripts/manage-quicknode-webhook.sh" pause-and-delete "$WEBHOOK_ID" "${var.quicknode_api_key}"',
    '        gcloud projects add-iam-policy-binding mento-monitoring --member="serviceAccount:$p" --role="roles/owner"',
  ],
  [
    "        # Remove from Terraform state so Terraform will create instead of",
    "        exit 0",
  ],
]) {
  assert(payloadLine.length <= sourceLine.length);
  assert(
    inlineHeredocBypassFiles[
      "alerts/infra/onchain-event-listeners/main.tf"
    ].includes(sourceLine),
  );
  inlineHeredocBypassFiles["alerts/infra/onchain-event-listeners/main.tf"] =
    inlineHeredocBypassFiles[
      "alerts/infra/onchain-event-listeners/main.tf"
    ].replace(sourceLine, payloadLine.padEnd(sourceLine.length));
}
expectFailure(
  inlineHeredocBypassFiles,
  "imperative Terraform execution blocks must match its exact audited shape",
);

const transitiveScriptBypassFiles = liveRepositoryFiles();
transitiveScriptBypassFiles["alerts/infra/scripts/common.sh"] +=
  '\np=production-infra-\np="$p"applier@mento-terraform-seed-ffac.iam.gserviceaccount.com\ngcloud projects add-iam-policy-binding mento-monitoring --member="serviceAccount:$p" --role="roles/owner"\n';
expectFailure(
  transitiveScriptBypassFiles,
  "imperative Terraform dependency must match its exact audited shape",
);

const localFileBypassFiles = liveRepositoryFiles();
localFileBypassFiles["terraform/dashboard.tf"] = localFileBypassFiles[
  "terraform/dashboard.tf"
]
  .replace(
    "  content = jsonencode({",
    '  content = "gcloud projects add-iam-policy-binding mento-monitoring --role=roles/owner"\n  ignored = jsonencode({',
  )
  .replace(
    '  filename        = "${path.module}/../.vercel/project.json"',
    '  filename        = "${path.module}/../alerts/infra/scripts/common.sh"',
  );
expectFailure(
  localFileBypassFiles,
  "local filesystem mutation blocks must match its exact audited shape",
);

const automaticVariableBypassFiles = liveRepositoryFiles();
automaticVariableBypassFiles["terraform/repro.auto.tfvars"] =
  'terraform_service_account = "production-infra-applier@mento-terraform-seed-ffac.iam.gserviceaccount.com"\n';
expectFailure(
  automaticVariableBypassFiles,
  "checked-in automatic variable files are forbidden",
);

for (const filePath of [
  "terraform/.auto.tfvars",
  "terraform/terraform.tfvars",
  "terraform/terraform.tfvars.json",
  "terraform/repro.auto.tfvars.json",
]) {
  expectFailure(
    withTerraformFile(filePath, "{}\n"),
    "checked-in automatic variable files are forbidden",
  );
}

const registeredProductionMember =
  '  member             = "serviceAccount:${google_service_account.production_infra_applier.email}"';
expectFailure(
  mutateCiWif(
    registeredProductionMember,
    '  member = join("", ["serviceAccount:production-infra-", "applier@mento-terraform-seed-ffac.iam.gserviceaccount.com"])',
  ),
  "terraform/ci-wif.tf:google_service_account_iam_member.production_infra_applier_org_terraform_token_creator: IAM grant sink: member must be exactly",
);

const legacyHeader =
  'resource "google_service_account_iam_member" "ci_alerts_org_terraform_token_creator" {';
for (const metaArgument of ["count = 0", "for_each = {}"]) {
  expectFailure(
    mutateCiWif(legacyHeader, `${legacyHeader}\n  ${metaArgument}`),
    "bootstrap legacy deployer token creator: resource multiplicity is forbidden",
  );
}

const productionWifHeader =
  'resource "google_service_account_iam_member" "production_infra_applier_wif_binding" {';
expectFailure(
  mutateCiWif(productionWifHeader, `${productionWifHeader}\n  for_each = {}`),
  "production applier WIF binding: resource multiplicity is forbidden",
);

expectFailure(
  withTerraformFile(
    "terraform/extra.tf",
    `\uFEFFresource "google_iam_workload_identity_pool_provider" "bom_bypass" {
  workload_identity_pool_id = "github-actions"
}
`,
  ),
  "workload identity provider inventory must contain exactly",
);

expectFailure(
  withTerraformFile(
    "terraform/extra.tf.json",
    JSON.stringify({
      resource: {
        google_iam_workload_identity_pool_provider: {
          json_bypass: {
            workload_identity_pool_id: "github-actions",
          },
        },
      },
    }),
  ),
  "Terraform JSON configuration is forbidden",
);

console.log("production infrastructure identity security tests passed");
