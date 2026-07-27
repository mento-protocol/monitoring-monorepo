#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
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

function isCandidate(filePath) {
  return (
    filePath.endsWith(".tf") ||
    filePath.endsWith(".sh") ||
    filePath.endsWith(".yml") ||
    filePath.endsWith(".yaml") ||
    filePath.endsWith("package.json") ||
    path.extname(filePath) === ""
  );
}

function repositoryFiles() {
  const paths = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: repoRoot, encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean)
    .filter(isCandidate);
  const files = {};
  for (const filePath of paths) {
    const absolutePath = path.join(repoRoot, filePath);
    const metadata = lstatSync(absolutePath);
    if (metadata.isSymbolicLink()) {
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
    }
    if (!metadata.isFile() && !metadata.isSymbolicLink()) continue;
    const contents = readFileSync(absolutePath, "utf8");
    if (
      path.extname(filePath) !== "" ||
      filePath.endsWith("package.json") ||
      contents.startsWith("#!")
    ) {
      files[filePath] = contents;
    }
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
      - app
      - deploy
      - --bucket=gs://mento-monitoring-app-engine-source
      - app.yaml
`,
  },
  "executable callsite inventory must be exactly",
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
