/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { NetworkProvider, useNetwork } from "@/components/network-provider";
import type { IndexerNetworkId } from "@/lib/networks";

// ---------------------------------------------------------------------------
// next/navigation mocks — each test mutates `pathname` then renders.
// ---------------------------------------------------------------------------

let pathname = "/";

vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
}));

// Treat every known IndexerNetworkId as configured so these tests exercise
// resolution logic without depending on env vars. networks.test.ts covers
// isConfiguredNetworkId in isolation.
vi.mock("@/lib/networks", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/networks")>("@/lib/networks");
  return {
    ...actual,
    isConfiguredNetworkId: (v: string): v is IndexerNetworkId =>
      v in actual.NETWORKS,
  };
});

let captured: { networkId: IndexerNetworkId; chainId: number } | null = null;
function Probe() {
  const { networkId, network } = useNetwork();
  captured = { networkId, chainId: network.chainId };
  return null;
}

function render() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <NetworkProvider>
        <Probe />
      </NetworkProvider>,
    );
  });
  return { root, container };
}

beforeEach(() => {
  pathname = "/";
  captured = null;
});

afterEach(() => {
  for (const el of Array.from(document.body.children)) el.remove();
});

describe("NetworkProvider — effective network resolution", () => {
  it("derives from pathname's namespaced pool ID", () => {
    pathname = "/pool/143-0x0000000000000000000000000000000000000001";
    render();
    expect(captured?.networkId).toBe("monad-mainnet");
    expect(captured?.chainId).toBe(143);
  });

  it("derives celo-sepolia from chainId 11142220 in the pool ID", () => {
    pathname = "/pool/11142220-0x0000000000000000000000000000000000000001";
    render();
    expect(captured?.networkId).toBe("celo-sepolia");
  });

  it("falls through to DEFAULT_NETWORK when pathname has no namespaced pool", () => {
    pathname = "/address-book";
    render();
    expect(captured?.networkId).toBe("celo-mainnet");
  });

  it("falls through when the pathname chainId isn't in PROD_NETWORK_BY_CHAIN_ID", () => {
    pathname = "/pool/99999-0x0000000000000000000000000000000000000001";
    render();
    expect(captured?.networkId).toBe("celo-mainnet");
  });
});

describe("NetworkProvider — pathname parsing edge cases", () => {
  it("handles non-namespaced pool IDs (raw address) by falling through to DEFAULT", () => {
    pathname = "/pool/0x0000000000000000000000000000000000000001";
    render();
    expect(captured?.networkId).toBe("celo-mainnet");
  });

  it("handles nested sub-routes under /pool/<id>/...", () => {
    pathname =
      "/pool/143-0x0000000000000000000000000000000000000001/extra/deep";
    render();
    expect(captured?.networkId).toBe("monad-mainnet");
  });

  it("handles malformed percent-encoding in the pool-ID segment without throwing", () => {
    pathname = "/pool/%E0%A4%A";
    render();
    expect(captured?.networkId).toBe("celo-mainnet");
  });

  it("does not match /pools (trailing 's') against /pool/ prefix", () => {
    pathname = "/pools";
    render();
    expect(captured?.networkId).toBe("celo-mainnet");
  });
});

describe("NetworkProvider — resync on pathname change", () => {
  it("re-derives network when the pathname changes between two pool IDs on different chains", () => {
    pathname = "/pool/42220-0x0000000000000000000000000000000000000001";
    const { root, container } = render();
    expect(captured?.networkId).toBe("celo-mainnet");

    pathname = "/pool/143-0x0000000000000000000000000000000000000002";
    act(() => {
      root.render(
        <NetworkProvider>
          <Probe />
        </NetworkProvider>,
      );
    });
    expect(captured?.networkId).toBe("monad-mainnet");

    container.remove();
  });
});
