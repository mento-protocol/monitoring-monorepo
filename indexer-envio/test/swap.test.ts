import { strict as assert } from "assert";
import { buildSwapTraderFields } from "../src/swap.js";

const CHAIN_CELO = 42220;
const USDM = "0x765de816845861e75a25fca122bb6898b8b1282a";
const USDC = "0xcebA9300f2b948710d2653dD7B07f33A8B32118C";
const TRADER = "0xAbCdEf1234567890aBCdef1234567890ABCDef12";
const ROUTER = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE";

const usdmUsdcPool = {
  token0: USDM,
  token1: USDC,
  token0Decimals: 18,
  token1Decimals: 6,
};

describe("buildSwapTraderFields", () => {
  it("lowercases caller (tx.from) and txTo (tx.to)", () => {
    const fields = buildSwapTraderFields(
      {
        chainId: CHAIN_CELO,
        transaction: { from: TRADER, to: ROUTER },
        params: {
          amount0In: 1_000n * 10n ** 18n,
          amount0Out: 0n,
          amount1In: 0n,
          amount1Out: 999_500_000n,
        },
      },
      usdmUsdcPool,
    );
    assert.equal(fields.caller, TRADER.toLowerCase());
    assert.equal(fields.txTo, ROUTER.toLowerCase());
    assert.ok(fields.volumeUsdWei > 0n);
  });

  it("falls back to empty string when transaction.{from,to} are undefined", () => {
    // Envio's generated types make both fields nullable. At runtime `from` is
    // always present when `field_selection.transaction_fields` includes it,
    // and `to` is only null for contract-creation txs (which don't emit Mento
    // Swap events). The fallback exists only to satisfy the looser type.
    const fields = buildSwapTraderFields(
      {
        chainId: CHAIN_CELO,
        transaction: { from: undefined, to: undefined },
        params: {
          amount0In: 1_000n * 10n ** 18n,
          amount0Out: 0n,
          amount1In: 0n,
          amount1Out: 999_500_000n,
        },
      },
      usdmUsdcPool,
    );
    assert.equal(fields.caller, "");
    assert.equal(fields.txTo, "");
  });

  it("returns volumeUsdWei = 0n when neither token is provided (uncomputable)", () => {
    const fields = buildSwapTraderFields(
      {
        chainId: CHAIN_CELO,
        transaction: { from: TRADER, to: ROUTER },
        params: {
          amount0In: 1_000n * 10n ** 18n,
          amount0Out: 0n,
          amount1In: 0n,
          amount1Out: 1_000n * 10n ** 18n,
        },
      },
      {
        token0: undefined,
        token1: undefined,
        token0Decimals: 18,
        token1Decimals: 18,
      },
    );
    assert.equal(fields.volumeUsdWei, 0n);
  });

  it("passes a historical FX rate through for same-currency non-USD pools", () => {
    const fields = buildSwapTraderFields(
      {
        chainId: 137,
        transaction: { from: TRADER, to: ROUTER },
        params: {
          amount0In: 100n * 10n ** 18n,
          amount0Out: 0n,
          amount1In: 0n,
          amount1Out: 99_900_000n,
        },
      },
      {
        token0: "0x4d502d735b4c574b487ed641ae87ceae884731c7",
        token1: "0x888883b5f5d21fb10dfeb70e8f9722b9fb0e5e51",
        token0Decimals: 18,
        token1Decimals: 6,
      },
      1_100_000_000_000_000_000_000_000n,
    );
    assert.equal(fields.volumeUsdWei, 110n * 10n ** 18n);
  });
});
