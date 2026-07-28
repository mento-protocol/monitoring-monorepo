#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  commentMaskedHcl,
  escapeRegExp,
  expectExpression,
  expectString,
  nestedBlocks,
  terraformTopLevelBlocks,
  topLevelBlockKey,
} from "./production-infra-identity-contract/hcl.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PUBLICATION_FILES = [
  "versions.tf",
  "providers.tf",
  "variables.tf",
  "policy.tf",
  "outputs.tf",
];

const EXPECTED_TOP_LEVEL_BLOCKS = new Set([
  "versions.tf:terraform",
  "providers.tf:provider.google",
  "variables.tf:variable.terraform_service_account",
  "policy.tf:locals",
  "policy.tf:resource.google_storage_bucket_object.peg_policy",
  "outputs.tf:output.peg_policy_bucket",
  "outputs.tf:output.peg_policy_object_name",
  "outputs.tf:output.peg_policy_generation",
  "outputs.tf:output.peg_policy_url",
]);
const EXPECTED_IDENTITIES = new Set([
  "org-terraform@mento-terraform-seed-ffac.iam.gserviceaccount.com",
  "org-terraform-refresh-readonly@mento-terraform-seed-ffac.iam.gserviceaccount.com",
  "peg-policy-publisher@mento-monitoring.iam.gserviceaccount.com",
]);
const PEG_POLICY_BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const PEG_POLICY_MD5_BASE64_PADDING = "==";
const PEG_POLICY_MD5_BASE64_EXPRESSION = `join("", concat(flatten([for offset in range(0, 30, 3) : [substr(local.peg_policy_base64_alphabet, floor(parseint(substr(local.peg_policy_source_md5_hex, offset, 3), 16) / 64), 1), substr(local.peg_policy_base64_alphabet, parseint(substr(local.peg_policy_source_md5_hex, offset, 3), 16) % 64, 1),]]), [substr(local.peg_policy_base64_alphabet, floor(parseint(substr(local.peg_policy_source_md5_hex, 30, 2), 16) / 4), 1), substr(local.peg_policy_base64_alphabet, (parseint(substr(local.peg_policy_source_md5_hex, 30, 2), 16) % 4) * 16, 1), "${PEG_POLICY_MD5_BASE64_PADDING}",],))`;

export function pegPolicyMd5HexToBase64(md5Hex) {
  if (!/^[0-9a-f]{32}$/u.test(md5Hex)) {
    throw new TypeError("MD5 must be exactly 32 lowercase hexadecimal digits");
  }

  const encoded = [];
  for (let offset = 0; offset < 30; offset += 3) {
    const chunk = Number.parseInt(md5Hex.slice(offset, offset + 3), 16);
    encoded.push(
      PEG_POLICY_BASE64_ALPHABET[Math.floor(chunk / 64)],
      PEG_POLICY_BASE64_ALPHABET[chunk % 64],
    );
  }
  const tail = Number.parseInt(md5Hex.slice(30), 16);
  encoded.push(
    PEG_POLICY_BASE64_ALPHABET[Math.floor(tail / 4)],
    PEG_POLICY_BASE64_ALPHABET[(tail % 4) * 16],
    PEG_POLICY_MD5_BASE64_PADDING,
  );
  return encoded.join("");
}

function blockFor(blocks, key, errors) {
  const block = blocks.find((candidate) => topLevelBlockKey(candidate) === key);
  if (!block) errors.push(`${key}: required block is missing`);
  return block;
}

function oneNested(block, type, errors, label) {
  const matches = nestedBlocks(block, type);
  if (matches.length !== 1) {
    errors.push(`${label}: must contain exactly one ${type} block`);
  }
  return matches[0];
}

function forbidAttribute(block, attribute, errors, label) {
  const pattern = new RegExp(`^\\s*${escapeRegExp(attribute)}\\s*=`, "mu");
  if (pattern.test(commentMaskedHcl(block?.code ?? ""))) {
    errors.push(`${label}: ${attribute} is forbidden`);
  }
}

