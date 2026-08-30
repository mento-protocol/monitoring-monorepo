#!/usr/bin/env node

import assert from "node:assert/strict";
import { checkPrimeSync, createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  CORE_RULESET_ID,
  MAIN_LIFECYCLE_RULESET_ADDRESS,
  SOURCE_MAIN_LIFECYCLE_BOUNDARY_POLICY,
  validateMainLifecycleBoundaryPlan,
} from "./check-main-lifecycle-boundary-plan.mjs";

const TEAM_ID = 424242;
const DEPENDABOT_MERGE_APP_ID = 515151;
const LOCAL_AGENT_APP_ID = 616161;
const MANAGED_RULESET_ID = 24680;
const ACTIONS_PUBLIC_KEY_ID = "actions-key-old";
const BROKER_IMPERSONATOR =
  "serviceAccount:local-agent-broker@mento-monitoring.iam.gserviceaccount.com";
const POLICY_BASE = Object.freeze({
  repository: "mento-protocol/monitoring-monorepo",
  controlled_main_lifecycle_resources_enabled: true,
  human_merge_operator_team_slug: "merge-operators",
  human_merge_operator_team_id: TEAM_ID,
  dependabot_merge_app_id: DEPENDABOT_MERGE_APP_ID,
  dependabot_merge_app_repository_permissions: {
    contents: "write",
    pull_requests: "write",
    workflows: "write",
  },
  local_agent_github_app_id: LOCAL_AGENT_APP_ID,
  controlled_main_lifecycle_ruleset_id: MANAGED_RULESET_ID,
  controlled_main_lifecycle_ruleset_enforcement: "active",
  dependabot_merge_environment_enabled: true,
  dependabot_merge_app_credentials_enabled: true,
  dependabot_merge_writer_migration_verified: true,
  legacy_dependabot_auto_merge_drained: true,
  ruleset_audit_active: false,
  local_agent_github_broker_scaffold_enabled: false,
  local_agent_github_broker_partial_recovery_enabled: false,
  local_agent_github_broker_impersonator: "",
});
const BOOTSTRAP_POLICY = Object.freeze({
  ...POLICY_BASE,
  controlled_main_lifecycle_ruleset_id: 0,
  controlled_main_lifecycle_ruleset_enforcement: "disabled",
  dependabot_merge_environment_enabled: false,
  dependabot_merge_app_credentials_enabled: false,
  dependabot_merge_writer_migration_verified: false,
  legacy_dependabot_auto_merge_drained: false,
});
const INERT_POLICY = Object.freeze({
  ...BOOTSTRAP_POLICY,
  controlled_main_lifecycle_resources_enabled: false,
  human_merge_operator_team_id: 0,
  dependabot_merge_app_id: 0,
  local_agent_github_app_id: 0,
});
const SCAFFOLD_POLICY = Object.freeze({
  ...POLICY_BASE,
  controlled_main_lifecycle_ruleset_enforcement: "disabled",
  dependabot_merge_writer_migration_verified: false,
  legacy_dependabot_auto_merge_drained: false,
  local_agent_github_broker_scaffold_enabled: true,
  local_agent_github_broker_impersonator: BROKER_IMPERSONATOR,
});
const CREDENTIAL_POLICY = Object.freeze({
  ...POLICY_BASE,
  controlled_main_lifecycle_ruleset_enforcement: "disabled",
  dependabot_merge_writer_migration_verified: false,
  legacy_dependabot_auto_merge_drained: false,
});
const ENVIRONMENT_POLICY = Object.freeze({
  ...CREDENTIAL_POLICY,
  dependabot_merge_app_credentials_enabled: false,
});
const SCAFFOLD_RECOVERY_POLICY = Object.freeze({
  ...SCAFFOLD_POLICY,
  local_agent_github_broker_partial_recovery_enabled: true,
});
const COMPLETED_DEPENDABOT_SCAFFOLD_RECOVERY_POLICY = Object.freeze({
  ...SCAFFOLD_RECOVERY_POLICY,
  dependabot_merge_writer_migration_verified: true,
  legacy_dependabot_auto_merge_drained: true,
});

function rulesetAfter({
  dependabotAppId = DEPENDABOT_MERGE_APP_ID,
  enforcement = "active",
  rulesetId = MANAGED_RULESET_ID,
  teamId = TEAM_ID,
} = {}) {
  const after = {
    name: "controlled-main-lifecycle",
    repository: "monitoring-monorepo",
    target: "branch",
    enforcement,
    conditions: [
      {
        ref_name: [{ include: ["refs/heads/main"], exclude: [] }],
      },
    ],
    bypass_actors: [
      {
        actor_id: teamId,
        actor_type: "Team",
        bypass_mode: "pull_request",
      },
      {
        actor_id: dependabotAppId,
        actor_type: "Integration",
        bypass_mode: "exempt",
      },
    ],
    rules: [
      {
        creation: true,
        update: true,
        deletion: true,
        merge_queue: [],
        pull_request: [],
      },
    ],
    etag: "fixture-etag",
    node_id: "fixture-node",
  };
  if (rulesetId !== undefined) after.ruleset_id = rulesetId;
  return after;
}

function rulesetEntry({
  actions = ["no-op"],
  before,
  dependabotAppId = DEPENDABOT_MERGE_APP_ID,
  enforcement = "active",
  rulesetId = MANAGED_RULESET_ID,
  teamId = TEAM_ID,
} = {}) {
  const after = rulesetAfter({
    dependabotAppId,
    enforcement,
    rulesetId,
    teamId,
  });
  return {
    address: MAIN_LIFECYCLE_RULESET_ADDRESS,
    index: 0,
    mode: "managed",
    type: "github_repository_ruleset",
    name: "controlled_main_lifecycle",
    change: {
      actions,
      before: before === undefined ? structuredClone(after) : before,
      after,
      after_unknown: {},
    },
  };
}

function dependabotCredentialEntries({ actions = ["no-op"] } = {}) {
  return [
    {
      address: "github_actions_environment_secret.dependabot_merge_app_id[0]",
      index: 0,
      mode: "managed",
      name: "dependabot_merge_app_id",
      kind: "secret",
      secretName: "DEPENDABOT_MERGE_APP_ID",
      type: "github_actions_environment_secret",
    },
    {
      address:
        "github_actions_environment_secret.dependabot_merge_app_private_key[0]",
      index: 0,
      mode: "managed",
      name: "dependabot_merge_app_private_key",
      kind: "secret",
      secretName: "DEPENDABOT_MERGE_APP_PRIVATE_KEY",
      type: "github_actions_environment_secret",
    },
    {
      address: "github_repository_environment.dependabot_merge[0]",
      index: 0,
      kind: "environment",
      mode: "managed",
      name: "dependabot_merge",
      type: "github_repository_environment",
    },
    {
      address:
        "github_repository_environment_deployment_policy.dependabot_merge_main[0]",
      index: 0,
      kind: "deployment-policy",
      mode: "managed",
      name: "dependabot_merge_main",
      type: "github_repository_environment_deployment_policy",
    },
  ].map(({ kind, secretName, ...entry }) => {
    const value =
      kind === "environment"
        ? {
            can_admins_bypass: false,
            deployment_branch_policy: [
              {
                custom_branch_policies: true,
                protected_branches: false,
              },
            ],
            environment: "dependabot-merge",
            repository: "monitoring-monorepo",
          }
        : kind === "deployment-policy"
          ? {
              branch_pattern: "main",
              environment: "dependabot-merge",
              repository: "monitoring-monorepo",
            }
          : {
              environment: "dependabot-merge",
              key_id: ACTIONS_PUBLIC_KEY_ID,
              value_encrypted: Buffer.from(`encrypted-${secretName}`).toString(
                "base64",
              ),
              repository: "monitoring-monorepo",
              secret_name: secretName,
            };
    return {
      ...entry,
      change: {
        actions: [...actions],
        after: structuredClone(value),
        after_unknown: {},
        before: actions[0] === "create" ? null : structuredClone(value),
      },
    };
  });
}

