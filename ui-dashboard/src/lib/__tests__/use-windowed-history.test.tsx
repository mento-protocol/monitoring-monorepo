/** @vitest-environment jsdom */

/* eslint-disable @typescript-eslint/no-explicit-any */

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Orchestration tests for `useWindowedHistory` — the live-head ⊕ frozen-older
 * keyset machine. Pattern: jsdom + react-dom/client + act + a Probe that
 * exposes the hook return via a ref (same convention as
 * `_lib/__tests__/use-hero-rollup.test.tsx`). No @testing-library/react.
 *
 * The load-bearing invariants under test: older pages are fetched once and
 * never re-polled; the head poll never triggers an older fetch; a failed page
 * keeps rendered rows and retries the same cursor; resetKey drops everything.
 */

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }));

vi.mock("graphql-request", () => ({
  GraphQLClient: vi.fn(function GraphQLClient() {
    return { request: requestMock };
  }),
}));

let headResponse: { data: unknown; error?: unknown; isLoading: boolean };
let lastHeadVariables: Record<string, unknown> | undefined;
vi.mock("@/lib/graphql", () => ({
  useGQL: (query: string | null, variables?: Record<string, unknown>) => {
    if (query === null) {
      return { data: undefined, error: undefined, isLoading: false };
    }
    lastHeadVariables = variables;
    return headResponse;
  },
}));

vi.mock("@/components/network-provider", () => ({
  useNetwork: () => ({
    network: {
      id: "celo-mainnet",
      hasuraUrl: "https://hasura.test",
      label: "Celo",
    },
  }),
}));

import { useWindowedHistory } from "../use-windowed-history";

type Row = { id: string; timestamp: string; value: number };
const row = (ts: number, value = ts): Row => ({
  id: `r-${ts}`,
  timestamp: String(ts),
  value,
});
const selectRows = (d: unknown): Row[] =>
  (d as { OracleSnapshot?: Row[] }).OracleSnapshot ?? [];
const headOf = (...tsDesc: number[]) => ({
  data: { OracleSnapshot: tsDesc.map((t) => row(t)) },
  error: undefined,
  isLoading: false,
});

type HookResult = ReturnType<typeof useWindowedHistory<Row>>;

function Probe({
  resultRef,
  resetKey,
}: {
  resultRef: { current: HookResult | null };
  resetKey: string;
}) {
  resultRef.current = useWindowedHistory<Row>({
    query: "ORACLE_QUERY",
    variables: { poolId: "pool-1" },
    selectRows,
    resetKey,
    pageSize: 3,
    maxPages: 2,
  });
  return null;
}

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  requestMock.mockReset();
  headResponse = { data: undefined, error: undefined, isLoading: true };
  lastHeadVariables = undefined;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(resetKey = "celo-mainnet:pool-1"): {
  ref: { current: HookResult | null };
  rerender: (key?: string) => void;
} {
  const ref: { current: HookResult | null } = { current: null };
  const rerender = (key = resetKey) =>
    act(() => root.render(<Probe resultRef={ref} resetKey={key} />));
  rerender();
  return { ref, rerender };
}

