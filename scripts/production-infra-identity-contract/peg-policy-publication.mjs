import {
  attributeExpression,
  blockKey,
  expectExpression,
  expectNoResourceMultiplicity,
  expectString,
  extractExpressionList,
  extractStringSet,
  requireBlock,
  sameSortedValues,
  stringAttribute,
} from "../lib/hcl.mjs";
import { exactStringList } from "./peg-policy-bucket.mjs";

function validatePegPolicyPublicationPlanIdentity(resources, errors) {
  const plan = requireBlock(
    resources,
    "terraform/ci-wif.tf",
    "google_service_account",
    "peg_policy_publication_plan",
    errors,
    "terraform: Peg policy publication plan identity",
  );
  if (plan) {
    expectNoResourceMultiplicity(
      plan,
      errors,
      "terraform: Peg policy publication plan identity",
    );
    expectString(
      plan,
      "project",
      "mento-terraform-seed-ffac",
      errors,
      "terraform: Peg policy publication plan identity",
    );
    expectString(
      plan,
      "account_id",
      "peg-policy-publication-plan",
      errors,
      "terraform: Peg policy publication plan identity",
    );
  }
  const reader = requireBlock(
    resources,
    "terraform/ci-wif.tf",
    "google_service_account",
    "peg_policy_publication_reader",
    errors,
    "terraform: Peg policy publication reader identity",
  );
  if (reader) {
    expectNoResourceMultiplicity(
      reader,
      errors,
      "terraform: Peg policy publication reader identity",
    );
    expectString(
      reader,
      "project",
      "mento-terraform-seed-ffac",
      errors,
      "terraform: Peg policy publication reader identity",
    );
    expectString(
      reader,
      "account_id",
      "peg-policy-publication-reader",
      errors,
      "terraform: Peg policy publication reader identity",
    );
  }
  const wif = requireBlock(
    resources,
    "terraform/ci-wif.tf",
    "google_service_account_iam_member",
    "peg_policy_publication_plan_wif_binding",
    errors,
    "terraform: Peg policy publication plan WIF binding",
  );
  if (wif) {
    expectNoResourceMultiplicity(
      wif,
      errors,
      "terraform: Peg policy publication plan WIF binding",
    );
    expectExpression(
      wif,
      "service_account_id",
      "google_service_account.peg_policy_publication_plan.name",
      errors,
      "terraform: Peg policy publication plan WIF binding",
    );
    expectString(
      wif,
      "role",
      "roles/iam.workloadIdentityUser",
      errors,
      "terraform: Peg policy publication plan WIF binding",
    );
    expectString(
      wif,
      "member",
      "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github_terraform_refresh.name}/attribute.workflow_ref/mento-protocol/monitoring-monorepo/.github/workflows/peg-policy-publication.yml@refs/heads/main",
      errors,
      "terraform: Peg policy publication plan WIF binding",
    );
  }
  const state = requireBlock(
    resources,
    "terraform/ci-wif.tf",
    "google_storage_bucket_iam_member",
    "state_bucket_peg_policy_publication_reader",
    errors,
    "terraform: Peg policy publication reader state grant",
  );
  if (state) {
    expectNoResourceMultiplicity(
      state,
      errors,
      "terraform: Peg policy publication reader state grant",
    );
    expectString(
      state,
      "bucket",
      "mento-terraform-tfstate-6ed6",
      errors,
      "terraform: Peg policy publication reader state grant",
    );
    expectString(
      state,
      "role",
      "roles/storage.objectViewer",
      errors,
      "terraform: Peg policy publication reader state grant",
    );
    expectString(
      state,
      "member",
      "serviceAccount:${google_service_account.peg_policy_publication_reader.email}",
      errors,
      "terraform: Peg policy publication reader state grant",
    );
  }
  const tokenCreator = requireBlock(
    resources,
    "terraform/ci-wif.tf",
    "google_service_account_iam_member",
    "peg_policy_publication_plan_reader_token_creator",
    errors,
    "terraform: Peg policy publication plan Token Creator",
  );
  if (tokenCreator) {
    expectNoResourceMultiplicity(
      tokenCreator,
      errors,
      "terraform: Peg policy publication plan Token Creator",
    );
    expectExpression(
      tokenCreator,
      "service_account_id",
      "google_service_account.peg_policy_publication_reader.name",
      errors,
      "terraform: Peg policy publication plan Token Creator",
    );
    expectString(
      tokenCreator,
      "role",
      "roles/iam.serviceAccountTokenCreator",
      errors,
      "terraform: Peg policy publication plan Token Creator",
    );
    expectString(
      tokenCreator,
      "member",
      "serviceAccount:${google_service_account.peg_policy_publication_plan.email}",
      errors,
      "terraform: Peg policy publication plan Token Creator",
    );
  }
}

