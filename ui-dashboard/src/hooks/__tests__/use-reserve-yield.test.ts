/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { ReserveYieldResponse } from "@/lib/reserve-yield";
import { rateLimitAwareRetry } from "@/lib/gql-retry";

function susdsHolding(
  overrides: Partial<ReserveYieldResponse["holdings"][number]> = {},
): ReserveYieldResponse["holdings"][number] {
  return {
    id: "susds-source",
    assetSymbol: "sUSDS",
    chain: "ethereum",
    sourceType: "wallet",
    sourceLabel: "Reserve Safe",
    identifier: "0x0000000000000000000000000000000000000001",
    custodianType: "self-custody",
    balance: 1_000,
    hasTokenBalance: true,
    principalUsd: 1_000,
    earnedYieldUsd: null,
    apyPercent: null,
    yieldModel: "Yield source pending",
    dailyRunRateUsd: null,
    next30dUsd: null,
    next365dUsd: null,
    annualRunRateUsd: null,
    ...overrides,
  };
}

type ReserveYieldSWRConfig = {
  refreshInterval: number;
  revalidateOnFocus: boolean;
  revalidateOnReconnect: boolean;
  refreshWhenHidden: boolean;
  errorRetryCount: number;
  onErrorRetry: unknown;
};

const swrMock = vi.hoisted(() => vi.fn());

vi.mock("swr", () => ({
  default: swrMock,
}));

import { useReserveYield } from "../use-reserve-yield";

let capturedResult: ReturnType<typeof useReserveYield> | null = null;

function ReserveYieldProbe() {
  capturedResult = useReserveYield();
  return null;
}

function renderReserveYieldProbe(): {
  config: ReserveYieldSWRConfig;
  result: ReturnType<typeof useReserveYield>;
} {
  capturedResult = null;
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => {
    root.render(createElement(ReserveYieldProbe));
  });
  root.unmount();
  const config = swrMock.mock.calls[0]?.[2] as
    | ReserveYieldSWRConfig
    | undefined;
  if (config === undefined) throw new Error("SWR config was not captured");
  if (capturedResult === null) {
    throw new Error("Reserve yield hook result was not captured");
  }
  return { config, result: capturedResult };
}

describe("useReserveYield", () => {
  beforeEach(() => {
    swrMock.mockReset();
    swrMock.mockReturnValue({
      data: undefined,
      error: undefined,
      isLoading: false,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("wires the shared active-tab retry guard", () => {
    const { config, result } = renderReserveYieldProbe();

    expect(config.revalidateOnFocus).toBe(false);
    expect(config.revalidateOnReconnect).toBe(false);
    expect(config.refreshWhenHidden).toBe(false);
    expect(config.errorRetryCount).toBe(5);
    expect(config.onErrorRetry).toBe(rateLimitAwareRetry);
    expect(result).toMatchObject({
      hasError: false,
      isLoading: false,
      reserveCurrentHoldingsClassificationFailed: false,
      hasUnindexedSusdsHolding: false,
    });
  });

  it("marks a holdings classification failure separately from broad source errors", () => {
    swrMock.mockReturnValue({
      data: {
        holdingsError:
          "Reserve API response contained asset rows without usable symbols.",
        reserveCurrentHoldingsClassificationFailed: true,
      } satisfies Partial<ReserveYieldResponse>,
      error: undefined,
      isLoading: false,
    });

    const { result } = renderReserveYieldProbe();
    expect(result).toMatchObject({
      hasError: true,
      isLoading: false,
      reserveCurrentHoldingsClassificationFailed: true,
    });
  });

  it("keeps a known stETH source error out of the classification signal", () => {
    swrMock.mockReturnValue({
      data: {
        holdingsError:
          "Reserve API returned yield rows without usable USD values.",
        reserveCurrentHoldingsClassificationFailed: false,
      } satisfies Partial<ReserveYieldResponse>,
      error: undefined,
      isLoading: false,
    });

    const { result } = renderReserveYieldProbe();
    expect(result).toMatchObject({
      hasError: true,
      isLoading: false,
      reserveCurrentHoldingsClassificationFailed: false,
    });
  });

  it("marks a reserve-yield fetch failure as a holdings classification failure", () => {
    swrMock.mockReturnValue({
      data: undefined,
      error: new Error("Reserve yield: HTTP 503"),
      isLoading: false,
    });

    const { result } = renderReserveYieldProbe();
    expect(result).toMatchObject({
      hasError: true,
      isLoading: false,
      reserveCurrentHoldingsClassificationFailed: true,
    });
  });

  it("fails closed when a legacy response omits the classification signal", () => {
    swrMock.mockReturnValue({
      data: {
        holdingsError: null,
      } satisfies Partial<ReserveYieldResponse>,
      error: undefined,
      isLoading: false,
    });

    const { result } = renderReserveYieldProbe();
    expect(result).toMatchObject({
      hasError: false,
      isLoading: false,
      reserveCurrentHoldingsClassificationFailed: true,
    });
  });

  it("surfaces current sUSDS exposure outside indexed wallets", () => {
    swrMock.mockReturnValue({
      data: {
        holdings: [susdsHolding()],
        holdingsError: null,
        reserveCurrentHoldingsClassificationFailed: false,
        hasUnindexedSusdsHolding: true,
      } satisfies Partial<ReserveYieldResponse>,
      error: undefined,
      isLoading: false,
    });

    const { result } = renderReserveYieldProbe();
    expect(result.hasUnindexedSusdsHolding).toBe(true);
  });

  it("derives missing legacy coverage without rejecting stETH-only holdings", () => {
    swrMock.mockReturnValue({
      data: {
        holdings: [susdsHolding()],
        holdingsError: null,
        reserveCurrentHoldingsClassificationFailed: false,
      } satisfies Partial<ReserveYieldResponse>,
      error: undefined,
      isLoading: false,
    });
    expect(renderReserveYieldProbe().result.hasUnindexedSusdsHolding).toBe(
      true,
    );

    swrMock.mockReset();
    swrMock.mockReturnValue({
      data: {
        holdings: [
          susdsHolding({
            assetSymbol: "stETH",
            identifier: "0xd0697f70e79476195b742d5afab14be50f98cc1e",
          }),
        ],
        holdingsError:
          "Reserve API returned yield rows without usable USD values.",
        reserveCurrentHoldingsClassificationFailed: false,
      } satisfies Partial<ReserveYieldResponse>,
      error: undefined,
      isLoading: false,
    });
    expect(renderReserveYieldProbe().result.hasUnindexedSusdsHolding).toBe(
      false,
    );
  });

  it.each([
    ["rate", { rateError: "FRED FEDFUNDS: HTTP 503" }],
    [
      "stETH earned yield",
      {
        earnedYieldError:
          "stETH earned-yield actuals pending: no indexed wallet snapshot rows yet.",
      },
    ],
  ])(
    "keeps a %s source error out of the holdings classification signal",
    (_source, sourceError) => {
      swrMock.mockReturnValue({
        data: {
          holdingsError: null,
          reserveCurrentHoldingsClassificationFailed: false,
          ...sourceError,
        } satisfies Partial<ReserveYieldResponse>,
        error: undefined,
        isLoading: false,
      });

      const { result } = renderReserveYieldProbe();
      expect(result).toMatchObject({
        hasError: true,
        isLoading: false,
        reserveCurrentHoldingsClassificationFailed: false,
      });
    },
  );
});
