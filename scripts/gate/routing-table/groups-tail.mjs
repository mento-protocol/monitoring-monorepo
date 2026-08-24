/**
 * Part of the quality gate's routing table. Read
 * `scripts/gate/routing-table/index.mjs` first: it owns the group order, the
 * schema, and the pairing lint, and it is the only module anything outside this
 * directory should import.
 *
 * ORDER IS ROUTING. Arms are first-match within their group, so an arm's index
 * IS its precedence — moving one up or down changes what the gate schedules,
 * and nothing about the diff will tell you that. The group order this file's
 * arms land in is asserted by `routing-table.test.mjs` against a written-out
 * list, for the same reason.
 */

/**
 * The last arms of the `tree` group — the GraphQL stub, the broad
 * `scripts/* | tools/*` sweep, the workspace-wide manifests, the pnpm files,
 * the patches directory and the top-level-service reminder — followed by the six
 * groups that run after it.
 *
 * Four of those six are `realTreeOnly`: they are repository-specific, and the
 * gate's own self-test runs this script against throwaway fixture repositories
 * that own neither the Sentry suites nor the symlinks they enumerate. Two are
 * `dynamic`: their patterns come from a set the engine computes at run time —
 * the resolved targets of `scripts/` symlinks, and the stack paths registered in
 * `terraform.stacks.json` — so the table owns their POSITION in the order and
 * the engine owns their contents.
 */
