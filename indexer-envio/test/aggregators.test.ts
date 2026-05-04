/// <reference types="mocha" />
import { strict as assert } from "assert";
import {
  classifyAggregator,
  _aggregatorAddressesForChain,
  _directEntriesForChain,
} from "../src/aggregators";

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
  it("Celo has all 4 verified aggregators", () => {
    const map = _aggregatorAddressesForChain(CHAIN_CELO);
    assert.equal(map.size, 4);
    assert.equal(map.get(SQUID_CELO), "squid");
  });

  it("Monad has 3 verified aggregators (no Squid, no default LI.FI)", () => {
    const map = _aggregatorAddressesForChain(CHAIN_MONAD);
    assert.equal(map.size, 3);
    assert.ok(!map.has(SQUID_CELO), "Squid not deployed on Monad");
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
});
