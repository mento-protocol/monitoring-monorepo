"use client";

import {
  createContext,
  use,
  useState,
  useCallback,
  useMemo,
  type ReactNode,
} from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
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
  setNetworkId: (id: IndexerNetworkId) => void;
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
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const paramNetwork = searchParams.get("network") ?? "";

  // Priority: ?network= (if configured) > pathname-derived > DEFAULT_NETWORK.
  // The configured check keeps ?network=<unready-network> from resolving.
  const fromPathname = useMemo<IndexerNetworkId | null>(() => {
    const chainId = pathnamePoolChainId(pathname);
    return chainId == null ? null : networkIdForChainId(chainId);
  }, [pathname]);

  const effectiveNetworkId: IndexerNetworkId = useMemo(() => {
    if (isConfiguredNetworkId(paramNetwork)) return paramNetwork;
    if (fromPathname && isConfiguredNetworkId(fromPathname))
      return fromPathname;
    return DEFAULT_NETWORK;
  }, [paramNetwork, fromPathname]);

  const [networkId, setNetworkId] =
    useState<IndexerNetworkId>(effectiveNetworkId);

  // Derived-state sync: picks up URL changes (including pathname flips via
  // browser back/forward) without calling setState inside useEffect.
  const [prevEffective, setPrevEffective] = useState(effectiveNetworkId);
  if (prevEffective !== effectiveNetworkId) {
    setPrevEffective(effectiveNetworkId);
    setNetworkId(effectiveNetworkId);
  }

  const handleNetworkChange = useCallback(
    (id: IndexerNetworkId) => {
      setNetworkId(id);
      const params = new URLSearchParams(searchParams.toString());
      // Delete the param only when selection matches the implicit resolution
      // (pathname-derived here, DEFAULT_NETWORK elsewhere). Otherwise write
      // it so it overrides pathname — required for selector changes on pool
      // detail pages to actually take effect.
      const implicitId = fromPathname ?? DEFAULT_NETWORK;
      if (id === implicitId) {
        params.delete("network");
      } else {
        params.set("network", id);
      }
      const qs = params.toString();
      router.replace(`${pathname}${qs ? `?${qs}` : ""}`, { scroll: false });
    },
    [searchParams, router, pathname, fromPathname],
  );

  const value: NetworkContextValue = {
    network: NETWORKS[networkId],
    networkId,
    setNetworkId: handleNetworkChange,
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

/**
 * A lightweight provider that sets a fixed network in context without URL
 * routing. Use this to render network-aware components (e.g. PoolsTable) for
 * a specific network inside a crosschain layout.
 */
export function StaticNetworkProvider({
  network,
  children,
}: {
  network: Network;
  children: ReactNode;
}) {
  const value: NetworkContextValue = {
    network,
    networkId: network.id,
    setNetworkId: () => {
      // no-op: static provider does not support network switching
    },
  };
  return <NetworkContext value={value}>{children}</NetworkContext>;
}
