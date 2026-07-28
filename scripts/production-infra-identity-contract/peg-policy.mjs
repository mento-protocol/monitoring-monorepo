import {
  attributeExpression,
  blockKey,
  commentMaskedHcl,
  expectExpression,
  expectNoResourceMultiplicity,
  expectString,
  extractStringSet,
  extractExpressionList,
  nestedBlocks,
  normalizeExpression,
  requireBlock,
  sameSortedValues,
  stringAttribute,
  topLevelBlockKey,
} from "./hcl.mjs";

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

function exactStringList(block, attribute) {
  const match = new RegExp(
    `^\\s*${attribute}\\s*=\\s*\\[\\s*((?:"(?:[^"\\\\]|\\\\.)*"\\s*,?\\s*)*)\\]\\s*$`,
    "gmu",
  ).exec(block?.code ?? "");
  if (!match) return undefined;
  const values = [...match[1].matchAll(/"((?:[^"\\]|\\.)*)"/gu)].map(
    ([, value]) => JSON.parse(`"${value}"`),
  );
  return values.length > 0 ? values : undefined;
}

function requireData(blocks, name, errors, label) {
  const matches = blocks.filter(
    (block) =>
      block.kind === "data" &&
      block.filePath === "terraform/peg-policy.tf" &&
      block.labels[0] === "google_iam_policy" &&
      block.labels[1] === name,
  );
  if (matches.length === 0) {
    errors.push(`${label}: required policy document is missing`);
  } else if (matches.length > 1) {
    errors.push(`${label}: policy document must be declared exactly once`);
  }
  return matches[0];
}

function validateExactBindings(data, expectedBindings, errors, label) {
  const bindings = nestedBlocks(data, "binding");
  if (bindings.length !== expectedBindings.length) {
    errors.push(
      `${label}: must contain exactly ${expectedBindings.length} bindings`,
    );
    return;
  }
  for (const {
    role,
    member,
    members: expectedMembers = [member],
  } of expectedBindings) {
    const matching = bindings.filter(
      (binding) =>
        normalizeExpression(attributeExpression(binding, "role")) === role,
    );
    if (matching.length !== 1) {
      errors.push(`${label}: must contain exactly one ${role} binding`);
      continue;
    }
    const binding = matching[0];
    const actualMembers = exactStringList(binding, "members");
    if (!sameSortedValues(actualMembers, expectedMembers)) {
      errors.push(
        `${label}: ${role} members must contain only ${expectedMembers.join(", ")}`,
      );
    }
    if (nestedBlocks(binding, "condition").length !== 0) {
      errors.push(`${label}: bindings must not be conditional`);
    }
  }
}

function validateBucketLifecycle(bucket, expectedRules, errors, label) {
  const versioning = nestedBlocks(bucket, "versioning");
  if (versioning.length !== 1) {
    errors.push(`${label}: must contain exactly one versioning block`);
  } else {
    expectExpression(versioning[0], "enabled", "true", errors, label);
  }

  const rules = nestedBlocks(bucket, "lifecycle_rule");
  if (rules.length !== expectedRules.length) {
    errors.push(
      `${label}: must contain exactly ${expectedRules.length} lifecycle rules`,
    );
  } else {
    for (const { state, attribute, value } of expectedRules) {
      const rule = rules.find((candidate) => {
        const conditions = nestedBlocks(candidate, "condition");
        return (
          conditions.length === 1 &&
          stringAttribute(conditions[0], "with_state") === state &&
          normalizeExpression(attributeExpression(conditions[0], attribute)) ===
            value
        );
      });
      if (!rule) {
        errors.push(
          `${label}: must retain ${state} ${attribute}=${value} retention`,
        );
        continue;
      }
      const actions = nestedBlocks(rule, "action");
      const conditions = nestedBlocks(rule, "condition");
      if (actions.length !== 1 || conditions.length !== 1) {
        errors.push(`${label}: lifecycle rules need one action and condition`);
        continue;
      }
      expectString(actions[0], "type", "Delete", errors, label);
      expectExpression(conditions[0], attribute, value, errors, label);
      expectString(conditions[0], "with_state", state, errors, label);
    }
  }

  const lifecycle = nestedBlocks(bucket, "lifecycle");
  if (lifecycle.length !== 1) {
    errors.push(`${label}: must contain exactly one lifecycle block`);
  } else {
    expectExpression(lifecycle[0], "prevent_destroy", "true", errors, label);
  }
}

