/** @vitest-environment jsdom */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockUseGQL = vi.hoisted(() => vi.fn());

vi.mock("@/lib/graphql", () => ({
  HASURA_TIMEOUT_MS: 5000,
  useGQL: (...args: unknown[]) => mockUseGQL(...args),
}));

import { CDP_TROVE_QUEUE } from "@/lib/queries";
import { CdpTroveQueueSchema, type CdpTroveQueueResponse } from "../queue";
import { useTroveQueue, type TroveQueueState } from "../use-trove-queue";

function queueData(
  overrides: Partial<CdpTroveQueueResponse> = {},
): CdpTroveQueueResponse {
  return {
    LiquityInstance: [{ id: "gbpm", isShutDown: false, shutDownAt: null }],
    OpenTrove: [
      {
        id: "gbpm-0x8abc",
        status: "active",
        debt: "1000",
        interestRate: "0",
        interestBatchId: null,
      },
    ],
    InterestBatch: [],
    ...overrides,
  };
}

let latest: TroveQueueState | null = null;

function Harness({
  collateral,
  troveEntityId,
}: {
  collateral: { id: string } | undefined;
  troveEntityId: string | null;
}) {
  latest = useTroveQueue(collateral, troveEntityId);
  return null;
}

type Handle = { container: HTMLElement; root: Root };

function setup(): Handle {
  const container = document.createElement("div");
  document.body.appendChild(container);
  return { container, root: createRoot(container) };
}

function render(
  handle: Handle,
  collateral: { id: string } | undefined = { id: "gbpm" },
  troveEntityId: string | null = "gbpm-0x8abc",
) {
  act(() => {
    handle.root.render(
      <Harness collateral={collateral} troveEntityId={troveEntityId} />,
    );
  });
}

function mockQueue({
  data,
  error = null,
  isLoading = false,
}: {
  /** `undefined` = never resolved (SWR loading semantics). */
  data?: CdpTroveQueueResponse;
  error?: Error | null;
  isLoading?: boolean;
} = {}) {
  mockUseGQL.mockImplementation((query: string | null) => {
    if (query === CDP_TROVE_QUEUE) {
      return { data, error, isLoading };
    }
    return { data: undefined, error: null, isLoading: false };
  });
}

describe("useTroveQueue", () => {
  let handle: Handle | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    latest = null;
    handle = setup();
  });

  afterEach(() => {
    if (handle) {
      act(() => handle!.root.unmount());
      handle.container.remove();
    }
    handle = null;
  });

  it("fires the ladder query with the collateral id, timeout, and Zod guard", () => {
    mockQueue({ data: queueData() });
    render(handle!);

    const call = mockUseGQL.mock.calls.find(
      ([query]) => query === CDP_TROVE_QUEUE,
    );
    expect(call?.[1]).toEqual({ collateralId: "gbpm" });
    const options = call?.[2] as
      | { timeoutMs?: number; schema?: unknown }
      | undefined;
    expect(options?.timeoutMs).toBe(5000);
    expect(options?.schema).toBe(CdpTroveQueueSchema);
  });

  it("derives the queue model from the response and this trove's entity id", () => {
    mockQueue({ data: queueData() });
    render(handle!);

    expect(latest!.hasLoadedOnce).toBe(true);
    expect(latest!.model?.kind).toBe("ready");
    const model = latest!.model;
    expect(model?.kind === "ready" && model.thisTrove?.position).toBe(1);
  });

  it("disables the fetch without a resolved collateral (unknown market / non-Celo)", () => {
    mockQueue({ data: queueData() });
    render(handle!, undefined, null);

    expect(
      mockUseGQL.mock.calls.some(([query]) => query === CDP_TROVE_QUEUE),
    ).toBe(false);
    expect(mockUseGQL.mock.calls.some(([query]) => query === null)).toBe(true);
    expect(latest!.model).toBeNull();
    expect(latest!.hasLoadedOnce).toBe(false);
  });

  it("keeps loading, first-load error, and confirmed data distinct", () => {
    // Never resolved: model stays null, nothing loaded.
    mockQueue({ isLoading: true });
    render(handle!);
    expect(latest!.model).toBeNull();
    expect(latest!.hasLoadedOnce).toBe(false);
    expect(latest!.isLoading).toBe(true);

    // First-load failure: still nothing confirmed.
    mockQueue({ error: new Error("queue query failed") });
    render(handle!);
    expect(latest!.model).toBeNull();
    expect(latest!.hasLoadedOnce).toBe(false);
    expect(latest!.error?.message).toBe("queue query failed");

    // A poll failure AFTER data resolved keeps the confirmed model
    // alongside the error — the panel's stale-refresh notice needs both.
    mockQueue({
      data: queueData(),
      error: new Error("queue revalidation stalled"),
    });
    render(handle!);
    expect(latest!.model?.kind).toBe("ready");
    expect(latest!.hasLoadedOnce).toBe(true);
    expect(latest!.error?.message).toBe("queue revalidation stalled");
  });
});
