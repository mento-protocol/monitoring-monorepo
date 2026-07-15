/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SWRConfig, type Cache, type SWRResponse } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { requestMock } = vi.hoisted(() => ({
  requestMock: vi.fn(),
}));

vi.mock("graphql-request", () => ({
  GraphQLClient: vi.fn(function GraphQLClientMock() {
    return { request: requestMock };
  }),
}));

vi.mock("@/components/network-provider", () => ({
  useNetwork: () => ({
    networkId: "celo-mainnet",
    network: {
      id: "celo-mainnet",
      label: "Celo",
      chainId: 42220,
      hasuraUrl: "https://hasura.example/v1/graphql",
    },
  }),
}));

import { useGQL } from "@/lib/graphql";

type Payload = { value: string };
type ResultRef = { current: SWRResponse<Payload> | null };

const QUERY = "query Window($range: String!) { value(range: $range) }";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function Probe({
  range,
  resultRef,
  keepPreviousData,
}: {
  range: string;
  resultRef: ResultRef;
  keepPreviousData?: boolean | undefined;
}) {
  resultRef.current = useGQL<Payload>(
    QUERY,
    { range },
    {
      refreshInterval: 0,
      ...(keepPreviousData !== undefined && { keepPreviousData }),
    },
  );
  return null;
}

let container: HTMLDivElement;
let root: Root;
let cache: Cache;
let resultRef: ResultRef;

function render(range: string, keepPreviousData?: boolean) {
  act(() => {
    root.render(
      <SWRConfig
        value={{
          provider: () => cache,
          dedupingInterval: 0,
        }}
      >
        <Probe
          range={range}
          resultRef={resultRef}
          keepPreviousData={keepPreviousData}
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

describe("useGQL keepPreviousData", () => {
  it("retains the prior key's data while the next key is loading", async () => {
    const first = deferred<Payload>();
    const second = deferred<Payload>();
    requestMock
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    render("7d", true);
    await act(async () => {
      first.resolve({ value: "7d data" });
      await first.promise;
      await vi.waitFor(() => {
        expect(resultRef.current?.data).toEqual({ value: "7d data" });
      });
    });
    expect(resultRef.current?.data).toEqual({ value: "7d data" });
    expect(resultRef.current?.isLoading).toBe(false);

    render("30d", true);

    expect(resultRef.current?.data).toEqual({ value: "7d data" });
    expect(resultRef.current?.isLoading).toBe(true);
    expect(requestMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      second.resolve({ value: "30d data" });
      await second.promise;
      await vi.waitFor(() => {
        expect(resultRef.current?.data).toEqual({ value: "30d data" });
      });
    });
    expect(resultRef.current?.data).toEqual({ value: "30d data" });
    expect(resultRef.current?.isLoading).toBe(false);
  });

  it("preserves SWR's default empty transition when the option is omitted", async () => {
    const first = deferred<Payload>();
    const second = deferred<Payload>();
    requestMock
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    render("7d");
    await act(async () => {
      first.resolve({ value: "7d data" });
      await first.promise;
      await vi.waitFor(() => {
        expect(resultRef.current?.data).toEqual({ value: "7d data" });
      });
    });
    expect(resultRef.current?.data).toEqual({ value: "7d data" });

    render("30d");

    expect(resultRef.current?.data).toBeUndefined();
    expect(resultRef.current?.isLoading).toBe(true);
  });
});