function validatePegPolicyPublicationPlanVariable(resources, errors) {
  const variable = requireBlock(
    resources,
    "terraform/github-variables.tf",
    "github_actions_variable",
    "gcp_peg_policy_publication_plan_service_account",
    errors,
    "terraform: GitHub variable GCP_PEG_POLICY_PUBLICATION_PLAN_SERVICE_ACCOUNT",
  );
  if (!variable) return;
  expectNoResourceMultiplicity(
    variable,
    errors,
    "terraform: GitHub variable GCP_PEG_POLICY_PUBLICATION_PLAN_SERVICE_ACCOUNT",
  );
  expectString(
    variable,
    "repository",
    "monitoring-monorepo",
    errors,
    "terraform: GitHub variable GCP_PEG_POLICY_PUBLICATION_PLAN_SERVICE_ACCOUNT",
  );
  expectString(
    variable,
    "variable_name",
    "GCP_PEG_POLICY_PUBLICATION_PLAN_SERVICE_ACCOUNT",
    errors,
    "terraform: GitHub variable GCP_PEG_POLICY_PUBLICATION_PLAN_SERVICE_ACCOUNT",
  );
  expectExpression(
    variable,
    "value",
    "google_service_account.peg_policy_publication_plan.email",
    errors,
    "terraform: GitHub variable GCP_PEG_POLICY_PUBLICATION_PLAN_SERVICE_ACCOUNT",
  );
  if (
    !sameSortedValues(extractExpressionList(variable, "depends_on"), [
      "google_service_account_iam_member.peg_policy_publication_plan_wif_binding",
      "google_service_account_iam_member.peg_policy_publication_plan_reader_token_creator",
      "google_storage_bucket_iam_member.state_bucket_peg_policy_publication_reader",
      "google_storage_bucket_iam_policy.peg_policy",
    ])
  ) {
    errors.push(
      "terraform: GitHub variable GCP_PEG_POLICY_PUBLICATION_PLAN_SERVICE_ACCOUNT: depends_on must contain the exact publication plan IAM chain",
    );
  }
}

function validateRuntimeServiceAccountUserGrants(topLevelBlocks, errors) {
  const resources = topLevelBlocks.filter((block) => block.kind === "resource");
  const specifications = [
    {
      name: "ci_metrics_bridge_runtime_service_account_user",
      member:
        '"serviceAccount:${google_service_account.metrics_bridge_deployer.email}"',
      dependsOn: [
        "google_service_account.metrics_bridge_deployer",
        "google_service_account.metrics_bridge_runtime",
      ],
    },
    {
      name: "dev_metrics_bridge_runtime_service_account_user",
      member: "each.value",
      forEach: "toset(var.gcp_dev_members)",
      dependsOn: [
        "google_project_iam_member.dev_run_admin",
        "google_service_account.metrics_bridge_runtime",
      ],
    },
  ];
  for (const specification of specifications) {
    const label = `terraform: Peg policy runtime act-as grant ${specification.name}`;
    const grant = requireBlock(
      resources,
      "terraform/deploy-staging.tf",
      "google_service_account_iam_member",
      specification.name,
      errors,
      label,
    );
    if (!grant) continue;
    if (!specification.forEach) {
      expectNoResourceMultiplicity(grant, errors, label);
    }
    expectExpression(
      grant,
      "service_account_id",
      "google_service_account.metrics_bridge_runtime.name",
      errors,
      label,
    );
    expectString(grant, "role", "roles/iam.serviceAccountUser", errors, label);
    expectExpression(grant, "member", specification.member, errors, label);
    if (specification.forEach) {
      expectExpression(grant, "for_each", specification.forEach, errors, label);
    }
    if (
      !sameSortedValues(
        extractExpressionList(grant, "depends_on"),
        specification.dependsOn,
      )
    ) {
      errors.push(
        `${label}: depends_on must contain only the required identities`,
      );
    }
  }

  const defaultComputeGrants = resources
    .filter(
      (block) =>
        block.filePath === "terraform/deploy-staging.tf" &&
        block.type === "google_service_account_iam_member" &&
        stringAttribute(block, "role") === "roles/iam.serviceAccountUser" &&
        block.code.includes("-compute@developer.gserviceaccount.com"),
    )
    .map(blockKey)
    .sort();
  if (defaultComputeGrants.length > 0) {
    errors.push(
      `terraform: Peg policy runtime act-as grants must not target the default Compute service account: ${defaultComputeGrants.join(", ")}`,
    );
  }

  for (const { from, to } of [
    {
      from: "google_service_account_iam_member.ci_default_compute_service_account_user",
      to: "google_service_account_iam_member.ci_metrics_bridge_runtime_service_account_user",
    },
    {
      from: "google_service_account_iam_member.dev_default_compute_service_account_user",
      to: "google_service_account_iam_member.dev_metrics_bridge_runtime_service_account_user",
    },
  ]) {
    const label = `terraform: Peg policy runtime act-as state move ${from}`;
    const matchingMoves = topLevelBlocks.filter(
      (block) =>
        block.filePath === "terraform/deploy-staging.tf" &&
        block.kind === "moved" &&
        attributeExpression(block, "from") === from,
    );
    if (matchingMoves.length !== 1) {
      errors.push(`${label}: must be declared exactly once`);
      continue;
    }
    expectExpression(matchingMoves[0], "to", to, errors, label);
  }
}

