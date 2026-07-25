import {
  attributeExpression,
  blockKey,
  expectExpression,
  expectNoResourceMultiplicity,
  expectString,
  extractExpressionList,
  nestedBlocks,
  normalizeExpression,
  requireBlock,
  sameSortedValues,
  stringAttribute,
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
      "terraform/peg-policy.tf:resource.google_storage_bucket_iam_member.metrics_bridge_runtime_peg_policy_object_viewer",
    ]),
  },
  {
    label: "terraform: Peg policy publisher identity",
    terraformName: "peg_policy_publisher",
    accountId: "peg-policy-publisher",
    allowedBlocks: new Set([
      "terraform/peg-policy.tf:resource.google_service_account.peg_policy_publisher",
      "terraform/peg-policy.tf:resource.google_storage_bucket_iam_member.peg_policy_publisher_object_admin",
      "terraform/peg-policy.tf:resource.google_service_account_iam_member.production_infra_applier_peg_policy_publisher_token_creator",
    ]),
  },
];

function iamBlocks(blocks) {
  return blocks.filter((block) =>
    /_iam_(?:member|binding|policy)$/u.test(block.type),
  );
}

function rejectUnexpectedPegPolicyGrants(
  blocks,
  predicate,
  allowedKeys,
  errors,
  label,
) {
  const unexpected = iamBlocks(blocks)
    .filter(predicate)
    .map(blockKey)
    .filter((key) => !allowedKeys.has(key));
  if (unexpected.length > 0) {
    errors.push(
      `${label}: unexpected IAM grants are forbidden: ${unexpected.sort().join(", ")}`,
    );
  }
}

function referencesPegPolicyRuntime(block) {
  return (
    block.code.includes("google_service_account.metrics_bridge_runtime.") ||
    block.code.includes("metrics-bridge-runtime@")
  );
}

function referencesPegPolicyPublisher(block) {
  return (
    block.code.includes("google_service_account.peg_policy_publisher.") ||
    block.code.includes("peg-policy-publisher@")
  );
}

function validatePegPolicyServiceAccount(blocks, name, accountId, errors) {
  const label = `terraform: Peg policy ${name} identity`;
  const block = requireBlock(
    blocks,
    "terraform/peg-policy.tf",
    "google_service_account",
    name,
    errors,
    label,
  );
  if (!block) return undefined;

  expectNoResourceMultiplicity(block, errors, label);
  expectExpression(
    block,
    "project",
    "google_project.monitoring.project_id",
    errors,
    label,
  );
  expectString(block, "account_id", accountId, errors, label);
  if (
    !sameSortedValues(extractExpressionList(block, "depends_on"), [
      "google_project_service.iam",
    ])
  ) {
    errors.push(`${label}: depends_on must contain only the IAM API`);
  }
  return block;
}

function validatePegPolicyBucketGrant(blocks, { name, role, member }, errors) {
  const label = `terraform: Peg policy ${name} bucket grant`;
  const block = requireBlock(
    blocks,
    "terraform/peg-policy.tf",
    "google_storage_bucket_iam_member",
    name,
    errors,
    label,
  );
  if (!block) return undefined;

  expectNoResourceMultiplicity(block, errors, label);
  expectExpression(
    block,
    "bucket",
    "google_storage_bucket.peg_policy.name",
    errors,
    label,
  );
  expectString(block, "role", role, errors, label);
  expectString(block, "member", member, errors, label);
  return block;
}

function validatePegPolicyLifecycleRule(
  lifecycleRule,
  { state, attribute, value },
  errors,
  label,
) {
  const actions = nestedBlocks(lifecycleRule, "action");
  const conditions = nestedBlocks(lifecycleRule, "condition");
  if (actions.length !== 1 || conditions.length !== 1) {
    errors.push(
      `${label}: lifecycle rule must contain exactly one action and condition`,
    );
    return;
  }
  expectString(actions[0], "type", "Delete", errors, label);
  expectExpression(conditions[0], attribute, value, errors, label);
  expectString(conditions[0], "with_state", state, errors, label);
}

function hasPegPolicyLifecycleCondition(rule, state, attribute, value) {
  return nestedBlocks(rule, "condition").some(
    (condition) =>
      stringAttribute(condition, "with_state") === state &&
      normalizeExpression(attributeExpression(condition, attribute)) === value,
  );
}

