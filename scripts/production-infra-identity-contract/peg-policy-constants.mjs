export const PEG_POLICY_PRODUCTION_APPLIER_GRANT_KEY =
  "terraform/peg-policy.tf:google_service_account_iam_member.production_infra_applier_peg_policy_publisher_token_creator";
const PEG_POLICY_RUNTIME_SERVICE_ACCOUNT_USER_GRANT_KEYS = [
  "terraform/deploy-staging.tf:google_service_account_iam_member.ci_metrics_bridge_runtime_service_account_user",
  "terraform/deploy-staging.tf:google_service_account_iam_member.dev_metrics_bridge_runtime_service_account_user",
];
export const PEG_POLICY_PUBLICATION_PLAN_WIF_GRANT_KEY =
  "terraform/ci-wif.tf:google_service_account_iam_member.peg_policy_publication_plan_wif_binding";
export const PEG_POLICY_PUBLICATION_PLAN_TOKEN_CREATOR_GRANT_KEY =
  "terraform/ci-wif.tf:google_service_account_iam_member.peg_policy_publication_plan_reader_token_creator";
export const PEG_POLICY_PUBLICATION_READER_STATE_GRANT_KEY =
  "terraform/ci-wif.tf:google_storage_bucket_iam_member.state_bucket_peg_policy_publication_reader";
export const PEG_POLICY_BUCKET_CONTROLLER_ROLE_KEY =
  "terraform/peg-policy.tf:resource.google_project_iam_custom_role.peg_policy_bucket_controller";

const PEG_POLICY_BUCKET_CONTROLLER_ROLE =
  "google_project_iam_custom_role.peg_policy_bucket_controller.name";
const PEG_POLICY_BUCKET_CONTROLLER_ROLE_ID = "pegPolicyBucketController";
const PEG_POLICY_BUCKET_CONTROLLER_MEMBER =
  "serviceAccount:${var.terraform_service_account}";

export const PEG_POLICY_IDENTITY_REFERENCE_SPECIFICATIONS = [
  {
    label: "terraform: Peg policy runtime identity",
    terraformName: "metrics_bridge_runtime",
    accountId: "metrics-bridge-runtime",
    allowedBlocks: new Set([
      "terraform/peg-policy.tf:resource.google_service_account.metrics_bridge_runtime",
      "terraform/peg-policy.tf:data.google_iam_policy.peg_policy",
      "terraform/metrics-bridge.tf:resource.google_cloud_run_v2_service.metrics_bridge",
      "terraform/deploy-staging.tf:resource.google_service_account_iam_member.ci_metrics_bridge_runtime_service_account_user",
      "terraform/deploy-staging.tf:resource.google_service_account_iam_member.dev_metrics_bridge_runtime_service_account_user",
    ]),
  },
  {
    label: "terraform: Peg policy publisher identity",
    terraformName: "peg_policy_publisher",
    accountId: "peg-policy-publisher",
    allowedBlocks: new Set([
      "terraform/peg-policy.tf:resource.google_service_account.peg_policy_publisher",
      "terraform/peg-policy.tf:data.google_iam_policy.peg_policy",
      "terraform/peg-policy.tf:resource.google_service_account_iam_member.production_infra_applier_peg_policy_publisher_token_creator",
      "alerts/peg-policy-publication/variables.tf:variable.terraform_service_account",
    ]),
  },
  {
    label: "terraform: Peg policy publication plan identity",
    terraformName: "peg_policy_publication_plan",
    accountId: "peg-policy-publication-plan",
    allowedBlocks: new Set([
      "terraform/ci-wif.tf:resource.google_service_account.peg_policy_publication_plan",
      PEG_POLICY_PUBLICATION_PLAN_WIF_GRANT_KEY.replace(
        ":google_",
        ":resource.google_",
      ),
      PEG_POLICY_PUBLICATION_PLAN_TOKEN_CREATOR_GRANT_KEY.replace(
        ":google_",
        ":resource.google_",
      ),
      "terraform/github-variables.tf:resource.github_actions_variable.gcp_peg_policy_publication_plan_service_account",
    ]),
  },
  {
    label: "terraform: Peg policy publication reader identity",
    terraformName: "peg_policy_publication_reader",
    accountId: "peg-policy-publication-reader",
    allowedBlocks: new Set([
      "terraform/ci-wif.tf:resource.google_service_account.peg_policy_publication_reader",
      PEG_POLICY_PUBLICATION_READER_STATE_GRANT_KEY.replace(
        ":google_",
        ":resource.google_",
      ),
      PEG_POLICY_PUBLICATION_PLAN_TOKEN_CREATOR_GRANT_KEY.replace(
        ":google_",
        ":resource.google_",
      ),
      "terraform/peg-policy.tf:data.google_iam_policy.peg_policy",
      "alerts/peg-policy-publication/variables.tf:variable.terraform_service_account",
    ]),
  },
];

const MONITORING_PROJECT = "google_project.monitoring.project_id";
const POLICY_BUCKET_NAME = "${google_project.monitoring.project_id}-peg-policy";
const ACCESS_LOG_BUCKET_NAME =
  "${google_project.monitoring.project_id}-peg-policy-access-logs";
const DEDICATED_PROJECT_MARKERS = [
  "gcp_peg_policy_project_id",
  "google_project.peg_policy",
  'resource "google_project" "peg_policy"',
];

export {
  ACCESS_LOG_BUCKET_NAME,
  DEDICATED_PROJECT_MARKERS,
  MONITORING_PROJECT,
  PEG_POLICY_BUCKET_CONTROLLER_MEMBER,
  PEG_POLICY_BUCKET_CONTROLLER_ROLE,
  PEG_POLICY_BUCKET_CONTROLLER_ROLE_ID,
  PEG_POLICY_RUNTIME_SERVICE_ACCOUNT_USER_GRANT_KEYS,
  POLICY_BUCKET_NAME,
};
