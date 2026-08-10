import {
  extractStringSet,
  expectExpression,
  expectNoResourceMultiplicity,
  expectString,
  nestedBlocks,
  requireBlock,
  sameSortedValues,
  terraformTopLevelBlocks,
} from "./production-infra-identity-contract/hcl.mjs";
import {
  discoverDeployStagingCallsites,
  isGcloudExecutable,
  parseDeployStagingStructuredFile,
} from "./deploy-staging-callsite-discovery.mjs";

export {
  discoverDeployStagingCallsites,
  stripDeployStagingTemplateSuffix,
} from "./deploy-staging-callsite-discovery.mjs";

const TERRAFORM_FILE = "terraform/deploy-staging.tf";
const METRICS_BRIDGE_BUILD_CONFIG = "cloudbuild.yaml";
const METRICS_BRIDGE_BUILDER =
  "projects/$PROJECT_ID/serviceAccounts/metrics-bridge-builder@$PROJECT_ID.iam.gserviceaccount.com";
const METRICS_BRIDGE_DIRECT_BOOTSTRAP_TARGETS = [
  "google_project_iam_member.metrics_bridge_builder",
  "google_artifact_registry_repository_iam_member.metrics_bridge_builder_writer",
  "google_project_iam_member.dev_logging_viewer",
  "google_service_account_iam_member.dev_metrics_bridge_builder_service_account_user",
  "google_service_account_iam_member.dev_metrics_bridge_runtime_service_account_user",
];
const METRICS_BRIDGE_SERVICE_BOOTSTRAP_TARGETS = [
  "google_cloud_run_v2_service.metrics_bridge",
  "google_cloud_run_v2_service_iam_member.metrics_bridge_public",
];
const CLOUD_BUILD_SOURCE_EXECUTORS = [
  "serviceAccount:${google_service_account.grafana_agent_builder.email}",
  "serviceAccount:${google_project.monitoring.number}-compute@developer.gserviceaccount.com",
  "serviceAccount:${google_service_account.metrics_bridge_builder.email}",
];

const EXPECTED_CALLSITES = [
  {
    filePath: ".github/workflows/metrics-bridge.yml",
    surface: "jobs.deploy.steps[3].run",
    kind: "builds-submit",
    flag: "gcs-source-staging-dir",
    value: "gs://${GCP_PROJECT}-cloud-build-source/metrics-bridge",
  },
  {
    filePath: "scripts/deploy-bridge.sh",
    surface: "shell",
    kind: "builds-submit",
    flag: "gcs-source-staging-dir",
    value: "gs://${PROJECT}-cloud-build-source/metrics-bridge",
  },
  {
    filePath: "aegis/grafana-agent/deploy.sh",
    surface: "shell",
    kind: "builds-submit",
    flag: "gcs-source-staging-dir",
    value: "gs://${project}-cloud-build-source/alloy",
  },
  {
    filePath: "aegis/bin/deploy.sh",
    surface: "shell",
    kind: "app-deploy",
    flag: "bucket",
    value: "gs://mento-monitoring-app-engine-source",
  },
  {
    filePath: "aegis/grafana-agent/cloudbuild.yaml",
    surface: "steps[0].args",
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
  validateCloudBuildSourceExecutors(blocks, errors);
}

function validateCloudBuildSourceExecutors(blocks, errors) {
  const label = `${TERRAFORM_FILE}: Cloud Build source executors`;
  const executorLocals = blocks.filter(
    (block) =>
      block.filePath === TERRAFORM_FILE &&
      block.kind === "locals" &&
      block.code.includes("cloud_build_source_executor_members"),
  );
  if (executorLocals.length !== 1) {
    errors.push(`${label}: must declare exactly one executor set`);
    return;
  }
  if (
    !sameSortedValues(
      extractStringSet(
        executorLocals[0].code,
        "cloud_build_source_executor_members",
      ),
      CLOUD_BUILD_SOURCE_EXECUTORS,
    )
  ) {
    errors.push(
      `${label}: must contain the two dedicated builders and temporary default Compute reader`,
    );
  }

  const grant = requireBlock(
    blocks,
    TERRAFORM_FILE,
    "google_storage_bucket_iam_member",
    "cloud_build_source_executor_object_viewer",
    errors,
    label,
  );
  if (!grant) return;
  expectExpression(
    grant,
    "for_each",
    "local.cloud_build_source_executor_members",
    errors,
    label,
  );
  expectExpression(
    grant,
    "bucket",
    "google_storage_bucket.cloud_build_source_staging.name",
    errors,
    label,
  );
  expectString(grant, "role", "roles/storage.objectViewer", errors, label);
}

function isShellRedirection(token) {
  return /^(?:(?:\d+|\{[A-Za-z_][A-Za-z0-9_]*\})?(?:<<<|<<-|<<|<>|>\||>>|>|<|>&|<&)|&>>|&>)$/u.test(
    token,
  );
}

function topLevelShellWords(text) {
  const words = [];
  let token = "";
  let quote;
  let backtick = false;
  let escaped = false;
  let substitutionDepth = 0;
  const flush = () => {
    if (token) words.push(token);
    token = "";
  };
  const operator = (index) => {
    const rest = text.slice(index);
    return [
      "<<<",
      "<<-",
      "<<",
      "<>",
      ">|",
      ">>",
      ">&",
      "<&",
      "&>>",
      "&>",
      ">",
      "<",
    ].find((candidate) => rest.startsWith(candidate));
  };
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (escaped) {
      token += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      token += character;
      escaped = true;
      continue;
    }
    if (quote) {
      token += character;
      if (character === quote) quote = undefined;
      continue;
    }
    if (backtick) {
      token += character;
      if (character === "`") backtick = false;
      continue;
    }
    if (character === "'" || character === '"') {
      token += character;
      quote = character;
      continue;
    }
    if (character === "`") {
      token += character;
      backtick = true;
      continue;
    }
    if (substitutionDepth > 0) {
      token += character;
      if (character === "(") substitutionDepth += 1;
      if (character === ")") substitutionDepth -= 1;
      continue;
    }
    if (character === "(" && ["$", "<", ">"].includes(text[index - 1])) {
      token += character;
      substitutionDepth = 1;
      continue;
    }
    if ((character === "<" || character === ">") && text[index + 1] === "(") {
      token += `${character}(`;
      substitutionDepth = 1;
      index += 1;
      continue;
    }
    if (/\s/u.test(character)) {
      flush();
      continue;
    }
    const redirection = operator(index);
    if (redirection) {
      flush();
      words.push(redirection);
      index += redirection.length - 1;
      continue;
    }
    token += character;
  }
  flush();
  return words;
}