function brokerScaffoldEntries({ actions = ["no-op"] } = {}) {
  return [
    {
      address: "google_service_account.local_agent_github_broker[0]",
      index: 0,
      mode: "managed",
      name: "local_agent_github_broker",
      type: "google_service_account",
    },
    {
      address:
        "google_secret_manager_secret.local_agent_github_app_private_key[0]",
      index: 0,
      mode: "managed",
      name: "local_agent_github_app_private_key",
      type: "google_secret_manager_secret",
    },
    {
      address:
        "google_secret_manager_secret_version.local_agent_github_app_private_key[0]",
      index: 0,
      mode: "managed",
      name: "local_agent_github_app_private_key",
      type: "google_secret_manager_secret_version",
    },
    {
      address:
        "google_secret_manager_secret_iam_member.local_agent_github_broker_accessor[0]",
      index: 0,
      mode: "managed",
      name: "local_agent_github_broker_accessor",
      type: "google_secret_manager_secret_iam_member",
    },
    {
      address: `google_service_account_iam_member.local_agent_github_broker_impersonator[${JSON.stringify(BROKER_IMPERSONATOR)}]`,
      index: BROKER_IMPERSONATOR,
      mode: "managed",
      name: "local_agent_github_broker_impersonator",
      type: "google_service_account_iam_member",
    },
  ].map((entry) => ({
    ...entry,
    change: {
      actions: [...actions],
      after: { fixture: entry.address },
      after_unknown: {},
      before: actions[0] === "create" ? null : { fixture: entry.address },
    },
  }));
}

function plan(entries = [rulesetEntry(), ...dependabotCredentialEntries()]) {
  return {
    configuration: {
      provider_config: {
        github: {
          name: "github",
          full_name: "registry.terraform.io/integrations/github",
          expressions: {
            owner: { constant_value: "mento-protocol" },
            base_url: { constant_value: "https://api.github.com/" },
            token: { references: ["var.github_token"] },
          },
        },
      },
    },
    variables: {},
    resource_changes: entries,
  };
}

function errorsFor(candidate, policy = POLICY_BASE, options = {}) {
  return validateMainLifecycleBoundaryPlan(candidate, {
    policy,
    ...options,
  });
}

function expectPass(candidate, policy = POLICY_BASE, options = {}) {
  assert.deepEqual(errorsFor(candidate, policy, options), []);
}

function expectFailure(
  candidate,
  expected,
  policy = POLICY_BASE,
  options = {},
) {
  const errors = errorsFor(candidate, policy, options);
  assert(
    errors.some((error) => error.includes(expected)),
    `expected ${JSON.stringify(errors)} to include ${JSON.stringify(expected)}`,
  );
}

// Steady-state and forward-only activation plans.
expectPass(plan());
expectPass(plan([]), INERT_POLICY);
const inertUnrelatedEntry = {
  address: "google_storage_bucket.unrelated_inert_plan",
  mode: "managed",
  name: "unrelated_inert_plan",
  type: "google_storage_bucket",
  change: { actions: ["create"], before: null, after: {}, after_unknown: {} },
};
expectPass(plan([inertUnrelatedEntry]), INERT_POLICY);
expectFailure(
  plan([rulesetEntry({ actions: ["create"], before: null })]),
  "inert bootstrap phase requires zero",
  INERT_POLICY,
);
expectFailure(
  plan(dependabotCredentialEntries({ actions: ["create"] })),
  "inert bootstrap phase requires zero",
  INERT_POLICY,
);
expectFailure(
  plan(brokerScaffoldEntries({ actions: ["create"] })),
  "inert bootstrap phase requires zero",
  INERT_POLICY,
);
expectPass(
  plan([
    rulesetEntry({ enforcement: "disabled" }),
    ...dependabotCredentialEntries(),
    ...brokerScaffoldEntries(),
  ]),
  SCAFFOLD_POLICY,
);
const activation = rulesetEntry({ actions: ["update"] });
activation.change.before.enforcement = "disabled";
expectPass(plan([activation, ...dependabotCredentialEntries()]));

const activationWithComputedChurn = structuredClone(activation);
activationWithComputedChurn.change.after.etag = "updated-fixture-etag";
activationWithComputedChurn.change.after.node_id = "updated-fixture-node";
expectPass(
  plan([activationWithComputedChurn, ...dependabotCredentialEntries()]),
);

const activeToActive = rulesetEntry({ actions: ["update"] });
activeToActive.change.after.etag = "updated-fixture-etag";
expectFailure(plan([activeToActive]), "may only activate disabled enforcement");

const disabledToDisabled = rulesetEntry({
  actions: ["update"],
  enforcement: "disabled",
});
expectFailure(
  plan([disabledToDisabled]),
  "may only activate disabled enforcement",
  {
    ...POLICY_BASE,
    controlled_main_lifecycle_ruleset_enforcement: "disabled",
  },
);

const activationWithUnvalidatedFieldMutation = structuredClone(activation);
activationWithUnvalidatedFieldMutation.change.after.provider_extension = {
  canary: true,
};
expectFailure(
  plan([activationWithUnvalidatedFieldMutation]),
  "must change only enforcement",
);

const activationWithRepair = structuredClone(activation);
activationWithRepair.change.before.rules[0].deletion = false;
expectFailure(
  plan([activationWithRepair]),
  "must contain creation, update, and deletion rules",
);

const managedDisabledPolicy = {
  ...POLICY_BASE,
  controlled_main_lifecycle_ruleset_enforcement: "disabled",
};
expectPass(
  plan([
    rulesetEntry({
      enforcement: "disabled",
    }),
    ...dependabotCredentialEntries(),
  ]),
  managedDisabledPolicy,
);

// Initial creation is disabled, has no existing ID, and keeps audit inert.
const initialCreate = rulesetEntry({
  actions: ["create"],
  before: null,
  enforcement: "disabled",
  rulesetId: 0,
});
initialCreate.change.after_unknown = { ruleset_id: true };
expectPass(plan([initialCreate]), BOOTSTRAP_POLICY);

// The dedicated App credential phase creates and protects the main-only
// Environment before it writes ciphertext while the ruleset stays disabled.
const credentialRuleset = rulesetEntry({ enforcement: "disabled" });
const environmentCreates = dependabotCredentialEntries({
  actions: ["create"],
}).slice(2);
expectPass(
  plan([credentialRuleset, ...environmentCreates]),
  ENVIRONMENT_POLICY,
);
expectFailure(
  plan([
    credentialRuleset,
    ...dependabotCredentialEntries({ actions: ["create"] }),
  ]),
  "without App secrets",
  ENVIRONMENT_POLICY,
);
const credentialCreates = dependabotCredentialEntries({ actions: ["create"] });
expectPass(plan([credentialRuleset, ...credentialCreates]), CREDENTIAL_POLICY);
const partialCredentialRecovery = dependabotCredentialEntries();
partialCredentialRecovery[1].change = credentialCreates[1].change;
expectPass(
  plan([credentialRuleset, ...partialCredentialRecovery]),
  CREDENTIAL_POLICY,
);
const activeCredentialRecovery = dependabotCredentialEntries();
activeCredentialRecovery[1].change = dependabotCredentialEntries({
  actions: ["create"],
})[1].change;
expectPass(plan([rulesetEntry(), ...activeCredentialRecovery]), POLICY_BASE);
expectPass(
  plan([
    rulesetEntry(),
    ...dependabotCredentialEntries({ actions: ["create"] }),
  ]),
  POLICY_BASE,
);
const activePublicKeyRecovery = dependabotCredentialEntries();
activePublicKeyRecovery[0].change = dependabotCredentialEntries({
  actions: ["create"],
})[0].change;
activePublicKeyRecovery[0].change.after.key_id = "actions-key-new";
activePublicKeyRecovery[0].change.after.value_encrypted = Buffer.from(
  "recreated-under-new-key",
).toString("base64");
activePublicKeyRecovery[1].change.actions = ["update"];
activePublicKeyRecovery[1].change.after.key_id = "actions-key-new";
activePublicKeyRecovery[1].change.after.value_encrypted = Buffer.from(
  "survivor-under-new-key",
).toString("base64");
expectPass(plan([rulesetEntry(), ...activePublicKeyRecovery]), POLICY_BASE);
const initialPublicKeyRecovery = structuredClone(activePublicKeyRecovery);
expectPass(
  plan([credentialRuleset, ...initialPublicKeyRecovery]),
  CREDENTIAL_POLICY,
);
const incompleteActivePublicKeyRecovery = structuredClone(
  activePublicKeyRecovery,
);
incompleteActivePublicKeyRecovery[1].change.after.value_encrypted =
  incompleteActivePublicKeyRecovery[1].change.before.value_encrypted;
