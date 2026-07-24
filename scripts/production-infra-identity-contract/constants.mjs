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
export const REFRESH_PROVIDER_VARIABLE =
  "GCP_TERRAFORM_REFRESH_WORKLOAD_IDENTITY_PROVIDER";
export const REFRESH_SERVICE_ACCOUNT_VARIABLE =
  "GCP_TERRAFORM_REFRESH_SERVICE_ACCOUNT";

export const PRODUCTION_SUBJECT =
  "repo:mento-protocol/monitoring-monorepo:environment:production-infra";
export const GITHUB_REPOSITORY_ID = "1172025835";
export const SEED_PROJECT_ID = "mento-terraform-seed-ffac";
export const REFRESH_TARGET_EMAIL =
  "org-terraform-refresh-readonly@mento-terraform-seed-ffac.iam.gserviceaccount.com";
export const PLAN_TARGET_EMAIL =
  "org-terraform-plan-readonly@mento-terraform-seed-ffac.iam.gserviceaccount.com";
export const PR_PLAN_CONDITION = "github.event_name == 'pull_request'";
export const TRUSTED_REFRESH_CONDITION =
  "github.ref == 'refs/heads/main' && (github.event_name == 'push' || github.event_name == 'workflow_dispatch')";
export const PLAN_JOB_CONDITION = `(github.event_name == 'pull_request'
  && github.event.pull_request.head.repo.fork == false
  && github.event.pull_request.user.login != 'dependabot[bot]'
  && !startsWith(github.event.pull_request.head.ref, 'sentry-autofix/'))
|| (github.ref == 'refs/heads/main'
  && (github.event_name == 'push' || github.event_name == 'workflow_dispatch'))`;
export const DRIFT_REFRESH_CONDITION =
  "github.ref == 'refs/heads/main' && needs.discover.outputs.has-stacks == 'true'";
export const GOOGLE_AUTH_ACTION =
  "google-github-actions/auth@7c6bc770dae815cd3e89ee6cdf493a5fab2cc093";
export const GOOGLE_PROVIDER_REFRESH_WORKFLOWS = new Set([
  ".github/workflows/alerts-infra.yml",
  ".github/workflows/governance-watchdog.yml",
]);
export const PLAN_PROVIDER_TARGET =
  "${{ github.event_name == 'pull_request' && 'org-terraform-plan-readonly@mento-terraform-seed-ffac.iam.gserviceaccount.com' || 'org-terraform-refresh-readonly@mento-terraform-seed-ffac.iam.gserviceaccount.com' }}";
export const WRITE_TERRAFORM_IDENTITIES = [
  "org-terraform@mento-terraform-seed-ffac.iam.gserviceaccount.com",
  "production-infra-applier@mento-terraform-seed-ffac.iam.gserviceaccount.com",
  "metrics-bridge-deployer@mento-monitoring.iam.gserviceaccount.com",
];
export const PR_PLAN_TARGETS = new Map([
  [".github/workflows/aegis-terraform.yml", []],
  [
    ".github/workflows/alerts-infra.yml",
    ["terraform_data.pr_plan_secretless_guard"],
  ],
  [
    ".github/workflows/alerts-rules.yml",
    [
      "terraform_data.pr_plan_secretless_guard",
      "grafana_rule_group.aegis_service_alerts",
      "grafana_rule_group.oracle_relayers",
      "grafana_rule_group.reserve_balances",
      "grafana_rule_group.trading_limits",
      "grafana_rule_group.trading_modes",
    ],
  ],
  [".github/workflows/governance-watchdog.yml", []],
]);

export const GENERIC_PROVIDER_CONDITION = `attribute.repository == "mento-protocol/monitoring-monorepo" && attribute.repository_id == "${GITHUB_REPOSITORY_ID}"`;
export const PRODUCTION_PROVIDER_CONDITION = `assertion.repository_id == "${GITHUB_REPOSITORY_ID}" && assertion.repository == "mento-protocol/monitoring-monorepo" && assertion.ref == "refs/heads/main" && assertion.sub == "repo:mento-protocol/monitoring-monorepo:environment:production-infra"`;
export const REFRESH_WORKFLOW_REFS = [
  "mento-protocol/monitoring-monorepo/.github/workflows/aegis-terraform.yml@refs/heads/main",
  "mento-protocol/monitoring-monorepo/.github/workflows/alerts-infra.yml@refs/heads/main",
  "mento-protocol/monitoring-monorepo/.github/workflows/alerts-rules.yml@refs/heads/main",
  "mento-protocol/monitoring-monorepo/.github/workflows/governance-watchdog.yml@refs/heads/main",
  "mento-protocol/monitoring-monorepo/.github/workflows/terraform-drift.yml@refs/heads/main",
];
export const REFRESH_PROVIDER_CONDITION = `assertion.repository_id == "${GITHUB_REPOSITORY_ID}" && assertion.repository == "mento-protocol/monitoring-monorepo" && assertion.ref == "refs/heads/main" && (${REFRESH_WORKFLOW_REFS.map((workflowRef) => `assertion.workflow_ref == "${workflowRef}"`).join(" || ")})`;

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