function validateBucket(
  blocks,
  { name, bucketName, dependsOn, rules, logging },
  errors,
) {
  const label = `terraform: Peg policy ${name} bucket`;
  const bucket = requireBlock(
    blocks,
    "terraform/peg-policy.tf",
    "google_storage_bucket",
    name,
    errors,
    label,
  );
  if (!bucket) return;

  expectNoResourceMultiplicity(bucket, errors, label);
  expectString(bucket, "name", bucketName, errors, label);
  expectExpression(bucket, "project", MONITORING_PROJECT, errors, label);
  expectExpression(bucket, "location", "var.gcp_region", errors, label);
  expectExpression(bucket, "force_destroy", "false", errors, label);
  expectExpression(
    bucket,
    "uniform_bucket_level_access",
    "true",
    errors,
    label,
  );
  expectString(bucket, "public_access_prevention", "enforced", errors, label);
  if (
    !sameSortedValues(extractExpressionList(bucket, "depends_on"), dependsOn)
  ) {
    errors.push(
      `${label}: depends_on must contain only the monitoring-project prerequisites`,
    );
  }
  if (logging) {
    const blocks = nestedBlocks(bucket, "logging");
    if (blocks.length !== 1) {
      errors.push(`${label}: must contain exactly one logging block`);
    } else {
      expectExpression(blocks[0], "log_bucket", logging.bucket, errors, label);
      expectString(
        blocks[0],
        "log_object_prefix",
        logging.prefix,
        errors,
        label,
      );
    }
  }
  validateBucketLifecycle(bucket, rules, errors, label);
}

function validateServiceAccount(blocks, name, accountId, errors) {
  const label = `terraform: Peg policy ${name} identity`;
  const account = requireBlock(
    blocks,
    "terraform/peg-policy.tf",
    "google_service_account",
    name,
    errors,
    label,
  );
  if (!account) return;
  expectNoResourceMultiplicity(account, errors, label);
  expectExpression(account, "project", MONITORING_PROJECT, errors, label);
  expectString(account, "account_id", accountId, errors, label);
  if (
    !sameSortedValues(extractExpressionList(account, "depends_on"), [
      "google_project_service.iam",
    ])
  ) {
    errors.push(
      `${label}: depends_on must contain only the monitoring IAM API`,
    );
  }
}

function validateBucketControllerRole(blocks, errors) {
  const label = "terraform: Peg policy bucket controller role";
  const role = requireBlock(
    blocks,
    "terraform/peg-policy.tf",
    "google_project_iam_custom_role",
    "peg_policy_bucket_controller",
    errors,
    label,
  );
  if (!role) return;
  expectNoResourceMultiplicity(role, errors, label);
  expectExpression(role, "project", MONITORING_PROJECT, errors, label);
  expectString(role, "role_id", "pegPolicyBucketController", errors, label);
  expectString(role, "title", "Peg Policy Bucket Controller", errors, label);
  if (
    !sameSortedValues(exactStringList(role, "permissions"), [
      "storage.buckets.get",
      "storage.buckets.getIamPolicy",
      "storage.buckets.setIamPolicy",
      "storage.buckets.update",
    ])
  ) {
    errors.push(
      `${label}: permissions must contain only the bucket IAM reconciliation permissions`,
    );
  }
  if (
    !sameSortedValues(extractExpressionList(role, "depends_on"), [
      "google_project_service.iam",
    ])
  ) {
    errors.push(
      `${label}: depends_on must contain only the monitoring IAM API`,
    );
  }
}

function validateAuthoritativePolicy(
  blocks,
  { name, expectedBindings, dependsOn = [] },
  errors,
) {
  const label = `terraform: Peg policy ${name} authoritative IAM policy`;
  const data = requireData(blocks, name, errors, label);
  if (data) validateExactBindings(data, expectedBindings, errors, label);
  const policy = requireBlock(
    blocks,
    "terraform/peg-policy.tf",
    "google_storage_bucket_iam_policy",
    name,
    errors,
    label,
  );
  if (!policy) return;
  expectNoResourceMultiplicity(policy, errors, label);
  expectExpression(
    policy,
    "bucket",
    `google_storage_bucket.${name}.name`,
    errors,
    label,
  );
  expectExpression(
    policy,
    "policy_data",
    `data.google_iam_policy.${name}.policy_data`,
    errors,
    label,
  );
  const lifecycle = nestedBlocks(policy, "lifecycle");
  if (lifecycle.length !== 1) {
    errors.push(`${label}: must contain exactly one lifecycle block`);
  } else {
    expectExpression(lifecycle[0], "prevent_destroy", "true", errors, label);
  }
  if (
    !sameSortedValues(
      extractExpressionList(policy, "depends_on") ?? [],
      dependsOn,
    )
  ) {
    errors.push(
      `${label}: depends_on must contain exactly the authoritative prerequisites`,
    );
  }
}

