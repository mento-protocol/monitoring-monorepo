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
    patterns: [
      "scripts/agent-autoreview.mjs",
      "scripts/agent-autoreview-core.mjs",
      "scripts/agent-autoreview-core.test.mjs",
      "scripts/agent-autoreview-target-guard.test.mjs",
    ],
    effects: [
      {
        command: "pnpm agent:autoreview:test",
        reason: "agent autoreview helper changed",
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
        why: "The `gh` runner, pagination guard, Documentation Garden workflow authorization, label bootstrap, and queue-state arbitration behind both scheduled issue automations. Neither suite covers the other's consumer, so a shared module belongs in both arms.",
        command: "pnpm docs:garden:test",
        reason: "shared GitHub issue lifecycle module changed",
      },
      {
        command: "pnpm docs:navigation-eval:test",
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
    why: "The routing table as data (ADR 0068). Its own suite owns the schema, ADR 0064's pairing rule, path staleness, the bash-oracle proof of the pattern compiler, and the equality check against the `case` arms in this file. The gate self-test rides along because every module here is in `implementation_signature()`: a change to one moves the freshness signature, which is gate behaviour whether or not the gate reads the table yet.",
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
      "scripts/pr/issue-board-transport.mjs",
    ],
    effects: [
      {
        why: "agent-issue-board.mjs is the entry point over six layers (cli, transport, state, projects, backfill, commands). The one suite covers the pure state machine through the entry's re-exports, so every layer routes to it.",
        command: "pnpm issue:board:test",
        reason: "agent issue board helper changed",
      },
    ],
  },
];
