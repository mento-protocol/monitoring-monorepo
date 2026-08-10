#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertDeployStagingContract,
  discoverDeployStagingCallsites,
  recordHasDeployStagingFlag,
  stripDeployStagingTemplateSuffix,
  validateDeployStagingContract,
} from "./deploy-staging-contract.mjs";
import {
  METRICS_BRIDGE_PUBLIC_BINDING_ADDRESS,
  METRICS_BRIDGE_SERVICE_ADDRESS,
  validateMetricsBridgeBootstrapPlan,
} from "./check-metrics-bridge-bootstrap-plan.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const SHELL_FILE_EXTENSIONS = [
  ".bash",
  ".bat",
  ".command",
  ".cmd",
  ".fish",
  ".ksh",
  ".mk",
  ".ps1",
  ".psm1",
  ".sh",
  ".zsh",
];

const SCRIPT_SOURCE_FILE_EXTENSIONS = [
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
];

function isDockerfile(filePath) {
  const basename = path.basename(stripDeployStagingTemplateSuffix(filePath));
  return basename === "Dockerfile" || basename.startsWith("Dockerfile.");
}

function isCandidate(filePath) {
  const sourcePath = stripDeployStagingTemplateSuffix(filePath);
  const lowercasePath = sourcePath.toLowerCase();
  const templated = sourcePath !== filePath;
  return (
    (!templated && lowercasePath.endsWith(".tf")) ||
    SHELL_FILE_EXTENSIONS.some((extension) =>
      lowercasePath.endsWith(extension),
    ) ||
    SCRIPT_SOURCE_FILE_EXTENSIONS.some((extension) =>
      lowercasePath.endsWith(extension),
    ) ||
    isDockerfile(filePath) ||
    (!templated && lowercasePath.endsWith(".yml")) ||
    (!templated && lowercasePath.endsWith(".yaml")) ||
    (!templated && lowercasePath.endsWith(".json")) ||
    (!templated && lowercasePath.endsWith("package.json")) ||
    (sourcePath === filePath && path.extname(sourcePath) === "")
  );
}

function isExecutable(metadata) {
  return (metadata.mode & 0o111) !== 0;
}

function hasShebang(filePath) {
  const descriptor = openSync(filePath, "r");
  try {
    const bytes = Buffer.alloc(2);
    return (
      readSync(descriptor, bytes, 0, bytes.length, 0) === bytes.length &&
      bytes.toString("utf8") === "#!"
    );
  } finally {
    closeSync(descriptor);
  }
}

function shouldScanFile(filePath, metadata, startsWithShebang) {
  return isCandidate(filePath) || isExecutable(metadata) || startsWithShebang;
}

function repositoryFiles() {
  const paths = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: repoRoot, encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean);
  const files = {};
  for (const filePath of paths) {
    const absolutePath = path.join(repoRoot, filePath);
    if (!existsSync(absolutePath)) continue;
    const linkMetadata = lstatSync(absolutePath);
    let metadata = linkMetadata;
    if (linkMetadata.isSymbolicLink()) {
      const target = realpathSync(absolutePath);
      const relativeTarget = path.relative(repoRoot, target);
      if (
        relativeTarget === ".." ||
        relativeTarget.startsWith(`..${path.sep}`)
      ) {
        throw new Error(
          `${filePath}: deploy-staging contract source symlink must stay inside the repository`,
        );
      }
      metadata = statSync(absolutePath);
    }
    if (!metadata.isFile()) continue;
    if (!shouldScanFile(filePath, metadata, hasShebang(absolutePath))) {
      continue;
    }
    const contents = readFileSync(absolutePath, "utf8");
    files[filePath] = contents;
  }
  return files;
}

function mutate(files, filePath, from, to) {
  assert(files[filePath]?.includes(from), `mutation source missing: ${from}`);
  return {
    ...files,
    [filePath]: files[filePath].replace(from, to),
  };
}

function expectFailure(files, expected) {
  const errors = validateDeployStagingContract(files);
  assert(
    errors.some((error) => error.includes(expected)),
    `expected deploy-staging failure containing "${expected}", got:\n${errors.join("\n")}`,
  );
}

const files = repositoryFiles();

const noOpServiceChange = {
  address: "google_cloud_run_v2_service.metrics_bridge",
  mode: "managed",
  change: { actions: ["no-op"] },
};
const publicBindingCreate = {
  address: METRICS_BRIDGE_PUBLIC_BINDING_ADDRESS,
  mode: "managed",
  change: { actions: ["create"] },
};
assert.deepEqual(
  validateMetricsBridgeBootstrapPlan(
    {
      resource_changes: [noOpServiceChange, publicBindingCreate],
    },
    "public-binding",
  ),
  [],
  "partial bootstrap plan should allow only the public binding create",
);
assert.deepEqual(
  validateMetricsBridgeBootstrapPlan(
    {
      resource_changes: [noOpServiceChange],
    },
    "public-binding",
  ),
  [],
  "a concurrent no-op recovery should remain safe",
);
const serviceCreate = {
  address: METRICS_BRIDGE_SERVICE_ADDRESS,
  mode: "managed",
  change: { actions: ["create"] },
};
assert.deepEqual(
  validateMetricsBridgeBootstrapPlan(
    { resource_changes: [serviceCreate] },
    "service",
  ),
  [],
  "first bootstrap plan should allow exactly the service create",
);
assert.deepEqual(
  validateMetricsBridgeBootstrapPlan(
    { resource_changes: [noOpServiceChange] },
    "service",
  ),
  ["service bootstrap plan must create its resource exactly once"],
  "a concurrent service state change should stop before apply",
);
for (const unsafeChange of [
  {
    address: "google_cloud_run_v2_service.metrics_bridge",
    mode: "managed",
    change: { actions: ["update"] },
  },
  {
    ...publicBindingCreate,
    change: { actions: ["delete", "create"] },
  },
  {
    address: "google_project_iam_member.unrelated",
    mode: "managed",
    change: { actions: ["create"] },
  },
]) {
  assert.equal(
    validateMetricsBridgeBootstrapPlan(
      {
        resource_changes: [unsafeChange],
      },
      "public-binding",
    ).length,
    1,
    `${unsafeChange.address} mutation should fail closed`,
  );
}
assert.deepEqual(
  validateMetricsBridgeBootstrapPlan(
    {
      resource_changes: [publicBindingCreate],
      resource_drift: [noOpServiceChange],
    },
    "public-binding",
  ),
  ["bootstrap plan must not contain refreshed resource drift"],
);

const rootGcloudIgnoreEntries = files[".gcloudignore"]
  .split(/\r?\n/u)
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("# "));
assert.equal(
  rootGcloudIgnoreEntries[0],
  "*",
  ".gcloudignore must default-deny the direct Cloud Build source archive",
);
assert.deepEqual(
  rootGcloudIgnoreEntries.filter(
    (line) => line.startsWith("!") && !line.startsWith("#!"),
  ),
  [
    "!.gcloudignore",
    "!cloudbuild.yaml",
    "!package.json",
    "!pnpm-lock.yaml",
    "!pnpm-workspace.yaml",
    "!patches/",
    "!patches/**",
    "!metrics-bridge/",
    "!metrics-bridge/**",
    "!shared-config/",
    "!shared-config/**",
  ],
  ".gcloudignore must allow only Metrics Bridge build inputs",
);
assert(
  rootGcloudIgnoreEntries.includes("#!include:.gitignore"),
  ".gcloudignore must reapply repository-local output exclusions",
);
for (const entry of [
  "*.env",
  "*.env.*",
  "terraform.tfvars",
  "gha-creds-*.json",
]) {
  assert(
    rootGcloudIgnoreEntries.includes(entry),
    `.gcloudignore must exclude direct-deploy credentials via ${entry}`,
  );
}