export const WORKSPACE_ARMS = [
  {
    patterns: ["scripts/envio-schema-stubs.graphql"],
    effects: [
      {
        why: "Shared Envio SDL stub fragment, read at test time by BOTH the dashboard and metrics-bridge GraphQL contract suites (and scripts/schema-diff.mjs) to make buildSchema() parse. A stub-only edit can break those contract tests, so route it to both packages' quality commands (test:coverage runs the contract suites) — the local mirror of the ui/bridge CI paths-filters. add_package_quality_commands omits test:browser, so this stays light.",
        surface: "scripts",
      },
      {
        verb: "add_dashboard_codegen",
        args: [
          "shared Envio schema stub changed (dashboard GraphQL types read it)",
        ],
      },
      {
        verb: "add_package_quality_commands",
        args: [
          "@mento-protocol/ui-dashboard",
          "shared Envio schema stub changed (dashboard GraphQL contract test reads it)",
        ],
      },
      {
        verb: "add_package_quality_commands",
        args: [
          "@mento-protocol/metrics-bridge",
          "shared Envio schema stub changed (bridge GraphQL contract test reads it)",
        ],
      },
    ],
  },
  {
    patterns: ["scripts/*", "tools/*"],
    effects: [{ surface: "scripts" }],
  },
  {
    patterns: ["terraform.stacks.json"],
    effects: [
      { surface: "terraform" },
      { command: "pnpm tf:test", reason: "Terraform stack registry changed" },
      {
        verb: "add_terraform_validate_commands",
        args: ["terraform", "Terraform stack registry changed"],
      },
      {
        verb: "add_terraform_validate_commands",
        args: ["alerts/rules", "Terraform stack registry changed"],
      },
      {
        verb: "add_terraform_validate_commands",
        args: ["alerts/infra", "Terraform stack registry changed"],
      },
      {
        verb: "add_terraform_validate_commands",
        args: ["aegis/terraform", "Terraform stack registry changed"],
      },
      {
        verb: "add_terraform_validate_commands",
        args: ["governance-watchdog/infra", "Terraform stack registry changed"],
      },
      {
        verb: "add_registered_terraform_validate_commands",
        args: ["Terraform stack registry changed"],
      },
      {
        checklist: "docs/pr-checklists/ci-workflow-gates.md",
        reason: "Terraform stack registry changed",
      },
      {
        checklist: "docs/pr-checklists/architecture-decisions.md",
        reason:
          "Terraform stack registry changed — a new stack likely needs an ADR",
      },
      { adrReminder: "Terraform stack registry changed — ADR reminder" },
    ],
  },
  {
    patterns: ["package.json"],
    effects: [
      { set: "root_package_json_class" },
      {
        dispatch: "root_package_json_class",
        arms: [
          {
            patterns: ["root-tooling-scripts"],
            effects: [],
          },
          {
            patterns: ["package-scripts"],
            effects: [],
          },
          {
            patterns: ["workspace-dev-metadata"],
            effects: [
              {
                why: "devDependencies / descriptive metadata only (GitHub issue #1414): reinstall + skew/lockfile lint, plus the @mento-protocol/config bundle as canary (it typechecks three downstream consumers). Trunk still full-scans package.json via trunk_requires_full_scan.",
                surface: "workspace",
              },
              {
                preflight: "pnpm install --frozen-lockfile",
                reason: "workspace dev metadata changed",
              },
              {
                command: "pnpm skew:check",
                reason: "workspace dev metadata changed",
              },
              {
                command: "pnpm lockfile:lint",
                reason: "workspace dev metadata changed",
              },
              {
                verb: "add_package_quality_commands",
                args: [
                  "@mento-protocol/config",
                  "workspace dev metadata changed (config typechecks downstream consumers as canary)",
                ],
              },
            ],
          },
          {
            patterns: ["*"],
            effects: [
              { surface: "workspace" },
              {
                preflight: "pnpm install --frozen-lockfile",
                reason: "workspace dependency/config changed",
              },
              {
                command: "bash scripts/agent-quality-gate.test.sh",
                reason: "agent quality gate package script changed",
              },
              {
                verb: "add_workspace_quality_commands",
                args: ["workspace dependency/config changed"],
              },
            ],
          },
        ],
      },
    ],
  },
  {
    patterns: ["pnpm-lock.yaml"],
    effects: [{ verb: "route_lockfile_change" }],
  },
  {
    patterns: ["pnpm-workspace.yaml"],
    effects: [
      { surface: "workspace" },
      {
        preflight: "pnpm install --frozen-lockfile",
        reason: "workspace dependency/config changed",
      },
      {
        verb: "add_workspace_quality_commands",
        args: ["workspace dependency/config changed"],
      },
      {
        adrReminder:
          "workspace membership/policy changed — ADR reminder (a new package likely needs an ADR)",
      },
    ],
  },
  {
    patterns: ["patches/*"],
    effects: [
      { surface: "workspace" },
      {
        preflight: "pnpm install --frozen-lockfile",
        reason: "pnpm patch changed",
      },
      { verb: "add_workspace_quality_commands", args: ["pnpm patch changed"] },
    ],
  },
  {
    patterns: [".node-version"],
    effects: [
      { surface: "workspace" },
      {
        preflight: "pnpm install --frozen-lockfile",
        reason: "Node version changed",
      },
      {
        verb: "add_workspace_quality_commands",
        args: ["Node version changed"],
      },
    ],
  },
  {
    patterns: ["*/package.json"],
    effects: [
      {
        why: "A TOP-LEVEL package.json not handled by an earlier package route is a new standalone service root (governance-watchdog-style: package.json but possibly no AGENTS.md). Restrict to a single path segment — a nested `pkg/sub/package.json` is a workspace member covered by the pnpm-workspace.yaml route, not a new top-level service. The reminder self-suppresses on an edit to an existing package.json anyway.",
        dispatch: "path",
        arms: [
          {
            patterns: ["*/*/*"],
            effects: [],
          },
          {
            patterns: ["*"],
            effects: [
              {
                adrReminder:
                  "top-level package.json changed — ADR reminder (a new package/service likely needs an ADR)",
              },
            ],
          },
        ],
      },
    ],
  },
];

