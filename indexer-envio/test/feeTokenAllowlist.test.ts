/// <reference types="mocha" />
/**
 * Fee-token registration allowlist
 *
 * Unit-tests the `isKnownFeeToken(chainId, address)` gate used by
 * `FPMMFactory.FPMMDeployed.contractRegister` to decide whether a token's
 * Transfer events should be indexed.
 *
 * Background — DoS mitigation:
 *   FPMMDeployed auto-registers token0/token1 as ERC20FeeToken contracts.
 *   The FPMMFactory is `onlyOwner`, so pool creation is not permissionless,
 *   but gating registration on the canonical Mento token registry is a cheap
 *   defense-in-depth measure. Without this gate, a compromised factory owner
 *   (or a misconfigured legitimate pool) could force the indexer to ingest
 *   Transfer events from an attacker-controlled ERC20.
 *
 * The contractRegister callback itself cannot be exercised by Envio's
 * `processEvent` test harness (framework limitation — documented in
 * dynamicRegistration.test.ts). We unit-test the gate predicate directly.
 */
import { strict as assert } from "assert";
import {
  isKnownFeeToken,
  _addMockAllowedFeeToken,
  _clearMockAllowedFeeTokens,
} from "../src/EventHandlers.ts";

// ---------------------------------------------------------------------------
// Known Mento tokens from @mento-protocol/contracts. These are canonical
// addresses — if the contracts package ever stops publishing them for the
// namespace in `config/deployment-namespaces.json`, this test fails loudly.
// ---------------------------------------------------------------------------

const USDM_CELO = "0x765de816845861e75a25fca122bb6898b8b1282a";
const EURM_CELO = "0xd8763cba276a3738e6de85b4b3bf5fded6d6ca73";
const USDC_CELO = "0xcebA9300f2b948710d2653dD7B07f33A8B32118C";
const USDM_MONAD = "0xBC69212B8E4d445b2307C9D32dD68E2A4Df00115"; // USDmSpoke

// A plausible attacker-controlled ERC20 address — deliberately not in the
// registry. Using a low-entropy address to make diffs readable.
const ATTACKER_TOKEN = "0x00000000000000000000000000000000deadbeef";

describe("isKnownFeeToken — registration gate", () => {
  afterEach(() => {
    _clearMockAllowedFeeTokens();
  });

  // ---------- accept real Mento tokens ----------

  it("accepts known Celo Mento stablecoins (USDm, EURm)", () => {
    assert.equal(isKnownFeeToken(42220, USDM_CELO), true);
    assert.equal(isKnownFeeToken(42220, EURM_CELO), true);
  });

  it("accepts known Celo collateral (USDC)", () => {
    assert.equal(isKnownFeeToken(42220, USDC_CELO), true);
  });

  it("is case-insensitive on the token address", () => {
    assert.equal(isKnownFeeToken(42220, USDM_CELO.toUpperCase()), true);
    assert.equal(isKnownFeeToken(42220, USDM_CELO.toLowerCase()), true);
  });

  it("accepts known Monad tokens (USDmSpoke stripped to USDm)", () => {
    assert.equal(isKnownFeeToken(143, USDM_MONAD), true);
  });

  // ---------- reject attacker-controlled / unknown tokens ----------

  it("rejects an arbitrary attacker-controlled token address", () => {
    assert.equal(isKnownFeeToken(42220, ATTACKER_TOKEN), false);
  });

  it("rejects a Celo mainnet token that is NOT published in @mento-protocol/contracts", () => {
    // Synthetic address — any real attacker-deployed token would look like this.
    assert.equal(
      isKnownFeeToken(42220, "0x1111111111111111111111111111111111111111"),
      false,
    );
  });

  // ---------- chain isolation ----------

  it("rejects a token registered on a different chain (no cross-chain reuse)", () => {
    // USDm is on Celo (42220). Querying it on Monad (143) must return false.
    assert.equal(isKnownFeeToken(143, USDM_CELO), false);
  });

  it("rejects lookups on an unknown chainId", () => {
    assert.equal(isKnownFeeToken(99999, USDM_CELO), false);
  });

  // ---------- test-only mock additions ----------

  it("honors _addMockAllowedFeeToken for tests without touching the static registry", () => {
    assert.equal(isKnownFeeToken(42220, ATTACKER_TOKEN), false);
    _addMockAllowedFeeToken(42220, ATTACKER_TOKEN);
    assert.equal(isKnownFeeToken(42220, ATTACKER_TOKEN), true);
    _clearMockAllowedFeeTokens();
    assert.equal(isKnownFeeToken(42220, ATTACKER_TOKEN), false);
  });

  it("mock entries are chain-scoped (adding to chain A does not leak to chain B)", () => {
    _addMockAllowedFeeToken(42220, ATTACKER_TOKEN);
    assert.equal(isKnownFeeToken(42220, ATTACKER_TOKEN), true);
    assert.equal(isKnownFeeToken(143, ATTACKER_TOKEN), false);
  });
});
