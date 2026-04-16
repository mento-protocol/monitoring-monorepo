"use client";

import { createContext, use, useMemo, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import {
  NETWORKS,
  DEFAULT_NETWORK,
  isConfiguredNetworkId,
  networkIdForChainId,
  type IndexerNetworkId,
  type Network,
} from "@/lib/networks";
import { extractChainIdFromPoolId } from "@/lib/pool-id";

type NetworkContextValue = {
  network: Network;
  networkId: IndexerNetworkId;
};

const NetworkContext = createContext<NetworkContextValue | null>(null);

// Returns the chainId from a `/pool/<chainId>-<addr>` pathname, or null.
// The catch handles malformed `%`-escapes in the path segment.
function pathnamePoolChainId(pathname: string): number | null {
  if (!pathname.startsWith("/pool/")) return null;
  const segment = pathname.slice("/pool/".length).split("/")[0] ?? "";
  try {
    return extractChainIdFromPoolId(decodeURIComponent(segment));
  } catch {
    return null;
  }
}

export function NetworkProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  const networkId = useMemo<IndexerNetworkId>(() => {
    const chainId = pathnamePoolChainId(pathname);
    const fromPathname = chainId == null ? null : networkIdForChainId(chainId);
    if (fromPathname && isConfiguredNetworkId(fromPathname))
      return fromPathname;
    return DEFAULT_NETWORK;
  }, [pathname]);

  const value: NetworkContextValue = {
    network: NETWORKS[networkId],
    networkId,
  };

  return <NetworkContext value={value}>{children}</NetworkContext>;
}

export function useNetwork(): NetworkContextValue {
  const ctx = use(NetworkContext);
  if (!ctx) {
    throw new Error("useNetwork must be used within <NetworkProvider>");
  }
  return ctx;
}
