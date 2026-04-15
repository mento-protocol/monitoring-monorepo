/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { NetworkProvider, useNetwork } from "@/components/network-provider";
import type { IndexerNetworkId } from "@/lib/networks";

// ---------------------------------------------------------------------------
// next/navigation mocks — each test mutates these then renders.
// ---------------------------------------------------------------------------

let pathname = "/";
let searchParams = new URLSearchParams();
const replaceMock = vi.fn();

vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
  useSearchParams: () => searchParams,
  useRouter: () => ({ replace: replaceMock }),
}));

// ---------------------------------------------------------------------------
// Network configuration mock — treat every known IndexerNetworkId as
// configured so these tests can exercise NetworkProvider's *resolution
// logic* without depending on which env vars happen to be set.
// (networks.test.ts already covers isConfiguredNetworkId in isolation.)
// ---------------------------------------------------------------------------

vi.mock("@/lib/networks", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/networks")>("@/lib/networks");
  return {
    ...actual,
    isConfiguredNetworkId: (v: string): v is IndexerNetworkId =>
      v in actual.NETWORKS,
  };
});

// ---------------------------------------------------------------------------
// Capture the resolved network via a probe consumer.
// ---------------------------------------------------------------------------

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

// Probe exposes `setNetworkId` so tests can exercise handleNetworkChange.
let setNetworkIdRef: ((id: IndexerNetworkId) => void) | null = null;
function ProbeWithSetter() {
  const { networkId, network, setNetworkId } = useNetwork();
  captured = { networkId, chainId: network.chainId };
  setNetworkIdRef = setNetworkId;
  return null;
}

function renderWithSetter() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <NetworkProvider>
        <ProbeWithSetter />
      </NetworkProvider>,
    );
  });
  return { root, container };
}

beforeEach(() => {
  pathname = "/";
  searchParams = new URLSearchParams();
  captured = null;
  setNetworkIdRef = null;
  replaceMock.mockReset();
});

afterEach(() => {
  for (const el of Array.from(document.body.children)) el.remove();
});

// ---------------------------------------------------------------------------
// Priority: ?network= > pathname-derived > DEFAULT_NETWORK
// ---------------------------------------------------------------------------

describe("NetworkProvider — effective network resolution", () => {
  it("uses ?network= when configured (highest priority)", () => {
    pathname = "/pools";
    searchParams = new URLSearchParams("network=celo-sepolia");
    render();
    expect(captured?.networkId).toBe("celo-sepolia");
  });

  it("derives from pathname's namespaced pool ID when ?network= is absent", () => {
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

  it("falls through to DEFAULT_NETWORK when neither param nor pathname resolves", () => {
    pathname = "/address-book";
    render();
    expect(captured?.networkId).toBe("celo-mainnet");
  });

  it("falls through when the pathname chainId isn't in PROD_NETWORK_BY_CHAIN_ID", () => {
    pathname = "/pool/99999-0x0000000000000000000000000000000000000001";
    render();
    expect(captured?.networkId).toBe("celo-mainnet");
  });

  it("?network= wins even when pathname would derive a different network", () => {
    // Backward-compat path: old URLs with mismatched param/pathname still
    // honor the user's explicit param.
    pathname = "/pool/143-0x0000000000000000000000000000000000000001";
    searchParams = new URLSearchParams("network=celo-mainnet");
    render();
    expect(captured?.networkId).toBe("celo-mainnet");
  });
});

// ---------------------------------------------------------------------------
// handleNetworkChange — write vs delete the param
// ---------------------------------------------------------------------------

describe("NetworkProvider — handleNetworkChange", () => {
  it("writes ?network= when selection differs from pathname-derived (even if target is DEFAULT_NETWORK)", () => {
    // Regression guard: before this branch, picking DEFAULT_NETWORK always
    // deleted the param, which on a Monad pool left pathname derivation
    // stuck on Monad → selector change silently ignored.
    pathname = "/pool/143-0x0000000000000000000000000000000000000001";
    renderWithSetter();
    act(() => setNetworkIdRef!("celo-mainnet"));
    expect(replaceMock).toHaveBeenCalledWith(
      `${pathname}?network=celo-mainnet`,
      { scroll: false },
    );
  });

  it("deletes ?network= when selection matches pathname-derived", () => {
    pathname = "/pool/143-0x0000000000000000000000000000000000000001";
    searchParams = new URLSearchParams("network=monad-mainnet");
    renderWithSetter();
    act(() => setNetworkIdRef!("monad-mainnet"));
    expect(replaceMock).toHaveBeenCalledWith(pathname, { scroll: false });
  });

  it("deletes ?network= when selection matches DEFAULT_NETWORK on non-pool pages", () => {
    pathname = "/pools";
    searchParams = new URLSearchParams("network=celo-sepolia");
    renderWithSetter();
    act(() => setNetworkIdRef!("celo-mainnet"));
    expect(replaceMock).toHaveBeenCalledWith(pathname, { scroll: false });
  });

  it("writes ?network= on non-pool pages when selecting non-default", () => {
    pathname = "/pools";
    renderWithSetter();
    act(() => setNetworkIdRef!("celo-sepolia"));
    expect(replaceMock).toHaveBeenCalledWith(
      `${pathname}?network=celo-sepolia`,
      { scroll: false },
    );
  });
});

// ---------------------------------------------------------------------------
// pathnamePoolChainId — edge cases
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Derived-state resync — browser back/forward between pools on different chains
// ---------------------------------------------------------------------------

describe("NetworkProvider — resync on pathname change", () => {
  it("re-derives network when the pathname changes between two pool IDs on different chains", () => {
    pathname = "/pool/42220-0x0000000000000000000000000000000000000001";
    const { root, container } = render();
    expect(captured?.networkId).toBe("celo-mainnet");

    // Simulate back/forward: pathname flips, provider re-renders.
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

// ---------------------------------------------------------------------------
// Unconfigured ?network= param — falls through (not silently used)
// ---------------------------------------------------------------------------

describe("NetworkProvider — unconfigured param guard", () => {
  it("ignores ?network=<unknown-id> and falls through to pathname-derived", () => {
    pathname = "/pool/143-0x0000000000000000000000000000000000000001";
    searchParams = new URLSearchParams("network=not-a-real-network");
    render();
    expect(captured?.networkId).toBe("monad-mainnet");
  });
});