expectFailure(
  plan([rulesetEntry(), ...incompleteActivePublicKeyRecovery]),
  "update the surviving secret key ID and ciphertext together",
  POLICY_BASE,
);
const incompleteInitialPublicKeyRecovery = structuredClone(
  initialPublicKeyRecovery,
);
incompleteInitialPublicKeyRecovery[1].change.after.value_encrypted =
  incompleteInitialPublicKeyRecovery[1].change.before.value_encrypted;
expectFailure(
  plan([credentialRuleset, ...incompleteInitialPublicKeyRecovery]),
  "update the surviving secret key ID and ciphertext together",
  CREDENTIAL_POLICY,
);
expectFailure(
  plan([credentialRuleset, credentialCreates[0]]),
  "requires exactly the main-only Environment",
  CREDENTIAL_POLICY,
);
const plaintextCredential = dependabotCredentialEntries();
plaintextCredential[1].change.after.plaintext_value = "private-key-canary";
plaintextCredential[1].change.before.plaintext_value = "private-key-canary";
expectFailure(
  plan([credentialRuleset, ...plaintextCredential]),
  "pre-encrypted values",
  CREDENTIAL_POLICY,
);
const malformedCiphertextCredential = dependabotCredentialEntries();
malformedCiphertextCredential[1].change.after.value_encrypted = "not-base64";
malformedCiphertextCredential[1].change.before.value_encrypted = "not-base64";
expectFailure(
  plan([credentialRuleset, ...malformedCiphertextCredential]),
  "pre-encrypted values",
  CREDENTIAL_POLICY,
);
const credentialDelete = dependabotCredentialEntries();
credentialDelete[1].change.actions = ["delete"];
expectFailure(
  plan([credentialRuleset, ...credentialDelete]),
  "only be created, unchanged, or updated in place",
  CREDENTIAL_POLICY,
);
const credentialRotation = dependabotCredentialEntries();
credentialRotation[1].change.actions = ["update"];
credentialRotation[1].change.after.value_encrypted =
  Buffer.from("rotated-ciphertext").toString("base64");
expectPass(plan([rulesetEntry(), ...credentialRotation]), POLICY_BASE);
const publicKeyRotation = dependabotCredentialEntries();
for (const [index, entry] of publicKeyRotation.slice(0, 2).entries()) {
  entry.change.actions = ["update"];
  entry.change.after.key_id = "actions-key-new";
  entry.change.after.value_encrypted = Buffer.from(
    `new-key-ciphertext-${index}`,
  ).toString("base64");
}
expectPass(plan([rulesetEntry(), ...publicKeyRotation]), POLICY_BASE);
const partialPublicKeyRotation = dependabotCredentialEntries();
partialPublicKeyRotation[1].change.actions = ["update"];
partialPublicKeyRotation[1].change.after.key_id = "actions-key-new";
partialPublicKeyRotation[1].change.after.value_encrypted =
  Buffer.from("new-key-ciphertext").toString("base64");
expectFailure(
  plan([rulesetEntry(), ...partialPublicKeyRotation]),
  "same Environment Actions public-key ID",
  POLICY_BASE,
);
const unrelatedCredentialRotationChange = {
  address: "google_storage_bucket.unrelated_credential_rotation",
  mode: "managed",
  name: "unrelated_credential_rotation",
  type: "google_storage_bucket",
  change: { actions: ["create"], before: null, after: {}, after_unknown: {} },
};
expectFailure(
  plan([
    rulesetEntry(),
    ...credentialRotation,
    unrelatedCredentialRotationChange,
  ]),
  "approved Dependabot credential rotation",
  POLICY_BASE,
);
const dependabotSecretMirror = {
  address: "github_actions_secret.dependabot_merge_app_private_key",
  mode: "managed",
  name: "dependabot_merge_app_private_key",
  type: "github_actions_secret",
  change: {
    actions: ["create"],
    before: null,
    after: {
      repository: "monitoring-monorepo",
      secret_name: "DEPENDABOT_MERGE_APP_PRIVATE_KEY",
    },
    after_unknown: {},
  },
};
expectFailure(
  plan([
    rulesetEntry(),
    ...dependabotCredentialEntries(),
    dependabotSecretMirror,
  ]),
  "must not be mirrored",
);

for (const [mutate, expected] of [
  [
    (entries) => (entries[2].change.after.can_admins_bypass = true),
    "disable admin bypass",
  ],
  [
    (entries) =>
      (entries[2].change.after.deployment_branch_policy[0].protected_branches = true),
    "explicit custom deployment-branch policy",
  ],
  [
    (entries) =>
      (entries[2].change.after.deployment_branch_policy[0].custom_branch_policies = false),
    "explicit custom deployment-branch policy",
  ],
  [
    (entries) => (entries[3].change.after.branch_pattern = "*"),
    "allow only the exact main branch",
  ],
  [
    (entries) => (entries[0].change.after.environment = "unprotected"),
    "two exact dependabot-merge Environment secrets",
  ],
]) {
  const candidate = dependabotCredentialEntries();
  mutate(candidate);
  expectFailure(plan([rulesetEntry(), ...candidate]), expected);
}

for (const index of [0, 1, 2, 3]) {
  const unknownCredentialField = dependabotCredentialEntries();
  unknownCredentialField[index].change.after_unknown = { managed: true };
  expectFailure(
    plan([rulesetEntry(), ...unknownCredentialField]),
    "managed fields must be known before apply",
  );
}

const environmentStrengtheningRepair = dependabotCredentialEntries();
environmentStrengtheningRepair[2].change.actions = ["update"];
environmentStrengtheningRepair[2].change.before.can_admins_bypass = true;
environmentStrengtheningRepair[2].change.before.deployment_branch_policy = [
  { custom_branch_policies: false, protected_branches: true },
];
expectPass(
  plan([rulesetEntry(), ...environmentStrengtheningRepair]),
  POLICY_BASE,
);

const emptyPolicyStrengtheningRepair = dependabotCredentialEntries();
emptyPolicyStrengtheningRepair[2].change.actions = ["update"];
emptyPolicyStrengtheningRepair[2].change.before.deployment_branch_policy = [];
expectPass(
  plan([rulesetEntry(), ...emptyPolicyStrengtheningRepair]),
  POLICY_BASE,
);

const deploymentPolicyStrengtheningRepair = dependabotCredentialEntries();
deploymentPolicyStrengtheningRepair[3].change.actions = ["update"];
deploymentPolicyStrengtheningRepair[3].change.before.branch_pattern = "*";
expectPass(
  plan([rulesetEntry(), ...deploymentPolicyStrengtheningRepair]),
  POLICY_BASE,
);

const malformedEnvironmentRepair = structuredClone(
  environmentStrengtheningRepair,
);
malformedEnvironmentRepair[2].change.before.repository = "attacker-repo";
expectFailure(
  plan([rulesetEntry(), ...malformedEnvironmentRepair]),
  "bounded known prior policy shape",
);
const nullPolicyEnvironmentRepair = structuredClone(
  environmentStrengtheningRepair,
);
nullPolicyEnvironmentRepair[2].change.before.deployment_branch_policy = null;
expectFailure(
  plan([rulesetEntry(), ...nullPolicyEnvironmentRepair]),
  "bounded known prior policy shape",
);

const wideningEnvironmentUpdate = dependabotCredentialEntries();
wideningEnvironmentUpdate[2].change.actions = ["update"];
wideningEnvironmentUpdate[2].change.after.can_admins_bypass = true;
expectFailure(
  plan([rulesetEntry(), ...wideningEnvironmentUpdate]),
  "must disable admin bypass",
);

const destructiveEnvironmentChange = dependabotCredentialEntries();
destructiveEnvironmentChange[2].change.actions = ["delete"];
expectFailure(
  plan([rulesetEntry(), ...destructiveEnvironmentChange]),
  "only be created, unchanged, or updated in place",
);

expectFailure(
  plan([
    rulesetEntry(),
    ...environmentStrengtheningRepair,
    unrelatedCredentialRotationChange,
  ]),
  "may update only its exact main-only boundary",
);