function rejectBroadProjectFallbacks(topLevelBlocks, errors) {
  const ciRoles = topLevelBlocks.find(
    (block) =>
      block.filePath === "terraform/ci-wif.tf" &&
      block.kind === "locals" &&
      block.code.includes("ci_deployer_roles"),
  );
  const expectedCiRoles = [
    "roles/cloudbuild.builds.editor",
    "roles/logging.viewer",
    "roles/artifactregistry.writer",
    "roles/run.admin",
    "roles/appengine.appAdmin",
  ];
  if (
    ciRoles &&
    !sameSortedValues(
      exactStringList(ciRoles, "ci_deployer_roles"),
      expectedCiRoles,
    )
  ) {
    errors.push(
      "terraform: ci_deployer_roles must contain only the approved deploy roles",
    );
  }

  const expectedBuilderRoles = [
    "roles/appengine.deployer",
    "roles/artifactregistry.writer",
    "roles/cloudbuild.builds.editor",
    "roles/logging.logWriter",
  ];
  const builderRoles = topLevelBlocks.find(
    (block) =>
      block.filePath === "terraform/aegis-bootstrap.tf" &&
      block.kind === "locals" &&
      block.code.includes("grafana_agent_builder_project_roles"),
  );
  if (
    builderRoles &&
    !sameSortedValues(
      extractStringSet(
        builderRoles?.code ?? "",
        "grafana_agent_builder_project_roles",
      ),
      expectedBuilderRoles,
    )
  ) {
    errors.push(
      "terraform: grafana_agent_builder_project_roles must contain only the approved builder roles",
    );
  }

  const expectedMetricsBridgeBuilderRoles = [
    "roles/cloudbuild.builds.editor",
    "roles/logging.logWriter",
  ];
  const metricsBridgeBuilderRoleBlocks = topLevelBlocks.filter(
    (block) =>
      block.filePath === "terraform/metrics-bridge.tf" &&
      block.kind === "locals" &&
      block.code.includes("metrics_bridge_builder_project_roles"),
  );
  if (metricsBridgeBuilderRoleBlocks.length !== 1) {
    errors.push(
      "terraform: metrics_bridge_builder_project_roles must be declared exactly once",
    );
  } else if (
    !sameSortedValues(
      extractStringSet(
        metricsBridgeBuilderRoleBlocks[0].code,
        "metrics_bridge_builder_project_roles",
      ),
      expectedMetricsBridgeBuilderRoles,
    )
  ) {
    errors.push(
      "terraform: metrics_bridge_builder_project_roles must contain only the approved builder roles",
    );
  }

  const forbiddenProjectRoles = new Set([
    "roles/storage.admin",
    "roles/storage.objectAdmin",
    "roles/iam.serviceAccountUser",
  ]);
  const forbiddenGrants = topLevelBlocks
    .filter(
      (block) =>
        block.kind === "resource" &&
        block.type === "google_project_iam_member" &&
        forbiddenProjectRoles.has(stringAttribute(block, "role")),
    )
    .map(blockKey)
    .sort();
  if (forbiddenGrants.length > 0) {
    errors.push(
      `terraform: direct project IAM grants may not restore broad storage or Service Account User roles: ${forbiddenGrants.join(", ")}`,
    );
  }
}

export {
  rejectBroadProjectFallbacks,
  validatePegPolicyPublicationPlanIdentity,
  validatePegPolicyPublicationPlanVariable,
  validateRuntimeServiceAccountUserGrants,
};
