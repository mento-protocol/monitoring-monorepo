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
    "terraform/variables.tf",
    "  type        = string",
    "  type        = number",
    "Peg policy project ID: type must be exactly",
  ],
  [
    "terraform/variables.tf",
    '  default     = "mento-monitoring-peg-policy"',
    '  default     = "mento-monitoring"',
    "Peg policy project ID: default must be exactly",
  ],
  [
    "terraform/peg-policy.tf",
    '  name            = "Mento Peg Policy"',
    '  name            = "Mento Monitoring"',
    "isolated Peg policy project: name must be exactly",
  ],
  [
    "terraform/peg-policy.tf",
    "  project_id      = var.gcp_peg_policy_project_id",
    "  project_id      = var.gcp_project_id",
    "isolated Peg policy project: project_id must be exactly",
  ],
  [
    "terraform/peg-policy.tf",
    "  org_id          = var.gcp_org_id",
    '  org_id          = "123456789"',
    "isolated Peg policy project: org_id must be exactly",
  ],
  [
    "terraform/peg-policy.tf",
    "  billing_account = var.gcp_billing_account",
    '  billing_account = "000000-000000-000000"',
    "isolated Peg policy project: billing_account must be exactly",
  ],
  [
    "terraform/peg-policy.tf",
    "  auto_create_network = false",
    "  auto_create_network = true",
    "isolated Peg policy project: auto_create_network must be exactly",
  ],
  [
    "terraform/peg-policy.tf",
    "  project = google_project.peg_policy.project_id",
    "  project = google_project.monitoring.project_id",
    "Peg policy Terraform owner bootstrap: project must be exactly",
  ],
  [
    "terraform/peg-policy.tf",
    '  role    = "roles/owner"',
    '  role    = "roles/editor"',
    "Peg policy Terraform owner bootstrap: role must be exactly",
  ],
  [
    "terraform/peg-policy.tf",
    '  member  = "serviceAccount:${var.terraform_service_account}"',
    '  member  = "serviceAccount:${google_service_account.metrics_bridge_deployer.email}"',
    "Peg policy Terraform owner bootstrap: member must be exactly",
  ],
  [
    "terraform/peg-policy.tf",
    "  name                        = google_project.peg_policy.project_id",
    '  name                        = "public-peg-policy"',
    "Peg policy bucket: name must be exactly",
  ],
  [
    "terraform/peg-policy.tf",
    "  project                     = google_project.peg_policy.project_id",
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
]) {
  expectContractFailure(mutateFile(validFiles, filePath, from, to), expected);
}

expectContractFailure(
  mutateFileOccurrence(
    validFiles,
    "terraform/peg-policy.tf",
    "    prevent_destroy = true",
    "    prevent_destroy = false",
    0,
  ),
  "isolated Peg policy project: prevent_destroy must be exactly",
);
expectContractFailure(
  mutateFileOccurrence(
    validFiles,
    "terraform/peg-policy.tf",
    "    prevent_destroy = true",
    "    prevent_destroy = false",
    1,
  ),
  "Peg policy bucket: prevent_destroy must be exactly",
);