// Flush pending fetches + React effects (incl. the continuation effect).
async function settle() {
  for (let i = 0; i < 8; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

const tsOf = (r: HookResult | null) =>
  (r?.rows ?? []).map((x) => Number(x.timestamp));

describe("useWindowedHistory", () => {
  it("seeds from the live head, sorted ASC, with the far-future head cursor", async () => {
    headResponse = headOf(102, 101, 100);
    const { ref } = render();
    await settle();
    expect(tsOf(ref.current)).toEqual([100, 101, 102]);
    expect(ref.current!.oldestLoadedTs).toBe(100);
    expect(lastHeadVariables).toMatchObject({
      limit: 3,
      beforeTimestamp: "9999999999",
    });
    expect(requestMock).not.toHaveBeenCalled(); // head is via useGQL, not the manual client
  });

  it("pages one older window from the oldest-loaded cursor and merges ASC", async () => {
    headResponse = headOf(102, 101, 100);
    requestMock.mockResolvedValue({
      OracleSnapshot: [row(99), row(98), row(97)],
    });
    const { ref } = render();
    await settle();

    await act(async () => {
      ref.current!.ensureLoadedBefore(98);
    });
    await settle();

    expect(tsOf(ref.current)).toEqual([97, 98, 99, 100, 101, 102]);
    expect(requestMock).toHaveBeenCalledTimes(1);
    // Cursor is the oldest currently-loaded timestamp (oldest of the head).
    expect(requestMock.mock.calls[0]![0].variables.beforeTimestamp).toBe("100");
  });

  it("dedupes by id (no duplicate rows across head/older overlap)", async () => {
    headResponse = headOf(102, 101, 100);
    // Artificial overlap: older page repeats r-100 (keyset normally excludes it).
    requestMock.mockResolvedValue({ OracleSnapshot: [row(100), row(99)] });
    const { ref } = render();
    await settle();
    await act(async () => ref.current!.ensureLoadedBefore(99));
    await settle();

    const ids = (ref.current!.rows ?? []).map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length); // no dupes
    expect(tsOf(ref.current)).toEqual([99, 100, 101, 102]);
  });

  it("is a no-op when the target is already covered", async () => {
    headResponse = headOf(102, 101, 100);
    const { ref } = render();
    await settle();
    await act(async () => ref.current!.ensureLoadedBefore(100)); // == oldest
    await settle();
    expect(requestMock).not.toHaveBeenCalled();
  });

  it("is single-flight: two synchronous requests issue one fetch", async () => {
    headResponse = headOf(102, 101, 100);
    requestMock.mockResolvedValue({
      OracleSnapshot: [row(99), row(98), row(97)],
    });
    const { ref } = render();
    await settle();
    await act(async () => {
      ref.current!.ensureLoadedBefore(98);
      ref.current!.ensureLoadedBefore(98);
    });
    await settle();
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it("marks reachedStart on a short page and stops fetching", async () => {
    headResponse = headOf(102, 101, 100);
    requestMock.mockResolvedValue({ OracleSnapshot: [row(99)] }); // < pageSize
    const { ref } = render();
    await settle();
    await act(async () => ref.current!.ensureLoadedBefore(0));
    await settle();

    expect(ref.current!.reachedStart).toBe(true);
    expect(requestMock).toHaveBeenCalledTimes(1);

    // Further requests are no-ops.
    await act(async () => ref.current!.ensureLoadedBefore(0));
    await settle();
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it("continues paging to a deep target, then caps at maxPages", async () => {
    headResponse = headOf(102, 101, 100);
    // Always-full pages → never reachedStart; the cap (2) must stop it.
    let cursor = 100;
    requestMock.mockImplementation(() => {
      const batch = [row(cursor - 1), row(cursor - 2), row(cursor - 3)];
      cursor -= 3;
      return Promise.resolve({ OracleSnapshot: batch });
    });
    const { ref } = render();
    await settle();
    await act(async () => ref.current!.ensureLoadedBefore(-1_000_000)); // very deep
    await settle();

    expect(requestMock).toHaveBeenCalledTimes(2); // maxPages
    expect(ref.current!.capped).toBe(true);
    expect(ref.current!.reachedStart).toBe(false);
  });

  it("does not re-fetch older pages when the head re-polls", async () => {
    headResponse = headOf(102, 101, 100);
    requestMock.mockResolvedValue({
      OracleSnapshot: [row(99), row(98), row(97)],
    });
    const { ref, rerender } = render();
    await settle();
    await act(async () => ref.current!.ensureLoadedBefore(98));
    await settle();
    expect(requestMock).toHaveBeenCalledTimes(1);

    // Simulate a 30s poll bringing a new newest row.
    headResponse = headOf(103, 102, 101);
    rerender();
    await settle();

    expect(requestMock).toHaveBeenCalledTimes(1); // history NOT re-fetched
    // New head row merged in; older frozen rows still present.
    expect(tsOf(ref.current)).toEqual([97, 98, 99, 100, 101, 102, 103]);
  });

  it("keeps rendered rows on an older-page error and retries the same cursor", async () => {
    headResponse = headOf(102, 101, 100);
    requestMock.mockRejectedValueOnce(new Error("boom"));
    const { ref } = render();
    await settle();
    await act(async () => ref.current!.ensureLoadedBefore(98));
    await settle();

    expect(ref.current!.olderError).toBeInstanceOf(Error);
    expect(tsOf(ref.current)).toEqual([100, 101, 102]); // head still rendered

    // Retry succeeds — same cursor (the failed page didn't advance it).
    requestMock.mockResolvedValueOnce({
      OracleSnapshot: [row(99), row(98), row(97)],
    });
    await act(async () => ref.current!.ensureLoadedBefore(98));
    await settle();

    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(requestMock.mock.calls[1]![0].variables.beforeTimestamp).toBe("100");
    expect(ref.current!.olderError).toBeUndefined();
    expect(tsOf(ref.current)).toEqual([97, 98, 99, 100, 101, 102]);
  });

  it("drops all frozen pages when resetKey changes", async () => {
    headResponse = headOf(102, 101, 100);
    requestMock.mockResolvedValue({
      OracleSnapshot: [row(99), row(98), row(97)],
    });
    const { ref, rerender } = render();
    await settle();
    await act(async () => ref.current!.ensureLoadedBefore(98));
    await settle();
    expect(tsOf(ref.current)).toHaveLength(6);

    // Switch pools: new resetKey + new head; frozen older pages must drop.
    headResponse = headOf(202, 201, 200);
    rerender("celo-mainnet:pool-2");
    await settle();

    expect(tsOf(ref.current)).toEqual([200, 201, 202]);
    expect(ref.current!.reachedStart).toBe(false);
    expect(ref.current!.capped).toBe(false);
  });
});
