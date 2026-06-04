import { strict as assert } from "assert";
import {
  classifyAggregator,
  getClusterMetadata,
  _aggregatorAddressesForChain,
  _allClusterNames,
  _directEntriesForChain,
} from "../src/aggregators";
import { CONTRACT_NAMESPACE_BY_CHAIN } from "../src/contractAddresses";

const CHAIN_CELO = 42220;
const CHAIN_MONAD = 143;

// Aggregator routers verified on-chain 2026-05-04 (see config/aggregators.json).
const SQUID_CELO = "0xce16f69375520ab01377ce7b88f5ba8c48f8d666";
const LIFI_CELO = "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae";
const ZEROX_CELO = "0xdef1c0ded9bec7f1a1670819833240f027b25eff";
const OPENOCEAN_CELO = "0x6352a56caadc4f1e25cd6c75970fa768a3304e64";
const LIFI_MONAD = "0x026f252016a7c47cdef1f05a3fc9e20c92a49c37"; // non-default
const ZEROX_AH_MONAD = "0x0000000000001ff3684f28c67538d4d072c22734";

// Mento direct entry points (from @mento-protocol/contracts).
const CELO_BROKER = "0x777a8255ca72412f0d706dc03c9d1987306b4cad";
const ROUTER_BOTH = "0x4861840c2efb2b98312b0ae34d86fd73e8f9b6f6"; // same on both

// Other Mento system contracts (from contracts.json).
const CELO_BIPOOLMANAGER = "0x22d9db95e6ae61c104a7b6f6c78d7993b94ec901";
const MONAD_FPMM_FACTORY = "0xa849b475fe5a4b5c9c3280152c7a1945b907613b";

const NOT_LABELED = "0xab5801a7d398351b8be11c439e05c5b3259aec9b";

describe("classifyAggregator", () => {
  it("Celo: matches known aggregators by address", () => {
    assert.equal(classifyAggregator(CHAIN_CELO, SQUID_CELO), "squid");
    assert.equal(classifyAggregator(CHAIN_CELO, LIFI_CELO), "lifi");
    assert.equal(classifyAggregator(CHAIN_CELO, ZEROX_CELO), "0x");
    assert.equal(classifyAggregator(CHAIN_CELO, OPENOCEAN_CELO), "openocean");
  });

  it("Monad: matches known aggregators by address (uses non-default LI.FI diamond)", () => {
    assert.equal(classifyAggregator(CHAIN_MONAD, LIFI_MONAD), "lifi");
    assert.equal(classifyAggregator(CHAIN_MONAD, ZEROX_AH_MONAD), "0x");
  });

  it("Aggregator addresses are NOT cross-applied to the wrong chain", () => {
    // Squid is Celo-only; on Monad it should fall through to "unknown".
    assert.equal(classifyAggregator(CHAIN_MONAD, SQUID_CELO), "unknown");
    // The default LI.FI diamond IS active on Celo; on Monad LI.FI uses a
    // different address, so the default address is unknown on Monad.
    assert.equal(classifyAggregator(CHAIN_MONAD, LIFI_CELO), "unknown");
  });

  it("classifies Mento Broker / Router as 'direct'", () => {
    assert.equal(classifyAggregator(CHAIN_CELO, CELO_BROKER), "direct");
    assert.equal(classifyAggregator(CHAIN_CELO, ROUTER_BOTH), "direct");
    assert.equal(classifyAggregator(CHAIN_MONAD, ROUTER_BOTH), "direct");
  });

  it("classifies a direct-to-pool swap as 'direct' when poolAddress matches txTo", () => {
    const poolAddr = "0xabcdef0123456789abcdef0123456789abcdef01";
    assert.equal(classifyAggregator(CHAIN_CELO, poolAddr, poolAddr), "direct");
    // Without poolAddress hint, an unlabeled pool address falls through.
    assert.equal(classifyAggregator(CHAIN_CELO, poolAddr), "unknown");
  });

  it("classifies a pool rebalancer entry point as 'system'", () => {
    const poolAddr = "0xabcdef0123456789abcdef0123456789abcdef01";
    const rebalancer = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    assert.equal(
      classifyAggregator(CHAIN_CELO, rebalancer, poolAddr, {
        rebalancerAddress: rebalancer,
      }),
      "system",
    );
  });

  it("classifies other Mento system contracts as 'system'", () => {
    assert.equal(classifyAggregator(CHAIN_CELO, CELO_BIPOOLMANAGER), "system");
    assert.equal(classifyAggregator(CHAIN_MONAD, MONAD_FPMM_FACTORY), "system");
  });

  it("returns 'unknown' for unlabeled addresses", () => {
    assert.equal(classifyAggregator(CHAIN_CELO, NOT_LABELED), "unknown");
    assert.equal(classifyAggregator(CHAIN_MONAD, NOT_LABELED), "unknown");
  });

  it("returns 'unknown' for empty txTo (contract-creation tx fallback)", () => {
    assert.equal(classifyAggregator(CHAIN_CELO, ""), "unknown");
  });

  it("is case-insensitive on input", () => {
    assert.equal(
      classifyAggregator(CHAIN_CELO, SQUID_CELO.toUpperCase()),
      "squid",
    );
  });

  it("returns 'unknown' for unknown chainId", () => {
    assert.equal(classifyAggregator(99999, SQUID_CELO), "unknown");
  });
});

