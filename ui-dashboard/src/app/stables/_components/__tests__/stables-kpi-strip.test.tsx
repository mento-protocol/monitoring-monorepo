import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StablesKpiStrip } from "../stables-kpi-strip";
import type {
  StableSupplyDailySnapshot,
  StableTokenCustodyDailySnapshot,
} from "../../_lib/types";

const DAY = 86_400;
const NOW_TS = Math.floor(Date.now() / 1000 / DAY) * DAY;

function snapshot(
  overrides: Partial<StableSupplyDailySnapshot> &
    Pick<StableSupplyDailySnapshot, "timestamp" | "totalSupply">,
): StableSupplyDailySnapshot {
  const row: StableSupplyDailySnapshot = {
    id: `42220-${overrides.tokenAddress ?? "0xa"}-${overrides.timestamp}`,
    chainId: overrides.chainId ?? 42220,
    tokenAddress: overrides.tokenAddress ?? "0xa",
    tokenSymbol: overrides.tokenSymbol ?? "USDm",
    source: overrides.source ?? "RESERVE",
    tokenDecimals: overrides.tokenDecimals ?? 18,
    timestamp: overrides.timestamp,
    totalSupply: overrides.totalSupply,
    dailyMintAmount: overrides.dailyMintAmount ?? "0",
    dailyBurnAmount: overrides.dailyBurnAmount ?? "0",
  };
  if (overrides.isCurrentState !== undefined) {
    row.isCurrentState = overrides.isCurrentState;
  }
  return row;
}

function custodySnapshot(
  overrides: Partial<StableTokenCustodyDailySnapshot> &
    Pick<StableTokenCustodyDailySnapshot, "timestamp" | "lockedSupply">,
): StableTokenCustodyDailySnapshot {
  return {
    id: `42220-${overrides.tokenAddress ?? "0xa"}-${overrides.timestamp}`,
    chainId: overrides.chainId ?? 42220,
    tokenAddress: overrides.tokenAddress ?? "0xa",
    tokenSymbol: overrides.tokenSymbol ?? "USDm",
    source: overrides.source ?? "RESERVE",
    tokenDecimals: overrides.tokenDecimals ?? 18,
    managerAddress: overrides.managerAddress ?? "0xlock",
    timestamp: overrides.timestamp,
    lockedSupply: overrides.lockedSupply,
    dailyLockedAmount: overrides.dailyLockedAmount ?? "0",
    dailyUnlockedAmount: overrides.dailyUnlockedAmount ?? "0",
  };
}

describe("StablesKpiStrip", () => {
  it("merges latest rows into 7d KPI rollups", () => {
    const baseline = snapshot({
      timestamp: String(NOW_TS - 7 * DAY),
      totalSupply: "100000000000000000000",
    });
    const latest = snapshot({
      timestamp: String(NOW_TS),
      totalSupply: "200000000000000000000",
    });

    const html = renderToStaticMarkup(
      <StablesKpiStrip
        latestPerToken={[latest]}
        latestCustodyPerToken={[]}
        snapshots={[baseline]}
        custodySnapshots={[]}
        rates={new Map()}
        isLoading={false}
        hasError={false}
      />,
    );

    expect(html).toContain("Circulating supply");
    expect(html).toContain("$200.00");
    expect(html).toContain("7d net change");
    expect(html).toContain("+$100.00");
  });

  it("subtracts custody from latest KPI totals with mixed-case token addresses", () => {
    const latest = snapshot({
      tokenAddress: "0xAa",
      timestamp: String(NOW_TS),
      totalSupply: "1000000000000000000000000",
      isCurrentState: true,
    });
    const locked = custodySnapshot({
      tokenAddress: "0xaa",
      timestamp: String(NOW_TS),
      lockedSupply: "250000000000000000000000",
    });

    const html = renderToStaticMarkup(
      <StablesKpiStrip
        latestPerToken={[latest]}
        latestCustodyPerToken={[locked]}
        snapshots={[]}
        custodySnapshots={[]}
        rates={new Map()}
        isLoading={false}
        hasError={false}
      />,
    );

    expect(html).toContain("$750K");
    expect(html).not.toContain("$1M");
  });

  it("does not subtract live custody from daily fallback supply rows", () => {
    const latest = snapshot({
      tokenAddress: "0xAa",
      timestamp: String(NOW_TS),
      totalSupply: "1000000000000000000000000",
    });
    const liveCustody = custodySnapshot({
      tokenAddress: "0xaa",
      timestamp: String(NOW_TS),
      lockedSupply: "250000000000000000000000",
    });

    const html = renderToStaticMarkup(
      <StablesKpiStrip
        latestPerToken={[latest]}
        latestCustodyPerToken={[liveCustody]}
        snapshots={[]}
        custodySnapshots={[]}
        rates={new Map()}
        isLoading={false}
        hasError={false}
      />,
    );

    expect(html).toContain("$1M");
    expect(html).not.toContain("$750K");
  });
});
