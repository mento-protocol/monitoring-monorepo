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
 * The rest of the alerts/infra tree, the governance watchdog, Terraform, Cloud
 * Build, and the root-level tool configs.
 *
 * The `alerts/infra/*` catch-all sits AFTER every named service, so it claims
 * the surface for everything else under that tree without shadowing them.
 */
export const ALERT_ARMS = [
  {
    patterns: ["alerts/infra/*"],
    effects: [
      { surface: "alerts-infra" },
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
  {
    patterns: ["governance-watchdog/*"],
    effects: [
      { surface: "governance-watchdog" },
      {
        dispatch: "path",
        arms: [
          {
            patterns: [
              "governance-watchdog/src/*",
              "governance-watchdog/bin/*.ts",
              "governance-watchdog/package.json",
              "governance-watchdog/pnpm-lock.yaml",
              "governance-watchdog/pnpm-workspace.yaml",
              "governance-watchdog/tsconfig.json",
              "governance-watchdog/tsconfig.build.json",
              "governance-watchdog/vitest.config.ts",
              "governance-watchdog/knip.json",
              "governance-watchdog/eslint.config.mjs",
            ],
            effects: [
              {
                verb: "add_package_quality_commands",
                args: [
                  "@mento-protocol/governance-watchdog",
                  "governance-watchdog changed",
                ],
              },
            ],
          },
          {
            patterns: ["governance-watchdog/infra/*.tf"],
            effects: [
              {
                verb: "add_terraform_validate_commands",
                args: [
                  "governance-watchdog/infra",
                  "governance-watchdog Terraform changed",
                ],
              },
              {
                checklist: "docs/pr-checklists/terraform-cloudrun.md",
                reason: "governance-watchdog Cloud Function path changed",
              },
            ],
          },
          {
            patterns: [
              "governance-watchdog/infra/quicknode-filter-functions/*.js",
            ],
            effects: [
              {
                why: "Canonical source that bin/deploy-quicknode-filter.sh pushes to the live QuickNode webhook — a syntax regression would otherwise only surface during a live filter update.",
                command: "node --check {path}",
                reason: "QuickNode filter function changed",
              },
            ],
          },
        ],
        trailingWhy:
          "Other files (bin/*.sh, *.md, .gcloudignore, .prettierrc, .env.example, osv-scanner.toml) need no extra routing: shell scripts hit the generic `*.sh → bash -n` branch above; the rest are doc/config-only. bin/*.ts is routed to package quality above — the package tsconfig includes `bin/**/*`, so typecheck/build cover those entrypoints.",
      },
    ],
  },
  {
    patterns: ["terraform/*"],
    effects: [
      { surface: "terraform" },
      {
        verb: "add_terraform_validate_commands",
        args: ["terraform", "Terraform changed"],
      },
      {
        checklist: "docs/pr-checklists/terraform-cloudrun.md",
        reason: "Terraform/Cloud Run path changed",
      },
    ],
  },
  {
    patterns: ["cloudbuild.yaml"],
    effects: [
      { surface: "cloudbuild" },
      {
        checklist: "docs/pr-checklists/terraform-cloudrun.md",
        reason: "Cloud Build config changed",
      },
      {
        verb: "add_package_quality_commands",
        args: [
          "@mento-protocol/metrics-bridge",
          "metrics bridge build context changed",
        ],
      },
    ],
  },
  {
    patterns: [".gcloudignore"],
    effects: [
      { surface: "cloudbuild" },
      {
        checklist: "docs/pr-checklists/terraform-cloudrun.md",
        reason: "Cloud Build ignore file changed",
      },
      {
        verb: "add_package_quality_commands",
        args: [
          "@mento-protocol/metrics-bridge",
          "metrics bridge build context changed",
        ],
      },
    ],
  },
  {
    patterns: [".lighthouserc.cjs"],
    effects: [
      { surface: "ui-dashboard" },
      {
        checklist: "docs/pr-checklists/code-health.md",
        reason: "Lighthouse CI budget config changed",
      },
      {
        command: "node scripts/lighthouse-config.test.mjs",
        reason: "Lighthouse CI budget config changed",
      },
    ],
  },
  {
    patterns: [".shellcheckrc"],
    effects: [
      {
        why: "The repo-wide `./tools/trunk check --all --filter=shellcheck` command itself is added by add_trunk_check_command (see trunk_requires_shellcheck_full_scan) since it depends on the full changed-paths set, not just this one path.",
        surface: "tooling",
      },
    ],
  },
];
