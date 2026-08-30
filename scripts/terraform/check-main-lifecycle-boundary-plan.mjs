#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

export const CORE_RULESET_ID = 13494367;
export const GITHUB_ACTIONS_APP_ID = 15368;
export const DEPENDABOT_APP_ID = 29110;
const DEPENDABOT_MERGE_APP_REPOSITORY_PERMISSIONS = Object.freeze({
  contents: "write",
  pull_requests: "write",
  workflows: "write",
});
export const MAIN_LIFECYCLE_RULESET_ADDRESS =
  "github_repository_ruleset.controlled_main_lifecycle[0]";
const DEPENDABOT_MERGE_ENVIRONMENT = "dependabot-merge";
const BROKER_PROJECT_ID = "mento-monitoring";
const BROKER_SERVICE_ACCOUNT_ID = "local-agent-github-broker";
const BROKER_SERVICE_ACCOUNT_EMAIL = `${BROKER_SERVICE_ACCOUNT_ID}@${BROKER_PROJECT_ID}.iam.gserviceaccount.com`;
const BROKER_SERVICE_ACCOUNT_MEMBER = `serviceAccount:${BROKER_SERVICE_ACCOUNT_EMAIL}`;
const BROKER_SERVICE_ACCOUNT_NAME = `projects/${BROKER_PROJECT_ID}/serviceAccounts/${BROKER_SERVICE_ACCOUNT_EMAIL}`;
const BROKER_SERVICE_ACCOUNT_DISPLAY_NAME =
  "Local agent GitHub credential broker";
const BROKER_SERVICE_ACCOUNT_DESCRIPTION =
  "Broker identity that reads the local-agent GitHub App key to mint non-bypass installation tokens outside agent processes.";
