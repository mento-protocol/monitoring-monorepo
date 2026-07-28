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
    '  role_id     = "pegPolicyBucketController"',
    '  role_id     = "pegPolicyBucketAdmin"',
    "Peg policy bucket controller role: role_id must be exactly",
  ],
  [
    "  project     = google_project.monitoring.project_id",
    "  project     = var.gcp_project_id",
    "Peg policy bucket controller role: project must be exactly",
  ],
  [
    '  title       = "Peg Policy Bucket Controller"',
    '  title       = "Peg Policy Bucket Admin"',
    "Peg policy bucket controller role: title must be exactly",
  ],
  [
    '    "storage.buckets.update",',
    '    "storage.buckets.delete",',
    "Peg policy bucket controller role: permissions must contain only",
  ],
  [
    "  depends_on = [google_project_service.iam]",
    "  depends_on = [google_project_service.storage]",
    "Peg policy bucket controller role: depends_on must contain only",
    2,
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
  "Peg policy peg_policy authoritative IAM policy: must contain exactly 3 bindings",
);

expectFailure(
  mutate(
    validFiles,
    "terraform/peg-policy.tf",
    '      "serviceAccount:${google_service_account.peg_policy_publication_reader.email}",',
    '      "serviceAccount:org-terraform-refresh-readonly@mento-terraform-seed-ffac.iam.gserviceaccount.com",',
  ),
  'Peg policy peg_policy authoritative IAM policy: "roles/storage.objectViewer" members must contain only',
);

expectFailure(
  mutate(
    validFiles,
    "terraform/peg-policy.tf",
    '      "serviceAccount:${var.terraform_service_account}",',
    '      "serviceAccount:other@mento-monitoring.iam.gserviceaccount.com",',
  ),
  "Peg policy peg_policy_access_logs authoritative IAM policy: google_project_iam_custom_role.peg_policy_bucket_controller.name members must contain only",
);

expectFailure(
  mutate(
    validFiles,
    "terraform/peg-policy.tf",
    '      "serviceAccount:${var.terraform_service_account}",',
    '      "serviceAccount:other@mento-monitoring.iam.gserviceaccount.com",',
    1,
  ),
  "Peg policy peg_policy authoritative IAM policy: google_project_iam_custom_role.peg_policy_bucket_controller.name members must contain only",
);

expectFailure(
  {
    ...validFiles,
    "terraform/peg-policy-controller-extra.tf": `
resource "google_project_iam_member" "peg_policy_controller_extra" {
  project = google_project.monitoring.project_id
  role    = google_project_iam_custom_role.peg_policy_bucket_controller.name
  member  = "serviceAccount:other@mento-monitoring.iam.gserviceaccount.com"
}
`,
  },
  "Peg policy bucket controller role may be used only by the authoritative bucket policies",
);

expectFailure(
  mutate(
    validFiles,
    "terraform/ci-wif.tf",
    "attribute.workflow_ref/mento-protocol/monitoring-monorepo/.github/workflows/peg-policy-publication.yml@refs/heads/main",
    "attribute.ref/refs/heads/main",
  ),
  "Peg policy publication plan WIF binding: member must be exactly",
);

expectFailure(
  mutate(
    validFiles,
    "terraform/ci-wif.tf",
    '    "mento-protocol/monitoring-monorepo/.github/workflows/terraform-drift.yml@refs/heads/main",',
    `    "mento-protocol/monitoring-monorepo/.github/workflows/terraform-drift.yml@refs/heads/main",
    "mento-protocol/monitoring-monorepo/.github/workflows/peg-policy-publication.yml@refs/heads/main",`,
  ),
  "terraform_refresh_workflow_refs must contain only the regular refresh and drift workflows",
);

expectFailure(
  mutate(
    validFiles,
    "terraform/ci-wif.tf",
    "attribute.workflow_ref/${each.value}",
    "attribute.ref/refs/heads/main",
  ),
  "terraform: refresh WIF binding: member must be exactly",
);

expectFailure(
  mutate(
    validFiles,
    "terraform/ci-wif.tf",
    "serviceAccount:${google_service_account.peg_policy_publication_reader.email}",
    "serviceAccount:org-terraform-refresh-readonly@mento-terraform-seed-ffac.iam.gserviceaccount.com",
    0,
  ),
  "Peg policy publication reader state grant: member must be exactly",
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

process.stdout.write("Peg policy identity contract tests passed.\n");
