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
 * The first third of the per-module dispatch under `scripts/*.mjs`: the agent
 * gate and autoreview helpers, the context and documentation tooling, and the
 * PR helpers.
 *
 * Each arm names exact module paths and the focused suite that covers them.
 * This is a list, not a hierarchy, and the staleness check is what keeps it
 * honest — a module that moves leaves an arm here that never matches again.
 */
export const AGENT_MODULE_ARMS = [
  {
    patterns: [
      "scripts/gate/quality-gate-coordinator*.mjs",
      "scripts/gate/agent-quality-gate-scheduler*.mjs",
      "scripts/gate/agent-quality-gate-fixture-processes.mjs",
      "scripts/gate/darwin-broker-launch-preflight*.mjs",
    ],
    effects: [
      {
        command: "pnpm agent:quality-gate:test",
        reason: "quality-gate coordinator changed",
      },
    ],
  },
  {
    why: "Autoreview imports the Darwin lineage modules and materializes the identity helper as part of its trusted runtime. These shared sources must exercise both consumers.",
    patterns: [
      "scripts/gate/darwin-process-identity-helper.mjs",
      "scripts/gate/darwin-process-lineage-model.mjs",
      "scripts/gate/darwin-process-lineage-state.mjs",
      "scripts/gate/darwin-process-lineage.mjs",
    ],
    effects: [
      {
        command: "pnpm agent:quality-gate:test",
        reason: "quality-gate process containment changed",
      },
      {
        command: "pnpm agent:autoreview:test",
        reason: "autoreview Darwin containment runtime changed",
      },
    ],
  },
  {
    patterns: [
      "scripts/gate/darwin-process-identity.test.mjs",
      "scripts/gate/darwin-process-lineage.test.mjs",
    ],
    effects: [
      {
        command: "pnpm agent:quality-gate:test",
        reason: "quality-gate process containment changed",
      },
    ],
  },
  {
    why: "The marker helper is shared by the gate, autoreview, the Sentry probe, and the CI gate extractor. A change must exercise every spawn surface and the routing oracle.",
    patterns: ["scripts/gate/mapped-command-process-identity*.mjs"],
    effects: [
      {
        command: "pnpm agent:quality-gate:test",
        reason: "mapped-command marker inheritance changed",
      },
      {
        command: "pnpm agent:autoreview:test",
        reason: "mapped-command marker inheritance changed",
      },
      {
        command: "pnpm sentry:broker:test",
        reason: "mapped-command marker inheritance changed",
      },
      {
        command:
          "node scripts/sentry/ci-wiring/check-sentry-suites-in-ci.test.mjs",
        reason: "mapped-command marker inheritance changed",
      },
      {
        command: "pnpm gate:routing-table:test",
        reason: "mapped-command marker inheritance changed",
      },
    ],
  },
  {
    patterns: ["scripts/check-agent-quality-gate-package-scripts.mjs"],
    effects: [
      {
        command: "node scripts/check-agent-quality-gate-package-scripts.mjs",
        reason: "agent quality gate package script validator changed",
      },
      {
        command: "pnpm agent:quality-gate:test",
        reason: "agent quality gate mapping changed",
      },
    ],
  },
  {
    patterns: ["scripts/production-infra-identity-contract/routing.test.mjs"],
    effects: [
      {
        command: "pnpm agent:quality-gate:test",
        reason: "agent quality gate mapping changed",
      },
    ],
  },
  {
    why: "The autoreview core exports the indexer-family source that arms-packages.mjs compiles. Autoreview executes the protected-main core, so it cannot see a candidate revision's new owner or false-to-true reclassification. The core path conservatively routes the checklist in both autoreview and the local gate. This intentionally overroutes unrelated core edits to preserve the trust boundary. A core-only edit must also exercise both the data-table parity suite and the live gate regression suite, in addition to its autoreview consumers.",
    patterns: ["scripts/agent-autoreview-core.mjs"],
    effects: [
      {
        command: "pnpm agent:autoreview:test",
        reason: "agent autoreview helper changed",
      },
      {
        checklist: "docs/pr-checklists/indexer-handler-invariants.md",
        reason: "indexer invariant routing source changed",
      },
      {
        why: "The scanner half of the #1943/#1970 canary (ADR 0068). Widening `credentialAssignmentKey`'s vocabulary re-traps the renamed Sentry fixtures, and nothing else would say so until the next autoreview run refused.",
        command: "node scripts/sentry/fixture-scan-canary.test.mjs",
        reason: "autoreview secret scanner changed",
      },
      {
        command: "pnpm gate:routing-table:test",
        reason: "indexer invariant routing source changed",
      },
      {
        command: "pnpm agent:quality-gate:test",
        reason: "indexer invariant routing source changed",
      },
    ],
  },
  {
    patterns: [
      "scripts/agent-autoreview.mjs",
      "scripts/agent-autoreview-core.test.mjs",
      "scripts/agent-autoreview-target-guard.test.mjs",
    ],
    effects: [
      {
        command: "pnpm agent:autoreview:test",
        reason: "agent autoreview helper changed",
      },
      {
        why: "The scanner half of the #1943/#1970 canary (ADR 0068). Widening `credentialAssignmentKey`'s vocabulary re-traps the renamed Sentry fixtures, and nothing else would say so until the next autoreview run refused.",
        command: "node scripts/sentry/fixture-scan-canary.test.mjs",
        reason: "autoreview secret scanner changed",
      },
    ],
  },
  {
    patterns: [
      "scripts/context/check-agent-context.mjs",
      "scripts/context/check-agent-context-helpers.mjs",
      "scripts/context/check-agent-context.test.mjs",
    ],
    effects: [
      {
        command: "pnpm agent:context-check",
        reason: "agent context checker changed",
      },
      {
        command: "node scripts/context/check-agent-context.test.mjs",
        reason: "agent context checker changed",
      },
    ],
  },
  {
    patterns: [
      "scripts/context/check-settings-contract.mjs",
      "scripts/context/check-settings-contract.test.mjs",
    ],
    effects: [
      {
        why: "The `.claude/settings.json` permission allowlist and the SessionEnd hook wiring for both runtimes. `check-agent-context.mjs` is the only caller, and its suite holds the one test of that forwarding, so a change here routes both suites plus the real enforcement pass.",
        command: "pnpm agent:context-check",
        reason: "agent settings contract changed",
      },
      {
        command: "node scripts/context/check-settings-contract.test.mjs",
        reason: "agent settings contract changed",
      },
      {
        command: "node scripts/context/check-agent-context.test.mjs",
        reason: "agent settings contract changed",
      },
    ],
  },
  {
    patterns: [
      "scripts/mcp/build-upstash-mcp-runtime.mjs",
      "scripts/mcp/render-upstash-mcp-config.mjs",
      "scripts/mcp/upstash-mcp-config.test.mjs",
      "scripts/mcp/upstash-mcp-launcher.mjs",
    ],
    effects: [
      {
        command: "node --test scripts/mcp/upstash-mcp-config.test.mjs",
        reason: "Upstash MCP transport contract changed",
      },
    ],
  },
  {
    patterns: [
      "scripts/repo-health/file-size-watchlist.mjs",
      "scripts/repo-health/file-size-watchlist-issue.mjs",
      "scripts/repo-health/file-size-watchlist.test.mjs",
    ],
    effects: [
      {
        command: "node --test scripts/repo-health/file-size-watchlist.test.mjs",
        reason: "file-size watchlist automation changed",
      },
    ],
  },
  {
    patterns: [
      "scripts/repo-health/check-guardrail-prose.mjs",
      "scripts/repo-health/check-guardrail-prose.test.mjs",
    ],
    effects: [
      {
        command: "node scripts/repo-health/check-guardrail-prose.test.mjs",
        reason: "guardrail prose checker changed",
      },
      {
        command: "node scripts/repo-health/check-guardrail-prose.mjs",
        reason: "guardrail prose checker changed",
      },
    ],
  },
  {
    patterns: [
      "scripts/repo-health/check-skills-mirror.mjs",
      "scripts/repo-health/check-skills-mirror.test.mjs",
    ],
    effects: [
      {
        command: "node scripts/repo-health/check-skills-mirror.test.mjs",
        reason: "skills mirror checker changed",
      },
      {
        command: "node scripts/repo-health/check-skills-mirror.mjs",
        reason: "skills mirror checker changed",
      },
    ],
  },
  {
    patterns: [
      "scripts/context/claude-runtime-document-registry.mjs",
      "scripts/context/docs-index.mjs",
      "scripts/context/docs-index-helpers.mjs",
      "scripts/context/docs-index.test.mjs",
    ],
    effects: [
      {
        command: "pnpm docs:index:test",
        reason: "documentation catalog helper changed",
      },
      {
        command: "pnpm docs:index --check",
        reason: "documentation catalog helper changed",
      },
      {
        command: "pnpm agent:context-check",
        reason: "documentation catalog metadata contract changed",
      },
    ],
  },
  {
    patterns: [
      "scripts/docs/docs-audit.mjs",
      "scripts/docs/docs-audit-helpers.mjs",
      "scripts/docs/docs-audit.test.mjs",
    ],
    effects: [
      {
        command: "pnpm docs:audit:test",
        reason: "documentation audit planner changed",
      },
      {
        command: "pnpm docs:audit --dry-run",
        reason: "documentation audit planner changed",
      },
      {
        command: "pnpm docs:index --check",
        reason: "documentation audit planner consumes the catalog",
      },
    ],
  },
  {
    patterns: [
      "scripts/docs/docs-garden-issue.mjs",
      "scripts/docs/docs-garden-issue-helpers.mjs",
      "scripts/docs/docs-garden-issue.test.mjs",
    ],
    effects: [
      {
        command: "pnpm docs:garden:test",
        reason: "documentation garden issue automation changed",
      },
      {
        command: "pnpm docs:audit --dry-run",
        reason: "documentation garden issue automation consumes the planner",
      },
      {
        command: "pnpm docs:index --check",
        reason: "documentation garden issue automation consumes the catalog",
      },
    ],
  },
  {
    patterns: [
      "scripts/docs/docs-navigation-eval.mjs",
      "scripts/docs/docs-navigation-eval-helpers.mjs",
      "scripts/docs/docs-navigation-eval-result.mjs",
      "scripts/docs/docs-navigation-eval-result-shape.mjs",
      "scripts/docs/docs-navigation-eval.test.mjs",
    ],
    effects: [
      {
        command: "pnpm docs:navigation-eval:test",
        reason: "documentation navigation evaluation changed",
      },
      {
        command: "pnpm docs:navigation-eval -- --check-fixtures",
        reason: "documentation navigation evaluation changed",
      },
      {
        command:
          "pnpm docs:navigation-eval -- --validate docs/evals/documentation-navigation-baseline.json --fixtures docs/evals/documentation-navigation-baseline-fixtures.json",
        reason: "documentation navigation evaluation changed",
      },
      {
        command: "pnpm docs:index --check",
        reason: "documentation navigation evaluation consumes the catalog",
      },
    ],
  },
  {
    patterns: ["scripts/lib/gh-issue-lifecycle.mjs"],
    effects: [
      {
        why: "The `gh` runner, pagination guard, Documentation Garden workflow authorization, label bootstrap, and queue-state arbitration behind all three scheduled issue automations, plus the narrowed local Sentry projection label ensure. Each consumer suite must run here.",
        command: "pnpm docs:garden:test",
        reason: "shared GitHub issue lifecycle module changed",
      },
      {
        command: "pnpm docs:navigation-eval:test",
        reason: "shared GitHub issue lifecycle module changed",
      },
      {
        command: "pnpm sentry:project:test",
        reason: "shared GitHub issue lifecycle module changed",
      },
      {
        command: "pnpm issue:board:test",
        reason: "shared GitHub issue lifecycle module changed",
      },
      {
        command: "pnpm review:eval:test",
        reason: "shared GitHub issue lifecycle module changed",
      },
    ],
  },
  {
    patterns: [
      "scripts/context/agent-context-budget.mjs",
      "scripts/context/agent-context-budget.test.mjs",
    ],
    effects: [
      {
        command: "pnpm agent:context-budget:test",
        reason: "agent context budget helper changed",
      },
      {
        command: "pnpm agent:context-budget --strict",
        reason: "agent context budget helper changed",
      },
    ],
  },
  {
    patterns: ["scripts/lighthouse-config.test.mjs"],
    effects: [
      {
        command: "node scripts/lighthouse-config.test.mjs",
        reason: "Lighthouse config assertion suite changed",
      },
    ],
  },
  {
    patterns: ["scripts/check-deploy-root-anchors.test.mjs"],
    effects: [
      {
        command: "node scripts/check-deploy-root-anchors.test.mjs",
        reason: "deploy root-anchor test changed",
      },
    ],
  },
  {
    patterns: [
      "scripts/pr/check-adr-reminder.mjs",
      "scripts/pr/check-adr-reminder.test.mjs",
    ],
    effects: [
      { command: "pnpm adr:check:test", reason: "ADR reminder helper changed" },
    ],
  },
  {
    patterns: [
      "scripts/gate/agent-prewarm.mjs",
      "scripts/gate/agent-prewarm.test.mjs",
    ],
    effects: [
      {
        command: "pnpm agent:prewarm:test",
        reason: "agent prewarm helper changed",
      },
    ],
  },
  {
    why: "The routing table as data (ADR 0069). Its own suite owns the schema, ADR 0064's pairing rule, path staleness, the bash-oracle proof of the pattern compiler, and the closed verb set the engine implements. The gate self-test rides along because every module here is in `implementation_signature()`: a change to one moves the freshness signature, which is gate behaviour.",
    patterns: ["scripts/gate/routing-table/*.mjs"],
    effects: [
      {
        command: "pnpm gate:routing-table:test",
        reason: "gate routing table changed",
      },
      {
        command: "pnpm agent:quality-gate:test",
        reason: "gate routing table is an implementation-signature input",
      },
    ],
  },
  {
    why: "The Node mapping engine (ADR 0069). This IS the routing: the gate builds its plan from the engine and executes it, so a change here changes what every gate run does. D5c retired the bash `case` arms, the in-gate byte comparison and the parity harness together (issue 2020), which leaves `engine.test.mjs` as the only thing pinning the verbs, the five post-passes and the root-manifest classifier. The arm also carries the gate self-test and the prewarm contract: both parse the stdout this module produces.",
    patterns: ["scripts/gate/mapping.mjs", "scripts/gate/mapping/*.mjs"],
    effects: [
      {
        command: "node --test scripts/gate/mapping/shell-quote.test.mjs",
        reason: "gate mapping engine changed",
      },
      {
        command: "node --test scripts/gate/mapping/engine.test.mjs",
        reason:
          "gate mapping engine changed (the only suite pinning its verbs and post-passes)",
      },
      {
        command: "pnpm agent:quality-gate:test",
        reason:
          "gate mapping engine produces the stdout the gate suite asserts on",
      },
      {
        command: "node scripts/gate/agent-prewarm.test.mjs",
        reason: "gate mapping engine produces the stdout agent:prewarm parses",
      },
      {
        command: "pnpm gate:routing-table:test",
        reason:
          "gate mapping engine implements the routing table's closed verb set",
      },
    ],
  },
  {
    why: "The bash-from-Node machinery. Its own suite already runs, because check-sentry-suites-in-ci.test.mjs imports it and the coverage arm routes that. What was missing is the OTHER consumer: ADR 0069's routing-table suite drives `runProbeShell`/`probeDirs` for the /bin/bash pattern oracle and `bashFunctionSource` for the implementation-signature pin. A change to the probe environment or to the end-of-function scan changes what both of those prove, and nothing said so.",
    patterns: [
      "scripts/sentry/ci-wiring/check-sentry-suites-in-ci-gate-extract.mjs",
    ],
    effects: [
      {
        command: "pnpm gate:routing-table:test",
        reason:
          "the routing table's bash oracle and signature pin run on this machinery",
      },
    ],
  },
  {
    patterns: [
      "scripts/pr/review-materiality.mjs",
      "scripts/pr/review-materiality-context.mjs",
      "scripts/pr/review-materiality.test.mjs",
    ],
    effects: [
      {
        command: "pnpm agent:review-materiality:test",
        reason: "agent review materiality helper changed",
      },
    ],
  },
  {
    patterns: [
      "scripts/pr/agent-issue-board.mjs",
      "scripts/pr/agent-issue-board.test.mjs",
      "scripts/pr/issue-board-backfill.mjs",
      "scripts/pr/issue-board-cli.mjs",
      "scripts/pr/issue-board-commands.mjs",
      "scripts/pr/issue-board-projects.mjs",
      "scripts/pr/issue-board-state.mjs",
      "scripts/pr/issue-board-sync.mjs",
      "scripts/pr/issue-board-transport.mjs",
    ],
    effects: [
      {
        why: "agent-issue-board.mjs is the entry point over seven layers (cli, transport, state, projects, backfill, commands, sync). The one suite covers the pure state machine through the entry's re-exports, so every layer routes to it.",
        command: "pnpm issue:board:test",
        reason: "agent issue board helper changed",
      },
    ],
  },
];