describe("_aggregatorAddressesForChain", () => {
  it("Celo has 5 verified aggregators (incl. OpenOcean executor) + 1 mento-router-v2 + 16 cluster-7dc08ec28f299c06 contracts", () => {
    const map = _aggregatorAddressesForChain(CHAIN_CELO);
    assert.equal(map.size, 22);
    assert.equal(map.get(SQUID_CELO), "squid");
    // OpenOcean per-leg executor classifies under the same `openocean` name
    // as the user-facing Exchange Proxy that delegates to it.
    assert.equal(
      map.get("0xdec876911cbe9428265af0d12132c52ee8642a99"),
      "openocean",
    );
    // Original MentoRouter on Celo — verified contract, not in
    // @mento-protocol/contracts, so we register it here so v2 broker traffic
    // via this address gets a labeled row instead of landing in `unknown`.
    assert.equal(
      map.get("0xbe729350f8cdfc19db6866e8579841188ee57f67"),
      "mento-router-v2",
    );
  });

  it("Monad has 3 verified aggregators (no Squid, no default LI.FI)", () => {
    const map = _aggregatorAddressesForChain(CHAIN_MONAD);
    assert.equal(map.size, 3);
    assert.ok(!map.has(SQUID_CELO), "Squid not deployed on Monad");
  });
});

