/**
 * Part of the quality gate's routing table. Read
 * `scripts/gate/routing-table/index.mjs` first: it owns the group order, the
 * schema, and the pairing lint, and it is the only module anything outside this
 * directory should import.
 *
 * ORDER IS ROUTING. Arms are first-match within their group, so an arm's index
 * IS its precedence — moving one up or down changes what the gate schedules.
 * Nothing about a diff will tell you that; `gate-equality.test.mjs`, which
 * compares this table against the gate's live `case` arms, will.
 */

/**
 * The six groups that run before the big per-tree group: the documentation
 * surface, the documentation contracts, the Upstash MCP transport pin, the
 * manifest and package-manager routes, the shell-syntax route, and the Vitest
 * configuration routes.
 *
 * They are separate `case` statements rather than arms of one, and that is
 * load-bearing: every group runs for every path, so a `.md` file reaches the
 * documentation-surface group AND the documentation-contracts group. Folding
 * two groups into one would make the second one's arms unreachable for any path
 * the first already matched.
 */
export const HEAD_GROUPS = [
  {
    id: "documentation-surface",
    arms: [
      {
        patterns: ["*.md"],
        effects: [
          { surface: "docs" },
          {
            command: "pnpm docs:index --check",
            reason: "tracked documentation changed",
          },
        ],
      },
    ],
  },
  {
    id: "documentation-contracts",
    arms: [
      {
        patterns: ["README.md", "*/README.md"],
        effects: [
          {
            command: "pnpm agent:context-check",
            reason: "README metadata may enroll canonical context",
          },
        ],
      },
      {
        patterns: ["docs/evals/documentation-navigation-baseline.json"],
        effects: [
          { surface: "docs" },
          {
            command: "pnpm docs:navigation-eval:test",
            reason: "documentation navigation baseline changed",
          },
          {
            command: "pnpm docs:navigation-eval -- --check-fixtures",
            reason: "documentation navigation baseline changed",
          },
          {
            command:
              "pnpm docs:navigation-eval -- --validate docs/evals/documentation-navigation-baseline.json --fixtures docs/evals/documentation-navigation-baseline-fixtures.json",
            reason: "documentation navigation baseline changed",
          },
        ],
      },
      {
        patterns: ["docs/evals/documentation-navigation-*.json"],
        effects: [
          { surface: "docs" },
          {
            command: "pnpm docs:navigation-eval:test",
            reason: "documentation navigation evaluation contract changed",
          },
          {
            command: "pnpm docs:navigation-eval -- --check-fixtures",
            reason: "documentation navigation evaluation contract changed",
          },
          {
            command:
              "pnpm docs:navigation-eval -- --validate docs/evals/documentation-navigation-baseline.json --fixtures docs/evals/documentation-navigation-baseline-fixtures.json",
            reason: "documentation navigation evaluation contract changed",
          },
        ],
      },
      {
        patterns: ["docs/claude-runtime-document-registry.json"],
        effects: [
          { surface: "docs" },
          {
            command: "pnpm docs:index --check",
            reason: "Claude runtime document registry changed",
          },
          {
            command: "pnpm agent:context-check",
            reason: "Claude runtime document registry changed",
          },
        ],
      },
      {
        patterns: ["AGENTS.md", "*/AGENTS.md", ".codex/config.toml"],
        effects: [
          { surface: "agent-context" },
          {
            command: "pnpm agent:context-budget --strict",
            reason: "agent instruction budget input changed",
          },
        ],
      },
    ],
  },
  {
    id: "upstash-mcp-transport",
    arms: [
      {
        patterns: [
          ".gitattributes",
          ".codex/config.toml",
          ".codex/upstash-mcp.example.toml",
          ".agents/skills/forensic-report/*",
          ".claude/skills/forensic-report/*",
          "docs/adr/0030-iac-before-cli-secrets.md",
          "docs/adr/0060-upstash-management-key-bootstrap.md",
          "docs/deployment.md",
          "docs/notes/codex-agent-skills.md",
          "docs/notes/upstash-mcp-operator.md",
          "package.json",
          "pnpm-lock.yaml",
          "scripts/mcp/build-upstash-mcp-runtime.mjs",
          "scripts/mcp/render-upstash-mcp-config.mjs",
          "scripts/mcp/upstash-mcp-launcher.mjs",
          "terraform/terraform.tfvars.example",
          "terraform/variables.tf",
        ],
        effects: [
          {
            command: "node --test scripts/mcp/upstash-mcp-config.test.mjs",
            reason: "Upstash MCP transport contract changed",
          },
        ],
      },
    ],
  },
  {
    id: "manifests-and-package-manager",
    arms: [
      {
        patterns: ["package.json"],
        effects: [
          { set: "root_package_json_class" },
          {
            dispatch: "root_package_json_class",
            arms: [
              {
                patterns: ["root-tooling-scripts"],
                effects: [
                  { surface: "tooling" },
                  {
                    verb: "add_root_tooling_package_script_checks",
                    args: ["root package tooling script changed"],
                  },
                ],
              },
              {
                patterns: ["package-scripts"],
                effects: [
                  { set: "package_script_risk_changed" },
                  { surface: "workspace" },
                  {
                    preflight: "pnpm install --frozen-lockfile",
                    reason: "root package script changed",
                  },
                  {
                    verb: "add_root_tooling_package_script_checks",
                    args: ["root package script changed"],
                  },
                  {
                    verb: "add_workspace_quality_commands",
                    args: ["root package script changed"],
                  },
                ],
              },
              {
                patterns: ["*"],
                effects: [
                  { set: "package_script_risk_changed" },
                  {
                    preflight: "pnpm install --frozen-lockfile",
                    reason: "workspace package manifest changed",
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        patterns: ["*/package.json"],
        effects: [
          { set: "package_script_risk_changed" },
          {
            preflight: "pnpm install --frozen-lockfile",
            reason: "workspace package manifest changed",
          },
          {
            command: "pnpm skew:check",
            reason: "workspace package manifest changed",
          },
        ],
      },
      {
        patterns: ["pnpm-lock.yaml", "pnpm-workspace.yaml"],
        effects: [{ set: "package_script_risk_changed" }],
      },
      {
        patterns: ["patches/*"],
        effects: [
          { set: "package_script_risk_changed" },
          {
            preflight: "pnpm install --frozen-lockfile",
            reason: "pnpm patch changed",
          },
          { surface: "workspace" },
          {
            verb: "add_workspace_quality_commands",
            args: ["pnpm patch changed"],
          },
        ],
      },
      {
        patterns: [".dependency-cruiser.cjs"],
        effects: [
          { surface: "tooling" },
          {
            command: "pnpm code-health:deps",
            reason:
              "dep-cruiser config changed (cross-package boundaries + cycles)",
          },
          {
            why: "`.dependency-cruiser.cjs` is also linted by `pnpm lint:scripts` (see eslint.config.mjs root coverage). A CJS-only edit must run both.",
            command: "pnpm lint:scripts",
            reason: "dep-cruiser config changed (root ESLint coverage)",
          },
          {
            checklist: "docs/pr-checklists/code-health.md",
            reason: "dep-cruiser config changed",
          },
        ],
      },
      {
        patterns: ["*/knip.json"],
        effects: [
          {
            why: "Match knip.json regardless of which package owns it. The pnpm filter scope below normalizes path to package.",
            surface: "tooling",
          },
          {
            checklist: "docs/pr-checklists/code-health.md",
            reason: "knip config changed",
          },
          {
            dispatch: "path",
            arms: [
              {
                patterns: ["shared-config/knip.json"],
                effects: [
                  {
                    verb: "add_turbo_package_task",
                    args: [
                      "@mento-protocol/config",
                      "knip",
                      "knip config changed",
                    ],
                  },
                ],
              },
              {
                patterns: ["ui-dashboard/knip.json"],
                effects: [
                  {
                    verb: "add_turbo_package_task",
                    args: [
                      "@mento-protocol/ui-dashboard",
                      "knip",
                      "knip config changed",
                    ],
                  },
                ],
              },
              {
                patterns: ["indexer-envio/knip.json"],
                effects: [
                  {
                    verb: "add_turbo_package_task",
                    args: [
                      "@mento-protocol/indexer-envio",
                      "knip",
                      "knip config changed",
                    ],
                  },
                ],
              },
              {
                patterns: ["metrics-bridge/knip.json"],
                effects: [
                  {
                    verb: "add_turbo_package_task",
                    args: [
                      "@mento-protocol/metrics-bridge",
                      "knip",
                      "knip config changed",
                    ],
                  },
                ],
              },
              {
                patterns: ["integration-probes/knip.json"],
                effects: [
                  {
                    verb: "add_turbo_package_task",
                    args: [
                      "@mento-protocol/integration-probes",
                      "knip",
                      "knip config changed",
                    ],
                  },
                ],
              },
              {
                patterns: ["aegis/knip.json"],
                effects: [
                  {
                    verb: "add_turbo_package_task",
                    args: [
                      "@mento-protocol/aegis",
                      "knip",
                      "knip config changed",
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        patterns: [".npmrc", "*/.npmrc", "pnpmfile.cjs", ".pnpmfile.cjs"],
        allowStale:
          "pnpm configuration this repository does not carry today. The arm exists so that adding one routes a frozen-lockfile install on the commit that adds it, rather than one commit later.",
        effects: [
          { set: "package_script_risk_changed" },
          {
            preflight: "pnpm install --frozen-lockfile",
            reason: "package manager config changed",
          },
          { surface: "workspace" },
          {
            verb: "add_workspace_quality_commands",
            args: ["package manager config changed"],
          },
        ],
      },
    ],
  },
  {
    id: "shell-syntax",
    arms: [
      {
        patterns: ["*.sh"],
        effects: [
          { surface: "scripts" },
          {
            when: "pathIsFile",
            effects: [
              { command: "bash -n {path}", reason: "shell script changed" },
            ],
          },
        ],
      },
    ],
  },
  {
    id: "vitest-configuration",
    arms: [
      {
        patterns: ["*/vitest.config.ts", "*/vitest.mutation.config.ts"],
        effects: [
          { surface: "tooling" },
          {
            command: "node scripts/repo-health/check-hermetic-vitest-setup.mjs",
            reason: "hermetic Vitest config changed",
          },
        ],
      },
      {
        patterns: ["*/vitest.hermetic-setup.ts"],
        effects: [
          { surface: "tooling" },
          {
            command: "node scripts/repo-health/check-hermetic-vitest-setup.mjs",
            reason: "hermetic Vitest setup changed",
          },
          {
            dispatch: "path",
            arms: [
              {
                patterns: [
                  "alerts/infra/oncall-announcer/vitest.hermetic-setup.ts",
                ],
                effects: [
                  {
                    verb: "add_package_vitest_typecheck_commands",
                    args: [
                      "@mento-protocol/alerts-oncall-announcer",
                      "alerts oncall-announcer hermetic Vitest setup changed",
                    ],
                  },
                ],
              },
              {
                patterns: [
                  "alerts/infra/onchain-event-handler/vitest.hermetic-setup.ts",
                ],
                effects: [
                  {
                    verb: "add_package_vitest_typecheck_commands",
                    args: [
                      "@mento-protocol/alerts-onchain-event-handler",
                      "alerts onchain-event-handler hermetic Vitest setup changed",
                    ],
                  },
                ],
              },
              {
                patterns: ["governance-watchdog/vitest.hermetic-setup.ts"],
                effects: [
                  {
                    verb: "add_package_vitest_typecheck_commands",
                    args: [
                      "@mento-protocol/governance-watchdog",
                      "governance-watchdog hermetic Vitest setup changed",
                    ],
                  },
                ],
              },
              {
                patterns: ["indexer-envio/vitest.hermetic-setup.ts"],
                effects: [
                  {
                    verb: "add_package_vitest_typecheck_commands",
                    args: [
                      "@mento-protocol/indexer-envio",
                      "indexer-envio hermetic Vitest setup changed",
                    ],
                  },
                ],
              },
              {
                patterns: ["integration-probes/vitest.hermetic-setup.ts"],
                effects: [
                  {
                    verb: "add_package_vitest_typecheck_commands",
                    args: [
                      "@mento-protocol/integration-probes",
                      "integration-probes hermetic Vitest setup changed",
                    ],
                  },
                ],
              },
              {
                patterns: ["metrics-bridge/vitest.hermetic-setup.ts"],
                effects: [
                  {
                    verb: "add_package_vitest_typecheck_commands",
                    args: [
                      "@mento-protocol/metrics-bridge",
                      "metrics-bridge hermetic Vitest setup changed",
                    ],
                  },
                ],
              },
              {
                patterns: ["shared-config/vitest.hermetic-setup.ts"],
                effects: [
                  {
                    verb: "add_package_vitest_typecheck_commands",
                    args: [
                      "@mento-protocol/config",
                      "shared-config hermetic Vitest setup changed",
                    ],
                  },
                ],
              },
              {
                patterns: ["ui-dashboard/vitest.hermetic-setup.ts"],
                effects: [
                  {
                    verb: "add_package_vitest_typecheck_commands",
                    args: [
                      "@mento-protocol/ui-dashboard",
                      "ui-dashboard hermetic Vitest setup changed",
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
];
