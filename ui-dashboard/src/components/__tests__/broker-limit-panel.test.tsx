import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Network } from "@/lib/networks";
import {
  LIMIT_FLAG_L0,
  LIMIT_FLAG_LG,
  type BrokerLimitsState,
} from "@/lib/broker-limits";
import type { BrokerTradingLimitRow, Pool } from "@/lib/types";

const AUDM = "0x7175504c455076f15c04a2f90a8e352281f492f9";
const USDM = "0x765de816845861e75a25fca122bb6898b8b1282a";

const NOW_SECONDS = 1_757_900_000;

const NETWORK: Network = {
  id: "celo-mainnet",
  label: "Celo",
  chainId: 42220,
  contractsNamespace: null,
  hasuraUrl: "https://hasura.example.com/v1/graphql",
  hasuraSecret: "",
  explorerBaseUrl: "https://celoscan.io",
  tokenSymbols: { [AUDM]: "AUDm", [USDM]: "USDm" },
  addressLabels: {},
  local: false,
  testnet: false,
  hasVirtualPools: true,
};

vi.mock("@/components/network-provider", () => ({
  useNetwork: () => ({ network: NETWORK }),
}));

// Pin the live clock only. `useSsrSafeRelative` / `useSsrSafeTimestamp` keep
// their real implementations, so the footer still renders its SSR-safe label.
vi.mock("@/hooks/use-now-seconds", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/hooks/use-now-seconds")>();
  return { ...actual, useNowSeconds: () => NOW_SECONDS };
});

import { BrokerLimitPanel } from "@/components/broker-limit-panel";
import { LimitPanel } from "@/components/limit-panel";

const POOL: Pool = {
  id: "42220-0x1d013077b00b28038a3f1e7a29aba34e12e562e9",
  chainId: 42220,
  token0: AUDM,
  token1: USDM,
  source: "virtual_pool_factory",
  wrappedExchangeId:
    "0xd580d237231109e6a96d67d82450611c610a805a26660c90281bdc0cd04a95c7",
  createdAtBlock: "1",
  createdAtTimestamp: "1",
  updatedAtBlock: "1",
  updatedAtTimestamp: "1",
};

function row(
  overrides: Partial<BrokerTradingLimitRow> = {},
): BrokerTradingLimitRow {
  return {
    id: `42220-0xexchange-${overrides.token ?? AUDM}`,
    chainId: 42220,
    exchangeId:
      "0xd580d237231109e6a96d67d82450611c610a805a26660c90281bdc0cd04a95c7",
    exchangeProvider: "0x22d9db95e6ae61c104a7b6f6c78d7993b94ec901",
    limitId:
      "0xd580d237231109e6a96d67d855253150245af6ab7a62ae692295e92e51be073e",
    poolId: POOL.id,
    token: AUDM,
    configKnown: true,
    flags: LIMIT_FLAG_LG,
    timestep0: "0",
    timestep1: "0",
    limit0: "0",
    limit1: "0",
    limitGlobal: "1597",
    stateKnown: true,
    netflow0: "0",
    netflow1: "0",
    netflowGlobal: "-1596",
    lastUpdated0: "0",
    lastUpdated1: "0",
    stateBlock: "77563625",
    stateTimestamp: String(NOW_SECONDS - 120),
    limitPressure0: "0.0000",
    limitPressure1: "0.0000",
    limitPressureGlobal: "0.9994",
    limitStatus: "WARN",
    updatedAtBlock: "77563625",
    updatedAtTimestamp: String(NOW_SECONDS - 120),
    ...overrides,
  };
}

const usdmRow = row({
  id: "usdm-leg",
  token: USDM,
  limitGlobal: "1144",
  netflowGlobal: "1139",
  limitPressureGlobal: "0.9956",
  limitId: "0xd580d237231109e6a96d67d8520d890ae552e1bd7c43f0310aa0b49468fbbded",
});

function state(overrides: Partial<BrokerLimitsState> = {}): BrokerLimitsState {
  return { rows: [], isLoading: false, hasError: false, ...overrides };
}

function render(overrides: Partial<BrokerLimitsState> = {}) {
  return renderToStaticMarkup(
    <BrokerLimitPanel pool={POOL} state={state(overrides)} />,
  );
}

function progressBarCount(html: string): number {
  return html.split('role="progressbar"').length - 1;
}

