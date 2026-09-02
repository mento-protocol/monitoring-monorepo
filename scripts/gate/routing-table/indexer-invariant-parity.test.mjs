#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  getIndexerHandlerInvariantChecklistDecisions,
  getIndexerHandlerInvariantRoutingFamilies,
} from "./indexer-handler-invariant-contract.mjs";
import { bashFunctionSource } from "../../sentry/ci-wiring/check-sentry-suites-in-ci-gate-extract.mjs";
import { AGENT_MODULE_ARMS } from "./arms-agent-modules.mjs";
import { PACKAGE_ARMS } from "./arms-packages.mjs";
import { casePatternToRegExp } from "./pattern.mjs";

const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const read = (relative) => readFileSync(`${REPO}${relative}`, "utf8");
const INDEXER_MODULE_EXTENSIONS = [
  "ts",
  "tsx",
  "mts",
  "cts",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "json",
];

function walkFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = `${directory}/${entry.name}`;
    return entry.isDirectory()
      ? walkFiles(entryPath)
      : [entryPath.slice(REPO.length + 1)];
  });
}

const walkIndexerModuleFiles = (directory) =>
  walkFiles(directory).filter((candidatePath) =>
    /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|json)$/.test(candidatePath),
  );

const focusedRootIndexerEntries = readdirSync(`${REPO}/indexer-envio`, {
  withFileTypes: true,
})
  .filter((entry) => entry.isFile() || entry.isSymbolicLink())
  .map((entry) => `indexer-envio/${entry.name}`)
  .sort();
const focusedRootIndexerConfigs = focusedRootIndexerEntries.filter(
  (candidatePath) => /^indexer-envio\/config[^/]*\.yaml$/.test(candidatePath),
);
const focusedRootIndexerTestRuntimeInputs = focusedRootIndexerEntries.filter(
  (candidatePath) =>
    candidatePath === "indexer-envio/stryker.config.mjs" ||
    /^indexer-envio\/vitest[^/]*$/.test(candidatePath),
);
const focusedIndexerScriptTestRuntimeInputs = readdirSync(
  `${REPO}/indexer-envio/scripts`,
  { withFileTypes: true },
)
  .filter((entry) => entry.isFile() || entry.isSymbolicLink())
  .map((entry) => `indexer-envio/scripts/${entry.name}`)
  .filter((candidatePath) =>
    /^indexer-envio\/scripts\/test-[^/]*\.mjs$/.test(candidatePath),
  )
  .sort();

const focusedNonConfigRootIndexerInputs = [
  "indexer-envio/schema.graphql",
  ...focusedRootIndexerTestRuntimeInputs,
];

const focusedRootIndexerInputs = [
  ...focusedRootIndexerConfigs,
  ...focusedNonConfigRootIndexerInputs,
];

const indexerPackageArm = PACKAGE_ARMS.find(
  ({ patterns }) => patterns.length === 1 && patterns[0] === "indexer-envio/*",
);
assert.ok(indexerPackageArm, "the package table has no indexer arm");
const indexerInvariantDispatch = indexerPackageArm.effects.find(
  (effect) =>
    effect.dispatch === "path" &&
    effect.arms.some((armed) =>
      armed.effects.some(
        (nested) =>
          nested.checklist ===
          "docs/pr-checklists/indexer-handler-invariants.md",
      ),
    ),
);
assert.ok(
  indexerInvariantDispatch,
  "the indexer arm has no handler-invariant dispatch",
);
assert.equal(
  indexerInvariantDispatch.arms.length,
  2,
  "the handler-invariant dispatch must have excluded and routed arms",
);
const [indexerInvariantExcludedArm, indexerInvariantRoutedArm] =
  indexerInvariantDispatch.arms;
const indexerInvariantInventoryDispatch = indexerPackageArm.effects.find(
  (effect) =>
    effect.dispatch === "path" &&
    effect.arms.some((armed) =>
      armed.effects.some(
        (nested) =>
          nested.command ===
          "node --test scripts/gate/routing-table/indexer-invariant-parity.test.mjs",
      ),
    ),
);
assert.ok(
  indexerInvariantInventoryDispatch,
  "the indexer arm has no invariant inventory dispatch",
);