assert.equal(
  shouldScanFile("scripts/new-deploy.bash", { mode: 0o100755 }, false),
  true,
  "executable .bash files must be scanned for deploy callsites",
);
assert.equal(
  shouldScanFile("scripts/new-deploy.command", { mode: 0o100644 }, false),
  true,
  "shell extensions must be scanned without a shebang",
);
assert.equal(
  shouldScanFile("scripts/new-deploy.bat", { mode: 0o100644 }, false),
  true,
  "batch files must be scanned without a shebang or executable bit",
);
assert.equal(
  shouldScanFile("scripts/new-deploy.cmd", { mode: 0o100644 }, false),
  true,
  "command files must be scanned without a shebang or executable bit",
);
assert.equal(
  shouldScanFile("scripts/new-deploy.CMD", { mode: 0o100644 }, false),
  true,
  "Windows script extensions must be matched case-insensitively",
);
assert.equal(
  shouldScanFile("scripts/deploy.mk", { mode: 0o100644 }, false),
  true,
  "Makefile fragments must be scanned without a shebang or executable bit",
);
assert.equal(
  shouldScanFile("scripts/new-deploy.ps1", { mode: 0o100644 }, false),
  true,
  "PowerShell scripts must be scanned without an executable bit",
);
assert.equal(
  shouldScanFile("scripts/new-deploy.psm1", { mode: 0o100644 }, false),
  true,
  "PowerShell modules must be scanned without an executable bit",
);
assert.equal(
  shouldScanFile("scripts/new-deploy.custom", { mode: 0o100644 }, true),
  true,
  "non-executable arbitrary-extension shebang files must be scanned",
);
assert.equal(
  isCandidate("cloudbuild.json"),
  true,
  "JSON Cloud Build configurations must be scanned for deploy callsites",
);
assert.equal(
  isCandidate("scripts/new-deploy.mjs"),
  true,
  "Node source files must be scanned for deploy callsites",
);
assert.equal(
  isCandidate("packages/deployer/src/deploy.ts"),
  true,
  "TypeScript source files must be scanned for deploy callsites",
);
assert.equal(
  isCandidate("images/bridge/Dockerfile.release"),
  true,
  "named Dockerfiles must be scanned for deploy callsites",
);
assert.equal(
  shouldScanFile("templates/deploy.sh.tftpl", { mode: 0o100644 }, false),
  true,
  "shell templates must be scanned without an executable bit",
);
assert.equal(
  shouldScanFile("templates/deploy.cmd.tftpl", { mode: 0o100644 }, false),
  true,
  "Windows command templates must be scanned without an executable bit",
);
assert.equal(
  shouldScanFile("templates/deploy.mk.tftpl", { mode: 0o100644 }, false),
  true,
  "Makefile fragment templates must be scanned without an executable bit",
);
assert.equal(
  shouldScanFile("templates/deploy.mjs.tftpl", { mode: 0o100644 }, false),
  true,
  "Node source templates must be scanned without an executable bit",
);
assert.equal(
  shouldScanFile("templates/filter-function.js.tpl", { mode: 0o100644 }, false),
  true,
  "Node source .tpl templates must be scanned without an executable bit",
);
assert.equal(
  shouldScanFile(
    "templates/Dockerfile.release.tftpl",
    { mode: 0o100644 },
    false,
  ),
  true,
  "Dockerfile templates must be scanned without an executable bit",
);
assert.equal(
  isCandidate("templates/deploy.tftpl"),
  false,
  "untyped templates must not be scanned as executable surfaces",
);
assert.equal(
  isCandidate("templates/deploy.sh.tftpl.bak"),
  false,
  "near-miss template names must not be scanned as executable surfaces",
);
assert.equal(
  isCandidate("templates/deploy.tf.tftpl"),
  false,
  "templated Terraform files must not be scanned as executable surfaces",
);
assert.equal(
  isCandidate("templates/deploy.md.tftpl"),
  false,
  "Markdown templates must not be scanned as executable surfaces",
);
assert.equal(
  isCandidate("templates/deploy.yml.tftpl"),
  false,
  "templated YAML files must not be scanned without structured semantics",
);
assert.equal(
  isCandidate("templates/deploy.sh.tmpl"),
  false,
  "unsupported template suffixes must not be scanned as executable surfaces",
);

expectFailure(
  mutate(
    files,
    "terraform/deploy-staging.tf",
    "location                    = var.gcp_region",
    'location                    = "US"',
  ),
  "cloud_build_source_staging: location must be exactly var.gcp_region",
);
expectFailure(
  mutate(
    files,
    "terraform/deploy-staging.tf",
    "retention_duration_seconds = 0",
    "retention_duration_seconds = 604800",
  ),
  "retention_duration_seconds must be exactly 0",
);
expectFailure(
  mutate(
    files,
    ".github/workflows/metrics-bridge.yml",
    '            --gcs-source-staging-dir="gs://${GCP_PROJECT}-cloud-build-source/metrics-bridge" \\\n',
    "",
  ),
  "metrics-bridge.yml: builds-submit must use --gcs-source-staging-dir",
);
for (const [filePath, doubleQuoted, singleQuoted, expectedError] of [
  [
    ".github/workflows/metrics-bridge.yml",
    '--gcs-source-staging-dir="gs://${GCP_PROJECT}-cloud-build-source/metrics-bridge"',
    "--gcs-source-staging-dir='gs://${GCP_PROJECT}-cloud-build-source/metrics-bridge'",
    "metrics-bridge.yml: builds-submit must use --gcs-source-staging-dir",
  ],
  [
    "scripts/deploy-bridge.sh",
    '--gcs-source-staging-dir="gs://${PROJECT}-cloud-build-source/metrics-bridge"',
    "--gcs-source-staging-dir='gs://${PROJECT}-cloud-build-source/metrics-bridge'",
    "scripts/deploy-bridge.sh: builds-submit must use --gcs-source-staging-dir",
  ],
  [
    "aegis/grafana-agent/deploy.sh",
    '--gcs-source-staging-dir="gs://${project}-cloud-build-source/alloy"',
    "--gcs-source-staging-dir='gs://${project}-cloud-build-source/alloy'",
    "aegis/grafana-agent/deploy.sh: builds-submit must use --gcs-source-staging-dir",
  ],
]) {
  expectFailure(
    mutate(files, filePath, doubleQuoted, singleQuoted),
    expectedError,
  );
}
assertDeployStagingContract(
  mutate(
    files,
    "aegis/bin/deploy.sh",
    "--bucket=gs://mento-monitoring-app-engine-source",
    "--bucket='gs://mento-monitoring-app-engine-source'",
  ),
);
assertDeployStagingContract(
  mutate(
    files,
    "scripts/deploy-bridge.sh",
    "gcloud builds submit",
    "gcloud.cmd builds submit",
  ),
);
for (const replacement of [
  '            > --gcs-source-staging-dir="gs://${GCP_PROJECT}-cloud-build-source/metrics-bridge" \\\n',
  '            2> --gcs-source-staging-dir "gs://${GCP_PROJECT}-cloud-build-source/metrics-bridge" \\\n',
  '            <<< --gcs-source-staging-dir "gs://${GCP_PROJECT}-cloud-build-source/metrics-bridge" \\\n',
  '            < --gcs-source-staging-dir "gs://${GCP_PROJECT}-cloud-build-source/metrics-bridge" \\\n',
  '            << --gcs-source-staging-dir "gs://${GCP_PROJECT}-cloud-build-source/metrics-bridge" \\\n',
  '            >| --gcs-source-staging-dir "gs://${GCP_PROJECT}-cloud-build-source/metrics-bridge" \\\n',
  '            &> --gcs-source-staging-dir "gs://${GCP_PROJECT}-cloud-build-source/metrics-bridge" \\\n',
  '            -- --gcs-source-staging-dir="gs://${GCP_PROJECT}-cloud-build-source/metrics-bridge" \\\n',
  '            "x --gcs-source-staging-dir=gs://${GCP_PROJECT}-cloud-build-source/metrics-bridge" \\\n',
  "            $(echo --gcs-source-staging-dir=gs://${GCP_PROJECT}-cloud-build-source/metrics-bridge) \\\n",
]) {
  expectFailure(
    mutate(
      files,
      ".github/workflows/metrics-bridge.yml",
      '            --gcs-source-staging-dir="gs://${GCP_PROJECT}-cloud-build-source/metrics-bridge" \\\n',
      replacement,
    ),
    "metrics-bridge.yml: builds-submit must use --gcs-source-staging-dir",
  );
}
assertDeployStagingContract(
  mutate(
    files,
    ".github/workflows/metrics-bridge.yml",
    '            --gcs-source-staging-dir="gs://${GCP_PROJECT}-cloud-build-source/metrics-bridge" \\\n',
    '            > /tmp/deploy.log \\\n            --gcs-source-staging-dir="gs://${GCP_PROJECT}-cloud-build-source/metrics-bridge" \\\n',
  ),
);
expectFailure(
  mutate(
    mutate(
      mutate(
        files,
        ".github/workflows/metrics-bridge.yml",
        "          gcloud builds submit \\\n",
        "          echo --gcs-source-staging-dir=gs://${GCP_PROJECT}-cloud-build-source/metrics-bridge $(gcloud builds submit \\\n",
      ),
      ".github/workflows/metrics-bridge.yml",
      '            --gcs-source-staging-dir="gs://${GCP_PROJECT}-cloud-build-source/metrics-bridge" \\\n',
      "",
    ),
    ".github/workflows/metrics-bridge.yml",
    "            .\n",
    "            .)\n",
  ),
  "metrics-bridge.yml: builds-submit must use --gcs-source-staging-dir",
);
expectFailure(
  mutate(
    mutate(
      files,
      ".github/workflows/metrics-bridge.yml",
      '            --gcs-source-staging-dir="gs://${GCP_PROJECT}-cloud-build-source/metrics-bridge" \\\n',
      "",
    ),
    ".github/workflows/metrics-bridge.yml",
    "            .\n",
    '            . && echo --gcs-source-staging-dir="gs://${GCP_PROJECT}-cloud-build-source/metrics-bridge"\n',
  ),
  "metrics-bridge.yml: builds-submit must use --gcs-source-staging-dir",
);
expectFailure(
  mutate(
    files,
    "aegis/bin/deploy.sh",
    "  --bucket=gs://mento-monitoring-app-engine-source \\\n",
    "",
  ),
  "aegis/bin/deploy.sh: app-deploy must use --bucket",
);
expectFailure(
  mutate(
    files,
    "aegis/grafana-agent/cloudbuild.yaml",
    "        --bucket=gs://mento-monitoring-app-engine-source,\n",
    "        --bucket=gs://wrong-bucket,\n        gs://mento-monitoring-app-engine-source,\n",
  ),
  "aegis/grafana-agent/cloudbuild.yaml: app-deploy must use --bucket",
);
expectFailure(
  mutate(
    files,
    "aegis/grafana-agent/cloudbuild.yaml",
    "        --bucket=gs://mento-monitoring-app-engine-source,\n",
    '        "x --bucket=gs://mento-monitoring-app-engine-source",\n',
  ),
  "aegis/grafana-agent/cloudbuild.yaml: app-deploy must use --bucket",
);
expectFailure(
  mutate(
    files,
    "aegis/grafana-agent/deploy.sh",
    '    --gcs-source-staging-dir="gs://${project}-cloud-build-source/alloy" \\\n',
    "",
  ),
  "aegis/grafana-agent/deploy.sh: builds-submit must use --gcs-source-staging-dir",
);
expectFailure(
  mutate(
    files,
    "aegis/grafana-agent/cloudbuild.yaml",
    "  logging: CLOUD_LOGGING_ONLY",
    "  logging: GCS_ONLY",
  ),
  "Cloud Build logging must be CLOUD_LOGGING_ONLY",
);