function matchesShellValue(token, value) {
  if (token === value) return true;
  if (token.startsWith('"') && token.endsWith('"')) {
    return token.slice(1, -1) === value;
  }
  if (token.startsWith("'") && token.endsWith("'")) {
    // Single quotes preserve static values but suppress required shell
    // interpolation in variable-based bucket paths.
    return !/[$`]/u.test(value) && token.slice(1, -1) === value;
  }
  return false;
}

function recordFlagValues(record, flag) {
  if (record.args) {
    if (record.argsTrusted === false) return undefined;
    const values = [];
    let optionsTerminated = false;
    for (let index = 0; index < record.args.length; index += 1) {
      const argument = record.args[index];
      if (argument === "--") {
        optionsTerminated = true;
        continue;
      }
      if (optionsTerminated) continue;
      if (argument.startsWith(`--${flag}=`)) {
        values.push(argument.slice(flag.length + 3));
      } else if (argument === `--${flag}`) {
        values.push(record.args[index + 1]);
      }
    }
    return values;
  }
  if (record.flagTrusted === false) return undefined;

  const tokens = topLevelShellWords(record.raw ?? record.normalized ?? "");
  const gcloudIndex = tokens.findIndex(isGcloudExecutable);
  if (gcloudIndex === -1) return undefined;
  const values = [];
  let optionsTerminated = false;
  let redirectionConsumesNext = false;
  for (let index = gcloudIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--") {
      optionsTerminated = true;
      continue;
    }
    if (isShellRedirection(token)) {
      redirectionConsumesNext = true;
      continue;
    }
    if (redirectionConsumesNext) {
      redirectionConsumesNext = false;
      continue;
    }
    if (optionsTerminated) continue;
    if (token.startsWith(`--${flag}=`)) {
      values.push(token.slice(flag.length + 3));
    } else if (token === `--${flag}`) {
      values.push(tokens[index + 1]);
    }
  }
  return values;
}

function recordHasExactSingleFlag(record, flag, value) {
  const values = recordFlagValues(record, flag);
  return values?.length === 1 && matchesShellValue(values[0] ?? "", value);
}

function recordHasForbiddenFlag(record, flag) {
  const values = recordFlagValues(record, flag);
  return values === undefined || values.length > 0;
}

export function recordHasDeployStagingFlag(record, flag, value) {
  const values = recordFlagValues(record, flag);
  return (
    values?.some((candidate) => matchesShellValue(candidate ?? "", value)) ??
    false
  );
}

function validateCallsites(files, errors) {
  const records = discoverDeployStagingCallsites(files, errors);
  const expectedKeys = EXPECTED_CALLSITES.map(
    ({ filePath, surface, kind }) => `${filePath}:${surface}:${kind}`,
  ).sort();
  const actualKeys = records
    .map(({ filePath, surface, kind }) => `${filePath}:${surface}:${kind}`)
    .sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    errors.push(
      `deploy-staging executable callsite inventory must be exactly ${expectedKeys.join(", ")}; found ${actualKeys.join(", ") || "none"}`,
    );
  }

  for (const expected of EXPECTED_CALLSITES) {
    const matches = records.filter(
      (record) =>
        record.filePath === expected.filePath &&
        record.surface === expected.surface &&
        record.kind === expected.kind,
    );
    if (
      matches.length === 1 &&
      !recordHasDeployStagingFlag(matches[0], expected.flag, expected.value)
    ) {
      errors.push(
        `${expected.filePath}: ${expected.kind} must use --${expected.flag}=${expected.value}`,
      );
    }
  }

  for (const filePath of [
    ".github/workflows/metrics-bridge.yml",
    "scripts/deploy-bridge.sh",
  ]) {
    const record = records.find(
      (candidate) =>
        candidate.filePath === filePath && candidate.kind === "builds-submit",
    );
    if (!recordHasExactSingleFlag(record ?? {}, "config", "cloudbuild.yaml")) {
      errors.push(
        `${filePath}: Metrics Bridge builds must set --config=cloudbuild.yaml exactly`,
      );
    }
    if (recordHasForbiddenFlag(record ?? {}, "service-account")) {
      errors.push(
        `${filePath}: Metrics Bridge builds must not override cloudbuild.yaml with --service-account`,
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

  const metricsBridge = parseDeployStagingStructuredFile(
    METRICS_BRIDGE_BUILD_CONFIG,
    requireSource(files, METRICS_BRIDGE_BUILD_CONFIG, errors),
    errors,
  );
  if (metricsBridge?.serviceAccount !== METRICS_BRIDGE_BUILDER) {
    errors.push(
      `${METRICS_BRIDGE_BUILD_CONFIG}: Cloud Build serviceAccount must be ${METRICS_BRIDGE_BUILDER}`,
    );
  }
  if (metricsBridge?.options?.logging !== "CLOUD_LOGGING_ONLY") {
    errors.push(
      `${METRICS_BRIDGE_BUILD_CONFIG}: Cloud Build logging must be CLOUD_LOGGING_ONLY`,
    );
  }

  const directDeployPath = "scripts/deploy-bridge.sh";
  const directDeploy = requireSource(files, directDeployPath, errors);
  const targetLine = (target) =>
    new RegExp(
      `^\\s+-target=${target.replaceAll(".", "\\.")}\\s*(?:\\\\)?$`,
      "gmu",
    );
  const serviceProbeStart = directDeploy.indexOf(
    'if ! EXISTING_METRICS_BRIDGE_SERVICE="$(gcloud run services list',
  );
  const serviceProbeEnd = directDeploy.indexOf("\nfi", serviceProbeStart);
  const serviceCaseStart = directDeploy.indexOf(
    'case "$EXISTING_METRICS_BRIDGE_SERVICE" in',
    serviceProbeEnd,
  );
  const absentServiceStart = directDeploy.indexOf('  "")', serviceCaseStart);
  const absentServiceEnd = directDeploy.indexOf("    ;;", absentServiceStart);
  const serviceCaseEnd = directDeploy.indexOf("esac", absentServiceEnd);

  for (const target of METRICS_BRIDGE_DIRECT_BOOTSTRAP_TARGETS) {
    const matches = directDeploy.match(targetLine(target));
    if (matches?.length !== 1) {
      errors.push(
        `${directDeployPath}: direct bootstrap must target ${target} exactly once`,
      );
    } else if (directDeploy.indexOf(matches[0]) > serviceProbeStart) {
      errors.push(
        `${directDeployPath}: direct IAM target ${target} must run before the service lookup`,
      );
    }
  }

  const expectedProbeFragments = [
    '--project="$PROJECT"',
    '--region="$REGION"',
    "--filter='metadata.name=metrics-bridge'",
    "--format='value(metadata.name)'",
    "--limit=2",
  ];
  const probeBlock =
    serviceProbeStart >= 0 && serviceProbeEnd > serviceProbeStart
      ? directDeploy.slice(serviceProbeStart, serviceProbeEnd)
      : "";
  if (
    !probeBlock ||
    !probeBlock.includes("exit 1") ||
    expectedProbeFragments.some((fragment) => !probeBlock.includes(fragment))
  ) {
    errors.push(
      `${directDeployPath}: existing-service lookup must be exact and fail closed`,
    );
  }

  for (const target of METRICS_BRIDGE_SERVICE_BOOTSTRAP_TARGETS) {
    const matches = directDeploy.match(targetLine(target));
    const targetIndex =
      matches?.length === 1 ? directDeploy.indexOf(matches[0]) : -1;
    if (
      matches?.length !== 1 ||
      targetIndex <= absentServiceStart ||
      targetIndex >= absentServiceEnd
    ) {
      errors.push(
        `${directDeployPath}: ${target} must run exactly once only in the confirmed-absent service branch`,
      );
    }
  }

  const unexpectedResultStart = directDeploy.indexOf("  *)", absentServiceEnd);
  const unexpectedResultBlock =
    unexpectedResultStart >= 0 && serviceCaseEnd > unexpectedResultStart
      ? directDeploy.slice(unexpectedResultStart, serviceCaseEnd)
      : "";
  if (
    serviceCaseStart < 0 ||
    absentServiceStart < 0 ||
    absentServiceEnd < 0 ||
    serviceCaseEnd < 0 ||
    !unexpectedResultBlock.includes("exit 1")
  ) {
    errors.push(
      `${directDeployPath}: service bootstrap branching must reject unexpected lookup results`,
    );
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
