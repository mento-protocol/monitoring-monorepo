#!/usr/bin/env node
import assert from "node:assert/strict";
import { validFixtureFiles } from "./fixtures.mjs";
import { validateProductionInfraIdentityContract } from "./index.mjs";

function expectContractFailure(files, expectedMessage) {
  const errors = validateProductionInfraIdentityContract(files);
  assert(
    errors.some((error) => error.includes(expectedMessage)),
    `expected identity-contract failure containing "${expectedMessage}", got:\n${errors.join("\n")}`,
  );
}

function mutateFile(files, filePath, from, to) {
  assert(
    files[filePath].includes(from),
    `fixture mutation source missing: ${from}`,
  );
  return {
    ...files,
    [filePath]: files[filePath].replace(from, to),
  };
}

function mutateFileOccurrence(files, filePath, from, to, occurrence) {
  const contents = files[filePath];
  let index = -1;
  for (let count = 0; count <= occurrence; count += 1) {
    index = contents.indexOf(from, index + 1);
    assert(
      index >= 0,
      `fixture mutation occurrence ${occurrence} missing: ${from}`,
    );
  }
  return {
    ...files,
    [filePath]: `${contents.slice(0, index)}${to}${contents.slice(index + from.length)}`,
  };
}

const validFiles = validFixtureFiles();

for (const [filePath, from, to, expected] of [
  [
    "terraform/gcp-project.tf",
    '  service                    = "storage.googleapis.com"',
    '  service                    = "compute.googleapis.com"',
    "Peg policy Storage API: service must be exactly",
  ],
  [
    "terraform/gcp-project.tf",
    "  project                    = google_project.monitoring.project_id",
    "  project                    = var.gcp_project_id",
    "Peg policy Storage API: project must be exactly",
  ],
  [
    "terraform/gcp-project.tf",
    "  disable_on_destroy         = false",
    "  disable_on_destroy         = true",
    "Peg policy Storage API: disable_on_destroy must be exactly",
  ],
  [
    "terraform/gcp-project.tf",
    "  disable_dependent_services = false",
    "  disable_dependent_services = true",
    "Peg policy Storage API: disable_dependent_services must be exactly",
  ],
  [
    "terraform/gcp-project.tf",
    "  depends_on = [google_project_iam_member.terraform_owner]",
    "  depends_on = [google_project_service.iam]",
    "Peg policy Storage API: depends_on must contain only",
  ],
  [
    "terraform/peg-policy.tf",
    '  name                        = "${google_project.monitoring.project_id}-peg-policy"',
    '  name                        = "public-peg-policy"',
    "Peg policy bucket: name must be exactly",
  ],
  [
    "terraform/peg-policy.tf",
    "  project                     = google_project.monitoring.project_id",
    "  project                     = var.gcp_project_id",
    "Peg policy bucket: project must be exactly",
  ],
  [
    "terraform/peg-policy.tf",
    "  location                    = var.gcp_region",
    "  location                    = var.gcp_project_id",
    "Peg policy bucket: location must be exactly",
  ],
  [
    "terraform/peg-policy.tf",
    "  force_destroy               = false",
    "  force_destroy               = true",
    "Peg policy bucket: force_destroy must be exactly",
  ],
  [
    "terraform/peg-policy.tf",
    "  uniform_bucket_level_access = true",
    "  uniform_bucket_level_access = false",
    "Peg policy bucket: uniform_bucket_level_access must be exactly",
  ],
  [
    "terraform/peg-policy.tf",
    '  public_access_prevention    = "enforced"',
    '  public_access_prevention    = "inherited"',
    "Peg policy bucket: public_access_prevention must be exactly",
  ],
  [
    "terraform/peg-policy.tf",
    "    enabled = true",
    "    enabled = false",
    "Peg policy bucket: enabled must be exactly",
  ],
  [
    "terraform/peg-policy.tf",
    '      type = "Delete"',
    '      type = "SetStorageClass"',
    "Peg policy bucket: type must be exactly",
  ],
  [
    "terraform/peg-policy.tf",
    "      days_since_noncurrent_time = 30",
    "      days_since_noncurrent_time = 29",
    "Peg policy bucket: days_since_noncurrent_time must be exactly",
  ],
  [
    "terraform/peg-policy.tf",
    "      days_since_noncurrent_time = 30",
    "      age = 30",
    "Peg policy bucket: days_since_noncurrent_time must be exactly",
  ],
  [
    "terraform/peg-policy.tf",
    '      with_state                 = "ARCHIVED"',
    '      with_state                 = "ANY"',
    "Peg policy bucket: with_state must be exactly",
  ],
  [
    "terraform/peg-policy.tf",
    "    prevent_destroy = true",
    "    prevent_destroy = false",
    "Peg policy bucket: prevent_destroy must be exactly",
  ],
]) {
  expectContractFailure(mutateFile(validFiles, filePath, from, to), expected);
}