expectFailure(
  mutate(
    files,
    "cloudbuild.yaml",
    "serviceAccount: projects/$PROJECT_ID/serviceAccounts/metrics-bridge-builder@$PROJECT_ID.iam.gserviceaccount.com\n",
    "",
  ),
  "cloudbuild.yaml: Cloud Build serviceAccount must be",
);
expectFailure(
  mutate(
    files,
    "cloudbuild.yaml",
    "serviceAccount: projects/$PROJECT_ID/serviceAccounts/metrics-bridge-builder@$PROJECT_ID.iam.gserviceaccount.com",
    "serviceAccount: projects/mento-monitoring/serviceAccounts/metrics-bridge-builder@mento-monitoring.iam.gserviceaccount.com",
  ),
  "cloudbuild.yaml: Cloud Build serviceAccount must be",
);
expectFailure(
  mutate(
    files,
    "cloudbuild.yaml",
    "  logging: CLOUD_LOGGING_ONLY",
    "  logging: GCS_ONLY",
  ),
  "cloudbuild.yaml: Cloud Build logging must be CLOUD_LOGGING_ONLY",
);

for (const [filePath, configFlag] of [
  [
    ".github/workflows/metrics-bridge.yml",
    "            --config=cloudbuild.yaml \\\n",
  ],
  ["scripts/deploy-bridge.sh", "  --config=cloudbuild.yaml \\\n"],
]) {
  expectFailure(
    mutate(
      files,
      filePath,
      configFlag,
      configFlag.replace("cloudbuild.yaml", "other.yaml"),
    ),
    `${filePath}: Metrics Bridge builds must set --config=cloudbuild.yaml exactly`,
  );
  expectFailure(
    mutate(
      files,
      filePath,
      configFlag,
      `${configFlag.slice(0, -2)}  --service-account=default@mento-monitoring.iam.gserviceaccount.com \\\n`,
    ),
    `${filePath}: Metrics Bridge builds must not override cloudbuild.yaml with --service-account`,
  );
}

for (const target of [
  "google_project_iam_member.metrics_bridge_builder",
  "google_artifact_registry_repository_iam_member.metrics_bridge_builder_writer",
  "google_storage_bucket_iam_policy.peg_policy",
  "google_project_iam_member.dev_logging_viewer",
  "google_service_account_iam_member.dev_metrics_bridge_builder_service_account_user",
  "google_service_account_iam_member.dev_metrics_bridge_runtime_service_account_user",
]) {
  const targetLine = files["scripts/deploy-bridge.sh"]
    .split("\n")
    .find((line) => line.includes(`-target=${target}`));
  assert(targetLine, `direct bootstrap target fixture missing: ${target}`);
  expectFailure(
    mutate(files, "scripts/deploy-bridge.sh", `${targetLine}\n`, ""),
    `scripts/deploy-bridge.sh: direct bootstrap must target ${target} exactly once`,
  );
}

const directSourceReaderTargets = [
  {
    variable: "GRAFANA_AGENT_SOURCE_READER_TARGET",
    account: "grafana-agent-builder",
  },
  {
    variable: "METRICS_BRIDGE_SOURCE_READER_TARGET",
    account: "metrics-bridge-builder",
  },
];
const directSourceReaderAssignments = [];
const directSourceReaderArguments = [];
for (const { variable, account } of directSourceReaderTargets) {
  const assignment = `${variable}="google_storage_bucket_iam_member.cloud_build_source_executor_object_viewer[\\"serviceAccount:${account}@\${PROJECT}.iam.gserviceaccount.com\\"]"`;
  const targetLine = `  -target="$${variable}" \\\n`;
  directSourceReaderAssignments.push(assignment);
  directSourceReaderArguments.push(targetLine.trim().replace(/\s*\\$/u, ""));
  assert(
    files["scripts/deploy-bridge.sh"].includes(assignment),
    `direct source-reader target fixture missing: ${variable}`,
  );
  assert(
    files["scripts/deploy-bridge.sh"].includes(targetLine),
    `direct source-reader target line missing: ${variable}`,
  );
  expectFailure(
    mutate(files, "scripts/deploy-bridge.sh", `${targetLine}`, ""),
    `scripts/deploy-bridge.sh: direct bootstrap must target the exact ${variable} instance once`,
  );
  expectFailure(
    mutate(
      files,
      "scripts/deploy-bridge.sh",
      assignment,
      assignment.replace(account, "default-compute"),
    ),
    `scripts/deploy-bridge.sh: direct bootstrap must target the exact ${variable} instance once`,
  );
}

const directSourceReaderArgv = execFileSync(
  "bash",
  [
    "-c",
    [
      "set -eu",
      "PROJECT=mento-monitoring",
      ...directSourceReaderAssignments,
      `set -- ${directSourceReaderArguments.join(" ")}`,
      `printf '%s\\n' "$@"`,
    ].join("\n"),
  ],
  { encoding: "utf8" },
)
  .trim()
  .split("\n");
assert.deepEqual(
  directSourceReaderArgv,
  directSourceReaderTargets.map(
    ({ account }) =>
      `-target=google_storage_bucket_iam_member.cloud_build_source_executor_object_viewer["serviceAccount:${account}@mento-monitoring.iam.gserviceaccount.com"]`,
  ),
  "direct source-reader targets must reach Terraform as quoted for_each instance addresses",
);

const broadSourceReaderTarget =
  "  -target=google_storage_bucket_iam_member.cloud_build_source_executor_object_viewer \\\n";
expectFailure(
  mutate(
    files,
    "scripts/deploy-bridge.sh",
    '  -target="$GRAFANA_AGENT_SOURCE_READER_TARGET" \\\n',
    `${broadSourceReaderTarget}  -target="$GRAFANA_AGENT_SOURCE_READER_TARGET" \\\n`,
  ),
  "scripts/deploy-bridge.sh: direct bootstrap must not target the whole source-reader collection",
);

expectFailure(
  mutate(
    files,
    "scripts/deploy-bridge.sh",
    "      -target=google_cloud_run_v2_service.metrics_bridge\n",
    "",
  ),
  "scripts/deploy-bridge.sh: google_cloud_run_v2_service.metrics_bridge must run exactly once only through a guarded no-refresh plan in the confirmed-absent service branch",
);
expectFailure(
  mutate(
    files,
    "scripts/deploy-bridge.sh",
    "    -target=google_cloud_run_v2_service_iam_member.metrics_bridge_public\n",
    "",
  ),
  "scripts/deploy-bridge.sh: partial bootstrap recovery must apply only a guarded no-refresh public-binding plan",
);