const BROKER_SECRET_ID = "local-agent-github-app-private-key";
const BROKER_SECRET_NAME = `projects/${BROKER_PROJECT_ID}/secrets/${BROKER_SECRET_ID}`;
const BROKER_SECRET_LABELS = Object.freeze({
  managed_by: "terraform",
  purpose: "local-agent-github-app",
});
const BROKER_SECRET_EFFECTIVE_LABELS = Object.freeze({
  "goog-terraform-provisioned": "true",
  ...BROKER_SECRET_LABELS,
});
const BROKER_SECRET_ACCESSOR_ROLE = "roles/secretmanager.secretAccessor";
const BROKER_IMPERSONATOR_ROLE = "roles/iam.serviceAccountTokenCreator";
const DEPENDABOT_MERGE_CREDENTIAL_RESOURCE_SPECS = Object.freeze([
  Object.freeze({
    address: "github_repository_environment.dependabot_merge[0]",
    index: 0,
    kind: "environment",
    name: "dependabot_merge",
    type: "github_repository_environment",
  }),
  Object.freeze({
    address:
      "github_repository_environment_deployment_policy.dependabot_merge_main[0]",
    index: 0,
    kind: "deployment-policy",
    name: "dependabot_merge_main",
    type: "github_repository_environment_deployment_policy",
  }),
  Object.freeze({
    address: "github_actions_environment_secret.dependabot_merge_app_id[0]",
    index: 0,
    kind: "secret",
    name: "dependabot_merge_app_id",
    secretName: "DEPENDABOT_MERGE_APP_ID",
    type: "github_actions_environment_secret",
  }),
  Object.freeze({
    address:
      "github_actions_environment_secret.dependabot_merge_app_private_key[0]",
    index: 0,
    kind: "secret",
    name: "dependabot_merge_app_private_key",
    secretName: "DEPENDABOT_MERGE_APP_PRIVATE_KEY",
    type: "github_actions_environment_secret",
  }),
]);
const BROKER_SCAFFOLD_RESOURCE_SPECS = Object.freeze([
  Object.freeze({
    address: "google_service_account.local_agent_github_broker[0]",
    index: 0,
    kind: "service-account",
    name: "local_agent_github_broker",
    type: "google_service_account",
  }),
  Object.freeze({
    address:
      "google_secret_manager_secret.local_agent_github_app_private_key[0]",
    index: 0,
    kind: "secret",
    name: "local_agent_github_app_private_key",
    type: "google_secret_manager_secret",
  }),
  Object.freeze({
    address:
      "google_secret_manager_secret_version.local_agent_github_app_private_key[0]",
    index: 0,
    kind: "secret-version",
    name: "local_agent_github_app_private_key",
    replaceable: true,
    type: "google_secret_manager_secret_version",
  }),
  Object.freeze({
    address:
      "google_secret_manager_secret_iam_member.local_agent_github_broker_accessor[0]",
    index: 0,
    kind: "secret-accessor",
    name: "local_agent_github_broker_accessor",
    type: "google_secret_manager_secret_iam_member",
  }),
  Object.freeze({
    address: undefined,
    index: undefined,
    kind: "impersonator",
    name: "local_agent_github_broker_impersonator",
    type: "google_service_account_iam_member",
  }),
]);
export const SOURCE_MAIN_LIFECYCLE_BOUNDARY_POLICY = Object.freeze(
  JSON.parse(
    readFileSync(
      new URL(
        "../../terraform/main-lifecycle-boundary-policy.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ),
);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameActions(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function containsTrue(value) {
  if (value === true) return true;
  if (Array.isArray(value)) return value.some(containsTrue);
  if (isObject(value)) return Object.values(value).some(containsTrue);
  return false;
}

function nonEmpty(value) {
  if (value === undefined || value === null || value === false) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (isObject(value)) return Object.keys(value).length > 0;
  return true;
}

function exactStringArray(value, expected) {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((entry, index) => entry === expected[index])
  );
}

function boundedBase64Ciphertext(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 131072 &&
    value.length % 4 === 0 &&
    /^[A-Za-z0-9+/]+={0,2}$/u.test(value)
  );
}

function relatedRulesetEntry(resourceChange) {
  return (
    resourceChange?.type === "github_repository_ruleset" ||
    resourceChange?.address === MAIN_LIFECYCLE_RULESET_ADDRESS ||
    resourceChange?.previous_address === MAIN_LIFECYCLE_RULESET_ADDRESS
  );
}

function brokerScaffoldSpec(resourceChange) {
  return BROKER_SCAFFOLD_RESOURCE_SPECS.find(
    (spec) =>
      resourceChange?.type === spec.type && resourceChange?.name === spec.name,
  );
}

function relatedBrokerScaffoldEntry(resourceChange) {
  if (brokerScaffoldSpec(resourceChange)) return true;
  return BROKER_SCAFFOLD_RESOURCE_SPECS.some((spec) => {
    const prefix = `${spec.type}.${spec.name}`;
    return (
      resourceChange?.address === prefix ||
      resourceChange?.address?.startsWith(`${prefix}[`) ||
      resourceChange?.previous_address === prefix ||
      resourceChange?.previous_address?.startsWith(`${prefix}[`)
    );
  });
}

function dependabotCredentialSpec(resourceChange) {
  return DEPENDABOT_MERGE_CREDENTIAL_RESOURCE_SPECS.find(
    (spec) =>
      resourceChange?.type === spec.type && resourceChange?.name === spec.name,
  );
}

function relatedDependabotCredentialEntry(resourceChange) {
  const reservedNames = new Set(
    DEPENDABOT_MERGE_CREDENTIAL_RESOURCE_SPECS.map(
      (spec) => spec.secretName,
    ).filter(Boolean),
  );
  return (
    DEPENDABOT_MERGE_CREDENTIAL_RESOURCE_SPECS.some(
      (spec) =>
        resourceChange?.address === spec.address ||
        resourceChange?.previous_address === spec.address ||
        (resourceChange?.type === spec.type &&
          resourceChange?.name === spec.name),
    ) || reservedNames.has(resourceChange?.change?.after?.secret_name)
  );
}

function exactIdentity(entry) {
  return (
    entry?.address === MAIN_LIFECYCLE_RULESET_ADDRESS &&
    entry?.mode === "managed" &&
    entry?.type === "github_repository_ruleset" &&
    entry?.name === "controlled_main_lifecycle" &&
    entry?.module_address === undefined &&
    entry?.index === 0 &&
    entry?.deposed === undefined &&
    entry?.previous_address === undefined
  );
}

function validateSourcePolicy(policy, errors) {
  const resourcesEnabled = policy?.controlled_main_lifecycle_resources_enabled;
  const dependabotEnvironmentEnabled =
    policy?.dependabot_merge_environment_enabled;
  const dependabotCredentialsEnabled =
    policy?.dependabot_merge_app_credentials_enabled;
  const dependabotWriterMigrationVerified =
    policy?.dependabot_merge_writer_migration_verified;
  const legacyDependabotAutoMergeDrained =
    policy?.legacy_dependabot_auto_merge_drained;
  const brokerScaffoldEnabled =
    policy?.local_agent_github_broker_scaffold_enabled;
  const brokerPartialRecoveryEnabled =
    policy?.local_agent_github_broker_partial_recovery_enabled;
  const brokerImpersonator = policy?.local_agent_github_broker_impersonator;
  const enabledIdentitiesValid =
    Number.isSafeInteger(policy?.human_merge_operator_team_id) &&
    policy.human_merge_operator_team_id > 0 &&
    Number.isSafeInteger(policy?.dependabot_merge_app_id) &&
    policy.dependabot_merge_app_id > 0 &&
    ![GITHUB_ACTIONS_APP_ID, DEPENDABOT_APP_ID].includes(
      policy.dependabot_merge_app_id,
    ) &&
    Number.isSafeInteger(policy?.local_agent_github_app_id) &&
    policy.local_agent_github_app_id > 0 &&
    ![GITHUB_ACTIONS_APP_ID, DEPENDABOT_APP_ID].includes(
      policy.local_agent_github_app_id,
    ) &&
    policy.local_agent_github_app_id !== policy.dependabot_merge_app_id;
  const inertIdentitiesValid =
    policy?.human_merge_operator_team_id === 0 &&
    policy?.dependabot_merge_app_id === 0 &&
    policy?.local_agent_github_app_id === 0;
  const inertStateValid =
    policy?.controlled_main_lifecycle_ruleset_id === 0 &&
    policy?.controlled_main_lifecycle_ruleset_enforcement === "disabled" &&
    dependabotEnvironmentEnabled === false &&
    dependabotCredentialsEnabled === false &&
    dependabotWriterMigrationVerified === false &&
    legacyDependabotAutoMergeDrained === false &&
    policy?.ruleset_audit_active === false &&
    brokerScaffoldEnabled === false &&
    brokerPartialRecoveryEnabled === false &&
    brokerImpersonator === "";
  if (
    !isObject(policy) ||
    policy.repository !== "mento-protocol/monitoring-monorepo" ||
    policy.human_merge_operator_team_slug !== "merge-operators" ||
    typeof resourcesEnabled !== "boolean" ||
    (resourcesEnabled ? !enabledIdentitiesValid : !inertIdentitiesValid) ||
    (!resourcesEnabled && !inertStateValid) ||
    !isDeepStrictEqual(
      policy.dependabot_merge_app_repository_permissions,
      DEPENDABOT_MERGE_APP_REPOSITORY_PERMISSIONS,
    ) ||
    !Number.isSafeInteger(policy.controlled_main_lifecycle_ruleset_id) ||
    policy.controlled_main_lifecycle_ruleset_id < 0 ||
    !["disabled", "active"].includes(
      policy.controlled_main_lifecycle_ruleset_enforcement,
    ) ||
    typeof policy.ruleset_audit_active !== "boolean" ||
    typeof dependabotEnvironmentEnabled !== "boolean" ||
    typeof dependabotCredentialsEnabled !== "boolean" ||
    typeof dependabotWriterMigrationVerified !== "boolean" ||
    typeof legacyDependabotAutoMergeDrained !== "boolean" ||
    typeof brokerScaffoldEnabled !== "boolean" ||
    typeof brokerPartialRecoveryEnabled !== "boolean" ||
    typeof brokerImpersonator !== "string" ||
    (brokerScaffoldEnabled
      ? !/^serviceAccount:[^@\s]+@[^@\s]+\.iam\.gserviceaccount\.com$/u.test(
          brokerImpersonator,
        )
      : brokerImpersonator !== "")
  ) {
    errors.push(
      "source policy must select either the exact inert zero-sentinel state with boundary resources disabled or the enabled state with approved positive Team, dedicated Dependabot merge App, and distinct local-agent App IDs; it must also pin the repository, exact merge-operators Team slug, exact Contents/write, Pull requests/write, and Workflows/write dedicated-App permissions, non-negative managed lifecycle ruleset ID, valid enforcement state, boolean Environment, credential, exact-head REST writer-migration, legacy auto-merge request absence, audit, broker-scaffold, and recovery gates, and one service-account principal only while the scaffold gate is enabled",
    );
    return undefined;
  }

  const rulesetId = policy.controlled_main_lifecycle_ruleset_id;
  const enforcement = policy.controlled_main_lifecycle_ruleset_enforcement;
  const auditActive = policy.ruleset_audit_active;
  const dependabotAppId = policy.dependabot_merge_app_id;
  const expected = {
    auditActive,
    brokerImpersonator,
    brokerPartialRecoveryEnabled,
    brokerScaffoldEnabled,
    dependabotAppId,
    dependabotCredentialsEnabled,
    dependabotEnvironmentEnabled,
    dependabotWriterMigrationVerified,
    enforcement,
    legacyDependabotAutoMergeDrained,
    resourcesEnabled,
    rulesetId,
    teamId: policy.human_merge_operator_team_id,
  };
  if (!resourcesEnabled) return expected;
  if (rulesetId === CORE_RULESET_ID) {
    errors.push("source policy must never adopt core ruleset 13494367");
  }
  if (
    rulesetId === 0 &&
    (enforcement !== "disabled" ||
      auditActive ||
      dependabotEnvironmentEnabled ||
      dependabotCredentialsEnabled ||
      dependabotWriterMigrationVerified ||
      legacyDependabotAutoMergeDrained)
  ) {
    errors.push(
      "initial lifecycle ruleset creation requires managed ID 0, disabled enforcement, disabled Dependabot Environment and credentials, no migration or legacy-drain claim, and an inactive audit",
    );
  }
  if (dependabotEnvironmentEnabled && rulesetId <= 0) {
    errors.push(
      "Dependabot merge Environment provisioning requires a source-pinned managed lifecycle ruleset ID",
    );
  }
  if (
    dependabotCredentialsEnabled &&
    (!dependabotEnvironmentEnabled || rulesetId <= 0)
  ) {
    errors.push(
      "Dependabot merge App credential provisioning requires the enabled main-only Environment and a source-pinned managed lifecycle ruleset ID",
    );
  }
  if (dependabotWriterMigrationVerified && !dependabotCredentialsEnabled) {
    errors.push(
      "Dependabot exact-head REST writer migration evidence requires enabled IaC-owned App credentials",
    );
  }
  if (legacyDependabotAutoMergeDrained && !dependabotWriterMigrationVerified) {
    errors.push(
      "legacy Dependabot auto-merge request absence evidence requires verified dedicated-App exact-head REST writer migration",
    );
  }
  if (
    enforcement === "active" &&
    (!dependabotCredentialsEnabled ||
      !dependabotWriterMigrationVerified ||
      !legacyDependabotAutoMergeDrained)
  ) {
    errors.push(
      "active lifecycle enforcement requires enabled dedicated-App credentials, verified exact-head REST writer migration, and absence of every legacy auto-merge request",
    );
  }
  if (auditActive && (rulesetId <= 0 || enforcement !== "active")) {
    errors.push(
      "ruleset audit activation requires a source-pinned non-core managed ID and active enforcement",
    );
  }
  if (brokerScaffoldEnabled && rulesetId <= 0) {
    errors.push(
      "broker scaffold enablement requires a source-pinned non-core managed lifecycle ruleset ID",
    );
  }
  if (
    brokerPartialRecoveryEnabled &&
    (!brokerScaffoldEnabled ||
      rulesetId <= 0 ||
      enforcement !== "disabled" ||
      auditActive)
  ) {
    errors.push(
      "broker scaffold partial recovery requires the enabled scaffold, a source-pinned managed ruleset ID, disabled enforcement, and an inactive audit",
    );
  }
  return expected;
}

function exactDependabotCredentialIdentity(entry, spec) {
  return (
    entry?.address === spec.address &&
    entry?.mode === "managed" &&
    entry?.type === spec.type &&
    entry?.name === spec.name &&
    entry?.module_address === undefined &&
    entry?.index === spec.index &&
    entry?.deposed === undefined &&
    entry?.previous_address === undefined
  );
}

function exactDependabotEnvironmentShape(value) {
  return (
    isObject(value) &&
    value.repository === "monitoring-monorepo" &&
    value.environment === DEPENDABOT_MERGE_ENVIRONMENT &&
    value.can_admins_bypass === false &&
    Array.isArray(value.deployment_branch_policy) &&
    value.deployment_branch_policy.length === 1 &&
    value.deployment_branch_policy[0]?.protected_branches === false &&
    value.deployment_branch_policy[0]?.custom_branch_policies === true
  );
}

function validateDependabotEnvironmentShape(value, errors) {
  if (!exactDependabotEnvironmentShape(value)) {
    errors.push(
      "the Dependabot merge Environment must disable admin bypass and use one explicit custom deployment-branch policy",
    );
  }
}

function validateDependabotEnvironmentRepairBeforeShape(value, errors) {
  if (
    !isObject(value) ||
    value.repository !== "monitoring-monorepo" ||
    value.environment !== DEPENDABOT_MERGE_ENVIRONMENT ||
    typeof value.can_admins_bypass !== "boolean" ||
    !Array.isArray(value.deployment_branch_policy) ||
    !(
      value.deployment_branch_policy.length === 0 ||
      (value.deployment_branch_policy.length === 1 &&
        typeof value.deployment_branch_policy[0]?.protected_branches ===
          "boolean" &&
        typeof value.deployment_branch_policy[0]?.custom_branch_policies ===
          "boolean")
    )
  ) {
    errors.push(
      "a Dependabot merge Environment repair requires the exact repository and name plus a bounded known prior policy shape or the provider's empty no-policy list",
    );
  } else if (exactDependabotEnvironmentShape(value)) {
    errors.push(
      "a Dependabot merge Environment repair must strengthen at least one unsafe Environment control",
    );
  }
}

function exactDependabotDeploymentPolicyShape(value) {
  return (
    isObject(value) &&
    value.repository === "monitoring-monorepo" &&
    value.environment === DEPENDABOT_MERGE_ENVIRONMENT &&
    value.branch_pattern === "main"
  );
}

function validateDependabotDeploymentPolicyShape(value, errors) {
  if (!exactDependabotDeploymentPolicyShape(value)) {
    errors.push(
      "the Dependabot merge Environment deployment policy must allow only the exact main branch",
    );
  }
}

function validateDependabotDeploymentPolicyRepairBeforeShape(value, errors) {
  if (
    !isObject(value) ||
    value.repository !== "monitoring-monorepo" ||
    value.environment !== DEPENDABOT_MERGE_ENVIRONMENT ||
    typeof value.branch_pattern !== "string" ||
    value.branch_pattern.length === 0 ||
    value.branch_pattern.length > 255
  ) {
    errors.push(
      "a Dependabot merge deployment-policy repair requires a bounded known prior branch pattern with the exact repository and Environment",
    );
  } else if (exactDependabotDeploymentPolicyShape(value)) {
    errors.push(
      "a Dependabot merge deployment-policy repair must strengthen an unsafe branch pattern to exact main",
    );
  }
}

function validateDependabotBoundaryRepairBeforeShape(value, spec, errors) {
  if (spec.kind === "environment") {
    validateDependabotEnvironmentRepairBeforeShape(value, errors);
    return;
  }
  validateDependabotDeploymentPolicyRepairBeforeShape(value, errors);
}

function validateDependabotSecretShape(value, spec, errors) {
  if (
    !isObject(value) ||
    value.repository !== "monitoring-monorepo" ||
    value.environment !== DEPENDABOT_MERGE_ENVIRONMENT ||
    value.secret_name !== spec.secretName ||
    typeof value.key_id !== "string" ||
    !/^[A-Za-z0-9_-]{1,256}$/u.test(value.key_id) ||
    !boundedBase64Ciphertext(value.value_encrypted) ||
    nonEmpty(value.encrypted_value) ||
    nonEmpty(value.plaintext_value) ||
    nonEmpty(value.value)
  ) {
    errors.push(
      "Dependabot merge App credentials must use only the two exact dependabot-merge Environment secrets with one explicit Environment public-key ID and pre-encrypted values",
    );
  }
}

function validateDependabotCredentialShape(value, spec, errors) {
  if (spec.kind === "environment") {
    validateDependabotEnvironmentShape(value, errors);
    return;
  }
  if (spec.kind === "deployment-policy") {
    validateDependabotDeploymentPolicyShape(value, errors);
    return;
  }
  validateDependabotSecretShape(value, spec, errors);
}

function validateDependabotMergeCredentials(
  plan,
  rulesetEntry,
  expected,
  errors,
) {
  const related = plan.resource_changes.filter(
    relatedDependabotCredentialEntry,
  );
  if (!expected?.dependabotEnvironmentEnabled) {
    if (related.length > 0) {
      errors.push(
        "a disabled Dependabot Environment source gate forbids the dedicated main-only Environment, deployment policy, and App secret resources",
      );
    }
    return;
  }
  const expectedSpecs = DEPENDABOT_MERGE_CREDENTIAL_RESOURCE_SPECS.filter(
    (spec) => expected.dependabotCredentialsEnabled || spec.kind !== "secret",
  );
  if (related.length !== expectedSpecs.length) {
    errors.push(
      expected.dependabotCredentialsEnabled
        ? "an enabled Dependabot credential source gate requires exactly the main-only Environment, its main deployment policy, and the App ID and private-key Environment secrets"
        : "an enabled Dependabot Environment source gate requires exactly the Environment and its main deployment policy without App secrets",
    );
    return;
  }

  const seen = new Set();
  for (const entry of related) {
    const spec = dependabotCredentialSpec(entry);
    if (!spec || seen.has(spec.name)) {
      errors.push(
        "Dependabot merge App credential resources must have one canonical identity each",
      );
      continue;
    }
    seen.add(spec.name);
    if (!exactDependabotCredentialIdentity(entry, spec)) {
      errors.push(
        "a Dependabot merge App credential resource has an unexpected identity",
      );
    }
    const actions = entry?.change?.actions;
    if (
      !sameActions(actions, ["create"]) &&
      !sameActions(actions, ["no-op"]) &&
      !sameActions(actions, ["update"])
    ) {
      errors.push(
        "Dependabot merge Environment and App credentials may only be created, unchanged, or updated in place",
      );
    }
    if (containsTrue(entry?.change?.after_unknown ?? {})) {
      errors.push(
        "Dependabot merge Environment and App credential managed fields must be known before apply",
      );
    }
    validateDependabotCredentialShape(entry?.change?.after, spec, errors);
    if (!sameActions(actions, ["create"])) {
      if (sameActions(actions, ["update"]) && spec.kind !== "secret") {
        validateDependabotBoundaryRepairBeforeShape(
          entry?.change?.before,
          spec,
          errors,
        );
      } else {
        validateDependabotCredentialShape(entry?.change?.before, spec, errors);
      }
    } else if (entry?.change?.before !== null) {
      errors.push(
        "a Dependabot merge Environment or credential create must have no prior value",
      );
    }
    if (
      sameActions(actions, ["no-op"]) &&
      !isDeepStrictEqual(entry?.change?.before, entry?.change?.after)
    ) {
      errors.push(
        "a Dependabot merge Environment or credential no-op must preserve its complete resource shape",
      );
    }
  }
  if (
    expectedSpecs.some((spec) => !seen.has(spec.name)) ||
    [...seen].some((name) => !expectedSpecs.some((spec) => spec.name === name))
  ) {
    errors.push(
      "Dependabot merge Environment and credential resources must match the exact resources enabled for this phase",
    );
  }

  const secretEntries = related.filter(
    (entry) => dependabotCredentialSpec(entry)?.kind === "secret",
  );
  const boundaryEntries = related.filter(
    (entry) => dependabotCredentialSpec(entry)?.kind !== "secret",
  );
  const creates = related.filter((entry) =>
    sameActions(entry?.change?.actions, ["create"]),
  );
  const secretCreates = secretEntries.filter((entry) =>
    sameActions(entry?.change?.actions, ["create"]),
  );
  const secretUpdates = secretEntries.filter((entry) =>
    sameActions(entry?.change?.actions, ["update"]),
  );
  const boundaryUpdates = boundaryEntries.filter((entry) =>
    sameActions(entry?.change?.actions, ["update"]),
  );
  const afterKeyIds = new Set(
    secretEntries.map((entry) => entry?.change?.after?.key_id),
  );
  if (expected.dependabotCredentialsEnabled && afterKeyIds.size !== 1) {
    errors.push(
      "both Dependabot merge App credential resources must use the same Environment Actions public-key ID",
    );
  }
  const existing = secretEntries.filter(
    (entry) => !sameActions(entry?.change?.actions, ["create"]),
  );
  const beforeKeyIds = new Set(
    existing.map((entry) => entry?.change?.before?.key_id),
  );
  if (
    expected.dependabotCredentialsEnabled &&
    existing.length > 0 &&
    beforeKeyIds.size !== 1
  ) {
    errors.push(
      "existing Dependabot merge App credential resources must share one prior Environment Actions public-key ID",
    );
  }
  const outsideCredentials = nonNoOpEntries(plan).filter(
    (entry) => entry !== rulesetEntry && !related.includes(entry),
  );
  if (creates.length > 0) {
    const initialProvisioning =
      expected.rulesetId > 0 &&
      expected.enforcement === "disabled" &&
      !expected.auditActive &&
      !expected.dependabotWriterMigrationVerified &&
      !expected.legacyDependabotAutoMergeDrained;
    const activeRecovery =
      expected.rulesetId > 0 &&
      expected.enforcement === "active" &&
      expected.dependabotWriterMigrationVerified &&
      expected.legacyDependabotAutoMergeDrained;
    const publicKeyRecovery =
      (initialProvisioning || activeRecovery) &&
      creates.length === 1 &&
      secretCreates.length === 1 &&
      secretUpdates.length === 1 &&
      boundaryUpdates.length === 0;
    const activeRecoveryBoundaryChanges = boundaryEntries.filter(
      (entry) => !sameActions(entry?.change?.actions, ["no-op"]),
    );
    if (activeRecovery && activeRecoveryBoundaryChanges.length > 0) {
      errors.push(
        "active-state Dependabot credential recovery may create only missing exact Environment secret resources and must keep the Environment and deployment policy unchanged",
      );
    }
    if (
      ((secretUpdates.length > 0 || boundaryUpdates.length > 0) &&
        !publicKeyRecovery) ||
      (!initialProvisioning && !activeRecovery) ||
      !sameActions(rulesetEntry?.change?.actions, ["no-op"]) ||
      outsideCredentials.length > 0
    ) {
      errors.push(
        "Dependabot Environment or credential creation requires either the pinned disabled pre-migration phase or coherent active-state recovery, an unchanged ruleset, and no unrelated change",
      );
    }
    if (publicKeyRecovery) {
      const survivingUpdate = secretUpdates[0];
      if (
        survivingUpdate?.change?.before?.key_id ===
          survivingUpdate?.change?.after?.key_id ||
        survivingUpdate?.change?.before?.value_encrypted ===
          survivingUpdate?.change?.after?.value_encrypted
      ) {
        errors.push(
          "recovery across an Actions public-key rotation must recreate the missing secret and update the surviving secret key ID and ciphertext together",
        );
      }
    }
  } else if (boundaryUpdates.length > 0) {
    if (
      secretUpdates.length > 0 ||
      !sameActions(rulesetEntry?.change?.actions, ["no-op"]) ||
      outsideCredentials.length > 0
    ) {
      errors.push(
        "a Dependabot Environment repair may update only its exact main-only boundary beside the unchanged ruleset",
      );
    }
  } else if (secretUpdates.length > 0) {
    if (
      ![1, 2].includes(secretUpdates.length) ||
      !sameActions(rulesetEntry?.change?.actions, ["no-op"]) ||
      outsideCredentials.length > 0
    ) {
      errors.push(
        "an approved Dependabot credential rotation may update one ciphertext or the exact two-secret key pair beside the unchanged ruleset",
      );
    }
    const oldKeyId = existing[0]?.change?.before?.key_id;
    const newKeyId = existing[0]?.change?.after?.key_id;
    if (secretUpdates.length === 1) {
      const update = secretUpdates[0];
      if (
        update?.change?.before?.key_id !== update?.change?.after?.key_id ||
        update?.change?.before?.value_encrypted ===
          update?.change?.after?.value_encrypted
      ) {
        errors.push(
          "a one-secret Dependabot credential rotation must keep the public-key ID and change only that ciphertext",
        );
      }
    } else if (
      secretUpdates.length === 2 &&
      (oldKeyId === newKeyId ||
        secretUpdates.some(
          (entry) =>
            entry?.change?.before?.key_id !== oldKeyId ||
            entry?.change?.after?.key_id !== newKeyId ||
            entry?.change?.before?.value_encrypted ===
              entry?.change?.after?.value_encrypted,
        ))
    ) {
      errors.push(
        "an Environment Actions public-key rotation must update both credential key IDs and both ciphertexts together",
      );
    }
  }
}

function exactBrokerScaffoldIdentity(entry, spec, expected) {
  const expectedIndex =
    spec.index === undefined ? expected?.brokerImpersonator : spec.index;
  const expectedAddress =
    spec.address ??
    `${spec.type}.${spec.name}[${JSON.stringify(expectedIndex)}]`;
  return (
    entry?.address === expectedAddress &&
    entry?.mode === "managed" &&
    entry?.type === spec.type &&
    entry?.name === spec.name &&
    entry?.module_address === undefined &&
    entry?.index === expectedIndex &&
    entry?.deposed === undefined &&
    entry?.previous_address === undefined
  );
}

const BROKER_PROJECT_REFERENCES = Object.freeze([
  "google_project.monitoring.project_id",
  "google_project.monitoring",
]);
const BROKER_SERVICE_ACCOUNT_EMAIL_REFERENCES = Object.freeze([
  "google_service_account.local_agent_github_broker[0].email",
  "google_service_account.local_agent_github_broker[0]",
  "google_service_account.local_agent_github_broker",
]);
const BROKER_SERVICE_ACCOUNT_NAME_REFERENCES = Object.freeze([
  "google_service_account.local_agent_github_broker[0].name",
  "google_service_account.local_agent_github_broker[0]",
  "google_service_account.local_agent_github_broker",
]);
const BROKER_SECRET_ID_REFERENCES = Object.freeze([
  "google_secret_manager_secret.local_agent_github_app_private_key[0].secret_id",
  "google_secret_manager_secret.local_agent_github_app_private_key[0]",
  "google_secret_manager_secret.local_agent_github_app_private_key",
]);
const BROKER_SECRET_NAME_REFERENCES = Object.freeze([
  "google_secret_manager_secret.local_agent_github_app_private_key[0].id",
  "google_secret_manager_secret.local_agent_github_app_private_key[0]",
  "google_secret_manager_secret.local_agent_github_app_private_key",
]);

function exactObjectKeys(value, expected) {
  return (
    isObject(value) &&
    isDeepStrictEqual(Object.keys(value).sort(), [...expected].sort())
  );
}

function exactFields(value, expected) {
  return Object.entries(expected).every(([name, expectedValue]) =>
    isDeepStrictEqual(value?.[name], expectedValue),
  );
}

function boundedProviderText(value, maximum = 4096) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    ![...value].some((character) => {
      const point = character.codePointAt(0);
      return point < 0x20 || point === 0x7f;
    })
  );
}