function forbidPattern(contents, pattern, errors, label) {
  if (pattern.test(commentMaskedHcl(contents)))
    errors.push(`${label} is forbidden`);
}

function expectExactMultilineLocalExpression(
  block,
  name,
  expected,
  errors,
  label,
) {
  const normalized = commentMaskedHcl(block?.code ?? "").replace(/\s+/gu, "");
  const expectedAssignment = `${name}=${expected.replace(/\s+/gu, "")}}`;
  if (normalized.split(expectedAssignment).length !== 2) {
    errors.push(`${label}: ${name} must be exactly ${expected}`);
  }
}

function expectNoProvisioner(block, errors, label) {
  if (/^\s*provisioner(?:\s|")/mu.test(commentMaskedHcl(block?.code ?? ""))) {
    errors.push(`${label}: imperative provisioners are forbidden`);
  }
}

function validateTopLevelInventory(files, errors) {
  assert.deepEqual(
    Object.keys(files).sort(),
    [...PUBLICATION_FILES].sort(),
    "publication root must contain exactly the registered Terraform files",
  );
  for (const file of PUBLICATION_FILES) {
    assert(
      typeof files[file] === "string",
      `missing publication file: ${file}`,
    );
  }

  const blocks = terraformTopLevelBlocks(files, errors);
  const actual = new Set(blocks.map(topLevelBlockKey));
  if (
    blocks.length !== EXPECTED_TOP_LEVEL_BLOCKS.size ||
    actual.size !== EXPECTED_TOP_LEVEL_BLOCKS.size ||
    [...EXPECTED_TOP_LEVEL_BLOCKS].some((key) => !actual.has(key))
  ) {
    errors.push(
      `publication root top-level block inventory must be exactly: ${[...EXPECTED_TOP_LEVEL_BLOCKS].sort().join(", ")}`,
    );
  }
  return blocks;
}

function validateVersions(blocks, errors) {
  const terraform = blockFor(blocks, "versions.tf:terraform", errors);
  const backend = oneNested(terraform, 'backend "gcs"', errors, "GCS backend");
  const requiredProviders = oneNested(
    terraform,
    "required_providers",
    errors,
    "provider requirements",
  );
  expectString(
    terraform,
    "required_version",
    ">= 1.11",
    errors,
    "Terraform version",
  );
  validateGoogleProviderRequirement(requiredProviders, errors);
  expectString(
    backend,
    "bucket",
    "mento-terraform-tfstate-6ed6",
    errors,
    "GCS backend",
  );
  expectString(
    backend,
    "prefix",
    "peg-policy-publication",
    errors,
    "GCS backend",
  );
  expectString(
    backend,
    "impersonate_service_account",
    "org-terraform@mento-terraform-seed-ffac.iam.gserviceaccount.com",
    errors,
    "GCS backend",
  );
}

function validateGoogleProviderRequirement(requiredProviders, errors) {
  const code = commentMaskedHcl(requiredProviders?.code ?? "");
  const opening = code.indexOf("{");
  const body = opening === -1 ? "" : code.slice(opening + 1, -1);
  const google = /^\s*google\s*=\s*\{([\s\S]*)\}\s*$/u.exec(body)?.[1];
  if (google === undefined) {
    errors.push(
      "Google provider requirement must contain exactly the google entry",
    );
    return;
  }

  const entries = [
    ...google.matchAll(
      /^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*"((?:[^"\\]|\\.)*)"\s*$/gmu,
    ),
  ];
  const residue = google
    .replaceAll(
      /^\s*[A-Za-z_][A-Za-z0-9_-]*\s*=\s*"(?:[^"\\]|\\.)*"\s*$/gmu,
      "",
    )
    .replace(/\s+/gu, "");
  const requirements = Object.create(null);
  for (const [, name, value] of entries) {
    if (Object.hasOwn(requirements, name)) {
      errors.push("Google provider requirement must not duplicate attributes");
      return;
    }
    try {
      requirements[name] = JSON.parse(`"${value}"`);
    } catch {
      errors.push("Google provider requirement contains an invalid string");
      return;
    }
  }
  if (
    residue !== "" ||
    Object.keys(requirements).length !== 2 ||
    requirements.source !== "hashicorp/google" ||
    requirements.version !== "~> 6.50.0"
  ) {
    errors.push(
      'Google provider requirement must be exactly source = "hashicorp/google" and version = "~> 6.50.0"',
    );
  }
}

