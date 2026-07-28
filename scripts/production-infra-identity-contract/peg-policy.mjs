import {
  attributeExpression,
  blockKey,
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

export const PEG_POLICY_IDENTITY_REFERENCE_SPECIFICATIONS = [
  {
    label: "terraform: Peg policy runtime identity",
    terraformName: "metrics_bridge_runtime",
    accountId: "metrics-bridge-runtime",
    allowedBlocks: new Set([
      "terraform/peg-policy.tf:resource.google_service_account.metrics_bridge_runtime",
      "terraform/peg-policy.tf:data.google_iam_policy.peg_policy",
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
  for (const { role, member } of expectedBindings) {
    const matching = bindings.filter(
      (binding) =>
        normalizeExpression(attributeExpression(binding, "role")) === role,
    );
    if (matching.length !== 1) {
      errors.push(`${label}: must contain exactly one ${role} binding`);
      continue;
    }
    const binding = matching[0];
    const members = exactStringList(binding, "members");
    if (!sameSortedValues(members, [member])) {
      errors.push(`${label}: ${role} members must contain only ${member}`);
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
        blockKey(block) !==
          "terraform/peg-policy.tf:google_storage_bucket_iam_policy.peg_policy",
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
          member:
            "serviceAccount:${google_service_account.metrics_bridge_runtime.email}",
        },
        {
          role: '"roles/storage.objectAdmin"',
          member:
            "serviceAccount:${google_service_account.peg_policy_publisher.email}",
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
}
