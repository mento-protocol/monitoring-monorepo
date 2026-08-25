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
 * The CI and alert-rule arms of the `tree` group: Actions workflows and
 * actions, agent prompts, Trunk, Turbo, the alert rules, and the first
 * alerts/infra services.
 */
export const WORKFLOW_ARMS = [
  {
    patterns: [".github/workflows/*", ".github/actions/*"],
    effects: [
      { surface: "github-workflows" },
      {
        checklist: "docs/pr-checklists/ci-workflow-gates.md",
        reason: "GitHub Actions workflow/action changed",
      },
      {
        command: "node scripts/workflows/check-github-action-pins.mjs",
        reason: "GitHub Actions workflow/action changed",
      },
      {
        command: "node scripts/workflows/check-autofix-ci-trust.mjs",
        reason:
          "GitHub Actions workflow/action changed (autofix CI trust boundary)",
      },
      {
        adrReminder:
          "workflow/action changed — ADR reminder (a new workflow likely needs an ADR)",
      },
      {
        dispatch: "path",
        arms: [
          {
            patterns: [".github/workflows/ci.yml"],
            effects: [
              { surface: "workspace" },
              {
                preflight: "pnpm install --frozen-lockfile",
                reason: "central CI workflow changed",
              },
              {
                verb: "add_workspace_quality_commands",
                args: ["central CI workflow changed"],
              },
              {
                why: "This workflow is the check's input: it asserts every Sentry suite has a step in the `scripts` job.",
                command:
                  "node scripts/sentry/ci-wiring/check-sentry-suites-in-ci.test.mjs",
                reason: "central CI workflow changed",
              },
              {
                command: "pnpm tf:test",
                reason: "Terraform registry-backed CI workflow changed",
              },
              {
                verb: "add_terraform_validate_commands",
                args: [
                  "terraform",
                  "Terraform registry-backed CI workflow changed",
                ],
              },
              {
                verb: "add_terraform_validate_commands",
                args: [
                  "alerts/rules",
                  "Terraform registry-backed CI workflow changed",
                ],
              },
              {
                verb: "add_terraform_validate_commands",
                args: [
                  "alerts/infra",
                  "Terraform registry-backed CI workflow changed",
                ],
              },
              {
                verb: "add_terraform_validate_commands",
                args: [
                  "aegis/terraform",
                  "Terraform registry-backed CI workflow changed",
                ],
              },
              {
                verb: "add_registered_terraform_validate_commands",
                args: ["Terraform registry-backed CI workflow changed"],
              },
            ],
          },
          {
            patterns: [".github/workflows/documentation-garden.yml"],
            effects: [
              {
                command: "pnpm docs:garden:test",
                reason: "documentation garden workflow changed",
              },
              {
                command: "pnpm docs:navigation-eval:test",
                reason: "documentation navigation scheduler workflow changed",
              },
            ],
          },
          {
            patterns: [".github/workflows/review-eval-freshness.yml"],
            why: "This workflow is the only automated reader of the review-skill evaluation contract and ledger. It runs the harness through its pnpm aliases, so an alias rename or a changed CLI mode reds here first. Same pairing as the documentation-garden arm above.",
            effects: [
              {
                command: "pnpm review:eval:test",
                reason: "review skill evaluation freshness workflow changed",
              },
            ],
          },
          {
            patterns: [".github/workflows/infra.yml"],
            effects: [
              {
                command: "pnpm tf:test",
                reason: "Terraform registry workflow changed",
              },
              {
                verb: "add_terraform_validate_commands",
                args: ["terraform", "Terraform registry workflow changed"],
              },
              {
                verb: "add_terraform_validate_commands",
                args: ["alerts/rules", "Terraform registry workflow changed"],
              },
              {
                verb: "add_terraform_validate_commands",
                args: ["alerts/infra", "Terraform registry workflow changed"],
              },
              {
                verb: "add_terraform_validate_commands",
                args: [
                  "aegis/terraform",
                  "Terraform registry workflow changed",
                ],
              },
              {
                verb: "add_registered_terraform_validate_commands",
                args: ["Terraform registry workflow changed"],
              },
            ],
          },
          {
            patterns: [".github/workflows/metrics-bridge.yml"],
            effects: [
              {
                checklist: "docs/pr-checklists/terraform-cloudrun.md",
                reason: "metrics bridge Cloud Run workflow changed",
              },
              {
                command: "pnpm agent:context-check",
                reason: "Cloud Run revision suffix guard changed",
              },
            ],
          },
          {
            patterns: [".github/workflows/aegis-app-engine.yml"],
            effects: [
              {
                verb: "add_aegis_quality_commands",
                args: ["Aegis App Engine workflow changed"],
              },
            ],
          },
          {
            patterns: [".github/workflows/lighthouse.yml"],
            effects: [
              {
                checklist: "docs/pr-checklists/code-health.md",
                reason: "Lighthouse CI workflow changed",
              },
            ],
          },
          {
            patterns: [".github/workflows/sentry-triage-agent.yml"],
            effects: [
              {
                why: 'Both suites assert on this file: the agent-comment tests own the "agent is the last step" and staged-closure invariants, the broker tests own "no Sentry credential in the agent\'s env" (#1711).',
                command:
                  "node scripts/sentry/triage/sentry-triage-agent-comment.test.mjs",
                reason: "Sentry triage agent workflow changed",
              },
              {
                command: "pnpm sentry:broker:test",
                reason: "Sentry triage agent workflow changed",
              },
              {
                why: "A third: the brief suite asserts the verdict job actually runs the needs-human brief leg, gated on the resolved verdict (#1748).",
                command: "pnpm sentry:brief:test",
                reason: "Sentry triage agent workflow changed",
              },
            ],
          },
          {
            patterns: [".github/actions/pnpm-install/*"],
            effects: [
              { surface: "workspace" },
              {
                preflight: "pnpm install --frozen-lockfile",
                reason: "pnpm install action changed",
              },
              {
                verb: "add_workspace_quality_commands",
                args: ["pnpm install action changed"],
              },
            ],
          },
        ],
      },
    ],
  },
  {
    patterns: [".github/prompts/*"],
    effects: [
      { surface: "tooling" },
      {
        dispatch: "path",
        arms: [
          {
            patterns: [".github/prompts/sentry-triage.md"],
            effects: [
              {
                why: "The prompt is the producing half of the verdict contract. The brief suite asserts it still asks for the needs-human brief fields the renderer consumes (#1748); dropping one here would leave the brief silently half-empty in production.",
                command: "pnpm sentry:brief:test",
                reason: "Sentry triage prompt changed",
              },
              {
                why: "The broker suite pins the OTHER load-bearing prompt rule: losing the Sentry toolset posts nothing rather than a verdict (#1938). It lives there because it is the agent-side half of the pre-flight probe, so a prompt-only edit must run it too or the rule can be dropped with nothing red.",
                command: "pnpm sentry:broker:test",
                reason: "Sentry triage prompt changed",
              },
            ],
          },
        ],
      },
    ],
  },
  {
    patterns: [".trunk/*"],
    effects: [
      { surface: "tooling" },
      {
        command: "node scripts/workflows/check-github-action-pins.mjs",
        reason: "Trunk workflow/action setup changed",
      },
      {
        command: "pnpm agent:quality-gate:test",
        reason: "agent quality gate trunk hook changed",
      },
    ],
  },
  {
    patterns: ["turbo.json"],
    effects: [
      { surface: "tooling" },
      {
        command: "pnpm agent:quality-gate:test",
        reason: "turbo task config changed",
      },
    ],
  },
  {
    patterns: ["alerts/rules/*"],
    effects: [
      { surface: "alerts-rules" },
      {
        verb: "add_terraform_validate_commands",
        args: ["alerts/rules", "alerts/rules Terraform changed"],
      },
      {
        command: "pnpm alerts:rules:lint",
        reason: "alerts/rules PromQL lint + metric cross-check",
      },
      {
        dispatch: "path",
        arms: [
          {
            patterns: ["alerts/rules/peg-thresholds.json"],
            effects: [
              {
                command: "node scripts/alerts/check-peg-registry-integrity.mjs",
                reason: "peg threshold policy changed",
              },
            ],
          },
          {
            patterns: ["alerts/rules/main.tf", "alerts/rules/rules-fpmms.tf"],
            effects: [
              {
                command:
                  "node scripts/alerts/check-deviation-threshold-drift.mjs",
                reason: "deviation threshold Terraform consumer changed",
              },
            ],
          },
        ],
      },
    ],
  },
  {
    patterns: ["alerts/infra/onchain-event-handler/*"],
    effects: [
      { surface: "alerts-infra" },
      {
        dispatch: "path",
        arms: [
          {
            patterns: ["alerts/infra/onchain-event-handler/src/safe-abi.json"],
            effects: [
              {
                verb: "add_package_quality_commands",
                args: [
                  "@mento-protocol/alerts-onchain-event-handler",
                  "Safe ABI changed (handler imports it)",
                ],
              },
              {
                verb: "add_terraform_validate_commands",
                args: [
                  "alerts/infra",
                  "Safe ABI changed (listener filter uses it at plan time)",
                ],
              },
            ],
          },
          {
            patterns: [
              "alerts/infra/onchain-event-handler/src/*",
              "alerts/infra/onchain-event-handler/package.json",
              "alerts/infra/onchain-event-handler/pnpm-lock.yaml",
              "alerts/infra/onchain-event-handler/pnpm-workspace.yaml",
              "alerts/infra/onchain-event-handler/tsconfig.json",
              "alerts/infra/onchain-event-handler/vitest.config.ts",
              "alerts/infra/onchain-event-handler/knip.json",
              "alerts/infra/onchain-event-handler/eslint.config.mjs",
            ],
            effects: [
              {
                verb: "add_package_quality_commands",
                args: [
                  "@mento-protocol/alerts-onchain-event-handler",
                  "alerts onchain-event-handler changed",
                ],
              },
              {
                when: {
                  pathEquals:
                    "alerts/infra/onchain-event-handler/pnpm-workspace.yaml",
                },
                effects: [
                  {
                    command:
                      "node --test scripts/supply-chain/alerts-uuid-overrides.test.mjs",
                    reason: "alerts uuid override policy changed",
                  },
                ],
              },
            ],
          },
          {
            patterns: ["alerts/infra/onchain-event-handler/*.tf"],
            effects: [
              {
                verb: "add_terraform_validate_commands",
                args: ["alerts/infra", "alerts/infra Terraform changed"],
              },
              {
                checklist: "docs/pr-checklists/terraform-cloudrun.md",
                reason: "alerts/infra Cloud Function path changed",
              },
            ],
          },
        ],
        trailingWhy:
          'Other handler files (scripts/*.sh, README.md, .gcloudignore, .prettierrc.json, .prettierignore) need no extra routing: shell scripts hit the generic `*.sh → bash -n $(quote_path "$path")` branch above; the others are doc/config-only and don\'t gate anything.',
      },
    ],
  },
  {
    patterns: ["alerts/infra/oncall-announcer/*"],
    effects: [
      { surface: "alerts-infra" },
      {
        dispatch: "path",
        arms: [
          {
            patterns: [
              "alerts/infra/oncall-announcer/src/*",
              "alerts/infra/oncall-announcer/package.json",
              "alerts/infra/oncall-announcer/pnpm-lock.yaml",
              "alerts/infra/oncall-announcer/pnpm-workspace.yaml",
              "alerts/infra/oncall-announcer/tsconfig.json",
              "alerts/infra/oncall-announcer/vitest.config.ts",
              "alerts/infra/oncall-announcer/knip.json",
              "alerts/infra/oncall-announcer/eslint.config.mjs",
            ],
            effects: [
              {
                verb: "add_alerts_oncall_quality_commands",
                args: ["alerts oncall-announcer changed"],
              },
              {
                when: {
                  pathEquals:
                    "alerts/infra/oncall-announcer/pnpm-workspace.yaml",
                },
                effects: [
                  {
                    command:
                      "node --test scripts/supply-chain/alerts-uuid-overrides.test.mjs",
                    reason: "alerts uuid override policy changed",
                  },
                ],
              },
            ],
          },
          {
            patterns: ["alerts/infra/oncall-announcer/*.tf"],
            effects: [
              {
                verb: "add_terraform_validate_commands",
                args: ["alerts/infra", "alerts/infra Terraform changed"],
              },
              {
                checklist: "docs/pr-checklists/terraform-cloudrun.md",
                reason: "alerts/infra Cloud Function path changed",
              },
            ],
          },
        ],
      },
    ],
  },
  {
    patterns: ["alerts/infra/sentry-ingest-watcher/*"],
    effects: [
      { surface: "alerts-infra" },
      {
        dispatch: "path",
        arms: [
          {
            patterns: [
              "alerts/infra/sentry-ingest-watcher/*.mjs",
              "alerts/infra/sentry-ingest-watcher/package.json",
            ],
            effects: [
              {
                command: "pnpm alerts:watcher:test",
                reason: "Sentry ingest dead-man switch changed",
              },
            ],
          },
          {
            patterns: ["alerts/infra/sentry-ingest-watcher/*.tf"],
            effects: [
              {
                verb: "add_terraform_validate_commands",
                args: ["alerts/infra", "alerts/infra Terraform changed"],
              },
              {
                checklist: "docs/pr-checklists/terraform-cloudrun.md",
                reason: "alerts/infra Cloud Function path changed",
              },
            ],
          },
        ],
      },
    ],
  },
  {
    patterns: ["alerts/infra/scripts/*"],
    effects: [
      { surface: "alerts-infra" },
      {
        dispatch: "path",
        arms: [
          {
            patterns: ["alerts/infra/scripts/*.sh"],
            effects: [
              {
                command: "bash -n {path}",
                reason: "alerts infra shell script changed",
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
              "alerts/infra/scripts/common.sh",
              "alerts/infra/scripts/fix-webhook-state.sh",
              "alerts/infra/scripts/fix-webhook-state.test.sh",
            ],
            effects: [
              {
                command: "bash alerts/infra/scripts/fix-webhook-state.test.sh",
                reason: "QuickNode state parser changed",
              },
            ],
          },
        ],
      },
    ],
  },
  {
    patterns: [
      "alerts/infra/onchain-event-listeners/*",
      "alerts/infra/channels/*",
    ],
    effects: [
      {
        why: "Listener filter (filter-function.js.tpl) feeds into the handler — a regression like dropping blockHash from it silently breaks the handler's cross-chain detection, and the 38 vitest cases cover that behavior. Route to handler tests in addition to TF validate. Matches the CI alerts paths-filter in .github/workflows/ci.yml.",
        surface: "alerts-infra",
      },
      {
        verb: "add_package_quality_commands",
        args: [
          "@mento-protocol/alerts-onchain-event-handler",
          "alerts/infra listener or channels changed (handler tests cover cross-chain behavior)",
        ],
      },
      {
        verb: "add_terraform_validate_commands",
        args: ["alerts/infra", "alerts/infra Terraform changed"],
      },
      {
        checklist: "docs/pr-checklists/terraform-cloudrun.md",
        reason: "alerts/infra Cloud Function path changed",
      },
      {
        dispatch: "path",
        arms: [
          {
            patterns: ["alerts/infra/onchain-event-listeners/main.tf"],
            effects: [
              {
                command: "bash alerts/infra/scripts/fix-webhook-state.test.sh",
                reason: "QuickNode replacement state parser changed",
              },
            ],
          },
        ],
      },
    ],
  },
];
