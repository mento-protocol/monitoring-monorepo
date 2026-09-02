#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  copyFileSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

import {
  getIndexerHandlerInvariantChecklistDecisions,
  getIndexerHandlerInvariantRoutingFamilies,
} from "./gate/routing-table/indexer-handler-invariant-contract.mjs";
import {
  getIndexerHandlerInvariantChecklistDecisions as autoreviewCoreDecisions,
  getIndexerHandlerInvariantRoutingFamilies as autoreviewCoreFamilies,
} from "./agent-autoreview-core.mjs";

const REPO = resolve(fileURLToPath(new URL("../", import.meta.url)));
const CONTRACT_MODULE =
  "scripts/gate/routing-table/indexer-handler-invariant-contract.mjs";
const FAMILIES_MODULE =
  "scripts/gate/routing-table/indexer-handler-invariant-families.mjs";
const read = (relative) => readFileSync(`${REPO}/${relative}`, "utf8");

function walkFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = `${directory}/${entry.name}`;
    return entry.isDirectory()
      ? walkFiles(entryPath)
      : [entryPath.slice(REPO.length + 1)];
  });
}

function walkModuleFiles(directory) {
  return walkFiles(directory).filter((candidatePath) =>
    /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|json)$/.test(candidatePath),
  );
}

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
const focusedIndexerTestRuntimeInputs = [
  ...focusedRootIndexerTestRuntimeInputs,
  ...focusedIndexerScriptTestRuntimeInputs,
].sort();
const ownedRootIndexerConfigs = getIndexerHandlerInvariantRoutingFamilies()
  .flatMap(({ exact = [] }) => exact)
  .filter((candidatePath) =>
    /^indexer-envio\/config[^/]*\.yaml$/.test(candidatePath),
  )
  .sort();
const ownedIndexerTestRuntimeInputs =
  getIndexerHandlerInvariantRoutingFamilies()
    .filter(({ owner }) => owner === "test-runtime-inputs")
    .flatMap(({ exact = [] }) => exact)
    .sort();
const currentIndexerSources = walkModuleFiles(
  `${REPO}/indexer-envio/src`,
).sort();
const currentIndexerTests = walkModuleFiles(
  `${REPO}/indexer-envio/test`,
).sort();

test("every focused external input has an explicit contract owner", () => {
  const paths = [
    ...walkFiles(`${REPO}/indexer-envio/abis`),
    ...walkFiles(`${REPO}/indexer-envio/config`),
    ...focusedRootIndexerInputs,
    ...focusedIndexerScriptTestRuntimeInputs,
  ].sort();
  assert.equal(paths.length, 45, "focused external-input inventory changed");
  const decisions = getIndexerHandlerInvariantChecklistDecisions(paths);
  for (const decision of decisions) {
    assert.notEqual(
      decision.owner,
      "outside-indexer-handler-invariant-scope",
      `${decision.path} has no explicit external-input owner`,
    );
  }
  assert.deepEqual(
    decisions.filter(({ route }) => !route),
    [
      {
        path: "indexer-envio/abis/liquity/AddressesRegistry.json",
        route: false,
        owner: "abi-nonruntime-inputs",
      },
      {
        path: "indexer-envio/abis/wormhole/NttDeployHelper.json",
        route: false,
        owner: "abi-nonruntime-inputs",
      },
    ],
    "only the two nonruntime ABIs stay excluded from focused external inputs",
  );
});

test("focused external inputs and exact owners cannot drift", () => {
  assert.deepEqual(
    ownedRootIndexerConfigs,
    focusedRootIndexerConfigs,
    "every current root config YAML must have one live exact owner",
  );
  assert.deepEqual(
    ownedIndexerTestRuntimeInputs,
    focusedIndexerTestRuntimeInputs,
    "every current focused test-runtime input must have one live exact owner",
  );
  for (const candidatePath of [
    ...ownedRootIndexerConfigs.filter(
      (ownedPath) => ownedPath !== "indexer-envio/config.yaml",
    ),
    ...focusedNonConfigRootIndexerInputs,
    ...focusedIndexerScriptTestRuntimeInputs,
  ]) {
    assert.ok(
      lstatSync(`${REPO}/${candidatePath}`).isFile(),
      `${candidatePath} must remain a regular file while the classifier owns it`,
    );
  }
  const configAlias = `${REPO}/indexer-envio/config.yaml`;
  assert.ok(
    lstatSync(configAlias).isSymbolicLink(),
    "indexer-envio/config.yaml must remain the reviewed config alias",
  );
  const configAliasTarget = readlinkSync(configAlias);
  assert.equal(
    configAliasTarget,
    "config.multichain.mainnet.yaml",
    "indexer-envio/config.yaml must keep its reviewed mainnet target",
  );
  assert.ok(
    lstatSync(`${REPO}/indexer-envio/${configAliasTarget}`).isFile(),
    "the indexer config alias target must remain a regular file",
  );
});