expectFailure(
  mutate(
    files,
    "scripts/deploy-bridge.sh",
    'if ! EXISTING_METRICS_BRIDGE_SERVICE="$(gcloud run services list',
    'if EXISTING_METRICS_BRIDGE_SERVICE="$(gcloud run services list',
  ),
  "scripts/deploy-bridge.sh: existing-service lookup must be exact and fail closed",
);
expectFailure(
  mutate(
    files,
    "scripts/deploy-bridge.sh",
    "  --filter='metadata.name=metrics-bridge' \\\n",
    "  --filter='metadata.name:metrics-bridge' \\\n",
  ),
  "scripts/deploy-bridge.sh: existing-service lookup must be exact and fail closed",
);
expectFailure(
  mutate(
    files,
    "scripts/deploy-bridge.sh",
    '  echo "Unable to verify Metrics Bridge Cloud Run service state; refusing to deploy."\n  exit 1\nfi',
    '  echo "Unable to verify Metrics Bridge Cloud Run service state; refusing to deploy."\nfi',
  ),
  "scripts/deploy-bridge.sh: existing-service lookup must be exact and fail closed",
);
expectFailure(
  mutate(
    files,
    "scripts/deploy-bridge.sh",
    '    echo "Unexpected Cloud Run service lookup result; refusing to deploy."\n    exit 1\n    ;;',
    '    echo "Unexpected Cloud Run service lookup result; refusing to deploy."\n    ;;',
  ),
  "scripts/deploy-bridge.sh: service bootstrap branching must reject unexpected lookup results",
);
expectFailure(
  mutate(
    mutate(
      files,
      "scripts/deploy-bridge.sh",
      "      -target=google_cloud_run_v2_service.metrics_bridge\n",
      "",
    ),
    "scripts/deploy-bridge.sh",
    "  -target=google_service_account_iam_member.dev_metrics_bridge_runtime_service_account_user\n",
    "  -target=google_service_account_iam_member.dev_metrics_bridge_runtime_service_account_user \\\n  -target=google_cloud_run_v2_service.metrics_bridge\n",
  ),
  "scripts/deploy-bridge.sh: google_cloud_run_v2_service.metrics_bridge must run exactly once only through a guarded no-refresh plan in the confirmed-absent service branch",
);
expectFailure(
  mutate(files, "scripts/deploy-bridge.sh", "      -refresh=false \\\n", ""),
  "scripts/deploy-bridge.sh: google_cloud_run_v2_service.metrics_bridge must run exactly once only through a guarded no-refresh plan in the confirmed-absent service branch",
);
expectFailure(
  mutate(
    files,
    "scripts/deploy-bridge.sh",
    "node scripts/check-metrics-bridge-bootstrap-plan.mjs service",
    "node scripts/other-plan-checker.mjs service",
  ),
  "scripts/deploy-bridge.sh: google_cloud_run_v2_service.metrics_bridge must run exactly once only through a guarded no-refresh plan in the confirmed-absent service branch",
);
expectFailure(
  mutate(
    files,
    "scripts/deploy-bridge.sh",
    'if ! CREATED_METRICS_BRIDGE_SERVICE="$(gcloud run services list',
    'if CREATED_METRICS_BRIDGE_SERVICE="$(gcloud run services list',
  ),
  "scripts/deploy-bridge.sh: google_cloud_run_v2_service.metrics_bridge must run exactly once only through a guarded no-refresh plan in the confirmed-absent service branch",
);
expectFailure(
  mutate(
    files,
    "scripts/deploy-bridge.sh",
    "    -refresh=false \\\n" + '    -out="$PUBLIC_BINDING_PLAN" \\\n',
    '    -out="$PUBLIC_BINDING_PLAN" \\\n',
  ),
  "scripts/deploy-bridge.sh: partial bootstrap recovery must apply only a guarded no-refresh public-binding plan",
);
expectFailure(
  mutate(
    files,
    "scripts/deploy-bridge.sh",
    "node scripts/check-metrics-bridge-bootstrap-plan.mjs public-binding",
    "node scripts/other-plan-checker.mjs public-binding",
  ),
  "scripts/deploy-bridge.sh: partial bootstrap recovery must apply only a guarded no-refresh public-binding plan",
);
expectFailure(
  mutate(
    files,
    "scripts/deploy-bridge.sh",
    'if ! grep -Fqx -- "$METRICS_BRIDGE_SERVICE_ADDRESS" <<<"$TERRAFORM_STATE_ADDRESSES"; then',
    'if grep -Fqx -- "$METRICS_BRIDGE_SERVICE_ADDRESS" <<<"$TERRAFORM_STATE_ADDRESSES"; then',
  ),
  "scripts/deploy-bridge.sh: service bootstrap branching must reject unexpected lookup results",
);
expectFailure(
  mutate(
    files,
    "scripts/deploy-bridge.sh",
    "  --filter='bindings.role=roles/run.invoker AND bindings.members=allUsers' \\\n",
    "  --filter='bindings.role=roles/run.invoker' \\\n",
  ),
  "scripts/deploy-bridge.sh: live public-binding verification must be exact and fail before image rollout",
);
expectFailure(
  mutate(
    files,
    "scripts/deploy-bridge.sh",
    '    echo "Public invoker binding is tracked but missing live; run a reviewed platform plan/apply before deploying."\n    exit 1',
    '    echo "Public invoker binding is tracked but missing live; run a reviewed platform plan/apply before deploying."',
  ),
  "scripts/deploy-bridge.sh: live public-binding verification must be exact and fail before image rollout",
);

const metricsBridgeBuilderExecutor =
  '    "serviceAccount:${google_service_account.metrics_bridge_builder.email}",\n';
const defaultComputeExecutor =
  '    "serviceAccount:${google_project.monitoring.number}-compute@developer.gserviceaccount.com",\n';
assert(
  files["terraform/deploy-staging.tf"].includes(metricsBridgeBuilderExecutor),
  "Metrics Bridge builder must be in the source-executor set",
);
assert(
  !files["terraform/deploy-staging.tf"].includes(defaultComputeExecutor),
  "Default Compute must not be in the source-executor set",
);
expectFailure(
  mutate(
    files,
    "terraform/deploy-staging.tf",
    metricsBridgeBuilderExecutor,
    `${defaultComputeExecutor}${metricsBridgeBuilderExecutor}`,
  ),
  "Cloud Build source executors: must contain only the two dedicated builders",
);
expectFailure(
  mutate(
    files,
    "terraform/deploy-staging.tf",
    metricsBridgeBuilderExecutor,
    "",
  ),
  "Cloud Build source executors: must contain only the two dedicated builders",
);
expectFailure(
  mutate(
    files,
    "terraform/deploy-staging.tf",
    metricsBridgeBuilderExecutor,
    `${metricsBridgeBuilderExecutor}    "serviceAccount:\${google_project.monitoring.number}@cloudbuild.gserviceaccount.com",\n`,
  ),
  "Cloud Build source executors: must contain only the two dedicated builders",
);
expectFailure(
  mutate(
    files,
    "terraform/deploy-staging.tf",
    '  role   = "roles/storage.objectViewer"',
    '  role   = "roles/storage.objectAdmin"',
  ),
  "Cloud Build source executors: role must be exactly",
);

expectFailure(
  {
    ...files,
    "scripts/new-deploy.sh":
      "#!/usr/bin/env bash\ngcloud builds submit --gcs-source-staging-dir=gs://mento-monitoring-cloud-build-source/new .\n",
  },
  "executable callsite inventory must be exactly",
);
expectFailure(
  {
    ...files,
    "new-cloudbuild.yaml": `steps:
  - name: gcr.io/cloud-builders/gcloud
    args:
      - --project
      - mento-monitoring
      - beta
      - builds
      - submit
      - .
`,
  },
  "executable callsite inventory must be exactly",
);
expectFailure(
  {
    ...files,
    "new-cloudbuild.yaml": `steps:
  - name: gcr.io/cloud-builders/gcloud
    args:
      - app
      - deploy
      - --bucket=gs://mento-monitoring-app-engine-source
      - app.yaml
`,
  },
  "executable callsite inventory must be exactly",
);

const nestedYamlBuildCallsites = discoverDeployStagingCallsites({
  "cloudbuild.yaml": `steps:
  - name: gcr.io/cloud-builders/gcloud
    args:
      - --project
      - mento-monitoring
      - beta
      - builds
      - submit
      - .
`,
});
assert.deepEqual(
  nestedYamlBuildCallsites.map(({ kind }) => kind),
  ["builds-submit"],
  "nested Cloud Build YAML build submissions must be discovered",
);

const nestedJsonCallsites = discoverDeployStagingCallsites({
  "cloudbuild.json": JSON.stringify({
    steps: [
      {
        name: "gcr.io/cloud-builders/gcloud",
        args: [
          "--project",
          "mento-monitoring",
          "beta",
          "app",
          "deploy",
          "--bucket=gs://mento-monitoring-app-engine-source",
          "app.yaml",
        ],
      },
    ],
  }),
});
assert.deepEqual(
  nestedJsonCallsites.map(({ kind }) => kind),
  ["app-deploy"],
  "nested Cloud Build JSON app deploys must be discovered",
);

const nestedJsonBuildCallsites = discoverDeployStagingCallsites({
  "cloudbuild.json": JSON.stringify({
    steps: [
      {
        name: "gcr.io/cloud-builders/gcloud",
        args: [
          "--project",
          "mento-monitoring",
          "alpha",
          "builds",
          "submit",
          ".",
        ],
      },
    ],
  }),
});
assert.deepEqual(
  nestedJsonBuildCallsites.map(({ kind }) => kind),
  ["builds-submit"],
  "nested Cloud Build JSON build submissions must be discovered",
);

for (const [shell, continuation, message] of [
  ["pwsh", "`", "pwsh workflow continuations"],
  ["PowerShell", "`", "PowerShell workflow continuations"],
  ["pwsh -NoProfile -File {0}", "`", "custom pwsh workflow continuations"],
  ["/usr/bin/env pwsh -File {0}", "`", "wrapped pwsh workflow continuations"],
  ["cmd", "^", "cmd workflow continuations"],
  ['cmd.exe /D /C "CALL {0}"', "^", "custom cmd workflow continuations"],
  ["env cmd /D /C {0}", "^", "wrapped cmd workflow continuations"],
]) {
  assert.deepEqual(
    discoverDeployStagingCallsites({
      ".github/workflows/deploy.yml": `jobs:
  deploy:
    steps:
      - shell: ${shell}
        run: |
          gcloud builds ${continuation}
            submit .
`,
    }).map(({ kind }) => kind),
    ["builds-submit"],
    `${message} must join their native continuation character`,
  );
}

assert.deepEqual(
  discoverDeployStagingCallsites({
    ".github/workflows/deploy.yml": `jobs:
  deploy:
    steps:
      - run: |
          gcloud builds \`
            submit .
`,
  }).map(({ kind }) => kind),
  ["builds-submit"],
  "workflow run blocks must scan every supported continuation form when shell selection is implicit",
);

