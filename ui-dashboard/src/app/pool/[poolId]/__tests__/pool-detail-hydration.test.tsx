/** @vitest-environment jsdom */

// Hydration regressions for SSR-prefetched pool-detail values (issue #1623):
// the server renders under one clock and the en-US locale, and the browser
// hydrates under a later UTC day and the de-DE locale. React must report no
// hydration mismatch, and the volume query must keep the server's day key.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { act, type ReactNode } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import type { Network } from "@/lib/networks";
import type {
  BrokerExchangeDailySnapshots24hResponse,
  PoolV2ExchangeResponse,
} from "@/lib/queries";
import type { Pool } from "@/lib/types";

const mockUseGQL = vi.fn();

vi.mock("@/lib/graphql", () => ({
  useGQL: (...args: unknown[]) => mockUseGQL(...args),
}));

const NETWORK = {
  id: "celo-mainnet",
  label: "Celo",
  chainId: 42220,
  contractsNamespace: null,
  hasuraUrl: "https://hasura.example.com/v1/graphql",
  hasuraSecret: "",
  explorerBaseUrl: "https://celoscan.io",
  tokenSymbols: { "0xt0": "GBPm", "0xt1": "USDm" },
  addressLabels: {},
  local: false,
  testnet: false,
  hasVirtualPools: true,
} as unknown as Network;

vi.mock("@/components/network-provider", () => ({
  useNetwork: () => ({ network: NETWORK }),
}));

const { nothing } = vi.hoisted(() => ({ nothing: () => null }));
vi.mock("@/components/address-link", () => ({
  AddressLink: ({ address }: { address: string }) => <span>{address}</span>,
}));
vi.mock("@/components/tooltip", () => ({ Tooltip: nothing }));
vi.mock("@/components/chain-icon", () => ({ ChainIcon: nothing }));
vi.mock("@/components/badges", () => ({ SourceBadge: nothing }));
vi.mock("@/components/market-hours-pill", () => ({
  MarketHoursPill: nothing,
}));
vi.mock("@/components/breaker-panel", () => ({ BreakerPanel: nothing }));
vi.mock("@/components/pool-config-panel", () => ({
  PoolConfigPanel: nothing,
}));
vi.mock("@/components/pool-header/broker-limit-status-value", () => ({
  BrokerLimitStatusValue: nothing,
}));
vi.mock("../_components/pool-lifecycle-panel", () => ({
  PoolLifecyclePanel: nothing,
}));

import { PoolHeader } from "../_components/pool-header";
import { ReservesPanel } from "@/components/reserves-panel";

const SERVER_DAY = 1778457600; // 2026-05-11T00:00:00Z
const CLIENT_DAY = SERVER_DAY + 86_400;

const VIRTUAL_POOL: Pool = {
  id: "42220-0xpool",
  chainId: 42220,
  token0: "0xt0",
  token1: "0xt1",
  token0Decimals: 18,
  token1Decimals: 18,
  tokenDecimalsKnown: true,
  source: "virtual_pool",
  wrappedExchangeId: "0xexchange",
  swapCount: 1234,
  createdAtBlock: "1",
  createdAtTimestamp: String(SERVER_DAY - 3_600),
  updatedAtBlock: "2",
  updatedAtTimestamp: String(SERVER_DAY - 60),
  reserves0: "1234500000000000000000",
  reserves1: "2345600000000000000000",
  oraclePrice: "1000000000000000000000000",
} as unknown as Pool;

const V2_EXCHANGE: PoolV2ExchangeResponse = {
  BiPoolExchange: [
    {
      id: "1",
      chainId: 42220,
      exchangeId: "0xexchange",
      exchangeProvider: "0xprovider",
      asset0: "0xt0",
      asset1: "0xt1",
      pricingModule: "0xpricing",
      pricingModuleName: "ConstantSum",
      spread: "5000000000000000000000",
      referenceRateFeedID: "0x0000000000000000000000000000000000000050",
      referenceRateResetFrequency: "300",
      minimumReports: "1",
      stablePoolResetSize: "0",
      bucket0: "1234567000000000000000000",
      bucket1: "7654321000000000000000000",
      lastBucketUpdate: String(SERVER_DAY - 120),
      isDeprecated: false,
      wrappedByPoolId: "42220-0xpool",
    },
  ],
} as unknown as PoolV2ExchangeResponse;

const VOLUME: BrokerExchangeDailySnapshots24hResponse = {
  BrokerExchangeDailySnapshot: [
    {
      id: `42220-v2-volume-${SERVER_DAY}`,
      timestamp: String(SERVER_DAY),
      volumeUsdWei: "42000000000000000000",
      swapCount: 1234,
    },
  ],
} as unknown as BrokerExchangeDailySnapshots24hResponse;