function exactTimestamp(value) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function exactExpressionKeys(expressions, expected) {
  return exactObjectKeys(expressions, Object.keys(expected));
}

function constantExpression(value) {
  return { constant_value: value };
}

function referenceExpression(references) {
  return { references: [...references] };
}

function expectedBrokerConfigurationExpressions(spec) {
  if (spec.kind === "service-account") {
    return {
      account_id: constantExpression(BROKER_SERVICE_ACCOUNT_ID),
      description: constantExpression(BROKER_SERVICE_ACCOUNT_DESCRIPTION),
      display_name: constantExpression(BROKER_SERVICE_ACCOUNT_DISPLAY_NAME),
      project: referenceExpression(BROKER_PROJECT_REFERENCES),
    };
  }
  if (spec.kind === "secret") {
    return {
      labels: constantExpression(BROKER_SECRET_LABELS),
      project: referenceExpression(BROKER_PROJECT_REFERENCES),
      replication: [{ auto: [{}] }],
      secret_id: constantExpression(BROKER_SECRET_ID),
    };
  }
  if (spec.kind === "secret-version") {
    return {
      deletion_policy: constantExpression("DISABLE"),
      secret: referenceExpression(BROKER_SECRET_NAME_REFERENCES),
      secret_data_wo: referenceExpression([
        "var.local_agent_github_app_private_key",
      ]),
      secret_data_wo_version: referenceExpression([
        "var.local_agent_github_app_private_key_rotation_counter",
      ]),
    };
  }
  if (spec.kind === "secret-accessor") {
    return {
      member: referenceExpression(BROKER_SERVICE_ACCOUNT_EMAIL_REFERENCES),
      project: referenceExpression(BROKER_PROJECT_REFERENCES),
      role: constantExpression(BROKER_SECRET_ACCESSOR_ROLE),
      secret_id: referenceExpression(BROKER_SECRET_ID_REFERENCES),
    };
  }
  return {
    member: referenceExpression(["each.value"]),
    role: constantExpression(BROKER_IMPERSONATOR_ROLE),
    service_account_id: referenceExpression(
      BROKER_SERVICE_ACCOUNT_NAME_REFERENCES,
    ),
  };
}

