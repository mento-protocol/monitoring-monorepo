#!/usr/bin/env node

import assert from "node:assert/strict";

import {
  METRICS_BRIDGE_SERVICE_ADDRESS,
  PEG_POLICY_BUCKET_CONTROLLER_ADDRESS,
  parseMetricsBridgeTemplateRolloutActive,
  validateMetricsBridgeTemplatePlan,
} from "./check-metrics-bridge-template-plan.mjs";

const LIVE_REVISION = "metrics-bridge-r-8a3d876-31435028185";

function markerSource(value = "false") {
  return `locals {
  metrics_bridge_template_rollout_active = ${value}
}
`;
}

function template(revision = LIVE_REVISION, generation = "1785276001213660") {
  return [
    {
      revision,
      service_account: "metrics-bridge-runtime@example.invalid",
      scaling: [{ min_instance_count: 1, max_instance_count: 1 }],
      containers: [
        {
          image: "example.invalid/metrics-bridge@sha256:deadbeef",
          env: [
            { name: "HASURA_URL", value: "https://example.invalid/graphql" },
            { name: "PEG_POLICY_URL", value: `gs://policy/${generation}` },
          ],
          resources: [{ limits: { cpu: "1", memory: "512Mi" } }],
        },
      ],
    },
  ];
}

function serviceChange({
  actions = ["no-op"],
  beforeTemplate = template(),
  afterTemplate = structuredClone(beforeTemplate),
  afterUnknown = {},
  identity = {},
  before = {},
  after = {},
} = {}) {
  return {
    address: METRICS_BRIDGE_SERVICE_ADDRESS,
    mode: "managed",
    type: "google_cloud_run_v2_service",
    name: "metrics_bridge",
    ...identity,
    change: {
      actions,
      before: {
        deletion_protection: true,
        template: beforeTemplate,
        ...before,
      },
      after: { deletion_protection: true, template: afterTemplate, ...after },
      after_unknown: afterUnknown,
    },
  };
}

function plan(resourceChanges, overrides = {}) {
  return {
    format_version: "1.2",
    terraform_version: "1.14.0",
    applyable: true,
    complete: true,
    errored: false,
    resource_changes: resourceChanges,
    ...overrides,
  };
}

function errorsFor(candidate, options = {}) {
  return validateMetricsBridgeTemplatePlan(candidate, {
    rolloutActive: false,
    requireService: true,
    ...options,
  });
}

function expectPass(candidate, options) {
  assert.deepEqual(errorsFor(candidate, options), []);
}

function expectFailure(candidate, expected, options) {
  const errors = errorsFor(candidate, options);
  assert(
    errors.some((error) => error.includes(expected)),
    `expected ${JSON.stringify(errors)} to include ${JSON.stringify(expected)}`,
  );
}

assert.equal(parseMetricsBridgeTemplateRolloutActive(markerSource()), false);
assert.equal(
  parseMetricsBridgeTemplateRolloutActive(markerSource("true")),
  true,
);
for (const source of [
  "locals {}\n",
  markerSource('"false"'),
  markerSource("local.enabled"),
  `locals {
  metrics_bridge_template_rollout_active = false
  metrics_bridge_template_rollout_active = true
}`,
  `# metrics_bridge_template_rollout_active = false
locals { other = true }
`,
  `resource "terraform_data" "marker" {
  metrics_bridge_template_rollout_active = false
}`,
  `locals {
  note = <<EOT
  metrics_bridge_template_rollout_active = false
EOT
}`,
  "locals {\n  metrics_bridge_template_rollout_active = false\n",
]) {
  assert.throws(
    () => parseMetricsBridgeTemplateRolloutActive(source),
    /Metrics Bridge|Invalid Metrics Bridge/u,
  );
}

expectPass(plan([serviceChange()]));
expectPass(plan([serviceChange()], { applyable: false }));
expectPass(
  plan([
    serviceChange({
      actions: ["update"],
      after: { deletion_protection: false },
    }),
  ]),
);
expectPass(
  plan([
    serviceChange({
      actions: ["update"],
      beforeTemplate: [
        {
          revision: LIVE_REVISION,
          containers: [{ env: [{ name: "A", value: "B" }] }],
          scaling: [{ min_instance_count: 1 }],
        },
      ],
      afterTemplate: [
        {
          scaling: [{ min_instance_count: 1 }],
          containers: [{ env: [{ name: "A", value: "B" }] }],
          revision: LIVE_REVISION,
        },
      ],
      after: { deletion_protection: false },
    }),
  ]),
);