expectContractFailure(
  mutateFile(
    validFiles,
    "terraform/peg-policy.tf",
    `  depends_on = [
    google_project_service.storage,
    google_storage_bucket_iam_member.peg_policy_access_logs_writer,
  ]`,
    "  depends_on = [google_project_service.storage]",
  ),
  "Peg policy bucket: depends_on must contain exactly the Storage API and access-log writer",
);
expectContractFailure(
  mutateFile(
    validFiles,
    "terraform/peg-policy.tf",
    `  lifecycle {
    prevent_destroy = true
  }`,
    `  lifecycle_rule {
    action {
      type = "Delete"
    }
    condition {
      days_since_noncurrent_time = 30
      with_state                 = "ARCHIVED"
    }
  }

  lifecycle {
    prevent_destroy = true
  }`,
  ),
  "Peg policy bucket: must contain exactly one lifecycle rule",
);
expectContractFailure(
  mutateFile(
    validFiles,
    "terraform/peg-policy.tf",
    `  lifecycle_rule {
    action {
      type = "Delete"
    }
    condition {
      days_since_noncurrent_time = 30
      with_state                 = "ARCHIVED"
    }
  }

`,
    "",
  ),
  "Peg policy bucket: must contain exactly one lifecycle rule",
);

for (const [from, to, expected, occurrence = 0] of [
  [
    "    log_bucket        = google_storage_bucket.peg_policy_access_logs.name",
    "    log_bucket        = google_storage_bucket.unrelated.name",
    "Peg policy bucket: log_bucket must be exactly",
  ],
  [
    '    log_object_prefix = "peg-policy/"',
    '    log_object_prefix = "other/"',
    "Peg policy bucket: log_object_prefix must be exactly",
  ],
  [
    '  name                        = "${google_project.monitoring.project_id}-peg-policy-access-logs"',
    '  name                        = "public-access-logs"',
    "Peg policy access-log bucket: name must be exactly",
  ],
  [
    "  project                     = google_project.monitoring.project_id",
    "  project                     = var.gcp_project_id",
    "Peg policy access-log bucket: project must be exactly",
    1,
  ],
  [
    "  location                    = var.gcp_region",
    '  location                    = "US"',
    "Peg policy access-log bucket: location must be exactly",
    1,
  ],
  [
    "  force_destroy               = false",
    "  force_destroy               = true",
    "Peg policy access-log bucket: force_destroy must be exactly",
    1,
  ],
  [
    "  uniform_bucket_level_access = true",
    "  uniform_bucket_level_access = false",
    "Peg policy access-log bucket: uniform_bucket_level_access must be exactly",
    1,
  ],
  [
    '  public_access_prevention    = "enforced"',
    '  public_access_prevention    = "inherited"',
    "Peg policy access-log bucket: public_access_prevention must be exactly",
    1,
  ],
  [
    "      age        = 90",
    "      age        = 89",
    "Peg policy access-log bucket: must retain the LIVE and ARCHIVED retention rules",
  ],
  [
    '      with_state = "LIVE"',
    '      with_state = "ARCHIVED"',
    "Peg policy access-log bucket: must retain the LIVE and ARCHIVED retention rules",
  ],
  [
    "  bucket = google_storage_bucket.peg_policy_access_logs.name",
    "  bucket = google_storage_bucket.peg_policy.name",
    "Peg policy access-log writer: bucket must be exactly",
  ],
  [
    '  role   = "roles/storage.objectCreator"',
    '  role   = "roles/storage.objectAdmin"',
    "Peg policy access-log writer: role must be exactly",
  ],
  [
    '  member = "group:cloud-storage-analytics@google.com"',
    '  member = "group:eng@mentolabs.xyz"',
    "Peg policy access-log writer: member must be exactly",
  ],
]) {
  expectContractFailure(
    mutateFileOccurrence(
      validFiles,
      "terraform/peg-policy.tf",
      from,
      to,
      occurrence,
    ),
    expected,
  );
}
expectContractFailure(
  mutateFile(
    validFiles,
    "terraform/peg-policy.tf",
    "  depends_on = [google_project_service.storage]",
    "  depends_on = []",
  ),
  "Peg policy access-log bucket: depends_on must contain only the Storage API",
);
expectContractFailure(
  mutateFileOccurrence(
    validFiles,
    "terraform/peg-policy.tf",
    "    enabled = true",
    "    enabled = false",
    1,
  ),
  "Peg policy access-log bucket: enabled must be exactly",
);
expectContractFailure(
  mutateFileOccurrence(
    validFiles,
    "terraform/peg-policy.tf",
    '      type = "Delete"',
    '      type = "SetStorageClass"',
    1,
  ),
  "Peg policy access-log bucket: type must be exactly",
);
expectContractFailure(
  mutateFileOccurrence(
    validFiles,
    "terraform/peg-policy.tf",
    "    prevent_destroy = true",
    "    prevent_destroy = false",
    1,
  ),
  "Peg policy access-log bucket: prevent_destroy must be exactly",
);
expectContractFailure(
  mutateFileOccurrence(
    validFiles,
    "terraform/peg-policy.tf",
    "  lifecycle_rule {",
    "  # archived retention removed",
    2,
  ),
  "Peg policy access-log bucket: must contain exactly two lifecycle rules",
);
expectContractFailure(
  mutateFileOccurrence(
    validFiles,
    "terraform/peg-policy.tf",
    "      days_since_noncurrent_time = 30",
    "      days_since_noncurrent_time = 29",
    1,
  ),
  "Peg policy access-log bucket: must retain the LIVE and ARCHIVED retention rules",
);
expectContractFailure(
  mutateFile(
    validFiles,
    "terraform/peg-policy.tf",
    "# trunk-ignore(checkov/CKV_GCP_62): a bucket cannot write access logs to itself.",
    "# checkov exception removed",
  ),
  "Peg policy access-log bucket: must keep the scoped self-logging Checkov exception",
);
expectContractFailure(
  mutateFile(
    validFiles,
    "terraform/peg-policy.tf",
    'resource "google_storage_bucket" "peg_policy" {',
    '#checkov:skip=CKV_GCP_62: invalid second exception\nresource "google_storage_bucket" "peg_policy" {',
  ),
  "Peg policy access-log bucket: must keep the scoped self-logging Checkov exception",
);

