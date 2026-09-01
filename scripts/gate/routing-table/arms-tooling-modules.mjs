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
 * The last third of the per-module dispatch under `scripts/*.mjs`: PR state,
 * Terraform helpers, supply-chain gates, workflow checks, deploy helpers, and
 * the alert-rule tooling.
 *
 * The four deploy-helper arms are exact-path on BOTH sides — pattern and
 * scheduled command — and each carries its any-depth pair. A stale command path
 * there fails loudly; a stale pattern fails silently, which is why the pair is
 * declared rather than assumed.
 */
export const TOOLING_MODULE_ARMS = [
  {
    why: "scripts/pr/ is the only location: the aliases, the suites, and the autoreview wrapper all resolve there. Neither arm is a glob, so each path needs naming outright.",
    patterns: [
      "scripts/pr/pr-feedback-state.mjs",
      "scripts/pr/pr-feedback-state-core.mjs",
      "scripts/pr/pr-feedback-state-claude.mjs",
      "scripts/pr/pr-feedback-state.test.mjs",
    ],
    effects: [
      {
        command: "pnpm pr:feedback-state:test",
        reason: "PR feedback-state helper changed",
      },
      {
        command: "pnpm pr:merge:test",
        reason:
          "the sanctioned merge wrapper gates merges on the feedback ledger this helper computes",
      },
    ],
  },
  {
    patterns: [
      "scripts/pr/pr-ready-state.mjs",
      "scripts/pr/pr-ready-state-core.mjs",
      "scripts/pr/pr-ready-state-format.mjs",
      "scripts/pr/pr-ready-state-review-signals.mjs",
      "scripts/pr/pr-ready-state.test.mjs",
    ],
    effects: [
      {
        command: "pnpm pr:ready-state:test",
        reason: "PR ready-state helper changed",
      },
      {
        command: "pnpm pr:merge:test",
        reason:
          "the sanctioned merge wrapper reads the ready-state oracle and its gh runner",
      },
    ],
  },
  {
    why: "The merge wrapper reads the ready-state helper, so the ready-state arm above already routes its own suite; this arm covers a change to the wrapper or its suite alone.",
    patterns: [
      "scripts/pr/merge-pr.mjs",
      "scripts/pr/merge-pr-core.mjs",
      "scripts/pr/merge-pr-io.mjs",
      "scripts/pr/merge-pr-github.mjs",
      "scripts/pr/merge-pr.test.mjs",
    ],
    effects: [
      {
        command: "pnpm pr:merge:test",
        reason: "sanctioned merge wrapper changed",
      },
    ],
  },
  {
    patterns: [
      "scripts/pr/review-process-metrics.mjs",
      "scripts/pr/review-process-metrics-core.mjs",
      "scripts/pr/review-process-metrics-finding-classifier.mjs",
      "scripts/pr/review-process-metrics-finding-preflight.mjs",
      "scripts/pr/review-process-metrics-legacy.mjs",
      "scripts/pr/review-process-metrics-markdown.mjs",
      "scripts/pr/review-process-metrics-report.mjs",
      "scripts/pr/review-process-metrics-signals.mjs",
      "scripts/pr/review-process-metrics-timeline.mjs",
      "scripts/pr/review-process-metrics.test.mjs",
    ],
    effects: [
      {
        command: "node scripts/pr/review-process-metrics.test.mjs",
        reason: "review-process metrics collector changed",
      },
    ],
  },
  {
    patterns: ["scripts/coderabbit-config.test.mjs"],
    effects: [
      {
        why: "Half of the .coderabbit.yaml pin pair; the config's own arm sits in the outer case because a repo-root .yaml never reaches this block.",
        command: "pnpm coderabbit:config:test",
        reason: "CodeRabbit config pin changed",
      },
    ],
  },
  {
    why: "Enumerated, not `scripts/terraform/*`: a glob here would win over the two `terraform-fmt-check` arms below, which bash `case` never reaches once an earlier arm matches, and the format helper would silently lose its own suite. `scripts/tf-stacks.{mjs,test.mjs}` stay flat — seven security-contract pins name those exact paths (scripts/AGENTS.md).",
    patterns: [
      "scripts/terraform/check-metrics-bridge-template-plan.mjs",
      "scripts/terraform/check-metrics-bridge-template-plan.test.mjs",
      "scripts/terraform/tf-platform-plan-guard.mjs",
      "scripts/tf-stacks.mjs",
      "scripts/tf-stacks.test.mjs",
    ],
    effects: [
      { command: "pnpm tf:test", reason: "Terraform stack wrapper changed" },
      {
        verb: "add_terraform_validate_commands",
        args: ["terraform", "Terraform stack wrapper changed"],
      },
      {
        verb: "add_terraform_validate_commands",
        args: ["alerts/rules", "Terraform stack wrapper changed"],
      },
      {
        verb: "add_terraform_validate_commands",
        args: ["alerts/infra", "Terraform stack wrapper changed"],
      },
      {
        verb: "add_terraform_validate_commands",
        args: ["aegis/terraform", "Terraform stack wrapper changed"],
      },
      {
        verb: "add_terraform_validate_commands",
        args: ["governance-watchdog/infra", "Terraform stack wrapper changed"],
      },
      {
        verb: "add_registered_terraform_validate_commands",
        args: ["Terraform stack wrapper changed"],
      },
    ],
  },
  {
    patterns: ["scripts/terraform/terraform-fmt-check.mjs"],
    effects: [
      {
        command: "node scripts/terraform/terraform-fmt-check.test.mjs",
        reason: "Terraform format helper changed",
      },
      { command: "pnpm tf:test", reason: "Terraform format helper changed" },
      {
        verb: "add_terraform_validate_commands",
        args: ["terraform", "Terraform format helper changed"],
      },
      {
        verb: "add_terraform_validate_commands",
        args: ["alerts/rules", "Terraform format helper changed"],
      },
      {
        verb: "add_terraform_validate_commands",
        args: ["alerts/infra", "Terraform format helper changed"],
      },
      {
        verb: "add_terraform_validate_commands",
        args: ["aegis/terraform", "Terraform format helper changed"],
      },
      {
        verb: "add_terraform_validate_commands",
        args: ["governance-watchdog/infra", "Terraform format helper changed"],
      },
      {
        verb: "add_registered_terraform_validate_commands",
        args: ["Terraform format helper changed"],
      },
    ],
  },
  {
    patterns: ["scripts/terraform/terraform-fmt-check.test.mjs"],
    effects: [
      {
        command: "node scripts/terraform/terraform-fmt-check.test.mjs",
        reason: "Terraform format helper test changed",
      },
    ],
  },
  {
    patterns: [
      "scripts/supply-chain/lockfile-lint.mjs",
      "scripts/supply-chain/lockfile-lint.test.mjs",
      "scripts/supply-chain/lockfile-lint-registry-sources.mjs",
      "scripts/supply-chain/lockfile-lint-override-ranges.mjs",
    ],
    effects: [
      {
        command: "pnpm lockfile:lint:test",
        reason: "lockfile lint helper changed",
      },
    ],
  },
  {
    why: "One parser, two readers with opposite failure modes: lockfile:lint fails CI on an unbounded override range and override:prune-report never fails anything. Route both so a change here cannot pass by only satisfying the side that stays green.",
    patterns: [
      "scripts/lib/pnpm-override-selector.mjs",
      "scripts/lib/pnpm-override-selector.test.mjs",
    ],
    effects: [
      {
        command: "node --test scripts/lib/pnpm-override-selector.test.mjs",
        reason: "shared pnpm override selector parser changed",
      },
      {
        command: "pnpm lockfile:lint:test",
        reason: "shared pnpm override selector parser changed",
      },
      {
        command: "pnpm override:prune-report:test",
        reason: "shared pnpm override selector parser changed",
      },
    ],
  },
  {
    patterns: ["scripts/supply-chain/alerts-uuid-overrides.test.mjs"],
    effects: [
      {
        command:
          "node --test scripts/supply-chain/alerts-uuid-overrides.test.mjs",
        reason: "alerts uuid override contract changed",
      },
    ],
  },
  {
    patterns: [
      "scripts/gate/lockfile-scope.mjs",
      "scripts/gate/lockfile-scope.test.mjs",
    ],
    effects: [
      {
        command: "node scripts/gate/lockfile-scope.test.mjs",
        reason: "lockfile scope helper changed",
      },
    ],
  },
  {
    patterns: [
      "scripts/supply-chain/pnpm-audit-high-gate.mjs",
      "scripts/supply-chain/pnpm-audit-high-gate.test.mjs",
    ],
    effects: [
      {
        command: "node scripts/supply-chain/pnpm-audit-high-gate.test.mjs",
        reason: "pnpm audit high gate changed",
      },
    ],
  },
  {
    patterns: ["scripts/sanitize-terraform-output.test.mjs"],
    effects: [
      {
        command: "pnpm sanitize:test",
        reason: "Terraform output sanitizer test changed",
      },
    ],
  },
  {
    patterns: [
      "scripts/supply-chain/version-skew-check.mjs",
      "scripts/supply-chain/version-skew-check.test.mjs",
    ],
    effects: [
      {
        command: "pnpm skew:check:test",
        reason: "version skew checker changed",
      },
    ],
  },
  {
    patterns: [
      "scripts/supply-chain/override-prune-report.mjs",
      "scripts/supply-chain/override-prune-report.test.mjs",
    ],
    effects: [
      {
        command: "pnpm override:prune-report:test",
        reason: "override prune report helper changed",
      },
    ],
  },
  {
    patterns: [
      "scripts/repo-health/check-hermetic-vitest-setup.mjs",
      "scripts/repo-health/check-hermetic-vitest-setup.test.mjs",
    ],
    effects: [
      {
        command: "node scripts/repo-health/check-hermetic-vitest-setup.mjs",
        reason: "hermetic Vitest setup checker changed",
      },
      {
        command:
          "node scripts/repo-health/check-hermetic-vitest-setup.test.mjs",
        reason: "hermetic Vitest setup checker changed",
      },
    ],
  },
  {
    patterns: ["scripts/workflows/check-github-action-pins.mjs"],
    effects: [
      {
        command: "node scripts/workflows/check-github-action-pins.mjs",
        reason: "GitHub Actions pin checker changed",
      },
      {
        command: "node scripts/workflows/check-github-action-pins.test.mjs",
        reason: "GitHub Actions pin checker changed",
      },
    ],
  },
  {
    patterns: [
      "scripts/workflows/check-autofix-ci-trust.mjs",
      "scripts/workflows/check-autofix-ci-trust.test.mjs",
      "scripts/workflows/autofix-trust-annotations.mjs",
    ],
    effects: [
      {
        command: "node scripts/workflows/check-autofix-ci-trust.mjs",
        reason: "autofix CI trust checker changed",
      },
      {
        command: "node scripts/workflows/check-autofix-ci-trust.test.mjs",
        reason: "autofix CI trust checker changed",
      },
    ],
  },
  {
    patterns: [
      "scripts/workflows/check-workflow-permissions-drift.mjs",
      "scripts/workflows/check-workflow-permissions-drift.test.mjs",
    ],
    effects: [
      {
        command:
          "node scripts/workflows/check-workflow-permissions-drift.test.mjs",
        reason: "platform-settings workflow-permissions drift checker changed",
      },
    ],
  },
  {
    patterns: ["scripts/workflows/check-github-action-pins.test.mjs"],
    effects: [
      {
        command: "node scripts/workflows/check-github-action-pins.test.mjs",
        reason: "GitHub Actions pin checker test changed",
      },
    ],
  },
  {
    why: "The Node deploy helpers moved into scripts/deploy/ with the wrappers. These arms match exact paths, so the patterns AND the commands they schedule both carry the new location — a stale command path fails loud (node cannot find the file), but a stale pattern fails silent.  Each therefore also carries the any-depth pair, like the wrapper arms. It matters MORE here: a wrapper that moves again still falls through to `scripts/deploy-*.sh|scripts/*/deploy-*.sh` and keeps the root-anchor check, but a `.mjs` has no deploy-specific fallback at all — it would land on `pnpm lint:scripts` alone and quietly stop running its suite.",
    patterns: [
      "scripts/deploy/deploy-indexer-verify.mjs",
      "scripts/deploy/deploy-indexer-verify.test.mjs",
      "scripts/deploy/deploy-indexer-verify-analysis.mjs",
      "scripts/deploy/deploy-indexer-verify-analysis.test.mjs",
      "scripts/deploy/deploy-indexer-verify-status-identity.mjs",
      "scripts/*/deploy-indexer-verify.mjs",
      "scripts/*/deploy-indexer-verify.test.mjs",
      "scripts/*/deploy-indexer-verify-analysis.mjs",
      "scripts/*/deploy-indexer-verify-analysis.test.mjs",
      "scripts/*/deploy-indexer-verify-status-identity.mjs",
    ],
    pairing: "paired",
    effects: [
      {
        command: "node scripts/deploy/deploy-indexer-verify-analysis.test.mjs",
        reason: "indexer deploy verifier changed",
      },
      {
        command: "node scripts/deploy/deploy-indexer-verify.test.mjs",
        reason: "indexer deploy verifier changed",
      },
    ],
  },
  {
    patterns: [
      "scripts/deploy/deploy-indexer-perf.mjs",
      "scripts/deploy/deploy-indexer-perf.test.mjs",
      "scripts/*/deploy-indexer-perf.mjs",
      "scripts/*/deploy-indexer-perf.test.mjs",
    ],
    pairing: "paired",
    effects: [
      {
        command: "node scripts/deploy/deploy-indexer-perf.test.mjs",
        reason: "indexer deploy perf helper changed",
      },
    ],
  },
  {
    patterns: [
      "scripts/deploy/filter-envio-runtime-errors.mjs",
      "scripts/deploy/filter-envio-runtime-errors.test.mjs",
      "scripts/*/filter-envio-runtime-errors.mjs",
      "scripts/*/filter-envio-runtime-errors.test.mjs",
    ],
    pairing: "paired",
    effects: [
      {
        command: "node scripts/deploy/filter-envio-runtime-errors.test.mjs",
        reason: "indexer runtime-log filter changed",
      },
    ],
  },
  {
    why: "The status command is the shell wrapper rewritten in Node (P15). It is read-only, so it never sourced the deploy guard and is not a subject of check-deploy-root-anchors.test.mjs — nothing routes it by the `deploy-*.sh` globs any more, and without this arm its argument parsing, renderers and cadence bands would be covered by nothing but `pnpm lint:scripts`.",
    patterns: [
      "scripts/deploy/deploy-indexer-status.mjs",
      "scripts/deploy/deploy-indexer-status.test.mjs",
      "scripts/*/deploy-indexer-status.mjs",
      "scripts/*/deploy-indexer-status.test.mjs",
    ],
    pairing: "paired",
    effects: [
      {
        command: "node scripts/deploy/deploy-indexer-status.test.mjs",
        reason: "indexer deploy status command changed",
      },
    ],
  },
  {
    patterns: [
      "scripts/alerts/alert-rules-lint.mjs",
      "scripts/alerts/alert-rules-lint-extract.mjs",
      "scripts/alerts/alert-rules-lint-peg-policy.mjs",
      "scripts/alerts/alert-rules-lint.test.mjs",
    ],
    effects: [
      {
        command: "pnpm alerts:rules:lint:test",
        reason: "alert-rules lint helper changed",
      },
    ],
  },
  {
    patterns: [
      "scripts/alerts/check-peg-registry-integrity.mjs",
      "scripts/alerts/check-peg-registry-integrity-lineage.mjs",
      "scripts/alerts/check-peg-registry-integrity.test.mjs",
    ],
    effects: [
      {
        command: "node scripts/alerts/check-peg-registry-integrity.mjs",
        reason: "peg registry integrity checker changed",
      },
      {
        command: "node scripts/alerts/check-peg-registry-integrity.test.mjs",
        reason: "peg registry integrity checker changed",
      },
    ],
  },
  {
    why: "The publication boundary's only suite runs inside `pnpm tf:test`, which the unconditional real-tree sweep further down already routes. Naming it here keeps the reason honest and the routing correct if that sweep is ever narrowed.",
    patterns: [
      "scripts/alerts/check-peg-policy-publication.mjs",
      "scripts/alerts/check-peg-policy-publication.test.mjs",
    ],
    effects: [
      {
        command: "pnpm tf:test",
        reason: "peg policy publication boundary changed",
      },
    ],
  },
  {
    why: "The peg policy version-digest contract. Both peg validators compare a version string against this one implementation, so a change here has to run both or the halves can disagree undetected.",
    patterns: ["scripts/lib/peg-policy-digest.mjs"],
    effects: [
      {
        command: "pnpm alerts:rules:lint:test",
        reason: "peg policy version digest changed",
      },
      {
        command: "node scripts/alerts/check-peg-registry-integrity.mjs",
        reason: "peg policy version digest changed",
      },
      {
        command: "node scripts/alerts/check-peg-registry-integrity.test.mjs",
        reason: "peg policy version digest changed",
      },
    ],
  },
  {
    patterns: [
      "scripts/pr/check-pr-description.mjs",
      "scripts/pr/check-pr-description.test.mjs",
    ],
    effects: [
      {
        command: "node scripts/pr/check-pr-description.test.mjs",
        reason: "PR description validator changed",
      },
    ],
  },
  {
    patterns: ["scripts/alerts/check-deviation-threshold-drift.mjs"],
    effects: [
      {
        command: "node scripts/alerts/check-deviation-threshold-drift.mjs",
        reason: "deviation threshold drift checker changed",
      },
      {
        command: "node scripts/alerts/check-deviation-threshold-drift.test.mjs",
        reason: "deviation threshold drift checker changed",
      },
    ],
  },
  {
    patterns: ["scripts/alerts/check-deviation-threshold-drift.test.mjs"],
    effects: [
      {
        command: "node scripts/alerts/check-deviation-threshold-drift.test.mjs",
        reason: "deviation threshold drift checker test changed",
      },
    ],
  },
  {
    patterns: [
      "scripts/terraform/notify-terraform-apply.mjs",
      "scripts/terraform/notify-terraform-apply.test.mjs",
    ],
    effects: [
      {
        command: "node scripts/terraform/notify-terraform-apply.test.mjs",
        reason: "Terraform apply Slack notifier changed",
      },
    ],
  },
  {
    patterns: [
      "scripts/terraform/check-terraform-deploy-queue.mjs",
      "scripts/terraform/check-terraform-deploy-queue.test.mjs",
    ],
    effects: [
      {
        command: "node scripts/terraform/check-terraform-deploy-queue.test.mjs",
        reason: "Terraform deploy queue watcher changed",
      },
    ],
  },
  {
    patterns: [
      "scripts/redrive-onchain-deadletter.mjs",
      "scripts/redrive-onchain-deadletter.test.mjs",
    ],
    effects: [
      {
        command: "node scripts/redrive-onchain-deadletter.test.mjs",
        reason: "onchain dead-letter redrive tool changed",
      },
    ],
  },
  {
    patterns: [
      "scripts/verify-github-environment-protection.mjs",
      "scripts/verify-github-environment-protection.test.mjs",
    ],
    effects: [
      {
        command: "node scripts/verify-github-environment-protection.test.mjs",
        reason: "GitHub environment protection checker changed",
      },
    ],
  },
  {
    patterns: ["scripts/eslint-baseline-diff.mjs"],
    effects: [
      {
        why: "The lint wrapper. A regression here would mask all per-package baseline drift. Re-run every package's lint to exercise the wrapper end-to-end, plus the semantic tests covering its matching/growth/absorption logic directly.",
        command: "node scripts/eslint-baseline-diff.test.mjs",
        reason: "ESLint baseline wrapper changed",
      },
      {
        verb: "add_package_quality_commands",
        args: ["@mento-protocol/config", "ESLint baseline wrapper changed"],
      },
      {
        verb: "add_package_quality_commands",
        args: [
          "@mento-protocol/ui-dashboard",
          "ESLint baseline wrapper changed",
        ],
      },
      {
        verb: "add_package_quality_commands",
        args: [
          "@mento-protocol/indexer-envio",
          "ESLint baseline wrapper changed",
        ],
      },
      {
        verb: "add_package_quality_commands",
        args: [
          "@mento-protocol/metrics-bridge",
          "ESLint baseline wrapper changed",
        ],
      },
      {
        verb: "add_package_quality_commands",
        args: [
          "@mento-protocol/integration-probes",
          "ESLint baseline wrapper changed",
        ],
      },
    ],
  },
  {
    patterns: ["scripts/eslint-baseline-diff.test.mjs"],
    effects: [
      {
        command: "node scripts/eslint-baseline-diff.test.mjs",
        reason: "ESLint baseline wrapper test changed",
      },
    ],
  },
];
