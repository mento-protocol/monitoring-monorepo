#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  CORE_RULESET_ID,
  HUMAN_LIFECYCLE_RULESET_ADDRESS,
  SOURCE_HUMAN_MERGE_BOUNDARY_POLICY,
  validateHumanMergeBoundaryPlan,
} from "./check-human-merge-boundary-plan.mjs";

const TEAM_ID = 424242;
const MANAGED_RULESET_ID = 24680;
const BROKER_IMPERSONATOR =
  "serviceAccount:local-agent-broker@mento-monitoring.iam.gserviceaccount.com";
const POLICY_BASE = Object.freeze({
  repository: "mento-protocol/monitoring-monorepo",
  human_merge_operator_team_id: TEAM_ID,
  human_main_lifecycle_ruleset_id: MANAGED_RULESET_ID,
  human_main_lifecycle_ruleset_enforcement: "active",
  ruleset_audit_active: false,
  local_agent_github_broker_scaffold_enabled: false,
  local_agent_github_broker_impersonator: "",
});
const BOOTSTRAP_POLICY = Object.freeze({
  ...POLICY_BASE,
  human_main_lifecycle_ruleset_id: 0,
  human_main_lifecycle_ruleset_enforcement: "disabled",
});
const SCAFFOLD_POLICY = Object.freeze({
  ...POLICY_BASE,
  human_main_lifecycle_ruleset_enforcement: "disabled",
  local_agent_github_broker_scaffold_enabled: true,
  local_agent_github_broker_impersonator: BROKER_IMPERSONATOR,
});

function rulesetAfter({
  enforcement = "active",
  rulesetId = MANAGED_RULESET_ID,
  teamId = TEAM_ID,
} = {}) {
  const after = {
    name: "human-only-main-lifecycle",
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
  enforcement = "active",
  rulesetId = MANAGED_RULESET_ID,
  teamId = TEAM_ID,
} = {}) {
  const after = rulesetAfter({ enforcement, rulesetId, teamId });
  return {
    address: HUMAN_LIFECYCLE_RULESET_ADDRESS,
    mode: "managed",
    type: "github_repository_ruleset",
    name: "human_only_main_lifecycle",
    change: {
      actions,
      before: before === undefined ? structuredClone(after) : before,
      after,
      after_unknown: {},
    },
  };
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

function plan(entries = [rulesetEntry()]) {
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
    resource_changes: entries,
  };
}

function errorsFor(candidate, policy = POLICY_BASE, options = {}) {
  return validateHumanMergeBoundaryPlan(candidate, {
    policy,
    ...options,
  });
}

function expectPass(candidate, policy = POLICY_BASE, options = {}) {
  assert.deepEqual(errorsFor(candidate, policy, options), []);
}

function expectFailure(candidate, expected, policy = POLICY_BASE) {
  const errors = errorsFor(candidate, policy);
  assert(
    errors.some((error) => error.includes(expected)),
    `expected ${JSON.stringify(errors)} to include ${JSON.stringify(expected)}`,
  );
}

// Steady-state and forward-only activation plans.
expectPass(plan());
expectPass(
  plan([rulesetEntry({ enforcement: "disabled" }), ...brokerScaffoldEntries()]),
  SCAFFOLD_POLICY,
);
const activation = rulesetEntry({ actions: ["update"] });
activation.change.before.enforcement = "disabled";
expectPass(plan([activation]));

