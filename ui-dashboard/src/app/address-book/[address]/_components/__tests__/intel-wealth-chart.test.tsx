/** @vitest-environment jsdom */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IntelWealthRecord } from "@/lib/intel-wealth";

let mockSwrData: IntelWealthRecord | null = null;

vi.mock("next-auth/react", () => ({
  useSession: () => ({ status: "authenticated" }),
}));

vi.mock("swr", () => ({
  default: () => ({ data: mockSwrData }),
}));

vi.mock("next/dynamic", () => ({
  default: () =>
    function MockPlot({
      ariaLabel,
      textAlternative,
    }: {
      ariaLabel: string;
      textAlternative: string;
    }) {
      return (
        <div data-testid="plot" aria-label={ariaLabel}>
          {textAlternative}
        </div>
      );
    },
}));

import { IntelWealthChart } from "@/app/address-book/[address]/_components/intel-wealth-chart";

const ADDRESS = "0x" + "a".repeat(40);

function makeRecord(): IntelWealthRecord {
  return {
    address: ADDRESS,
    fetchedAt: "2026-07-01T12:00:00.000Z",
    sources: ["arkham"],
    balances: {
      addresses: {},
      totalBalance: { ethereum: 250 },
      totalBalance24hAgo: { ethereum: 200 },
      balances: {},
    },
    portfolio: {
      "180d_ago": {
        ts: 1_750_000_000,
        data: { tokens: [{ symbol: "CELO", usd: 100 }] },
      },
      "0d_ago": {
        ts: 1_765_000_000,
        data: { tokens: [{ symbol: "CELO", usd: 250 }] },
      },
    },
    version: 1,
  };
}

let container: HTMLElement | null = null;
let root: Root | null = null;

function render() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(<IntelWealthChart address={ADDRESS} />);
  });
}

beforeEach(() => {
  mockSwrData = makeRecord();
});

afterEach(() => {
  if (root) {
    act(() => {
      root?.unmount();
    });
  }
  root = null;
  container?.remove();
  container = null;
  mockSwrData = null;
});

describe("IntelWealthChart accessibility", () => {
  it("wraps the wealth plot in a named figure with an sr-only text alternative", () => {
    render();

    const figure = container?.querySelector('[role="figure"]');
    expect(figure?.getAttribute("aria-label")).toBe("Wealth trajectory chart");
    expect(container?.querySelector(".sr-only")?.textContent).toBe(
      "Wealth trajectory chart with 2 portfolio snapshots. It starts at 180d ago $100.00 and ends at Now $250.00.",
    );
  });
});