for (const [occurrence, replacement, expected] of [
  [
    0,
    "  project      = var.gcp_project_id",
    "Peg policy metrics_bridge_runtime identity: project must be exactly",
  ],
  [
    1,
    "  project      = var.gcp_project_id",
    "Peg policy peg_policy_publisher identity: project must be exactly",
  ],
]) {
  expectContractFailure(
    mutateFileOccurrence(
      validFiles,
      "terraform/peg-policy.tf",
      "  project      = google_project.monitoring.project_id",
      replacement,
      occurrence,
    ),
    expected,
  );
}
for (const [from, to, expected] of [
  [
    '  account_id   = "metrics-bridge-runtime"',
    '  account_id   = "metrics-bridge-runtime-writer"',
    "Peg policy metrics_bridge_runtime identity: account_id must be exactly",
  ],
  [
    '  account_id   = "peg-policy-publisher"',
    '  account_id   = "peg-policy-publisher-writer"',
    "Peg policy peg_policy_publisher identity: account_id must be exactly",
  ],
]) {
  expectContractFailure(
    mutateFile(validFiles, "terraform/peg-policy.tf", from, to),
    expected,
  );
}
for (const [occurrence, expected] of [
  [
    0,
    "Peg policy metrics_bridge_runtime identity: depends_on must contain only",
  ],
  [1, "Peg policy peg_policy_publisher identity: depends_on must contain only"],
]) {
  expectContractFailure(
    mutateFileOccurrence(
      validFiles,
      "terraform/peg-policy.tf",
      "  depends_on = [google_project_service.iam]",
      "  depends_on = [google_project_service.storage]",
      occurrence,
    ),
    expected,
  );
}

