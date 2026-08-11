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
  "google_storage_bucket_iam_policy.peg_policy",
  "google_project_iam_member.dev_logging_viewer",
  "google_service_account_iam_member.dev_metrics_bridge_builder_service_account_user",
  "google_service_account_iam_member.dev_metrics_bridge_runtime_service_account_user",
];
const METRICS_BRIDGE_DIRECT_SOURCE_READER_TARGETS = [
  {
    variable: "GRAFANA_AGENT_SOURCE_READER_TARGET",
    assignment:
      'GRAFANA_AGENT_SOURCE_READER_TARGET="google_storage_bucket_iam_member.cloud_build_source_executor_object_viewer[\\"serviceAccount:grafana-agent-builder@${PROJECT}.iam.gserviceaccount.com\\"]"',
  },
  {
    variable: "METRICS_BRIDGE_SOURCE_READER_TARGET",
    assignment:
      'METRICS_BRIDGE_SOURCE_READER_TARGET="google_storage_bucket_iam_member.cloud_build_source_executor_object_viewer[\\"serviceAccount:metrics-bridge-builder@${PROJECT}.iam.gserviceaccount.com\\"]"',
  },
];
const CLOUD_BUILD_SOURCE_EXECUTOR_COLLECTION_TARGET =
  "google_storage_bucket_iam_member.cloud_build_source_executor_object_viewer";
const METRICS_BRIDGE_SERVICE_BOOTSTRAP_TARGET =
  "google_cloud_run_v2_service.metrics_bridge";
const METRICS_BRIDGE_PUBLIC_BINDING_TARGET =
  "google_cloud_run_v2_service_iam_member.metrics_bridge_public";
const CLOUD_BUILD_SOURCE_EXECUTORS = [
  "serviceAccount:${google_service_account.grafana_agent_builder.email}",
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
  validateAppEngineDefaultStagingAdmin(blocks, errors);
}

