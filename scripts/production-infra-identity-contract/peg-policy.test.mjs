#!/usr/bin/env node
import assert from "node:assert/strict";
import { validFixtureFiles } from "./fixtures.mjs";
import { validateProductionInfraIdentityContract } from "./index.mjs";

function mutate(files, filePath, from, to, occurrence = 0) {
  let index = -1;
  for (let count = 0; count <= occurrence; count += 1) {
    index = files[filePath].indexOf(from, index + 1);
  }
  assert(index >= 0, `fixture mutation source missing: ${from}`);
  return {
    ...files,
    [filePath]: `${files[filePath].slice(0, index)}${to}${files[filePath].slice(index + from.length)}`,
  };
}

function expectFailure(files, expected) {
  const errors = validateProductionInfraIdentityContract(files);
  assert(
    errors.some((error) => error.includes(expected)),
    `expected failure containing "${expected}", got:\n${errors.join("\n")}`,
  );
}

const validFiles = validFixtureFiles();
assert.deepEqual(validateProductionInfraIdentityContract(validFiles), []);

function withConcreteGeneration(files, generation) {
  return mutate(
    mutate(
      files,
      "terraform/peg-policy.tf",
      "  peg_policy_runtime_generation = null",
      `  peg_policy_runtime_generation = "${generation}"`,
    ),
    "terraform/metrics-bridge.tf",
    "      template[0].revision,\n",
    "",
  );
}

const activeGenerationFiles = withConcreteGeneration(
  validFiles,
  "1750000000000000",
);
assert.deepEqual(
  validateProductionInfraIdentityContract(activeGenerationFiles),
  [],
);

const maximumGenerationFiles = withConcreteGeneration(
  validFiles,
  "9223372036854775807",
);
assert.deepEqual(
  validateProductionInfraIdentityContract(maximumGenerationFiles),
  [],
);

for (const [from, to, expected, occurrence = 0] of [
  [
    '  name                        = "${google_project.monitoring.project_id}-peg-policy"',
    '  name                        = "public-peg-policy"',
    "Peg policy peg_policy bucket: name must be exactly",
  ],
  [
    "  project                     = google_project.monitoring.project_id",
    "  project                     = var.gcp_project_id",
    "Peg policy peg_policy bucket: project must be exactly",
  ],
  [
    '  name                        = "${google_project.monitoring.project_id}-peg-policy-access-logs"',
    '  name                        = "public-peg-policy-access-logs"',
    "Peg policy peg_policy_access_logs bucket: name must be exactly",
  ],
  [
    "  project                     = google_project.monitoring.project_id",
    "  project                     = var.gcp_project_id",
    "Peg policy peg_policy_access_logs bucket: project must be exactly",
    1,
  ],
  [
    "  uniform_bucket_level_access = true",
    "  uniform_bucket_level_access = false",
    "Peg policy peg_policy bucket: uniform_bucket_level_access must be exactly",
  ],
  [
    "  force_destroy               = false",
    "  force_destroy               = true",
    "Peg policy peg_policy bucket: force_destroy must be exactly",
  ],
  [
    "    enabled = true",
    "    enabled = false",
    "Peg policy peg_policy bucket: enabled must be exactly",
  ],
  [
    '  public_access_prevention    = "enforced"',
    '  public_access_prevention    = "inherited"',
    "Peg policy peg_policy_access_logs bucket: public_access_prevention must be exactly",
    1,
  ],
  [
    "      days_since_noncurrent_time = 30",
    "      days_since_noncurrent_time = 29",
    "Peg policy peg_policy bucket: must retain ARCHIVED",
  ],
  [
    "      age        = 90",
    "      age        = 89",
    "Peg policy peg_policy_access_logs bucket: must retain LIVE",
  ],
  [
    "    prevent_destroy = true",
    "    prevent_destroy = false",
    "Peg policy peg_policy bucket: prevent_destroy must be exactly",
    0,
  ],
  [
    "  project      = google_project.monitoring.project_id",
    "  project      = var.gcp_project_id",
    "Peg policy metrics_bridge_runtime identity: project must be exactly",
  ],
  [
    "  project      = google_project.monitoring.project_id",
    "  project      = var.gcp_project_id",
    "Peg policy peg_policy_publisher identity: project must be exactly",
    1,
  ],
  [
    '    role = "roles/storage.objectViewer"',
    '    role = "roles/storage.admin"',
    'Peg policy peg_policy authoritative IAM policy: must contain exactly one "roles/storage.objectViewer" binding',
  ],
  [
    '      "serviceAccount:${google_service_account.metrics_bridge_runtime.email}",',
    '      "serviceAccount:${google_service_account.peg_policy_publisher.email}",',
    'Peg policy peg_policy authoritative IAM policy: "roles/storage.objectViewer" members must contain only',
  ],
  [
    '      "serviceAccount:${google_service_account.peg_policy_publisher.email}",',
    '      "serviceAccount:${google_service_account.metrics_bridge_runtime.email}",',
    'Peg policy peg_policy authoritative IAM policy: "roles/storage.objectAdmin" members must contain only',
  ],
  [
    '  role               = "roles/iam.serviceAccountTokenCreator"',
    '  role               = "roles/iam.serviceAccountUser"',
    "Peg policy publisher Token Creator: role must be exactly",
  ],
]) {
  expectFailure(
    mutate(validFiles, "terraform/peg-policy.tf", from, to, occurrence),
    expected,
  );
}

