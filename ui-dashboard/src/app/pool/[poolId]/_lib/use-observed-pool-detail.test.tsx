/** @vitest-environment jsdom */

import React, { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import type { PoolDetailInitialData } from "@/lib/pool-detail-initial-data";
import type { PoolDetailResponse } from "@/lib/queries";
import type { Pool } from "@/lib/types";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const gqlMock = vi.hoisted(() => ({
  data: undefined as PoolDetailResponse | undefined,
  error: undefined as Error | undefined,
  isLoading: false,
  onSuccess: undefined as ((response: PoolDetailResponse) => void) | undefined,
}));

vi.mock("@/lib/graphql", () => ({
  useGQL: (
    _query: string,
    _variables: Record<string, unknown>,
    _refreshInterval: undefined,
    options: { onSuccess?: (response: PoolDetailResponse) => void },
  ) => {
    gqlMock.onSuccess = options.onSuccess;
    return {
      data: gqlMock.data,
      error: gqlMock.error,
      isLoading: gqlMock.isLoading,
    };
  },
}));

import { useObservedPoolDetail } from "./use-observed-pool-detail";

function makePool(id: string, chainId: number, checkedAt: number): Pool {
  return {
    id,
    chainId,
    token0: "0xtoken0",
    token1: "0xtoken1",
    source: "fpmm_factory",
    createdAtBlock: "1",
    createdAtTimestamp: "1000",
    updatedAtBlock: "2",
    updatedAtTimestamp: "2000",
    oracleOk: true,
    oracleTimestamp: "1900",
    oracleFreshnessCheckedAt: checkedAt,
    priceDifference: "0",
  };
}

function initialData(pool: Pool): PoolDetailInitialData {
  return { pool: { Pool: [pool] } };
}

let root: Root;
let container: HTMLDivElement;
let observed: ReturnType<typeof useObservedPoolDetail> | undefined;

function Probe({
  pool,
  fallback,
}: {
  pool: Pool;
  fallback: PoolDetailInitialData;
}) {
  observed = useObservedPoolDetail(pool.id, pool.chainId, fallback);
  return null;
}

beforeEach(() => {
  gqlMock.data = undefined;
  gqlMock.error = undefined;
  gqlMock.isLoading = false;
  gqlMock.onSuccess = undefined;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  observed = undefined;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe("useObservedPoolDetail", () => {
  it("retains the SSR pool and reports degradation after a successful omission", () => {
    const pool = makePool("42220-0xpool-a", 42220, 2_000);
    gqlMock.data = { Pool: [] };

    act(() => root.render(<Probe pool={pool} fallback={initialData(pool)} />));

    expect(observed?.pool?.id).toBe(pool.id);
    expect(observed?.error?.message).toContain("omitted the requested pool");
  });

  it("does not leak a client observation across pool navigation", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(3_000 * 1000));
    const poolA = makePool("42220-0xpool-a", 42220, 2_000);
    const poolB = makePool("143-0xpool-b", 143, 2_100);
    gqlMock.data = { Pool: [poolA] };
    act(() =>
      root.render(<Probe pool={poolA} fallback={initialData(poolA)} />),
    );
    act(() => gqlMock.onSuccess?.({ Pool: [poolA] }));
    expect(observed?.pool?.oracleFreshnessCheckedAt).toBe(3_000);

    gqlMock.data = { Pool: [poolB] };
    act(() =>
      root.render(<Probe pool={poolB} fallback={initialData(poolB)} />),
    );

    expect(observed?.pool?.id).toBe(poolB.id);
    expect(observed?.pool?.oracleFreshnessCheckedAt).toBe(2_100);
  });
});
