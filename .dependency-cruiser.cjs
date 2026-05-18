/**
 * Cross-package architecture rules for the monitoring monorepo.
 *
 * Tier 1 (this file, blocking):
 *   - no circular dependencies
 *   - no cross-package leakage between dashboard / indexer / metrics-bridge / aegis
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
      severity: "error",
      comment:
        "Circular dependencies make refactors fragile and obscure init order. Break the cycle by extracting the shared piece.",
      from: {},
      to: { circular: true },
    },
    {
      name: "indexer-no-dashboard",
      severity: "error",
      comment:
        "indexer-envio runs in Envio's runtime and must not import from ui-dashboard. Whole-package scope: src/, test/, scripts/, AND package-root configs (eslint.config.mjs, vitest.config.ts, stryker.config.mjs, envio-env.d.ts). Generated dirs (.envio/, build/) are excluded at the options level below.",
      from: { path: "^indexer-envio/" },
      to: { path: "^ui-dashboard/" },
    },
    {
      name: "indexer-no-bridge",
      severity: "error",
      comment:
        "indexer-envio must not depend on metrics-bridge. Whole-package scope (see indexer-no-dashboard for the same rationale).",
      from: { path: "^indexer-envio/" },
      to: { path: "^metrics-bridge/" },
    },
    {
      name: "indexer-no-shared-config",
      severity: "error",
      comment:
        "indexer-envio is intentionally isolated. It must not import shared-config; chain/token data comes from the indexer's own config or @mento-protocol/contracts. Whole-package scope.",
      from: { path: "^indexer-envio/" },
      to: { path: "^shared-config/" },
    },
    {
      name: "dashboard-runtime-no-indexer",
      severity: "error",
      comment:
        "ui-dashboard runtime must not import indexer-envio. Reads happen via Hasura/GraphQL. Whole-package scope so package-root configs (next.config.ts, sentry.*.config.ts, vitest.config.ts, etc.) and scripts/ are also covered. Tests get their own narrower escape hatch — see next rule.",
      from: {
        path: "^ui-dashboard/",
        pathNot:
          "(/__tests__/|\\.test\\.|^ui-dashboard/tests/|^ui-dashboard/next-env\\.d\\.ts$)",
      },
      to: { path: "^indexer-envio/" },
    },
    {
      name: "dashboard-tests-only-indexer-config-json",
      severity: "error",
      comment:
        "ui-dashboard tests may only import indexer-envio config JSON (data) for cross-validation. Runtime source is still off-limits. Three alternations cover the test path conventions in this package: (a) files directly under src/__tests__/, (b) nested __tests__ or *.test.* under src/, (c) the top-level tests/ dir (Playwright fixtures + browser flows). The earlier two-alt version missed (a) — a future helper like src/__tests__/foo.ts (no .test. extension) would have bypassed both this rule and dashboard-runtime-no-indexer (whose pathNot excludes /__tests__/).",
      from: {
        path: "^ui-dashboard/(src/__tests__/|src/.*(/__tests__/|\\.test\\.)|tests/)",
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
        "ui-dashboard tests (all conventions: src/__tests__/, src/*.test.*, and top-level tests/) must not import metrics-bridge runtime. Mirrors the runtime rule's coverage.",
      from: {
        path: "^ui-dashboard/(src/__tests__/|src/.*(/__tests__/|\\.test\\.)|tests/)",
      },
      to: { path: "^metrics-bridge/" },
    },
    {
      name: "dashboard-no-bridge",
      severity: "error",
      comment:
        "ui-dashboard must not import metrics-bridge source; the bridge is a separate Cloud Run service. Whole-package scope — same coverage as dashboard-runtime-no-indexer.",
      from: {
        path: "^ui-dashboard/",
        pathNot:
          "(/__tests__/|\\.test\\.|^ui-dashboard/tests/|^ui-dashboard/next-env\\.d\\.ts$)",
      },
      to: { path: "^metrics-bridge/" },
    },
    {
      name: "bridge-no-indexer",
      severity: "error",
      comment:
        "metrics-bridge must not import indexer-envio source; reads happen through the Hasura/GraphQL API. Whole-package scope: src/, test/, AND package-root configs (vitest.config.ts, stryker.config.mjs, etc.).",
      from: { path: "^metrics-bridge/" },
      to: { path: "^indexer-envio/" },
    },
    {
      name: "bridge-no-dashboard",
      severity: "error",
      comment:
        "metrics-bridge must not import ui-dashboard source. Whole-package scope.",
      from: { path: "^metrics-bridge/" },
      to: { path: "^ui-dashboard/" },
    },
    {
      name: "shared-config-stays-leaf",
      severity: "error",
      comment:
        "shared-config is the leaf in the dep graph; no upward imports allowed. Whole-package scope covers src/, __tests__/, AND eslint.config.mjs. Tests get their own narrower escape hatch (see next rule); excluded here via pathNot because dep-cruiser evaluates each forbidden rule independently — without this exclusion the rule would fire on test config-JSON imports even though the next rule is supposed to allow them.",
      from: {
        path: "^shared-config/",
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
    {
      name: "aegis-no-dashboard-indexer-bridge",
      severity: "error",
      comment:
        "Aegis is the App Engine v2 alerting service and must not import dashboard, indexer, or metrics-bridge internals. Shared monitoring metadata should be routed through shared-config.",
      from: { path: "^aegis/" },
      to: { path: "^(ui-dashboard|indexer-envio|metrics-bridge)/" },
    },
    {
      name: "dashboard-indexer-bridge-no-aegis",
      severity: "error",
      comment:
        "Aegis is a separate App Engine service. Dashboard, indexer, and metrics-bridge must not import its service or Terraform internals.",
      from: { path: "^(ui-dashboard|indexer-envio|metrics-bridge)/" },
      to: { path: "^aegis/" },
    },
    {
      name: "shared-config-no-aegis",
      severity: "error",
      comment:
        "shared-config is the leaf in the dep graph and must not import from Aegis.",
      from: { path: "^shared-config/" },
      to: { path: "^aegis/" },
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
        "^aegis/lib/",
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
        "^aegis/lib/",
      ],
    },
    includeOnly: {
      path: "^(shared-config|ui-dashboard|indexer-envio|metrics-bridge|aegis)/",
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