test("the live indexer module inventory keeps its routing totals", () => {
  for (const [label, paths, routed, excluded] of [
    ["source", currentIndexerSources, 127, 5],
    ["test", currentIndexerTests, 86, 5],
  ]) {
    const decisions = getIndexerHandlerInvariantChecklistDecisions(paths);
    assert.equal(decisions.length, paths.length, `${label} decision count`);
    assert.deepEqual(
      decisions.map(({ path: decisionPath }) => decisionPath),
      paths,
      `${label} decisions preserve input order and paths`,
    );
    assert.equal(
      decisions.filter(({ route }) => route).length,
      routed,
      `${label} routed total`,
    );
    assert.equal(
      decisions.filter(({ route }) => !route).length,
      excluded,
      `${label} excluded total`,
    );
    for (const decision of decisions) {
      assert.equal(
        typeof decision.route,
        "boolean",
        `${label} route is boolean`,
      );
      assert.equal(
        typeof decision.owner,
        "string",
        `${label} owner is a string`,
      );
      assert.notEqual(decision.owner, "", `${label} owner is non-empty`);
      assert.notEqual(
        decision.owner,
        "future-module",
        `${label} path has an explicit current owner: ${decision.path}`,
      );
    }
  }
  assert.equal(
    currentIndexerSources.length,
    132,
    "current source module inventory",
  );
  assert.equal(currentIndexerTests.length, 91, "current test module inventory");
  assert.doesNotThrow(
    () =>
      getIndexerHandlerInvariantChecklistDecisions([
        ...currentIndexerSources,
        ...currentIndexerTests,
      ]),
    "current family definitions must not overlap",
  );
});

test("named indexer modules keep their exact routing owner", () => {
  for (const [candidatePath, route, owner] of [
    ["indexer-envio/src/swap.ts", true, "source-runtime"],
    ["indexer-envio/src/pool/types.ts", false, "source-excluded-type-only"],
    ["indexer-envio/src/handlers/broker.ts", true, "handler-modules"],
    [
      "indexer-envio/src/handlers/liquity/troveManagerPreloadContext.ts",
      false,
      "liquity-type-only",
    ],
    ["indexer-envio/src/rpc/effects.ts", true, "rpc-effects"],
    ["indexer-envio/src/rpc/log.ts", false, "rpc-logging-only"],
    ["indexer-envio/src/rpc/http-test-mock-bridge.ts", true, "rpc-effects"],
    ["indexer-envio/src/rpc/http-test-mocks.ts", true, "rpc-effects"],
    ["indexer-envio/src/pool/self-heal.ts", true, "pool-runtime"],
    ["indexer-envio/src/bridge.ts", true, "source-runtime"],
    ["indexer-envio/src/constants.ts", true, "source-runtime"],
    ["indexer-envio/src/wormhole/chainIds.ts", true, "wormhole-runtime"],
    ["indexer-envio/src/wormhole/detail.ts", true, "wormhole-runtime"],
    [
      "indexer-envio/src/wormhole/handlerContext.ts",
      false,
      "wormhole-type-only",
    ],
    ["indexer-envio/src/wormhole/nttAddresses.ts", true, "wormhole-runtime"],
    ["indexer-envio/src/wormhole/pairing.ts", true, "wormhole-runtime"],
    [
      "indexer-envio/src/wormhole/scratchWarnings.ts",
      false,
      "wormhole-warning-only",
    ],
    ["indexer-envio/src/wormhole/status.ts", true, "wormhole-runtime"],
    ["indexer-envio/test/bridge.test.ts", true, "invariant-tests"],
    ["indexer-envio/test/feeTokenAllowlist.test.ts", true, "invariant-tests"],
    [
      "indexer-envio/test/helpers/indexerTestHarness.ts",
      true,
      "test-invariant-support",
    ],
    [
      "indexer-envio/test/hermeticGuard.test.ts",
      true,
      "test-invariant-support",
    ],
    ["indexer-envio/test/self-heal.test.ts", true, "invariant-tests"],
    ["indexer-envio/test/startBlockInvariant.test.ts", true, "invariant-tests"],
    ["indexer-envio/test/swap.test.ts", true, "invariant-tests"],
    [
      "indexer-envio/test/wormholeScratchWarnings.test.ts",
      false,
      "test-excluded",
    ],
    ["indexer-envio/abis/FPMM.json", true, "abi-runtime-inputs"],
    [
      "indexer-envio/abis/liquity/AddressesRegistry.json",
      false,
      "abi-nonruntime-inputs",
    ],
    [
      "indexer-envio/abis/wormhole/NttDeployHelper.json",
      false,
      "abi-nonruntime-inputs",
    ],
    ["indexer-envio/config/fx-calendar.json", true, "config-runtime-inputs"],
    ["indexer-envio/config.yaml", true, "root-runtime-inputs"],
    [
      "indexer-envio/config.multichain.mainnet.yaml",
      true,
      "root-runtime-inputs",
    ],
    ["indexer-envio/schema.graphql", true, "root-runtime-inputs"],
    [
      "indexer-envio/scripts/test-reserve-yield.mjs",
      true,
      "test-runtime-inputs",
    ],
    ["indexer-envio/stryker.config.mjs", true, "test-runtime-inputs"],
    ["indexer-envio/vitest.config.ts", true, "test-runtime-inputs"],
    ["indexer-envio/vitest.fail-closed.config.ts", true, "test-runtime-inputs"],
    ["indexer-envio/vitest.hermetic-setup.ts", true, "test-runtime-inputs"],
    ["indexer-envio/vitest.mutation.config.ts", true, "test-runtime-inputs"],
  ]) {
    assert.deepEqual(
      getIndexerHandlerInvariantChecklistDecisions([candidatePath]),
      [{ path: candidatePath, route, owner }],
      `${candidatePath} keeps its exact routing owner`,
    );
  }
});

