/** @vitest-environment jsdom */

import React, { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import type { Pool } from "@/lib/types";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type GqlResult = {
  data: unknown;
  error: Error | undefined;
  isLoading: boolean;
};

const responses = vi.hoisted(() => new Map<string, GqlResult>());

vi.mock("@/lib/graphql", () => ({
  useGQL: (query: string): GqlResult =>
    responses.get(query) ?? {
      data: undefined,
      error: undefined,
      isLoading: false,
    },
}));

import {
  POOL_THRESHOLDS_KNOWN_EXT,
  POOL_VP_DEPRECATION_EXT,
  POOL_VP_LIFECYCLE_DEPRECATION_EXT,
  POOL_VP_ORACLE_FRESHNESS_EXT,
} from "@/lib/queries";
import {
  usePoolWithThresholds,
  type PoolWithThresholdsResult,
} from "./use-pool-with-thresholds";

const BASE_POOL: Pool = {
  id: "42220-0xpool",
  chainId: 42220,
  token0: "0xtoken0",
  token1: "0xtoken1",
  source: "fpmm_factory",
  createdAtBlock: "1",
  createdAtTimestamp: "1000",
  updatedAtBlock: "2",
  updatedAtTimestamp: "2000",
  oracleOk: true,
  oracleTimestamp: "1990",
  priceDifference: "0",
};

let root: Root;
let container: HTMLDivElement;
let observed: PoolWithThresholdsResult | undefined;

function Probe({ pool = BASE_POOL }: { pool?: Pool }) {
  observed = usePoolWithThresholds(pool, pool.id, pool.chainId);
  return null;
}

function result(data: unknown): GqlResult {
  return { data, error: undefined, isLoading: false };
}

beforeEach(() => {
  responses.clear();
  responses.set(
    POOL_THRESHOLDS_KNOWN_EXT,
    result({
      Pool: [
        {
          id: BASE_POOL.id,
          rebalanceThresholdsKnown: true,
          tokenDecimalsKnown: true,
          degenerateReserves: false,
          breakerTripped: true,
        },
      ],
    }),
  );
  responses.set(
    POOL_VP_ORACLE_FRESHNESS_EXT,
    result({ Pool: [{ id: BASE_POOL.id }] }),
  );
  responses.set(
    POOL_VP_DEPRECATION_EXT,
    result({
      BiPoolExchange: [
        { id: "0xexchange", isDeprecated: false, minimumReports: "1" },
      ],
    }),
  );
  responses.set(
    POOL_VP_LIFECYCLE_DEPRECATION_EXT,
    result({ VirtualPoolLifecycle: [] }),
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  observed = undefined;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("usePoolWithThresholds missing-row retention", () => {
  it("retains breaker inputs and degrades when a successful response omits the pool", () => {
    act(() => root.render(<Probe />));
    expect(observed?.pool?.breakerTripped).toBe(true);
    expect(observed?.healthRefreshError).toBeUndefined();

    responses.set(POOL_THRESHOLDS_KNOWN_EXT, result({ Pool: [] }));
    act(() => root.render(<Probe />));

    expect(observed?.pool?.breakerTripped).toBe(true);
    expect(observed?.healthRefreshError?.message).toContain(
      "omitted the requested pool",
    );
  });

  it("retains VirtualPool freshness inputs and degrades when their row disappears", () => {
    const virtualPool: Pool = {
      ...BASE_POOL,
      source: "virtual_pool",
      wrappedExchangeId: "0xexchange",
    };
    responses.set(
      POOL_VP_ORACLE_FRESHNESS_EXT,
      result({
        Pool: [
          {
            id: virtualPool.id,
            medianLive: false,
            oracleFreshnessWindow: "300",
          },
        ],
      }),
    );
    act(() => root.render(<Probe pool={virtualPool} />));
    expect(observed?.pool?.medianLive).toBe(false);
    expect(observed?.healthRefreshError).toBeUndefined();

    responses.set(POOL_VP_ORACLE_FRESHNESS_EXT, result({ Pool: [] }));
    act(() => root.render(<Probe pool={virtualPool} />));

    expect(observed?.pool?.medianLive).toBe(false);
    expect(observed?.healthRefreshError?.message).toContain(
      "omitted the requested pool",
    );
  });

  it("retains a confirmed exchange deprecation across a successful omission", () => {
    const virtualPool: Pool = {
      ...BASE_POOL,
      source: "virtual_pool",
      wrappedExchangeId: "0xexchange",
    };
    responses.set(
      POOL_VP_DEPRECATION_EXT,
      result({
        BiPoolExchange: [
          {
            id: "0xexchange",
            isDeprecated: true,
            minimumReports: "3",
          },
        ],
      }),
    );
    act(() => root.render(<Probe pool={virtualPool} />));
    expect(observed?.pool?.wrappedExchangeDeprecated).toBe(true);

    responses.set(POOL_VP_DEPRECATION_EXT, result({ BiPoolExchange: [] }));
    act(() => root.render(<Probe pool={virtualPool} />));

    expect(observed?.pool?.wrappedExchangeDeprecated).toBe(true);
    expect(observed?.healthRefreshError?.message).toContain(
      "omitted the requested exchange",
    );
  });

  it("marks a cold successful-empty exchange response as unconfirmed", () => {
    const virtualPool: Pool = {
      ...BASE_POOL,
      source: "virtual_pool",
      wrappedExchangeId: "0xexchange",
    };
    responses.set(POOL_VP_DEPRECATION_EXT, result({ BiPoolExchange: [] }));

    act(() => root.render(<Probe pool={virtualPool} />));

    expect(observed?.pool?.vpDeprecationKnown).toBe(false);
    expect(observed?.healthRefreshError?.message).toContain(
      "omitted the requested exchange",
    );
  });

  it("retains a confirmed lifecycle deprecation across a successful omission", () => {
    const virtualPool: Pool = {
      ...BASE_POOL,
      source: "virtual_pool",
      wrappedExchangeId: "0xexchange",
    };
    responses.set(
      POOL_VP_LIFECYCLE_DEPRECATION_EXT,
      result({
        VirtualPoolLifecycle: [
          { id: "deprecation-event", poolId: virtualPool.id },
        ],
      }),
    );
    act(() => root.render(<Probe pool={virtualPool} />));
    expect(observed?.pool?.wrappedExchangeDeprecated).toBe(true);

    responses.set(
      POOL_VP_LIFECYCLE_DEPRECATION_EXT,
      result({ VirtualPoolLifecycle: [] }),
    );
    act(() => root.render(<Probe pool={virtualPool} />));

    expect(observed?.pool?.wrappedExchangeDeprecated).toBe(true);
    expect(observed?.healthRefreshError?.message).toContain(
      "dropped a confirmed deprecation event",
    );
  });
});