test("the derived exact arms keep the current route counts", () => {
  assert.equal(indexerInvariantExcludedArm.patterns.length, 12);
  assert.equal(indexerInvariantRoutedArm.patterns.length, 256);
});
const matchesAny = (patterns, candidatePath) =>
  patterns.some((pattern) => casePatternToRegExp(pattern).test(candidatePath));
const tableIndexerInvariantDecision = (candidatePath) => {
  if (matchesAny(indexerInvariantExcludedArm.patterns, candidatePath)) {
    return false;
  }
  return matchesAny(indexerInvariantRoutedArm.patterns, candidatePath);
};

test("the contract-source arm preserves the checklist across classifier drift", () => {
  const protectedDecisions = getIndexerHandlerInvariantChecklistDecisions([
    "indexer-envio/src/futureProtectedSkew.ts",
    "indexer-envio/src/rpc/log.ts",
  ]);
  assert.deepEqual(
    protectedDecisions.map(({ route }) => route),
    [false, false],
    "the skew controls must remain unrouted in the protected classifier",
  );

  const contractArm = AGENT_MODULE_ARMS.find(({ patterns }) =>
    patterns.includes(
      "scripts/gate/routing-table/indexer-handler-invariant-contract.mjs",
    ),
  );
  assert.ok(
    contractArm,
    "the agent module table has no invariant-contract arm",
  );
  assert.ok(
    contractArm.effects.some(
      (effect) =>
        effect.checklist ===
          "docs/pr-checklists/indexer-handler-invariants.md" &&
        effect.reason === "indexer invariant routing source changed",
    ),
    "the contract-source arm does not conservatively route the invariant checklist",
  );
});

test("the table and contract agree on every current indexer module path", () => {
  const paths = [
    ...walkIndexerModuleFiles(`${REPO}/indexer-envio/src`),
    ...walkIndexerModuleFiles(`${REPO}/indexer-envio/test`),
  ].sort();
  assert.equal(paths.length, 223, "current module inventory changed");
  const decisions = getIndexerHandlerInvariantChecklistDecisions(paths);
  for (const decision of decisions) {
    assert.equal(
      tableIndexerInvariantDecision(decision.path),
      decision.route,
      `${decision.path} differs between the contract and routing table`,
    );
    assert.notEqual(
      decision.owner,
      "future-module",
      `${decision.path} has no explicit current owner`,
    );
    assert.notEqual(
      decision.owner,
      "outside-indexer-handler-invariant-scope",
      `${decision.path} fell outside the classifier`,
    );
  }
  assert.equal(
    decisions.filter(({ route }) => !route).length,
    10,
    "current exclusion count changed",
  );
});

test("the table and contract agree on every focused input outside src and test", () => {
  const paths = [
    ...walkFiles(`${REPO}/indexer-envio/abis`),
    ...walkFiles(`${REPO}/indexer-envio/config`),
    ...focusedRootIndexerInputs,
    ...focusedIndexerScriptTestRuntimeInputs,
  ].sort();
  const decisions = getIndexerHandlerInvariantChecklistDecisions(paths);
  for (const decision of decisions) {
    assert.equal(
      tableIndexerInvariantDecision(decision.path),
      decision.route,
      `${decision.path} differs between the contract and routing table`,
    );
  }
});

test("focused handler and RPC test support stays routed", () => {
  for (const [candidatePath, owner] of [
    ["indexer-envio/src/rpc/http-test-mock-bridge.ts", "rpc-effects"],
    ["indexer-envio/src/rpc/http-test-mocks.ts", "rpc-effects"],
    ["indexer-envio/test/helpers/eventFixtures.ts", "test-invariant-support"],
    ["indexer-envio/test/helpers/httpRpc.ts", "test-invariant-support"],
    [
      "indexer-envio/test/helpers/indexerTestHarness.ts",
      "test-invariant-support",
    ],
    ["indexer-envio/test/helpers/makePool.ts", "test-invariant-support"],
    ["indexer-envio/test/hermeticGuard.test.ts", "test-invariant-support"],
    ["indexer-envio/test/setup/publish-test-rpc.ts", "test-invariant-support"],
    ["indexer-envio/test/feeTokenAllowlist.test.ts", "invariant-tests"],
  ]) {
    assert.deepEqual(
      getIndexerHandlerInvariantChecklistDecisions([candidatePath]),
      [{ path: candidatePath, route: true, owner }],
    );
    assert.equal(tableIndexerInvariantDecision(candidatePath), true);
  }
});

