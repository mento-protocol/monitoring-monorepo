const commonRoles = [
  "roles/artifactregistry.viewer",
  "roles/browser",
  "roles/cloudfunctions.viewer",
  "roles/cloudscheduler.viewer",
  "roles/iam.securityReviewer",
  "roles/iam.serviceAccountViewer",
  "roles/logging.viewer",
  "roles/monitoring.viewer",
  "roles/run.viewer",
  "roles/secretmanager.viewer",
  "roles/serviceusage.serviceUsageConsumer",
  "roles/serviceusage.serviceUsageViewer",
  "roles/storage.bucketViewer",
];

function roleSet(name, roles) {
  return `locals {
  ${name} = toset([
${roles.map((role) => `    "${role}",`).join("\n")}
  ])
}`;
}

const productionTerraformFixture = String.raw`
resource "google_iam_workload_identity_pool" "github_actions" {
  project                   = google_project.monitoring.project_id
  workload_identity_pool_id = "github-actions"
}

resource "google_iam_workload_identity_pool_provider" "github" {
  project                            = google_project.monitoring.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github_actions.workload_identity_pool_id
  workload_identity_pool_provider_id = "github"
  attribute_condition                = "attribute.repository == \"mento-protocol/monitoring-monorepo\""
  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
    "attribute.ref"        = "assertion.ref"
  }
  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_iam_workload_identity_pool" "github_production_infra" {
  project                   = google_project.monitoring.project_id
  workload_identity_pool_id = "github-production-infra"
}

resource "google_iam_workload_identity_pool_provider" "github_production_infra" {
  project                            = google_project.monitoring.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github_production_infra.workload_identity_pool_id
  workload_identity_pool_provider_id = "github"
  attribute_condition                = "assertion.repository == \"mento-protocol/monitoring-monorepo\" && assertion.ref == \"refs/heads/main\" && assertion.sub == \"repo:mento-protocol/monitoring-monorepo:environment:production-infra\""
  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
    "attribute.ref"        = "assertion.ref"
  }
  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account" "production_infra_applier" {
  project    = "mento-terraform-seed-ffac"
  account_id = "production-infra-applier"
}

resource "google_service_account_iam_member" "production_infra_applier_wif_binding" {
  service_account_id = google_service_account.production_infra_applier.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principal://iam.googleapis.com/$\{google_iam_workload_identity_pool.github_production_infra.name}/subject/repo:mento-protocol/monitoring-monorepo:environment:production-infra"
}

resource "google_service_account_iam_member" "production_infra_applier_org_terraform_token_creator" {
  service_account_id = "projects/mento-terraform-seed-ffac/serviceAccounts/$\{var.terraform_service_account}"
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:$\{google_service_account.production_infra_applier.email}"
}

resource "google_service_account" "terraform_refresh_readonly" {
  project    = google_project.monitoring.project_id
  account_id = "terraform-refresh-readonly"
}

resource "google_service_account_iam_member" "terraform_refresh_readonly_wif_binding" {
  service_account_id = google_service_account.terraform_refresh_readonly.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/$\{google_iam_workload_identity_pool.github_actions.name}/attribute.ref/refs/heads/main"
}

resource "google_service_account" "org_terraform_refresh_readonly" {
  project    = "mento-terraform-seed-ffac"
  account_id = "org-terraform-refresh-readonly"
}

resource "google_service_account_iam_member" "ci_refresh_readonly_org_terraform_refresh_readonly_token_creator" {
  service_account_id = google_service_account.org_terraform_refresh_readonly.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:$\{google_service_account.terraform_refresh_readonly.email}"
}

resource "google_storage_bucket_iam_member" "state_bucket_refresh_readonly" {
  bucket = "mento-terraform-tfstate-6ed6"
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:$\{google_service_account.org_terraform_refresh_readonly.email}"
}
`.replaceAll("$\\{", "${");

const githubVariablesFixture = `
resource "github_actions_variable" "gcp_production_infra_workload_identity_provider" {
  repository    = "monitoring-monorepo"
  variable_name = "GCP_PRODUCTION_INFRA_WORKLOAD_IDENTITY_PROVIDER"
  value         = google_iam_workload_identity_pool_provider.github_production_infra.name
  depends_on = [
    google_service_account_iam_member.production_infra_applier_wif_binding,
    google_service_account_iam_member.production_infra_applier_org_terraform_token_creator,
  ]
}
resource "github_actions_variable" "gcp_production_infra_service_account" {
  repository    = "monitoring-monorepo"
  variable_name = "GCP_PRODUCTION_INFRA_SERVICE_ACCOUNT"
  value         = google_service_account.production_infra_applier.email
  depends_on = [
    google_service_account_iam_member.production_infra_applier_wif_binding,
    google_service_account_iam_member.production_infra_applier_org_terraform_token_creator,
  ]
}
resource "github_actions_variable" "gcp_terraform_refresh_service_account" {
  repository    = "monitoring-monorepo"
  variable_name = "GCP_TERRAFORM_REFRESH_SERVICE_ACCOUNT"
  value         = google_service_account.terraform_refresh_readonly.email
  depends_on = [
    google_service_account_iam_member.terraform_refresh_readonly_wif_binding,
    google_service_account_iam_member.ci_refresh_readonly_org_terraform_refresh_readonly_token_creator,
    google_storage_bucket_iam_member.state_bucket_refresh_readonly,
  ]
}
`;

