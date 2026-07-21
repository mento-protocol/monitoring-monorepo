/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SWRConfig, type Cache } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolDailyVolumeRow } from "@/lib/volume-pool";

const { requestMock } = vi.hoisted(() => ({
  requestMock: vi.fn(),
}));

vi.mock("@/lib/graphql-fetch", () => ({
  GraphQLClient: vi.fn(function GraphQLClientMock() {
    return { request: requestMock };
  }),
}));

vi.mock("@/components/network-provider", () => ({
  useNetwork: () => ({
    network: {
      id: "celo-mainnet",
      label: "Celo",
      hasuraUrl: "https://hasura.example/v1/graphql",
    },
  }),
}));

import { usePoolVolumeSnapshots } from "../use-pool-volume-snapshots";

type HookResult = ReturnType<typeof usePoolVolumeSnapshots>;
type ResultRef = { current: HookResult | null };

function row(id: string, timestamp: string): PoolDailyVolumeRow {
  return {
    id,
    chainId: 42220,
    poolId: `42220-0x${id.padStart(40, "0")}`,
    timestamp,
    swapCount: 1,
    swapCountIncludingProtocolActors: 1,
    volumeUsdWei: "1000000000000000000",
    volumeUsdWeiIncludingProtocolActors: "1000000000000000000",
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function Probe({
  afterTimestamp,
  range,
  resultRef,
}: {
  afterTimestamp: number;
  range: "30d" | "90d";
  resultRef: ResultRef;
}) {
  resultRef.current = usePoolVolumeSnapshots({
    enabled: true,
    afterTimestamp,
    range,
    chainIdIn: [42220, 143, 137],
  });
  return null;
}

let container: HTMLDivElement;
let root: Root;
let cache: Cache;
let resultRef: ResultRef;

function render(afterTimestamp: number, range: "30d" | "90d") {
  act(() => {
    root.render(
      <SWRConfig value={{ provider: () => cache, dedupingInterval: 0 }}>
        <Probe
          afterTimestamp={afterTimestamp}
          range={range}
          resultRef={resultRef}
        />
      </SWRConfig>,
    );
  });
}

beforeEach(() => {
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  requestMock.mockReset();
  cache = new Map();
  resultRef = { current: null };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("usePoolVolumeSnapshots", () => {
  it("retains rows and keeps the chart skeleton off across a cutoff-key change", async () => {
    const first = deferred<{ PoolDailyVolumeSnapshot: PoolDailyVolumeRow[] }>();
    const second = deferred<{
      PoolDailyVolumeSnapshot: PoolDailyVolumeRow[];
    }>();
    requestMock
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    render(100, "30d");
    await act(async () => {
      first.resolve({ PoolDailyVolumeSnapshot: [row("1", "100")] });
      await first.promise;
    });
    expect(resultRef.current?.rows.map(({ id }) => id)).toEqual(["1"]);
    expect(resultRef.current?.isLoading).toBe(false);
    expect(resultRef.current?.dataAfterTimestamp).toBe(100);
    expect(resultRef.current?.dataRange).toBe("30d");

    render(200, "90d");

    expect(resultRef.current?.rows.map(({ id }) => id)).toEqual(["1"]);
    expect(resultRef.current?.isLoading).toBe(true);
    expect(resultRef.current?.dataAfterTimestamp).toBe(100);
    expect(resultRef.current?.dataRange).toBe("30d");
    expect(
      resultRef.current!.isLoading && resultRef.current!.rows.length === 0,
    ).toBe(false);

    await act(async () => {
      second.resolve({ PoolDailyVolumeSnapshot: [row("2", "200")] });
      await second.promise;
    });
    expect(resultRef.current?.rows.map(({ id }) => id)).toEqual(["2"]);
    expect(resultRef.current?.isLoading).toBe(false);
    expect(resultRef.current?.dataAfterTimestamp).toBe(200);
    expect(resultRef.current?.dataRange).toBe("90d");
  });
});
