#!/usr/bin/env node
import assert from "node:assert/strict";
import { validFixtureFiles } from "./production-infra-identity-contract-fixtures.mjs";
import { validateProductionInfraIdentityContract } from "./production-infra-identity-contract.mjs";

function expectFailure(files, expectedMessage) {
  const errors = validateProductionInfraIdentityContract(files);
  assert(
    errors.some((error) => error.includes(expectedMessage)),
    `expected failure containing "${expectedMessage}", got:\n${errors.join("\n")}`,
  );
}

function withTerraformFile(filePath, contents) {
  return {
    ...validFixtureFiles(),
    [filePath]: contents,
  };
}

function mutateCiWif(from, to) {
  const files = validFixtureFiles();
  assert(files["terraform/ci-wif.tf"].includes(from));
  files["terraform/ci-wif.tf"] = files["terraform/ci-wif.tf"].replace(from, to);
  return files;
}

expectFailure(
  withTerraformFile(
    "terraform/extra.tf",
    `locals {
  hidden = "\${format("#%s", google_service_account.production_infra_applier.email)}"
}
`,
  ),
  "production applier: identity references are allowed only",
);

expectFailure(
  withTerraformFile(
    "terraform/extra.tf",
    `locals {
  parser_depth = "\${format("{", 1)}"
}
resource "google_iam_workload_identity_pool_provider" "template_bypass" {
  workload_identity_pool_id = "github-actions"
}`,
  ),
  "workload identity provider inventory must contain exactly",
);

expectFailure(
  withTerraformFile(
    "terraform/extra.tf",
    `locals {
  nested = {
}`,
  ),
  "unterminated top-level locals block",
);

expectFailure(
  withTerraformFile(
    "terraform/extra.tf",
    `locals {
  hidden = google_service_account /* separator */ .
    production_infra_applier . email
}
`,
  ),
  "production applier: identity references are allowed only",
);

expectFailure(
  withTerraformFile(
    "terraform/extra.tf",
    String.raw`resource "google_project_iam_member" "escaped_identity_grant" {
  project = google_project.monitoring.project_id
  role    = "roles/storage.admin"
  member  = "serviceAccount:production-infra-\u0061pplier@mento-terraform-seed-ffac.iam.gserviceaccount.com"
}
`,
  ),
  "production applier: identity references are allowed only",
);

const legacyHeader =
  'resource "google_service_account_iam_member" "ci_alerts_org_terraform_token_creator" {';
for (const metaArgument of ["count = 0", "for_each = {}"]) {
  expectFailure(
    mutateCiWif(legacyHeader, `${legacyHeader}\n  ${metaArgument}`),
    "bootstrap legacy deployer token creator: resource multiplicity is forbidden",
  );
}

const productionWifHeader =
  'resource "google_service_account_iam_member" "production_infra_applier_wif_binding" {';
expectFailure(
  mutateCiWif(productionWifHeader, `${productionWifHeader}\n  for_each = {}`),
  "production applier WIF binding: resource multiplicity is forbidden",
);

expectFailure(
  withTerraformFile(
    "terraform/extra.tf",
    `\uFEFFresource "google_iam_workload_identity_pool_provider" "bom_bypass" {
  workload_identity_pool_id = "github-actions"
}
`,
  ),
  "workload identity provider inventory must contain exactly",
);

expectFailure(
  withTerraformFile(
    "terraform/extra.tf.json",
    JSON.stringify({
      resource: {
        google_iam_workload_identity_pool_provider: {
          json_bypass: {
            workload_identity_pool_id: "github-actions",
          },
        },
      },
    }),
  ),
  "Terraform JSON configuration is forbidden",
);

console.log("production infrastructure identity security tests passed");