for (const [from, to, expected] of [
  [
    "  service_account_id = google_service_account.peg_policy_publisher.name",
    "  service_account_id = google_service_account.metrics_bridge_runtime.name",
    "Peg policy publisher Token Creator: service_account_id must be exactly",
  ],
  [
    '  role               = "roles/iam.serviceAccountTokenCreator"',
    '  role               = "roles/iam.serviceAccountUser"',
    "Peg policy publisher Token Creator: role must be exactly",
  ],
  [
    '  member             = "serviceAccount:${google_service_account.production_infra_applier.email}"',
    '  member             = "serviceAccount:${google_service_account.metrics_bridge_deployer.email}"',
    "Peg policy publisher Token Creator: member must be exactly",
  ],
  [
    '  role   = "roles/storage.objectViewer"',
    '  role   = "roles/storage.objectAdmin"',
    "metrics_bridge_runtime_peg_policy_object_viewer bucket grant: role must be exactly",
  ],
  [
    '  role   = "roles/storage.objectAdmin"',
    '  role   = "roles/storage.objectViewer"',
    "peg_policy_publisher_object_admin bucket grant: role must be exactly",
  ],
]) {
  expectContractFailure(
    mutateFile(validFiles, "terraform/peg-policy.tf", from, to),
    expected,
  );
}

expectContractFailure(
  mutateFile(
    validFiles,
    "terraform/peg-policy.tf",
    "  bucket = google_storage_bucket.peg_policy.name",
    "  bucket = google_storage_bucket.unrelated.name",
  ),
  "metrics_bridge_runtime_peg_policy_object_viewer bucket grant: bucket must be exactly",
);
expectContractFailure(
  mutateFileOccurrence(
    validFiles,
    "terraform/peg-policy.tf",
    "  bucket = google_storage_bucket.peg_policy.name",
    "  bucket = google_storage_bucket.unrelated.name",
    1,
  ),
  "peg_policy_publisher_object_admin bucket grant: bucket must be exactly",
);
expectContractFailure(
  mutateFile(
    validFiles,
    "terraform/peg-policy.tf",
    '  member = "serviceAccount:${google_service_account.metrics_bridge_runtime.email}"',
    '  member = "serviceAccount:${google_service_account.peg_policy_publisher.email}"',
  ),
  "metrics_bridge_runtime_peg_policy_object_viewer bucket grant: member must be exactly",
);
expectContractFailure(
  mutateFile(
    validFiles,
    "terraform/peg-policy.tf",
    '  member = "serviceAccount:${google_service_account.peg_policy_publisher.email}"',
    '  member = "serviceAccount:${google_service_account.metrics_bridge_runtime.email}"',
  ),
  "peg_policy_publisher_object_admin bucket grant: member must be exactly",
);

expectContractFailure(
  {
    ...validFiles,
    "terraform/peg-policy-extra.tf": `
resource "google_project_iam_member" "production_applier_fourth_grant" {
  project = google_project.monitoring.project_id
  role    = "roles/storage.admin"
  member  = "serviceAccount:\${google_service_account.production_infra_applier.email}"
}
`,
  },
  "production applier: unexpected IAM grants",
);
expectContractFailure(
  {
    ...validFiles,
    "terraform/peg-policy-extra-runtime.tf": `
resource "google_project_iam_member" "runtime_extra_grant" {
  project = google_project.monitoring.project_id
  role    = "roles/storage.admin"
  member  = "serviceAccount:\${google_service_account.metrics_bridge_runtime.email}"
}
`,
  },
  "Peg policy runtime identity: unexpected IAM grants",
);
expectContractFailure(
  {
    ...validFiles,
    "terraform/peg-policy-runtime-attachment.tf": `
resource "google_cloud_run_v2_service" "forbidden_peg_runtime" {
  name     = "forbidden-peg-runtime"
  location = var.gcp_region

  template {
    service_account = google_service_account.metrics_bridge_runtime.email
  }
}
`,
  },
  "Peg policy runtime identity: identity references are allowed only",
);
expectContractFailure(
  {
    ...validFiles,
    "terraform/peg-policy-extra-publisher.tf": `
resource "google_project_iam_member" "publisher_extra_grant" {
  project = google_project.monitoring.project_id
  role    = "roles/storage.admin"
  member  = "serviceAccount:\${google_service_account.peg_policy_publisher.email}"
}
`,
  },
  "Peg policy publisher identity: unexpected IAM grants",
);