for (const [name, service, replacement] of [
  ["peg_policy_storage", "storage.googleapis.com", "compute.googleapis.com"],
  ["peg_policy_iam", "iam.googleapis.com", "run.googleapis.com"],
]) {
  const blockHeader = `resource "google_project_service" "${name}" {`;
  const source = validFiles["terraform/peg-policy.tf"];
  const blockStart = source.indexOf(blockHeader);
  const blockEnd = source.indexOf("\n}", blockStart) + 2;
  assert(blockStart >= 0 && blockEnd > blockStart, `${name} fixture missing`);
  const block = source.slice(blockStart, blockEnd);
  expectContractFailure(
    mutateFile(
      validFiles,
      "terraform/peg-policy.tf",
      block,
      block.replace(
        `  service                    = "${service}"`,
        `  service                    = "${replacement}"`,
      ),
    ),
    `Peg policy ${name} API: service must be exactly`,
  );
  expectContractFailure(
    mutateFile(
      validFiles,
      "terraform/peg-policy.tf",
      block,
      block.replace(
        "  project                    = google_project.peg_policy.project_id",
        "  project                    = google_project.monitoring.project_id",
      ),
    ),
    `Peg policy ${name} API: project must be exactly`,
  );
  expectContractFailure(
    mutateFile(
      validFiles,
      "terraform/peg-policy.tf",
      block,
      block.replace(
        "  disable_on_destroy         = false",
        "  disable_on_destroy         = true",
      ),
    ),
    `Peg policy ${name} API: disable_on_destroy must be exactly`,
  );
  expectContractFailure(
    mutateFile(
      validFiles,
      "terraform/peg-policy.tf",
      block,
      block.replace(
        "  disable_dependent_services = false",
        "  disable_dependent_services = true",
      ),
    ),
    `Peg policy ${name} API: disable_dependent_services must be exactly`,
  );
  expectContractFailure(
    mutateFile(
      validFiles,
      "terraform/peg-policy.tf",
      block,
      block.replace(
        "  depends_on = [google_project_iam_member.peg_policy_terraform_owner]",
        "  depends_on = []",
      ),
    ),
    `Peg policy ${name} API: depends_on must contain only`,
  );
}

expectContractFailure(
  {
    ...validFiles,
    "terraform/peg-policy-extra-api.tf": `
resource "google_project_service" "peg_policy_compute" {
  project                    = google_project.peg_policy.project_id
  service                    = "compute.googleapis.com"
  disable_on_destroy         = false
  disable_dependent_services = false
}
`,
  },
  "isolated Peg policy project may enable only Storage and IAM",
);

for (const [name, member] of [
  [
    "routine_deployer",
    "serviceAccount:${google_service_account.metrics_bridge_deployer.email}",
  ],
  [
    "pr_plan",
    "serviceAccount:${google_service_account.metrics_bridge_plan_readonly.email}",
  ],
  [
    "trusted_refresh",
    "serviceAccount:${google_service_account.org_terraform_refresh_readonly.email}",
  ],
  ["developer", "group:eng@mentolabs.xyz"],
]) {
  expectContractFailure(
    {
      ...validFiles,
      [`terraform/peg-policy-${name}.tf`]: `
resource "google_project_iam_member" "peg_policy_${name}" {
  project = google_project.peg_policy.project_id
  role    = "roles/storage.objectViewer"
  member  = "${member}"
}
`,
    },
    "isolated Peg policy project references are restricted to the source foundation",
  );
}

expectContractFailure(
  {
    ...validFiles,
    "terraform/peg-policy-hard-coded-project-grant.tf": `
resource "google_project_iam_member" "peg_policy_hard_coded_grant" {
  project = "mento-monitoring-peg-policy"
  role    = "roles/storage.objectAdmin"
  member  = "group:eng@mentolabs.xyz"
}
`,
  },
  "isolated Peg policy project references are restricted to the source foundation",
);

expectContractFailure(
  {
    ...validFiles,
    "terraform/peg-policy-derived-project.tf": `
locals {
  forbidden_peg_policy_project = google_project.peg_policy.project_id
}
`,
  },
  "isolated Peg policy project references are restricted to the source foundation",
);