assert.deepEqual(
  discoverDeployStagingCallsites({
    ".github/workflows/deploy.yml": `jobs:
  deploy:
    steps:
      - run: gcloud builds submit .
`,
  }).map(({ kind }) => kind),
  ["builds-submit"],
  "multi-shell workflow scanning must not duplicate a single-line deploy",
);

for (const [filePath, shell, continuation, message] of [
  [
    ".github/actions/deploy/action.yml",
    "pwsh",
    "`",
    "nested pwsh composite-action continuations",
  ],
  [
    ".github/actions/deploy/action.yaml",
    "cmd",
    "^",
    "nested cmd composite-action continuations",
  ],
  ["action.yml", "pwsh", "`", "root pwsh composite-action continuations"],
  ["action.yaml", "cmd", "^", "root cmd composite-action continuations"],
]) {
  assert.deepEqual(
    discoverDeployStagingCallsites({
      [filePath]: `runs:
  using: composite
  steps:
    - shell: ${shell}
      run: |
        gcloud builds ${continuation}
          submit .
`,
    }).map(({ kind }) => kind),
    ["builds-submit"],
    `${message} must join their native continuation character`,
  );
}

assert.deepEqual(
  discoverDeployStagingCallsites({
    ".github/actions/deploy/action.yaml": `runs:
  using: composite
  steps:
    - run: gcloud builds submit .
`,
  }).map(({ kind }) => kind),
  ["builds-submit"],
  "multi-shell composite-action scanning must not duplicate a single-line deploy",
);

assert.deepEqual(
  discoverDeployStagingCallsites({
    ".github/workflows/escaped-deploy.yml": `jobs:
  deploy:
    steps:
      - run: g\\cloud builds submit .
`,
  }).map(({ kind }) => kind),
  ["builds-submit"],
  "multi-shell workflow scanning must retain Unix backslash-escaped executable detection",
);

assert.deepEqual(
  discoverDeployStagingCallsites({
    "action.yml": `runs:
  using: composite
  steps:
    - shell: cmd
      run: |
        GCLOUD.CMD app ^
          deploy app.yaml
`,
  }).map(({ kind }) => kind),
  ["app-deploy"],
  "multi-shell composite scanning must retain case-insensitive Windows launcher detection",
);

assert.deepEqual(
  discoverDeployStagingCallsites({
    ".github/workflows/mixed-shell-deploy.yml": `jobs:
  deploy:
    steps:
      - run: |
          gcloud builds \`
            submit .
          gcloud app ^
            deploy app.yaml
`,
  })
    .map(({ kind }) => kind)
    .sort(),
  ["app-deploy", "builds-submit"],
  "multi-shell scanning must retain distinct deploys found by different continuation modes",
);

function assertForbiddenSignature(
  contents,
  message,
  filePath = "scripts/deploy",
) {
  const records = discoverDeployStagingCallsites({ [filePath]: contents });
  assert(records.length > 0, `${message}: literal deploy signature was missed`);
  expectFailure(
    { ...files, [filePath]: contents },
    "executable callsite inventory must be exactly",
  );
}

function assertSingleStructuredSignature(
  contents,
  message,
  filePath,
  kind,
  surface,
) {
  const records = discoverDeployStagingCallsites({ [filePath]: contents });
  assert.deepEqual(
    records.map((record) => ({
      kind: record.kind,
      surface: record.surface,
    })),
    [{ kind, surface }],
    `${message}: structured invocation must produce one owned record`,
  );
  expectFailure(
    { ...files, [filePath]: contents },
    "executable callsite inventory must be exactly",
  );
}

function assertProgrammaticConstCallsite(contents, message) {
  assertForbiddenSignature(contents, message, "scripts/const-deploy.mjs");
}

for (const [contents, message] of [
  [
    `const args = ["builds", "submit", "."];
execFileSync("gcloud", args);
`,
    "const argv aliases must be discovered",
  ],
  [
    `const command = "gcloud";
const args = ["app", "deploy", "app.yaml"];
childProcess.execFileSync(command, args);
`,
    "const executable and argv aliases through member callees must be discovered",
  ],
  [
    `const command = "gcloud";
const args = ["app", "deploy", "app.yaml"];
childProcess["execFileSync"](command, args);
`,
    "const executable and argv aliases through statically named computed member callees must be discovered",
  ],
  [
    `const command = "gcloud";
const args = ["builds", "submit", "."];
childProcess[\`execFileSync\`](command, args);
`,
    "no-substitution template member callees must be discovered",
  ],
  [
    `const command = "gcloud";
const args = ["builds", "submit", "."];
childProcess[("execFileSync")](command, args);
`,
    "parenthesized computed member callees must be discovered",
  ],
  [
    `const baseArgs = ["builds", "submit", "."];
const args = baseArgs;
execFileSync("gcloud", args);
`,
    "two-hop const argv aliases must be discovered",
  ],
  [
    `function deploy() {
  const command = "gcloud";
  const args = ["builds", "submit", "."];
  execFileSync(command, args);
}
`,
    "function-local const aliases must be discovered",
  ],
  [
    `function deploy() {
  execFileSync("gcloud", args);
}
const args = ["builds", "submit", "."];
deploy();
`,
    "closure captures of later const declarations must be discovered",
  ],
  [
    `const command = "echo";
function deploy() {
  const command = "gcloud";
  execFileSync(command, ["builds", "submit", "."]);
}
`,
    "nested lexical shadowing must resolve the bound const",
  ],
  [
    `const command = ["gcloud", "builds", "submit", "."];
Bun.spawn(command);
`,
    "const command-vector aliases must be discovered",
  ],
  [
    `const suffix = ["submit", "."];
execFileSync("gcloud", ["builds", ...suffix]);
`,
    "const argv array spreads must be flattened when statically evaluable",
  ],
  [
    `Bun.spawn(["gcloud", ...["app", "deploy", "app.yaml"]]);
`,
    "literal command-vector array spreads must be flattened",
  ],
  [
    `const options = {
  cmd: ["gcloud", "app", "deploy", "app.yaml"],
};
run(options);
`,
    "const object cmd aliases must be discovered",
  ],
  [
    `const options = {
  cmd: ["gcloud", "app", "deploy", "app.yaml"],
};
Bun.spawn(options["cmd"]);
`,
    "quoted object command-vector aliases must be discovered",
  ],
  [
    `const spec = {
  command: "gcloud",
  args: ["builds", "submit", "."],
};
execFileSync(spec.command, spec.args);
`,
    "const object property aliases must be discovered",
  ],
  [
    `const spec = {
  command: "gcloud",
  args: ["builds", "submit", "."],
};
execFileSync(spec["command"], spec["args"]);
`,
    "quoted object property aliases must be discovered",
  ],
  [
    `run({ command: "gcloud", args: ["builds", "submit", "."] });
`,
    "object command and args must be discovered",
  ],
  [
    `new Deno.Command("gcloud", { args: ["app", "deploy", "app.yaml"] });
`,
    "Deno options must be discovered",
  ],
  [
    `const args = ["app", "deploy", "app.yaml"];
new Deno.Command("gcloud", { args });
`,
    "Deno shorthand const args must be discovered",
  ],
  [
    `const cmd = ["gcloud", "builds", "submit", "."];
Bun.spawn({ cmd });
`,
    "Bun shorthand const command vectors must be discovered",
  ],
  [
    `run({
  ...defaults,
  command: "gcloud",
  args: ["builds", "submit", "."],
});
`,
    "direct static object properties after a spread must be discovered",
  ],
  [
    `const command = "C:\\\\SDK\\\\GCLOUD.CMD";
execFileSync(command, ["builds", "submit", "."]);
`,
    "mixed-case gcloud.cmd const executables must be discovered",
  ],
]) {
  assertProgrammaticConstCallsite(contents, message);
}

assertForbiddenSignature(
  `const command = "gcloud";
const args = ["builds", "submit", "."];
childProcess["execFileSync" as const](command, args);
`,
  "TypeScript asserted computed member callees must be discovered",
  "scripts/const-deploy.ts",
);
assertForbiddenSignature(
  `const spec = {
  command: "gcloud",
  args: ["builds", "submit", "."],
};
execFileSync(spec[("command" as const)], spec[\`args\`]);
`,
  "TypeScript-wrapped quoted object property aliases must be discovered",
  "scripts/const-deploy.ts",
);

