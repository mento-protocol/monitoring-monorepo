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

const PEG_POLICY_PROJECT_ID = "mento-monitoring-peg-policy";
const PEG_POLICY_PROJECT_EXPRESSION = "google_project.peg_policy.project_id";
const PEG_POLICY_PROJECT_MARKERS = [
  PEG_POLICY_PROJECT_EXPRESSION,
  "var.gcp_peg_policy_project_id",
  PEG_POLICY_PROJECT_ID,
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

function validatePegPolicyServiceAccount(
  blocks,
  name,
  accountId,
  project,
  iamApi,
  errors,
) {
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
  expectExpression(block, "project", project, errors, label);
  expectString(block, "account_id", accountId, errors, label);
  if (!sameSortedValues(extractExpressionList(block, "depends_on"), [iamApi])) {
    errors.push(`${label}: depends_on must contain only the IAM API`);
  }
  return block;
}

function validatePegPolicyProject(topLevelBlocks, blocks, errors) {
  const variableLabel = "terraform: Peg policy project ID";
  const projectId = requireBlock(
    topLevelBlocks,
    "terraform/variables.tf",
    "variable",
    "gcp_peg_policy_project_id",
    errors,
    variableLabel,
  );
  if (projectId) {
    expectExpression(projectId, "type", "string", errors, variableLabel);
    expectString(
      projectId,
      "default",
      PEG_POLICY_PROJECT_ID,
      errors,
      variableLabel,
    );
  }

  const projectLabel = "terraform: isolated Peg policy project";
  const project = requireBlock(
    blocks,
    "terraform/peg-policy.tf",
    "google_project",
    "peg_policy",
    errors,
    projectLabel,
  );
  if (project) {
    expectNoResourceMultiplicity(project, errors, projectLabel);
    expectString(project, "name", "Mento Peg Policy", errors, projectLabel);
    expectExpression(
      project,
      "project_id",
      "var.gcp_peg_policy_project_id",
      errors,
      projectLabel,
    );
    expectExpression(project, "org_id", "var.gcp_org_id", errors, projectLabel);
    expectExpression(
      project,
      "billing_account",
      "var.gcp_billing_account",
      errors,
      projectLabel,
    );
    expectExpression(
      project,
      "auto_create_network",
      "false",
      errors,
      projectLabel,
    );
    const lifecycles = nestedBlocks(project, "lifecycle");
    if (lifecycles.length !== 1) {
      errors.push(`${projectLabel}: must contain exactly one lifecycle block`);
    } else {
      expectExpression(
        lifecycles[0],
        "prevent_destroy",
        "true",
        errors,
        projectLabel,
      );
    }
  }

  const ownerLabel = "terraform: Peg policy Terraform owner bootstrap";
  const owner = requireBlock(
    blocks,
    "terraform/peg-policy.tf",
    "google_project_iam_member",
    "peg_policy_terraform_owner",
    errors,
    ownerLabel,
  );
  if (owner) {
    expectNoResourceMultiplicity(owner, errors, ownerLabel);
    expectExpression(
      owner,
      "project",
      PEG_POLICY_PROJECT_EXPRESSION,
      errors,
      ownerLabel,
    );
    expectString(owner, "role", "roles/owner", errors, ownerLabel);
    expectString(
      owner,
      "member",
      "serviceAccount:${var.terraform_service_account}",
      errors,
      ownerLabel,
    );
  }

  const expectedApis = new Map([
    ["peg_policy_storage", "storage.googleapis.com"],
    ["peg_policy_iam", "iam.googleapis.com"],
  ]);
  for (const [name, service] of expectedApis) {
    const label = `terraform: Peg policy ${name} API`;
    const api = requireBlock(
      blocks,
      "terraform/peg-policy.tf",
      "google_project_service",
      name,
      errors,
      label,
    );
    if (!api) continue;
    expectNoResourceMultiplicity(api, errors, label);
    expectExpression(
      api,
      "project",
      PEG_POLICY_PROJECT_EXPRESSION,
      errors,
      label,
    );
    expectString(api, "service", service, errors, label);
    expectExpression(api, "disable_on_destroy", "false", errors, label);
    expectExpression(api, "disable_dependent_services", "false", errors, label);
    if (
      !sameSortedValues(extractExpressionList(api, "depends_on"), [
        "google_project_iam_member.peg_policy_terraform_owner",
      ])
    ) {
      errors.push(
        `${label}: depends_on must contain only the protected Terraform owner bootstrap`,
      );
    }
  }

  const extraApis = blocks
    .filter(
      (block) =>
        block.type === "google_project_service" &&
        normalizeExpression(attributeExpression(block, "project")) ===
          PEG_POLICY_PROJECT_EXPRESSION &&
        !expectedApis.has(block.name),
    )
    .map(blockKey)
    .sort();
  if (extraApis.length > 0) {
    errors.push(
      `terraform: isolated Peg policy project may enable only Storage and IAM: ${extraApis.join(", ")}`,
    );
  }
}

function exactStringList(block, attribute) {
  const match = new RegExp(
    `^\\s*${attribute}\\s*=\\s*\\[\\s*((?:"(?:[^"\\\\]|\\\\.)*"\\s*,?\\s*)*)\\]\\s*$`,
    "gmu",
  ).exec(block.code);
  if (!match) return undefined;
  const values = [...match[1].matchAll(/"((?:[^"\\]|\\.)*)"/gu)].map(
    ([, value]) => JSON.parse(`"${value}"`),
  );
  return values.length > 0 ? values : undefined;
}