function validateBrokerScaffoldConfiguration(plan, spec, errors) {
  const resources = plan.configuration?.root_module?.resources;
  const baseAddress = `${spec.type}.${spec.name}`;
  const matches = Array.isArray(resources)
    ? resources.filter(
        (resource) =>
          resource?.type === spec.type && resource?.name === spec.name,
      )
    : [];
  const resource = matches[0];
  const expectedExpressions = expectedBrokerConfigurationExpressions(spec);
  if (
    matches.length !== 1 ||
    resource?.address !== baseAddress ||
    resource?.mode !== "managed" ||
    resource?.provider_config_key !== "google" ||
    resource?.schema_version !== 0 ||
    !exactExpressionKeys(resource?.expressions, expectedExpressions) ||
    !isDeepStrictEqual(resource?.expressions, expectedExpressions)
  ) {
    errors.push(
      "broker scaffold Terraform configuration must use only the pinned project, canonical resource references, write-only key variable, rotation counter, and exact IAM values",
    );
  }
}

function exactServiceAccountShape(value, mode) {
  const fixed = {
    account_id: BROKER_SERVICE_ACCOUNT_ID,
    create_ignore_already_exists: null,
    description: BROKER_SERVICE_ACCOUNT_DESCRIPTION,
    disabled: false,
    display_name: BROKER_SERVICE_ACCOUNT_DISPLAY_NAME,
    email: BROKER_SERVICE_ACCOUNT_EMAIL,
    member: BROKER_SERVICE_ACCOUNT_MEMBER,
    project: BROKER_PROJECT_ID,
    timeouts: null,
  };
  const keys = Object.keys(fixed);
  if (mode === "live") keys.push("id", "name", "unique_id");
  return (
    exactObjectKeys(value, keys) &&
    exactFields(value, fixed) &&
    (mode !== "live" ||
      (value.id === BROKER_SERVICE_ACCOUNT_NAME &&
        value.name === BROKER_SERVICE_ACCOUNT_NAME &&
        /^[1-9][0-9]{0,63}$/u.test(value.unique_id)))
  );
}

