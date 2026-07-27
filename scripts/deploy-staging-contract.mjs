import {
  expectExpression,
  expectNoResourceMultiplicity,
  expectString,
  nestedBlocks,
  requireBlock,
  terraformTopLevelBlocks,
} from "./production-infra-identity-contract/hcl.mjs";
import {
  discoverDeployStagingCallsites,
  parseDeployStagingStructuredFile,
} from "./deploy-staging-callsite-discovery.mjs";

export { discoverDeployStagingCallsites } from "./deploy-staging-callsite-discovery.mjs";

const TERRAFORM_FILE = "terraform/deploy-staging.tf";

const EXPECTED_CALLSITES = [
  {
    filePath: ".github/workflows/metrics-bridge.yml",
    kind: "builds-submit",
    flag: "gcs-source-staging-dir",
    value: "gs://${GCP_PROJECT}-cloud-build-source/metrics-bridge",
  },
  {
    filePath: "scripts/deploy-bridge.sh",
    kind: "builds-submit",
    flag: "gcs-source-staging-dir",
    value: "gs://${PROJECT}-cloud-build-source/metrics-bridge",
  },
  {
    filePath: "aegis/grafana-agent/deploy.sh",
    kind: "builds-submit",
    flag: "gcs-source-staging-dir",
    value: "gs://${project}-cloud-build-source/alloy",
  },
  {
    filePath: "aegis/bin/deploy.sh",
    kind: "app-deploy",
    flag: "bucket",
    value: "gs://mento-monitoring-app-engine-source",
  },
  {
    filePath: "aegis/grafana-agent/cloudbuild.yaml",
    kind: "app-deploy",
    flag: "bucket",
    value: "gs://mento-monitoring-app-engine-source",
  },
];

function requireSource(files, filePath, errors) {
  const contents = files[filePath];
  if (typeof contents !== "string") {
    errors.push(`${filePath}: file is required by the deploy-staging contract`);
    return "";
  }
  return contents;
}

function expectOneNested(block, type, errors, label) {
  const matches = nestedBlocks(block, type);
  if (matches.length !== 1) {
    errors.push(`${label}: must contain exactly one ${type} block`);
  }
  return matches[0];
}

function validateBucket(blocks, { name, suffix, location, age }, errors) {
  const label = `${TERRAFORM_FILE}: ${name}`;
  const bucket = requireBlock(
    blocks,
    TERRAFORM_FILE,
    "google_storage_bucket",
    name,
    errors,
    label,
  );
  if (!bucket) return;

  expectNoResourceMultiplicity(bucket, errors, label);
  expectExpression(
    bucket,
    "project",
    "google_project.monitoring.project_id",
    errors,
    label,
  );
  expectString(
    bucket,
    "name",
    `\${google_project.monitoring.project_id}-${suffix}`,
    errors,
    label,
  );
  if (location.startsWith('"')) {
    expectString(bucket, "location", JSON.parse(location), errors, label);
  } else {
    expectExpression(bucket, "location", location, errors, label);
  }
  expectExpression(bucket, "force_destroy", "false", errors, label);
  expectExpression(
    bucket,
    "uniform_bucket_level_access",
    "true",
    errors,
    label,
  );
  expectString(bucket, "public_access_prevention", "enforced", errors, label);
  expectExpression(
    bucket,
    "depends_on",
    "[google_project_service.storage]",
    errors,
    label,
  );

  const lifecycleRule = expectOneNested(
    bucket,
    "lifecycle_rule",
    errors,
    label,
  );
  const action = expectOneNested(lifecycleRule, "action", errors, label);
  const condition = expectOneNested(lifecycleRule, "condition", errors, label);
  expectString(action, "type", "Delete", errors, label);
  expectExpression(condition, "age", String(age), errors, label);
  expectString(condition, "with_state", "LIVE", errors, label);

  const softDelete = expectOneNested(
    bucket,
    "soft_delete_policy",
    errors,
    label,
  );
  expectExpression(
    softDelete,
    "retention_duration_seconds",
    "0",
    errors,
    label,
  );
  const lifecycle = expectOneNested(bucket, "lifecycle", errors, label);
  expectExpression(lifecycle, "prevent_destroy", "true", errors, label);
}

function validateTerraform(files, errors) {
  const contents = requireSource(files, TERRAFORM_FILE, errors);
  const blocks = terraformTopLevelBlocks(
    { [TERRAFORM_FILE]: contents },
    errors,
  );
  validateBucket(
    blocks,
    {
      name: "cloud_build_source_staging",
      suffix: "cloud-build-source",
      location: "var.gcp_region",
      age: 7,
    },
    errors,
  );
  validateBucket(
    blocks,
    {
      name: "app_engine_source_staging",
      suffix: "app-engine-source",
      location: '"US"',
      age: 30,
    },
    errors,
  );
}

function hasFlag(record, flag, value) {
  const args = record.args ?? record.invocationArgs;
  return args.some(
    (argument, index) =>
      argument === `--${flag}=${value}` ||
      (argument === `--${flag}` && args[index + 1] === value),
  );
}

function validateCallsites(files, errors) {
  const records = discoverDeployStagingCallsites(files, errors);
  const expectedKeys = EXPECTED_CALLSITES.map(
    ({ filePath, kind }) => `${filePath}:${kind}`,
  ).sort();
  const actualKeys = records
    .map(({ filePath, kind }) => `${filePath}:${kind}`)
    .sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    errors.push(
      `deploy-staging executable callsite inventory must be exactly ${expectedKeys.join(", ")}; found ${actualKeys.join(", ") || "none"}`,
    );
  }

  for (const expected of EXPECTED_CALLSITES) {
    const matches = records.filter(
      (record) =>
        record.filePath === expected.filePath && record.kind === expected.kind,
    );
    if (
      matches.length === 1 &&
      !hasFlag(matches[0], expected.flag, expected.value)
    ) {
      errors.push(
        `${expected.filePath}: ${expected.kind} must use --${expected.flag}=${expected.value}`,
      );
    }
  }

  const alloyPath = "aegis/grafana-agent/cloudbuild.yaml";
  const alloy = parseDeployStagingStructuredFile(
    alloyPath,
    requireSource(files, alloyPath, errors),
    errors,
  );
  if (alloy?.options?.logging !== "CLOUD_LOGGING_ONLY") {
    errors.push(`${alloyPath}: Cloud Build logging must be CLOUD_LOGGING_ONLY`);
  }
}

export function validateDeployStagingContract(files) {
  const errors = [];
  validateTerraform(files, errors);
  validateCallsites(files, errors);
  return errors;
}

export function assertDeployStagingContract(files) {
  const errors = validateDeployStagingContract(files);
  if (errors.length > 0) {
    throw new Error(
      `Deployment source-staging contract failed:\n- ${errors.join("\n- ")}`,
    );
  }
}