test("confirmed non-invariant inputs stay explicitly excluded", () => {
  for (const [candidatePath, owner] of [
    [
      "indexer-envio/abis/liquity/AddressesRegistry.json",
      "abi-nonruntime-inputs",
    ],
    [
      "indexer-envio/abis/wormhole/NttDeployHelper.json",
      "abi-nonruntime-inputs",
    ],
    [
      "indexer-envio/src/handlers/liquity/troveManagerPreloadContext.ts",
      "liquity-type-only",
    ],
    ["indexer-envio/src/rpc/log.ts", "rpc-logging-only"],
  ]) {
    assert.deepEqual(
      getIndexerHandlerInvariantChecklistDecisions([candidatePath]),
      [{ path: candidatePath, route: false, owner }],
    );
    assert.equal(tableIndexerInvariantDecision(candidatePath), false);
    assert.ok(
      matchesAny(
        indexerInvariantInventoryDispatch.arms[0].patterns,
        candidatePath,
      ),
      `${candidatePath} no longer triggers the owner inventory`,
    );
  }
});

test("every exact family member keeps its owner and table disposition", () => {
  for (const family of getIndexerHandlerInvariantRoutingFamilies()) {
    for (const candidatePath of family.exact ?? []) {
      const [decision] = getIndexerHandlerInvariantChecklistDecisions([
        candidatePath,
      ]);
      assert.deepEqual(
        decision,
        {
          path: candidatePath,
          route: family.route,
          owner: family.owner,
        },
        `${candidatePath} lost exact owner ${family.owner}`,
      );
      assert.equal(
        tableIndexerInvariantDecision(candidatePath),
        family.route,
        `${candidatePath} lost table disposition ${family.route}`,
      );
    }
  }
});

test("the nested dispatch is excluded-first and inventories future modules", () => {
  assert.deepEqual(
    indexerInvariantExcludedArm.effects,
    [],
    "the first arm must stop excluded paths without adding the checklist",
  );
  assert.equal(indexerInvariantRoutedArm.effects.length, 1);
  const futurePatterns = ["src", "test"].flatMap((scope) =>
    INDEXER_MODULE_EXTENSIONS.map(
      (extension) => `indexer-envio/${scope}/*.${extension}`,
    ),
  );
  const fallbackPatterns = getIndexerHandlerInvariantRoutingFamilies()
    .filter(({ fallback }) => fallback !== undefined)
    .flatMap(({ fallback }) =>
      fallback.prefixes.flatMap((prefix) =>
        fallback.extensions.map((extension) => `${prefix}*.${extension}`),
      ),
    );
  assert.deepEqual(
    fallbackPatterns,
    futurePatterns,
    "the fallback family differs from the canonical 18 module patterns",
  );
  const inventoryPatterns = indexerInvariantInventoryDispatch.arms[0].patterns;
  assert.deepEqual(
    inventoryPatterns.slice(0, 7),
    [
      "indexer-envio/abis/*",
      "indexer-envio/config/*",
      "indexer-envio/config*.yaml",
      "indexer-envio/vitest*",
      "indexer-envio/scripts/test-*.mjs",
      "indexer-envio/schema.graphql",
      "indexer-envio/stryker.config.mjs",
    ],
    "the focused external runtime and test-support inventory changed",
  );
  assert.deepEqual(
    inventoryPatterns.slice(7),
    futurePatterns,
    "the inventory dispatch lost a future module pattern",
  );
  assert.equal(inventoryPatterns.length, 25, "inventory pattern count changed");
  for (const pattern of futurePatterns) {
    assert.ok(
      !indexerInvariantExcludedArm.patterns.includes(pattern),
      `the excluded arm directly compiled unclassified pattern ${pattern}`,
    );
    assert.ok(
      !indexerInvariantRoutedArm.patterns.includes(pattern),
      `the routed arm directly compiled unclassified pattern ${pattern}`,
    );
    const candidatePath = pattern.replace("*", "future/deep-handler");
    const [decision] = getIndexerHandlerInvariantChecklistDecisions([
      candidatePath,
    ]);
    assert.deepEqual(decision, {
      path: candidatePath,
      route: false,
      owner: "future-module",
    });
    assert.equal(tableIndexerInvariantDecision(candidatePath), false);
  }
  const unrelatedModulePath =
    "indexer-envio/test/documentation-catalog.test.ts";
  assert.deepEqual(
    getIndexerHandlerInvariantChecklistDecisions([unrelatedModulePath]),
    [
      {
        path: unrelatedModulePath,
        route: false,
        owner: "future-module",
      },
    ],
    "an unrelated test module remains unclassified",
  );
  assert.equal(tableIndexerInvariantDecision(unrelatedModulePath), false);
  assert.ok(
    matchesAny(
      indexerInvariantInventoryDispatch.arms[0].patterns,
      unrelatedModulePath,
    ),
    "an unrelated test module must still trigger the inventory check",
  );
  for (const family of getIndexerHandlerInvariantRoutingFamilies().filter(
    ({ route }) => !route,
  )) {
    for (const candidatePath of family.exact ?? []) {
      assert.ok(
        matchesAny(indexerInvariantExcludedArm.patterns, candidatePath),
        `${candidatePath} is absent from the excluded-first arm`,
      );
    }
  }
});

