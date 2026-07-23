export const APPLY_WORKFLOWS = [
  ".github/workflows/alerts-rules.yml",
  ".github/workflows/alerts-infra.yml",
  ".github/workflows/aegis-terraform.yml",
  ".github/workflows/governance-watchdog.yml",
];

export const SERVICE_AND_DRIFT_WORKFLOWS = [
  ".github/workflows/metrics-bridge.yml",
  ".github/workflows/aegis-app-engine.yml",
  ".github/workflows/terraform-drift.yml",
];

export const PRODUCTION_PROVIDER_VARIABLE =
  "GCP_PRODUCTION_INFRA_WORKLOAD_IDENTITY_PROVIDER";
export const PRODUCTION_SERVICE_ACCOUNT_VARIABLE =
  "GCP_PRODUCTION_INFRA_SERVICE_ACCOUNT";
export const REFRESH_SERVICE_ACCOUNT_VARIABLE =
  "GCP_TERRAFORM_REFRESH_SERVICE_ACCOUNT";

export const PRODUCTION_SUBJECT =
  "repo:mento-protocol/monitoring-monorepo:environment:production-infra";
export const SEED_PROJECT_ID = "mento-terraform-seed-ffac";
export const REFRESH_TARGET_EMAIL =
  "org-terraform-refresh-readonly@mento-terraform-seed-ffac.iam.gserviceaccount.com";

export const GENERIC_PROVIDER_CONDITION =
  'attribute.repository == "mento-protocol/monitoring-monorepo"';
export const PRODUCTION_PROVIDER_CONDITION =
  'assertion.repository == "mento-protocol/monitoring-monorepo" && assertion.ref == "refs/heads/main" && assertion.sub == "repo:mento-protocol/monitoring-monorepo:environment:production-infra"';

export const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";

export const COMMON_REFRESH_PROJECT_ROLES = [
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
