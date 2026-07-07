/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Network } from "@/lib/networks";
import type { Pool } from "@/lib/types";
import { POOL_DETAIL_WITH_HEALTH } from "@/lib/queries";

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
const mockPreloadGQL = vi.fn();
let mockSearchParams = new URLSearchParams();

vi.mock("@/lib/graphql", () => ({
  preloadGQL: (...args: unknown[]) => mockPreloadGQL(...args),
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => mockSearchParams,
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => "/pools",
}));

vi.mock("@/lib/weekend", () => ({
  isWeekend: vi.fn(() => false),
  isWeekendOracleStale: vi.fn(() => false),
  FX_CLOSE_DAY: 5,
  FX_CLOSE_HOUR_UTC: 21,
  FX_REOPEN_DAY: 0,
  FX_REOPEN_HOUR_UTC: 23,
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: ReactNode;
  } & AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

import { GlobalPoolsTable } from "@/components/global-pools-table";

const CELO_NETWORK: Network = {
  id: "celo-mainnet",
  label: "Celo",
  chainId: 42220,
  contractsNamespace: null,
  hasuraUrl: "https://example.com",
  hasuraSecret: "",
  explorerBaseUrl: "https://celoscan.io",
  tokenSymbols: {
    "0xde9e4c3ce781b4ba68120d6261cbad65ce0ab00b": "USDm",
    "0xc7e4635651e3e3af82b61d3e23c159438dae3bbf": "KESm",
  },
  addressLabels: {},
  local: false,
  testnet: false,
  hasVirtualPools: false,
};

const POOL_ID = "42220-0x0000000000000000000000000000000000000001";
const BASE_POOL: Pool = {
  id: POOL_ID,
  chainId: 42220,
  token0: "0xde9e4c3ce781b4ba68120d6261cbad65ce0ab00b",
  token1: "0xc7e4635651e3e3af82b61d3e23c159438dae3bbf",
  source: "fpmm_factory",
  createdAtBlock: "1",
  createdAtTimestamp: "1700000000",
  updatedAtBlock: "1",
  updatedAtTimestamp: "1700000000",
  healthStatus: "OK",
  limitStatus: "OK",
};

let container: HTMLDivElement;
let root: Root;
let previousActEnvironment: boolean | undefined;

beforeEach(() => {
  previousActEnvironment = reactActEnvironment.IS_REACT_ACT_ENVIRONMENT;
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  mockSearchParams = new URLSearchParams();
  mockPreloadGQL.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT =
    previousActEnvironment ?? false;
});

describe("GlobalPoolsTable pool-detail prefetch", () => {
  it("preloads the pool detail query on row hover", () => {
    act(() => {
      root.render(
        <GlobalPoolsTable
          entries={[
            { pool: BASE_POOL, network: CELO_NETWORK, rates: new Map() },
          ]}
        />,
      );
    });

    const row = container.querySelector("tbody tr");
    expect(row).not.toBeNull();
    act(() => {
      row?.dispatchEvent(
        new MouseEvent("mouseover", {
          bubbles: true,
          relatedTarget: document.body,
        }),
      );
    });

    expect(mockPreloadGQL).toHaveBeenCalledWith(
      expect.objectContaining({ id: "celo-mainnet", chainId: 42220 }),
      POOL_DETAIL_WITH_HEALTH,
      { id: POOL_ID, chainId: 42220 },
    );
  });

  it("preloads the same query on keyboard focus", () => {
    act(() => {
      root.render(
        <GlobalPoolsTable
          entries={[
            { pool: BASE_POOL, network: CELO_NETWORK, rates: new Map() },
          ]}
        />,
      );
    });

    const link = container.querySelector("tbody a");
    expect(link).not.toBeNull();
    act(() => {
      link?.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    });

    expect(mockPreloadGQL).toHaveBeenCalledWith(
      expect.objectContaining({ id: "celo-mainnet", chainId: 42220 }),
      POOL_DETAIL_WITH_HEALTH,
      { id: POOL_ID, chainId: 42220 },
    );
  });
});