test("future root indexer configs trigger the exact-owner inventory", () => {
  const candidatePath = "indexer-envio/config.multichain.owner-probe.yaml";
  assert.ok(
    matchesAny(
      indexerInvariantInventoryDispatch.arms[0].patterns,
      candidatePath,
    ),
    `${candidatePath} must trigger the invariant inventory check`,
  );
  assert.deepEqual(
    getIndexerHandlerInvariantChecklistDecisions([candidatePath]),
    [
      {
        path: candidatePath,
        route: false,
        owner: "outside-indexer-handler-invariant-scope",
      },
    ],
  );
  assert.equal(tableIndexerInvariantDecision(candidatePath), false);
});

test("future root Vitest inputs trigger the exact-owner inventory", () => {
  const candidatePath = "indexer-envio/vitest.future-runtime.config.mjs";
  assert.ok(
    matchesAny(
      indexerInvariantInventoryDispatch.arms[0].patterns,
      candidatePath,
    ),
    `${candidatePath} must trigger the invariant inventory check`,
  );
  assert.deepEqual(
    getIndexerHandlerInvariantChecklistDecisions([candidatePath]),
    [
      {
        path: candidatePath,
        route: false,
        owner: "outside-indexer-handler-invariant-scope",
      },
    ],
  );
  assert.equal(tableIndexerInvariantDecision(candidatePath), false);
});

test("future indexer test wrappers trigger the exact-owner inventory", () => {
  const candidatePath = "indexer-envio/scripts/test-future-runtime.mjs";
  assert.ok(
    matchesAny(
      indexerInvariantInventoryDispatch.arms[0].patterns,
      candidatePath,
    ),
    `${candidatePath} must trigger the invariant inventory check`,
  );
  assert.deepEqual(
    getIndexerHandlerInvariantChecklistDecisions([candidatePath]),
    [
      {
        path: candidatePath,
        route: false,
        owner: "outside-indexer-handler-invariant-scope",
      },
    ],
  );
  assert.equal(tableIndexerInvariantDecision(candidatePath), false);
});

test("exact owners do not widen into same-namespace files", () => {
  for (const [candidatePath, owner] of [
    ["indexer-envio/abis/FPMM.json", "abi-runtime-inputs"],
    ["indexer-envio/config/fx-calendar.json", "config-runtime-inputs"],
    ["indexer-envio/src/handlers/broker.ts", "handler-modules"],
    ["indexer-envio/src/rpc/effects.ts", "rpc-effects"],
  ]) {
    const [decision] = getIndexerHandlerInvariantChecklistDecisions([
      candidatePath,
    ]);
    assert.deepEqual(decision, { path: candidatePath, route: true, owner });
    assert.equal(tableIndexerInvariantDecision(candidatePath), true);
  }

  for (const [candidatePath, owner] of [
    ["indexer-envio/src/handlers/documentation-catalog.ts", "future-module"],
    ["indexer-envio/src/rpc/documentation-catalog.ts", "future-module"],
    [
      "indexer-envio/abis/documentation-catalog.json",
      "outside-indexer-handler-invariant-scope",
    ],
    [
      "indexer-envio/config/documentation-catalog.json",
      "outside-indexer-handler-invariant-scope",
    ],
  ]) {
    const [decision] = getIndexerHandlerInvariantChecklistDecisions([
      candidatePath,
    ]);
    assert.deepEqual(decision, {
      path: candidatePath,
      route: false,
      owner,
    });
    assert.equal(tableIndexerInvariantDecision(candidatePath), false);
    assert.ok(
      matchesAny(
        indexerInvariantInventoryDispatch.arms[0].patterns,
        candidatePath,
      ),
      `${candidatePath} no longer triggers the inventory check`,
    );
  }
  assert.ok(
    getIndexerHandlerInvariantRoutingFamilies().every(
      (family) => family.prefix === undefined,
    ),
    "a broad positive prefix returned to the exact owner table",
  );
});