function validateProvider(blocks, errors) {
  const provider = blockFor(blocks, "providers.tf:provider.google", errors);
  expectString(
    provider,
    "project",
    "mento-monitoring",
    errors,
    "Google provider",
  );
  expectExpression(
    provider,
    "impersonate_service_account",
    "var.terraform_service_account",
    errors,
    "Google provider",
  );
}

function validateVariable(blocks, errors) {
  const variable = blockFor(
    blocks,
    "variables.tf:variable.terraform_service_account",
    errors,
  );
  expectExpression(
    variable,
    "type",
    "string",
    errors,
    "provider identity variable",
  );
  expectString(
    variable,
    "default",
    "peg-policy-publisher@mento-monitoring.iam.gserviceaccount.com",
    errors,
    "provider identity variable",
  );
  const validation = oneNested(
    variable,
    "validation",
    errors,
    "provider identity variable",
  );
  expectExpression(
    validation,
    "condition",
    'var.terraform_service_account == "org-terraform-refresh-readonly@mento-terraform-seed-ffac.iam.gserviceaccount.com" || var.terraform_service_account == "peg-policy-publisher@mento-monitoring.iam.gserviceaccount.com"',
    errors,
    "provider identity variable",
  );
  expectString(
    validation,
    "error_message",
    "terraform_service_account must be the refresh reader or the Peg policy publisher.",
    errors,
    "provider identity variable",
  );
}

function validatePolicy(blocks, errors) {
  const locals = blockFor(blocks, "policy.tf:locals", errors);
  expectString(
    locals,
    "peg_policy_bucket",
    "mento-monitoring-peg-policy",
    errors,
    "Peg policy locals",
  );
  expectString(
    locals,
    "peg_policy_object",
    "peg-policy/current.json",
    errors,
    "Peg policy locals",
  );
  expectExpression(
    locals,
    "peg_policy_source",
    'file("${path.module}/../rules/peg-thresholds.json")',
    errors,
    "Peg policy locals",
  );
  expectExpression(
    locals,
    "peg_policy_source_md5_hex",
    "md5(local.peg_policy_source)",
    errors,
    "Peg policy locals",
  );
  expectString(
    locals,
    "peg_policy_base64_alphabet",
    PEG_POLICY_BASE64_ALPHABET,
    errors,
    "Peg policy locals",
  );
  expectExactMultilineLocalExpression(
    locals,
    "peg_policy_source_md5_base64",
    PEG_POLICY_MD5_BASE64_EXPRESSION,
    errors,
    "Peg policy locals",
  );

  const policy = blockFor(
    blocks,
    "policy.tf:resource.google_storage_bucket_object.peg_policy",
    errors,
  );
  expectExpression(
    policy,
    "bucket",
    "local.peg_policy_bucket",
    errors,
    "Peg policy object",
  );
  expectExpression(
    policy,
    "name",
    "local.peg_policy_object",
    errors,
    "Peg policy object",
  );
  expectExpression(
    policy,
    "content",
    "local.peg_policy_source",
    errors,
    "Peg policy object",
  );
  expectString(
    policy,
    "content_type",
    "application/json",
    errors,
    "Peg policy object",
  );
  expectString(
    policy,
    "cache_control",
    "no-store",
    errors,
    "Peg policy object",
  );
  expectExpression(
    policy,
    "detect_md5hash",
    "local.peg_policy_source_md5_base64",
    errors,
    "Peg policy object",
  );
  expectString(
    policy,
    "deletion_policy",
    "ABANDON",
    errors,
    "Peg policy object",
  );
  forbidAttribute(policy, "source", errors, "Peg policy object");
  forbidAttribute(policy, "source_md5hash", errors, "Peg policy object");
  expectNoProvisioner(policy, errors, "Peg policy object");

  const lifecycle = oneNested(policy, "lifecycle", errors, "Peg policy object");
  expectExpression(
    lifecycle,
    "prevent_destroy",
    "true",
    errors,
    "Peg policy object lifecycle",
  );
  forbidAttribute(
    lifecycle,
    "create_before_destroy",
    errors,
    "Peg policy object lifecycle",
  );
  const postcondition = oneNested(
    lifecycle,
    "postcondition",
    errors,
    "Peg policy object lifecycle",
  );
  expectExpression(
    postcondition,
    "condition",
    "can(tonumber(self.generation)) && tonumber(self.generation) > 0",
    errors,
    "Peg policy generation postcondition",
  );
  expectString(
    postcondition,
    "error_message",
    "GCS must report a positive immutable generation for the published Peg policy.",
    errors,
    "Peg policy generation postcondition",
  );
}

