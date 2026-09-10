/** @vitest-environment jsdom */
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
function renderHook<T, P = undefined>(
  hook: (props: P) => T,
  options?: { initialProps: P },
) {
  const container = document.createElement("div");
  const root = createRoot(container);
  const result = {} as { current: T };
  function Probe({ value }: { value: P }) {
    result.current = hook(value);
    return null;
  }
  const rerender = (props: P) =>
    act(() => root.render(createElement(Probe, { value: props })));
  rerender(options?.initialProps as P);
  cleanups.push(() => act(() => root.unmount()));
  return { result, rerender };
}
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CDP_TROVE_OPERATIONS,
  CDP_TROVE_OPERATIONS_NUMERIC,
} from "@/lib/queries";
import { useTroveOperations } from "../use-trove-operations";

const { useGQL } = vi.hoisted(() => ({ useGQL: vi.fn() }));
vi.mock("@/lib/graphql", () => ({ HASURA_TIMEOUT_MS: 10_000, useGQL }));
const numeric = {
  data: { TroveOperationEventType: { fields: [{ name: "logIndex" }] } },
};
const legacy = {
  data: { TroveOperationEventType: { fields: [{ name: "id" }] } },
};
const empty = { TroveOperationEvent: [] };
beforeEach(() =>
  useGQL.mockReset().mockReturnValue({ data: undefined, isLoading: true }),
);

describe("interim operation query transitions", () => {
  it.each([
    {},
    legacy,
    { data: { TroveOperationEventType: null } },
    { ...numeric, error: new Error("probe failed") },
  ])(
    "uses a supported legacy query while capability is absent, pending or failed",
    (schema) => {
      const { result } = renderHook(() =>
        useTroveOperations("instance", "0x1", true, schema),
      );
      expect(useGQL).toHaveBeenLastCalledWith(
        CDP_TROVE_OPERATIONS,
        { instanceId: "instance", troveId: "0x1", limit: 1000 },
        { timeoutMs: 10_000 },
      );
      expect(result.current.orderingNotice).toMatch(
        /may omit newer operations/,
      );
    },
  );
  it("uses numeric server ordering only with confirmed support", () => {
    useGQL.mockReturnValue({ data: empty, isLoading: false });
    const { result } = renderHook(() =>
      useTroveOperations("instance", "0x1", true, numeric),
    );
    expect(useGQL.mock.lastCall?.[0]).toBe(CDP_TROVE_OPERATIONS_NUMERIC);
    expect(result.current.orderingNotice).toBeNull();
  });
  it("retains legacy rows and their warning during upgrade; preserves new query errors", () => {
    useGQL.mockReturnValue({ data: empty, isLoading: false });
    const { result, rerender } = renderHook(
      ({ schema }) => useTroveOperations("instance", "0x1", true, schema),
      { initialProps: { schema: legacy } },
    );
    useGQL.mockReturnValue({ data: undefined, isLoading: true });
    rerender({ schema: numeric });
    expect(result.current.data).toBe(empty);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.orderingNotice).toMatch(/may omit/);
    const error = new Error("query failed");
    useGQL.mockReturnValue({ data: undefined, isLoading: false, error });
    rerender({ schema: numeric });
    expect(result.current.error).toBe(error);
    expect(result.current.data).toBe(empty);
    useGQL.mockReturnValue({
      data: { TroveOperationEvent: [] },
      isLoading: false,
    });
    rerender({ schema: numeric });
    expect(result.current.orderingNotice).toBeNull();
  });
  it("switches back to the legacy query on rollback or failed re-probe", () => {
    useGQL.mockReturnValue({ data: empty, isLoading: false });
    const { result, rerender } = renderHook(
      ({ schema }) => useTroveOperations("instance", "0x1", true, schema),
      {
        initialProps: {
          schema: numeric as { data: typeof numeric.data; error?: Error },
        },
      },
    );
    useGQL.mockReturnValue({ data: undefined, isLoading: true });
    rerender({ schema: legacy });
    expect(useGQL.mock.lastCall?.[0]).toBe(CDP_TROVE_OPERATIONS);
    expect(result.current.data).toBe(empty);
    rerender({ schema: { ...numeric, error: new Error("probe") } });
    expect(useGQL.mock.lastCall?.[0]).toBe(CDP_TROVE_OPERATIONS);
    expect(result.current.orderingNotice).toMatch(/could not be checked/);
  });
  it("does not retain another trove's response", () => {
    useGQL.mockReturnValue({ data: empty, isLoading: false });
    const { result, rerender } = renderHook(
      ({ id }) => useTroveOperations("instance", id, true, legacy),
      { initialProps: { id: "0x1" } },
    );
    useGQL.mockReturnValue({ data: undefined, isLoading: true });
    rerender({ id: "0x2" });
    expect(result.current.data).toBeUndefined();
    expect(result.current.isLoading).toBe(true);
  });
  it("disables operations polling during complete-ledger handoff", () => {
    const { rerender } = renderHook(
      ({ enabled }) => useTroveOperations("instance", "0x1", enabled, numeric),
      { initialProps: { enabled: true } },
    );
    rerender({ enabled: false });
    expect(useGQL).toHaveBeenLastCalledWith(null, undefined, {
      timeoutMs: 10_000,
    });
  });
});
