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
  const basename = path.basename(filePath);
  return basename === "Dockerfile" || basename.startsWith("Dockerfile.");
}

function isCandidate(filePath) {
  return (
    filePath.endsWith(".tf") ||
    SHELL_FILE_EXTENSIONS.some((extension) => filePath.endsWith(extension)) ||
    SCRIPT_SOURCE_FILE_EXTENSIONS.some((extension) =>
      filePath.endsWith(extension),
    ) ||
    isDockerfile(filePath) ||
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
  ["gcloud app deploy app.yaml", "root extensionless candidate", "deploy"],
  ["gcloud builds submit .", "tools extensionless candidate", "tools/deploy"],
  [
    "gcloud app deploy app.yaml",
    "executable custom extension candidate",
    "scripts/deploy.custom",
  ],
]) {
  assertForbiddenSignature(contents, message, filePath);
}

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
assertForbiddenSignature(
  JSON.stringify({ entrypoint: "gcloud", args: ["app", "deploy", "app.yaml"] }),
  "JSON entrypoint and argv array",
  "new-cloudbuild.json",
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
  `import { execa } from "execa";
await execa("gcloud", ["app", "deploy", "app.yaml"]);
`,
  "TypeScript child-process argv",
  "packages/deployer/src/deploy.ts",
);
assertForbiddenSignature(
  "FROM gcr.io/google.com/cloudsdktool/google-cloud-cli:stable\nRUN gcloud app deploy app.yaml\n",
  "named Dockerfile",
  "images/deployer/Dockerfile.release",
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

assertDeployStagingContract(files);
console.log("deployment source-staging contract tests passed");