function validatePegPolicyAccessLogBucket(files, blocks, errors) {
  const label = "terraform: Peg policy access-log bucket";
  const source = files["terraform/peg-policy.tf"] ?? "";
  const selfLoggingSkip =
    '# trunk-ignore(checkov/CKV_GCP_62): a bucket cannot write access logs to itself.\nresource "google_storage_bucket" "peg_policy_access_logs" {';
  const checkovSkips = source.match(/CKV_GCP_62/gu) ?? [];
  if (checkovSkips.length !== 1 || !source.includes(selfLoggingSkip)) {
    errors.push(
      `${label}: must keep the scoped self-logging Checkov exception on the access-log bucket`,
    );
  }
  const bucket = requireBlock(
    blocks,
    "terraform/peg-policy.tf",
    "google_storage_bucket",
    "peg_policy_access_logs",
    errors,
    label,
  );
  if (bucket) {
    expectNoResourceMultiplicity(bucket, errors, label);
    expectString(
      bucket,
      "name",
      "${google_project.monitoring.project_id}-peg-policy-access-logs",
      errors,
      label,
    );
    expectExpression(
      bucket,
      "project",
      "google_project.monitoring.project_id",
      errors,
      label,
    );
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
      !sameSortedValues(extractExpressionList(bucket, "depends_on"), [
        "google_project_service.storage",
      ])
    ) {
      errors.push(`${label}: depends_on must contain only the Storage API`);
    }

    const versioning = nestedBlocks(bucket, "versioning");
    if (versioning.length !== 1) {
      errors.push(`${label}: must contain exactly one versioning block`);
    } else {
      expectExpression(versioning[0], "enabled", "true", errors, label);
    }

    const lifecycleRules = nestedBlocks(bucket, "lifecycle_rule");
    if (lifecycleRules.length !== 2) {
      errors.push(`${label}: must contain exactly two lifecycle rules`);
    } else {
      const liveRule = lifecycleRules.find((rule) =>
        hasPegPolicyLifecycleCondition(rule, "LIVE", "age", "90"),
      );
      const archivedRule = lifecycleRules.find((rule) =>
        hasPegPolicyLifecycleCondition(
          rule,
          "ARCHIVED",
          "days_since_noncurrent_time",
          "30",
        ),
      );
      if (!liveRule || !archivedRule || liveRule === archivedRule) {
        errors.push(
          `${label}: must retain the LIVE and ARCHIVED retention rules`,
        );
      } else {
        validatePegPolicyLifecycleRule(
          liveRule,
          { state: "LIVE", attribute: "age", value: "90" },
          errors,
          label,
        );
        validatePegPolicyLifecycleRule(
          archivedRule,
          {
            state: "ARCHIVED",
            attribute: "days_since_noncurrent_time",
            value: "30",
          },
          errors,
          label,
        );
      }
    }

    const lifecycles = nestedBlocks(bucket, "lifecycle");
    if (lifecycles.length !== 1) {
      errors.push(`${label}: must contain exactly one lifecycle block`);
    } else {
      expectExpression(lifecycles[0], "prevent_destroy", "true", errors, label);
    }
  }

  const writer = requireBlock(
    blocks,
    "terraform/peg-policy.tf",
    "google_storage_bucket_iam_member",
    "peg_policy_access_logs_writer",
    errors,
    "terraform: Peg policy access-log writer",
  );
  if (writer) {
    const label = "terraform: Peg policy access-log writer";
    expectNoResourceMultiplicity(writer, errors, label);
    expectExpression(
      writer,
      "bucket",
      "google_storage_bucket.peg_policy_access_logs.name",
      errors,
      label,
    );
    expectString(writer, "role", "roles/storage.objectCreator", errors, label);
    expectString(
      writer,
      "member",
      "group:cloud-storage-analytics@google.com",
      errors,
      label,
    );
  }
}