function rejectUnsafeAdditions(files, topLevelBlocks, errors) {
  for (const [filePath, source] of Object.entries(files)) {
    if (DEDICATED_PROJECT_MARKERS.some((marker) => source.includes(marker))) {
      errors.push(
        `terraform: separate Peg policy project references are forbidden: ${filePath}`,
      );
    }
  }

  const forbiddenBucketIam = topLevelBlocks
    .filter(
      (block) =>
        block.kind === "resource" &&
        /google_storage_bucket_iam_(?:member|binding)$/u.test(block.type) &&
        (block.code.includes("google_storage_bucket.peg_policy.") ||
          block.code.includes("google_storage_bucket.peg_policy_access_logs.")),
    )
    .map(topLevelBlockKey)
    .sort();
  if (forbiddenBucketIam.length > 0) {
    errors.push(
      `terraform: Peg buckets must use only authoritative IAM policies: ${forbiddenBucketIam.join(", ")}`,
    );
  }

  const controllerRoleUnexpected = topLevelBlocks
    .filter(
      (block) =>
        (block.code.includes(PEG_POLICY_BUCKET_CONTROLLER_ROLE) ||
          block.code.includes(PEG_POLICY_BUCKET_CONTROLLER_ROLE_ID)) &&
        ![
          PEG_POLICY_BUCKET_CONTROLLER_ROLE_KEY,
          "terraform/peg-policy.tf:data.google_iam_policy.peg_policy",
          "terraform/peg-policy.tf:data.google_iam_policy.peg_policy_access_logs",
        ].includes(topLevelBlockKey(block)),
    )
    .map(topLevelBlockKey)
    .sort();
  if (controllerRoleUnexpected.length > 0) {
    errors.push(
      `terraform: Peg policy bucket controller role may be used only by the authoritative bucket policies: ${controllerRoleUnexpected.join(", ")}`,
    );
  }

  const iamBlocks = topLevelBlocks.filter(
    (block) =>
      block.kind === "resource" &&
      /_iam_(?:member|binding|policy)$/u.test(block.type),
  );
  const runtimeUnexpected = iamBlocks
    .filter(
      (block) =>
        (block.code.includes(
          "google_service_account.metrics_bridge_runtime.",
        ) ||
          block.code.includes("metrics-bridge-runtime@")) &&
        ![
          "terraform/peg-policy.tf:google_storage_bucket_iam_policy.peg_policy",
          ...PEG_POLICY_RUNTIME_SERVICE_ACCOUNT_USER_GRANT_KEYS,
        ].includes(blockKey(block)),
    )
    .map(blockKey);
  if (runtimeUnexpected.length > 0) {
    errors.push(
      `terraform: Peg policy runtime identity: unexpected IAM grants are forbidden: ${runtimeUnexpected.join(", ")}`,
    );
  }
  const publisherUnexpected = iamBlocks
    .filter(
      (block) =>
        (block.code.includes("google_service_account.peg_policy_publisher.") ||
          block.code.includes("peg-policy-publisher@")) &&
        ![
          "terraform/peg-policy.tf:google_storage_bucket_iam_policy.peg_policy",
          PEG_POLICY_PRODUCTION_APPLIER_GRANT_KEY,
        ].includes(blockKey(block)),
    )
    .map(blockKey);
  if (publisherUnexpected.length > 0) {
    errors.push(
      `terraform: Peg policy publisher identity: unexpected IAM grants are forbidden: ${publisherUnexpected.join(", ")}`,
    );
  }
  const publicationPlanUnexpected = iamBlocks
    .filter(
      (block) =>
        (block.code.includes(
          "google_service_account.peg_policy_publication_plan.",
        ) ||
          block.code.includes("peg-policy-publication-plan@")) &&
        ![
          PEG_POLICY_PUBLICATION_PLAN_WIF_GRANT_KEY,
          PEG_POLICY_PUBLICATION_PLAN_TOKEN_CREATOR_GRANT_KEY,
        ].includes(blockKey(block)),
    )
    .map(blockKey);
  if (publicationPlanUnexpected.length > 0) {
    errors.push(
      `terraform: Peg policy publication plan identity: unexpected IAM grants are forbidden: ${publicationPlanUnexpected.join(", ")}`,
    );
  }
  const publicationReaderUnexpected = iamBlocks
    .filter(
      (block) =>
        (block.code.includes(
          "google_service_account.peg_policy_publication_reader.",
        ) ||
          block.code.includes("peg-policy-publication-reader@")) &&
        ![
          PEG_POLICY_PUBLICATION_READER_STATE_GRANT_KEY,
          "terraform/peg-policy.tf:google_storage_bucket_iam_policy.peg_policy",
          PEG_POLICY_PUBLICATION_PLAN_TOKEN_CREATOR_GRANT_KEY,
        ].includes(blockKey(block)),
    )
    .map(blockKey);
  if (publicationReaderUnexpected.length > 0) {
    errors.push(
      `terraform: Peg policy publication reader identity: unexpected IAM grants are forbidden: ${publicationReaderUnexpected.join(", ")}`,
    );
  }
}

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

