"use client";

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  type ReactNode,
} from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import {
  NETWORKS,
  DEFAULT_NETWORK,
  isNetworkId,
  type NetworkId,
  type Network,
} from "@/lib/networks";

type NetworkContextValue = {
  network: Network;
  networkId: NetworkId;
  setNetworkId: (id: NetworkId) => void;
};

const NetworkContext = createContext<NetworkContextValue | null>(null);

export function NetworkProvider({ children }: { children: ReactNode }) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  // Read initial value from URL
  const paramNetwork = searchParams.get("network") ?? "";
  const initial = isNetworkId(paramNetwork) ? paramNetwork : DEFAULT_NETWORK;
  const [networkId, setNetworkIdState] = useState<NetworkId>(initial);

  // Sync URL → state when URL changes externally
  useEffect(() => {
    const p = searchParams.get("network") ?? "";
    if (isNetworkId(p) && p !== networkId) {
      setNetworkIdState(p);
    }
  }, [searchParams, networkId]);

  const setNetworkId = useCallback(
    (id: NetworkId) => {
      setNetworkIdState(id);
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
    setNetworkId,
  };

  return (
    <NetworkContext.Provider value={value}>{children}</NetworkContext.Provider>
  );
}

export function useNetwork(): NetworkContextValue {
  const ctx = useContext(NetworkContext);
  if (!ctx) {
    throw new Error("useNetwork must be used within <NetworkProvider>");
  }
  return ctx;
}