function exactSecretShape(value, mode) {
  const fixed = {
    annotations: null,
    deletion_protection: false,
    effective_labels: BROKER_SECRET_EFFECTIVE_LABELS,
    labels: BROKER_SECRET_LABELS,
    project: BROKER_PROJECT_ID,
    replication: [
      {
        auto: [{ customer_managed_encryption: [] }],
        user_managed: [],
      },
    ],
    rotation: [],
    secret_id: BROKER_SECRET_ID,
    tags: null,
    terraform_labels: BROKER_SECRET_EFFECTIVE_LABELS,
    timeouts: null,
    topics: [],
    ttl: null,
    version_aliases: null,
    version_destroy_ttl: null,
  };
  const keys = Object.keys(fixed);
  if (mode === "live") {
    keys.push(
      "create_time",
      "effective_annotations",
      "expire_time",
      "id",
      "name",
    );
  }
  return (
    exactObjectKeys(value, keys) &&
    exactFields(value, fixed) &&
    (mode !== "live" ||
      (exactTimestamp(value.create_time) &&
        isDeepStrictEqual(value.effective_annotations, {}) &&
        value.expire_time === null &&
        value.id === BROKER_SECRET_NAME &&
        value.name === BROKER_SECRET_NAME))
  );
}

function exactSecretVersionShape(value, mode) {
  const fixed = {
    deletion_policy: "DISABLE",
    enabled: true,
    is_secret_data_base64: false,
    secret_data: null,
    secret_data_wo: null,
    timeouts: null,
  };
  const keys = [...Object.keys(fixed), "secret_data_wo_version"];
  if (mode !== "create-unknown-secret") {
    fixed.secret = BROKER_SECRET_NAME;
    keys.push("secret");
  }
  if (mode === "live") {
    keys.push("create_time", "destroy_time", "id", "name", "version");
  }
  const rotation = value?.secret_data_wo_version;
  if (
    !exactObjectKeys(value, keys) ||
    !exactFields(value, fixed) ||
    !Number.isSafeInteger(rotation) ||
    rotation <= 0
  ) {
    return false;
  }
  if (mode !== "live") return true;
  const version = value.version;
  const versionName = `${BROKER_SECRET_NAME}/versions/${version}`;
  return (
    exactTimestamp(value.create_time) &&
    value.destroy_time === null &&
    /^[1-9][0-9]*$/u.test(version) &&
    value.id === versionName &&
    value.name === versionName
  );
}

function exactIamComputedFields(value, expectedId) {
  return boundedProviderText(value?.etag, 2048) && value?.id === expectedId;
}

function exactSecretAccessorShape(value, mode) {
  const fixed = {
    condition: [],
    member: BROKER_SERVICE_ACCOUNT_MEMBER,
    project: BROKER_PROJECT_ID,
    role: BROKER_SECRET_ACCESSOR_ROLE,
    secret_id: BROKER_SECRET_ID,
  };
  const keys = Object.keys(fixed);
  if (mode === "live") keys.push("etag", "id");
  return (
    exactObjectKeys(value, keys) &&
    exactFields(value, fixed) &&
    (mode !== "live" ||
      exactIamComputedFields(
        value,
        `${BROKER_SECRET_NAME} ${BROKER_SECRET_ACCESSOR_ROLE} ${BROKER_SERVICE_ACCOUNT_MEMBER}`,
      ))
  );
}