expectFailure(
  mutate(
    validFiles,
    "terraform/peg-policy.tf",
    `    condition {
      days_since_noncurrent_time = 30
      with_state                 = "ARCHIVED"
    }`,
    "",
  ),
  "Peg policy peg_policy bucket: must retain ARCHIVED",
);

expectFailure(
  mutate(
    validFiles,
    "terraform/peg-policy.tf",
    `    condition {
      days_since_noncurrent_time = 30
      with_state                 = "ARCHIVED"
    }`,
    `    condition {
      days_since_noncurrent_time = 30
      with_state                 = "ARCHIVED"
    }
    condition {
      days_since_noncurrent_time = 30
      with_state                 = "ARCHIVED"
    }`,
  ),
  "Peg policy peg_policy bucket: must retain ARCHIVED",
);

expectFailure(
  {
    ...validFiles,
    "terraform/peg-policy-project.tf": `
resource "google_project" "peg_policy" {
  project_id = "mento-monitoring-peg-policy"
}
`,
  },
  "separate Peg policy project references are forbidden",
);

expectFailure(
  mutate(
    validFiles,
    "terraform/peg-policy.tf",
    "    prevent_destroy = true",
    "    prevent_destroy = false",
    2,
  ),
  "Peg policy peg_policy_access_logs authoritative IAM policy: prevent_destroy must be exactly",
);

expectFailure(
  mutate(
    validFiles,
    "terraform/peg-policy.tf",
    `  binding {
    role = "roles/storage.objectAdmin"
    members = [
      "serviceAccount:\${google_service_account.peg_policy_publisher.email}",
    ]
  }`,
    `  binding {
    role = "roles/storage.objectAdmin"
    members = [
      "serviceAccount:\${google_service_account.peg_policy_publisher.email}",
    ]
  }
  binding {
    role = "roles/storage.objectCreator"
    members = ["group:eng@mentolabs.xyz"]
  }`,
  ),
  "Peg policy peg_policy authoritative IAM policy: must contain exactly 2 bindings",
);

expectFailure(
  {
    ...validFiles,
    "terraform/peg-policy-publisher-extra.tf": `
resource "google_project_iam_member" "publisher_extra" {
  project = google_project.monitoring.project_id
  role = "roles/storage.admin"
  member = "serviceAccount:\${google_service_account.peg_policy_publisher.email}"
}
`,
  },
  "Peg policy publisher identity: unexpected IAM grants are forbidden",
);

expectFailure(
  {
    ...validFiles,
    "terraform/peg-policy-variable.tf": `
variable "gcp_peg_policy_project_id" { type = string }
`,
  },
  "separate Peg policy project references are forbidden",
);

expectFailure(
  {
    ...validFiles,
    "terraform/peg-policy-member.tf": `
resource "google_storage_bucket_iam_member" "peg_policy_legacy_reader" {
  bucket = google_storage_bucket.peg_policy.name
  role = "roles/storage.objectViewer"
  member = "group:eng@mentolabs.xyz"
}
`,
  },
  "Peg buckets must use only authoritative IAM policies",
);