test("freshness, CI routes, and Turbo inputs pin the external family source", () => {
  const signature = bashFunctionSource(
    read("/scripts/agent-quality-gate.sh"),
    "implementation_signature",
    "scripts/agent-quality-gate.sh",
  );
  const signatureEntries = /for path in\b([\s\S]*?);\s*do\b/
    .exec(signature)?.[1]
    .replace(/#[^\n]*/g, "")
    .replace(/\\\n/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  assert.ok(
    signatureEntries?.includes(
      "scripts/gate/routing-table/indexer-handler-invariant-families.mjs",
    ),
    "implementation_signature() does not list the external family source",
  );
  assert.ok(
    signatureEntries?.includes(
      "scripts/agent-autoreview-secret-suppressions.json",
    ),
    "implementation_signature() does not list the sealed suppression config",
  );
  const ci = read("/.github/workflows/ci.yml");
  const changesJob = /\n {2}changes:\n([\s\S]*?)\n {2}shared:\n/.exec(ci)?.[1];
  assert.ok(changesJob, "ci.yml has no bounded changes job");
  const rootRuntimeFilter =
    /\n {12}autoreviewRootRuntime: &autoreviewRootRuntime\n([\s\S]*?)\n {12}versionSkew: &versionSkew\n/.exec(
      changesJob,
    )?.[1];
  assert.ok(rootRuntimeFilter, "ci.yml has no autoreviewRootRuntime filter");
  assert.match(
    rootRuntimeFilter,
    /^\s+- scripts\/agent-autoreview-secret-suppressions\.json$/m,
    "autoreviewRootRuntime does not route the sealed suppression config",
  );
  assert.match(
    changesJob,
    /^ {6}autoreviewRootRuntime: \$\{\{ steps\.filter\.outputs\.autoreviewRootRuntime \}\}$/m,
    "the changes job does not export the autoreviewRootRuntime filter",
  );
  const rootRuntimeJob =
    /\n {2}autoreview-root-runtime:\n([\s\S]*?)\n {2}version-skew:\n/.exec(
      ci,
    )?.[1];
  assert.ok(
    rootRuntimeJob,
    "ci.yml has no bounded autoreview-root-runtime job",
  );
  assert.match(
    rootRuntimeJob,
    /^ {4}needs: changes$/m,
    "the focused root-runtime job does not depend on the changes job",
  );
  assert.match(
    rootRuntimeJob,
    /^ {4}if: needs\.changes\.outputs\.forceAll == 'true' \|\| needs\.changes\.outputs\.autoreviewRootRuntime == 'true'$/m,
    "the focused root-runtime job does not consume forceAll or the autoreviewRootRuntime filter",
  );
  const turbo = JSON.parse(read("/turbo.json"));
  const input = "$TURBO_ROOT$/scripts/agent-autoreview-core.mjs";
  const suppressionInput =
    "$TURBO_ROOT$/scripts/agent-autoreview-secret-suppressions.json";
  for (const task of ["build", "size-limit", "test:browser"]) {
    assert.ok(
      turbo.tasks[task].inputs.includes(input),
      `turbo task ${task} does not pin the external family source`,
    );
    assert.ok(
      turbo.tasks[task].inputs.includes(suppressionInput),
      `turbo task ${task} does not pin the sealed suppression config`,
    );
  }
});

test("indexer CI runs the parity test that enforces explicit current owners", () => {
  const ci = read("/.github/workflows/ci.yml");
  const indexerJob = /\n {2}indexer:\n([\s\S]*?)\n {2}bridge:\n/.exec(ci)?.[1];
  assert.ok(indexerJob, "ci.yml has no bounded indexer job");
  assert.match(
    indexerJob,
    /^\s+run:\s+node --test scripts\/gate\/routing-table\/indexer-invariant-parity\.test\.mjs\s*$/m,
    "the indexer job does not enforce the routing inventory",
  );
});
