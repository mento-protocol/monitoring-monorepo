#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  closeSync,
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
  validateDeployStagingContract,
} from "./deploy-staging-contract.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const SHELL_FILE_EXTENSIONS = [
  ".bash",
  ".command",
  ".fish",
  ".ksh",
  ".sh",
  ".zsh",
];

function isCandidate(filePath) {
  return (
    filePath.endsWith(".tf") ||
    SHELL_FILE_EXTENSIONS.some((extension) => filePath.endsWith(extension)) ||
    filePath.endsWith(".yml") ||
    filePath.endsWith(".yaml") ||
    filePath.endsWith(".json") ||
    filePath.endsWith("package.json") ||
    path.extname(filePath) === ""
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
  shouldScanFile("scripts/new-deploy.custom", { mode: 0o100644 }, true),
  true,
  "non-executable arbitrary-extension shebang files must be scanned",
);
assert.equal(
  isCandidate("cloudbuild.json"),
  true,
  "JSON Cloud Build configurations must be scanned for deploy callsites",
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

function assertCallsiteKinds(contents, expected, message) {
  assert.deepEqual(
    discoverDeployStagingCallsites({
      "scripts/common-invocations.command": contents,
    }).map(({ kind }) => kind),
    expected,
    message,
  );
}

for (const [contents, expected, message] of [
  [
    "gcloud --project=mento-monitoring builds submit .",
    ["builds-submit"],
    "global flags",
  ],
  ["gcloud --log-http builds submit .", ["builds-submit"], "boolean flags"],
  [
    "command gcloud --user-output-enabled app deploy app.yaml",
    ["app-deploy"],
    "command",
  ],
  [
    "env FOO=bar gcloud beta app deploy app.yaml",
    ["app-deploy"],
    "env assignments",
  ],
  ["exec gcloud builds submit .", ["builds-submit"], "bare exec"],
  ["time gcloud app deploy app.yaml", ["app-deploy"], "bare time"],
  ["time -p gcloud app deploy app.yaml", ["app-deploy"], "time -p"],
  ["exec -a deploy gcloud builds submit .", ["builds-submit"], "exec -a"],
  ["exec -c gcloud builds submit .", ["builds-submit"], "exec -c"],
  ["exec -l gcloud app deploy app.yaml", ["app-deploy"], "exec -l"],
  ["exec -cl gcloud builds submit .", ["builds-submit"], "exec -cl"],
  ["exec -lc gcloud app deploy app.yaml", ["app-deploy"], "exec -lc"],
  ["command -p gcloud app deploy app.yaml", ["app-deploy"], "command -p"],
  ["command -- gcloud builds submit .", ["builds-submit"], "command --"],
  ["env -i FOO=bar gcloud builds submit .", ["builds-submit"], "env -i"],
  [
    "env --ignore-environment gcloud app deploy app.yaml",
    ["app-deploy"],
    "env --ignore-environment",
  ],
  ["env -u NAME gcloud builds submit .", ["builds-submit"], "env -u"],
  ["env -uNAME gcloud app deploy app.yaml", ["app-deploy"], "env -uNAME"],
  ["env --unset NAME gcloud builds submit .", ["builds-submit"], "env --unset"],
  [
    "env --unset=NAME gcloud app deploy app.yaml",
    ["app-deploy"],
    "env --unset=NAME",
  ],
  ["env -C DIR gcloud builds submit .", ["builds-submit"], "env -C"],
  ["env -CDIR gcloud app deploy app.yaml", ["app-deploy"], "env -CDIR"],
  ["env --chdir DIR gcloud builds submit .", ["builds-submit"], "env --chdir"],
  [
    "env --chdir=DIR gcloud app deploy app.yaml",
    ["app-deploy"],
    "env --chdir=DIR",
  ],
  ["env -- gcloud builds submit .", ["builds-submit"], "env --"],
  [
    "env -- FOO=bar gcloud app deploy app.yaml",
    ["app-deploy"],
    "env -- assignment",
  ],
  [
    "time env -i FOO=bar gcloud builds submit .",
    ["builds-submit"],
    "nested wrappers",
  ],
  ["time command -v gcloud", [], "nested lookup"],
  ["while gcloud builds submit .; do break; done", ["builds-submit"], "while"],
  ["until gcloud app deploy app.yaml; do break; done", ["app-deploy"], "until"],
  [
    "exec -clx gcloud builds submit .",
    ["builds-submit"],
    "unsupported wrapper option fallback",
  ],
  ["command -v gcloud", [], "command -v lookup"],
  ["command -V gcloud", [], "command -V lookup"],
  ["command -pv gcloud", [], "command -pv lookup"],
  ["command -pV gcloud", [], "command -pV lookup"],
  ["echo gcloud builds submit .", [], "echo data"],
  ["env -S 'gcloud builds submit .'", [], "env -S runtime string"],
  [
    "env -S echo gcloud builds submit .",
    ["builds-submit"],
    "unknown option fails closed",
  ],
]) {
  assertCallsiteKinds(contents, expected, message);
}
assertCallsiteKinds(
  "( gcloud builds submit . )",
  ["builds-submit"],
  "grouped commands must expose build submissions",
);
assertCallsiteKinds(
  "result=$(gcloud app deploy app.yaml)",
  ["app-deploy"],
  "command substitutions must expose app deploys once",
);
assertCallsiteKinds(
  'result="$(gcloud beta app deploy app.yaml)"',
  ["app-deploy"],
  "double-quoted command substitutions must expose app deploys",
);
assertCallsiteKinds(
  "echo 'gcloud builds submit .'",
  [],
  "single-quoted command text must remain literal",
);

assert.equal(
  discoverDeployStagingCallsites({
    "scripts/log-deploy.sh": `#!/usr/bin/env bash
echo "gcloud builds submit ."
printf '%s\\n' 'gcloud beta app deploy app.yaml'
`,
  }).length,
  0,
  "quoted deploy text must not create executable callsites",
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

assertDeployStagingContract(files);
console.log("deployment source-staging contract tests passed");