for (const policy of [
  {
    ...BOOTSTRAP_POLICY,
    controlled_main_lifecycle_ruleset_enforcement: "active",
  },
  { ...BOOTSTRAP_POLICY, ruleset_audit_active: true },
]) {
  expectFailure(
    plan([initialCreate]),
    "initial lifecycle ruleset creation requires",
    policy,
  );
}
expectFailure(
  plan([activation, ...dependabotCredentialEntries()]),
  "active lifecycle enforcement requires",
  {
    ...POLICY_BASE,
    dependabot_merge_writer_migration_verified: false,
    legacy_dependabot_auto_merge_drained: false,
  },
);
expectFailure(
  plan([credentialRuleset]),
  "exact-head REST writer migration evidence requires enabled",
  {
    ...CREDENTIAL_POLICY,
    dependabot_merge_app_credentials_enabled: false,
    dependabot_merge_writer_migration_verified: true,
  },
);
expectFailure(
  plan([credentialRuleset, ...dependabotCredentialEntries()]),
  "legacy Dependabot auto-merge request absence evidence requires",
  {
    ...CREDENTIAL_POLICY,
    legacy_dependabot_auto_merge_drained: true,
  },
);

const auditedPolicy = { ...POLICY_BASE, ruleset_audit_active: true };
expectPass(plan(), auditedPolicy);
expectFailure(
  plan([activation]),
  "separate no-op plan after active enforcement receives live proof",
  auditedPolicy,
);

const rollback = rulesetEntry({
  actions: ["update"],
  enforcement: "disabled",
});
rollback.change.before.enforcement = "active";
expectFailure(
  plan([rollback]),
  "enforcement must not move backward",
  managedDisabledPolicy,
);

expectPass(plan([]), POLICY_BASE, { recoveryTargetOnly: true });
expectPass(plan([inertUnrelatedEntry]), POLICY_BASE, {
  recoveryTargetOnly: true,
});
expectFailure(
  null,
  "Terraform plan JSON must include resource_changes",
  POLICY_BASE,
  { recoveryTargetOnly: true },
);
for (const entry of [
  rulesetEntry(),
  dependabotCredentialEntries()[0],
  brokerScaffoldEntries()[0],
]) {
  expectFailure(
    plan([entry]),
    "Peg-policy recovery-only plan must not include",
    POLICY_BASE,
    { recoveryTargetOnly: true },
  );
}

for (const actions of [
  ["delete"],
  ["create", "delete"],
  ["delete", "create"],
  ["read"],
]) {
  const entry = rulesetEntry({ actions });
  expectFailure(
    plan([entry]),
    "may only be created, unchanged, or updated in place",
  );
}

expectFailure(plan([]), "one canonical controlled lifecycle ruleset");
expectFailure(
  plan([
    rulesetEntry(),
    {
      ...rulesetEntry(),
      address: "github_repository_ruleset.core_main",
      name: "core_main",
    },
  ]),
  "no other first-class repository rulesets",
);

for (const [mutate, expected] of [
  [(after) => (after.enforcement = "disabled"), "source-pinned enforcement"],
  [(after) => (after.repository = "other"), "source-pinned enforcement"],
  [
    (after) => (after.conditions[0].ref_name[0].include = ["~ALL"]),
    "target only refs/heads/main",
  ],
  [
    (after) =>
      after.bypass_actors.push({
        actor_id: 5,
        actor_type: "RepositoryRole",
        bypass_mode: "always",
      }),
    "exactly the human Team and dedicated Dependabot App bypasses",
  ],
  [(after) => (after.bypass_actors[0].bypass_mode = "always"), "Team bypass"],
  [
    (after) => (after.rules[0].creation = false),
    "creation, update, and deletion",
  ],
  [
    (after) => (after.rules[0].deletion = false),
    "creation, update, and deletion",
  ],
  [
    (after) => (after.rules[0].update = false),
    "creation, update, and deletion",
  ],
  [(after) => (after.rules[0].pull_request = [{}]), "contain only creation"],
]) {
  const entry = rulesetEntry();
  mutate(entry.change.after);
  expectFailure(plan([entry]), expected);
}

const unknownActor = rulesetEntry();
unknownActor.change.after_unknown = { bypass_actors: [{ actor_id: true }] };
expectFailure(plan([unknownActor]), "managed fields must be known");

const unknownManagedId = rulesetEntry();
unknownManagedId.change.after_unknown = { ruleset_id: true };
expectFailure(plan([unknownManagedId]), "managed fields must be known");

const computedCreate = structuredClone(initialCreate);
computedCreate.change.after_unknown = {
  etag: true,
  node_id: true,
  ruleset_id: true,
};
expectPass(plan([computedCreate]), BOOTSTRAP_POLICY);

// Phase 3 creates only the disabled lifecycle ruleset while the broker source
// gate is false.
const phaseThreeExtra = {
  address: "google_storage_bucket.unrelated",
  mode: "managed",
  name: "unrelated",
  type: "google_storage_bucket",
  change: { actions: ["create"], before: null, after: {}, after_unknown: {} },
};
expectFailure(
  plan([initialCreate, phaseThreeExtra]),
  "only change",
  BOOTSTRAP_POLICY,
);
expectFailure(
  plan([initialCreate, ...brokerScaffoldEntries({ actions: ["create"] })]),
  "disabled broker-scaffold source gate",
  BOOTSTRAP_POLICY,
);

// Phase 4B requires one reviewed source transition and one coherent creation
// plan. The ruleset is already pinned, disabled, and unchanged.
const phaseFourRuleset = rulesetEntry({ enforcement: "disabled" });
const phaseFourScaffold = brokerScaffoldEntries({ actions: ["create"] });
expectPass(
  plan([
    phaseFourRuleset,
    ...dependabotCredentialEntries(),
    ...phaseFourScaffold,
  ]),
  SCAFFOLD_POLICY,
);
expectFailure(
  plan([phaseFourRuleset, ...phaseFourScaffold, phaseThreeExtra]),
  "may change only the documented five-resource",
  SCAFFOLD_POLICY,
);
expectFailure(
  plan([phaseFourRuleset, ...phaseFourScaffold.slice(1)]),
  "complete five-resource",
  SCAFFOLD_POLICY,
);
expectFailure(
  plan([initialCreate, ...phaseFourScaffold]),
  "broker scaffold enablement requires a source-pinned",
  { ...SCAFFOLD_POLICY, controlled_main_lifecycle_ruleset_id: 0 },
);
const partialScaffold = brokerScaffoldEntries();
partialScaffold[0].change = phaseFourScaffold[0].change;
expectFailure(
  plan([phaseFourRuleset, ...partialScaffold]),
  "create all five resources together",
  SCAFFOLD_POLICY,
);
expectPass(
  plan([
    phaseFourRuleset,
    ...dependabotCredentialEntries(),
    ...partialScaffold,
  ]),
  SCAFFOLD_RECOVERY_POLICY,
);
expectPass(
  plan([
    phaseFourRuleset,
    ...dependabotCredentialEntries(),
    ...partialScaffold,
  ]),
  COMPLETED_DEPENDABOT_SCAFFOLD_RECOVERY_POLICY,
);
expectPass(
  plan([
    phaseFourRuleset,
    ...dependabotCredentialEntries(),
    ...brokerScaffoldEntries(),
  ]),
  SCAFFOLD_RECOVERY_POLICY,
);
expectFailure(
  plan([phaseFourRuleset, ...phaseFourScaffold]),
  "requires at least one existing no-op scaffold member",
  SCAFFOLD_RECOVERY_POLICY,
);
expectFailure(
  plan([phaseFourRuleset, ...partialScaffold, phaseThreeExtra]),
  "partial recovery may change only missing members",
  SCAFFOLD_RECOVERY_POLICY,
);
const recoveryChangedNoOp = structuredClone(partialScaffold);
recoveryChangedNoOp[1].change.after.fixture = "changed-shape";
expectFailure(
  plan([phaseFourRuleset, ...recoveryChangedNoOp]),
  "no-op must preserve the same current resource shape",
  SCAFFOLD_RECOVERY_POLICY,
);
const recoveryCreateWithPriorValue = structuredClone(partialScaffold);
recoveryCreateWithPriorValue[0].change.before = { unexpected: true };
expectFailure(
  plan([phaseFourRuleset, ...recoveryCreateWithPriorValue]),
  "create must have no prior value",
  SCAFFOLD_RECOVERY_POLICY,
);
const recoveryReplacement = brokerScaffoldEntries();
recoveryReplacement[2].change.actions = ["create", "delete"];
expectFailure(
  plan([phaseFourRuleset, ...recoveryReplacement]),
  "partial recovery permits only canonical create and no-op",
  SCAFFOLD_RECOVERY_POLICY,
);
expectFailure(
  plan([activation, ...partialScaffold]),
  "partial recovery requires the enabled scaffold",
  {
    ...SCAFFOLD_RECOVERY_POLICY,
    controlled_main_lifecycle_ruleset_enforcement: "active",
  },
);
expectFailure(
  plan([phaseFourRuleset, ...partialScaffold]),
  "partial recovery requires the enabled scaffold",
  {
    ...SCAFFOLD_RECOVERY_POLICY,
    ruleset_audit_active: true,
  },
);
expectFailure(
  plan([phaseFourRuleset, ...partialScaffold]),
  "partial recovery requires the enabled scaffold",
  {
    ...SCAFFOLD_RECOVERY_POLICY,
    local_agent_github_broker_scaffold_enabled: false,
    local_agent_github_broker_impersonator: "",
  },
);
expectFailure(
  plan([initialCreate, ...partialScaffold]),
  "partial recovery requires the enabled scaffold",
  {
    ...SCAFFOLD_RECOVERY_POLICY,
    controlled_main_lifecycle_ruleset_id: 0,
  },
);
expectFailure(
  plan([activation, ...phaseFourScaffold]),
  "pinned, disabled, unchanged lifecycle ruleset",
  {
    ...SCAFFOLD_POLICY,
    controlled_main_lifecycle_ruleset_enforcement: "active",
  },
);
expectFailure(
  plan([phaseFourRuleset, ...brokerScaffoldEntries()]),
  "disabled broker-scaffold source gate",
  managedDisabledPolicy,
);

