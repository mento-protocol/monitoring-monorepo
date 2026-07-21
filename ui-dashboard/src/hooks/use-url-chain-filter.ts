"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  readChainFilter,
  writeChainFilterParam,
  type ChainFilterOption,
  type ChainFilterValue,
} from "@/lib/chain-filter";

export function useUrlChainFilter(options: readonly ChainFilterOption[]): {
  chainId: ChainFilterValue;
  updateChainId: (chainId: ChainFilterValue) => void;
} {
  // The route components using this hook are wrapped in Suspense. The server
  // snapshot is load-bearing for direct URL hydration; live reads after mount
  // use window.location because replaceState does not update useSearchParams.
  // react-doctor-disable-next-line react-doctor/nextjs-no-use-search-params-without-suspense
  const searchParams = useSearchParams();
  const [chainId, setChainId] = useState<ChainFilterValue>(() =>
    readChainFilter(searchParams, options),
  );

  const updateChainId = useCallback((next: ChainFilterValue) => {
    setChainId(next);
    const params = new URLSearchParams(window.location.search);
    writeChainFilterParam(params, next);
    replaceSearch(params);
  }, []);

  useEffect(() => {
    if (options.length === 0) return;
    const syncFromLocation = () => {
      const params = new URLSearchParams(window.location.search);
      const next = readChainFilter(params, options);
      setChainId((previous) => (previous === next ? previous : next));
      if (params.has("chain") && next === null) {
        params.delete("chain");
        replaceSearch(params);
      }
    };
    syncFromLocation();
    window.addEventListener("popstate", syncFromLocation);
    return () => window.removeEventListener("popstate", syncFromLocation);
  }, [options]);

  return { chainId, updateChainId };
}

function replaceSearch(params: URLSearchParams) {
  const query = params.toString();
  const next =
    window.location.pathname +
    (query ? `?${query}` : "") +
    window.location.hash;
  window.history.replaceState(window.history.state, "", next);
}
