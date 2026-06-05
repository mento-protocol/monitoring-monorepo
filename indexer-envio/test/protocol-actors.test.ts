import { strict as assert } from "assert";
import {
  isProtocolActorEntryPoint,
  isProtocolOwnedAddress,
  _protocolOwnedAddressesForChain,
} from "../src/protocol-actors.js";

const CHAIN_CELO = 42220;
const CHAIN_MONAD = 143;
const CHAIN_TEST_FIXTURE = 99999;

// Real Celo addresses (lowercased) — must stay in @mento-protocol/contracts.
const CELO_BROKER = "0x777a8255ca72412f0d706dc03c9d1987306b4cad";
const CELO_BIPOOLMANAGER = "0x22d9db95e6ae61c104a7b6f6c78d7993b94ec901";
const CELO_RESERVE = "0x9380fa34fd9e4fd14c06305fd7b6199089ed4eb9";
const CELO_OPEN_LIQUIDITY_STRATEGY =
  "0x54e2ae8c8448912e17ce0b2453bafb7b0d80e40f";
const CELO_PROTOCOL_FEE_RECIPIENT =
  "0x0dd57f6f181d0469143fe9380762d8a112e96e4a";
const CELO_MENTO_REBALANCER_EOA = "0xaa8299fc6a685b5f9ce9bda8d0b3ea3d54731976";

// Real Monad addresses + an NTT transceiver proxy from nttAddresses.json.
const MONAD_FPMM_FACTORY = "0xa849b475fe5a4b5c9c3280152c7a1945b907613b";
const MONAD_RESERVE_V2 = "0x4255cf38e51516766180b33122029a88cb853806";
const MONAD_NTT_TRANSCEIVER_CHFM = "0x0d05cf3f8d39dc988e69cc1bf37f972eadbdc093";
const TEST_MANUAL_PROTOCOL_ACTOR = "0x0000000000000000000000000000000000000a11";

// A random non-Mento EOA (one of Vitalik's addresses, not relevant to Mento).
const NOT_MENTO = "0xab5801a7d398351b8be11c439e05c5b3259aec9b";