function targetProjectFixture(project) {
  return `
${roleSet("terraform_refresh_readonly_project_roles", commonRoles)}
resource "google_project_iam_member" "terraform_refresh_readonly" {
  for_each = local.terraform_refresh_readonly_project_roles
  project  = ${project}
  role     = each.value
  member   = "serviceAccount:org-terraform-refresh-readonly@mento-terraform-seed-ffac.iam.gserviceaccount.com"
}
`;
}

function bucketGrantFixture(bucket) {
  return `
resource "google_storage_bucket_iam_member" "terraform_refresh_readonly_function_source" {
  bucket = ${bucket}
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:org-terraform-refresh-readonly@mento-terraform-seed-ffac.iam.gserviceaccount.com"
}
`;
}

function secretGrantFixture(project, entries) {
  return `
resource "google_secret_manager_secret_iam_member" "terraform_refresh_readonly" {
  for_each = {
${Object.entries(entries)
  .map(([key, value]) => `    ${key} = ${value}`)
  .join("\n")}
  }
  project   = ${project}
  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:org-terraform-refresh-readonly@mento-terraform-seed-ffac.iam.gserviceaccount.com"
}
`;
}

function applyWorkflowFixture() {
  return `
name: Terraform fixture
jobs:
  plan:
    runs-on: ubuntu-latest
    steps:
      - uses: google-github-actions/auth@pinned
        with:
          workload_identity_provider: \${{ secrets.GCP_WORKLOAD_IDENTITY_PROVIDER }}
          service_account: \${{ secrets.GCP_SERVICE_ACCOUNT }}
  apply:
    environment:
      name: production-infra
    runs-on: ubuntu-latest
    steps:
      - name: Verify production-infra environment protection
        run: node scripts/verify-github-environment-protection.mjs
      - uses: google-github-actions/auth@pinned
        with:
          workload_identity_provider: \${{ vars.GCP_PRODUCTION_INFRA_WORKLOAD_IDENTITY_PROVIDER }}
          service_account: \${{ vars.GCP_PRODUCTION_INFRA_SERVICE_ACCOUNT }}
`;
}

export function validFixtureFiles() {
  return {
    "terraform/ci-wif.tf": productionTerraformFixture,
    "terraform/github-variables.tf": githubVariablesFixture,
    "alerts/infra/main.tf": targetProjectFixture("local.project_id"),
    "governance-watchdog/infra/main.tf": targetProjectFixture(
      "module.governance_watchdog.project_id",
    ),
    "alerts/infra/onchain-event-handler/main.tf": `${bucketGrantFixture(
      "google_storage_bucket.function_bucket.name",
    )}${secretGrantFixture(
      "var.project_id",
      Object.fromEntries([
        [
          "quicknode_signing",
          "google_secret_manager_secret.quicknode_signing_secret.secret_id",
        ],
        ["slack_bot", "google_secret_manager_secret.slack_bot_token.secret_id"],
      ]),
    )}`,
    "alerts/infra/oncall-announcer/main.tf": `${bucketGrantFixture(
      "google_storage_bucket.function_bucket.name",
    )}${secretGrantFixture(
      "var.project_id",
      Object.fromEntries([
        ["slack_bot", "google_secret_manager_secret.slack_bot_token.secret_id"],
        [
          "splunk_api_id",
          "google_secret_manager_secret.splunk_on_call_api_id.secret_id",
        ],
        [
          "splunk_api",
          "google_secret_manager_secret.splunk_on_call_api_key.secret_id",
        ],
      ]),
    )}`,
    "governance-watchdog/infra/storage.tf": bucketGrantFixture(
      "google_storage_bucket.watchdog_notifications_function.name",
    ),
    "governance-watchdog/infra/terraform-refresh.tf": secretGrantFixture(
      "module.governance_watchdog.project_id",
      Object.fromEntries([
        [
          "discord_test",
          "google_secret_manager_secret.discord_test_webhook_url.secret_id",
        ],
        [
          "discord_primary",
          "google_secret_manager_secret.discord_webhook_url.secret_id",
        ],
        [
          "quicknode_api",
          "google_secret_manager_secret.quicknode_api_key.secret_id",
        ],
        [
          "quicknode_security",
          "google_secret_manager_secret.quicknode_security_token.secret_id",
        ],
        [
          "telegram_bot",
          "google_secret_manager_secret.telegram_bot_token.secret_id",
        ],
        ["x_auth", "google_secret_manager_secret.x_auth_token.secret_id"],
      ]),
    ),
    ".github/workflows/alerts-rules.yml": applyWorkflowFixture(),
    ".github/workflows/alerts-infra.yml": applyWorkflowFixture(),
    ".github/workflows/aegis-terraform.yml": applyWorkflowFixture(),
    ".github/workflows/governance-watchdog.yml": applyWorkflowFixture(),
    ".github/workflows/metrics-bridge.yml": "jobs:\n  deploy:\n",
    ".github/workflows/aegis-app-engine.yml": "jobs:\n  deploy:\n",
    ".github/workflows/terraform-drift.yml": "jobs:\n  drift:\n",
  };
}
