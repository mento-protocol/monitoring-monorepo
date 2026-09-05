/**
 * Part of the quality gate's routing table. Read
 * `scripts/gate/routing-table/index.mjs` first: it owns the group order, the
 * schema, and the pairing lint, and it is the only module anything outside this
 * directory should import.
 *
 * ORDER IS ROUTING. Arms match first-to-last within a group, so an arm's index
 * is its precedence: move one and the gate schedules something else. Nothing
 * checks that. `routing-table.test.mjs` pins only the GROUP order, against a
 * written-out list.
 */

/**
 * The remaining workspace-package arms of the `tree` group: the metrics bridge,
 * the integration probes, Aegis, and the shared configuration package.
 */
export const SERVICE_ARMS = [
  {
    patterns: ["metrics-bridge/*"],
    effects: [
      { surface: "metrics-bridge" },
      {
        dispatch: "path",
        arms: [
          {
            patterns: ["metrics-bridge/peg-registry.json"],
            effects: [
              {
                verb: "add_peg_registry_integrity_check",
                args: ["peg registry changed"],
              },
            ],
          },
        ],
      },
      {
        dispatch: "path",
        arms: [
          {
            patterns: ["metrics-bridge/src/*"],
            effects: [
              {
                checklist: "docs/pr-checklists/stateful-data-ui.md",
                reason: "metrics bridge data flow changed",
              },
              {
                checklist: "docs/pr-checklists/terraform-cloudrun.md",
                reason: "metrics bridge Cloud Run runtime changed",
              },
            ],
          },
        ],
      },
      {
        dispatch: "path",
        arms: [
          {
            patterns: [
              "metrics-bridge/src/metrics.ts",
              "metrics-bridge/src/cdp-metrics.ts",
              "metrics-bridge/src/peg/metrics.ts",
              "metrics-bridge/src/peg/listing-metrics.ts",
            ],
            effects: [
              {
                command: "pnpm alerts:rules:lint",
                reason:
                  "metrics-bridge gauge registry changed (alerts cross-check)",
              },
            ],
          },
        ],
      },
      {
        dispatch: "path",
        arms: [
          {
            patterns: [
              "metrics-bridge/Dockerfile",
              "metrics-bridge/.dockerignore",
            ],
            effects: [
              {
                checklist: "docs/pr-checklists/terraform-cloudrun.md",
                reason: "metrics bridge Cloud Run runtime changed",
              },
            ],
          },
        ],
      },
      {
        dispatch: "path",
        arms: [
          {
            patterns: [
              "metrics-bridge/stryker.config.mjs",
              "metrics-bridge/vitest.mutation.config.ts",
              "metrics-bridge/src/rebalance-probe.ts",
              "metrics-bridge/test/rebalance-probe.test.ts",
            ],
            effects: [
              {
                checklist: "docs/pr-checklists/mutation-testing.md",
                reason: "metrics bridge mutation baseline changed",
              },
              {
                verb: "add_bridge_mutation_baseline",
                args: ["metrics bridge mutation baseline changed"],
              },
            ],
          },
        ],
      },
      {
        verb: "add_package_quality_commands",
        args: ["@mento-protocol/metrics-bridge", "metrics-bridge changed"],
      },
    ],
  },
  {
    patterns: ["integration-probes/*"],
    effects: [
      { surface: "integration-probes" },
      {
        dispatch: "path",
        arms: [
          {
            patterns: ["integration-probes/src/*"],
            effects: [
              {
                checklist: "docs/pr-checklists/stateful-data-ui.md",
                reason: "integration probe data flow changed",
              },
            ],
          },
        ],
      },
      {
        verb: "add_package_quality_commands",
        args: [
          "@mento-protocol/integration-probes",
          "integration-probes changed",
        ],
      },
    ],
  },
  {
    patterns: ["aegis/*"],
    effects: [
      { surface: "aegis" },
      {
        dispatch: "path",
        arms: [
          {
            patterns: [
              "aegis/src/*",
              "aegis/config.yaml",
              "aegis/app.yaml",
              "aegis/contracts/*",
              "aegis/foundry.toml",
              "aegis/foundry.lock",
              "aegis/package.json",
              "aegis/tsconfig*.json",
              "aegis/nest-cli.json",
              "aegis/eslint.config.js",
              "aegis/eslint-baseline.json",
            ],
            effects: [
              { verb: "add_aegis_quality_commands", args: ["aegis changed"] },
            ],
          },
          {
            patterns: ["aegis/terraform/*"],
            effects: [
              {
                verb: "add_terraform_validate_commands",
                args: ["aegis/terraform", "Aegis Terraform changed"],
              },
              {
                checklist: "docs/pr-checklists/ci-workflow-gates.md",
                reason: "Aegis Terraform/deploy-adjacent path changed",
              },
            ],
          },
          {
            patterns: ["aegis/grafana-agent/*", "aegis/bin/*"],
            effects: [
              {
                verb: "add_aegis_quality_commands",
                args: ["aegis runtime/deploy path changed"],
              },
              {
                checklist: "docs/pr-checklists/ci-workflow-gates.md",
                reason: "Aegis deploy path changed",
              },
            ],
          },
          {
            patterns: ["aegis/lib/*"],
            effects: [
              {
                command: "cd aegis && forge test",
                reason: "Aegis Foundry dependency changed",
              },
            ],
          },
        ],
      },
    ],
  },
  {
    patterns: ["shared-config/*"],
    effects: [
      { surface: "shared-config" },
      {
        verb: "add_package_quality_commands",
        args: ["@mento-protocol/config", "shared-config changed"],
      },
      {
        command: "pnpm --filter @mento-protocol/config build",
        reason: "shared-config exports changed",
      },
      {
        command: "pnpm --filter @mento-protocol/ui-dashboard typecheck",
        reason: "shared-config consumers should typecheck",
      },
      {
        command: "pnpm --filter @mento-protocol/metrics-bridge typecheck",
        reason: "shared-config consumers should typecheck",
      },
      {
        command: "pnpm --filter @mento-protocol/integration-probes typecheck",
        reason: "shared-config consumers should typecheck",
      },
      {
        why: "shared-config is imported into the dashboard client bundle via `@mento-protocol/config` — changes to chain/token metadata or helpers can shift the emitted JS. Mirrors the `shared-config/**` entry in `.github/workflows/size-limit.yml`.",
        verb: "add_ui_size_limit",
        args: ["shared-config exports feed the dashboard bundle"],
      },
      {
        dispatch: "path",
        arms: [
          {
            patterns: [
              "shared-config/chain-metadata.json",
              "shared-config/deployment-namespaces.json",
              "shared-config/oracle-reporters.json",
              "shared-config/src/chains.ts",
              "shared-config/src/oracle-reporters.ts",
              "shared-config/src/tokens.ts",
            ],
            effects: [
              {
                verb: "add_peg_registry_integrity_check",
                args: ["peg registry authority input changed"],
              },
            ],
          },
        ],
      },
      {
        dispatch: "path",
        arms: [
          {
            patterns: ["shared-config/src/thresholds.ts"],
            effects: [
              {
                command:
                  "node scripts/alerts/check-deviation-threshold-drift.mjs",
                reason: "shared deviation threshold source changed",
              },
              {
                command:
                  "pnpm --filter @mento-protocol/indexer-envio exec vitest run deviationThresholdSharedConfigSync",
                reason: "shared deviation threshold source changed",
              },
            ],
          },
          {
            patterns: [
              "shared-config/deployment-namespaces.json",
              "shared-config/fx-calendar.json",
            ],
            effects: [
              {
                verb: "add_all_indexer_codegen",
                args: ["shared-config vendored indexer fixture changed"],
              },
              {
                verb: "add_package_quality_commands",
                args: [
                  "@mento-protocol/indexer-envio",
                  "shared-config vendored indexer fixture changed",
                ],
              },
            ],
          },
        ],
      },
    ],
  },
];