// Simulate a browser whose default locale differs from the server's. Calls
// that pass an explicit locale are unaffected.
let defaultLocale = "en-US";
const numberToLocale = Number.prototype.toLocaleString;
const dateToLocale = Date.prototype.toLocaleString;

beforeEach(() => {
  defaultLocale = "en-US";
  vi.spyOn(Number.prototype, "toLocaleString").mockImplementation(function (
    this: number,
    locales?: Intl.LocalesArgument,
    options?: Intl.NumberFormatOptions,
  ) {
    return numberToLocale.call(this, locales ?? defaultLocale, options);
  });
  vi.spyOn(Date.prototype, "toLocaleString").mockImplementation(function (
    this: Date,
    locales?: Intl.LocalesArgument,
    options?: Intl.DateTimeFormatOptions,
  ) {
    return dateToLocale.call(this, locales ?? defaultLocale, options);
  });
  vi.useFakeTimers({ toFake: ["Date"] });
  mockUseGQL.mockReset();
  mockUseGQL.mockImplementation(
    (
      query: string | null,
      _variables: unknown,
      _refreshMs: unknown,
      options?: { fallbackData?: unknown },
    ) => {
      const data = query ? options?.fallbackData : undefined;
      return {
        data,
        isLoading: Boolean(query) && data === undefined,
        error: undefined,
      };
    },
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function hydrateUnderBrowserClock(serverHtml: string, ui: ReactNode) {
  vi.setSystemTime((CLIENT_DAY + 5) * 1000);
  defaultLocale = "de-DE";
  // Negative control: the simulated browser locale is live.
  expect((1234).toLocaleString()).toBe("1.234");

  const container = document.createElement("div");
  container.innerHTML = serverHtml;
  document.body.appendChild(container);
  const recoverable: unknown[] = [];
  const consoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => undefined);
  let root: Root | null = null;
  try {
    await act(async () => {
      root = hydrateRoot(container, ui, {
        onRecoverableError: (error) => recoverable.push(error),
      });
      await Promise.resolve();
    });
    const hydrationLogs = consoleError.mock.calls.filter((call) =>
      call.some((value) =>
        /hydrat|didn't match|React error #41[89]/i.test(String(value)),
      ),
    );
    expect(recoverable).toEqual([]);
    expect(hydrationLogs).toEqual([]);
    return container.textContent ?? "";
  } finally {
    await act(async () => {
      root?.unmount();
    });
    container.remove();
  }
}

function volumeCalls() {
  return mockUseGQL.mock.calls.filter(
    ([query]) =>
      typeof query === "string" &&
      query.includes("BrokerExchangeDailySnapshots24h"),
  );
}

describe("pool-detail hydration across server/browser clock and locale", () => {
  it("hydrates the VirtualPool header and keeps the server's volume day key", async () => {
    const ui = (
      <PoolHeader
        pool={VIRTUAL_POOL}
        tradingLimits={[]}
        brokerLimits={{ rows: [], isLoading: false, hasError: false }}
        initialV2Exchange={V2_EXCHANGE}
        initialExchangeVolume={VOLUME}
        initialExchangeVolumeSince={SERVER_DAY}
      />
    );

    vi.setSystemTime((SERVER_DAY + 86_399) * 1000);
    const serverHtml = renderToString(ui);
    expect(serverHtml).toContain("1,234 swaps since UTC midnight");
    expect(serverHtml).toContain("1,234,567");
    expect(serverHtml).toContain("$42.00");

    mockUseGQL.mockClear();
    const text = await hydrateUnderBrowserClock(serverHtml, ui);

    const calls = volumeCalls();
    // Hydration render: the serialized server key and its fallback.
    expect(calls[0]?.[1]).toMatchObject({ since: SERVER_DAY });
    expect(calls[0]?.[3]).toMatchObject({ fallbackData: VOLUME });
    // After mount the key moves to the browser's UTC day without the
    // previous day's fallback.
    const last = calls.at(-1);
    expect(last?.[1]).toMatchObject({ since: CLIENT_DAY });
    expect((last?.[3] as { fallbackData?: unknown }).fallbackData).toBe(
      undefined,
    );
    expect(text).toContain("1,234");
    expect(text).toContain("7,654,321");
  });

  it("hydrates reserve amounts identically under a different browser locale", async () => {
    const ui = <ReservesPanel pool={VIRTUAL_POOL} rates={new Map()} />;

    vi.setSystemTime((SERVER_DAY + 86_399) * 1000);
    const serverHtml = renderToString(ui);
    expect(serverHtml).toContain("1,234.50");

    const text = await hydrateUnderBrowserClock(serverHtml, ui);
    expect(text).toContain("1,234.50");
    expect(text).toContain("2,345.60");
  });
});