describe("cluster classification", () => {
  // The 16 contracts in cluster-7dc08ec28f299c06 (deployer 0x7dc08ec2…df8f022),
  // ordered by deploy time. Source: celoscan creator field on each contract,
  // verified 2026-05-08. All share `owner() = 0x7dc08ec2…df8f022` and were
  // deployed via the CREATE3 factory 0xba5Ed099…ba5Ed.
  const CLUSTER_CONTRACTS = [
    "0xf184a8498f4bad5ca6ef538b72142411588792a3",
    "0xea99a75e309868a59074e9b0441c14ba62c6ea28",
    "0x953b7173200229f255f83b6f4fa448d753b79301",
    "0xf023c10a9adb0553ce07d37f367630e4e84a944e",
    "0x187c35dbbc8055b267303dd7b351e708f4c5d3bf",
    "0x9bfbcd07ea9c3cdc30057d7629beb589fe2d854d",
    "0xfe8237bcba52339d818c9c9c3c94481196e4b653",
    "0x35f629410baffd35c482a1f77cfb0ec2f0a75c76",
    "0x1bbcc3dad88fe33248a9ab6600fe72235c51d7ce",
    "0x48d5be40f43fd70ed9329dc0e83b8c5d3a3364f4",
    "0x93acb2d456edeffa2e2ea97efc4fa4d17c39d4b8",
    "0xef6956414006e161fca5f048331d91e472077e9b",
    "0x00d1cda22d867e2d2f22931b5567e93cc1e047cd",
    "0x2e73e4a7f4c2ee4fb5d5d2fd823821e3975237d7",
    "0x6f9fe2b0acf50874dcb49faefff62382381bf622",
    "0xc2068e03ca948f54348899eeda1417a901d76285",
  ];

  it("classifies all 16 fleet contracts under the same cluster name", () => {
    for (const addr of CLUSTER_CONTRACTS) {
      assert.equal(
        classifyAggregator(CHAIN_CELO, addr),
        "cluster-7dc08ec28f299c06",
        `expected cluster-7dc08ec28f299c06 for ${addr}`,
      );
    }
  });

  it("does NOT classify cluster contracts on the wrong chain", () => {
    // Same address on Monad falls through to "unknown" — the cluster
    // exists only on Celo.
    assert.equal(
      classifyAggregator(CHAIN_MONAD, CLUSTER_CONTRACTS[0]!),
      "unknown",
    );
  });

  it("getClusterMetadata returns deployer + explorer for known clusters", () => {
    const meta = getClusterMetadata("cluster-7dc08ec28f299c06");
    assert.ok(meta, "cluster-7dc08ec28f299c06 metadata should exist");
    assert.equal(meta.chainId, 42220);
    assert.equal(meta.deployer, "0x7dc08ec28f299c062d2941de1f9cfb741df8f022");
    assert.ok(
      meta.explorerUrl.includes(meta.deployer),
      "explorerUrl should link to the deployer",
    );
  });

  it("getClusterMetadata returns undefined for non-cluster names", () => {
    assert.equal(getClusterMetadata("squid"), undefined);
    assert.equal(getClusterMetadata("direct"), undefined);
    assert.equal(getClusterMetadata("unknown"), undefined);
    assert.equal(getClusterMetadata("cluster-deadbeef"), undefined);
  });

  it("_allClusterNames lists every cluster currently labeled", () => {
    const names = _allClusterNames();
    assert.ok(names.includes("cluster-7dc08ec28f299c06"));
    // Sanity: all returned names follow the cluster-<16hex> convention.
    // 16 hex = 64 bits — collision-free in practice for the foreseeable
    // cluster count, vs ~1-in-4-billion for the 8-hex prefix that an
    // earlier version of this PR used.
    for (const name of names) {
      assert.match(
        name,
        /^cluster-[0-9a-f]{16}$/,
        `cluster name "${name}" should match cluster-<16 hex chars>`,
      );
    }
  });

  // (The shared-vs-vendored cluster metadata parity check now lives in
  // `aggregators-parity.test.ts` — it covers the whole file deepEqual, not
  // just the cluster slice.)

  it("every cluster-* name in per-chain entries has a matching $clusters block entry", () => {
    // Catches typos like `cluster-7dc08ec28f299c07` (off-by-one) in
    // aggregators.json — without this test, classifyAggregator would happily
    // return the bad name and the volume PR-3 tooltip would silently
    // break (getClusterMetadata returns undefined).
    const knownClusters = new Set(_allClusterNames());
    const chainsWithAggregators = Object.keys(CONTRACT_NAMESPACE_BY_CHAIN).map(
      Number,
    );
    for (const chainId of chainsWithAggregators) {
      const map = _aggregatorAddressesForChain(chainId);
      for (const [addr, name] of map) {
        if (name.startsWith("cluster-")) {
          assert.ok(
            knownClusters.has(name),
            `${addr} on chain ${chainId} uses cluster name "${name}" but no matching $clusters entry exists in aggregators.json`,
          );
        }
      }
    }
  });
});

describe("_directEntriesForChain", () => {
  it("Celo includes Broker + Router", () => {
    const set = _directEntriesForChain(CHAIN_CELO);
    assert.ok(set.has(CELO_BROKER));
    assert.ok(set.has(ROUTER_BOTH));
  });

  it("Monad includes Routerv300 (no Broker)", () => {
    const set = _directEntriesForChain(CHAIN_MONAD);
    assert.ok(set.has(ROUTER_BOTH));
    assert.ok(!set.has(CELO_BROKER), "Monad has no Broker contract");
  });

  it("Testnet chains (Alfajores + Monad testnet) get direct-entry sets too", () => {
    // Same handler path runs against config.multichain.testnet.yaml; if the
    // direct-entry map were mainnet-only, testnet Broker/Router calls would
    // misclassify as "unknown".
    assert.ok(
      _directEntriesForChain(11142220).size > 0,
      "Alfajores direct-entry set should be non-empty",
    );
    assert.ok(
      _directEntriesForChain(10143).size > 0,
      "Monad testnet direct-entry set should be non-empty",
    );
  });
});
