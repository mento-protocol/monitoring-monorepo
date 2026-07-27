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

function mutateFile(files, from, to) {
  const filePath = "terraform/peg-policy.tf";
  assert(
    files[filePath].includes(from),
    `fixture mutation source missing: ${from}`,
  );
  return {
    ...files,
    [filePath]: files[filePath].replace(from, to),
  };
}

function mutateOccurrence(files, from, to, occurrence) {
  const filePath = "terraform/peg-policy.tf";
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
assert.deepEqual(validateProductionInfraIdentityContract(validFiles), []);

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
    "  policy_data = data.google_iam_policy.peg_policy.policy_data",
    "  policy_data = data.google_iam_policy.peg_policy_access_logs.policy_data",
    "Peg policy peg_policy authoritative IAM policy: policy_data must be exactly",
  ],
  [
    "  depends_on = [google_storage_bucket_iam_policy.peg_policy_access_logs]",
    "  depends_on = []",
    "Peg policy peg_policy authoritative IAM policy: depends_on must contain exactly the authoritative prerequisites",
  ],
  [
    "    google_storage_bucket_iam_policy.peg_policy_access_logs,",
    "    google_project_service.storage,",
    "Peg policy bucket: depends_on must contain exactly the Storage API and authoritative access-log policy",
  ],
]) {
  expectContractFailure(mutateFile(validFiles, from, to), expected);
}

expectContractFailure(
  mutateOccurrence(
    validFiles,
    "    prevent_destroy = true",
    "    prevent_destroy = false",
    2,
  ),
  "Peg policy peg_policy_access_logs authoritative IAM policy: prevent_destroy must be exactly",
);
expectContractFailure(
  mutateOccurrence(
    validFiles,
    "    prevent_destroy = true",
    "    prevent_destroy = false",
    3,
  ),
  "Peg policy peg_policy authoritative IAM policy: prevent_destroy must be exactly",
);

for (const [from, to, expected, occurrence] of [
  [
    '    role = "roles/storage.objectCreator"',
    '    role = "roles/storage.objectAdmin"',
    'Peg policy peg_policy_access_logs authoritative IAM policy: must contain exactly one "roles/storage.objectCreator" binding',
    0,
  ],
  [
    '    role = "roles/storage.objectViewer"',
    '    role = "roles/storage.objectAdmin"',
    'Peg policy peg_policy authoritative IAM policy: must contain exactly one "roles/storage.objectViewer" binding',
    0,
  ],
  [
    '      "serviceAccount:${var.terraform_service_account}",',
    '      "serviceAccount:${var.terraform_service_account}",\n      "group:eng@mentolabs.xyz",',
    "Peg policy peg_policy_access_logs authoritative IAM policy: google_project_iam_custom_role.peg_policy_bucket_controller.name members must contain only",
    0,
  ],
  [
    '      "serviceAccount:${var.terraform_service_account}",',
    '      "serviceAccount:${var.terraform_service_account}",\n      "group:eng@mentolabs.xyz",',
    "Peg policy peg_policy authoritative IAM policy: google_project_iam_custom_role.peg_policy_bucket_controller.name members must contain only",
    1,
  ],
]) {
  expectContractFailure(
    mutateOccurrence(validFiles, from, to, occurrence),
    expected,
  );
}

expectContractFailure(
  mutateFile(
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
  {
    ...validFiles,
    "terraform/peg-policy-legacy-member.tf": `
resource "google_storage_bucket_iam_member" "peg_policy_legacy_reader" {
  bucket = google_storage_bucket.peg_policy.name
  role   = "roles/storage.objectViewer"
  member = "group:eng@mentolabs.xyz"
}
`,
  },
  "Peg buckets must use only authoritative IAM policies, not member or binding resources",
);
expectContractFailure(
  {
    ...validFiles,
    "terraform/peg-policy-legacy-binding.tf": `
resource "google_storage_bucket_iam_binding" "peg_policy_access_logs_legacy_writer" {
  bucket  = google_storage_bucket.peg_policy_access_logs.name
  role    = "roles/storage.objectCreator"
  members = ["group:eng@mentolabs.xyz"]
}
`,
  },
  "Peg buckets must use only authoritative IAM policies, not member or binding resources",
);
expectContractFailure(
  {
    ...validFiles,
    "terraform/peg-policy-controller-escape.tf": `
resource "google_project_iam_member" "peg_policy_bucket_controller_escape" {
  project = google_project.monitoring.project_id
  role    = google_project_iam_custom_role.peg_policy_bucket_controller.name
  member  = "serviceAccount:\${var.terraform_service_account}"
}
`,
  },
  "Peg policy bucket controller role may appear only in the two authoritative policy documents",
);

console.log(
  "production infrastructure Peg policy authoritative IAM tests passed",
);
