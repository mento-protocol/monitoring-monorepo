"use client";

import { createContext, use, useEffect, useMemo, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import * as Sentry from "@sentry/nextjs";
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

  // Tag every Sentry event with the current chain and drop a breadcrumb on
  // network changes — makes multi-network issue triage filterable and gives
  // on-call a navigation trail when an error fires.
  useEffect(() => {
    Sentry.setTag("chain", networkId);
    Sentry.addBreadcrumb({
      category: "navigation",
      message: `network → ${networkId}`,
      level: "info",
    });
  }, [networkId]);

  // Memoize so navigating between pages on the same chain doesn't produce
  // a new object reference and retrigger every context consumer.
  const value = useMemo<NetworkContextValue>(
    () => ({ network: NETWORKS[networkId], networkId }),
    [networkId],
  );

  return <NetworkContext value={value}>{children}</NetworkContext>;
}

export function useNetwork(): NetworkContextValue {
  const ctx = use(NetworkContext);
  if (!ctx) {
    throw new Error("useNetwork must be used within <NetworkProvider>");
  }
  return ctx;
}