describe("BrokerLimitPanel", () => {
  it("renders exactly one bar per token leg when only the global window is enabled", () => {
    const html = render({ rows: [row(), usdmRow] });

    expect(progressBarCount(html)).toBe(2);
    expect(html).toContain('aria-label="Global limit (LG) for AUDm"');
    expect(html).toContain('aria-label="Global limit (LG) for USDm"');
    // No 5-minute / daily bar: those windows are disabled on this exchange.
    expect(html).not.toContain("limit (L0)");
    expect(html).not.toContain("limit (L1)");
  });

  it("reports the 99.94% AUDm leg through the ARIA state channel", () => {
    const html = render({ rows: [row()] });

    expect(html).toContain('aria-valuetext="99.9%"');
    // The bar is capped at the valuemax, so the rounded capped percentage is
    // what aria-valuenow carries.
    expect(html).toContain('aria-valuenow="100"');
    expect(html).toContain("99.9%");
  });

  it("rounds an uncapped pressure into aria-valuenow", () => {
    const html = render({ rows: [row({ limitPressureGlobal: "0.9900" })] });

    expect(html).toContain('aria-valuenow="99"');
    expect(html).toContain('aria-valuetext="99.0%"');
  });

  it('marks a breached limit as "(over limit)"', () => {
    const html = render({ rows: [row({ limitPressureGlobal: "1.0500" })] });

    expect(html).toContain('aria-valuetext="105.0% (over limit)"');
    expect(html).toContain('aria-valuenow="100"');
  });

  it("formats netflow and limit as whole tokens, never at the FPMM 15-decimal scale", () => {
    const html = render({ rows: [row(), usdmRow] });

    expect(html).toContain("-1,596 AUDm");
    expect(html).toContain("1,597 AUDm");
    expect(html).toContain("+1,139 USDm");
    expect(html).toContain("1,144 USDm");
    expect(html).not.toContain("0.000000000000");
  });

  it("shows the worst leg status in the header badge", () => {
    const html = render({
      rows: [row({ limitStatus: "OK" }), usdmRow],
    });
    expect(html).toContain("WARN");
  });

  it("holds the badge at N/A while a pool leg is unread", () => {
    // The readable leg must not report OK for the pool: the unread sibling can
    // already be at its cap. Its own bar still renders.
    const oneLegMissing = render({ rows: [row({ limitStatus: "OK" })] });
    expect(oneLegMissing).toContain("⚪");
    expect(oneLegMissing).not.toContain("🟢");
    expect(progressBarCount(oneLegMissing)).toBe(1);

    const legUnread = render({
      rows: [
        row({ limitStatus: "OK" }),
        { ...usdmRow, stateKnown: false, limitStatus: "N/A" },
      ],
    });
    expect(legUnread).toContain("⚪");
    expect(legUnread).not.toContain("🟢");
    expect(legUnread).toContain("Baseline state pending");
  });

  it("holds back the bars until the config is known", () => {
    const html = render({
      rows: [row({ configKnown: false, limitStatus: "N/A" })],
    });

    expect(progressBarCount(html)).toBe(0);
    expect(html).toContain(
      "Limit configuration unavailable, retrying on the next swap.",
    );
    // No false OK: the badge stays N/A while the row is unknown.
    expect(html).toContain("N/A");
  });

  it("holds back the bars until an exact-block state read landed", () => {
    const html = render({
      rows: [row({ stateKnown: false, limitStatus: "N/A" })],
    });

    expect(progressBarCount(html)).toBe(0);
    expect(html).toContain("Baseline state pending");
    expect(html).toContain("State not read yet");
  });

  it("says so when a configured leg has no enabled window", () => {
    const html = render({
      rows: [row({ flags: 0, limitStatus: "N/A" })],
    });

    expect(progressBarCount(html)).toBe(0);
    expect(html).toContain("No limit window is enabled for this token.");
  });

  it("renders the empty, error and loading states distinctly", () => {
    expect(render()).toContain(
      "No limit state yet; limits refresh on Broker swaps for this exchange.",
    );

    const errorHtml = render({ hasError: true });
    expect(errorHtml).toContain("Unable to load trading limits");
    expect(errorHtml).not.toContain("No limit state yet");

    const loadingHtml = render({ isLoading: true });
    expect(loadingHtml).toContain("animate-pulse");
    expect(loadingHtml).not.toContain("No limit state yet");
  });

  it("ages the state footer to amber past 30 minutes", () => {
    const fresh = render({ rows: [row()] });
    expect(fresh).toContain("State as of");
    expect(fresh).not.toContain("text-amber-400");

    const stale = render({
      rows: [row({ stateTimestamp: String(NOW_SECONDS - 1_900) })],
    });
    expect(stale).toContain("text-amber-400");
  });

  it("shows the Broker limit id operators see in Grafana and Aegis", () => {
    const html = render({ rows: [row()] });
    expect(html).toContain(
      "0xd580d237231109e6a96d67d855253150245af6ab7a62ae692295e92e51be073e",
    );
  });

  it("never claims trading limits are inapplicable to a VirtualPool", () => {
    const html = renderToStaticMarkup(
      <LimitPanel
        pool={POOL}
        tradingLimits={[]}
        brokerLimits={state({ rows: [row(), usdmRow] })}
      />,
    );

    expect(html).not.toContain("not applicable");
    expect(html).toContain("Trading Limits");
    expect(progressBarCount(html)).toBe(2);
  });

  it("keeps the FPMM path on its own 15-decimal rows", () => {
    const html = renderToStaticMarkup(
      <LimitPanel
        pool={{ ...POOL, source: "fpmm_factory", wrappedExchangeId: undefined }}
        tradingLimits={[]}
        brokerLimits={state({ rows: [row()] })}
      />,
    );

    expect(html).toContain("No trading limit data available yet.");
    expect(progressBarCount(html)).toBe(0);
  });

  it("orders the legs by the pool's token0/token1", () => {
    const html = render({ rows: [usdmRow, row()] });
    expect(html.indexOf("AUDm")).toBeLessThan(html.indexOf("USDm"));
  });

  it("labels rolling windows from the on-chain timesteps", () => {
    const html = render({
      rows: [
        row({
          flags: LIMIT_FLAG_LG | LIMIT_FLAG_L0,
          timestep0: "300",
          limit0: "100",
          netflow0: "40",
          limitPressure0: "0.4000",
        }),
      ],
    });

    expect(progressBarCount(html)).toBe(2);
    expect(html).toContain('aria-label="5-minute limit (L0) for AUDm"');
  });
});