const PEG_POLICY_RUNTIME_GENERATION_CONDITION =
  'local.peg_policy_runtime_generation == null ? true : (can(regex("^[1-9][0-9]*$", local.peg_policy_runtime_generation)) && can(tonumber(local.peg_policy_runtime_generation)) && tonumber(local.peg_policy_runtime_generation) <= 9223372036854775807)';
const PEG_POLICY_RUNTIME_URL =
  '"https://storage.googleapis.com/download/storage/v1/b/${google_storage_bucket.peg_policy.name}/o/peg-policy%2Fcurrent.json?alt=media&generation=${local.peg_policy_runtime_generation}"';
const MAX_GCS_GENERATION = 9_223_372_036_854_775_807n;
const POSITIVE_DECIMAL = /^[1-9][0-9]*$/u;
const QUOTED_POSITIVE_DECIMAL = /^"[1-9][0-9]*"$/u;
const RUNTIME_GENERATION_LITERAL_ERROR =
  "generation must be exactly null or a quoted positive decimal GCS generation within signed 64-bit range";
const PEG_POLICY_RUNTIME_ENV_SOURCE =
  /^\s*peg_policy_runtime_env\s*=\s*local\.peg_policy_runtime_generation\s*==\s*null\s*\?\s*\{\}\s*:\s*\{\s*PEG_POLICY_URL\s*=\s*local\.peg_policy_runtime_url\s*PEG_POLICY_AUTH_MODE\s*=\s*"gcp-metadata"\s*\}/mu;

function assignmentCount(source, attribute) {
  return [...source.matchAll(new RegExp(`^\\s*${attribute}\\s*=`, "gmu"))]
    .length;
}

function hasExactRuntimeExpression(block, source, attribute, expected) {
  return (
    assignmentCount(source, attribute) === 1 &&
    attributeExpression(block, attribute) === expected
  );
}

function isValidRuntimeGenerationLiteral(block) {
  const source = attributeExpression(block, "peg_policy_runtime_generation");
  if (source === "null") return true;

  if (!QUOTED_POSITIVE_DECIMAL.test(source ?? "")) return false;

  const generation = stringAttribute(block, "peg_policy_runtime_generation");
  return (
    typeof generation === "string" &&
    POSITIVE_DECIMAL.test(generation) &&
    BigInt(generation) <= MAX_GCS_GENERATION
  );
}