test("unowned modules fall back without inheriting a broad owner", () => {
  for (const extension of [
    "ts",
    "tsx",
    "mts",
    "cts",
    "js",
    "jsx",
    "mjs",
    "cjs",
    "json",
  ]) {
    for (const scope of ["src", "test"]) {
      const candidatePath = `indexer-envio/${scope}/future-handler.${extension}`;
      assert.deepEqual(
        getIndexerHandlerInvariantChecklistDecisions([candidatePath]),
        [
          {
            path: candidatePath,
            route: false,
            owner: "future-module",
          },
        ],
      );
    }
  }
  assert.deepEqual(
    getIndexerHandlerInvariantChecklistDecisions([
      "indexer-envio/test/documentation-catalog.test.ts",
    ]),
    [
      {
        path: "indexer-envio/test/documentation-catalog.test.ts",
        route: false,
        owner: "future-module",
      },
    ],
    "an unowned test module does not route the handler-invariant checklist",
  );
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
    assert.deepEqual(
      getIndexerHandlerInvariantChecklistDecisions([candidatePath]),
      [{ path: candidatePath, route: false, owner }],
      `${candidatePath} does not inherit a broad checklist owner`,
    );
  }
  for (const outsidePath of [
    "indexer-envio/.env.example",
    "indexer-envio/envio-env.d.ts",
    "indexer-envio/package.json",
    "indexer-envio/scripts/generateNttAddresses.mjs",
    "indexer-envio/tsconfig.json",
    "indexer-envio/src/future-handler.vue",
    "ui-dashboard/src/future-handler.ts",
  ]) {
    assert.deepEqual(
      getIndexerHandlerInvariantChecklistDecisions([outsidePath]),
      [
        {
          path: outsidePath,
          route: false,
          owner: "outside-indexer-handler-invariant-scope",
        },
      ],
    );
  }
});

test("callers receive a detached, deeply frozen family view", () => {
  const frozenIndexerFamilies = getIndexerHandlerInvariantRoutingFamilies();
  const copiedIndexerFamilies = getIndexerHandlerInvariantRoutingFamilies();
  const isDeeplyFrozen = (value) =>
    value === null ||
    typeof value !== "object" ||
    (Object.isFrozen(value) && Object.values(value).every(isDeeplyFrozen));
  assert.ok(isDeeplyFrozen(frozenIndexerFamilies));
  assert.notStrictEqual(frozenIndexerFamilies, copiedIndexerFamilies);
  assert.notStrictEqual(frozenIndexerFamilies[0], copiedIndexerFamilies[0]);
  assert.throws(() => frozenIndexerFamilies.push({}), TypeError);
  const frozenExactIndexerFamily = frozenIndexerFamilies.find(
    ({ exact }) => exact !== undefined,
  );
  const frozenFallbackIndexerFamily = frozenIndexerFamilies.find(
    ({ fallback }) => fallback !== undefined,
  );
  assert.ok(frozenExactIndexerFamily);
  assert.ok(frozenFallbackIndexerFamily);
  assert.throws(
    () => frozenExactIndexerFamily.exact.push("changed"),
    TypeError,
  );
  assert.throws(
    () => frozenFallbackIndexerFamily.fallback.prefixes.push("changed"),
    TypeError,
  );
  assert.deepEqual(
    getIndexerHandlerInvariantChecklistDecisions(["indexer-envio/src/swap.ts"]),
    [
      {
        path: "indexer-envio/src/swap.ts",
        route: true,
        owner: "source-runtime",
      },
    ],
    "a caller cannot mutate later classifier decisions through the family view",
  );
});