expectFailure(
  {
    ...validFiles,
    "terraform/peg-policy-runtime-extra.tf": `
resource "google_project_iam_member" "runtime_extra" {
  project = google_project.monitoring.project_id
  role = "roles/storage.admin"
  member = "serviceAccount:\${google_service_account.metrics_bridge_runtime.email}"
}
`,
  },
  "Peg policy runtime identity: unexpected IAM grants are forbidden",
);

for (const [filePath, contents, expected] of [
  [
    "terraform/ci-wif.tf",
    `
locals {
  ci_deployer_roles = ["roles/storage.admin"]
}
`,
    "ci_deployer_roles must contain only the approved deploy roles",
  ],
  [
    "terraform/ci-wif.tf",
    `
locals {
  ci_deployer_roles = ["roles/iam.serviceAccountUser"]
}
`,
    "ci_deployer_roles must contain only the approved deploy roles",
  ],
  [
    "terraform/ci-wif.tf",
    `
locals {
  ci_deployer_roles = ["roles/storage.objectAdmin"]
}
`,
    "ci_deployer_roles must contain only the approved deploy roles",
  ],
  [
    "terraform/ci-wif.tf",
    `
locals {
  ci_deployer_roles = ["roles/browser"]
}
`,
    "ci_deployer_roles must contain only the approved deploy roles",
  ],
  [
    "terraform/project-iam.tf",
    `
resource "google_project_iam_member" "renamed_dev_storage_admin" {
  project = google_project.monitoring.project_id
  role = "roles/storage.admin"
  member = "group:eng@mentolabs.xyz"
}
`,
    "direct project IAM grants may not restore broad storage or Service Account User roles",
  ],
  [
    "terraform/project-iam.tf",
    `
resource "google_project_iam_member" "direct_project_act_as" {
  project = google_project.monitoring.project_id
  role = "roles/iam.serviceAccountUser"
  member = "group:eng@mentolabs.xyz"
}
`,
    "direct project IAM grants may not restore broad storage or Service Account User roles",
  ],
  [
    "terraform/aegis-bootstrap.tf",
    `
locals {
  grafana_agent_builder_project_roles = toset(["roles/storage.objectAdmin"])
}
`,
    "grafana_agent_builder_project_roles must contain only the approved builder roles",
  ],
]) {
  expectFailure(
    {
      ...validFiles,
      [filePath]: `${validFiles[filePath] ?? ""}${contents}`,
    },
    expected,
  );
}

expectFailure(
  mutate(
    validFiles,
    "terraform/peg-policy.tf",
    "  depends_on = [google_project_service.storage]",
    "  depends_on = [google_project_service.iam]",
  ),
  "Peg policy peg_policy_access_logs bucket: depends_on must contain only",
);

expectFailure(
  mutate(
    validFiles,
    "terraform/peg-policy.tf",
    '    log_object_prefix = "peg-policy/"',
    '    log_object_prefix = "other/"',
  ),
  "Peg policy peg_policy bucket: log_object_prefix must be exactly",
);

for (const [filePath, from, to, expected] of [
  [
    "terraform/peg-policy.tf",
    "https://storage.googleapis.com/download/storage/v1/b/${google_storage_bucket.peg_policy.name}/o/peg-policy%2Fcurrent.json?alt=media&generation=${local.peg_policy_runtime_generation}",
    "https://storage.googleapis.com/storage/v1/b/${google_storage_bucket.peg_policy.name}/o/peg-policy%2Fcurrent.json?alt=media&generation=${local.peg_policy_runtime_generation}",
    "Peg policy runtime attachment: canonical URL: must be exactly source-controlled",
  ],
  [
    "terraform/peg-policy.tf",
    '    PEG_POLICY_AUTH_MODE = "gcp-metadata"',
    '    PEG_POLICY_AUTH_MODE = "none"',
    "Peg policy runtime attachment: paired environment: must be exactly source-controlled",
  ],
  [
    "terraform/metrics-bridge.tf",
    "    service_account = google_service_account.metrics_bridge_runtime.email",
    "    service_account = google_service_account.metrics_bridge_deployer.email",
    "Peg policy runtime attachment: service_account must be exactly",
  ],
  [
    "terraform/metrics-bridge.tf",
    "        for_each = local.peg_policy_runtime_env",
    "        for_each = {}",
    "Peg policy runtime attachment: for_each must be exactly",
  ],
  [
    "terraform/metrics-bridge.tf",
    '      condition     = local.peg_policy_runtime_generation == null ? true : (can(regex("^[1-9][0-9]*$", local.peg_policy_runtime_generation)) && can(tonumber(local.peg_policy_runtime_generation)) && tonumber(local.peg_policy_runtime_generation) <= 9223372036854775807)',
    "      condition     = true",
    "Peg policy runtime attachment: condition must be exactly",
  ],
]) {
  expectFailure(mutate(validFiles, filePath, from, to), expected);
}

