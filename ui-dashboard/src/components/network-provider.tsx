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

  const paramNetwork = searchParams.get("network") ?? "";
  const fromURL: NetworkId = isNetworkId(paramNetwork)
    ? paramNetwork
    : DEFAULT_NETWORK;

  const [networkId, setNetworkId] = useState<NetworkId>(fromURL);

  // Sync URL → state when the URL changes externally (derived state pattern,
  // avoids calling setState inside useEffect).
  const [prevFromURL, setPrevFromURL] = useState(fromURL);
  if (prevFromURL !== fromURL) {
    setPrevFromURL(fromURL);
    setNetworkId(fromURL);
  }

  const handleNetworkChange = useCallback(
    (id: NetworkId) => {
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