function exactImpersonatorShape(value, mode, impersonator) {
  const fixed = {
    condition: [],
    member: impersonator,
    role: BROKER_IMPERSONATOR_ROLE,
  };
  const keys = Object.keys(fixed);
  if (mode !== "create-unknown-service-account") {
    fixed.service_account_id = BROKER_SERVICE_ACCOUNT_NAME;
    keys.push("service_account_id");
  }
  if (mode === "live") keys.push("etag", "id");
  return (
    exactObjectKeys(value, keys) &&
    exactFields(value, fixed) &&
    (mode !== "live" ||
      exactIamComputedFields(
        value,
        `${BROKER_SERVICE_ACCOUNT_NAME} ${BROKER_IMPERSONATOR_ROLE} ${impersonator}`,
      ))
  );
}

function exactBrokerValueShape(spec, value, mode, expected) {
  if (spec.kind === "service-account") {
    return exactServiceAccountShape(value, mode);
  }
  if (spec.kind === "secret") return exactSecretShape(value, mode);
  if (spec.kind === "secret-version") {
    return exactSecretVersionShape(value, mode);
  }
  if (spec.kind === "secret-accessor") {
    return exactSecretAccessorShape(value, mode);
  }
  return exactImpersonatorShape(value, mode, expected.brokerImpersonator);
}

function expectedBrokerCreateUnknown(spec, dependencies) {
  if (spec.kind === "service-account") {
    return { id: true, name: true, unique_id: true };
  }
  if (spec.kind === "secret") {
    return {
      create_time: true,
      effective_annotations: true,
      effective_labels: {},
      expire_time: true,
      id: true,
      labels: {},
      name: true,
      replication: [
        {
          auto: [{ customer_managed_encryption: [] }],
          user_managed: [],
        },
      ],
      rotation: [],
      terraform_labels: {},
      topics: [],
    };
  }
  if (spec.kind === "secret-version") {
    return {
      create_time: true,
      destroy_time: true,
      id: true,
      name: true,
      ...(dependencies.secretCreated ? { secret: true } : {}),
      version: true,
    };
  }
  if (spec.kind === "secret-accessor") {
    return { condition: [], etag: true, id: true };
  }
  return {
    condition: [],
    etag: true,
    id: true,
    ...(dependencies.serviceAccountCreated ? { service_account_id: true } : {}),
  };
}

function expectedBrokerReplacementUnknown() {
  return {
    create_time: true,
    destroy_time: true,
    id: true,
    name: true,
    version: true,
  };
}

function validateBrokerUnknownShape(entry, expectedUnknown, errors) {
  if (!isDeepStrictEqual(entry?.change?.after_unknown, expectedUnknown)) {
    errors.push(
      "broker scaffold planned unknown fields must match only the pinned provider-computed shape",
    );
  }
}

function validateCanonicalBrokerScaffoldChange(
  entry,
  spec,
  dependencies,
  expected,
  errors,
) {
  const actions = entry?.change?.actions;
  if (sameActions(actions, ["create"])) {
    const mode =
      spec.kind === "secret-version" && dependencies.secretCreated
        ? "create-unknown-secret"
        : spec.kind === "impersonator" && dependencies.serviceAccountCreated
          ? "create-unknown-service-account"
          : "create";
    if (
      entry?.change?.before !== null ||
      !exactBrokerValueShape(spec, entry?.change?.after, mode, expected)
    ) {
      errors.push(
        `broker scaffold ${spec.kind} create must have no prior value and the exact pinned planned shape`,
      );
    }
    validateBrokerUnknownShape(
      entry,
      expectedBrokerCreateUnknown(spec, dependencies),
      errors,
    );
    if (
      entry?.change?.replace_paths !== undefined &&
      !isDeepStrictEqual(entry.change.replace_paths, [])
    ) {
      errors.push("a broker scaffold create must not carry replacement paths");
    }
    return;
  }
  if (sameActions(actions, ["no-op"])) {
    if (
      !exactBrokerValueShape(spec, entry?.change?.before, "live", expected) ||
      !exactBrokerValueShape(spec, entry?.change?.after, "live", expected) ||
      !isDeepStrictEqual(entry.change.before, entry.change.after)
    ) {
      errors.push(
        `broker scaffold ${spec.kind} no-op must preserve the exact pinned live shape`,
      );
    }
    validateBrokerUnknownShape(entry, {}, errors);
    if (
      entry?.change?.replace_paths !== undefined &&
      !isDeepStrictEqual(entry.change.replace_paths, [])
    ) {
      errors.push("a broker scaffold no-op must not carry replacement paths");
    }
    return;
  }
  if (spec.replaceable && sameActions(actions, ["create", "delete"])) {
    const before = entry?.change?.before;
    const after = entry?.change?.after;
    if (
      !exactBrokerValueShape(spec, before, "live", expected) ||
      !exactBrokerValueShape(spec, after, "create", expected) ||
      after?.secret_data_wo_version !== before?.secret_data_wo_version + 1 ||
      !isDeepStrictEqual(entry?.change?.replace_paths, [
        ["secret_data_wo_version"],
      ])
    ) {
      errors.push(
        "broker scaffold secret-version replacement must rotate only the write-only value through the next counter and exact replacement path",
      );
    }
    validateBrokerUnknownShape(
      entry,
      expectedBrokerReplacementUnknown(),
      errors,
    );
  }
}

function nonNoOpEntries(plan) {
  return plan.resource_changes.filter(
    (entry) => !sameActions(entry?.change?.actions, ["no-op"]),
  );
}

function validateBrokerScaffold(plan, rulesetEntry, expected, errors) {
  const related = plan.resource_changes.filter(relatedBrokerScaffoldEntry);
  if (!expected?.brokerScaffoldEnabled) {
    if (related.length > 0) {
      errors.push(
        "a disabled broker-scaffold source gate forbids every broker scaffold and credential resource",
      );
    }
    if (sameActions(rulesetEntry?.change?.actions, ["create"])) {
      const outsideRuleset = nonNoOpEntries(plan).filter(
        (entry) => entry !== rulesetEntry,
      );
      if (outsideRuleset.length > 0) {
        errors.push(
          "initial disabled lifecycle ruleset creation must be the plan's only change",
        );
      }
    }
    return;
  }

  if (related.length !== BROKER_SCAFFOLD_RESOURCE_SPECS.length) {
    errors.push(
      "an enabled broker-scaffold source gate requires the complete five-resource scaffold and credential set",
    );
    return;
  }

  const entriesBySpec = new Map();
  for (const entry of related) {
    const spec = brokerScaffoldSpec(entry);
    const key = `${spec?.type}.${spec?.name}`;
    if (!spec || entriesBySpec.has(key)) {
      errors.push(
        "broker scaffold resources must have one canonical identity each",
      );
      continue;
    }
    entriesBySpec.set(key, entry);
    if (!exactBrokerScaffoldIdentity(entry, spec, expected)) {
      errors.push("a broker scaffold resource has an unexpected identity");
    }
    validateBrokerScaffoldConfiguration(plan, spec, errors);
    const actions = entry?.change?.actions;
    const allowed =
      sameActions(actions, ["create"]) ||
      sameActions(actions, ["no-op"]) ||
      (spec.replaceable && sameActions(actions, ["create", "delete"]));
    if (!allowed) {
      errors.push(
        "broker scaffold resources may only be created, unchanged, or rotate the write-only credential version",
      );
    }
  }

  const serviceAccountEntry = entriesBySpec.get(
    "google_service_account.local_agent_github_broker",
  );
  const secretEntry = entriesBySpec.get(
    "google_secret_manager_secret.local_agent_github_app_private_key",
  );
  const dependencies = {
    secretCreated: sameActions(secretEntry?.change?.actions, ["create"]),
    serviceAccountCreated: sameActions(serviceAccountEntry?.change?.actions, [
      "create",
    ]),
  };
  for (const [key, entry] of entriesBySpec) {
    const spec = BROKER_SCAFFOLD_RESOURCE_SPECS.find(
      (candidate) => `${candidate.type}.${candidate.name}` === key,
    );
    validateCanonicalBrokerScaffoldChange(
      entry,
      spec,
      dependencies,
      expected,
      errors,
    );
  }

  const createEntries = related.filter((entry) =>
    sameActions(entry?.change?.actions, ["create"]),
  );
  const replacementEntries = related.filter((entry) =>
    sameActions(entry?.change?.actions, ["create", "delete"]),
  );
  const outsideScaffold = nonNoOpEntries(plan).filter(
    (entry) => !related.includes(entry),
  );
  if (expected.brokerPartialRecoveryEnabled) {
    if (
      expected.rulesetId <= 0 ||
      expected.enforcement !== "disabled" ||
      expected.auditActive ||
      !sameActions(rulesetEntry?.change?.actions, ["no-op"])
    ) {
      errors.push(
        "broker scaffold partial recovery requires a pinned, disabled, unchanged lifecycle ruleset and an inactive audit",
      );
    }
    if (replacementEntries.length > 0) {
      errors.push(
        "broker scaffold partial recovery permits only canonical create and no-op scaffold actions",
      );
    }
    if (outsideScaffold.length > 0) {
      errors.push(
        "broker scaffold partial recovery may change only missing members of the documented five-resource scaffold and credential set",
      );
    }
  }
  if (createEntries.length > 0) {
    if (expected.brokerPartialRecoveryEnabled) {
      if (createEntries.length >= BROKER_SCAFFOLD_RESOURCE_SPECS.length) {
        errors.push(
          "broker scaffold partial recovery requires at least one existing no-op scaffold member; disable the recovery gate for an ordinary all-five create",
        );
      }
    } else if (
      createEntries.length !== BROKER_SCAFFOLD_RESOURCE_SPECS.length ||
      replacementEntries.length > 0
    ) {
      errors.push(
        "initial broker scaffold provisioning must create all five resources together unless the reviewed partial-recovery gate is enabled",
      );
    }
    if (
      expected.rulesetId <= 0 ||
      expected.enforcement !== "disabled" ||
      expected.auditActive ||
      !sameActions(rulesetEntry?.change?.actions, ["no-op"])
    ) {
      errors.push(
        "initial broker scaffold provisioning requires a pinned, disabled, unchanged lifecycle ruleset and an inactive audit",
      );
    }
    if (outsideScaffold.length > 0 && !expected.brokerPartialRecoveryEnabled) {
      errors.push(
        "initial broker scaffold provisioning may change only the documented five-resource scaffold and credential set",
      );
    }
  } else if (replacementEntries.length > 0) {
    if (replacementEntries.length !== 1) {
      errors.push("one approved credential plan may rotate only one version");
    }
    const outsideVersion = nonNoOpEntries(plan).filter(
      (entry) => !replacementEntries.includes(entry),
    );
    if (outsideVersion.length > 0) {
      errors.push(
        "a credential rotation plan may change only the write-only credential version",
      );
    }
  }
}

