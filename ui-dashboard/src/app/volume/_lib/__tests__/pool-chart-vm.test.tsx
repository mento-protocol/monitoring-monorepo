/** @vitest-environment jsdom */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SECONDS_PER_DAY } from "@/lib/time-series";
import type { PoolDailyVolumeRow } from "@/lib/volume-pool";

vi.mock("@/lib/networks", () => ({
  networkForChainId: (chainId: number) =>
    chainId === 42220
      ? { chainId, label: "Celo" }
      : chainId === 143
        ? { chainId, label: "Monad" }
        : null,
}));

vi.mock("@/lib/tokens", () => ({
  poolName: (_network: unknown, token0: string | null, token1: string | null) =>
    `${token0 ?? "?"}/${token1 ?? "?"}`,
}));

import { usePoolChartViewModel } from "../pool-chart-vm";

type ViewModel = ReturnType<typeof usePoolChartViewModel>;
type ResultRef = { current: ViewModel | null };

const USD_WEI = BigInt(10) ** BigInt(18);
const DAY = 1_767_225_600;
const CELO_POOL = "42220-0x1111111111111111111111111111111111111111";
const MONAD_POOL = "143-0x2222222222222222222222222222222222222222";

function usdWei(amount: number): string {
  return (BigInt(amount) * USD_WEI).toString();
}

function row(
  overrides: Partial<PoolDailyVolumeRow> & Pick<PoolDailyVolumeRow, "poolId">,
): PoolDailyVolumeRow {
  const timestamp = overrides.timestamp ?? String(DAY);

  return {
    id: `${overrides.poolId}-${timestamp}`,
    chainId: Number(overrides.poolId.split("-", 1)[0]),
    timestamp,
    swapCount: 1,
    swapCountIncludingProtocolActors: 1,
    volumeUsdWei: usdWei(0),
    volumeUsdWeiIncludingProtocolActors: usdWei(0),
    ...overrides,
    poolId: overrides.poolId,
  };
}

function HookWrapper({
  resultRef,
  includeProtocolActors,
  rows,
  cutoff,
  utcDayKey,
}: {
  resultRef: ResultRef;
  includeProtocolActors: boolean;
  rows: readonly PoolDailyVolumeRow[];
  cutoff: number;
  utcDayKey: number;
}) {
  resultRef.current = usePoolChartViewModel({
    includeProtocolActors,
    poolVolumeRows: rows,
    poolMeta: new Map([
      [CELO_POOL.toLowerCase(), { token0: "USDC", token1: "USDm" }],
      [MONAD_POOL.toLowerCase(), { token0: "USDT", token1: "USDm" }],
    ]),
    cutoff,
    utcDayKey,
  });
  return null;
}

let container: HTMLElement;
let root: Root;

function setup() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
}

function renderVm({
  includeProtocolActors = false,
  rows,
  cutoff = DAY - SECONDS_PER_DAY,
  utcDayKey = 1,
}: {
  includeProtocolActors?: boolean;
  rows: readonly PoolDailyVolumeRow[];
  cutoff?: number;
  utcDayKey?: number;
}): ResultRef {
  const ref: ResultRef = { current: null };
  act(() => {
    root.render(
      <HookWrapper
        resultRef={ref}
        includeProtocolActors={includeProtocolActors}
        rows={rows}
        cutoff={cutoff}
        utcDayKey={utcDayKey}
      />,
    );
  });
  return ref;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date((DAY + SECONDS_PER_DAY) * 1000));
  setup();
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.useRealTimers();
});

describe("usePoolChartViewModel", () => {
  it("builds stable chart identities, names, chain labels, colors, and shares", () => {
    const ref = renderVm({
      rows: [
        row({
          poolId: CELO_POOL,
          volumeUsdWei: usdWei(100),
          volumeUsdWeiIncludingProtocolActors: usdWei(150),
        }),
        row({
          poolId: MONAD_POOL,
          volumeUsdWei: usdWei(25),
          volumeUsdWeiIncludingProtocolActors: usdWei(25),
        }),
      ],
    });

    expect(ref.current?.chartBreakdown.map((entry) => entry.id)).toEqual([
      CELO_POOL,
      MONAD_POOL,
    ]);
    expect(ref.current?.chartBreakdown.map((entry) => entry.name)).toEqual([
      "USDC/USDm",
      "USDT/USDm",
    ]);
    expect(
      ref.current?.topPoolsListEntries.map((entry) => entry.share),
    ).toEqual([0.8, 0.2]);
    expect(ref.current?.topPoolsListEntries[0]?.color).toBe(
      ref.current?.chartBreakdown[0]?.color,
    );
    expect(
      renderToStaticMarkup(<>{ref.current?.chartBreakdown[0]?.legendIcon}</>),
    ).toContain("Celo");
    expect(
      renderToStaticMarkup(
        <>{ref.current?.topPoolsListEntries[1]?.chainBadge}</>,
      ),
    ).toContain("Monad");
  });

  it("switches between user-only and including-protocol-actors pool volume", () => {
    const rows = [
      row({
        poolId: CELO_POOL,
        volumeUsdWei: usdWei(100),
        volumeUsdWeiIncludingProtocolActors: usdWei(150),
      }),
    ];

    const userOnly = renderVm({ rows, includeProtocolActors: false });
    expect(userOnly.current?.topPoolsListEntries[0]?.totalUsd).toBe(100);

    const withSystem = renderVm({ rows, includeProtocolActors: true });
    expect(withSystem.current?.topPoolsListEntries[0]?.totalUsd).toBe(150);
  });

  it("returns empty lists when all admitted rows have zero volume", () => {
    const ref = renderVm({
      rows: [
        row({
          poolId: CELO_POOL,
          volumeUsdWei: usdWei(0),
          volumeUsdWeiIncludingProtocolActors: usdWei(0),
        }),
      ],
    });

    expect(ref.current?.chartBreakdown).toEqual([]);
    expect(ref.current?.topPoolsListEntries).toEqual([]);
    expect(ref.current?.poolVolumeBreakdown.windowTotalUsdWei).toBe(BigInt(0));
  });
});
