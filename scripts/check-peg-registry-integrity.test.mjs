import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  checkPegRegistryIntegrity,
  pegPolicyVersionDigest,
  validatePegPolicyLineage,
} from "./check-peg-registry-integrity.mjs";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const SCRIPT_PATH = fileURLToPath(
  new URL("./check-peg-registry-integrity.mjs", import.meta.url),
);
const REGISTRY_PATH = join(REPO_ROOT, "metrics-bridge/peg-registry.json");
const POLICY_PATH = join(REPO_ROOT, "alerts/rules/peg-thresholds.json");
const ASSET_ADDRESS = "0x888883b5f5d21fb10dfeb70e8f9722b9fb0e5e51";
const MONITOR_FEED = "0xc22418a83dfc262b10a1f57e25309db83e7ea79e";
const CONVERSION_FEED = "0xec57482aa55e3ad026c315a0e4a692b776c318ca";
const SORTED_ORACLES = "0x6f92c745346057a61b259579256159458a0a6a92";

function readProductionData() {
  return {
    registry: JSON.parse(readFileSync(REGISTRY_PATH, "utf8")),
    policy: JSON.parse(readFileSync(POLICY_PATH, "utf8")),
  };
}

function clone(value) {
  return structuredClone(value);
}

function sealPolicyVersion(policyVersion, prefix) {
  policyVersion.version = `${prefix}-${pegPolicyVersionDigest(policyVersion)}`;
}

function registryAsset(registry, slug = "europ-schuman") {
  const asset = registry[slug];
  assert.ok(asset, `missing registry asset ${slug}`);
  return asset;
}

function policyAsset(policy, version = "active", slug = "europ-schuman") {
  const asset = policy[version]?.assets?.[slug];
  assert.ok(asset, `missing policy ${version} asset ${slug}`);
  return asset;
}

function authorityFixture({
  chains = [137],
  monitorPair = "EUROP/EUR",
  conversionPair = "EUR/USD",
  sortedOracles = [SORTED_ORACLES],
  tokenAddress = ASSET_ADDRESS,
  tokenName = "EUROP",
  extraEntries = [],
} = {}) {
  const entries = [
    {
      chainId: 137,
      address: tokenAddress,
      rawName: tokenName,
      canonicalName: tokenName,
      type: "token",
    },
    ...sortedOracles.map((address) => ({
      chainId: 137,
      address,
      rawName: "SortedOracles",
      canonicalName: "SortedOracles",
      type: "contract",
    })),
    ...extraEntries,
  ];
  const feeds = new Map([
    [MONITOR_FEED, monitorPair],
    [CONVERSION_FEED, conversionPair],
  ]);
  const chainSet = new Set(chains);
  return {
    hasChain: (chainId) => chainSet.has(chainId),
    contractEntries: (chainId) =>
      entries.filter((entry) => entry.chainId === chainId),
    knownRateFeedsByChain: (chainId) =>
      chainId === 137 ? new Map(feeds) : new Map(),
  };
}

