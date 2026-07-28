#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  pegPolicyMd5HexToBase64,
  readPegPolicyPublication,
  validatePegPolicyPublication,
} from "./check-peg-policy-publication.mjs";

const validFiles = readPegPolicyPublication();
assert.doesNotThrow(() => validatePegPolicyPublication(validFiles));

const emptyMd5Hex = "d41d8cd98f00b204e9800998ecf8427e";
const emptyMd5Base64 = "1B2M2Y8AsgTpgAmY7PhCfg==";
assert.equal(pegPolicyMd5HexToBase64(emptyMd5Hex), emptyMd5Base64);
assert.equal(
  Buffer.from(pegPolicyMd5HexToBase64(emptyMd5Hex), "base64").toString("hex"),
  emptyMd5Hex,
);

const policySource = readFileSync(
  new URL("../alerts/rules/peg-thresholds.json", import.meta.url),
);
const policySourceMd5Hex = createHash("md5").update(policySource).digest("hex");
assert.equal(
  pegPolicyMd5HexToBase64(policySourceMd5Hex),
  createHash("md5").update(policySource).digest("base64"),
);

function withMutation(file, replacement, expectedError) {
  const files = { ...validFiles, [file]: replacement(validFiles[file]) };
  assert.throws(() => validatePegPolicyPublication(files), expectedError);
}

withMutation(
  "versions.tf",
  (value) =>
    value.replace(
      'required_version = ">= 1.11"',
      'required_version = ">= 1.12"',
    ),
  /Terraform version: required_version must be exactly/u,
);
withMutation(
  "versions.tf",
  (value) =>
    value.replace('source  = "hashicorp/google"', 'source  = "wrong/google"'),
  /Google provider requirement must be exactly/u,
);
withMutation(
  "versions.tf",
  (value) => value.replace('version = "~> 6.50.0"', 'version = "~> 7.0.0"'),
  /Google provider requirement must be exactly/u,
);
withMutation(
  "versions.tf",
  (value) =>
    value.replace(
      'source  = "hashicorp/google"',
      'source  = "wrong/google" # source = "hashicorp/google"',
    ),
  /Google provider requirement must be exactly/u,
);
withMutation(
  "versions.tf",
  (value) =>
    value.replace(
      'version = "~> 6.50.0"',
      'version = "~> 7.0.0" # version = "~> 6.50.0"',
    ),
  /Google provider requirement must be exactly/u,
);
withMutation(
  "versions.tf",
  (value) =>
    value.replace(
      "    }\n  }\n}",
      '    }\n    random = { source = "hashicorp/random", version = "~> 3.0.0" }\n  }\n}',
    ),
  /Google provider requirement must be exactly/u,
);

