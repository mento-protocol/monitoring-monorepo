"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { ALL_BRIDGE_STATUSES } from "@/lib/bridge-status";
import { parseBridgeChainId } from "@/lib/bridge-flows/filters";
import type { BridgeStatus } from "@/lib/types";
import { BRIDGE_CHAIN_IDS } from "./bridge-chain-filters";

type BridgeFlowUrlState = {
  rawPage: number;
  selectedStatus: BridgeStatus | null;
  sourceChainId: number | null;
  destChainId: number | null;
  setPage: (page: number) => void;
  handleStatusChange: (status: BridgeStatus | null) => void;
  handleSourceChange: (chainId: number | null) => void;
  handleDestinationChange: (chainId: number | null) => void;
};

const BRIDGE_STATUS_SET = new Set<string>(ALL_BRIDGE_STATUSES);

function canonicalizeBridgeFlowParams(
  params: URLSearchParams,
): URLSearchParams {
  const canonical = new URLSearchParams(params);
  const pageParam = canonical.get("page");
  if (pageParam !== null) {
    const page = Number(pageParam);
    if (!Number.isSafeInteger(page) || page <= 1) canonical.delete("page");
    else canonical.set("page", String(page));
  }

  const status = canonical.get("status");
  if (status !== null && !BRIDGE_STATUS_SET.has(status)) {
    canonical.delete("status");
  }
  for (const key of ["source", "destination"] as const) {
    const value = canonical.get(key);
    if (
      value !== null &&
      parseBridgeChainId(value, BRIDGE_CHAIN_IDS) === null
    ) {
      canonical.delete(key);
    }
  }
  return canonical;
}

function parseBridgeFlowUrlState(params: URLSearchParams) {
  const statusParam = params.get("status");
  const pageParam = Number(params.get("page") ?? "1");
  const selectedStatus =
    statusParam !== null && BRIDGE_STATUS_SET.has(statusParam)
      ? (statusParam as BridgeStatus)
      : null;
  return {
    rawPage: Number.isSafeInteger(pageParam) && pageParam > 1 ? pageParam : 1,
    selectedStatus,
    sourceChainId: parseBridgeChainId(params.get("source"), BRIDGE_CHAIN_IDS),
    destChainId: parseBridgeChainId(
      params.get("destination"),
      BRIDGE_CHAIN_IDS,
    ),
  };
}

type ReplaceBridgeParams = (mutate: (params: URLSearchParams) => void) => void;

function useBridgeParamActions(replaceParams: ReplaceBridgeParams) {
  const setPage = useCallback(
    (page: number) => {
      replaceParams((params) => {
        if (page === 1) params.delete("page");
        else params.set("page", String(page));
      });
    },
    [replaceParams],
  );
  const handleStatusChange = useCallback(
    (next: BridgeStatus | null) => {
      replaceParams((params) => {
        if (next === null) params.delete("status");
        else params.set("status", next);
        params.delete("page");
      });
    },
    [replaceParams],
  );
  const updateChainFilter = useCallback(
    (key: "source" | "destination", chainId: number | null) => {
      replaceParams((params) => {
        if (chainId === null) params.delete(key);
        else params.set(key, String(chainId));
        params.delete("page");
      });
    },
    [replaceParams],
  );
  const handleSourceChange = useCallback(
    (chainId: number | null) => updateChainFilter("source", chainId),
    [updateChainFilter],
  );
  const handleDestinationChange = useCallback(
    (chainId: number | null) => updateChainFilter("destination", chainId),
    [updateChainFilter],
  );
  return {
    setPage,
    handleStatusChange,
    handleSourceChange,
    handleDestinationChange,
  };
}

export function useBridgeFlowUrlState(): BridgeFlowUrlState {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const initialParams = searchParams.toString();
  const paramsRef = useRef(initialParams);
  const [state, setState] = useState(() =>
    parseBridgeFlowUrlState(new URLSearchParams(initialParams)),
  );

  const commitParams = useCallback(
    (rawParams: URLSearchParams) => {
      const params = canonicalizeBridgeFlowParams(rawParams);
      const nextParams = params.toString();
      paramsRef.current = nextParams;
      window.history.replaceState(
        window.history.state,
        "",
        `${pathname}${nextParams ? `?${nextParams}` : ""}${window.location.hash}`,
      );
      setState(parseBridgeFlowUrlState(params));
    },
    [pathname],
  );

  useEffect(() => {
    const canonical = canonicalizeBridgeFlowParams(
      new URLSearchParams(paramsRef.current),
    );
    if (canonical.toString() !== paramsRef.current) commitParams(canonical);
  }, [commitParams]);

  useEffect(() => {
    const nextParams = searchParams.toString();
    if (nextParams === paramsRef.current) return;
    const params = canonicalizeBridgeFlowParams(
      new URLSearchParams(nextParams),
    );
    if (params.toString() !== nextParams) commitParams(params);
    else {
      paramsRef.current = nextParams;
      setState(parseBridgeFlowUrlState(params));
    }
  }, [commitParams, searchParams]);

  useEffect(() => {
    const handlePopState = () => {
      const nextParams = window.location.search.slice(1);
      const params = canonicalizeBridgeFlowParams(
        new URLSearchParams(nextParams),
      );
      if (params.toString() !== nextParams) commitParams(params);
      else {
        paramsRef.current = nextParams;
        setState(parseBridgeFlowUrlState(params));
      }
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [commitParams]);

  const replaceParams = useCallback(
    (mutate: (params: URLSearchParams) => void) => {
      const params = new URLSearchParams(paramsRef.current);
      mutate(params);
      commitParams(params);
    },
    [commitParams],
  );
  const actions = useBridgeParamActions(replaceParams);
  return { ...state, ...actions };
}
