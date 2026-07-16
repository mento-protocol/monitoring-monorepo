import { describe, expect, it } from "vitest";
import { NETWORKS } from "../networks";
import type { Pool } from "../types";
import { poolTotalVolumeUSD } from "../volume";

const network = NETWORKS["celo-mainnet"];
const USDM = "0x765de816845861e75a25fca122bb6898b8b1282a";
const USDC = "0xceba9300f2b948710d2653dd7b07f33a8b32118c";

function pool(overrides: Partial<Pool> = {}): Pool {
  return {
    id: "42220-0xpool",
    chainId: 42220,
    token0: USDM,
    token1: USDC,
    source: "fpmm_factory",
    createdAtBlock: "1",
    createdAtTimestamp: "1700000000",
    updatedAtBlock: "2",
    updatedAtTimestamp: "1700000060",
    token0Decimals: 18,
    token1Decimals: 6,
    tokenDecimalsKnown: true,
    notionalVolume0: "125000000000000000000",
    notionalVolume1: "125000000",
    ...overrides,
  };
}

describe("poolTotalVolumeUSD", () => {
  it("uses the exact cumulative USDm counter for the SSR all-time headline", () => {
    expect(poolTotalVolumeUSD(pool(), network, new Map())).toBe(125);
  });

  it("fails closed when the selected cumulative counter is missing", () => {
    expect(
      poolTotalVolumeUSD(
        pool({ notionalVolume0: undefined }),
        network,
        new Map(),
      ),
    ).toBeNull();
  });

  it("keeps untrusted token decimals unavailable", () => {
    expect(
      poolTotalVolumeUSD(
        pool({ tokenDecimalsKnown: undefined }),
        network,
        new Map(),
      ),
    ).toBeNull();
  });
});