withMutation(
  "policy.tf",
  (value) => value.replace("peg-thresholds.json", "untrusted-policy.json"),
  /Peg policy locals: peg_policy_source must be exactly/u,
);
withMutation(
  "policy.tf",
  (value) =>
    value.replace(
      "local.peg_policy_source_md5_base64",
      "md5(local.peg_policy_source)",
    ),
  /Peg policy object: detect_md5hash must be exactly/u,
);
withMutation(
  "policy.tf",
  (value) => value.replace("range(0, 30, 3)", "range(0, 27, 3)"),
  /Peg policy locals: peg_policy_source_md5_base64 must be exactly/u,
);
withMutation(
  "policy.tf",
  (value) => value.replace('      "==",', '      "=",'),
  /Peg policy locals: peg_policy_source_md5_base64 must be exactly/u,
);
withMutation(
  "policy.tf",
  (value) =>
    value.replace(
      "  lifecycle {",
      '  source = "untrusted-policy.json"\n\n  lifecycle {',
    ),
  /Peg policy object: source is forbidden/u,
);
withMutation(
  "policy.tf",
  (value) =>
    value.replace(
      "  lifecycle {",
      "  source_md5hash = md5(local.peg_policy_source)\n\n  lifecycle {",
    ),
  /Peg policy object: source_md5hash is forbidden/u,
);
withMutation(
  "policy.tf",
  (value) =>
    value.replace("prevent_destroy = true", "create_before_destroy = true"),
  /Peg policy object lifecycle: prevent_destroy must be exactly true/u,
);
withMutation(
  "providers.tf",
  (value) =>
    value.replace(
      'project                     = "mento-monitoring"',
      'project                     = "wrong-project"',
    ),
  /Google provider: project must be exactly/u,
);
withMutation(
  "providers.tf",
  (value) =>
    value.replace(
      'project                     = "mento-monitoring"',
      'project                     = "wrong-project"\n# project = "mento-monitoring"',
    ),
  /Google provider: project must be exactly/u,
);
withMutation(
  "policy.tf",
  (value) => value.replace("mento-monitoring-peg-policy", "wrong-bucket"),
  /Peg policy locals: peg_policy_bucket must be exactly/u,
);
withMutation(
  "policy.tf",
  (value) =>
    value.replace(
      'peg_policy_bucket          = "mento-monitoring-peg-policy"',
      'peg_policy_bucket          = "wrong"\n# peg_policy_bucket = "mento-monitoring-peg-policy"',
    ),
  /Peg policy locals: peg_policy_bucket must be exactly/u,
);
withMutation(
  "policy.tf",
  (value) => value.replace("peg-policy/current.json", "peg-policy/wrong.json"),
  /Peg policy locals: peg_policy_object must be exactly/u,
);
withMutation(
  "policy.tf",
  (value) =>
    value.replace(
      'peg_policy_object          = "peg-policy/current.json"',
      'peg_policy_object          = "wrong"\n# peg_policy_object = "peg-policy/current.json"',
    ),
  /Peg policy locals: peg_policy_object must be exactly/u,
);
withMutation(
  "policy.tf",
  (value) =>
    value.replace(
      "  lifecycle {",
      '  provisioner "local-exec" {\n    command = "false"\n  }\n\n  lifecycle {',
    ),
  /imperative provisioners are forbidden/u,
);
withMutation(
  "policy.tf",
  (value) => `${value}\nlifecycle_rule {}\n`,
  /deletion lifecycle is forbidden/u,
);

for (const [file, block] of [
  ["outputs.tf", 'output "harmless_note" { value = "hello" }'],
  ["providers.tf", 'provider "random" {}'],
  ["policy.tf", 'data "terraform_remote_state" "harmless" {}'],
  ["policy.tf", 'module "harmless" { source = "./harmless" }'],
  ["policy.tf", 'resource "null_resource" "harmless" {}'],
]) {
  withMutation(
    file,
    (value) => `${value}\n${block}\n`,
    /top-level block inventory must be exactly/u,
  );
}

withMutation(
  "providers.tf",
  (value) =>
    `${value}\nprovider "google" {\n  project                     = "wrong-project"\n  impersonate_service_account = var.terraform_service_account\n}\n`,
  /top-level block inventory must be exactly/u,
);

withMutation(
  "variables.tf",
  (value) =>
    value.replace(
      /condition\s*=.*$/mu,
      'condition = var.terraform_service_account == "attacker@other-project.iam.gserviceaccount.com" # || var.terraform_service_account == "peg-policy-publisher@mento-monitoring.iam.gserviceaccount.com"',
    ),
  /provider identity variable: condition must be exactly/u,
);

assert.throws(
  () =>
    validatePegPolicyPublication({
      ...validFiles,
      "variables.tf": validFiles["variables.tf"].replace(
        '"peg-policy-publisher@mento-monitoring.iam.gserviceaccount.com"',
        '"attacker@other-project.iam.gserviceaccount.com"',
      ),
    }),
  /unregistered publication identity is forbidden/u,
);
assert.throws(
  () =>
    validatePegPolicyPublication({
      ...validFiles,
      "extra.tf": 'resource "google_storage_bucket" "extra" {}\n',
    }),
  /publication root must contain exactly the registered Terraform files/u,
);
assert.throws(
  () =>
    validatePegPolicyPublication({
      ...validFiles,
      "evil.tf.json": '{"resource":{"google_storage_bucket":{"evil":{}}}}\n',
    }),
  /publication root must contain exactly the registered Terraform files/u,
);
assert.throws(
  () =>
    validatePegPolicyPublication({
      ...validFiles,
      "policy.tf": `${validFiles["policy.tf"]}\noutput "broken" {`,
    }),
  /unterminated top-level output block/u,
);

console.log("peg policy publication boundary tests passed");