function requireData(blocks, type, name, errors, label) {
  const matches = blocks.filter(
    (block) =>
      block.kind === "data" &&
      block.filePath === "terraform/peg-policy.tf" &&
      block.labels[0] === type &&
      block.labels[1] === name,
  );
  if (matches.length === 0) {
    errors.push(`${label}: required data ${type}.${name} is missing`);
  } else if (matches.length > 1) {
    errors.push(`${label}: data ${type}.${name} must be declared exactly once`);
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
    expectExpression(binding, "role", role, errors, label);
    const members = exactStringList(binding, "members");
    if (!sameSortedValues(members, [member])) {
      errors.push(`${label}: ${role} members must contain only ${member}`);
    }
    if (nestedBlocks(binding, "condition").length !== 0) {
      errors.push(`${label}: ${role} binding must not be conditional`);
    }
  }
}

function validatePegPolicyCustomRole(blocks, errors) {
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
  expectExpression(
    role,
    "project",
    PEG_POLICY_PROJECT_EXPRESSION,
    errors,
    label,
  );
  expectString(role, "role_id", "pegPolicyBucketController", errors, label);
  const permissions = exactStringList(role, "permissions");
  if (
    !sameSortedValues(permissions, [
      "storage.buckets.get",
      "storage.buckets.getIamPolicy",
      "storage.buckets.setIamPolicy",
      "storage.buckets.update",
    ])
  ) {
    errors.push(
      `${label}: permissions must contain only the exact bucket controls`,
    );
  }
  if (
    !sameSortedValues(extractExpressionList(role, "depends_on"), [
      "google_project_service.peg_policy_iam",
    ])
  ) {
    errors.push(`${label}: depends_on must contain only the IAM API`);
  }
}