const wrongScaffoldIdentity = brokerScaffoldEntries();
wrongScaffoldIdentity[0].address =
  "google_service_account.local_agent_github_broker[1]";
wrongScaffoldIdentity[0].index = 1;
expectFailure(
  plan([phaseFourRuleset, ...wrongScaffoldIdentity]),
  "unexpected identity",
  SCAFFOLD_POLICY,
);
const deletedScaffold = brokerScaffoldEntries();
deletedScaffold[0].change.actions = ["delete"];
expectFailure(
  plan([phaseFourRuleset, ...deletedScaffold]),
  "may only be created, unchanged, or rotate",
  SCAFFOLD_POLICY,
);

const rotationEntries = brokerScaffoldEntries();
rotationEntries[2].change.actions = ["create", "delete"];
expectPass(
  plan([
    phaseFourRuleset,
    ...dependabotCredentialEntries(),
    ...rotationEntries,
  ]),
  SCAFFOLD_POLICY,
);
const rotationWithExtra = structuredClone(rotationEntries);
rotationWithExtra[0].change.actions = ["update"];
expectFailure(
  plan([phaseFourRuleset, ...rotationWithExtra]),
  "may only be created, unchanged, or rotate",
  SCAFFOLD_POLICY,
);

const wrongTeam = rulesetEntry();
wrongTeam.change.after.bypass_actors[0].actor_id = 7;
expectFailure(plan([wrongTeam]), "source-pinned approved Team ID");

const wrongDependabotApp = rulesetEntry();
wrongDependabotApp.change.after.bypass_actors[1].actor_id = 7;
expectFailure(
  plan([wrongDependabotApp]),
  "source-pinned dedicated Dependabot merge App ID",
);
for (const sharedAppId of [15368, 29110]) {
  const sharedIntegration = rulesetEntry({ dependabotAppId: sharedAppId });
  expectFailure(
    plan([sharedIntegration]),
    "shared GitHub Actions and Dependabot integrations",
  );
}
const pullRequestBotBypass = rulesetEntry();
pullRequestBotBypass.change.after.bypass_actors[1].bypass_mode = "pull_request";
expectFailure(plan([pullRequestBotBypass]), "Integration ID in exempt mode");
const thirdBypass = rulesetEntry();
thirdBypass.change.after.bypass_actors.push({
  actor_id: 616161,
  actor_type: "Integration",
  bypass_mode: "exempt",
});
expectFailure(
  plan([thirdBypass]),
  "exactly the human Team and dedicated Dependabot App bypasses",
);
expectFailure(plan(), "distinct local-agent App IDs", {
  ...POLICY_BASE,
  local_agent_github_app_id: 0,
});
expectFailure(plan(), "distinct local-agent App IDs", {
  ...POLICY_BASE,
  local_agent_github_app_id: DEPENDABOT_MERGE_APP_ID,
});
for (const sharedAppId of [15368, 29110]) {
  expectFailure(plan(), "distinct local-agent App IDs", {
    ...POLICY_BASE,
    local_agent_github_app_id: sharedAppId,
  });
}

const mutableMirror = {
  address: "github_actions_variable.human_merge_operator_team_id",
  mode: "managed",
  type: "github_actions_variable",
  name: "human_merge_operator_team_id",
  change: {
    actions: ["create"],
    before: null,
    after: {
      repository: "monitoring-monorepo",
      variable_name: "HUMAN_MERGE_OPERATOR_TEAM_ID",
      value: String(TEAM_ID),
    },
    after_unknown: {},
  },
};
expectFailure(
  plan([rulesetEntry(), mutableMirror]),
  "repository-variable authority is forbidden",
);

const moved = rulesetEntry();
moved.previous_address = MAIN_LIFECYCLE_RULESET_ADDRESS;
expectFailure(plan([moved]), "unexpected resource identity");

// Directly importing the unmanaged core ruleset at the canonical address must
// fail for both update and no-op plans.
for (const actions of [["update"], ["no-op"]]) {
  const importedCore = rulesetEntry({ actions });
  importedCore.change.before = {
    ...rulesetAfter(),
    ruleset_id: CORE_RULESET_ID,
    name: "main",
  };
  expectFailure(plan([importedCore]), "must never adopt core ruleset 13494367");
}

const policyAdoptsCore = {
  ...POLICY_BASE,
  controlled_main_lifecycle_ruleset_id: CORE_RULESET_ID,
};
expectFailure(
  plan(),
  "must never adopt core ruleset 13494367",
  policyAdoptsCore,
);

for (const [mutate, expected] of [
  [
    (value) =>
      (value.configuration.provider_config.github.expressions.owner.constant_value =
        "attacker"),
    "only GitHub provider",
  ],
  [
    (value) =>
      (value.configuration.provider_config.github.expressions.base_url.constant_value =
        "https://example.invalid/"),
    "only GitHub provider",
  ],
  [
    (value) =>
      (value.configuration.provider_config.github.expressions.token = {
        references: ["var.alternate_token"],
      }),
    "use only var.github_token",
  ],
  [
    (value) =>
      (value.configuration.provider_config.github.expressions.token = {
        constant_value: "fixture-literal",
      }),
    "use only var.github_token",
  ],
  [
    (value) =>
      delete value.configuration.provider_config.github.expressions.token,
    "use only var.github_token",
  ],
  [
    (value) =>
      (value.configuration.provider_config.github.expressions.token = {
        references: ["var.github_token", "var.alternate_token"],
      }),
    "use only var.github_token",
  ],
  [
    (value) =>
      (value.configuration.provider_config["github.shadow"] = {
        name: "github",
        full_name: "registry.terraform.io/integrations/github",
        alias: "shadow",
        expressions: {
          owner: { constant_value: "attacker" },
          base_url: { constant_value: "https://example.invalid/" },
          token: { references: ["var.github_token"] },
        },
      }),
    "only GitHub provider",
  ],
  [
    (value) => (value.variables = { github_owner: { value: "attacker" } }),
    "must not expose an overridable github_owner",
  ],
]) {
  const candidate = plan();
  mutate(candidate);
  expectFailure(candidate, expected);
}

