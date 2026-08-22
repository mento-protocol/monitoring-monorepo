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
 * The dashboard and indexer arms of the `tree` group.
 *
 * The dashboard's shell-wrapper arm sits FIRST, above `ui-dashboard/*`, because
 * the two overlap and the wrapper arm is the specific one. Reordering them
 * would leave the wrapper arm unreachable.
 */

import { getIndexerHandlerInvariantRoutingFamilies } from "../../agent-autoreview-core.mjs";

const indexerHandlerInvariantFamilies =
  getIndexerHandlerInvariantRoutingFamilies();

function indexerHandlerInvariantExplicitPatterns(family) {
  return family.exact ?? [];
}

function indexerHandlerInvariantFallbackPatterns(family) {
  return family.fallback === undefined
    ? []
    : family.fallback.prefixes.flatMap((prefix) =>
        family.fallback.extensions.map(
          (extension) => `${prefix}*.${extension}`,
        ),
      );
}

function uniquePatterns(patterns) {
  return [...new Set(patterns)];
}

const indexerHandlerInvariantExcludedPatterns = uniquePatterns([
  ...indexerHandlerInvariantFamilies
    .filter(({ fallback, route }) => fallback === undefined && !route)
    .flatMap(indexerHandlerInvariantExplicitPatterns),
]);

const indexerHandlerInvariantRoutedPatterns = uniquePatterns(
  indexerHandlerInvariantFamilies
    .filter(({ fallback, route }) => fallback === undefined && route)
    .flatMap(indexerHandlerInvariantExplicitPatterns),
);
const indexerHandlerInvariantTypeScriptPatterns =
  indexerHandlerInvariantFamilies
    .filter(({ fallback }) => fallback !== undefined)
    .flatMap(indexerHandlerInvariantFallbackPatterns);
const indexerHandlerInvariantExternalInventoryPatterns = [
  "indexer-envio/abis/*",
  "indexer-envio/config/*",
];
const indexerHandlerInvariantInventoryPatterns = uniquePatterns([
  ...indexerHandlerInvariantExternalInventoryPatterns,
  ...indexerHandlerInvariantFamilies
    .flatMap(indexerHandlerInvariantExplicitPatterns)
    .filter(
      (pattern) =>
        !pattern.startsWith("indexer-envio/abis/") &&
        !pattern.startsWith("indexer-envio/config/") &&
        !pattern.startsWith("indexer-envio/src/") &&
        !pattern.startsWith("indexer-envio/test/"),
    ),
  ...indexerHandlerInvariantTypeScriptPatterns,
]);

