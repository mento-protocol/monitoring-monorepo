#!/usr/bin/env node
import assert from "node:assert/strict";
import {
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
} from "./agent-autoreview-core.mjs";

const REPO = resolve(fileURLToPath(new URL("../", import.meta.url)));
const read = (relative) => readFileSync(`${REPO}/${relative}`, "utf8");

function walkFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = `${directory}/${entry.name}`;
    return entry.isDirectory()
      ? walkFiles(entryPath)
      : [entryPath.slice(REPO.length + 1)];
  });
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

test("every focused external input has an explicit autoreview owner", () => {
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

async function assertMalformedCoreFailsImport(label, rewrite, expected) {
  const directory = mkdtempSync(`${tmpdir()}/indexer-autoreview-${label}-`);
  const modulePath = `${directory}/agent-autoreview-core.mjs`;
  try {
    const source = read("scripts/agent-autoreview-core.mjs");
    const changed = rewrite(source);
    assert.notEqual(changed, source, `${label} fixture changed no source`);
    writeFileSync(modulePath, changed, "utf8");
    await assert.rejects(import(pathToFileURL(modulePath).href), expected);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("the external family schema fails closed before use", async () => {
  await assertMalformedCoreFailsImport(
    "route-type",
    (source) => source.replace("route: false,", 'route: "false",'),
    /route must be boolean/,
  );
  await assertMalformedCoreFailsImport(
    "exact-overlap",
    (source) =>
      source.replace(
        '"indexer-envio/src/pool/health.ts",',
        '"indexer-envio/src/swap.ts",',
      ),
    /explicit path .* has 2 owners/,
  );
  await assertMalformedCoreFailsImport(
    "bash-metacharacter",
    (source) =>
      source.replace(
        '"indexer-envio/src/abis.ts",',
        '"indexer-envio/src/abi*.ts",',
      ),
    /Bash-unsafe literal path/,
  );
  await assertMalformedCoreFailsImport(
    "exact-directory",
    (source) =>
      source.replace(
        '"indexer-envio/src/abis.ts",',
        '"indexer-envio/src/abis.ts/",',
      ),
    /noncanonical or Bash-unsafe literal path/,
  );
  await assertMalformedCoreFailsImport(
    "prefix-field",
    (source) =>
      source.replace(
        'owner: "abi-runtime-inputs",\n      route: true,',
        'owner: "abi-runtime-inputs",\n      route: true,\n      prefix: "indexer-envio/abis/",',
      ),
    /unknown keys: prefix/,
  );
  await assertMalformedCoreFailsImport(
    "fallback-route",
    (source) =>
      source.replace(
        'owner: "future-module",\n      route: false,',
        'owner: "future-module",\n      route: true,',
      ),
    /fallback must remain unclassified/,
  );
  await assertMalformedCoreFailsImport(
    "fallback-extension",
    (source) =>
      source.replace(
        '          "json",\n        ],',
        '          "json",\n          "md",\n        ],',
      ),
    /only the canonical src\/test JS, JSON, or TS module scope/,
  );
  await assertMalformedCoreFailsImport(
    "fallback-prefix",
    (source) =>
      source.replace(
        'prefixes: ["indexer-envio/src/", "indexer-envio/test/"],',
        'prefixes: ["indexer-envio/src/", "indexer-envio/test/", "indexer-envio/config/"],',
      ),
    /only the canonical src\/test JS, JSON, or TS module scope/,
  );
});