function validateAppEngineDefaultStagingAdmin(blocks, errors) {
  const label = `${TERRAFORM_FILE}: App Engine default staging admin`;
  const grant = requireBlock(
    blocks,
    TERRAFORM_FILE,
    "google_storage_bucket_iam_member",
    "app_engine_default_staging_admin",
    errors,
    label,
  );
  if (!grant) return;

  expectNoResourceMultiplicity(grant, errors, label);
  expectString(
    grant,
    "bucket",
    "staging.${google_project.monitoring.project_id}.appspot.com",
    errors,
    label,
  );
  expectString(grant, "role", "roles/storage.admin", errors, label);
  expectExpression(
    grant,
    "member",
    '"serviceAccount:${local.aegis_app_engine_default_service_account}"',
    errors,
    label,
  );
  expectExpression(
    grant,
    "depends_on",
    "[google_app_engine_application.aegis]",
    errors,
    label,
  );
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
    errors.push(`${label}: must contain only the two dedicated builders`);
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
  const normalizedDirectDeployLines = directDeploy
    .split("\n")
    .map((line) => line.trim().replace(/\s*\\$/u, ""));
  const targetLine = (target) =>
    new RegExp(
      `^\\s+-target=${target.replaceAll(".", "\\.")}\\s*(?:\\\\)?$`,
      "gmu",
    );
  const serviceProbeStart = directDeploy.indexOf(
    'if ! EXISTING_METRICS_BRIDGE_SERVICE="$(gcloud run services list',
  );
  const serviceProbeEnd = directDeploy.indexOf("\nfi", serviceProbeStart);
  const initialStateReadStart = directDeploy.indexOf(
    'if ! TERRAFORM_STATE_ADDRESSES="$(terraform -chdir=terraform state list)"',
    serviceProbeEnd,
  );
  const serviceCaseStart = directDeploy.indexOf(
    'case "$EXISTING_METRICS_BRIDGE_SERVICE" in',
    serviceProbeEnd,
  );
  const existingServiceStart = directDeploy.indexOf(
    "  metrics-bridge)",
    serviceCaseStart,
  );
  const existingServiceEnd = directDeploy.indexOf(
    "    ;;",
    existingServiceStart,
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
    } else if (
      serviceProbeStart >= 0 &&
      directDeploy.indexOf(matches[0]) > serviceProbeStart
    ) {
      errors.push(
        `${directDeployPath}: direct IAM target ${target} must run before the service lookup`,
      );
    }
  }

  for (const {
    variable,
    assignment,
  } of METRICS_BRIDGE_DIRECT_SOURCE_READER_TARGETS) {
    const assignmentCount = directDeploy.split(assignment).length - 1;
    const targetCount = normalizedDirectDeployLines.filter(
      (line) => line === `-target="$${variable}"`,
    ).length;
    if (assignmentCount !== 1 || targetCount !== 1) {
      errors.push(
        `${directDeployPath}: direct bootstrap must target the exact ${variable} instance once`,
      );
    }
  }

  const broadSourceReaderTargets = new Set([
    `-target=${CLOUD_BUILD_SOURCE_EXECUTOR_COLLECTION_TARGET}`,
    `-target="${CLOUD_BUILD_SOURCE_EXECUTOR_COLLECTION_TARGET}"`,
    `-target='${CLOUD_BUILD_SOURCE_EXECUTOR_COLLECTION_TARGET}'`,
  ]);
  if (
    normalizedDirectDeployLines.some((line) =>
      broadSourceReaderTargets.has(line),
    )
  ) {
    errors.push(
      `${directDeployPath}: direct bootstrap must not target the whole source-reader collection`,
    );
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

  const serviceTargetMatches = directDeploy.match(
    targetLine(METRICS_BRIDGE_SERVICE_BOOTSTRAP_TARGET),
  );
  const serviceTargetIndex =
    serviceTargetMatches?.length === 1
      ? directDeploy.indexOf(serviceTargetMatches[0])
      : -1;
  const absentServiceBlock =
    absentServiceStart >= 0 && absentServiceEnd > absentServiceStart
      ? directDeploy.slice(absentServiceStart, absentServiceEnd)
      : "";
  const expectedServiceBootstrapFragments = [
    'if grep -Fqx -- "$METRICS_BRIDGE_SERVICE_ADDRESS"',
    "Cloud Run service is tracked in Terraform state but missing live",
    'mktemp "${TMPDIR:-/tmp}/metrics-bridge-service-bootstrap.XXXXXX"',
    "terraform -chdir=terraform plan",
    "-refresh=false",
    '-out="$SERVICE_BOOTSTRAP_PLAN"',
    'terraform -chdir=terraform show -json "$SERVICE_BOOTSTRAP_PLAN"',
    "node scripts/check-metrics-bridge-bootstrap-plan.mjs service",
    'terraform -chdir=terraform apply "$SERVICE_BOOTSTRAP_PLAN"',
    'if ! CREATED_METRICS_BRIDGE_SERVICE="$(gcloud run services list',
    '[[ "$CREATED_METRICS_BRIDGE_SERVICE" != "metrics-bridge" ]]',
    "exit 1",
  ];
  if (
    serviceTargetMatches?.length !== 1 ||
    serviceTargetIndex <= absentServiceStart ||
    serviceTargetIndex >= absentServiceEnd ||
    !absentServiceBlock ||
    expectedServiceBootstrapFragments.some(
      (fragment) => !absentServiceBlock.includes(fragment),
    )
  ) {
    errors.push(
      `${directDeployPath}: ${METRICS_BRIDGE_SERVICE_BOOTSTRAP_TARGET} must run exactly once only through a guarded no-refresh plan in the confirmed-absent service branch`,
    );
  }

  const unexpectedResultStart = directDeploy.indexOf("  *)", absentServiceEnd);
  const existingServiceBlock =
    existingServiceStart >= 0 && existingServiceEnd > existingServiceStart
      ? directDeploy.slice(existingServiceStart, existingServiceEnd)
      : "";
  const unexpectedResultBlock =
    unexpectedResultStart >= 0 && serviceCaseEnd > unexpectedResultStart
      ? directDeploy.slice(unexpectedResultStart, serviceCaseEnd)
      : "";
  if (
    serviceCaseStart < 0 ||
    !existingServiceBlock.includes(
      'if ! grep -Fqx -- "$METRICS_BRIDGE_SERVICE_ADDRESS"',
    ) ||
    !existingServiceBlock.includes(
      "Cloud Run service exists but is not tracked in Terraform state",
    ) ||
    !existingServiceBlock.includes("exit 1") ||
    absentServiceStart < 0 ||
    absentServiceEnd < 0 ||
    serviceCaseEnd < 0 ||
    !unexpectedResultBlock.includes("exit 1")
  ) {
    errors.push(
      `${directDeployPath}: service bootstrap branching must reject unexpected lookup results`,
    );
  }

  const postServiceStateReadStart = directDeploy.indexOf(
    'if ! TERRAFORM_STATE_ADDRESSES="$(terraform -chdir=terraform state list)"',
    serviceCaseEnd,
  );
  const publicBindingStateStart = directDeploy.indexOf(
    'if grep -Fqx -- "$METRICS_BRIDGE_PUBLIC_BINDING_ADDRESS"',
    postServiceStateReadStart,
  );
  const publicBindingRecoveryStart = directDeploy.indexOf(
    "\nelse\n",
    publicBindingStateStart,
  );
  const stateClassificationBlock =
    initialStateReadStart >= 0 &&
    publicBindingRecoveryStart > initialStateReadStart
      ? directDeploy.slice(initialStateReadStart, publicBindingRecoveryStart)
      : "";
  const publicBindingRecoveryEnd = directDeploy.indexOf(
    "# State presence proves Terraform ownership",
    publicBindingRecoveryStart,
  );
  const publicBindingRecoveryBlock =
    publicBindingRecoveryStart >= 0 &&
    publicBindingRecoveryEnd > publicBindingRecoveryStart
      ? directDeploy.slice(publicBindingRecoveryStart, publicBindingRecoveryEnd)
      : "";
  const publicTargetMatches = directDeploy.match(
    targetLine(METRICS_BRIDGE_PUBLIC_BINDING_TARGET),
  );
  const publicTargetIndex =
    publicTargetMatches?.length === 1
      ? directDeploy.indexOf(publicTargetMatches[0])
      : -1;
  const expectedRecoveryFragments = [
    'mktemp "${TMPDIR:-/tmp}/metrics-bridge-public-bootstrap.XXXXXX"',
    "terraform -chdir=terraform plan",
    "-refresh=false",
    '-out="$PUBLIC_BINDING_PLAN"',
    'terraform -chdir=terraform show -json "$PUBLIC_BINDING_PLAN"',
    "node scripts/check-metrics-bridge-bootstrap-plan.mjs public-binding",
    'terraform -chdir=terraform apply "$PUBLIC_BINDING_PLAN"',
    'grep -Fqx -- "$METRICS_BRIDGE_PUBLIC_BINDING_ADDRESS"',
    "exit 1",
  ];
  const expectedStateFragments = [
    "terraform -chdir=terraform state list",
    'if ! grep -Fqx -- "$METRICS_BRIDGE_SERVICE_ADDRESS"',
    "Cloud Run service exists but is not tracked in Terraform state",
    'if grep -Fqx -- "$METRICS_BRIDGE_SERVICE_ADDRESS"',
    "Cloud Run service is tracked in Terraform state but missing live",
    "Cloud Run service is absent from Terraform state",
    'grep -Fqx -- "$METRICS_BRIDGE_PUBLIC_BINDING_ADDRESS"',
    "exit 1",
  ];
  if (
    initialStateReadStart <= serviceProbeEnd ||
    initialStateReadStart >= serviceCaseStart ||
    postServiceStateReadStart <= serviceCaseEnd ||
    publicBindingStateStart <= postServiceStateReadStart ||
    !stateClassificationBlock ||
    expectedStateFragments.some(
      (fragment) => !stateClassificationBlock.includes(fragment),
    ) ||
    !publicBindingRecoveryBlock ||
    publicTargetMatches?.length !== 1 ||
    publicTargetIndex <= publicBindingRecoveryStart ||
    publicTargetIndex >= publicBindingRecoveryEnd ||
    expectedRecoveryFragments.some(
      (fragment) => !publicBindingRecoveryBlock.includes(fragment),
    )
  ) {
    errors.push(
      `${directDeployPath}: partial bootstrap recovery must apply only a guarded no-refresh public-binding plan`,
    );
  }

  const liveBindingProbeStart = directDeploy.indexOf(
    'if ! LIVE_PUBLIC_INVOKER="$(gcloud run services get-iam-policy metrics-bridge',
    publicBindingRecoveryEnd,
  );
  const liveBindingCaseEnd = directDeploy.indexOf(
    "esac",
    liveBindingProbeStart,
  );
  const buildStart = directDeploy.indexOf(
    'echo "Building container image via Cloud Build..."',
  );
  const liveBindingBlock =
    liveBindingProbeStart >= 0 && liveBindingCaseEnd > liveBindingProbeStart
      ? directDeploy.slice(liveBindingProbeStart, liveBindingCaseEnd)
      : "";
  const expectedLiveBindingFragments = [
    '--project="$PROJECT"',
    '--region="$REGION"',
    "--flatten='bindings[].members'",
    "--filter='bindings.role=roles/run.invoker AND bindings.members=allUsers'",
    "--format='value(bindings.members)'",
    "--limit=2",
    'echo "Unable to verify the live public invoker binding; refusing to deploy."\n  exit 1\nfi',
    'case "$LIVE_PUBLIC_INVOKER" in',
    "allUsers)",
    '  "")\n    echo "Public invoker binding is tracked but missing live; run a reviewed platform plan/apply before deploying."\n    exit 1',
    '  *)\n    echo "Unexpected public invoker lookup result; refusing to deploy."\n    exit 1',
  ];
  if (
    !liveBindingBlock ||
    buildStart <= liveBindingCaseEnd ||
    expectedLiveBindingFragments.some(
      (fragment) => !liveBindingBlock.includes(fragment),
    )
  ) {
    errors.push(
      `${directDeployPath}: live public-binding verification must be exact and fail before image rollout`,
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
