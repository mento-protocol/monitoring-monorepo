import {
  attributeExpression,
  blockKey,
  commentMaskedHcl,
  expectExpression,
  expectNoResourceMultiplicity,
  expectString,
  extractExpressionList,
  nestedBlocks,
  normalizeExpression,
  requireBlock,
  sameSortedValues,
  stringAttribute,
  topLevelBlockKey,
} from "../lib/hcl.mjs";
import {
  DEDICATED_PROJECT_MARKERS,
  MONITORING_PROJECT,
  PEG_POLICY_BUCKET_CONTROLLER_ROLE,
  PEG_POLICY_BUCKET_CONTROLLER_ROLE_ID,
  PEG_POLICY_BUCKET_CONTROLLER_ROLE_KEY,
  PEG_POLICY_PRODUCTION_APPLIER_GRANT_KEY,
  PEG_POLICY_PUBLICATION_PLAN_TOKEN_CREATOR_GRANT_KEY,
  PEG_POLICY_PUBLICATION_PLAN_WIF_GRANT_KEY,
  PEG_POLICY_PUBLICATION_READER_STATE_GRANT_KEY,
  PEG_POLICY_RUNTIME_SERVICE_ACCOUNT_USER_GRANT_KEYS,
} from "./peg-policy-constants.mjs";

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

function lifecycleIgnoredTraversals(lifecycle) {
  const source = commentMaskedHcl(lifecycle?.code ?? "");
  const matches = [
    ...source.matchAll(
      /(?:^|\n)[ \t]*ignore_changes[ \t]*=[ \t]*\[[ \t]*\n([\s\S]*?)^[ \t]*\][ \t]*$/gmu,
    ),
  ];
  if (matches.length !== 1) return undefined;

  const traversals = matches[0][1]
    .split(",")
    .map((value) => normalizeExpression(value))
    .filter(Boolean);
  return traversals.every((value) =>
    /^[A-Za-z_][A-Za-z0-9_]*(?:(?:\.[A-Za-z_][A-Za-z0-9_]*)|(?:\[[0-9]+\]))*$/u.test(
      value,
    ),
  )
    ? traversals
    : undefined;
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

export {
  exactStringList,
  lifecycleIgnoredTraversals,
  rejectUnsafeAdditions,
  validateAuthoritativePolicy,
  validateBucket,
  validateBucketControllerRole,
  validateServiceAccount,
};