function validateRulesetShape(after, expected, errors) {
  if (!isObject(after)) {
    errors.push("controlled lifecycle ruleset must have a known after value");
    return;
  }
  if (
    after.name !== "controlled-main-lifecycle" ||
    after.repository !== "monitoring-monorepo" ||
    after.target !== "branch" ||
    after.enforcement !== expected?.enforcement
  ) {
    errors.push(
      "controlled lifecycle ruleset must match the source-pinned enforcement on monitoring-monorepo branches",
    );
  }

  if (after.ruleset_id === CORE_RULESET_ID) {
    errors.push(
      "controlled lifecycle ruleset must never use core ruleset 13494367",
    );
  }
  if (expected?.rulesetId > 0) {
    if (after.ruleset_id !== expected.rulesetId) {
      errors.push(
        "controlled lifecycle ruleset after ID must match the source-pinned managed ID",
      );
    }
  } else if (
    after.ruleset_id !== undefined &&
    after.ruleset_id !== null &&
    after.ruleset_id !== 0
  ) {
    errors.push(
      "initial lifecycle ruleset creation must not carry an existing ruleset ID",
    );
  }

  if (
    !Array.isArray(after.conditions) ||
    after.conditions.length !== 1 ||
    !isObject(after.conditions[0]) ||
    !Array.isArray(after.conditions[0].ref_name) ||
    after.conditions[0].ref_name.length !== 1 ||
    !exactStringArray(after.conditions[0].ref_name[0]?.include, [
      "refs/heads/main",
    ]) ||
    !exactStringArray(after.conditions[0].ref_name[0]?.exclude, [])
  ) {
    errors.push(
      "controlled lifecycle ruleset must target only refs/heads/main",
    );
  }

  const bypasses = after.bypass_actors;
  if (!Array.isArray(bypasses) || bypasses.length !== 2) {
    errors.push(
      "controlled lifecycle ruleset must have exactly the human Team and dedicated Dependabot App bypasses",
    );
  } else {
    const team = bypasses.find((entry) => entry?.actor_type === "Team");
    const dependabotApp = bypasses.find(
      (entry) => entry?.actor_type === "Integration",
    );
    if (
      team?.actor_type !== "Team" ||
      !Number.isSafeInteger(team?.actor_id) ||
      team.actor_id <= 0 ||
      team.bypass_mode !== "pull_request"
    ) {
      errors.push(
        "controlled lifecycle ruleset Team bypass must be one positive ID in pull_request mode",
      );
    } else if (team.actor_id !== expected?.teamId) {
      errors.push(
        "controlled lifecycle ruleset Team actor must match the source-pinned approved Team ID",
      );
    }
    if (
      dependabotApp?.actor_type !== "Integration" ||
      !Number.isSafeInteger(dependabotApp?.actor_id) ||
      dependabotApp.actor_id <= 0 ||
      dependabotApp.bypass_mode !== "exempt"
    ) {
      errors.push(
        "controlled lifecycle ruleset Dependabot writer bypass must be one positive Integration ID in exempt mode",
      );
    } else if (dependabotApp.actor_id !== expected?.dependabotAppId) {
      errors.push(
        "controlled lifecycle ruleset Integration actor must match the source-pinned dedicated Dependabot merge App ID",
      );
    }
    if (
      [GITHUB_ACTIONS_APP_ID, DEPENDABOT_APP_ID].includes(
        dependabotApp?.actor_id,
      )
    ) {
      errors.push(
        "shared GitHub Actions and Dependabot integrations must never bypass the controlled lifecycle ruleset",
      );
    }
  }

  if (
    !Array.isArray(after.rules) ||
    after.rules.length !== 1 ||
    !isObject(after.rules[0]) ||
    after.rules[0].creation !== true ||
    after.rules[0].update !== true ||
    after.rules[0].deletion !== true
  ) {
    errors.push(
      "controlled lifecycle ruleset must contain creation, update, and deletion rules",
    );
  } else {
    const extraRules = Object.entries(after.rules[0]).filter(
      ([name, value]) =>
        !["creation", "update", "deletion"].includes(name) && nonEmpty(value),
    );
    if (extraRules.length > 0) {
      errors.push(
        "controlled lifecycle ruleset must contain only creation, update, and deletion rules",
      );
    }
  }
}

function validateExistingIdentity(before, expected, errors) {
  if (!isObject(before)) {
    errors.push(
      "an existing controlled lifecycle ruleset must have a known before value",
    );
    return;
  }
  if (before.ruleset_id === CORE_RULESET_ID) {
    errors.push(
      "controlled lifecycle ruleset must never adopt core ruleset 13494367",
    );
  }
  if (before.ruleset_id !== expected?.rulesetId) {
    errors.push(
      "controlled lifecycle ruleset before ID must match the source-pinned managed ID",
    );
  }
  if (
    before.name !== "controlled-main-lifecycle" ||
    before.repository !== "monitoring-monorepo" ||
    before.target !== "branch" ||
    !["disabled", "active"].includes(before.enforcement)
  ) {
    errors.push(
      "controlled lifecycle ruleset before value must identify the expected managed ruleset",
    );
  }
}

function normalizedManagedRulesetState(value) {
  if (!isObject(value)) return value;
  const normalized = structuredClone(value);
  delete normalized.enforcement;
  delete normalized.etag;
  delete normalized.node_id;
  return normalized;
}