export const TAIL_GROUPS = [
  {
    id: "terraform-root",
    why: "`pnpm tf:test` owns the fail-closed production identity contract. Route every complete-inventory input plus the contract implementation itself. Keep this after the specialized cases so ci.yml/infra.yml retain their more specific command reasons while `add_command` deduplicates the run.  `scripts/lib/*.mjs` covers the shared parsing cores the contract imports from outside its own directory (ADR 0064): `hcl.mjs` backs all five contract clusters plus the ADR 0053 deploy-staging contract, and `workflow-yaml.mjs` backs the workflow and refresh-routing checks. The unconditional real-tree sweep further down already runs `pnpm tf:test` for any non-empty change set, so this arm does not decide whether the suite runs — it names the reason and keeps the routing correct if that sweep is ever narrowed. The glob is deliberately wider than the two files so a future shared core added to `scripts/lib/` cannot land unrouted; the cost is that a core the contract does not read, such as `peg-policy-digest.mjs`, also gets this reason. Its own arm above routes the two peg suites. `scripts/terraform/*.mjs` (P10) does the same for the moved apply-path guards: `tf-stacks.mjs` imports two of them, so a change there reaches the contract through the wrapper.",
    arms: [
      {
        patterns: [
          "terraform/*",
          "aegis/terraform/*",
          "alerts/infra/*",
          "alerts/rules/*",
          "governance-watchdog/infra/*",
          ".github/workflows/*",
          "scripts/production-infra-identity-contract/*.mjs",
          "scripts/lib/*.mjs",
          "scripts/terraform/*.mjs",
          "scripts/sanitize-terraform-output.sh",
          "scripts/verify-github-environment-protection.mjs",
        ],
        effects: [
          {
            command: "pnpm tf:test",
            reason:
              "production infrastructure identity contract surface changed",
          },
        ],
      },
    ],
  },
  {
    id: "sentry-ci-coverage",
    realTreeOnly: true,
    arms: [
      {
        patterns: [
          ".github/workflows/*",
          ".github/actions/*",
          "package.json",
          "scripts/agent-quality-gate.sh",
          "scripts/check-agent-quality-gate-package-scripts.mjs",
          "scripts/sentry/ci-wiring/check-sentry-suites-in-ci*.mjs",
          "scripts/lib/static-imports.mjs",
          "scripts/sentry-*.test.mjs",
          "scripts/*/sentry-*.test.mjs",
          "scripts/tf-stacks.test.mjs",
        ],
        pairing: "paired",
        effects: [
          {
            command:
              "node scripts/sentry/ci-wiring/check-sentry-suites-in-ci.test.mjs",
            reason: "Sentry CI-coverage check reads this file",
          },
        ],
      },
    ],
  },
  {
    id: "sentry-suite-gate",
    why: "The self-run Sentry-suite gate (#1779, ADR 0062) runs EVERY suite the manifest owns and asserts each one's pass count against its committed floor, so every manifest-owned suite routes it — not just the gate's own files. Deleting a test from, say, sentry-triage-requeue.test.mjs leaves `pnpm sentry:requeue:test` green (30 passed, exit 0) while the gate reds on `pass 30 < floor 31`; without this arm the local gate misses that and it only surfaces after push. The same glob pair as above covers suites at any depth, and the gate's own three files ride along so all of them route the identical pair of commands.  Both commands are kept because neither substitutes for the other: the self-test proves the gate's LOGIC against throwaway fixture manifests in a temp dir and never reads the committed one, while the real gate is what validates the committed manifest against the real suites. `add_command` deduplicates on the exact command string, so a path matching both this arm and another one still schedules each command once.  Both run under `/usr/bin/env -u NODE_OPTIONS -u NODE_PATH`, matching the CI entry point. Without it a developer carrying a perfectly legitimate ambient `NODE_OPTIONS=--no-warnings` cannot run the gate at all — it refuses to start before executing a single suite — and half the self-test's fixtures fail for that same reason. The gate costs ~3s. `scripts/sentry/gate/sentry-suite-gate*.mjs` rather than the gate script alone: the round-8 split created sentry-suite-gate-fixtures.mjs, which this arm did not match, so a change to it scheduled Trunk and lint:scripts but NEITHER gate suite — and that file owns fixture environment isolation, the step-summary redirection and the shared harness. The prefix glob covers every current and future gate module, so the next split cannot reopen it.  `scripts/lib/static-imports.mjs` is named outright because it sits under neither prefix and yet decides both consumers' answers: the gate's watch set and exemption proof, and the CI-coverage check's import proof. It scheduled only Trunk, lint:scripts and tf:test when it was extracted, so a behavioural parser change was validated by neither gate suite nor the checker (Codex 3761572721). It is listed in the coverage-check arm above for the same reason. A shared module belongs in every arm that reads it, whatever it is called.  `check-sentry-suites-in-ci-core-commands.mjs` is here on the same ground, found by the dry-run sweep that closed the one above: the gate's exemption proof now parses the `tf:test` alias with that module's shell grammar, so a change to it changes a gate verdict while its name still says \"checker\". Four gaps of this shape have now come from naming files rather than deriving readers; the gate's own watch set is the derived answer, and teaching this mapping to consult it is the standing fix (#1803).",
    realTreeOnly: true,
    arms: [
      {
        patterns: [
          "scripts/sentry-*.test.mjs",
          "scripts/*/sentry-*.test.mjs",
          "scripts/sentry/gate/sentry-suite-gate*.mjs",
          "scripts/lib/static-imports.mjs",
          "scripts/sentry/ci-wiring/check-sentry-suites-in-ci-core-commands.mjs",
          "scripts/sentry/gate/sentry-suite-manifest.json",
        ],
        pairing: "paired",
        effects: [
          {
            verb: "add_sentry_suite_gate_commands",
            args: [
              "Sentry-suite gate, manifest, or a manifest-owned suite changed",
            ],
          },
        ],
      },
    ],
  },
  {
    id: "scripts-symlink",
    why: "A directory symlink under scripts/ exposes suites the extension patterns above (and the CI `rootScripts` filter) never see: `findSentrySuites` follows the link and enumerates `scripts/<link>/sentry-*.test.mjs`, but the changed paths are the extensionless link itself and its target outside scripts/, matching neither. Route BOTH Sentry checks for ANY symlink under scripts/ so the suite it exposes is proven wired rather than silently skipped (Codex 3754355168). `-L` reads the working tree, matching what both enumerators walk.  The gate pair is what makes this arm load-bearing now. Until #1779 PR C the checker demanded a direct CI step for every enumerated suite, so it red on its own; PR C retired that assertion because the unconditional CI gate runs each suite instead — but the gate is a DIFFERENT command, and this arm was still scheduling only the checker. A suite added beneath such a link then left the checker green while the missing manifest entry reds only after push (Codex 3766397748). Coverage moved jobs; the routing has to move with it.",
    realTreeOnly: true,
    arms: [
      {
        patterns: ["scripts/*"],
        effects: [
          {
            when: "pathIsSymlink",
            effects: [
              {
                command:
                  "node scripts/sentry/ci-wiring/check-sentry-suites-in-ci.test.mjs",
                reason:
                  "symlink under scripts/ can expose an unwired Sentry suite",
              },
              {
                verb: "add_sentry_suite_gate_commands",
                args: [
                  "symlink under scripts/ can expose an unwired Sentry suite",
                ],
              },
            ],
          },
        ],
      },
    ],
  },
  {
    id: "scripts-symlink-target",
    realTreeOnly: true,
    dynamic: "scriptsSymlinkTargets",
    arms: [
      {
        patterns: ["${scripts_symlink_target}/*"],
        effects: [
          {
            command:
              "node scripts/sentry/ci-wiring/check-sentry-suites-in-ci.test.mjs",
            reason:
              "change beneath a scripts/ symlink target can expose an unwired Sentry suite",
          },
          {
            verb: "add_sentry_suite_gate_commands",
            args: [
              "change beneath a scripts/ symlink target can expose an unwired Sentry suite",
            ],
          },
          { stop: true },
        ],
      },
    ],
  },
  {
    id: "registered-terraform-stacks",
    dynamic: "registeredTerraformStacks",
    requiresNonEmpty: true,
    arms: [
      {
        patterns: ["${terraform_stack_path}/*"],
        effects: [
          { surface: "terraform" },
          {
            verb: "add_terraform_validate_commands",
            args: [
              "${terraform_stack_path}",
              "registered Terraform stack changed",
            ],
          },
          {
            command: "pnpm tf:test",
            reason: "registered Terraform stack changed",
          },
          { stop: true },
        ],
      },
    ],
  },
];