for (const invalidGeneration of [
  '""',
  '"0"',
  '"01"',
  '"-1"',
  '"1.5"',
  '"\\u0031"',
  '"9223372036854775808"',
  "1750000000000000",
  "local.published_generation",
  "var.peg_policy_runtime_generation",
]) {
  expectFailure(
    mutate(validFiles, "terraform/peg-policy.tf", "null", invalidGeneration),
    "Peg policy runtime attachment: generation must be exactly null or a quoted positive decimal GCS generation within signed 64-bit range",
  );
}

expectFailure(
  mutate(
    validFiles,
    "terraform/deploy-staging.tf",
    "google_service_account.metrics_bridge_runtime.name",
    '"projects/${google_project.monitoring.project_id}/serviceAccounts/${google_project.monitoring.number}-compute@developer.gserviceaccount.com"',
  ),
  "Peg policy runtime act-as grants must not target the default Compute service account",
);

expectFailure(
  mutate(
    validFiles,
    "terraform/deploy-staging.tf",
    "google_service_account_iam_member.ci_default_compute_service_account_user",
    "google_service_account_iam_member.other_service_account_user",
  ),
  "Peg policy runtime act-as state move google_service_account_iam_member.ci_default_compute_service_account_user: must be declared exactly once",
);

expectFailure(
  mutate(
    validFiles,
    "terraform/peg-policy.tf",
    '  peg_policy_runtime_url = local.peg_policy_runtime_generation == null ? null : "https://storage.googleapis.com/download/storage/v1/b/${google_storage_bucket.peg_policy.name}/o/peg-policy%2Fcurrent.json?alt=media&generation=${local.peg_policy_runtime_generation}"',
    '  peg_policy_runtime_url = "https://invalid.example/policy.json"\n\n  decoy = local.peg_policy_runtime_generation == null ? null : "https://storage.googleapis.com/download/storage/v1/b/${google_storage_bucket.peg_policy.name}/o/peg-policy%2Fcurrent.json?alt=media&generation=${local.peg_policy_runtime_generation}"',
  ),
  "Peg policy runtime attachment: canonical URL: must be exactly source-controlled",
);

expectFailure(
  mutate(
    validFiles,
    "terraform/peg-policy.tf",
    `  peg_policy_runtime_env = local.peg_policy_runtime_generation == null ? {} : {
    PEG_POLICY_URL       = local.peg_policy_runtime_url
    PEG_POLICY_AUTH_MODE = "gcp-metadata"
  }`,
    `  peg_policy_runtime_env = {}

  decoy_env = local.peg_policy_runtime_generation == null ? {} : {
    PEG_POLICY_URL       = local.peg_policy_runtime_url
    PEG_POLICY_AUTH_MODE = "gcp-metadata"
  }`,
  ),
  "Peg policy runtime attachment: paired environment: must be exactly source-controlled",
);

expectFailure(
  {
    ...validFiles,
    "terraform/peg-policy-runtime-input.tf": `
variable "peg_policy_runtime_generation" {
  type = string
}
`,
  },
  "Peg policy runtime attachment: runtime generation must be a reviewed source literal, not an external variable",
);

expectFailure(
  mutate(
    validFiles,
    "terraform/metrics-bridge.tf",
    "      template[0].revision,\n",
    "",
  ),
  "Peg policy runtime attachment: must ignore template revision while generation is null",
);

expectFailure(
  mutate(
    withConcreteGeneration(validFiles, "1750000000000000"),
    "terraform/metrics-bridge.tf",
    "      client,",
    "      template[0].revision,\n      client,",
  ),
  "Peg policy runtime attachment: must not ignore template revision while applying a concrete generation",
);

process.stdout.write("Peg policy identity contract tests passed.\n");