function validateOutputs(blocks, errors) {
  const expectations = [
    ["peg_policy_bucket", "google_storage_bucket_object.peg_policy.bucket"],
    ["peg_policy_object_name", "google_storage_bucket_object.peg_policy.name"],
    [
      "peg_policy_generation",
      "tonumber(google_storage_bucket_object.peg_policy.generation)",
    ],
    [
      "peg_policy_url",
      '"https://storage.googleapis.com/download/storage/v1/b/mento-monitoring-peg-policy/o/peg-policy%2Fcurrent.json?alt=media&generation=${tonumber(google_storage_bucket_object.peg_policy.generation)}"',
    ],
  ];
  for (const [name, expected] of expectations) {
    const output = blockFor(blocks, `outputs.tf:output.${name}`, errors);
    expectExpression(output, "value", expected, errors, `output ${name}`);
  }
}

function validateForbiddenSurfaces(files, blocks, errors) {
  const all = Object.values(files).join("\n");
  forbidPattern(all, /\bgoogle_cloud_run/gu, errors, "runtime attachment");
  forbidPattern(all, /\bPEG_POLICY_/gu, errors, "runtime configuration");
  forbidPattern(all, /\bgrafana_/gu, errors, "Grafana resource");
  forbidPattern(all, /\blifecycle_rule\s*\{/gu, errors, "deletion lifecycle");

  const identities = [
    ...commentMaskedHcl(all).matchAll(
      /[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com/giu,
    ),
  ].map((match) => match[0]);
  if (identities.some((identity) => !EXPECTED_IDENTITIES.has(identity))) {
    errors.push("unregistered publication identity is forbidden");
  }

  for (const block of blocks) {
    if (block.kind === "resource")
      expectNoProvisioner(block, errors, topLevelBlockKey(block));
  }
}

export function validatePegPolicyPublication(files) {
  const errors = [];
  const blocks = validateTopLevelInventory(files, errors);
  validateVersions(blocks, errors);
  validateProvider(blocks, errors);
  validateVariable(blocks, errors);
  validatePolicy(blocks, errors);
  validateOutputs(blocks, errors);
  validateForbiddenSurfaces(files, blocks, errors);
  if (errors.length > 0) {
    throw new Error(
      `Peg policy publication boundary failed:\n- ${errors.join("\n- ")}`,
    );
  }
}

export function readPegPolicyPublication(rootPath = root) {
  const publication = path.join(rootPath, "alerts/peg-policy-publication");
  const fileNames = readdirSync(publication).filter(
    (file) => file.endsWith(".tf") || file.endsWith(".tf.json"),
  );
  return Object.fromEntries(
    fileNames.map((file) => [
      file,
      readFileSync(path.join(publication, file), "utf8"),
    ]),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  validatePegPolicyPublication(readPegPolicyPublication());
  process.stdout.write("Peg policy publication boundary: ok\n");
}