describe("isProtocolOwnedAddress", () => {
  it("flags the Celo Broker as a protocol-owned address", () => {
    assert.equal(isProtocolOwnedAddress(CHAIN_CELO, CELO_BROKER), true);
  });

  it("flags the Celo BiPoolManager + Reserve + ProtocolFeeRecipient", () => {
    assert.equal(isProtocolOwnedAddress(CHAIN_CELO, CELO_BIPOOLMANAGER), true);
    assert.equal(isProtocolOwnedAddress(CHAIN_CELO, CELO_RESERVE), true);
    assert.equal(
      isProtocolOwnedAddress(CHAIN_CELO, CELO_PROTOCOL_FEE_RECIPIENT),
      true,
    );
  });

  it("flags manual Celo protocol actor EOAs as protocol-owned callers", () => {
    assert.equal(
      isProtocolOwnedAddress(CHAIN_CELO, CELO_MENTO_REBALANCER_EOA),
      true,
    );
    assert.equal(
      isProtocolActorEntryPoint(CHAIN_CELO, CELO_MENTO_REBALANCER_EOA),
      true,
    );
  });

  it("flags Monad protocol contracts (FPMMFactory, ReserveV2)", () => {
    assert.equal(isProtocolOwnedAddress(CHAIN_MONAD, MONAD_FPMM_FACTORY), true);
    assert.equal(isProtocolOwnedAddress(CHAIN_MONAD, MONAD_RESERVE_V2), true);
  });

  it("flags Monad NTT transceiver proxies from nttAddresses.json", () => {
    assert.equal(
      isProtocolOwnedAddress(CHAIN_MONAD, MONAD_NTT_TRANSCEIVER_CHFM),
      true,
    );
  });

  it("is case-insensitive on the input address", () => {
    assert.equal(
      isProtocolOwnedAddress(CHAIN_CELO, CELO_BROKER.toUpperCase()),
      true,
    );
  });

  it("returns false for an unrelated EOA", () => {
    assert.equal(isProtocolOwnedAddress(CHAIN_CELO, NOT_MENTO), false);
    assert.equal(isProtocolOwnedAddress(CHAIN_MONAD, NOT_MENTO), false);
  });

  it("returns false for empty string", () => {
    assert.equal(isProtocolOwnedAddress(CHAIN_CELO, ""), false);
  });

  it("returns false for unknown chainId (defensive: no entries → false)", () => {
    assert.equal(isProtocolOwnedAddress(99999, CELO_BROKER), false);
  });

  it("flags a per-pool rebalancer EOA when pool is provided", () => {
    const fakeRebalancer = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    assert.equal(
      isProtocolOwnedAddress(CHAIN_CELO, fakeRebalancer, {
        rebalancerAddress: fakeRebalancer,
      }),
      true,
    );
  });

  it("does not flag a rebalancer-shaped address when pool is missing", () => {
    const fakeRebalancer = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    assert.equal(isProtocolOwnedAddress(CHAIN_CELO, fakeRebalancer), false);
  });

  it("rebalancer comparison is case-insensitive", () => {
    const fakeRebalancer = "0xDEADBEEFdeadbeefdeadbeefdeadbeefDEADBEEF";
    assert.equal(
      isProtocolOwnedAddress(CHAIN_CELO, fakeRebalancer.toLowerCase(), {
        rebalancerAddress: fakeRebalancer,
      }),
      true,
    );
  });

  it("flags a pool rebalancer tx.to as a protocol actor entry point", () => {
    const fakeRebalancer = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    assert.equal(
      isProtocolActorEntryPoint(CHAIN_CELO, fakeRebalancer, {
        rebalancerAddress: fakeRebalancer,
      }),
      true,
    );
  });

  it("does not treat direct-entry Broker tx.to as a protocol actor entry point", () => {
    assert.equal(
      isProtocolActorEntryPoint(CHAIN_CELO, CELO_BROKER, {
        rebalancerAddress: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      }),
      false,
    );
  });

  it("flags non-user-facing static protocol contracts as protocol actor entry points", () => {
    assert.equal(
      isProtocolActorEntryPoint(CHAIN_CELO, CELO_OPEN_LIQUIDITY_STRATEGY),
      true,
    );
  });

  it("flags manual protocol actor overrides by chain", () => {
    assert.equal(
      isProtocolOwnedAddress(CHAIN_TEST_FIXTURE, TEST_MANUAL_PROTOCOL_ACTOR),
      true,
    );
    assert.equal(
      isProtocolActorEntryPoint(CHAIN_TEST_FIXTURE, TEST_MANUAL_PROTOCOL_ACTOR),
      true,
    );
    assert.equal(
      isProtocolOwnedAddress(CHAIN_CELO, TEST_MANUAL_PROTOCOL_ACTOR),
      false,
    );
    assert.equal(
      isProtocolActorEntryPoint(CHAIN_CELO, TEST_MANUAL_PROTOCOL_ACTOR),
      false,
    );
  });
});

describe("_protocolOwnedAddressesForChain", () => {
  it("Celo set includes >5 contracts", () => {
    const set = _protocolOwnedAddressesForChain(CHAIN_CELO);
    assert.ok(
      set.size > 5,
      `expected >5 Celo protocol contracts, got ${set.size}`,
    );
  });

  it("Monad set includes >5 contracts", () => {
    const set = _protocolOwnedAddressesForChain(CHAIN_MONAD);
    assert.ok(
      set.size > 5,
      `expected >5 Monad protocol contracts, got ${set.size}`,
    );
  });

  it("Testnet chains (Alfajores 11142220, Monad testnet 10143) are seeded so testnet runs get correct protocol-flow filtering", () => {
    // Source of truth: config/deployment-namespaces.json. Both testnet chains
    // ship in @mento-protocol/contracts under the testnet-v2-rc5 namespace.
    const alfajoresSet = _protocolOwnedAddressesForChain(11142220);
    const monadTestnetSet = _protocolOwnedAddressesForChain(10143);
    assert.ok(
      alfajoresSet.size > 0,
      `expected non-empty Alfajores protocol-owned set, got ${alfajoresSet.size}`,
    );
    assert.ok(
      monadTestnetSet.size > 0,
      `expected non-empty Monad-testnet protocol-owned set, got ${monadTestnetSet.size}`,
    );
  });

  it("unknown chain returns empty set", () => {
    assert.equal(_protocolOwnedAddressesForChain(99999).size, 0);
  });
});