export function validatePegPolicyFoundation(files, blocks, errors) {
  const storageApiLabel = "terraform: Peg policy Storage API";
  const storageApi = requireBlock(
    blocks,
    "terraform/gcp-project.tf",
    "google_project_service",
    "storage",
    errors,
    storageApiLabel,
  );
  if (storageApi) {
    expectNoResourceMultiplicity(storageApi, errors, storageApiLabel);
    expectExpression(
      storageApi,
      "project",
      "google_project.monitoring.project_id",
      errors,
      storageApiLabel,
    );
    expectString(
      storageApi,
      "service",
      "storage.googleapis.com",
      errors,
      storageApiLabel,
    );
    expectExpression(
      storageApi,
      "disable_on_destroy",
      "false",
      errors,
      storageApiLabel,
    );
    expectExpression(
      storageApi,
      "disable_dependent_services",
      "false",
      errors,
      storageApiLabel,
    );
    if (
      !sameSortedValues(extractExpressionList(storageApi, "depends_on"), [
        "google_project_iam_member.terraform_owner",
      ])
    ) {
      errors.push(
        `${storageApiLabel}: depends_on must contain only the Terraform owner grant`,
      );
    }
  }

  const bucketLabel = "terraform: Peg policy bucket";
  const bucket = requireBlock(
    blocks,
    "terraform/peg-policy.tf",
    "google_storage_bucket",
    "peg_policy",
    errors,
    bucketLabel,
  );
  if (bucket) {
    expectNoResourceMultiplicity(bucket, errors, bucketLabel);
    expectString(
      bucket,
      "name",
      "${google_project.monitoring.project_id}-peg-policy",
      errors,
      bucketLabel,
    );
    expectExpression(
      bucket,
      "project",
      "google_project.monitoring.project_id",
      errors,
      bucketLabel,
    );
    expectExpression(bucket, "location", "var.gcp_region", errors, bucketLabel);
    expectExpression(bucket, "force_destroy", "false", errors, bucketLabel);
    expectExpression(
      bucket,
      "uniform_bucket_level_access",
      "true",
      errors,
      bucketLabel,
    );
    expectString(
      bucket,
      "public_access_prevention",
      "enforced",
      errors,
      bucketLabel,
    );
    if (
      !sameSortedValues(extractExpressionList(bucket, "depends_on"), [
        "google_project_service.storage",
        "google_storage_bucket_iam_member.peg_policy_access_logs_writer",
      ])
    ) {
      errors.push(
        `${bucketLabel}: depends_on must contain exactly the Storage API and access-log writer`,
      );
    }

    const versioning = nestedBlocks(bucket, "versioning");
    if (versioning.length !== 1) {
      errors.push(`${bucketLabel}: must contain exactly one versioning block`);
    } else {
      expectExpression(versioning[0], "enabled", "true", errors, bucketLabel);
    }

    const logging = nestedBlocks(bucket, "logging");
    if (logging.length !== 1) {
      errors.push(`${bucketLabel}: must contain exactly one logging block`);
    } else {
      expectExpression(
        logging[0],
        "log_bucket",
        "google_storage_bucket.peg_policy_access_logs.name",
        errors,
        bucketLabel,
      );
      expectString(
        logging[0],
        "log_object_prefix",
        "peg-policy/",
        errors,
        bucketLabel,
      );
    }

    const lifecycleRules = nestedBlocks(bucket, "lifecycle_rule");
    if (lifecycleRules.length !== 1) {
      errors.push(`${bucketLabel}: must contain exactly one lifecycle rule`);
    } else {
      const actions = nestedBlocks(lifecycleRules[0], "action");
      const conditions = nestedBlocks(lifecycleRules[0], "condition");
      if (actions.length !== 1 || conditions.length !== 1) {
        errors.push(
          `${bucketLabel}: lifecycle rule must contain exactly one action and condition`,
        );
      } else {
        expectString(actions[0], "type", "Delete", errors, bucketLabel);
        expectExpression(
          conditions[0],
          "days_since_noncurrent_time",
          "30",
          errors,
          bucketLabel,
        );
        expectString(
          conditions[0],
          "with_state",
          "ARCHIVED",
          errors,
          bucketLabel,
        );
      }
    }

    const lifecycles = nestedBlocks(bucket, "lifecycle");
    if (lifecycles.length !== 1) {
      errors.push(`${bucketLabel}: must contain exactly one lifecycle block`);
    } else {
      expectExpression(
        lifecycles[0],
        "prevent_destroy",
        "true",
        errors,
        bucketLabel,
      );
    }
  }

  validatePegPolicyAccessLogBucket(files, blocks, errors);

  validatePegPolicyServiceAccount(
    blocks,
    "metrics_bridge_runtime",
    "metrics-bridge-runtime",
    errors,
  );
  validatePegPolicyServiceAccount(
    blocks,
    "peg_policy_publisher",
    "peg-policy-publisher",
    errors,
  );

  const runtimeBucketGrant = validatePegPolicyBucketGrant(
    blocks,
    {
      name: "metrics_bridge_runtime_peg_policy_object_viewer",
      role: "roles/storage.objectViewer",
      member:
        "serviceAccount:${google_service_account.metrics_bridge_runtime.email}",
    },
    errors,
  );
  const publisherBucketGrant = validatePegPolicyBucketGrant(
    blocks,
    {
      name: "peg_policy_publisher_object_admin",
      role: "roles/storage.objectAdmin",
      member:
        "serviceAccount:${google_service_account.peg_policy_publisher.email}",
    },
    errors,
  );
  const publisherTokenCreator = requireBlock(
    blocks,
    "terraform/peg-policy.tf",
    "google_service_account_iam_member",
    "production_infra_applier_peg_policy_publisher_token_creator",
    errors,
    "terraform: Peg policy publisher Token Creator",
  );
  if (publisherTokenCreator) {
    const label = "terraform: Peg policy publisher Token Creator";
    expectNoResourceMultiplicity(publisherTokenCreator, errors, label);
    expectExpression(
      publisherTokenCreator,
      "service_account_id",
      "google_service_account.peg_policy_publisher.name",
      errors,
      label,
    );
    expectString(
      publisherTokenCreator,
      "role",
      "roles/iam.serviceAccountTokenCreator",
      errors,
      label,
    );
    expectString(
      publisherTokenCreator,
      "member",
      "serviceAccount:${google_service_account.production_infra_applier.email}",
      errors,
      label,
    );
  }

  rejectUnexpectedPegPolicyGrants(
    blocks,
    referencesPegPolicyRuntime,
    new Set([runtimeBucketGrant].filter(Boolean).map(blockKey)),
    errors,
    "terraform: Peg policy runtime identity",
  );
  rejectUnexpectedPegPolicyGrants(
    blocks,
    referencesPegPolicyPublisher,
    new Set(
      [publisherBucketGrant, publisherTokenCreator]
        .filter(Boolean)
        .map(blockKey),
    ),
    errors,
    "terraform: Peg policy publisher identity",
  );
}
