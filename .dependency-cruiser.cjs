/**
 * Cross-package architecture rules for the monitoring monorepo.
 *
 * Tier 1 (this file, blocking):
 *   - no circular dependencies
 *   - no cross-package leakage between dashboard / indexer / metrics-bridge
 *   - shared-config must stay a leaf (no imports of other workspace packages)
 *
 * Tier 3 intra-package layer rules (also in this file, blocking):
 *   - dashboard: lib/ must not import components/ (direction: components → lib)
 *   - dashboard: route-private _components/ and _tabs/ stay inside their route
 *   - indexer: handlers must not reach into rpc/ implementation files directly;
 *     they must go through rpc/effects.ts (Effect API) or the rpc.ts barrel
 *     (DB helpers). Pre-inventory found zero violations; rules ship at error.
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

    // -------------------------------------------------------------------------
    // Intra-package layer rules (Tier 3)
    // Pre-inventory (PR #444) found zero violations for all three rules, so
    // they ship directly at error severity.
    // -------------------------------------------------------------------------

    {
      name: "dashboard-lib-no-components",
      severity: "error",
      comment:
        "ui-dashboard/src/lib/ must not import from src/components/. The allowed direction is components → lib (components may use lib utilities), never the reverse. lib/ is pure logic; components/ owns React rendering. Importing a component from lib would create an upward dependency and couple pure logic to the render layer. Tests under lib/ are excluded because test helpers may reference component types for assertion utilities.",
      from: {
        path: "^ui-dashboard/src/lib/",
        pathNot: "(/__tests__/|\\.test\\.)",
      },
      to: { path: "^ui-dashboard/src/components/" },
    },
    // Route-private encapsulation: one rule per route that owns _components/ or
    // _tabs/. Each rule forbids code from ANYWHERE in the dashboard source tree
    // (not just app/) from importing that route's private directory. The
    // `from.path` is intentionally `^ui-dashboard/src/` — a lib/ or components/
    // file reaching into route-private code is the same violation as a
    // neighbour-route doing so. The `from.pathNot` excludes only the owning
    // route's own subtree, so within-route imports (page.tsx → same-route
    // _components/, _tabs/ → same-route _components/, etc.) remain allowed.
    //
    // address-book: two rules, one per sub-route, so that
    // `address-book/AddressBookClient.tsx` cannot import
    // `address-book/[address]/_components/` (and vice versa). Excluding the
    // whole `address-book/` subtree in a single rule would allow that leakage.
    //
    // Pre-inventory (PR #444): zero cross-route violations; rules ship at error.
    {
      name: "dashboard-route-private-pools",
      severity: "error",
      comment:
        "ui-dashboard/src/app/pools/_components/ is private to the pools route. No code outside app/pools/ — including lib/, components/, or other routes — may import from it.",
      from: {
        path: "^ui-dashboard/src/",
        pathNot: "^ui-dashboard/src/app/pools/",
      },
      to: { path: "^ui-dashboard/src/app/pools/_components/" },
    },
    {
      name: "dashboard-route-private-pool-detail",
      severity: "error",
      comment:
        "ui-dashboard/src/app/pool/[poolId]/_components/ and _tabs/ are private to the pool-detail route. No code outside app/pool/[poolId]/ — including lib/, components/, or sibling routes — may import from them.",
      from: {
        path: "^ui-dashboard/src/",
        pathNot: "^ui-dashboard/src/app/pool/\\[poolId\\]/",
      },
      to: {
        path: "^ui-dashboard/src/app/pool/\\[poolId\\]/(_components|_tabs)/",
      },
    },
    {
      name: "dashboard-route-private-leaderboard",
      severity: "error",
      comment:
        "ui-dashboard/src/app/leaderboard/_components/ is private to the leaderboard route. No code outside app/leaderboard/ — including lib/, components/, or other routes — may import from it.",
      from: {
        path: "^ui-dashboard/src/",
        pathNot: "^ui-dashboard/src/app/leaderboard/",
      },
      to: { path: "^ui-dashboard/src/app/leaderboard/_components/" },
    },
    {
      name: "dashboard-route-private-address-book-root",
      severity: "error",
      comment:
        "ui-dashboard/src/app/address-book/_components/ is private to the address-book list route. The detail route (address-book/[address]/) must not import it, nor may any other file outside app/address-book/ (excluding the [address] sub-route).",
      from: {
        path: "^ui-dashboard/src/",
        pathNot: "^ui-dashboard/src/app/address-book/(?!\\[address\\])[^/]",
      },
      to: { path: "^ui-dashboard/src/app/address-book/_components/" },
    },
    {
      name: "dashboard-route-private-address-book-detail",
      severity: "error",
      comment:
        "ui-dashboard/src/app/address-book/[address]/_components/ is private to the address-detail route. The list route (address-book/, outside the [address] sub-tree) must not import it, nor may any other file outside app/address-book/[address]/.",
      from: {
        path: "^ui-dashboard/src/",
        pathNot: "^ui-dashboard/src/app/address-book/\\[address\\]/",
      },
      to: {
        path: "^ui-dashboard/src/app/address-book/\\[address\\]/_components/",
      },
    },
    {
      name: "dashboard-route-private-bridge-flows",
      severity: "error",
      comment:
        "ui-dashboard/src/app/bridge-flows/_components/ is private to the bridge-flows route. No code outside app/bridge-flows/ — including lib/, components/, or other routes — may import from it.",
      from: {
        path: "^ui-dashboard/src/",
        pathNot: "^ui-dashboard/src/app/bridge-flows/",
      },
      to: { path: "^ui-dashboard/src/app/bridge-flows/_components/" },
    },
    {
      name: "dashboard-route-private-revenue",
      severity: "error",
      comment:
        "ui-dashboard/src/app/revenue/_components/ is private to the revenue route. No code outside app/revenue/ — including lib/, components/, or other routes — may import from it.",
      from: {
        path: "^ui-dashboard/src/",
        pathNot: "^ui-dashboard/src/app/revenue/",
      },
      to: { path: "^ui-dashboard/src/app/revenue/_components/" },
    },
    {
      name: "indexer-handlers-no-rpc-internals",
      severity: "error",
      comment:
        "indexer-envio handlers must not import directly from rpc/ implementation files (pool-state, oracle-state, biPoolManager, breakers, etc.). The allowed paths are: rpc/effects.ts (the Envio Effect API facade, which provides per-batch memoisation, deduplication, and rate-limiting) and the rpc.ts barrel (which re-exports client primitives and the DB-query helpers used by SortedOracles). Bypassing effects.ts with a direct fetcher call means each handler invocation fires two RPC reads (preload + processing) instead of one, and loses cross-handler deduplication. Pre-inventory (PR #444): zero violations.",
      from: { path: "^indexer-envio/src/handlers/" },
      to: {
        path: "^indexer-envio/src/rpc/",
        pathNot: "^indexer-envio/src/rpc/effects\\.ts$",
      },
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