const sourcePolicy = SOURCE_MAIN_LIFECYCLE_BOUNDARY_POLICY;
if (!sourcePolicy.controlled_main_lifecycle_resources_enabled) {
  assert.deepEqual(
    validateMainLifecycleBoundaryPlan(plan([]), { policy: sourcePolicy }),
    [],
    "the checked-in inert phase must permit unrelated platform plans with no boundary resources",
  );
  expectFailure(plan(), "inert bootstrap phase requires zero", sourcePolicy);
} else {
  const sourceIsBootstrap =
    sourcePolicy.controlled_main_lifecycle_ruleset_id === 0;
  const sourceEntry = rulesetEntry({
    actions: sourceIsBootstrap ? ["create"] : ["no-op"],
    before: sourceIsBootstrap ? null : undefined,
    enforcement: sourcePolicy.controlled_main_lifecycle_ruleset_enforcement,
    dependabotAppId: sourcePolicy.dependabot_merge_app_id,
    rulesetId: sourceIsBootstrap
      ? undefined
      : sourcePolicy.controlled_main_lifecycle_ruleset_id,
    teamId: sourcePolicy.human_merge_operator_team_id,
  });
  assert.deepEqual(
    validateMainLifecycleBoundaryPlan(plan([sourceEntry]), {
      policy: sourcePolicy,
    }),
    [],
    "the current positive source-policy phase must have a valid exact plan fixture",
  );
}
for (const policy of [
  null,
  { ...POLICY_BASE, controlled_main_lifecycle_resources_enabled: "true" },
  {
    ...INERT_POLICY,
    controlled_main_lifecycle_resources_enabled: false,
    human_merge_operator_team_id: TEAM_ID,
  },
  { ...POLICY_BASE, ruleset_audit_active: "true" },
  { ...POLICY_BASE, dependabot_merge_app_id: 15368 },
  { ...POLICY_BASE, dependabot_merge_app_id: 29110 },
  { ...POLICY_BASE, local_agent_github_app_id: 0 },
  {
    ...POLICY_BASE,
    local_agent_github_app_id: DEPENDABOT_MERGE_APP_ID,
  },
  { ...POLICY_BASE, local_agent_github_app_id: 15368 },
  { ...POLICY_BASE, local_agent_github_app_id: 29110 },
  {
    ...POLICY_BASE,
    dependabot_merge_app_repository_permissions: {
      contents: "write",
      pull_requests: "write",
    },
  },
  {
    ...POLICY_BASE,
    dependabot_merge_app_repository_permissions: {
      actions: "write",
      contents: "write",
      pull_requests: "write",
      workflows: "write",
    },
  },
  { ...POLICY_BASE, dependabot_merge_environment_enabled: "true" },
  { ...POLICY_BASE, human_merge_operator_team_slug: "wrong-team" },
  { ...POLICY_BASE, dependabot_merge_app_credentials_enabled: "true" },
  { ...POLICY_BASE, dependabot_merge_writer_migration_verified: "true" },
  { ...POLICY_BASE, legacy_dependabot_auto_merge_drained: "true" },
  { ...POLICY_BASE, repository: "attacker/repo" },
  { ...POLICY_BASE, local_agent_github_broker_scaffold_enabled: "false" },
  {
    ...POLICY_BASE,
    local_agent_github_broker_partial_recovery_enabled: "false",
  },
  {
    ...POLICY_BASE,
    local_agent_github_broker_scaffold_enabled: false,
    local_agent_github_broker_impersonator: "group:agents@example.com",
  },
  {
    ...POLICY_BASE,
    local_agent_github_broker_scaffold_enabled: true,
    local_agent_github_broker_impersonator: "serviceAccount:not-an-email",
  },
]) {
  assert(
    validateMainLifecycleBoundaryPlan(plan(), { policy }).some((error) =>
      error.includes("source policy must"),
    ),
    "a malformed source policy must fail closed",
  );
}

assert.deepEqual(errorsFor(null), [
  "Terraform plan JSON must include resource_changes",
]);

