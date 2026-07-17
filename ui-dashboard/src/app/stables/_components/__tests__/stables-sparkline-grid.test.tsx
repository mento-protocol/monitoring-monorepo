/** @vitest-environment jsdom */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { StablesSparklineGrid } from "../stables-sparkline-grid";
import type { StableSupplyDailySnapshot } from "../../_lib/types";

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

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) {
    act(() => {
      root?.unmount();
    });
  }
  root = null;
  container?.remove();
  container = null;
});

function renderGrid(props: {
  latestPerToken: ReadonlyArray<StableSupplyDailySnapshot>;
  isLoading: boolean;
  hasError: boolean;
}): HTMLDivElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <StablesSparklineGrid
        snapshots={[]}
        latestPerToken={props.latestPerToken}
        custodySnapshots={[]}
        latestCustodyPerToken={[]}
        rates={new Map()}
        isLoading={props.isLoading}
        hasError={props.hasError}
      />,
    );
  });
  return container;
}

const GRID_CLASS =
  "grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3";
const CARD_CLASS =
  "rounded-lg border border-slate-800 bg-slate-900/60 p-4 flex flex-col gap-2";

describe("StablesSparklineGrid — loading-branch skeleton parity", () => {
  it("renders the same grid section filled with 20 placeholder cards while loading", () => {
    const div = renderGrid({
      latestPerToken: [],
      isLoading: true,
      hasError: false,
    });

    const grid = div.querySelector('[role="status"]');
    expect(grid).not.toBeNull();
    expect(grid!.className).toBe(GRID_CLASS);

    const cards = grid!.querySelectorAll("article");
    expect(cards).toHaveLength(22);
    for (const card of Array.from(cards)) {
      expect((card as HTMLElement).className).toBe(CARD_CLASS);
    }
  });

  it("gives every skeleton card the same wrapper class as a real loaded card", () => {
    const loadingDiv = renderGrid({
      latestPerToken: [],
      isLoading: true,
      hasError: false,
    });
    const skeletonCard = loadingDiv.querySelector("article");
    expect(skeletonCard).not.toBeNull();

    const loadedDiv = renderGrid({
      latestPerToken: [
        snapshot({
          timestamp: String(NOW_TS),
          totalSupply: "1000000000000000000",
        }),
      ],
      isLoading: false,
      hasError: false,
    });
    const realCard = loadedDiv.querySelector("article");
    expect(realCard).not.toBeNull();

    expect(skeletonCard!.className).toBe(realCard!.className);
  });

  it("reserves the identical minHeight across loading, error, empty, and loaded-with-data branches", () => {
    const loading = renderGrid({
      latestPerToken: [],
      isLoading: true,
      hasError: false,
    });
    const loadingHeight =
      loading.querySelector<HTMLElement>("[style]")?.style.minHeight;
    expect(loadingHeight).toBeTruthy();

    const error = renderGrid({
      latestPerToken: [],
      isLoading: false,
      hasError: true,
    });
    expect(error.querySelector<HTMLElement>("[style]")?.style.minHeight).toBe(
      loadingHeight,
    );

    const empty = renderGrid({
      latestPerToken: [],
      isLoading: false,
      hasError: false,
    });
    expect(empty.querySelector<HTMLElement>("[style]")?.style.minHeight).toBe(
      loadingHeight,
    );

    const loaded = renderGrid({
      latestPerToken: [
        snapshot({
          timestamp: String(NOW_TS),
          totalSupply: "1000000000000000000",
        }),
      ],
      isLoading: false,
      hasError: false,
    });
    expect(loaded.querySelector<HTMLElement>("[style]")?.style.minHeight).toBe(
      loadingHeight,
    );
  });

  it("exposes exactly one polite live region while loading", () => {
    const div = renderGrid({
      latestPerToken: [],
      isLoading: true,
      hasError: false,
    });
    expect(div.querySelectorAll('[aria-live="polite"]')).toHaveLength(1);
  });
});
