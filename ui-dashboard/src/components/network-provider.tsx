"use client";

import {
  createContext,
  use,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import {
  NETWORKS,
  DEFAULT_NETWORK,
  isConfiguredNetworkId,
  type IndexerNetworkId,
  type Network,
} from "@/lib/networks";

type NetworkContextValue = {
  network: Network;
  networkId: IndexerNetworkId;
  setNetworkId: (id: IndexerNetworkId) => void;
};

const NetworkContext = createContext<NetworkContextValue | null>(null);

export function NetworkProvider({ children }: { children: ReactNode }) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const paramNetwork = searchParams.get("network") ?? "";
  // Only accept URL network params that are actually configured (have a Hasura URL).
  // This prevents ?network=monad-mainnet-hosted from resolving to a broken state
  // before the Envio indexer has been deployed and the env var set.
  const fromURL: IndexerNetworkId = isConfiguredNetworkId(paramNetwork)
    ? paramNetwork
    : DEFAULT_NETWORK;

  const [networkId, setNetworkId] = useState<IndexerNetworkId>(fromURL);

  // Sync URL → state when the URL changes externally (derived state pattern,
  // avoids calling setState inside useEffect).
  const [prevFromURL, setPrevFromURL] = useState(fromURL);
  if (prevFromURL !== fromURL) {
    setPrevFromURL(fromURL);
    setNetworkId(fromURL);
  }

  const handleNetworkChange = useCallback(
    (id: IndexerNetworkId) => {
      setNetworkId(id);
      const params = new URLSearchParams(searchParams.toString());
      if (id === DEFAULT_NETWORK) {
        params.delete("network");
      } else {
        params.set("network", id);
      }
      const qs = params.toString();
      router.replace(`${pathname}${qs ? `?${qs}` : ""}`, { scroll: false });
    },
    [searchParams, router, pathname],
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