function validatePegPolicyRuntimeAttachment(files, topLevelBlocks, errors) {
  const label = "terraform: Peg policy runtime attachment";
  const runtimeLocals = topLevelBlocks.filter(
    (block) =>
      block.filePath === "terraform/peg-policy.tf" &&
      block.kind === "locals" &&
      block.code.includes("peg_policy_runtime_generation"),
  );
  if (runtimeLocals.length !== 1) {
    errors.push(`${label}: must declare exactly one runtime locals block`);
  } else {
    const source = runtimeLocals[0].code;
    if (
      assignmentCount(source, "peg_policy_runtime_generation") !== 1 ||
      !isValidRuntimeGenerationLiteral(runtimeLocals[0])
    ) {
      errors.push(`${label}: ${RUNTIME_GENERATION_LITERAL_ERROR}`);
    }
    if (
      !hasExactRuntimeExpression(
        runtimeLocals[0],
        source,
        "peg_policy_runtime_url",
        `local.peg_policy_runtime_generation == null ? null : ${PEG_POLICY_RUNTIME_URL}`,
      )
    ) {
      errors.push(`${label}: canonical URL: must be exactly source-controlled`);
    }
    if (
      assignmentCount(source, "peg_policy_runtime_env") !== 1 ||
      !PEG_POLICY_RUNTIME_ENV_SOURCE.test(source)
    ) {
      errors.push(
        `${label}: paired environment: must be exactly source-controlled`,
      );
    }
  }

  const externalGenerationInputs = topLevelBlocks.filter(
    (block) =>
      block.kind === "variable" &&
      block.labels[0] === "peg_policy_runtime_generation",
  );
  if (externalGenerationInputs.length > 0) {
    errors.push(
      `${label}: runtime generation must be a reviewed source literal, not an external variable`,
    );
  }

  const policyPairOccurrences = Object.values(files)
    .filter((source) => typeof source === "string")
    .join("\n")
    .match(/\bPEG_POLICY_(?:URL|AUTH_MODE)\b/gu);
  if ((policyPairOccurrences?.length ?? 0) !== 2) {
    errors.push(
      `${label}: PEG_POLICY_URL and PEG_POLICY_AUTH_MODE must appear only in the paired runtime map`,
    );
  }

  const runtime = requireBlock(
    topLevelBlocks.filter((block) => block.kind === "resource"),
    "terraform/metrics-bridge.tf",
    "google_cloud_run_v2_service",
    "metrics_bridge",
    errors,
    label,
  );
  if (!runtime) return;
  if (
    !sameSortedValues(extractExpressionList(runtime, "depends_on"), [
      "google_project_service.run",
      "google_storage_bucket_iam_policy.peg_policy",
    ])
  ) {
    errors.push(`${label}: must depend on Cloud Run and the policy IAM grant`);
  }

  const templates = nestedBlocks(runtime, "template");
  if (templates.length !== 1) {
    errors.push(`${label}: must contain exactly one Cloud Run template`);
    return;
  }
  expectExpression(
    templates[0],
    "service_account",
    "google_service_account.metrics_bridge_runtime.email",
    errors,
    label,
  );
  const containers = nestedBlocks(templates[0], "containers");
  if (containers.length !== 1) {
    errors.push(`${label}: must contain exactly one Cloud Run container`);
    return;
  }
  const policyEnv = nestedBlocks(containers[0], 'dynamic "env"');
  if (policyEnv.length !== 1) {
    errors.push(`${label}: must contain exactly one paired policy env block`);
  } else {
    expectExpression(
      policyEnv[0],
      "for_each",
      "local.peg_policy_runtime_env",
      errors,
      label,
    );
    const contents = nestedBlocks(policyEnv[0], "content");
    if (contents.length !== 1) {
      errors.push(
        `${label}: policy env block must contain exactly one content block`,
      );
    } else {
      expectExpression(contents[0], "name", "env.key", errors, label);
      expectExpression(contents[0], "value", "env.value", errors, label);
    }
  }

  const lifecycles = nestedBlocks(runtime, "lifecycle");
  if (lifecycles.length !== 1) {
    errors.push(`${label}: must contain exactly one lifecycle block`);
    return;
  }
  const ignoresTemplateRevision = commentMaskedHcl(lifecycles[0].code).includes(
    "template[0].revision",
  );
  if (
    attributeExpression(runtimeLocals[0], "peg_policy_runtime_generation") ===
      "null" &&
    !ignoresTemplateRevision
  ) {
    errors.push(
      `${label}: must ignore template revision while generation is null`,
    );
  }
  if (
    attributeExpression(runtimeLocals[0], "peg_policy_runtime_generation") !==
      "null" &&
    ignoresTemplateRevision
  ) {
    errors.push(
      `${label}: must not ignore template revision while applying a concrete generation`,
    );
  }
  const preconditions = nestedBlocks(lifecycles[0], "precondition");
  if (preconditions.length !== 1) {
    errors.push(`${label}: must contain exactly one generation precondition`);
  } else {
    expectExpression(
      preconditions[0],
      "condition",
      PEG_POLICY_RUNTIME_GENERATION_CONDITION,
      errors,
      label,
    );
    expectString(
      preconditions[0],
      "error_message",
      "peg_policy_runtime_generation must be null or a positive GCS generation within signed 64-bit range.",
      errors,
      label,
    );
  }
}