async function checkFixture({
  mutateRegistry,
  mutatePolicy,
  authority = authorityFixture(),
} = {}) {
  const data = readProductionData();
  mutateRegistry?.(data.registry);
  mutatePolicy?.(data.policy);
  const directory = mkdtempSync(join(tmpdir(), "peg-integrity-test-"));
  const registryPath = join(directory, "registry.json");
  const policyPath = join(directory, "policy.json");
  writeFileSync(registryPath, `${JSON.stringify(data.registry, null, 2)}\n`);
  writeFileSync(policyPath, `${JSON.stringify(data.policy, null, 2)}\n`);
  try {
    return await checkPegRegistryIntegrity({
      registryPath,
      policyPath,
      authority,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function joinedErrors(result) {
  return result.errors.join("\n");
}

test("production registry and policy pass against installed Mento config", async () => {
  const result = await checkPegRegistryIntegrity();

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.summary, { assets: 1, sources: 3, monitors: 1 });
});

test("injected temp paths exercise the production validation path", async () => {
  const result = await checkFixture();

  assert.deepEqual(result.errors, []);
});

test("rejects malformed and non-lowercase address references", async (t) => {
  const cases = [
    ["tokenRef", (asset) => (asset.tokenRefs[0].address = "0x1234")],
    [
      "pool",
      (asset) =>
        (asset.monitors[0].poolAddress =
          "0xCD8c6811d975981f57e7fb32e59f0bee66af3201"),
    ],
    ["monitor feed", (asset) => (asset.monitors[0].rateFeedId = "bad")],
    [
      "SyntheticAsset token",
      (asset) =>
        (asset.monitors[0].monitoredTokenAddress = ASSET_ADDRESS.toUpperCase()),
    ],
    [
      "conversion feed",
      (asset) =>
        (asset.sources[2].convertVia.rateFeedId =
          CONVERSION_FEED.toUpperCase()),
    ],
  ];

  for (const [name, mutate] of cases) {
    await t.test(name, async () => {
      const result = await checkFixture({
        mutateRegistry: (registry) => mutate(registryAsset(registry)),
      });

      assert.match(joinedErrors(result), /lowercase 20-byte EVM address/);
    });
  }
});

test("rejects duplicate source ids and chain-scoped pool identities", async () => {
  const result = await checkFixture({
    mutateRegistry: (registry) => {
      const asset = registryAsset(registry);
      asset.sources.push(clone(asset.sources[0]));
      asset.monitors.push(clone(asset.monitors[0]));
    },
  });
  const errors = joinedErrors(result);

  assert.match(errors, /duplicate source id "bitvavo_eur"/);
  assert.match(errors, /duplicate chain-scoped pool identity 137:0xcd8c/);
});

test("rejects an asset alias instead of accepting policy-registry drift", async () => {
  const result = await checkFixture({
    mutatePolicy: (policy) => {
      policy.active.assets.europ = policy.active.assets["europ-schuman"];
      delete policy.active.assets["europ-schuman"];
    },
  });
  const errors = joinedErrors(result);

  assert.match(errors, /missing registry asset "europ-schuman"/);
  assert.match(errors, /unknown asset "europ"; remove the stale alias/);
});

test("rejects a non-object policy asset with a matching registry key", async () => {
  const result = await checkFixture({
    mutatePolicy: (policy) => {
      policy.active.assets["europ-schuman"] = null;
    },
  });

  assert.match(
    joinedErrors(result),
    /policy\.active\.assets\["europ-schuman"\]: expected an object/,
  );
});

test("rejects extra and omitted source policy aliases", async () => {
  const result = await checkFixture({
    mutatePolicy: (policy) => {
      const sources = policyAsset(policy).sources;
      sources.bitvavo_legacy = sources.bitvavo_eur;
      delete sources.bitvavo_eur;
    },
  });
  const errors = joinedErrors(result);

  assert.match(errors, /missing registry source "bitvavo_eur"/);
  assert.match(errors, /unknown source "bitvavo_legacy"/);
});

test("rejects token and source aliases that disagree with config identity", async () => {
  const result = await checkFixture({
    mutateRegistry: (registry) => {
      const source = registryAsset(registry).sources[0];
      source.baseCurrency = "EURP";
      source.pair = "EURP-EUR";
    },
  });

  assert.match(
    joinedErrors(result),
    /baseCurrency: "EURP" does not match canonical token symbol\(s\) EUROP/,
  );
});

test("requires every chain tokenRef to resolve to the same canonical asset", async () => {
  const secondAssetAddress = "0x2222222222222222222222222222222222222222";
  const result = await checkFixture({
    authority: authorityFixture({
      chains: [137, 143],
      extraEntries: [
        {
          chainId: 143,
          address: secondAssetAddress,
          rawName: "EURP",
          canonicalName: "EURP",
          type: "token",
        },
      ],
    }),
    mutateRegistry: (registry) => {
      registryAsset(registry).tokenRefs.push({
        chainId: 143,
        address: secondAssetAddress,
      });
    },
  });

  assert.match(
    joinedErrors(result),
    /does not match canonical token symbol\(s\) EUROP, EURP/,
  );
});

test("enforces executable coverage-class capabilities", async (t) => {
  await t.test("supported coverage class", async () => {
    const result = await checkFixture({
      mutateRegistry: (registry) => {
        registryAsset(registry).coverageClass = "cex-book-only";
      },
    });

    assert.match(joinedErrors(result), /unsupported class "cex-book-only"/);
  });

  await t.test("indexed-pool monitor", async () => {
    const result = await checkFixture({
      mutateRegistry: (registry) => {
        registryAsset(registry).monitors = [];
      },
    });

    assert.match(
      joinedErrors(result),
      /requires at least one indexed-pool monitor/,
    );
  });

  await t.test("Phase-2 provider adapter", async () => {
    const result = await checkFixture({
      mutateRegistry: (registry) => {
        registryAsset(registry).sources[0].provider = "coinbase";
      },
    });
    const errors = joinedErrors(result);

    assert.match(errors, /unsupported Phase-2 adapter "coinbase"/);
    assert.match(
      errors,
      /must name a source backed by a Phase-2 external CEX adapter/,
    );
  });

  await t.test("provider-native pair aliases", async () => {
    const result = await checkFixture({
      mutateRegistry: (registry) => {
        const asset = registryAsset(registry);
        asset.sources[0].pair = "EUROP/EUR";
        asset.sources[1].pair = "EUROP-EUR";
      },
    });
    const errors = joinedErrors(result);

    assert.match(errors, /bitvavo.*expected "EUROP-EUR"/);
    assert.match(errors, /kraken.*expected "EUROP\/EUR"/);
  });
});

test("enforces registry and policy cardinality ceilings", async (t) => {
  await t.test("32 registry assets", async () => {
    const result = await checkFixture({
      mutateRegistry: (registry) => {
        for (let index = 1; index <= 32; index += 1) {
          registry[`europ-alias-${index}`] = clone(registry["europ-schuman"]);
        }
      },
    });

    assert.match(
      joinedErrors(result),
      /registry: expected at most 32 assets, found 33/,
    );
  });

  await t.test("16 registry and policy sources", async () => {
    const result = await checkFixture({
      mutateRegistry: (registry) => {
        const sources = registryAsset(registry).sources;
        for (let index = 0; index < 14; index += 1) {
          sources.push({ ...clone(sources[1]), id: `kraken_extra_${index}` });
        }
      },
      mutatePolicy: (policy) => {
        const sources = policyAsset(policy).sources;
        for (let index = 0; index < 14; index += 1) {
          sources[`kraken_extra_${index}`] = clone(sources.kraken_eur);
        }
      },
    });
    const errors = joinedErrors(result);

    assert.match(errors, /registry.*sources: expected at most 16, found 17/);
    assert.match(
      errors,
      /policy\.active.*sources: expected at most 16, found 17/,
    );
  });

  await t.test("8 tokenRefs and monitors", async () => {
    const result = await checkFixture({
      mutateRegistry: (registry) => {
        const asset = registryAsset(registry);
        for (let index = 1; index <= 8; index += 1) {
          asset.tokenRefs.push(clone(asset.tokenRefs[0]));
          asset.monitors.push({
            ...clone(asset.monitors[0]),
            poolAddress: `0x${String(index).padStart(40, "0")}`,
          });
        }
      },
    });
    const errors = joinedErrors(result);

    assert.match(errors, /tokenRefs: expected at most 8, found 9/);
    assert.match(errors, /monitors: expected at most 8, found 9/);
  });

  await t.test("32 policy assets in every version", async () => {
    const result = await checkFixture({
      mutatePolicy: (policy) => {
        for (let index = 1; index <= 32; index += 1) {
          policy.active.assets[`europ-alias-${index}`] = clone(
            policy.active.assets["europ-schuman"],
          );
        }
      },
    });

    assert.match(
      joinedErrors(result),
      /policy\.active\.assets: expected at most 32 assets, found 33/,
    );
  });
});

test("rejects two slugs claiming the same canonical token", async () => {
  const result = await checkFixture({
    mutateRegistry: (registry) => {
      registry["europ-legacy"] = clone(registry["europ-schuman"]);
    },
    mutatePolicy: (policy) => {
      policy.active.assets["europ-legacy"] = clone(
        policy.active.assets["europ-schuman"],
      );
    },
  });

  assert.match(
    joinedErrors(result),
    /claimed by both.*remove the stale asset alias/,
  );
});

test("rejects conversion and monitor chain mismatches", async (t) => {
  const authority = authorityFixture({ chains: [137, 143] });

  await t.test("conversion chain", async () => {
    const result = await checkFixture({
      authority,
      mutateRegistry: (registry) => {
        registryAsset(registry).sources[2].convertVia.chainId = 143;
      },
    });
    const errors = joinedErrors(result);

    assert.match(errors, /chain 143 has no tokenRef/);
    assert.match(errors, /feed .* is unknown on chain 143/);
  });

  await t.test("monitor chain", async () => {
    const result = await checkFixture({
      authority,
      mutateRegistry: (registry) => {
        registryAsset(registry).monitors[0].chainId = 143;
      },
    });
    const errors = joinedErrors(result);

    assert.match(errors, /not this asset's canonical SyntheticAsset tokenRef/);
    assert.match(errors, /feed .* is unknown on chain 143/);
  });
});

test("requires the explicit conversion feed direction to be to/from", async () => {
  const result = await checkFixture({
    authority: authorityFixture({ conversionPair: "USD/EUR" }),
  });

  assert.match(
    joinedErrors(result),
    /feed pair "USD\/EUR" does not match required conversion pair "EUR\/USD"/,
  );
});

test("requires the monitor feed to bind the SyntheticAsset to its peg", async () => {
  const result = await checkFixture({
    authority: authorityFixture({ monitorPair: "EUR/EUROP" }),
  });

  assert.match(
    joinedErrors(result),
    /does not bind SyntheticAsset "EUROP" to peg "EUR"/,
  );
});

test("requires exactly one canonical SortedOracles on referenced chains", async (t) => {
  await t.test("missing", async () => {
    const result = await checkFixture({
      authority: authorityFixture({ sortedOracles: [] }),
    });

    assert.match(
      joinedErrors(result),
      /expected exactly one canonical SortedOracles.*found 0/,
    );
  });

  await t.test("duplicate", async () => {
    const result = await checkFixture({
      authority: authorityFixture({
        sortedOracles: [
          SORTED_ORACLES,
          "0x1111111111111111111111111111111111111111",
        ],
      }),
    });

    assert.match(
      joinedErrors(result),
      /expected exactly one canonical SortedOracles.*found 2/,
    );
  });
});

test("requires exactly one deep venue and a matching designation", async (t) => {
  await t.test("two deep sources", async () => {
    const result = await checkFixture({
      mutatePolicy: (policy) => {
        policyAsset(policy).sources.kraken_eur.authority = "deep";
      },
    });

    assert.match(
      joinedErrors(result),
      /expected exactly one deep venue, found 2/,
    );
  });

  await t.test("no deep source", async () => {
    const result = await checkFixture({
      mutatePolicy: (policy) => {
        policyAsset(policy).sources.bitvavo_eur.authority = "secondary";
      },
    });

    assert.match(
      joinedErrors(result),
      /expected exactly one deep venue, found 0/,
    );
  });

  await t.test("stale designation", async () => {
    const result = await checkFixture({
      mutatePolicy: (policy) => {
        policyAsset(policy).deepVenueSource = "bitvavo_legacy";
      },
    });
    const errors = joinedErrors(result);

    assert.match(errors, /deepVenueSource: expected "bitvavo_eur"/);
    assert.match(errors, /is not a policy source/);
  });
});

test("requires complete policy for every authority-bearing source", async () => {
  const result = await checkFixture({
    mutatePolicy: (policy) => {
      delete policyAsset(policy).sources.bitvavo_eur.referenceSizeCap;
    },
  });

  assert.match(
    joinedErrors(result),
    /bitvavo_eur.*referenceSizeCap: missing or non-finite source policy/,
  );
});

test("enforces topology and conversion-policy consistency", async (t) => {
  await t.test("display topology has no alert authority", async () => {
    const result = await checkFixture({
      mutatePolicy: (policy) => {
        policyAsset(policy).sources.kraken_usd.authority = "secondary";
      },
    });

    assert.match(
      joinedErrors(result),
      /display topology cannot carry alert authority/,
    );
  });

  await t.test("converted source has an error band", async () => {
    const result = await checkFixture({
      mutatePolicy: (policy) => {
        policyAsset(policy).sources.kraken_usd.conversionErrorBps = 0;
      },
    });

    assert.match(
      joinedErrors(result),
      /converted source requires a positive error band/,
    );
  });

  await t.test("direct quote has no conversion error", async () => {
    const result = await checkFixture({
      mutatePolicy: (policy) => {
        policyAsset(policy).sources.bitvavo_eur.conversionErrorBps = 5;
      },
    });

    assert.match(
      joinedErrors(result),
      /direct-quote source must use zero conversion error/,
    );
  });
});

test("validates retained previous policy internal topology during rollover", async () => {
  const result = await checkFixture({
    mutatePolicy: (policy) => {
      policy.previous = clone(policy.active);
      sealPolicyVersion(policy.previous, "europ-v0");
      policy.previous.assets["europ-schuman"].sources.bitvavo_legacy =
        policy.previous.assets["europ-schuman"].sources.bitvavo_eur;
      delete policy.previous.assets["europ-schuman"].sources.bitvavo_eur;
      sealPolicyVersion(policy.previous, "europ-v0");
    },
  });

  assert.match(
    joinedErrors(result),
    /policy\.previous.*deepVenueSource.*bitvavo_eur.*not a policy source/,
  );
});

test("accepts complete A-to-B onboarding while active still matches registry", async () => {
  const result = await checkFixture({
    mutateRegistry: (registry) => {
      const source = clone(registryAsset(registry).sources[1]);
      source.id = "kraken_eur_backup";
      registryAsset(registry).sources.push(source);
    },
    mutatePolicy: (policy) => {
      policy.previous = clone(policy.active);
      sealPolicyVersion(policy.previous, "europ-v1");
      policy.active.assets["europ-schuman"].sources.kraken_eur_backup = clone(
        policy.active.assets["europ-schuman"].sources.kraken_eur,
      );
      sealPolicyVersion(policy.active, "europ-v2");
    },
  });

  assert.deepEqual(
    result.errors,
    [],
    `expected current B topology and retained complete A policy to pass:\n${joinedErrors(result)}`,
  );
});

test("retained previous topology does not relax active registry parity", async () => {
  const result = await checkFixture({
    mutateRegistry: (registry) => {
      const source = clone(registryAsset(registry).sources[1]);
      source.id = "kraken_eur_backup";
      registryAsset(registry).sources.push(source);
    },
    mutatePolicy: (policy) => {
      policy.previous = clone(policy.active);
      sealPolicyVersion(policy.previous, "europ-v1");
      sealPolicyVersion(policy.active, "europ-v2");
    },
  });

  assert.match(
    joinedErrors(result),
    /policy\.active.*missing registry source "kraken_eur_backup"/,
  );
});

test("policy version suffix binds each retained version's immutable content", async (t) => {
  await t.test("uses locale-independent code-point key order", () => {
    assert.equal(
      pegPolicyVersionDigest({
        version: "ignored",
        assets: {
          "asset-a": {
            sources: {
              kraken_eur: { weight: 1 },
              kraken2_eur: { weight: 2 },
            },
          },
        },
        rolloverAckExpectedSeconds: 300,
      }),
      "366f968f8c1281f3aa1a31126dfceff7",
    );
  });

  await t.test("missing digest suffix", async () => {
    const result = await checkFixture({
      mutatePolicy: (policy) => {
        policy.active.version = "europ-v2";
      },
    });

    assert.match(joinedErrors(result), /must end with the first 32 lowercase/);
  });

  await t.test("content changed under retained suffix", async () => {
    const result = await checkFixture({
      mutatePolicy: (policy) => {
        policy.active.assets["europ-schuman"].warnDeviationBps += 1;
      },
    });

    assert.match(
      joinedErrors(result),
      /digest suffix .* does not match policy content/,
    );
  });

  await t.test("active and previous validate independently", async () => {
    const result = await checkFixture({
      mutatePolicy: (policy) => {
        policy.previous = clone(policy.active);
        policy.previous.assets["europ-schuman"].warnDeviationBps += 1;
        sealPolicyVersion(policy.previous, "europ-v1");
        sealPolicyVersion(policy.active, "europ-v2");
      },
    });

    assert.deepEqual(result.errors, []);
  });
});

test("policy lineage retains the exact prior active version", () => {
  const { policy: base } = readProductionData();
  base.previous = null;
  const next = clone(base);
  next.active.assets["europ-schuman"].warnDeviationBps += 1;
  sealPolicyVersion(next.active, "europ-v2");

  assert.match(
    validatePegPolicyLineage(base, next).join("\n"),
    /must retain the complete prior active version/,
  );

  next.previous = clone(base.active);
  assert.deepEqual(validatePegPolicyLineage(base, next), []);

  next.previous.assets["europ-schuman"].warnDeviationBps += 1;
  sealPolicyVersion(next.previous, "unrelated-v1");
  assert.match(
    validatePegPolicyLineage(base, next).join("\n"),
    /must retain the complete prior active version/,
  );
});

test("policy lineage allows ack cleanup but rejects predecessor reintroduction", () => {
  const { policy } = readProductionData();
  const withPrevious = clone(policy);
  withPrevious.previous = clone(policy.active);
  sealPolicyVersion(withPrevious.previous, "europ-v0");

  const cleaned = clone(withPrevious);
  cleaned.previous = null;
  assert.deepEqual(validatePegPolicyLineage(withPrevious, cleaned), []);
  assert.match(
    validatePegPolicyLineage(cleaned, withPrevious).join("\n"),
    /reintroduced a retained predecessor/,
  );
});

test("policy lineage requires ACK cleanup before another active rollover", () => {
  const { policy: initial } = readProductionData();
  const current = clone(initial);
  current.previous = clone(initial.active);
  current.active.assets["europ-schuman"].warnDeviationBps += 1;
  sealPolicyVersion(current.active, "europ-v2");

  const next = clone(current);
  next.previous = clone(current.active);
  next.active.assets["europ-schuman"].warnDeviationBps += 1;
  sealPolicyVersion(next.active, "europ-v3");

  assert.match(
    validatePegPolicyLineage(current, next).join("\n"),
    /requires ACK cleanup .* before another active rollover/,
  );

  const acknowledged = clone(current);
  acknowledged.previous = null;
  assert.deepEqual(validatePegPolicyLineage(acknowledged, next), []);
});

test("returns unique errors in deterministic lexical order", async () => {
  const options = {
    mutateRegistry: (registry) => {
      const asset = registryAsset(registry);
      asset.monitors[0].poolAddress = "bad";
      asset.sources.push(clone(asset.sources[0]));
    },
    mutatePolicy: (policy) => {
      policyAsset(policy).deepVenueSource = "stale_source";
    },
  };
  const first = await checkFixture(options);
  const second = await checkFixture(options);

  assert.deepEqual(first.errors, [...first.errors].sort());
  assert.equal(new Set(first.errors).size, first.errors.length);
  assert.deepEqual(second.errors, first.errors);
});

test("reports invalid JSON with the injected path", async () => {
  const directory = mkdtempSync(join(tmpdir(), "peg-integrity-json-test-"));
  const registryPath = join(directory, "registry.json");
  writeFileSync(registryPath, "{");
  try {
    await assert.rejects(
      checkPegRegistryIntegrity({
        registryPath,
        policyPath: POLICY_PATH,
        authority: authorityFixture(),
      }),
      new RegExp(
        `registry: invalid JSON in ${registryPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
      ),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("CLI is directly runnable from the repository root", () => {
  const output = execFileSync(
    process.execPath,
    [relative(REPO_ROOT, SCRIPT_PATH)],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );

  assert.match(output, /Peg registry integrity check OK: 1 asset\(s\)/);
});

test("CLI fails closed when the policy base ref is unavailable", () => {
  const result = spawnSync(
    process.execPath,
    [SCRIPT_PATH, "--base-ref", "origin/definitely-missing-policy-base"],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /cannot resolve policy base ref/);
});

test("CLI no-argument local inference fails closed without origin/main", () => {
  const directory = mkdtempSync(join(tmpdir(), "peg-integrity-git-test-"));
  const gitDirectory = join(directory, "isolated.git");
  const env = { ...process.env, GIT_DIR: gitDirectory };
  delete env.GITHUB_BASE_REF;
  delete env.PEG_POLICY_BASE_REF;
  execFileSync("git", ["init", "--bare", gitDirectory], {
    encoding: "utf8",
    stdio: "ignore",
  });

  try {
    const result = spawnSync(process.execPath, [SCRIPT_PATH], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env,
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /cannot resolve policy base ref origin\/main/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("CLI initial policy introduction requires previous=null", () => {
  const data = readProductionData();
  data.policy.previous = null;
  const directory = mkdtempSync(
    join(tmpdir(), "peg-integrity-bootstrap-test-"),
  );
  const repository = join(directory, "repository");
  const registryPath = join(directory, "registry.json");
  const policyPath = join(directory, "policy.json");
  writeFileSync(registryPath, JSON.stringify(data.registry));
  writeFileSync(policyPath, JSON.stringify(data.policy));
  execFileSync("git", ["init", "--initial-branch=main", repository], {
    encoding: "utf8",
    stdio: "ignore",
  });
  execFileSync("git", ["-C", repository, "config", "user.name", "Test"]);
  execFileSync("git", [
    "-C",
    repository,
    "config",
    "user.email",
    "test@example.com",
  ]);
  execFileSync(
    "git",
    ["-C", repository, "commit", "--allow-empty", "-m", "base"],
    {
      stdio: "ignore",
    },
  );
  execFileSync("git", [
    "-C",
    repository,
    "update-ref",
    "refs/remotes/origin/main",
    "HEAD",
  ]);
  const env = { ...process.env, GIT_DIR: join(repository, ".git") };
  delete env.GITHUB_BASE_REF;
  delete env.PEG_POLICY_BASE_REF;

  try {
    const accepted = spawnSync(
      process.execPath,
      [SCRIPT_PATH, "--registry", registryPath, "--policy", policyPath],
      { cwd: REPO_ROOT, encoding: "utf8", env },
    );
    assert.equal(accepted.status, 0, accepted.stderr);

    data.policy.previous = clone(data.policy.active);
    sealPolicyVersion(data.policy.previous, "unrelated-v0");
    writeFileSync(policyPath, JSON.stringify(data.policy));
    const result = spawnSync(
      process.execPath,
      [SCRIPT_PATH, "--registry", registryPath, "--policy", policyPath],
      { cwd: REPO_ROOT, encoding: "utf8", env },
    );

    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /initial policy introduction must not retain an unrelated predecessor/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("CLI accepts injected paths and exits nonzero with actionable errors", () => {
  const data = readProductionData();
  policyAsset(data.policy).deepVenueSource = "stale_source";
  const directory = mkdtempSync(join(tmpdir(), "peg-integrity-cli-test-"));
  const registryPath = join(directory, "registry.json");
  const policyPath = join(directory, "policy.json");
  writeFileSync(registryPath, JSON.stringify(data.registry));
  writeFileSync(policyPath, JSON.stringify(data.policy));
  try {
    const result = spawnSync(
      process.execPath,
      [SCRIPT_PATH, "--registry", registryPath, "--policy", policyPath],
      { cwd: REPO_ROOT, encoding: "utf8" },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /deepVenueSource.*stale_source/);
    assert.match(result.stderr, /Peg registry integrity check failed/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