for (const [contents, message] of [
  [
    `let args = ["builds", "submit", "."];
execFileSync("gcloud", args);
`,
    "let aliases must not be evaluated",
  ],
  [
    `const method = "execFileSync";
const command = "gcloud";
const args = ["builds", "submit", "."];
childProcess[method](command, args);
`,
    "dynamically named computed member callees must not be evaluated",
  ],
  [
    `const command = "gcloud";
const args = ["builds", "submit", "."];
childProcess["debug"](command, args);
`,
    "unknown statically named computed member callees must not be evaluated",
  ],
  [
    `var args = ["builds", "submit", "."];
execFileSync("gcloud", args);
`,
    "var aliases must not be evaluated",
  ],
  [
    `const args = ["builds", "submit", "."];
function deploy(args) { execFileSync("gcloud", args); }
`,
    "parameter shadowing must not be evaluated",
  ],
  [
    `const spec = {
  command: "gcloud",
  args: ["builds", "submit", "."],
};
function deploy(spec) { execFileSync(spec.command, spec.args); }
`,
    "object parameter shadowing must not be evaluated",
  ],
  [
    `const command = "gcloud";
const args = ["builds", "submit", "."];
logger.debug(command, args);
`,
    "const aliases passed to inert member methods must not be executable",
  ],
  [
    `const spec = {
  command: "gcloud",
  args: ["builds", "submit", "."],
};
source.indexOf(spec.command, spec.args);
`,
    "const property aliases passed to inert member methods must not be executable",
  ],
  [
    `const spec = {
  command: "gcloud",
  args: ["builds", "submit", "."],
};
source.indexOf(spec["command"], spec["args"]);
`,
    "quoted property aliases passed to inert member methods must not be executable",
  ],
  [
    `const options = {
  cmd: [
    "gcloud",
    "app",
    "deploy",
    "app.yaml",
  ],
};
source.indexOf(options["cmd"]);
`,
    "quoted command-vector aliases passed to inert member methods must not be executable",
  ],
  [
    `const property = "command";
const spec = {
  command: "gcloud",
  args: ["builds", "submit", "."],
};
execFileSync(spec[property], spec["args"]);
`,
    "dynamically named object properties must not be evaluated",
  ],
  [
    `import args from "./args.mjs";
execFileSync("gcloud", args);
`,
    "imports must not be evaluated",
  ],
  [
    `const { args } = config;
execFileSync("gcloud", args);
`,
    "destructured aliases must not be evaluated",
  ],
  [
    `const args = args;
execFileSync("gcloud", args);
`,
    "self-referential aliases must not be evaluated",
  ],
  [
    `const first = second;
const second = first;
execFileSync("gcloud", first);
`,
    "cyclic aliases must not be evaluated",
  ],
  [
    `const dynamic = getArg();
execFileSync("gcloud", ["builds", dynamic, "."]);
`,
    "dynamic array elements must not be evaluated",
  ],
  [
    `execFileSync("gcloud", ["builds", , "."]);
`,
    "array holes must not be evaluated",
  ],
  [
    `const extra = getArgs();
execFileSync("gcloud", ["builds", ...extra]);
`,
    "dynamic array spreads must not be evaluated",
  ],
  [
    `const args = getArgs();
execFileSync("gcloud", args);
`,
    "dynamic initializers must not be evaluated",
  ],
  [
    `const spec = { command: "gcloud", args: getArgs() };
execFileSync(spec.command, spec.args);
`,
    "dynamic object properties must not be evaluated",
  ],
  [
    `run({
  command: "gcloud",
  ...{ args: ["builds", "submit", "."] },
});
`,
    "object spreads must not be evaluated",
  ],
  [
    `run({
  command: "gcloud",
  get args() { return ["builds", "submit", "."]; },
});
`,
    "object getters must not be evaluated",
  ],
  [
    `run({
  command: "gcloud",
  ["args"]: ["builds", "submit", "."],
});
`,
    "computed object properties must not be evaluated",
  ],
  [
    `run({
  command: "gcloud",
  args: ["builds"],
  args: ["builds", "submit", "."],
});
`,
    "duplicate object properties must not be evaluated",
  ],
  [
    `const command = "gcloud";
const args = ["builds", "submit", "."];
`,
    "inert const data must not be evaluated",
  ],
]) {
  assert.equal(
    discoverDeployStagingCallsites({ "scripts/const-negative.mjs": contents })
      .length,
    0,
    message,
  );
}

const inlineArgsRecord = discoverDeployStagingCallsites({
  "scripts/inline-trusted.mjs": `execFileSync(
  "gcloud",
  ["builds", "submit", "--gcs-source-staging-dir=gs://trusted", "."],
);
`,
})[0];
assert.equal(
  recordHasDeployStagingFlag(
    inlineArgsRecord,
    "gcs-source-staging-dir",
    "gs://trusted",
  ),
  true,
  "literal argv arrays must remain trusted staging evidence",
);
const spreadArgsRecord = discoverDeployStagingCallsites({
  "scripts/spread-argv.mjs": `execFileSync(
  "gcloud",
  [
    "builds",
    "submit",
    ...["--gcs-source-staging-dir=gs://trusted", "."],
  ],
);
`,
})[0];
assert(spreadArgsRecord, "static spread argv must still be detected");
assert.equal(
  spreadArgsRecord.argsTrusted,
  false,
  "spread argv must carry untrusted provenance",
);
assert.equal(
  recordHasDeployStagingFlag(
    spreadArgsRecord,
    "gcs-source-staging-dir",
    "gs://trusted",
  ),
  false,
  "spread argv must not satisfy the staging-flag requirement",
);
const mutableArgsRecord = discoverDeployStagingCallsites({
  "scripts/mutable-const-argv.mjs": `const args = [
  "builds",
  "submit",
  "--gcs-source-staging-dir=gs://trusted",
  ".",
];
args[2] = "--gcs-source-staging-dir=gs://mutated";
execFileSync("gcloud", args);
`,
})[0];
assert(mutableArgsRecord, "mutable const argv must still be detected");
assert.equal(
  mutableArgsRecord.argsTrusted,
  false,
  "const-bound aggregate argv must carry untrusted provenance",
);
assert.equal(
  recordHasDeployStagingFlag(
    mutableArgsRecord,
    "gcs-source-staging-dir",
    "gs://trusted",
  ),
  false,
  "const-bound aggregate argv must not satisfy the staging-flag requirement",
);
const mutablePropertyRecord = discoverDeployStagingCallsites({
  "scripts/mutable-const-property.mjs": `const option = {
  value: "--gcs-source-staging-dir=gs://trusted",
};
option.value = "--gcs-source-staging-dir=gs://mutated";
execFileSync(
  "gcloud",
  ["builds", "submit", option.value, "."],
);
`,
})[0];
assert(
  mutablePropertyRecord,
  "mutable const object properties must still be detected",
);
assert.equal(
  recordHasDeployStagingFlag(
    mutablePropertyRecord,
    "gcs-source-staging-dir",
    "gs://trusted",
  ),
  false,
  "mutable const object properties must not satisfy the staging-flag requirement",
);

for (const [contents, message, filePath] of [
  [
    "gcloud --project mento-monitoring builds submit .",
    "separated global flag",
  ],
  [
    "gcloud builds --project mento-monitoring submit .",
    "group-interposed flag",
  ],
  [
    "gcloud app --access-token-file /tmp/token deploy app.yaml",
    "group-interposed global flag",
  ],
  ["{ gcloud builds submit .; }", "brace group"],
  ["f(){ gcloud app deploy app.yaml; }", "function body"],
  ["function f { gcloud builds submit .; }", "function declaration"],
  ["echo { gcloud builds submit .; }", "inert brace data fails closed"],
  ["echo 'gcloud app deploy app.yaml'", "quoted log fails closed"],
  ['g"cloud" build\\s sub\\mit .', "quoted and escaped literals"],
  ["g\\\ncloud build\\\ns sub\\\nmit .", "escaped line continuations"],
  ["`gcloud builds submit .`", "backtick substitution"],
  ["/usr/local/bin/gcloud app deploy app.yaml", "absolute gcloud path"],
  ["cat <<\\EOF\ngcloud builds submit .\nEOF", "backslash quoted heredoc"],
  ["cat <<'E'OF\ngcloud app deploy app.yaml\nEOF", "quoted heredoc"],
  ["bash -s <<EOF\ngcloud builds submit .\nEOF", "shell-fed heredoc"],
  ["printf 'gcloud app deploy app.yaml\\n' | xargs -I{} {}", "xargs direct"],
  [
    "bash -O extglob -c 'gcloud builds submit .'",
    "bash option and command string",
  ],
  [
    "printf 'gcloud app deploy app.yaml\\n' > ./generated; source ./generated",
    "relative generated source",
  ],
  [
    "gcloud builds submit .",
    "nested extensionless candidate",
    "packages/foo/scripts/deploy",
  ],
  [
    "deploy:\n\tgcloud builds submit .",
    "Makefile fragment candidate",
    "scripts/deploy.mk",
  ],
  ["gcloud app deploy app.yaml", "root extensionless candidate", "deploy"],
  ["gcloud builds submit .", "tools extensionless candidate", "tools/deploy"],
  [
    "gcloud app deploy app.yaml",
    "executable custom extension candidate",
    "scripts/deploy.custom",
  ],
  [
    "gcloud builds submit .",
    "PowerShell script candidate",
    "scripts/deploy.ps1",
  ],
  [
    "function Deploy-App { gcloud app deploy app.yaml }",
    "PowerShell module candidate",
    "scripts/deploy.psm1",
  ],
  [
    "gcloud builds `\n  submit .",
    "PowerShell continuation",
    "scripts/multiline-deploy.ps1",
  ],
  [
    "<# gcloud builds submit . #>",
    "PowerShell block comments fail closed",
    "scripts/commented-deploy.ps1",
  ],
  [
    "function Deploy-App {\n  gcloud app `\n    deploy app.yaml\n}",
    "PowerShell module continuation",
    "scripts/multiline-deploy.psm1",
  ],
  ["gcloud builds submit .", "Windows batch candidate", "scripts/deploy.bat"],
  [
    "REM gcloud builds submit .",
    "batch REM lines fail closed",
    "scripts/commented-deploy.cmd",
  ],
  [
    ":: gcloud app deploy app.yaml",
    "batch double-colon lines fail closed",
    "scripts/commented-deploy.bat",
  ],
  [
    "echo setup # & gcloud builds submit .",
    "hash text in batch sources remains executable",
    "scripts/hash-deploy.cmd",
  ],
  [
    "gcloud app deploy app.yaml",
    "Windows command candidate",
    "scripts/deploy.cmd",
  ],
  [
    "gcloud builds ^\n  submit .",
    "Windows batch continuation",
    "scripts/multiline-deploy.bat",
  ],
  [
    "gcloud app ^\n  deploy app.yaml",
    "Windows command continuation",
    "scripts/multiline-deploy.cmd",
  ],
  [
    "gcloud.cmd builds submit .",
    "Windows gcloud launcher",
    "scripts/windows-launcher-deploy.cmd",
  ],
  [
    "gclou^d builds submit .",
    "inline cmd caret escaped gcloud launcher",
    "scripts/windows-inline-caret-deploy.cmd",
  ],
  [
    "gclou^d app deploy app.yaml",
    "inline batch caret escaped gcloud launcher",
    "scripts/windows-inline-caret-deploy.bat",
  ],
  [
    "gcloud.c^md builds submit .",
    "inline cmd caret escaped gcloud.cmd launcher",
    "scripts/windows-inline-caret-launcher-deploy.cmd",
  ],
  [
    "C:\\SDK\\GCLOUD.CMD builds submit .",
    "mixed-case absolute Windows gcloud launcher path",
    "scripts/windows-path-launcher-deploy.CMD",
  ],
  [
    ".\\gcloud.cmd app deploy app.yaml",
    "relative Windows gcloud launcher path",
    "scripts/windows-relative-launcher-deploy.ps1",
  ],
]) {
  assertForbiddenSignature(contents, message, filePath);
}