export function validatePegPolicyFoundation(files, topLevelBlocks, errors) {
  const resources = topLevelBlocks.filter((block) => block.kind === "resource");
  validateBucket(
    resources,
    {
      name: "peg_policy",
      bucketName: POLICY_BUCKET_NAME,
      dependsOn: [
        "google_project_service.storage",
        "google_storage_bucket_iam_policy.peg_policy_access_logs",
      ],
      logging: {
        bucket: "google_storage_bucket.peg_policy_access_logs.name",
        prefix: "peg-policy/",
      },
      rules: [
        {
          state: "ARCHIVED",
          attribute: "days_since_noncurrent_time",
          value: "30",
        },
      ],
    },
    errors,
  );
  validateBucket(
    resources,
    {
      name: "peg_policy_access_logs",
      bucketName: ACCESS_LOG_BUCKET_NAME,
      dependsOn: ["google_project_service.storage"],
      rules: [
        { state: "LIVE", attribute: "age", value: "90" },
        {
          state: "ARCHIVED",
          attribute: "days_since_noncurrent_time",
          value: "30",
        },
      ],
    },
    errors,
  );
  validateServiceAccount(
    resources,
    "metrics_bridge_runtime",
    "metrics-bridge-runtime",
    errors,
  );
  validatePegPolicyPublicationPlanIdentity(resources, errors);
  validatePegPolicyPublicationPlanVariable(resources, errors);
  validateBucketControllerRole(resources, errors);
  validateServiceAccount(
    resources,
    "peg_policy_publisher",
    "peg-policy-publisher",
    errors,
  );
  validateAuthoritativePolicy(
    topLevelBlocks,
    {
      name: "peg_policy_access_logs",
      expectedBindings: [
        {
          role: '"roles/storage.objectCreator"',
          member: "group:cloud-storage-analytics@google.com",
        },
        {
          role: PEG_POLICY_BUCKET_CONTROLLER_ROLE,
          member: PEG_POLICY_BUCKET_CONTROLLER_MEMBER,
        },
      ],
    },
    errors,
  );
  validateAuthoritativePolicy(
    topLevelBlocks,
    {
      name: "peg_policy",
      expectedBindings: [
        {
          role: '"roles/storage.objectViewer"',
          members: [
            "serviceAccount:${google_service_account.metrics_bridge_runtime.email}",
            "serviceAccount:${google_service_account.peg_policy_publication_reader.email}",
          ],
        },
        {
          role: '"roles/storage.objectAdmin"',
          member:
            "serviceAccount:${google_service_account.peg_policy_publisher.email}",
        },
        {
          role: PEG_POLICY_BUCKET_CONTROLLER_ROLE,
          member: PEG_POLICY_BUCKET_CONTROLLER_MEMBER,
        },
      ],
      dependsOn: ["google_storage_bucket_iam_policy.peg_policy_access_logs"],
    },
    errors,
  );
  const tokenCreator = requireBlock(
    resources,
    "terraform/peg-policy.tf",
    "google_service_account_iam_member",
    "production_infra_applier_peg_policy_publisher_token_creator",
    errors,
    "terraform: Peg policy publisher Token Creator",
  );
  if (tokenCreator) {
    expectNoResourceMultiplicity(
      tokenCreator,
      errors,
      "terraform: Peg policy publisher Token Creator",
    );
    expectExpression(
      tokenCreator,
      "service_account_id",
      "google_service_account.peg_policy_publisher.name",
      errors,
      "terraform: Peg policy publisher Token Creator",
    );
    expectString(
      tokenCreator,
      "role",
      "roles/iam.serviceAccountTokenCreator",
      errors,
      "terraform: Peg policy publisher Token Creator",
    );
    expectString(
      tokenCreator,
      "member",
      "serviceAccount:${google_service_account.production_infra_applier.email}",
      errors,
      "terraform: Peg policy publisher Token Creator",
    );
  }
  rejectUnsafeAdditions(files, topLevelBlocks, errors);
  rejectBroadProjectFallbacks(topLevelBlocks, errors);
  validateRuntimeServiceAccountUserGrants(topLevelBlocks, errors);
  validatePegPolicyRuntimeAttachment(files, topLevelBlocks, errors);
}