const activationWithComputedChurn = structuredClone(activation);
activationWithComputedChurn.change.after.etag = "updated-fixture-etag";
activationWithComputedChurn.change.after.node_id = "updated-fixture-node";
expectPass(plan([activationWithComputedChurn]));

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
    human_main_lifecycle_ruleset_enforcement: "disabled",
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
  human_main_lifecycle_ruleset_enforcement: "disabled",
};
expectPass(
  plan([
    rulesetEntry({
      enforcement: "disabled",
    }),
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

for (const policy of [
  {
    ...BOOTSTRAP_POLICY,
    human_main_lifecycle_ruleset_enforcement: "active",
  },
  { ...BOOTSTRAP_POLICY, ruleset_audit_active: true },
]) {
  expectFailure(
    plan([initialCreate]),
    "initial lifecycle ruleset creation requires",
    policy,
  );
}

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

expectFailure(plan([]), "one canonical human lifecycle ruleset");
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
    "exactly one Team bypass",
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

// Phase 4 requires one reviewed source transition and one coherent creation
// plan. The ruleset is already pinned, disabled, and unchanged.
const phaseFourRuleset = rulesetEntry({ enforcement: "disabled" });
const phaseFourScaffold = brokerScaffoldEntries({ actions: ["create"] });
expectPass(plan([phaseFourRuleset, ...phaseFourScaffold]), SCAFFOLD_POLICY);
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
  { ...SCAFFOLD_POLICY, human_main_lifecycle_ruleset_id: 0 },
);
const partialScaffold = brokerScaffoldEntries();
partialScaffold[0].change = phaseFourScaffold[0].change;
expectFailure(
  plan([phaseFourRuleset, ...partialScaffold]),
  "create all five resources together",
  SCAFFOLD_POLICY,
);
expectFailure(
  plan([activation, ...phaseFourScaffold]),
  "pinned, disabled, unchanged lifecycle ruleset",
  { ...SCAFFOLD_POLICY, human_main_lifecycle_ruleset_enforcement: "active" },
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
expectPass(plan([phaseFourRuleset, ...rotationEntries]), SCAFFOLD_POLICY);
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
moved.previous_address = HUMAN_LIFECYCLE_RULESET_ADDRESS;
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
  human_main_lifecycle_ruleset_id: CORE_RULESET_ID,
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

const sourcePolicy = SOURCE_HUMAN_MERGE_BOUNDARY_POLICY;
if (sourcePolicy.human_merge_operator_team_id === 0) {
  const sourceErrors = validateHumanMergeBoundaryPlan(plan(), {
    policy: sourcePolicy,
  });
  assert(
    sourceErrors.some((error) =>
      error.includes("replace the zero Team sentinel"),
    ),
    "a checked-in Team sentinel must fail closed",
  );
} else {
  const sourceIsBootstrap = sourcePolicy.human_main_lifecycle_ruleset_id === 0;
  const sourceEntry = rulesetEntry({
    actions: sourceIsBootstrap ? ["create"] : ["no-op"],
    before: sourceIsBootstrap ? null : undefined,
    enforcement: sourcePolicy.human_main_lifecycle_ruleset_enforcement,
    rulesetId: sourceIsBootstrap
      ? undefined
      : sourcePolicy.human_main_lifecycle_ruleset_id,
    teamId: sourcePolicy.human_merge_operator_team_id,
  });
  assert.deepEqual(
    validateHumanMergeBoundaryPlan(plan([sourceEntry]), {
      policy: sourcePolicy,
    }),
    [],
    "the current positive source-policy phase must have a valid exact plan fixture",
  );
}
for (const policy of [
  null,
  { ...POLICY_BASE, ruleset_audit_active: "true" },
  { ...POLICY_BASE, repository: "attacker/repo" },
  { ...POLICY_BASE, local_agent_github_broker_scaffold_enabled: "false" },
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
    validateHumanMergeBoundaryPlan(plan(), { policy }).some((error) =>
      error.includes("source policy must pin"),
    ),
    "a malformed source policy must fail closed",
  );
}

assert.deepEqual(errorsFor(null), [
  "Terraform plan JSON must include resource_changes",
]);

const terraformSource = readFileSync(
  new URL("../../terraform/github-main-lifecycle-ruleset.tf", import.meta.url),
  "utf8",
);
const appSource = readFileSync(
  new URL("../../terraform/github-local-agent-app.tf", import.meta.url),
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
assert.match(
  terraformSource,
  /resource "github_repository_ruleset" "human_only_main_lifecycle" \{[\s\S]*?rules \{[\s\S]*?creation = true[\s\S]*?update\s+= true[\s\S]*?deletion = true[\s\S]*?lifecycle \{[\s\S]*?prevent_destroy = true/u,
  "the source must create the protected lifecycle ruleset",
);
assert.doesNotMatch(
  terraformSource,
  /actor_type\s*=\s*"Integration"/u,
  "the ruleset source must not restore a GitHub Actions Integration bypass",
);
assert.match(
  appSource,
  /for_each = toset\([\s\S]*?local\.local_agent_github_broker_impersonator/u,
  "the broker impersonator must come from reviewed source",
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

const pkcs1Pattern =
  /^-----BEGIN RSA PRIVATE KEY-----\n([A-Za-z0-9+/=]{4,64}\n)+-----END RSA PRIVATE KEY-----\n?$/u;
const pkcs8Pattern =
  /^-----BEGIN PRIVATE KEY-----\n([A-Za-z0-9+/=]{4,64}\n)+-----END PRIVATE KEY-----\n?$/u;
const pkcs1Begin = ["-----BEGIN RSA", "PRIVATE KEY-----"].join(" ");
const pkcs1End = ["-----END RSA", "PRIVATE KEY-----"].join(" ");
const pkcs8Begin = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
const pkcs8End = ["-----END", "PRIVATE KEY-----"].join(" ");
function acceptsPrivateKeyFixture(value, active = true) {
  const key = value ?? "";
  return (
    !active ||
    (Buffer.byteLength(key, "utf8") <= 65536 &&
      (pkcs1Pattern.test(key) || pkcs8Pattern.test(key)))
  );
}
const validPkcs1 = `${pkcs1Begin}\nQUJDRA==\n${pkcs1End}\n`;
const validPkcs8 = `${pkcs8Begin}\nQUJDRA==\n${pkcs8End}\n`;
const oversizedPkcs8 = `${pkcs8Begin}\n${`${"A".repeat(64)}\n`.repeat(1024)}${pkcs8End}\n`;
for (const [label, value, accepted] of [
  ["omitted", undefined, false],
  ["blank", "", false],
  ["malformed", "-----BEGIN PRIVATE KEY-----\nnot pem!\n", false],
  ["oversized", oversizedPkcs8, false],
  ["valid PKCS#1", validPkcs1, true],
  ["valid PKCS#8", validPkcs8, true],
]) {
  assert.equal(
    acceptsPrivateKeyFixture(value),
    accepted,
    `${label} private-key fixture has the wrong activation result`,
  );
}
assert.equal(
  acceptsPrivateKeyFixture("", false),
  true,
  "an inactive credential must not require key material",
);
assert.match(
  variableSource,
  /sensitive\s*=\s*true[\s\S]*?ephemeral\s*=\s*true[\s\S]*?length\(var\.local_agent_github_app_private_key\) <= 65536/u,
  "the App key must stay sensitive, ephemeral, and bounded",
);
for (const pattern of [
  "^-----BEGIN RSA PRIVATE KEY-----\\\\n([A-Za-z0-9+/=]{4,64}\\\\n)+-----END RSA PRIVATE KEY-----\\\\n?$",
  "^-----BEGIN PRIVATE KEY-----\\\\n([A-Za-z0-9+/=]{4,64}\\\\n)+-----END PRIVATE KEY-----\\\\n?$",
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