assert.equal(
  discoverDeployStagingCallsites({
    "scripts/windows-double-caret-deploy.cmd": "gclou^^d builds submit .",
  }).length,
  0,
  "double cmd carets must preserve a literal caret and remain a near miss",
);

assert.deepEqual(
  discoverDeployStagingCallsites({
    ".github/workflows/deploy.yml": `jobs:
  deploy:
    steps:
      - run: gclou^d builds submit .
`,
  }).map(({ kind }) => kind),
  ["builds-submit"],
  "GitHub Actions universal shell scanning must recognize cmd caret escapes",
);

for (const filePath of [
  ".github/workflows/hash-deploy.yml",
  ".github/actions/deploy/action.yml",
]) {
  const contents = filePath.startsWith(".github/workflows/")
    ? `jobs:
  deploy:
    steps:
      - shell: cmd
        run: |
          echo setup # & gcloud builds submit .
`
    : `runs:
  using: composite
  steps:
    - shell: cmd
      run: |
        echo setup # & gcloud builds submit .
`;
  assertForbiddenSignature(
    contents,
    "hash text in cmd workflow surfaces remains executable",
    filePath,
  );
}

assert.equal(
  discoverDeployStagingCallsites({
    ".github/workflows/bash-comment.yml": `jobs:
  deploy:
    steps:
      - shell: bash
        run: |
          echo setup # & gcloud builds submit .
`,
  }).length,
  0,
  "hash text in a statically selected bash step must remain a comment",
);

assert.deepEqual(
  discoverDeployStagingCallsites({
    ".github/workflows/windows-bash-deploy.yml": `jobs:
  deploy:
    runs-on: windows-latest
    steps:
      - shell: bash
        run: GCLOUD.CMD builds submit .
`,
  }).map(({ kind }) => kind),
  ["builds-submit"],
  "a statically selected bash shell must retain Windows executable matching",
);

assert.deepEqual(
  discoverDeployStagingCallsites({
    ".github/workflows/inherited-cmd-hash.yml": `jobs:
  deploy:
    defaults:
      run:
        shell: cmd
    steps:
      - run: |
          echo setup # & gcloud builds submit .
`,
  }).map(({ kind }) => kind),
  ["builds-submit"],
  "inherited workflow shells must retain the conservative cmd hash scan",
);

assertForbiddenSignature(
  JSON.stringify({ scripts: { deploy: "gcloud builds submit ." } }),
  "package-script surface",
  "package.json",
);
assertForbiddenSignature(
  "command: [gcloud, builds, submit, .]\n",
  "YAML argv array",
  "new-cloudbuild.yaml",
);
assertSingleStructuredSignature(
  JSON.stringify({ entrypoint: "gcloud", args: ["app", "deploy", "app.yaml"] }),
  "JSON entrypoint and argv array",
  "new-cloudbuild.json",
  "app-deploy",
  "entrypoint+args",
);
assertSingleStructuredSignature(
  JSON.stringify({
    steps: [
      {
        name: "gcr.io/cloud-builders/gcloud",
        entrypoint: "gcloud",
        args: ["app", "deploy", "app.yaml"],
      },
    ],
  }),
  "Cloud Build entrypoint override and argv array",
  "cloudbuild-overlap.json",
  "app-deploy",
  "steps[0].entrypoint+args",
);
assertSingleStructuredSignature(
  `apiVersion: batch/v1
kind: Job
spec:
  template:
    spec:
      containers:
        - name: deploy
          image: google/cloud-sdk
          command: ["gcloud"]
          args: ["builds", "submit", "."]
`,
  "Kubernetes command and args arrays",
  "new-deploy-job.yaml",
  "builds-submit",
  "spec.template.spec.containers[0].command+args",
);
assertSingleStructuredSignature(
  `services:
  deploy:
    image: google/cloud-sdk
    entrypoint: ["gcloud"]
    command: ["app", "deploy", "app.yaml"]
`,
  "Compose entrypoint and command arrays",
  "compose.yaml",
  "app-deploy",
  "services.deploy.entrypoint+command",
);
assertForbiddenSignature(
  `resource "terraform_data" "unregistered_deploy" {
  provisioner "local-exec" {
    command = "gcloud builds submit ."
  }
}
`,
  "Terraform local-exec command",
  "terraform/local-exec-deploy.tf",
);
assertForbiddenSignature(
  `import { execFileSync } from "node:child_process";
execFileSync("gcloud", ["builds", "submit", "."]);
`,
  "Node child-process argv",
  "scripts/alternate-deploy.mjs",
);
assertForbiddenSignature(
  `import { execFileSync } from "node:child_process";
execFileSync("gcloud", [
  "builds",
  "submit",
  ".",
]);
`,
  "multiline Node child-process argv",
  "scripts/alternate-multiline-deploy.mjs",
);
assertForbiddenSignature(
  `import { execFileSync } from "node:child_process";
execFileSync("C:\\\\SDK\\\\GCLOUD.CMD", [
  "builds",
  "submit",
  ".",
]);
`,
  "mixed-case Windows gcloud launcher through Node",
  "scripts/windows-launcher-deploy.MJS",
);
assertForbiddenSignature(
  `import { spawn } from "node:child_process";
spawn("/usr/local/bin/gcloud", [
  "app",
  // Keep the deploy mode explicit.
  "deploy",
  "app.yaml",
]);
`,
  "multiline absolute-path child-process argv",
  "scripts/absolute-multiline-deploy.mjs",
);
assertForbiddenSignature(
  `Bun.spawn([
  "/usr/local/bin/gcloud",
  "builds",
  // Keep source staging explicit.
  "submit",
  ".",
]);
`,
  "multiline command-vector argv",
  "scripts/command-vector-deploy.mjs",
);
assertForbiddenSignature(
  `Bun.spawn({
  cmd: [
    "gcloud",
    "builds",
    "submit",
    ".",
  ],
});
`,
  "multiline object-form command-vector argv",
  "scripts/object-command-vector-deploy.mjs",
);
assertForbiddenSignature(
  `Bun.spawnSync({
  cmd: [
    "gcloud",
    "app",
    "deploy",
    "app.yaml",
  ],
});
`,
  "multiline synchronous object-form command-vector argv",
  "scripts/sync-object-command-vector-deploy.mjs",
);
assertForbiddenSignature(
  `run({
  cmd: [
    "gcloud",
    "builds",
    "submit",
    ".",
  ],
});
`,
  "multiline unknown direct object-form wrappers must be discovered",
  "scripts/unknown-object-command-vector-deploy.mjs",
);
assertForbiddenSignature(
  `await $\`gcloud builds
submit .\`;
`,
  "multiline zx tagged-template command",
  "scripts/zx-tagged-template-deploy.mjs",
);
assertForbiddenSignature(
  `await Bun.$\`gcloud app
deploy app.yaml\`;
`,
  "multiline Bun tagged-template command",
  "scripts/bun-tagged-template-deploy.mjs",
);
assertForbiddenSignature(
  `await deploy\`gcloud builds
submit .\`;
`,
  "multiline unknown static tagged wrappers must be discovered",
  "scripts/unknown-tagged-template-deploy.mjs",
);
assertForbiddenSignature(
  `await $\`# setup
gcloud builds submit .\`;
`,
  "tagged-template command after a shell comment",
  "scripts/comment-prefixed-tagged-template-deploy.mjs",
);
assertForbiddenSignature(
  `execSync(
  "gcloud builds " +
    "submit .",
);
`,
  "multiline statically concatenated command",
  "scripts/concatenated-command-deploy.mjs",
);
assertForbiddenSignature(
  `childProcess.execSync(
  "gcloud builds " +
    "submit .",
);
`,
  "multiline static command string through a member callee",
  "scripts/member-concatenated-command-deploy.mjs",
);
assertForbiddenSignature(
  `execSync(\`gcloud \${"builds"}
\${"submit"} .\`);
`,
  "multiline static template-expression command",
  "scripts/static-template-expression-deploy.mjs",
);
assertForbiddenSignature(
  `execSync("GCLOUD.CMD builds submit .");
`,
  "mixed-case Windows launcher in a programmatic command string",
  "scripts/windows-command-string-deploy.mjs",
);
assertForbiddenSignature(
  `execSync("C:\\\\SDK\\\\GCLOUD.CMD app deploy app.yaml");
`,
  "mixed-case Windows launcher path in a programmatic command string",
  "scripts/windows-path-command-string-deploy.mjs",
);
assertForbiddenSignature(
  `execSync("/usr/local/bin/gcloud builds submit .");
`,
  "Unix launcher path in a programmatic command string",
  "scripts/unix-path-command-string-deploy.mjs",
);
assertForbiddenSignature(
  `await $\`GCLOUD.CMD builds
submit .\`;
`,
  "mixed-case Windows launcher in a tagged-template command",
  "scripts/windows-tagged-template-deploy.mjs",
);
assertForbiddenSignature(
  `execFileSync(
  ("gcloud" as string),
  [
    "builds",
    "submit",
    ".",
  ] as const,
);
`,
  "typed multiline child-process argv",
  "scripts/typed-child-process-deploy.ts",
);
assertForbiddenSignature(
  `new Deno.Command("gcloud", {
  args: [
    "app",
    "deploy",
    "app.yaml",
  ],
});
`,
  "multiline constructor args object",
  "scripts/constructor-deploy.mjs",
);
assertForbiddenSignature(
  `record("gcloud", [
  "builds",
  "submit",
  ".",
]);
`,
  "multiline unknown direct programmatic wrappers must be discovered",
  "scripts/unknown-wrapper-deploy.mjs",
);
assertForbiddenSignature(
  `import { execa } from "execa";
await execa("gcloud", ["app", "deploy", "app.yaml"]);
`,
  "TypeScript child-process argv",
  "packages/deployer/src/deploy.ts",
);
assertForbiddenSignature(
  `import { execa } from "execa";
await execa(
  "gcloud",
  ["app", "deploy", "app.yaml"],
);
`,
  "multiline TypeScript child-process argv",
  "packages/deployer/src/multiline-deploy.ts",
);
assertForbiddenSignature(
  `import { execSync } from "node:child_process";
execSync(\`gcloud builds
submit .\`);
`,
  "multiline static command string",
  "scripts/static-command-deploy.mjs",
);
assertForbiddenSignature(
  "FROM gcr.io/google.com/cloudsdktool/google-cloud-cli:stable\nRUN gcloud app deploy app.yaml\n",
  "named Dockerfile",
  "images/deployer/Dockerfile.release",
);
assertForbiddenSignature(
  "gcloud builds \\\n  submit .\n",
  "shell template",
  "templates/deploy.sh.tftpl",
);
assertForbiddenSignature(
  "gcloud builds ^\n  submit .\n",
  "Windows command template",
  "templates/deploy.cmd.tftpl",
);
assertForbiddenSignature(
  "FROM gcr.io/google.com/cloudsdktool/google-cloud-cli:stable\nRUN gcloud app deploy app.yaml\n",
  "Dockerfile template",
  "templates/Dockerfile.release.tftpl",
);
assertForbiddenSignature(
  `const command = "gcloud";
const args = ["builds", "submit", "."];
execFileSync(command, args);
`,
  "Node source template",
  "templates/deploy.mjs.tftpl",
);
assertForbiddenSignature(
  'const command = "gcloud";\nconst args = ["builds", "submit", "."];\nexecFileSync(command, args);\n',
  "Node source .tpl template",
  "templates/deploy.mjs.tpl",
);