export const PACKAGE_ARMS = [
  {
    patterns: ["ui-dashboard/scripts/*.sh"],
    effects: [
      { surface: "ui-dashboard" },
      {
        dispatch: "path",
        arms: [
          {
            patterns: [
              "ui-dashboard/scripts/vercel-ignore-build.sh",
              "ui-dashboard/scripts/vercel-ignore-build.test.sh",
            ],
            effects: [
              {
                command:
                  "bash ui-dashboard/scripts/vercel-ignore-build.test.sh",
                reason: "Vercel ignore build script changed",
              },
            ],
          },
          {
            patterns: [
              "ui-dashboard/scripts/check-react-doctor-diff.sh",
              "ui-dashboard/scripts/check-react-doctor-score.sh",
            ],
            effects: [
              {
                why: "agent-quality-gate.test.sh copies and runs the diff wrapper in a stub repo, so the routing suite is this pair's real regression test.",
                command: "pnpm agent:quality-gate:test",
                reason: "React Doctor wrapper changed",
              },
            ],
          },
        ],
      },
    ],
  },
  {
    patterns: ["ui-dashboard/*"],
    effects: [
      { surface: "ui-dashboard" },
      {
        verb: "add_dashboard_quality_commands",
        args: ["ui-dashboard changed"],
      },
      {
        verb: "add_ui_react_doctor_diff",
        args: ["ui-dashboard client code should keep React Doctor clean"],
      },
      {
        verb: "add_ui_react_doctor_full_score",
        args: ["ui-dashboard React Doctor score should stay 100"],
      },
      {
        why: "Bundle size budget gate — mirrors `.github/workflows/size-limit.yml`. Any change under ui-dashboard/ that can affect the client build (src files, root config files like postcss/sentry-shared/next/tsconfig) re-runs the build + size-limit check locally before opening a PR. Browser fixtures and other nested .mjs files are deliberately excluded: they can invalidate browser-test cache entries without forcing an unrelated dashboard build cache miss.",
        dispatch: "path",
        arms: [
          {
            patterns: [
              "ui-dashboard/src/*",
              "ui-dashboard/package.json",
              "ui-dashboard/next.config.*",
              "ui-dashboard/postcss.config.*",
              "ui-dashboard/sentry.*.config.*",
              "ui-dashboard/sentry.shared.ts",
              "ui-dashboard/tsconfig*.json",
              "ui-dashboard/.size-limit.cjs",
              "ui-dashboard/vercel.json",
              "ui-dashboard/.env.production.local.example",
            ],
            effects: [
              {
                verb: "add_ui_size_limit",
                args: ["ui-dashboard bundle inputs changed"],
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
              "ui-dashboard/src/app/*",
              "ui-dashboard/src/components/*",
              "ui-dashboard/src/lib/graphql.ts",
              "ui-dashboard/src/hooks/*",
              "ui-dashboard/src/lib/queries.ts",
              "ui-dashboard/src/lib/queries/*",
              "ui-dashboard/src/lib/bridge-queries.ts",
              "ui-dashboard/src/lib/bridge-flows/use-bridge-gql.ts",
              "ui-dashboard/src/lib/gql-retry.ts",
              "ui-dashboard/src/lib/fetch-all-networks.ts",
              "ui-dashboard/src/lib/fetch-json.ts",
              "ui-dashboard/src/lib/network-fetcher/*",
              "ui-dashboard/src/lib/og-graphql-client.ts",
              "ui-dashboard/src/lib/homepage-og.ts",
              "ui-dashboard/src/lib/pool-og.ts",
              "ui-dashboard/src/lib/bridge-flows-og.ts",
              "ui-dashboard/src/lib/hasura-timeout.ts",
              "ui-dashboard/src/lib/mento-address-discovery.ts",
            ],
            effects: [
              {
                checklist: "docs/pr-checklists/swr-polling-hasura.md",
                reason: "Hasura/SWR/query path changed",
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
              "ui-dashboard/src/app/*",
              "ui-dashboard/src/components/*",
              "ui-dashboard/src/hooks/*",
              "ui-dashboard/src/lib/*",
            ],
            effects: [
              {
                checklist: "docs/pr-checklists/stateful-data-ui.md",
                reason: "dashboard data or UI flow changed",
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
              "ui-dashboard/src/app/*/layout.tsx",
              "ui-dashboard/src/app/*/page.tsx",
              "ui-dashboard/src/app/*/_lib/*metadata*",
            ],
            effects: [
              {
                checklist: "docs/pr-checklists/dynamic-route-metadata.md",
                reason: "dynamic route or metadata-adjacent file changed",
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
              "ui-dashboard/src/components/*",
              "ui-dashboard/src/app/*/_components/*",
              "ui-dashboard/src/lib/use-roving-*",
            ],
            effects: [
              {
                checklist:
                  "docs/pr-checklists/keyboard-a11y-controlled-widgets.md",
                reason: "controlled dashboard component changed",
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
              "ui-dashboard/stryker.config.mjs",
              "ui-dashboard/vitest.mutation.config.ts",
              "ui-dashboard/src/lib/weekend.ts",
              "ui-dashboard/src/lib/pool-id.ts",
              "ui-dashboard/src/lib/__tests__/weekend.test.ts",
              "ui-dashboard/src/lib/__tests__/pool-id.test.ts",
            ],
            effects: [
              {
                checklist: "docs/pr-checklists/mutation-testing.md",
                reason: "dashboard mutation baseline changed",
              },
              {
                verb: "add_ui_mutation_baseline",
                args: ["dashboard mutation baseline changed"],
              },
            ],
          },
        ],
      },
    ],
  },
  {
    patterns: ["indexer-envio/*"],
    effects: [
      { surface: "indexer-envio" },
      {
        dispatch: "path",
        arms: [
          {
            patterns: [
              "indexer-envio/schema.graphql",
              "indexer-envio/abis/*",
              "indexer-envio/scripts/run-envio-with-env.mjs",
              "indexer-envio/package.json",
            ],
            effects: [
              {
                verb: "add_all_indexer_codegen",
                args: ["indexer schema/source/ABI/package path changed"],
              },
              {
                verb: "add_dashboard_codegen",
                args: [
                  "indexer schema/source path changed (dashboard GraphQL types read schema.graphql)",
                ],
              },
              {
                checklist: "docs/pr-checklists/stateful-data-ui.md",
                reason: "indexer data flow changed",
              },
            ],
          },
          {
            patterns: ["indexer-envio/src/EventHandlersBridgeOnly.ts"],
            effects: [
              {
                verb: "add_bridge_codegen_then_restore_mainnet",
                args: ["bridge handler registration path changed"],
              },
              {
                checklist: "docs/pr-checklists/stateful-data-ui.md",
                reason: "indexer data flow changed",
              },
            ],
          },
          {
            patterns: [
              "indexer-envio/src/handlers/susds*.ts",
              "indexer-envio/src/handlers/susds/*",
              "indexer-envio/src/handlers/steth*.ts",
              "indexer-envio/src/handlers/steth/*",
            ],
            effects: [
              {
                verb: "add_reserve_yield_codegen_then_restore_mainnet",
                args: ["reserve-yield handler path changed"],
              },
              {
                checklist: "docs/pr-checklists/stateful-data-ui.md",
                reason: "indexer data flow changed",
              },
            ],
          },
          {
            patterns: [
              "indexer-envio/src/rpc/susds.ts",
              "indexer-envio/src/rpc/effects.ts",
            ],
            effects: [
              {
                verb: "add_reserve_yield_codegen_then_restore_mainnet",
                args: ["reserve-yield RPC path changed"],
              },
              {
                checklist: "docs/pr-checklists/stateful-data-ui.md",
                reason: "indexer data flow changed",
              },
            ],
          },
          {
            patterns: ["indexer-envio/src/handlers/wormhole/*"],
            effects: [
              {
                verb: "add_bridge_codegen_then_restore_mainnet",
                args: ["bridge handler registration path changed"],
              },
              {
                verb: "add_indexer_testnet_codegen",
                args: ["indexer handler registration path changed"],
              },
              {
                checklist: "docs/pr-checklists/stateful-data-ui.md",
                reason: "indexer data flow changed",
              },
            ],
          },
          {
            patterns: [
              "indexer-envio/src/EventHandlers.ts",
              "indexer-envio/src/handlers/*",
            ],
            effects: [
              {
                verb: "add_indexer_testnet_codegen",
                args: ["indexer handler registration path changed"],
              },
              {
                verb: "add_indexer_mainnet_codegen",
                args: ["indexer handler registration path changed"],
              },
              {
                verb: "add_reserve_yield_codegen_then_restore_mainnet",
                args: ["reserve-yield handler registration path changed"],
              },
              {
                checklist: "docs/pr-checklists/stateful-data-ui.md",
                reason: "indexer data flow changed",
              },
            ],
          },
          {
            patterns: ["indexer-envio/src/*"],
            effects: [
              {
                checklist: "docs/pr-checklists/stateful-data-ui.md",
                reason: "indexer data flow changed",
              },
            ],
          },
        ],
      },
      {
        dispatch: "path",
        arms: [
          {
            patterns: ["indexer-envio/config/*.json"],
            effects: [
              {
                checklist: "docs/pr-checklists/stateful-data-ui.md",
                reason: "indexer config data flow changed",
              },
            ],
          },
        ],
      },
      {
        dispatch: "path",
        arms: [
          {
            patterns: ["indexer-envio/config.multichain.mainnet.yaml"],
            effects: [
              {
                verb: "add_indexer_mainnet_codegen",
                args: ["mainnet indexer config changed"],
              },
              {
                verb: "add_reserve_yield_codegen_then_restore_mainnet",
                args: ["reserve-yield indexer config changed"],
              },
              {
                checklist: "docs/pr-checklists/stateful-data-ui.md",
                reason: "indexer data flow changed",
              },
            ],
          },
          {
            patterns: ["indexer-envio/config.multichain.testnet.yaml"],
            effects: [
              {
                verb: "add_indexer_testnet_codegen",
                args: ["testnet indexer config changed"],
              },
              {
                checklist: "docs/pr-checklists/stateful-data-ui.md",
                reason: "indexer data flow changed",
              },
            ],
          },
          {
            patterns: ["indexer-envio/config.multichain.bridge-only.yaml"],
            effects: [
              {
                verb: "add_bridge_codegen_then_restore_mainnet",
                args: ["bridge-only indexer config changed"],
              },
              {
                checklist: "docs/pr-checklists/stateful-data-ui.md",
                reason: "indexer data flow changed",
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
              "indexer-envio/stryker.config.mjs",
              "indexer-envio/vitest.mutation.config.ts",
              "indexer-envio/src/helpers.ts",
              "indexer-envio/src/tradingLimits.ts",
              "indexer-envio/src/handlers/stables/classifyKind.ts",
              "indexer-envio/src/handlers/stables/dailyFlush.ts",
              "indexer-envio/test/code-quality-invariants.test.ts",
              "indexer-envio/test/pool-helpers.test.ts",
              "indexer-envio/test/tradingLimits.test.ts",
              "indexer-envio/test/stables.test.ts",
              "indexer-envio/config/*.json",
            ],
            effects: [
              {
                checklist: "docs/pr-checklists/mutation-testing.md",
                reason: "indexer mutation baseline changed",
              },
              {
                verb: "add_indexer_mutation_baseline",
                args: ["indexer mutation baseline changed"],
              },
            ],
          },
        ],
      },
      {
        why: "Every current or future src/test TypeScript path and every focused external runtime or test-support input must keep an explicit owner in the core. This test runs for all seventeen inventory patterns before a later scripts-only change can discover drift.",
        dispatch: "path",
        arms: [
          {
            patterns: indexerHandlerInvariantInventoryPatterns,
            effects: [
              {
                command:
                  "node --test scripts/gate/routing-table/indexer-invariant-parity.test.mjs",
                reason: "indexer invariant routing inventory changed",
              },
            ],
          },
        ],
      },
      {
        why: "The shared autoreview core owns the exact indexer family dispositions. The first arm carries explicit exclusions; the second carries explicit routes. Future TypeScript patterns only trigger the inventory check until they gain an explicit owner.",
        dispatch: "path",
        arms: [
          {
            patterns: indexerHandlerInvariantExcludedPatterns,
            effects: [],
          },
          {
            patterns: indexerHandlerInvariantRoutedPatterns,
            effects: [
              {
                checklist: "docs/pr-checklists/indexer-handler-invariants.md",
                reason: "indexer handler/RPC/self-heal invariant path changed",
              },
            ],
          },
        ],
      },
      {
        verb: "add_package_quality_commands",
        args: ["@mento-protocol/indexer-envio", "indexer-envio changed"],
      },
    ],
  },
];
