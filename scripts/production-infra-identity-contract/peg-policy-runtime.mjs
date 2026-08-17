import {
  attributeExpression,
  expectExpression,
  expectNoResourceMultiplicity,
  expectString,
  extractExpressionList,
  nestedBlocks,
  normalizeExpression,
  requireBlock,
  sameSortedValues,
  stringAttribute,
} from "../lib/hcl.mjs";
import {
  ACCESS_LOG_BUCKET_NAME,
  PEG_POLICY_BUCKET_CONTROLLER_MEMBER,
  PEG_POLICY_BUCKET_CONTROLLER_ROLE,
  POLICY_BUCKET_NAME,
} from "./peg-policy-constants.mjs";
import {
  lifecycleIgnoredTraversals,
  rejectUnsafeAdditions,
  validateAuthoritativePolicy,
  validateBucket,
  validateBucketControllerRole,
  validateServiceAccount,
} from "./peg-policy-bucket.mjs";
import {
  rejectBroadProjectFallbacks,
  validatePegPolicyPublicationPlanIdentity,
  validatePegPolicyPublicationPlanVariable,
  validateRuntimeServiceAccountUserGrants,
} from "./peg-policy-publication.mjs";

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
  const rolloutLocals = topLevelBlocks.filter(
    (block) =>
      block.filePath === "terraform/metrics-bridge.tf" &&
      block.kind === "locals" &&
      block.code.includes("metrics_bridge_template_rollout_active"),
  );
  let templateRolloutActive;
  if (rolloutLocals.length !== 1) {
    errors.push(`${label}: must declare exactly one template rollout marker`);
  } else {
    const source = rolloutLocals[0].code;
    const marker = normalizeExpression(
      attributeExpression(
        rolloutLocals[0],
        "metrics_bridge_template_rollout_active",
      ),
    );
    if (
      assignmentCount(source, "metrics_bridge_template_rollout_active") !== 1 ||
      (marker !== "true" && marker !== "false")
    ) {
      errors.push(
        `${label}: template rollout marker must be declared exactly once as true or false`,
      );
    } else {
      templateRolloutActive = marker === "true";
    }
  }
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
  const ignoredTraversals = lifecycleIgnoredTraversals(lifecycles[0]);
  const ignoresAll =
    normalizeExpression(
      attributeExpression(lifecycles[0], "ignore_changes"),
    ) === "all";
  if (!ignoresAll && ignoredTraversals === undefined) {
    errors.push(
      `${label}: ignore_changes must be one static multiline traversal list`,
    );
  }
  const ignoresTemplateRevision = ignoredTraversals?.includes(
    "template[0].revision",
  );
  if (templateRolloutActive === false && !ignoresTemplateRevision) {
    errors.push(
      `${label}: steady state must ignore the generated template revision name`,
    );
  }
  if (templateRolloutActive === true && ignoresTemplateRevision) {
    errors.push(
      `${label}: template rollout must not retain the generated revision name`,
    );
  }
  const ignoredPolicyEnvironment = ignoresAll
    ? "all"
    : ignoredTraversals?.find((traversal) => {
        const broadTemplateAncestors = new Set([
          "template",
          "template[0]",
          "template[0].containers",
          "template[0].containers[0]",
        ]);
        const policyEnvironment = "template[0].containers[0].env";
        return (
          broadTemplateAncestors.has(traversal) ||
          traversal === policyEnvironment ||
          traversal.startsWith(`${policyEnvironment}.`) ||
          traversal.startsWith(`${policyEnvironment}[`)
        );
      });
  if (ignoredPolicyEnvironment) {
    errors.push(
      `${label}: must keep the paired policy environment managed; ignore_changes contains ${ignoredPolicyEnvironment}`,
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