function validateRulesetEntry(entry, expected, errors) {
  if (!exactIdentity(entry)) {
    errors.push(
      "controlled lifecycle ruleset has an unexpected resource identity",
    );
  }
  const actions = entry?.change?.actions;
  const isCreate = sameActions(actions, ["create"]);
  const isNoOp = sameActions(actions, ["no-op"]);
  const isUpdate = sameActions(actions, ["update"]);
  if (!isCreate && !isNoOp && !isUpdate) {
    errors.push(
      "controlled lifecycle ruleset may only be created, unchanged, or updated in place",
    );
  }

  const unknown = structuredClone(entry?.change?.after_unknown ?? {});
  if (isObject(unknown)) {
    delete unknown.etag;
    delete unknown.node_id;
    if (isCreate && expected?.rulesetId === 0) delete unknown.ruleset_id;
  }
  if (containsTrue(unknown)) {
    errors.push(
      "controlled lifecycle ruleset managed fields must be known before apply",
    );
  }

  if (expected?.rulesetId === 0) {
    if (!isCreate || entry?.change?.before !== null) {
      errors.push(
        "managed lifecycle ruleset ID 0 permits only an initial create with no before value",
      );
    }
  } else if (expected?.rulesetId > 0) {
    if (isCreate) {
      errors.push(
        "a source-pinned managed lifecycle ruleset ID forbids another create",
      );
    }
    validateExistingIdentity(entry?.change?.before, expected, errors);
  }

  const beforeEnforcement = entry?.change?.before?.enforcement;
  if (expected?.enforcement === "disabled" && beforeEnforcement === "active") {
    errors.push(
      "controlled lifecycle ruleset enforcement must not move backward",
    );
  }
  if (isNoOp && beforeEnforcement !== expected?.enforcement) {
    errors.push(
      "a no-op controlled lifecycle ruleset must already match source-pinned enforcement",
    );
  }
  if (isNoOp) {
    validateRulesetShape(entry?.change?.before, expected, errors);
  }
  if (isUpdate) {
    if (
      beforeEnforcement !== "disabled" ||
      expected?.enforcement !== "active" ||
      entry?.change?.after?.enforcement !== "active"
    ) {
      errors.push(
        "a controlled lifecycle ruleset update may only activate disabled enforcement",
      );
    }
    if (
      !isDeepStrictEqual(
        normalizedManagedRulesetState(entry?.change?.before),
        normalizedManagedRulesetState(entry?.change?.after),
      )
    ) {
      errors.push(
        "a controlled lifecycle ruleset update must change only enforcement",
      );
    }
    validateRulesetShape(
      entry?.change?.before,
      { ...expected, enforcement: beforeEnforcement },
      errors,
    );
  }
  if (expected?.auditActive) {
    if (!isNoOp || beforeEnforcement !== "active") {
      errors.push(
        "ruleset audit activation requires a separate no-op plan after active enforcement receives live proof",
      );
    }
  }

  validateRulesetShape(entry?.change?.after, expected, errors);
}

function validateGithubProvider(plan, errors) {
  if (Object.hasOwn(plan.variables ?? {}, "github_owner")) {
    errors.push(
      "platform plan must not expose an overridable github_owner variable",
    );
  }
  const providerConfigurations = plan.configuration?.provider_config ?? {};
  const githubProviders = Object.entries(providerConfigurations).filter(
    ([, configuration]) =>
      configuration?.full_name === "registry.terraform.io/integrations/github",
  );
  const provider = providerConfigurations.github;
  const tokenExpression = provider?.expressions?.token;
  if (
    githubProviders.length !== 1 ||
    githubProviders[0]?.[0] !== "github" ||
    !isObject(provider) ||
    provider.full_name !== "registry.terraform.io/integrations/github" ||
    provider.expressions?.owner?.constant_value !== "mento-protocol" ||
    provider.expressions?.base_url?.constant_value !==
      "https://api.github.com/" ||
    !isObject(tokenExpression) ||
    Object.keys(tokenExpression).length !== 1 ||
    !exactStringArray(tokenExpression.references, ["var.github_token"])
  ) {
    errors.push(
      "the only GitHub provider must be unaliased, use only var.github_token, and pin mento-protocol plus https://api.github.com/ in reviewed source",
    );
  }
}

function rejectMutableTeamMirror(plan, errors) {
  const mirror = plan.resource_changes.filter(
    (entry) =>
      entry?.address ===
        "github_actions_variable.human_merge_operator_team_id" ||
      entry?.previous_address ===
        "github_actions_variable.human_merge_operator_team_id" ||
      entry?.change?.after?.variable_name === "HUMAN_MERGE_OPERATOR_TEAM_ID",
  );
  if (mirror.length > 0) {
    errors.push(
      "mutable HUMAN_MERGE_OPERATOR_TEAM_ID repository-variable authority is forbidden",
    );
  }
}

function rejectDependabotCredentialMirrors(plan, errors) {
  const reservedNames = new Set(
    DEPENDABOT_MERGE_CREDENTIAL_RESOURCE_SPECS.map(
      (spec) => spec.secretName,
    ).filter(Boolean),
  );
  const mirrors = plan.resource_changes.filter((entry) => {
    const secretName = entry?.change?.after?.secret_name;
    return (
      reservedNames.has(secretName) &&
      (entry?.type !== "github_actions_environment_secret" ||
        entry?.change?.after?.environment !== DEPENDABOT_MERGE_ENVIRONMENT)
    );
  });
  if (mirrors.length > 0) {
    errors.push(
      "dedicated Dependabot merge App credentials must exist only in their exact dependabot-merge Environment secret resources and must not be mirrored into repository, Dependabot, Codespaces, another Environment, or organization secret stores",
    );
  }
}

export function validateMainLifecycleBoundaryPlan(
  plan,
  {
    policy = SOURCE_MAIN_LIFECYCLE_BOUNDARY_POLICY,
    recoveryTargetOnly = false,
  } = {},
) {
  const errors = [];
  if (!isObject(plan) || !Array.isArray(plan.resource_changes)) {
    return ["Terraform plan JSON must include resource_changes"];
  }
  if (recoveryTargetOnly) {
    const boundaryEntries = plan.resource_changes.filter(
      (entry) =>
        relatedRulesetEntry(entry) ||
        relatedDependabotCredentialEntry(entry) ||
        relatedBrokerScaffoldEntry(entry),
    );
    if (boundaryEntries.length > 0) {
      errors.push(
        "the Peg-policy recovery-only plan must not include controlled lifecycle ruleset, dedicated-App credential, or local-agent broker resources",
      );
    }
    return errors;
  }
  const expected = validateSourcePolicy(policy, errors);
  validateGithubProvider(plan, errors);
  rejectMutableTeamMirror(plan, errors);
  rejectDependabotCredentialMirrors(plan, errors);
  if (expected?.resourcesEnabled === false) {
    const boundaryEntries = plan.resource_changes.filter(
      (entry) =>
        relatedRulesetEntry(entry) ||
        relatedDependabotCredentialEntry(entry) ||
        relatedBrokerScaffoldEntry(entry),
    );
    if (boundaryEntries.length > 0) {
      errors.push(
        "the inert bootstrap phase requires zero controlled lifecycle ruleset, dedicated-App credential, and local-agent broker resources",
      );
    }
    return errors;
  }
  const related = plan.resource_changes.filter(relatedRulesetEntry);
  if (related.length !== 1) {
    errors.push(
      "Terraform plan must contain one canonical controlled lifecycle ruleset and no other first-class repository rulesets",
    );
    return errors;
  }
  validateRulesetEntry(related[0], expected, errors);
  validateBrokerScaffold(plan, related[0], expected, errors);
  validateDependabotMergeCredentials(plan, related[0], expected, errors);
  return errors;
}

export function assertMainLifecycleBoundaryPlan(plan, options) {
  const errors = validateMainLifecycleBoundaryPlan(plan, options);
  if (errors.length > 0) {
    throw new Error(
      `Main lifecycle boundary plan policy failed: ${errors.join("; ")}`,
    );
  }
}
