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
 * The eight groups that run before the big per-tree group: the documentation
 * surface, the documentation contracts, the review-skill evaluation contracts,
 * the Upstash MCP transport pin, the manifest and package-manager routes, the
 * shell-syntax route, the babysit repo hook, and the Vitest configuration
 * routes.
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
          {
            command: "pnpm docs:navigation-eval:test",
            reason:
              "tracked documentation can change navigation source budgets",
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
        // `CLAUDE.md` is the root AGENTS.md symlink and carries its own pin
        // block. Editing through the symlink shows up as `AGENTS.md`, but
        // replacing or deleting the link shows up as `CLAUDE.md` — the exact
        // change the pin exists to catch — so it routes here too.
        patterns: [
          "AGENTS.md",
          "CLAUDE.md",
          "*/AGENTS.md",
          ".codex/config.toml",
        ],
        effects: [
          { surface: "agent-context" },
          {
            command: "pnpm agent:context-budget --strict",
            reason: "agent instruction budget input changed",
          },
          {
            command: "node scripts/repo-health/check-guardrail-prose.mjs",
            reason:
              "agent instruction file holding pinned guardrail prose changed",
          },
        ],
      },
      {
        // The operating card carries the Non-negotiables the pin list protects.
        // It reaches no arm above, so this is the only route that runs the
        // guardrail-prose check when the card itself is edited.
        patterns: ["docs/notes/pr-operating-card.md"],
        effects: [
          {
            command: "node scripts/repo-health/check-guardrail-prose.mjs",
            reason: "operating card holding pinned guardrail prose changed",
          },
        ],
      },
    ],
  },
  {
    id: "review-eval-contracts",
    arms: [
      {
        patterns: ["docs/evals/review-skill*"],
        why: "The review-skill evaluation is comparable only while its contract holds: frozen truth digests, an explicit scorable-id list, frozen finder-report and prompt digests, and an append-only ledger. All three checks are hermetic — no model, no network — so the gate can prove a contract edit before it reaches CI. `*` matches `/` in a bash `case`, so this one pattern also covers `review-skill-truth/` and `review-skill-finder-reports/`.",
        effects: [
          { surface: "docs" },
          {
            command: "pnpm review:eval:test",
            reason: "review skill evaluation contract changed",
          },
          {
            command: "pnpm review:eval -- --check-fixtures --offline",
            reason: "review skill evaluation contract changed",
          },
          {
            command:
              "pnpm review:eval -- --check-ledger --require-base --revalidate-appended",
            reason: "review skill evaluation contract changed",
          },
        ],
      },
      {
        patterns: ["scripts/review/*"],
        why: "The harness scores itself, so a scorer, matcher, or prompt edit moves the comparability key and can silently change every later number. Same three hermetic checks as the contract arm; the surface comes from the `scripts/` arm in the tree group.",
        effects: [
          {
            command: "pnpm review:eval:test",
            reason: "review skill evaluation harness changed",
          },
          {
            command: "pnpm review:eval -- --check-fixtures --offline",
            reason: "review skill evaluation harness changed",
          },
          {
            command:
              "pnpm review:eval -- --check-ledger --require-base --revalidate-appended",
            reason: "review skill evaluation harness changed",
          },
        ],
      },
      {
        patterns: [".gitignore"],
        why: "Review-eval publication relies on the scoped cells/ ignore rule to keep raw model transcripts out of Git and autoreview bundles.",
        effects: [
          {
            command: "pnpm review:eval:test",
            reason: "review-eval raw cell exclusion changed",
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
            why: "The `code-health:deps` script line lives in this file, and its positional arguments are one of the two sources `engine.test.mjs` holds the gate's scanned-root list set-equal to. The class dispatch below sends a script-only edit to the shell gate alone, and required CI never runs `engine.test.mjs`, so shrinking the scanned roots here would merge with the staleness test that exists to catch it never having been invoked. Routed for every root manifest change rather than only ones touching that line: a whole-file trigger cannot be defeated by reformatting, and this file changes rarely.",
            command: "node --test scripts/gate/mapping/engine.test.mjs",
            reason:
              "root manifest changed (gate pins its scanned roots against the code-health:deps script)",
          },
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
            why: "The engine narrows `pnpm code-health:deps` to the roots dependency-cruiser actually scans, and it holds those roots as a pinned constant. `engine.test.mjs` is what compares that constant with this file's `includeOnly.path` and with the root `code-health:deps` script, set-equal both ways. Without this route, adding a root here would leave the gate under-routing every change under it — a smaller plan, arrived at silently, which is the failure mode ADR 0069 exists to prevent.",
            command: "node --test scripts/gate/mapping/engine.test.mjs",
            reason:
              "dep-cruiser config changed (gate pins its scanned roots against this file)",
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
        // Named one by one rather than as an arm-wide flag: a fourth absent
        // path added to this arm later must red rather than inherit these.
        allowStale: {
          ".npmrc":
            "pnpm configuration this repository does not carry today. The arm exists so that adding one routes a frozen-lockfile install on the commit that adds it, rather than one commit later.",
          "pnpmfile.cjs":
            "the CommonJS pnpm hook file, which this repository does not carry. Routed for the same reason as .npmrc: adding one must schedule an install on its own commit.",
          ".pnpmfile.cjs":
            "the dot-prefixed spelling of the same pnpm hook file, which pnpm also accepts and this repository does not carry.",
        },
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
    id: "babysit-repo-hook",
    arms: [
      {
        patterns: [".claude/babysit-pr.sh", ".claude/babysit-pr.test.sh"],
        why: "The babysit repo hook gates PR readiness for every babysit surface, and its fork refusal is fail-closed. `bash -n` above only parses it, so a hook or suite edit routes the behavioural suite. Unconditional on purpose: with the suite file missing, `bash` exits 127 and the gate still fails closed.",
        effects: [
          {
            command: "bash .claude/babysit-pr.test.sh",
            reason: "babysit repo hook changed",
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