for (const [contents, message] of [
  [
    `/*
execFileSync("gcloud", [
  "builds",
  "submit",
  ".",
]);
*/
`,
    "AST recovery must not join comment-only multiline tokens",
  ],
  [
    `const example = \`execFileSync("gcloud", [
  "builds",
  "submit",
  ".",
])\`;
`,
    "AST recovery must not join quoted multiline example tokens",
  ],
  [
    `const example = [
  "gcloud",
  "builds",
  "submit",
  ".",
];
`,
    "AST recovery must not treat an inert command vector as an invocation",
  ],
  [
    `const example = {
  command: "gcloud",
  args: [
    "builds",
    "submit",
    ".",
  ],
};
`,
    "AST recovery must not treat inert constructor data as an invocation",
  ],
  [
    `const example = {
  cmd: [
    "gcloud",
    "builds",
    "submit",
    ".",
  ],
};
`,
    "AST recovery must not treat an inert Bun command vector as an invocation",
  ],
  [
    `const example = \`gcloud builds
submit .\`;
`,
    "AST recovery must not treat an untagged template as an invocation",
  ],
  [
    `await $\`
# gcloud builds
submit .
echo safe
\`;
`,
    "AST recovery must preserve shell comments in tagged templates",
  ],
  [
    `await $\`gcloud builds # incomplete command
submit .\`;
`,
    "AST recovery must not join commands across shell comments",
  ],
  [
    `await $\`gcloud builds \${flags}
submit .\`;
`,
    "AST recovery must not guess across dynamic template substitutions",
  ],
]) {
  assert.equal(
    discoverDeployStagingCallsites({
      "scripts/programmatic-decoy.mjs": contents,
    }).length,
    0,
    message,
  );
}

assert.equal(
  discoverDeployStagingCallsites({
    "scripts/inline-tagged-template.mjs": "await $`gcloud builds submit .`;\n",
  }).length,
  1,
  "AST recovery must not duplicate inline tagged-template records",
);
assert.equal(
  discoverDeployStagingCallsites({
    "scripts/static-tagged-template.mjs":
      'await $`gcloud ${"builds"} ${"submit"} .`;\n',
  }).length,
  1,
  "tagged templates with literal-only interpolations must stay discoverable",
);
const constTaggedTemplateRecord = discoverDeployStagingCallsites({
  "scripts/const-tagged-template.mjs": `const group = "builds";
await $\`gcloud \${group} submit .\`;
`,
})[0];
assert(
  constTaggedTemplateRecord,
  "tagged templates with const interpolations must be discovered",
);
const constTaggedFlagRecord = discoverDeployStagingCallsites({
  "scripts/const-tagged-flag.mjs": `const group = "builds";
const staging =
  "--gcs-source-staging-dir=gs://trusted";
await $\`gcloud \${group} submit \${staging} .\`;
`,
})[0];
assert(
  constTaggedFlagRecord,
  "tagged templates with const flag interpolations must be discovered",
);
assert.equal(
  constTaggedFlagRecord.flagTrusted,
  false,
  "resolved tagged-template records must carry untrusted flag provenance",
);
assert.equal(
  recordHasDeployStagingFlag(
    constTaggedFlagRecord,
    "gcs-source-staging-dir",
    "gs://trusted",
  ),
  false,
  "resolved tagged-template constants must not prove a required staging flag",
);
assert.equal(
  discoverDeployStagingCallsites({
    "scripts/lowercase-windows-command-string.mjs":
      'execSync("gcloud.cmd builds submit .");\n',
  }).length,
  1,
  "programmatic Windows launcher recovery must not duplicate lowercase records",
);

assert.equal(
  discoverDeployStagingCallsites({
    "scripts/comment-only.sh": `#!/usr/bin/env bash
# gcloud builds submit .
# gcloud app deploy app.yaml
`,
  }).length,
  0,
  "comments must remain outside the literal deploy policy",
);
assert.equal(
  discoverDeployStagingCallsites({
    "terraform/comment-only.tf": `# gcloud builds submit .
// gcloud app deploy app.yaml
/*
gcloud builds submit .
*/
`,
  }).length,
  0,
  "Terraform comments must remain outside the literal deploy policy",
);

const commentsOnly = {
  ...files,
  "scripts/comment-only.sh": `#!/usr/bin/env bash
# gcloud builds submit .
# gcloud app deploy app.yaml
`,
};
assert.equal(
  discoverDeployStagingCallsites(commentsOnly).length,
  discoverDeployStagingCallsites(files).length,
  "comments must not create executable callsites",
);
assert.equal(
  discoverDeployStagingCallsites({
    "scripts/gcloud-wrapper.sh": "gcloud.py app deploy app.yaml\n",
  }).length,
  0,
  "different executable names must not match the gcloud basename",
);
assert.equal(
  discoverDeployStagingCallsites({
    "scripts/gcloud-wrapper.cmd": "gcloud.cmdx app deploy app.yaml\n",
  }).length,
  0,
  "longer Windows executable names must not match the gcloud.cmd basename",
);
assert.equal(
  discoverDeployStagingCallsites({
    "scripts/gcloud-wrapper.mjs":
      'execSync("GCLOUD.CMDX app deploy app.yaml");\n',
  }).length,
  0,
  "programmatic Windows launcher near misses must stay ignored",
);
assert.equal(
  discoverDeployStagingCallsites({
    "scripts/uppercase-unix-launcher.mjs":
      'execSync("GCLOUD builds submit .");\n',
  }).length,
  0,
  "programmatic Windows support must not make bare Unix launchers case-insensitive",
);

assertDeployStagingContract(files);
console.log("deployment source-staging contract tests passed");