const terraformSource = readFileSync(
  new URL(
    "../../terraform/github-controlled-main-lifecycle-ruleset.tf",
    import.meta.url,
  ),
  "utf8",
);
const appSource = readFileSync(
  new URL("../../terraform/github-local-agent-app.tf", import.meta.url),
  "utf8",
);
const dependabotSource = readFileSync(
  new URL(
    "../../terraform/github-dependabot-merge-app-credentials.tf",
    import.meta.url,
  ),
  "utf8",
);
const providerSource = readFileSync(
  new URL("../../terraform/providers.tf", import.meta.url),
  "utf8",
);
const variableSource = readFileSync(
  new URL("../../terraform/variables.tf", import.meta.url),
  "utf8",
);
const lifecycleAdrSource = readFileSync(
  new URL(
    "../../docs/adr/0080-controlled-main-lifecycle-boundary.md",
    import.meta.url,
  ),
  "utf8",
);
const lifecycleRunbookSource = readFileSync(
  new URL(
    "../../docs/notes/local-agent-github-app-credential.md",
    import.meta.url,
  ),
  "utf8",
);
const operatingCardSource = readFileSync(
  new URL("../../docs/notes/pr-operating-card.md", import.meta.url),
  "utf8",
);
const terraformDocsSource = readFileSync(
  new URL("../../docs/terraform.md", import.meta.url),
  "utf8",
);
const exactHeadRestContractSources = Object.freeze({
  "ADR 0080": lifecycleAdrSource,
  "controlled lifecycle Terraform": terraformSource,
  "local-agent credential runbook": lifecycleRunbookSource,
  "PR operating card": operatingCardSource,
  "Terraform guide": terraformDocsSource,
});
for (const [sourceName, source] of Object.entries(
  exactHeadRestContractSources,
)) {
  assert.doesNotMatch(
    source,
    /native auto-merge|final merge or auto-merge|absent or attributable to the dedicated App|auto-merge enablement actor|required delayed native auto-merge identity|reliable later update path/iu,
    `${sourceName} must not restore the obsolete native-auto-merge writer design`,
  );
}
assert.match(
  terraformSource,
  /direct[\s\S]*?lifecycle update actor[\s\S]*?one synchronous,[\s\S]*?exact-head REST merge[\s\S]*?leaves no standing auto-merge request/u,
  "the ruleset source must describe the dedicated App as the direct synchronous REST update actor",
);
assert.match(
  lifecycleAdrSource,
  /waits for all required[\s\S]*?checks[\s\S]*?repeats its authoritative proofs[\s\S]*?one synchronous exact-head[\s\S]*?REST merge[\s\S]*?cannot enqueue or leave a standing auto-merge request/u,
  "ADR 0080 must pin the required-check wait, authoritative reproof, and synchronous REST merge contract",
);
assert.match(
  lifecycleRunbookSource,
  /wait for required checks for up to 60 minutes[\s\S]*?Mint[\s\S]*?after that wait[\s\S]*?before the repeated final proof[\s\S]*?every read uses `GH_READ_TOKEN` from `github\.token`[\s\S]*?only the final REST `PUT` receives the App token/u,
  "the migration runbook must mint a fresh App token after the wait and scope it to the final PUT",
);
assert.match(
  lifecycleRunbookSource,
  /Require every open Dependabot pull request to have no auto-merge request[\s\S]*?must not create a replacement request under the[\s\S]*?dedicated App/u,
  "the legacy drain must end with no standing request under any actor",
);
assert.match(
  operatingCardSource,
  /waits for all[\s\S]*?required checks[\s\S]*?repeats its authoritative proofs[\s\S]*?one[\s\S]*?synchronous exact-head REST merge[\s\S]*?creates no standing auto-merge request/u,
  "the operating card must state the synchronous routine Dependabot exception",
);
assert.match(
  terraformDocsSource,
  /wait for required checks[\s\S]*?mint a fresh dedicated[\s\S]*?after that wait[\s\S]*?repeat the complete authoritative proof with[\s\S]*?`github\.token`[\s\S]*?only to one final synchronous[\s\S]*?exact-head REST `PUT`/u,
  "the Terraform guide must preserve the read-token and final-write-token split",
);
assert.match(
  terraformSource,
  /resource "github_repository_ruleset" "controlled_main_lifecycle" \{[\s\S]*?count\s+=\s+local\.controlled_main_lifecycle_resources_enabled \? 1 : 0[\s\S]*?rules \{[\s\S]*?creation = true[\s\S]*?update\s+= true[\s\S]*?deletion = true[\s\S]*?lifecycle \{[\s\S]*?prevent_destroy = true/u,
  "the source must create the protected lifecycle ruleset",
);
assert.match(
  terraformSource,
  /actor_id\s*=\s*local\.human_merge_operator_team_id[\s\S]*?actor_type\s*=\s*"Team"[\s\S]*?bypass_mode\s*=\s*"pull_request"[\s\S]*?actor_id\s*=\s*local\.dependabot_merge_app_id[\s\S]*?actor_type\s*=\s*"Integration"[\s\S]*?bypass_mode\s*=\s*"exempt"/u,
  "the ruleset source must keep exactly the human Team and dedicated Dependabot App bypass modes",
);
assert.equal(
  SOURCE_MAIN_LIFECYCLE_BOUNDARY_POLICY.human_merge_operator_team_slug,
  "merge-operators",
  "reviewed policy must pin the exact new human Team slug",
);
assert.match(
  terraformSource,
  /human_merge_operator_team_slug\s*=\s*local\.main_lifecycle_boundary_policy\.human_merge_operator_team_slug[\s\S]*?local\.human_merge_operator_team_slug == "merge-operators"/u,
  "Terraform must reject a different human merge Team slug",
);
for (const [sourceName, source] of [
  ["ADR 0080", lifecycleAdrSource],
  ["activation runbook", lifecycleRunbookSource],
]) {
  assert.match(
    source,
    /exact slug[\s\S]*?`merge-operators`[\s\S]*?built-in Write/iu,
    `${sourceName} must require the exact Team slug and least built-in repository role`,
  );
}
assert.match(
  terraformSource,
  /!contains\(\[15368, 29110\], local\.dependabot_merge_app_id\)[\s\S]*?local\.local_agent_github_app_id > 0[\s\S]*?!contains\(\[15368, 29110\], local\.local_agent_github_app_id\)[\s\S]*?local\.dependabot_merge_app_id != local\.local_agent_github_app_id/u,
  "the ruleset source must reject the shared Actions App, Dependabot App, and local agent App identities",
);
assert.doesNotMatch(
  variableSource,
  /variable "local_agent_github_app_id"/u,
  "the local-agent App ID must come from reviewed policy source, not an operator tfvar",
);
assert.match(
  appSource,
  /local\.local_agent_github_app_id > 0/u,
  "local-agent credential activation must use the source-pinned App ID",
);
assert.match(
  terraformSource,
  /length\(keys\(local\.dependabot_merge_app_repository_permissions\)\) == 3[\s\S]*?\.contents, null\) == "write"[\s\S]*?\.pull_requests, null\) == "write"[\s\S]*?\.workflows, null\) == "write"/u,
  "the ruleset source must pin the dedicated App's exact three repository permissions",
);
assert.match(
  terraformSource,
  /controlled_main_lifecycle_ruleset_enforcement != "active"[\s\S]*?dependabot_merge_app_credentials_enabled[\s\S]*?dependabot_merge_writer_migration_verified[\s\S]*?legacy_dependabot_auto_merge_drained/u,
  "active enforcement must require credential provisioning, exact-head REST writer migration, and legacy-request absence evidence",
);
assert.match(
  dependabotSource,
  /resource "github_repository_environment" "dependabot_merge"[\s\S]*?can_admins_bypass\s*=\s*false[\s\S]*?deployment_branch_policy \{[\s\S]*?protected_branches\s*=\s*false[\s\S]*?custom_branch_policies\s*=\s*true/u,
  "the credential source must define a custom-policy Environment without admin bypass",
);
assert.match(
  dependabotSource,
  /resource "github_repository_environment_deployment_policy" "dependabot_merge_main"[\s\S]*?environment\s*=\s*github_repository_environment\.dependabot_merge\[0\]\.environment[\s\S]*?branch_pattern\s*=\s*"main"/u,
  "the Environment deployment policy must allow only the exact main branch",
);
assert.match(
  dependabotSource,
  /resource "github_actions_environment_secret" "dependabot_merge_app_id"[\s\S]*?environment\s*=\s*github_repository_environment\.dependabot_merge\[0\]\.environment[\s\S]*?secret_name\s*=\s*"DEPENDABOT_MERGE_APP_ID"[\s\S]*?key_id\s*=\s*var\.dependabot_merge_app_environment_public_key_id[\s\S]*?value_encrypted\s*=\s*var\.dependabot_merge_app_id_encrypted_value[\s\S]*?depends_on\s*=\s*\[[\s\S]*?github_repository_environment_deployment_policy\.dependabot_merge_main/u,
  "the App ID must use the protected Environment secret store after its exact deployment policy exists",
);
assert.equal(
  (
    dependabotSource.match(
      /count\s+=\s+local\.controlled_main_lifecycle_resources_enabled && local\.dependabot_merge_environment_enabled \? 1 : 0/gu,
    ) ?? []
  ).length,
  2,
  "the Environment and policy must stay absent while the Environment source gate is false",
);
assert.equal(
  (
    dependabotSource.match(
      /count\s+=\s+local\.controlled_main_lifecycle_resources_enabled && local\.dependabot_merge_app_credentials_enabled \? 1 : 0/gu,
    ) ?? []
  ).length,
  2,
  "both dedicated-App secrets must stay absent while the credential source gate is false",
);
assert.equal(
  (
    appSource.match(/local\.controlled_main_lifecycle_resources_enabled/gu) ??
    []
  ).length,
  5,
  "all five local-agent broker resources must stay behind the boundary resource gate",
);
assert.match(
  dependabotSource,
  /resource "github_actions_environment_secret" "dependabot_merge_app_private_key"[\s\S]*?environment\s*=\s*github_repository_environment\.dependabot_merge\[0\]\.environment[\s\S]*?secret_name\s*=\s*"DEPENDABOT_MERGE_APP_PRIVATE_KEY"[\s\S]*?key_id\s*=\s*var\.dependabot_merge_app_environment_public_key_id[\s\S]*?value_encrypted\s*=\s*var\.dependabot_merge_app_private_key_encrypted_value[\s\S]*?depends_on\s*=\s*\[[\s\S]*?github_repository_environment_deployment_policy\.dependabot_merge_main/u,
  "the App private key must use the protected Environment secret store after its exact deployment policy exists",
);
assert.doesNotMatch(
  dependabotSource,
  /resource "github_actions_secret" "dependabot_merge_app_/u,
  "the bypass-App credentials must not use repository-wide Actions secrets",
);
assert.doesNotMatch(
  dependabotSource,
  /(?:plaintext_value|\bvalue|\bencrypted_value)\s*=/u,
  "the Dependabot credential resources must never accept plaintext values",
);
const dependabotWorkflowSource = readFileSync(
  new URL("../../.github/workflows/dependabot-auto-merge.yml", import.meta.url),
  "utf8",
);
assert.doesNotMatch(
  dependabotWorkflowSource,
  /^\s*environment:\s*dependabot-merge\s*$/mu,
  "the current writer must not reference the Environment before the protected resource exists live",
);
assert.match(
  lifecycleRunbookSource,
  /create and protect[\s\S]*?dependabot-merge[\s\S]*?Environment[\s\S]*?install[\s\S]*?Environment secrets[\s\S]*?separate reviewed writer change[\s\S]*?environment:\s*dependabot-merge/iu,
  "the runbook must require Environment protection and secrets before a separate writer migration",
);
assert.match(
  appSource,
  /for_each = toset\([\s\S]*?local\.local_agent_github_broker_impersonator/u,
  "the broker impersonator must come from reviewed source",
);
assert.match(
  appSource,
  /local_agent_github_broker_partial_recovery_enabled\s*=\s*local\.main_lifecycle_boundary_policy\.local_agent_github_broker_partial_recovery_enabled/u,
  "the partial-recovery lane must come only from reviewed source",
);
const partialRecoverySourceGate = terraformSource.match(
  /local\.local_agent_github_broker_partial_recovery_enabled == false \|\|\s*\(\s*(local\.local_agent_github_broker_scaffold_enabled[\s\S]*?ruleset_audit_active == false)\s*\)\s*\) &&\s*\(\s*local\.controlled_main_lifecycle_ruleset_enforcement != "active"/u,
)?.[1];
assert.ok(
  partialRecoverySourceGate,
  "the Terraform source must retain one identifiable partial-recovery precondition",
);
assert.match(
  partialRecoverySourceGate,
  /local_agent_github_broker_scaffold_enabled[\s\S]*?controlled_main_lifecycle_ruleset_id > 0[\s\S]*?controlled_main_lifecycle_ruleset_enforcement == "disabled"[\s\S]*?ruleset_audit_active == false/u,
  "the Terraform source must keep partial recovery bounded to the enabled scaffold and pinned disabled ruleset phase",
);
assert.doesNotMatch(
  partialRecoverySourceGate,
  /dependabot_merge_app_credentials_enabled|dependabot_merge_writer_migration_verified|legacy_dependabot_auto_merge_drained/u,
  "partial recovery must preserve the independently reviewed Dependabot gate values instead of forcing them false",
);
assert.doesNotMatch(
  appSource,
  /var\.local_agent_github_app_private_key\s*!=\s*""/u,
  "an ephemeral App key must not enter a managed-resource lifecycle precondition",
);
assert.doesNotMatch(
  appSource,
  /precondition\s*\{[^}]*var\.local_agent_github_app_private_key(?![A-Za-z0-9_])/u,
  "the ephemeral App key must stay out of every managed-resource precondition",
);
assert.match(
  appSource,
  /secret_data_wo\s*=\s*var\.local_agent_github_app_private_key/u,
  "the ephemeral App key must terminate at the write-only Secret Manager field",
);
assert.doesNotMatch(
  appSource,
  /secret_data\s*=\s*var\.local_agent_github_app_private_key/u,
  "the App key must never enter Terraform state through the ordinary secret-data field",
);
for (const resource of [
  "google_service_account",
  "google_secret_manager_secret",
  "google_secret_manager_secret_version",
  "google_secret_manager_secret_iam_member",
  "google_service_account_iam_member",
]) {
  assert.match(
    appSource,
    new RegExp(
      `resource "${resource}"[\\s\\S]*?local_agent_github_broker_scaffold_enabled`,
      "u",
    ),
    `${resource} must stay behind the reviewed broker-scaffold source gate`,
  );
}

const canonicalBase64Lines =
  "(?:[A-Za-z0-9+/]{64}\\n)*(?:[A-Za-z0-9+/]{4}){0,15}(?:[A-Za-z0-9+/]{4}|[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=|[A-Za-z0-9+/][AQgw]==)";
const pkcs1Pattern = new RegExp(
  `^-----BEGIN RSA PRIVATE KEY-----\\n${canonicalBase64Lines}\\n-----END RSA PRIVATE KEY-----\\n?$`,
  "u",
);
const pkcs8Pattern = new RegExp(
  `^-----BEGIN PRIVATE KEY-----\\n${canonicalBase64Lines}\\n-----END PRIVATE KEY-----\\n?$`,
  "u",
);
const pkcs8Begin = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
const pkcs8End = ["-----END", "PRIVATE KEY-----"].join(" ");
function acceptsPrivateKeyEnvelopeFixture(value, active = true) {
  const key = value ?? "";
  return (
    !active ||
    (Buffer.byteLength(key, "utf8") <= 65536 &&
      (pkcs1Pattern.test(key) || pkcs8Pattern.test(key)))
  );
}
function bigIntBuffer(value) {
  let hexadecimal = value.toString(16);
  if (hexadecimal.length % 2 === 1) hexadecimal = `0${hexadecimal}`;
  return Buffer.from(hexadecimal, "hex");
}
function nextDeterministicPrime(start) {
  let candidate = start | 1n;
  while (!checkPrimeSync(bigIntBuffer(candidate), { checks: 32 })) {
    candidate += 2n;
  }
  return candidate;
}
function extendedGcd(left, right) {
  if (right === 0n) return [left, 1n, 0n];
  const [divisor, x, y] = extendedGcd(right, left % right);
  return [divisor, y, x - (left / right) * y];
}
function modularInverse(value, modulus) {
  const [divisor, inverse] = extendedGcd(value, modulus);
  assert.equal(divisor, 1n, "deterministic RSA fixture inputs must be coprime");
  return ((inverse % modulus) + modulus) % modulus;
}
export function deterministicRsaTestKey() {
  // Fixed prime-search starts produce a synthetic key on every run. No
  // generated or operator credential is stored in source or test output.
  const base = 3n << 1022n;
  const p = nextDeterministicPrime(base + 0x123456789abcdefn);
  const q = nextDeterministicPrime(base + 0xfedcba987654321n);
  const e = 65537n;
  const d = modularInverse(e, (p - 1n) * (q - 1n));
  const base64Url = (value) => bigIntBuffer(value).toString("base64url");
  return createPrivateKey({
    format: "jwk",
    key: {
      kty: "RSA",
      n: base64Url(p * q),
      e: base64Url(e),
      d: base64Url(d),
      p: base64Url(p),
      q: base64Url(q),
      dp: base64Url(d % (p - 1n)),
      dq: base64Url(d % (q - 1n)),
      qi: base64Url(modularInverse(q, p)),
    },
  });
}
const deterministicKey = deterministicRsaTestKey();
const validPkcs1 = deterministicKey
  .export({
    format: "pem",
    type: "pkcs1",
  })
  .toString();
const validPkcs8 = deterministicKey
  .export({
    format: "pem",
    type: "pkcs8",
  })
  .toString();
const nonCanonicalPkcs1 = validPkcs1.replace(
  /([AQgw])==(?=\n-----END RSA PRIVATE KEY-----)/u,
  (_, finalCharacter) =>
    `${{ A: "B", Q: "R", g: "h", w: "x" }[finalCharacter]}==`,
);
assert.notEqual(
  nonCanonicalPkcs1,
  validPkcs1,
  "the deterministic PKCS#1 fixture must end with double padding",
);
const pemBody = (value) => value.split("\n").slice(1, -2).join("");
assert.equal(
  Buffer.compare(
    Buffer.from(pemBody(nonCanonicalPkcs1), "base64"),
    Buffer.from(pemBody(validPkcs1), "base64"),
  ),
  0,
  "the pad-bit mutation must decode to the same deterministic DER bytes",
);
const oversizedPkcs8 = `${pkcs8Begin}\n${`${"A".repeat(64)}\n`.repeat(1024)}${pkcs8End}\n`;
for (const [label, value, accepted] of [
  ["omitted", undefined, false],
  ["blank", "", false],
  ["malformed", "-----BEGIN PRIVATE KEY-----\nnot pem!\n", false],
  [
    "padding before the final quantum",
    `${pkcs8Begin}\nQU=JDRA=\n${pkcs8End}\n`,
    false,
  ],
  [
    "noncanonical short line",
    `${pkcs8Begin}\nQUJD\nRA==\n${pkcs8End}\n`,
    false,
  ],
  [
    "canonical non-DER envelope",
    `${pkcs8Begin}\nQUJDRA==\n${pkcs8End}\n`,
    true,
  ],
  ["oversized", oversizedPkcs8, false],
  ["noncanonical PKCS#1 pad bits", nonCanonicalPkcs1, false],
  ["valid PKCS#1", validPkcs1, true],
  ["valid PKCS#8", validPkcs8, true],
]) {
  assert.equal(
    acceptsPrivateKeyEnvelopeFixture(value),
    accepted,
    `${label} private-key fixture has the wrong activation result`,
  );
}
assert.equal(
  acceptsPrivateKeyEnvelopeFixture("", false),
  true,
  "an inactive credential must not require key material",
);
assert.match(
  variableSource,
  /sensitive\s*=\s*true[\s\S]*?ephemeral\s*=\s*true[\s\S]*?length\(var\.local_agent_github_app_private_key\) <= 65536/u,
  "the App key must stay sensitive, ephemeral, and bounded",
);
for (const pattern of [
  "^-----BEGIN RSA PRIVATE KEY-----\\\\n([A-Za-z0-9+/]{64}\\\\n)*([A-Za-z0-9+/]{4}){0,15}([A-Za-z0-9+/]{4}|[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=|[A-Za-z0-9+/][AQgw]==)\\\\n-----END RSA PRIVATE KEY-----\\\\n?$",
  "^-----BEGIN PRIVATE KEY-----\\\\n([A-Za-z0-9+/]{64}\\\\n)*([A-Za-z0-9+/]{4}){0,15}([A-Za-z0-9+/]{4}|[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=|[A-Za-z0-9+/][AQgw]==)\\\\n-----END PRIVATE KEY-----\\\\n?$",
]) {
  assert(
    variableSource.includes(`can(regex("${pattern}"`),
    "Terraform activation validation must retain the exact tested PEM envelope patterns",
  );
}
assert.match(
  providerSource,
  /provider "github" \{\s*owner\s*=\s*"mento-protocol"\s*base_url\s*=\s*"https:\/\/api\.github\.com\/"\s*token\s*=\s*var\.github_token\s*\}/u,
  "the GitHub provider must stay source-bound to the public mento-protocol target",
);
assert.doesNotMatch(
  variableSource,
  /variable "(?:github_owner|human_merge_operator_team_id|local_agent_github_broker_impersonators)"/u,
  "the provider owner, Team actor, and broker impersonator must not become operator variables",
);
