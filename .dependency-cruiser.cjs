/**
 * Cross-package architecture rules for the monitoring monorepo.
 *
 * Tier 1 (this file, blocking):
 *   - no circular dependencies
 *   - no cross-package leakage between dashboard / indexer / metrics-bridge
 *   - shared-config must stay a leaf (no imports of other workspace packages)
 *
 * Tier 3 layer rules (intra-package: e.g. ui-dashboard `lib/` not importing
 * `components/`, indexer `handlers/` reaching into internals) ship in a later
 * PR as `warn` until a baseline is recorded.
 *
 * Run: `pnpm code-health:deps`
 * Graph: `pnpm code-health:deps:graph`  (requires graphviz `dot`)
 */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      // PR1 baseline records the known cycle indexer-envio/src/{pool,deviationBreach}.ts.
      // Promote to "error" in a follow-up after that cycle is broken (BACKLOG.md).
      severity: "warn",
      comment:
        "Circular dependencies make refactors fragile and obscure init order. Break the cycle by extracting the shared piece.",
      from: {},
      to: { circular: true },
    },
    {
      name: "indexer-no-dashboard",
      severity: "error",
      comment:
        "indexer-envio runs in Envio's runtime and must not import from ui-dashboard. Covers src/, test/, and the codegen/audit scripts under scripts/.",
      from: { path: "^indexer-envio/(src|test|scripts)/" },
      to: { path: "^ui-dashboard/" },
    },
    {
      name: "indexer-no-bridge",
      severity: "error",
      comment:
        "indexer-envio must not depend on metrics-bridge; the dependency flows the other way. Covers src/, test/, and scripts/.",
      from: { path: "^indexer-envio/(src|test|scripts)/" },
      to: { path: "^metrics-bridge/" },
    },
    {
      name: "indexer-no-shared-config",
      severity: "error",
      comment:
        "indexer-envio is intentionally isolated. It must not import shared-config; chain/token data comes from the indexer's own config or @mento-protocol/contracts. Covers src/, test/, and scripts/.",
      from: { path: "^indexer-envio/(src|test|scripts)/" },
      to: { path: "^shared-config/" },
    },
    {
      name: "dashboard-runtime-no-indexer",
      severity: "error",
      comment:
        "ui-dashboard runtime must not import indexer-envio. Reads happen via Hasura/GraphQL.",
      from: {
        path: "^ui-dashboard/src/",
        // Tests get their own (narrower) escape hatch — see next rule.
        pathNot: "(/__tests__/|\\.test\\.)",
      },
      to: { path: "^indexer-envio/" },
    },
    {
      name: "dashboard-tests-only-indexer-config-json",
      severity: "error",
      comment:
        "ui-dashboard tests may only import indexer-envio config JSON (data) for cross-validation. Runtime source is still off-limits. Covers src test files AND the top-level `tests/` dir (Playwright fixtures, browser flows) so files in tests/ can't bypass the boundary.",
      from: {
        path: "^ui-dashboard/(src/.*(/__tests__/|\\.test\\.)|tests/)",
      },
      to: {
        path: "^indexer-envio/",
        pathNot: "^indexer-envio/config/.*\\.json$",
      },
    },
    {
      name: "dashboard-tests-no-bridge",
      severity: "error",
      comment:
        "ui-dashboard's top-level tests/ dir (Playwright fixtures + browser flows) must not import metrics-bridge runtime. Same boundary the src rule enforces below.",
      from: { path: "^ui-dashboard/tests/" },
      to: { path: "^metrics-bridge/" },
    },
    {
      name: "dashboard-no-bridge",
      severity: "error",
      comment:
        "ui-dashboard must not import metrics-bridge source; the bridge is a separate Cloud Run service.",
      from: { path: "^ui-dashboard/src/" },
      to: { path: "^metrics-bridge/" },
    },
    {
      name: "bridge-no-indexer",
      severity: "error",
      comment:
        "metrics-bridge must not import indexer-envio source; reads happen through the Hasura/GraphQL API. Covers `test/` too so test helpers can't smuggle in a cross-package path.",
      from: { path: "^metrics-bridge/(src|test)/" },
      to: { path: "^indexer-envio/" },
    },
    {
      name: "bridge-no-dashboard",
      severity: "error",
      comment:
        "metrics-bridge must not import ui-dashboard source (test/ included).",
      from: { path: "^metrics-bridge/(src|test)/" },
      to: { path: "^ui-dashboard/" },
    },
    {
      name: "shared-config-stays-leaf",
      severity: "error",
      comment:
        "shared-config is the leaf in the dep graph; no upward imports allowed. Tests get their own narrower escape hatch (see next rule); excluded here via pathNot because dep-cruiser evaluates each forbidden rule independently — without this exclusion the rule would fire on test config-JSON imports even though the next rule is supposed to allow them.",
      from: {
        path: "^shared-config/(src|__tests__)/",
        // Mirror `dashboard-runtime-no-indexer`: exclude test files so the
        // narrower test-allow rule below is the active gate for tests.
        pathNot: "^shared-config/__tests__/",
      },
      to: { path: "^(ui-dashboard|indexer-envio|metrics-bridge)/" },
    },
    {
      name: "shared-config-tests-only-indexer-config-json",
      severity: "error",
      comment:
        "shared-config tests may only import indexer-envio config JSON (data) for cross-validation. Runtime source is still off-limits. Mirrors `dashboard-tests-only-indexer-config-json`. Today's `__tests__/aggregators.test.ts` uses `new URL()` filesystem access (not a static import) so dep-cruiser doesn't see it — this rule is forward-looking for any future static `import data from \"…/config/*.json\"`.",
      from: { path: "^shared-config/__tests__/" },
      to: {
        path: "^indexer-envio/",
        pathNot: "^indexer-envio/config/.*\\.json$",
      },
    },
    {
      name: "shared-config-tests-no-dashboard-or-bridge",
      severity: "error",
      comment:
        "shared-config tests must not import ui-dashboard or metrics-bridge runtime. The dashboard/bridge boundary has no data-only escape hatch like the indexer one.",
      from: { path: "^shared-config/__tests__/" },
      to: { path: "^(ui-dashboard|metrics-bridge)/" },
    },
  ],
  options: {
    doNotFollow: {
      path: [
        "node_modules",
        "(^|/)\\.envio($|/)",
        "(^|/)\\.next($|/)",
        "(^|/)dist($|/)",
        "(^|/)build($|/)",
        "(^|/)coverage($|/)",
        "(^|/)reports($|/)",
        "(^|/)\\.claude/worktrees($|/)",
      ],
    },
    exclude: {
      path: [
        "node_modules",
        "(^|/)\\.envio($|/)",
        "(^|/)\\.next($|/)",
        "(^|/)dist($|/)",
        "(^|/)build($|/)",
        "(^|/)coverage($|/)",
        "(^|/)reports($|/)",
        "(^|/)\\.claude/worktrees($|/)",
        "(^|/)\\.git($|/)",
      ],
    },
    includeOnly: {
      path: "^(shared-config|ui-dashboard|indexer-envio|metrics-bridge)/",
    },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["types", "node", "import", "require"],
      mainFields: ["main", "types"],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