expectContractFailure(
  mutateFile(
    validFiles,
    "terraform/peg-policy.tf",
    `  depends_on = [
    google_project_service.peg_policy_storage,
    google_storage_bucket_iam_policy.peg_policy_access_logs,
  ]`,
    "  depends_on = [google_project_service.peg_policy_storage]",
  ),
  "Peg policy bucket: depends_on must contain exactly the Storage API and authoritative access-log policy",
);
expectContractFailure(
  mutateFileOccurrence(
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
    1,
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
    '  name                        = "${google_project.peg_policy.project_id}-access-logs"',
    '  name                        = "public-access-logs"',
    "Peg policy access-log bucket: name must be exactly",
  ],
  [
    "  project                     = google_project.peg_policy.project_id",
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
    "  depends_on = [google_project_service.peg_policy_storage]",
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
    2,
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

expectContractFailure(
  mutateFile(
    validFiles,
    "terraform/peg-policy.tf",
    "  project      = google_project.monitoring.project_id",
    "  project      = google_project.peg_policy.project_id",
  ),
  "Peg policy metrics_bridge_runtime identity: project must be exactly",
);
expectContractFailure(
  mutateFile(
    validFiles,
    "terraform/peg-policy.tf",
    "  project      = google_project.peg_policy.project_id",
    "  project      = google_project.monitoring.project_id",
  ),
  "Peg policy peg_policy_publisher identity: project must be exactly",
);
for (const [from, to, expected] of [
  [
    "  project     = google_project.peg_policy.project_id",
    "  project     = google_project.monitoring.project_id",
    "Peg policy bucket controller role: project must be exactly",
  ],
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
expectContractFailure(
  mutateFile(
    validFiles,
    "terraform/peg-policy.tf",
    "  depends_on = [google_project_service.iam]",
    "  depends_on = [google_project_service.storage]",
  ),
  "Peg policy metrics_bridge_runtime identity: depends_on must contain only",
);
expectContractFailure(
  mutateFileOccurrence(
    validFiles,
    "terraform/peg-policy.tf",
    "  depends_on = [google_project_service.peg_policy_iam]",
    "  depends_on = [google_project_service.peg_policy_storage]",
    1,
  ),
  "Peg policy peg_policy_publisher identity: depends_on must contain only",
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

function mutatePegPolicy(files, from, to) {
  return mutateFile(files, "terraform/peg-policy.tf", from, to);
}

function mutatePegPolicyOccurrence(files, from, to, occurrence) {
  return mutateFileOccurrence(
    files,
    "terraform/peg-policy.tf",
    from,
    to,
    occurrence,
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
]) {
  expectContractFailure(mutatePegPolicy(validFiles, from, to), expected);
}

for (const [from, to, expected] of [
  [
    '  role_id     = "pegPolicyBucketController"',
    '  role_id     = "pegPolicyBucketAdministrator"',
    "Peg policy bucket controller role: role_id must be exactly",
  ],
  [
    '    "storage.buckets.update",',
    '    "storage.objects.delete",',
    "Peg policy bucket controller role: permissions must contain only",
  ],
  [
    '    "storage.buckets.get",\n',
    "",
    "Peg policy bucket controller role: permissions must contain only",
  ],
  [
    "  depends_on = [google_project_service.peg_policy_iam]",
    "  depends_on = [google_project_service.peg_policy_storage]",
    "Peg policy bucket controller role: depends_on must contain only the IAM API",
  ],
  [
    "  policy_data = data.google_iam_policy.peg_policy.policy_data",
    "  policy_data = data.google_iam_policy.peg_policy_access_logs.policy_data",
    "Peg policy peg_policy authoritative IAM policy: policy_data must be exactly",
  ],
  [
    "  depends_on = [google_storage_bucket_iam_policy.peg_policy_access_logs]",
    "  depends_on = []",
    "Peg policy peg_policy authoritative IAM policy: depends_on must contain exactly the authoritative prerequisites",
  ],
]) {
  expectContractFailure(mutatePegPolicy(validFiles, from, to), expected);
}

for (const [occurrence, expected] of [
  [
    3,
    "Peg policy peg_policy_access_logs authoritative IAM policy: prevent_destroy must be exactly",
  ],
  [
    4,
    "Peg policy peg_policy authoritative IAM policy: prevent_destroy must be exactly",
  ],
]) {
  expectContractFailure(
    mutatePegPolicyOccurrence(
      validFiles,
      "    prevent_destroy = true",
      "    prevent_destroy = false",
      occurrence,
    ),
    expected,
  );
}

for (const [from, to, expected, occurrence] of [
  [
    '    role = "roles/storage.objectCreator"',
    '    role = "roles/storage.objectAdmin"',
    'Peg policy peg_policy_access_logs authoritative IAM policy: must contain exactly one "roles/storage.objectCreator" binding',
    0,
  ],
  [
    '    role = "roles/storage.objectViewer"',
    '    role = "roles/storage.admin"',
    'Peg policy peg_policy authoritative IAM policy: must contain exactly one "roles/storage.objectViewer" binding',
    0,
  ],
  [
    '      "serviceAccount:${google_service_account.metrics_bridge_runtime.email}",',
    '      "serviceAccount:${google_service_account.peg_policy_publisher.email}",',
    'Peg policy peg_policy authoritative IAM policy: "roles/storage.objectViewer" members must contain only',
    0,
  ],
  [
    '      "serviceAccount:${google_service_account.peg_policy_publisher.email}",',
    '      "serviceAccount:${google_service_account.metrics_bridge_runtime.email}",',
    'Peg policy peg_policy authoritative IAM policy: "roles/storage.objectAdmin" members must contain only',
    0,
  ],
  [
    '      "group:cloud-storage-analytics@google.com",',
    '      "group:eng@mentolabs.xyz",',
    'Peg policy peg_policy_access_logs authoritative IAM policy: "roles/storage.objectCreator" members must contain only',
    0,
  ],
]) {
  expectContractFailure(
    mutatePegPolicyOccurrence(validFiles, from, to, occurrence),
    expected,
  );
}

expectContractFailure(
  mutatePegPolicy(
    validFiles,
    `  binding {
    role = "roles/storage.objectAdmin"
    members = [
      "serviceAccount:\${google_service_account.peg_policy_publisher.email}",
    ]
  }
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
  }
}`,
  ),
  "Peg policy peg_policy authoritative IAM policy: must contain exactly 3 bindings",
);
expectContractFailure(
  mutatePegPolicy(
    validFiles,
    `  binding {
    role = "roles/storage.objectViewer"
    members = [
      "serviceAccount:\${google_service_account.metrics_bridge_runtime.email}",
    ]
  }

`,
    "",
  ),
  "Peg policy peg_policy authoritative IAM policy: must contain exactly 3 bindings",
);
expectContractFailure(
  mutatePegPolicy(
    validFiles,
    `  binding {
    role = "roles/storage.objectCreator"
    members = [
      "group:cloud-storage-analytics@google.com",
    ]
  }
}`,
    "}",
  ),
  "Peg policy peg_policy_access_logs authoritative IAM policy: must contain exactly 2 bindings",
);

for (const [filePath, contents] of [
  [
    "terraform/peg-policy-legacy-member.tf",
    `
resource "google_storage_bucket_iam_member" "peg_policy_legacy_reader" {
  bucket = google_storage_bucket.peg_policy.name
  role   = "roles/storage.objectViewer"
  member = "group:eng@mentolabs.xyz"
}
`,
  ],
  [
    "terraform/peg-policy-legacy-binding.tf",
    `
resource "google_storage_bucket_iam_binding" "peg_policy_access_logs_legacy_writer" {
  bucket  = google_storage_bucket.peg_policy_access_logs.name
  role    = "roles/storage.objectCreator"
  members = ["group:eng@mentolabs.xyz"]
}
`,
  ],
  [
    "terraform/peg-policy-hard-coded-member.tf",
    `
resource "google_storage_bucket_iam_member" "peg_policy_derived_legacy_reader" {
  bucket = "mento-monitoring-peg-policy"
  role   = "roles/storage.objectViewer"
  member = "group:eng@mentolabs.xyz"
}
`,
  ],
]) {
  expectContractFailure(
    { ...validFiles, [filePath]: contents },
    "Peg buckets must use only authoritative IAM policies, not member or binding resources",
  );
}
