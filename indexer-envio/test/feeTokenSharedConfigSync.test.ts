/// <reference types="mocha" />
import { strict as assert } from "assert";
import { KNOWN_TOKEN_META } from "../src/feeToken";

/**
 * Drift-protection test. `indexer-envio/src/feeToken.ts:buildKnownTokenMeta`
 * is a deliberate mirror of `shared-config/src/tokens.ts` (with two extra
 * indexer-only filters: `Mock*` exclusion + `decimals` required). If a
 * contributor weakens the indexer filter to match shared-config verbatim,
 * `isKnownFeeToken` would start admitting Mock ERC20s into the fee-token
 * allowlist — a security regression PR #174 paid for.
 *
 * We can't import shared-config at runtime (Envio builds outside the pnpm
 * workspace — see src/contractAddresses.ts:14-18), so instead we assert
 * invariants on the indexer's KNOWN_TOKEN_META that the shared filter
 * could not produce:
 *
 *   1. No entry has a `rawName` starting with `Mock`
 *   2. Every entry has a defined `decimals` value
 *
 * Both hold today; failing either means the filter was accidentally
 * weakened in a refactor.
 */
describe("feeToken allowlist — drift protection vs shared-config/src/tokens.ts", () => {
  it("excludes every Mock* token from KNOWN_TOKEN_META", () => {
    for (const [key, meta] of KNOWN_TOKEN_META.entries()) {
      assert.ok(
        !meta.symbol.startsWith("Mock"),
        `${key} has symbol ${meta.symbol} — Mock* tokens must NOT be in the fee-token allowlist (security-sensitive, see PR #174).`,
      );
    }
  });

  it("requires decimals for every KNOWN_TOKEN_META entry", () => {
    for (const [key, meta] of KNOWN_TOKEN_META.entries()) {
      assert.ok(
        typeof meta.decimals === "number" && Number.isFinite(meta.decimals),
        `${key} has decimals=${String(meta.decimals)} — indexer-only filter requires a defined decimals field.`,
      );
    }
  });
});