const changedGenerationTemplate = template(LIVE_REVISION, "1785276001213661");
expectFailure(
  plan([
    serviceChange({
      actions: ["update"],
      afterTemplate: changedGenerationTemplate,
    }),
  ]),
  "must not change or obscure the service template",
);
expectFailure(
  plan([
    serviceChange({
      actions: ["update"],
      afterTemplate: template(null),
    }),
  ]),
  "must not change or obscure the service template",
);
expectFailure(
  plan([
    serviceChange({
      actions: ["update"],
      afterUnknown: { template: [{ containers: [{ env: true }] }] },
    }),
  ]),
  "must not change or obscure the service template",
);
expectFailure(
  plan([serviceChange({ actions: ["delete"] })]),
  "must be a no-op or in-place update",
);
expectFailure(plan([]), "must contain the Metrics Bridge service");
expectFailure(
  plan([
    serviceChange(),
    serviceChange({
      identity: { address: `module.child.${METRICS_BRIDGE_SERVICE_ADDRESS}` },
    }),
  ]),
  "one canonical Metrics Bridge entry",
);
expectFailure(
  plan([
    serviceChange({
      identity: { previous_address: METRICS_BRIDGE_SERVICE_ADDRESS },
    }),
  ]),
  "unexpected resource identity",
);
expectFailure(
  plan([serviceChange({ identity: { index: 0 } })]),
  "unexpected resource identity",
);
expectFailure(
  plan([
    serviceChange({
      identity: { address: `module.child.${METRICS_BRIDGE_SERVICE_ADDRESS}` },
    }),
  ]),
  "unexpected resource identity",
);

expectPass(
  plan([
    serviceChange({
      actions: ["update"],
      afterTemplate: template(null, "1785276001213661"),
    }),
  ]),
  { rolloutActive: true },
);
expectFailure(
  plan([serviceChange()]),
  "rollout must be exactly one in-place update",
  { rolloutActive: true },
);
expectFailure(
  plan([serviceChange({ actions: ["update"], afterTemplate: template(null) })]),
  "requires a known managed template change",
  { rolloutActive: true },
);
expectFailure(
  plan([
    serviceChange({
      actions: ["update"],
      afterTemplate: template("new-revision", "1785276001213661"),
    }),
  ]),
  "must clear the generated revision name",
  { rolloutActive: true },
);
expectFailure(
  plan([
    serviceChange({
      actions: ["update"],
      beforeTemplate: template(null),
      afterTemplate: template(null, "1785276001213661"),
    }),
  ]),
  "requires a named live revision",
  { rolloutActive: true },
);
expectFailure(
  plan([
    serviceChange({
      actions: ["update"],
      afterTemplate: template(null, "1785276001213661"),
      afterUnknown: { template: [{ revision: true }] },
    }),
  ]),
  "revision must be known",
  { rolloutActive: true },
);
const oldRevisionRetainedElsewhere = template(null, "1785276001213661");
oldRevisionRetainedElsewhere[0].annotations = { old: LIVE_REVISION };
expectFailure(
  plan([
    serviceChange({
      actions: ["update"],
      afterTemplate: oldRevisionRetainedElsewhere,
    }),
  ]),
  "must not retain the old revision name",
  { rolloutActive: true },
);

const recoveryRoleCreate = {
  address: PEG_POLICY_BUCKET_CONTROLLER_ADDRESS,
  mode: "managed",
  type: "google_project_iam_custom_role",
  name: "peg_policy_bucket_controller",
  change: { actions: ["create"], before: null, after: {} },
};
expectPass(plan([recoveryRoleCreate], { complete: false }), {
  requireService: false,
  recoveryTargetOnly: true,
});
expectFailure(
  plan([recoveryRoleCreate], { complete: false }),
  "rollout mode forbids targeted platform recovery",
  {
    rolloutActive: true,
    requireService: false,
    recoveryTargetOnly: true,
  },
);
expectFailure(
  plan(
    [
      recoveryRoleCreate,
      {
        address: "google_project_service.storage",
        mode: "managed",
        change: { actions: ["create"], before: null, after: {} },
      },
    ],
    { complete: false },
  ),
  "may only create the Peg policy bucket controller role",
  { requireService: false, recoveryTargetOnly: true },
);
expectFailure(
  plan(
    [
      {
        ...recoveryRoleCreate,
        change: { actions: ["update"], before: {}, after: {} },
      },
    ],
    { complete: false },
  ),
  "may only create the Peg policy bucket controller role",
  { requireService: false, recoveryTargetOnly: true },
);
expectFailure(
  plan([{ ...recoveryRoleCreate, deposed: "deadbeef" }], { complete: false }),
  "may only create the Peg policy bucket controller role",
  { requireService: false, recoveryTargetOnly: true },
);

for (const [overrides, expected] of [
  [{ format_version: "2.0" }, "format major 1"],
  [{ complete: false }, "must be complete"],
  [{ errored: true }, "must not be errored"],
  [{ applyable: "yes" }, "must declare whether it is applyable"],
  [{ deferred_changes: [{}] }, "must not contain deferred changes"],
  [{ action_invocations: [{}] }, "must not contain action invocations"],
]) {
  expectFailure(plan([serviceChange()], overrides), expected);
}
expectFailure(
  plan(
    [
      serviceChange({
        actions: ["update"],
        afterTemplate: template(null, "1785276001213661"),
      }),
    ],
    { complete: false },
  ),
  "must be complete",
  { rolloutActive: true },
);
expectFailure(
  plan(
    [
      serviceChange({
        actions: ["update"],
        after: { deletion_protection: false },
      }),
    ],
    { applyable: false },
  ),
  "mutations must be applyable",
);

process.stdout.write("Metrics Bridge template plan tests passed.\n");