function validatePegPolicyAuthoritativePolicy(
  blocks,
  { name, bucket, expectedBindings, dependsOn = [] },
  errors,
) {
  const label = `terraform: Peg policy ${name} authoritative IAM policy`;
  const data = requireData(blocks, "google_iam_policy", name, errors, label);
  if (data) {
    validateExactBindings(data, expectedBindings, errors, label);
  }

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
  expectExpression(policy, "bucket", bucket, errors, label);
  expectExpression(
    policy,
    "policy_data",
    `data.google_iam_policy.${name}.policy_data`,
    errors,
    label,
  );
  const lifecycles = nestedBlocks(policy, "lifecycle");
  if (lifecycles.length !== 1) {
    errors.push(`${label}: must contain exactly one lifecycle block`);
  } else {
    expectExpression(lifecycles[0], "prevent_destroy", "true", errors, label);
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

function rejectPegBucketMemberOrBindingResources(blocks, errors) {
  const pegBucketTargets = [
    "google_storage_bucket.peg_policy.",
    "google_storage_bucket.peg_policy_access_logs.",
    PEG_POLICY_PROJECT_EXPRESSION,
    "${google_project.peg_policy.project_id}-access-logs",
    PEG_POLICY_PROJECT_ID,
    `${PEG_POLICY_PROJECT_ID}-access-logs`,
  ];
  const forbidden = blocks
    .filter(
      (block) =>
        block.kind === "resource" &&
        /google_storage_bucket_iam_(?:member|binding)$/u.test(block.type) &&
        pegBucketTargets.some((target) => block.code.includes(target)),
    )
    .map(blockKey)
    .sort();
  if (forbidden.length > 0) {
    errors.push(
      `terraform: Peg buckets must use only authoritative IAM policies, not member or binding resources: ${forbidden.join(", ")}`,
    );
  }
}

function rejectUnexpectedPegProjectReferences(topLevelBlocks, errors) {
  const allowed = new Set([
    "terraform/variables.tf:variable.gcp_peg_policy_project_id",
    "terraform/peg-policy.tf:resource.google_project.peg_policy",
    "terraform/peg-policy.tf:resource.google_project_iam_member.peg_policy_terraform_owner",
    "terraform/peg-policy.tf:resource.google_project_service.peg_policy_storage",
    "terraform/peg-policy.tf:resource.google_project_service.peg_policy_iam",
    "terraform/peg-policy.tf:resource.google_storage_bucket.peg_policy",
    "terraform/peg-policy.tf:resource.google_storage_bucket.peg_policy_access_logs",
    "terraform/peg-policy.tf:resource.google_project_iam_custom_role.peg_policy_bucket_controller",
    "terraform/peg-policy.tf:resource.google_service_account.peg_policy_publisher",
  ]);
  const unexpected = topLevelBlocks
    .filter(
      (block) =>
        PEG_POLICY_PROJECT_MARKERS.some((marker) =>
          block.code.includes(marker),
        ) && !allowed.has(topLevelBlockKey(block)),
    )
    .map(topLevelBlockKey)
    .sort();
  if (unexpected.length > 0) {
    errors.push(
      `terraform: isolated Peg policy project references are restricted to the source foundation: ${unexpected.join(", ")}`,
    );
  }
}

function rejectCustomRoleReferencesOutsidePolicies(blocks, errors) {
  const allowed = new Set([
    "terraform/peg-policy.tf:data.google_iam_policy.peg_policy",
    "terraform/peg-policy.tf:data.google_iam_policy.peg_policy_access_logs",
  ]);
  const unexpected = blocks
    .filter(
      (block) =>
        block.code.includes(
          "google_project_iam_custom_role.peg_policy_bucket_controller",
        ) && !allowed.has(topLevelBlockKey(block)),
    )
    .map(topLevelBlockKey)
    .sort();
  if (unexpected.length > 0) {
    errors.push(
      `terraform: Peg policy bucket controller role may appear only in the two authoritative policy documents: ${unexpected.join(", ")}`,
    );
  }
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
      "${google_project.peg_policy.project_id}-access-logs",
      errors,
      label,
    );
    expectExpression(
      bucket,
      "project",
      PEG_POLICY_PROJECT_EXPRESSION,
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
        "google_project_service.peg_policy_storage",
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
}

export function validatePegPolicyFoundation(files, topLevelBlocks, errors) {
  const blocks = topLevelBlocks.filter((block) => block.kind === "resource");
  validatePegPolicyProject(topLevelBlocks, blocks, errors);

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
    expectExpression(
      bucket,
      "name",
      PEG_POLICY_PROJECT_EXPRESSION,
      errors,
      bucketLabel,
    );
    expectExpression(
      bucket,
      "project",
      PEG_POLICY_PROJECT_EXPRESSION,
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
        "google_project_service.peg_policy_storage",
        "google_storage_bucket_iam_policy.peg_policy_access_logs",
      ])
    ) {
      errors.push(
        `${bucketLabel}: depends_on must contain exactly the Storage API and authoritative access-log policy`,
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
    "google_project.monitoring.project_id",
    "google_project_service.iam",
    errors,
  );
  validatePegPolicyServiceAccount(
    blocks,
    "peg_policy_publisher",
    "peg-policy-publisher",
    PEG_POLICY_PROJECT_EXPRESSION,
    "google_project_service.peg_policy_iam",
    errors,
  );

  validatePegPolicyCustomRole(blocks, errors);
  validatePegPolicyAuthoritativePolicy(
    topLevelBlocks,
    {
      name: "peg_policy_access_logs",
      bucket: "google_storage_bucket.peg_policy_access_logs.name",
      expectedBindings: [
        {
          role: "google_project_iam_custom_role.peg_policy_bucket_controller.name",
          member: "serviceAccount:${var.terraform_service_account}",
        },
        {
          role: '"roles/storage.objectCreator"',
          member: "group:cloud-storage-analytics@google.com",
        },
      ],
    },
    errors,
  );
  validatePegPolicyAuthoritativePolicy(
    topLevelBlocks,
    {
      name: "peg_policy",
      bucket: "google_storage_bucket.peg_policy.name",
      expectedBindings: [
        {
          role: "google_project_iam_custom_role.peg_policy_bucket_controller.name",
          member: "serviceAccount:${var.terraform_service_account}",
        },
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

  rejectPegBucketMemberOrBindingResources(topLevelBlocks, errors);
  rejectUnexpectedPegProjectReferences(topLevelBlocks, errors);
  rejectCustomRoleReferencesOutsidePolicies(topLevelBlocks, errors);
  rejectUnexpectedPegPolicyGrants(
    blocks,
    referencesPegPolicyRuntime,
    new Set(),
    errors,
    "terraform: Peg policy runtime identity",
  );
  rejectUnexpectedPegPolicyGrants(
    blocks,
    referencesPegPolicyPublisher,
    new Set([publisherTokenCreator].filter(Boolean).map(blockKey)),
    errors,
    "terraform: Peg policy publisher identity",
  );
}
