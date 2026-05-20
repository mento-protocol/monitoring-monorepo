/** @vitest-environment jsdom */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BridgeVolumeChart } from "@/components/bridge-volume-chart";
import type { BridgeDailySnapshot } from "@/lib/types";

vi.mock("next/dynamic", () => ({
  default: () =>
    function MockPlot() {
      return React.createElement("div", { "data-testid": "plot" });
    },
}));

const SECONDS_PER_DAY = 86_400;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

function dayAlignedNow(): number {
  const nowSec = Math.floor(Date.now() / 1000);
  return Math.floor(nowSec / SECONDS_PER_DAY) * SECONDS_PER_DAY;
}

function makeBridgeSnapshot(
  overrides: Partial<BridgeDailySnapshot> = {},
): BridgeDailySnapshot {
  const date = String(dayAlignedNow());
  return {
    id: `bridge-${date}`,
    date,
    provider: "WORMHOLE",
    tokenSymbol: "USDm",
    sourceChainId: 42220,
    destChainId: 143,
    sentCount: 1,
    deliveredCount: 1,
    cancelledCount: 0,
    sentVolume: "1000000000000000000",
    deliveredVolume: "1000000000000000000",
    sentUsdValue: "1",
    updatedAt: date,
    ...overrides,
  };
}

function renderChart(
  props: Partial<React.ComponentProps<typeof BridgeVolumeChart>> = {},
) {
  act(() => {
    root.render(
      <BridgeVolumeChart
        snapshots={[makeBridgeSnapshot()]}
        rates={new Map()}
        isLoading={false}
        hasError={false}
        {...props}
      />,
    );
  });
}

function buttonWithText(text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(
    (el) => el.textContent === text,
  );
  expect(button).toBeDefined();
  return button as HTMLButtonElement;
}

describe("BridgeVolumeChart cap note", () => {
  it("hides the dataset cap warning on the default 30d range and shows it after switching to All", () => {
    renderChart({ isCapped: true });

    expect(buttonWithText("1M").getAttribute("aria-pressed")).toBe("true");
    expect(container.textContent).not.toContain("partial data");

    act(() => {
      buttonWithText("All").click();
    });

    expect(buttonWithText("All").getAttribute("aria-pressed")).toBe("true");
    expect(container.textContent).toContain("partial data");
  });
});