test("the checklist entry point rejects a non-string path list", () => {
  assert.throws(
    () =>
      getIndexerHandlerInvariantChecklistDecisions(
        "indexer-envio/src/indexer.ts",
      ),
    /array of strings/,
  );
  assert.throws(
    () =>
      getIndexerHandlerInvariantChecklistDecisions([
        "indexer-envio/src/indexer.ts",
        1,
      ]),
    /array of strings/,
  );
});

// Temporary while the autoreview core still carries its own copy of this
// contract. The removal PR deletes the core module and this test with it.
test("the extracted contract answers exactly like the autoreview core", () => {
  assert.deepEqual(
    getIndexerHandlerInvariantRoutingFamilies(),
    autoreviewCoreFamilies(),
    "the extracted families must match the autoreview core families",
  );
  const inventory = [
    ...currentIndexerSources,
    ...currentIndexerTests,
    ...walkFiles(`${REPO}/indexer-envio/abis`),
    ...walkFiles(`${REPO}/indexer-envio/config`),
    ...focusedRootIndexerInputs,
    ...focusedIndexerScriptTestRuntimeInputs,
  ].sort();
  assert.deepEqual(
    getIndexerHandlerInvariantChecklistDecisions(inventory),
    autoreviewCoreDecisions(inventory),
    "every live-inventory decision must match the autoreview core",
  );
});

async function assertMalformedFamiliesFailImport(label, rewrite, expected) {
  const directory = mkdtempSync(`${tmpdir()}/indexer-invariant-${label}-`);
  const contractPath = `${directory}/indexer-handler-invariant-contract.mjs`;
  const familiesPath = `${directory}/indexer-handler-invariant-families.mjs`;
  try {
    copyFileSync(`${REPO}/${CONTRACT_MODULE}`, contractPath);
    const source = read(FAMILIES_MODULE);
    const changed = rewrite(source);
    assert.notEqual(changed, source, `${label} fixture changed no source`);
    writeFileSync(familiesPath, changed, "utf8");
    await assert.rejects(import(pathToFileURL(contractPath).href), expected);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("the external family schema fails closed before use", async () => {
  await assertMalformedFamiliesFailImport(
    "route-type",
    (source) => source.replace("route: false,", 'route: "false",'),
    /route must be boolean/,
  );
  await assertMalformedFamiliesFailImport(
    "exact-overlap",
    (source) =>
      source.replace(
        '"indexer-envio/src/pool/health.ts",',
        '"indexer-envio/src/swap.ts",',
      ),
    /explicit path .* has 2 owners/,
  );
  await assertMalformedFamiliesFailImport(
    "bash-metacharacter",
    (source) =>
      source.replace(
        '"indexer-envio/src/abis.ts",',
        '"indexer-envio/src/abi*.ts",',
      ),
    /Bash-unsafe literal path/,
  );
  await assertMalformedFamiliesFailImport(
    "exact-directory",
    (source) =>
      source.replace(
        '"indexer-envio/src/abis.ts",',
        '"indexer-envio/src/abis.ts/",',
      ),
    /noncanonical or Bash-unsafe literal path/,
  );
  await assertMalformedFamiliesFailImport(
    "prefix-field",
    (source) =>
      source.replace(
        'owner: "abi-runtime-inputs",\n    route: true,',
        'owner: "abi-runtime-inputs",\n    route: true,\n    prefix: "indexer-envio/abis/",',
      ),
    /unknown keys: prefix/,
  );
  await assertMalformedFamiliesFailImport(
    "fallback-route",
    (source) =>
      source.replace(
        'owner: "future-module",\n    route: false,',
        'owner: "future-module",\n    route: true,',
      ),
    /fallback must remain unclassified/,
  );
  await assertMalformedFamiliesFailImport(
    "fallback-extension",
    (source) =>
      source.replace(
        '        "json",\n      ],',
        '        "json",\n        "md",\n      ],',
      ),
    /only the canonical src\/test JS, JSON, or TS module scope/,
  );
  await assertMalformedFamiliesFailImport(
    "fallback-prefix",
    (source) =>
      source.replace(
        'prefixes: ["indexer-envio/src/", "indexer-envio/test/"],',
        'prefixes: ["indexer-envio/src/", "indexer-envio/test/", "indexer-envio/config/"],',
      ),
    /only the canonical src\/test JS, JSON, or TS module scope/,
  );
});
