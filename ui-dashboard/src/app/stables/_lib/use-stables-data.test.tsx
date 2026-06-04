import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { STABLES_CHANGES } from "@/lib/queries/stables";
import type { StableSupplyChangeEvent } from "./types";

const mockUseGQL = vi.hoisted(() => vi.fn());

vi.mock("@/lib/graphql", () => ({
  useGQL: (...args: unknown[]) => mockUseGQL(...args),
}));

import { useStablesChanges } from "./use-stables-data";

type ChangesResult = ReturnType<typeof useStablesChanges>;
type GqlCall = [string | null, Record<string, unknown> | undefined];

function changeEvent(
  overrides: Partial<StableSupplyChangeEvent> &
    Pick<StableSupplyChangeEvent, "id" | "amount">,
): StableSupplyChangeEvent {
  return {
    id: overrides.id,
    chainId: overrides.chainId ?? 42220,
    tokenAddress: overrides.tokenAddress ?? "0xusd",
    tokenSymbol: overrides.tokenSymbol ?? "USDm",
    tokenDecimals: overrides.tokenDecimals ?? 18,
    source: overrides.source ?? "RESERVE",
    kind: overrides.kind ?? "RESERVE_MINT",
    counterparty: overrides.counterparty ?? "0xcounterparty",
    caller: overrides.caller ?? "0xcaller",
    txTo: overrides.txTo ?? "0xto",
    isSystemCaller: overrides.isSystemCaller ?? false,
    amount: overrides.amount,
    txHash: overrides.txHash ?? `0x${overrides.id}`,
    blockNumber: overrides.blockNumber ?? "123",
    blockTimestamp: overrides.blockTimestamp ?? "1780617600",
  };
}

function renderHook(page = 0): ChangesResult {
  const ref: { current: ChangesResult | null } = { current: null };

  function HookProbe(): null {
    ref.current = useStablesChanges("7d", page);
    return null;
  }

  renderToStaticMarkup(<HookProbe />);

  if (ref.current == null) {
    throw new Error("useStablesChanges did not render");
  }
  return ref.current;
}

describe("useStablesChanges", () => {
  beforeEach(() => {
    mockUseGQL.mockReset();
    mockUseGQL.mockImplementation(() => ({
      data: { StableSupplyChangeEvent: [] },
      error: null,
      isLoading: false,
    }));
  });

  it("queries a larger raw page and hides rows below table display precision", () => {
    mockUseGQL.mockImplementation((query: string | null) => ({
      data:
        query === null
          ? undefined
          : {
              StableSupplyChangeEvent: [
                changeEvent({
                  id: "dust",
                  amount: "9999999999999999",
                }),
                changeEvent({
                  id: "visible-mint",
                  amount: "10000000000000000",
                }),
                changeEvent({
                  id: "visible-burn",
                  amount: "-10000000000000000",
                  kind: "RESERVE_BURN",
                }),
              ],
            },
      error: null,
      isLoading: false,
    }));

    const result = renderHook();

    expect(mockUseGQL).toHaveBeenCalledWith(
      STABLES_CHANGES,
      expect.objectContaining({
        chainIds: [42220, 143],
        limit: 400,
        offset: 0,
        sinceTimestamp: expect.any(Number),
      }),
    );
    expect(result.events.map((event) => event.id)).toEqual([
      "visible-mint",
      "visible-burn",
    ]);
    expect(result.capped).toBe(false);
  });

  it("continues fetching raw pages until enough visible rows are available", () => {
    mockUseGQL.mockImplementation((query: string | null, variables) => {
      if (query === null) {
        return {
          data: undefined,
          error: null,
          isLoading: false,
        };
      }
      const offset = (variables as { offset: number }).offset;
      return {
        data: {
          StableSupplyChangeEvent:
            offset === 0
              ? Array.from({ length: 400 }, (_, index) =>
                  changeEvent({
                    id: `dust-${index}`,
                    amount: "1",
                  }),
                )
              : Array.from({ length: 201 }, (_, index) =>
                  changeEvent({
                    id: `visible-${index}`,
                    amount: "10000000000000000",
                  }),
                ),
        },
        error: null,
        isLoading: false,
      };
    });

    const result = renderHook();

    const gqlCalls = mockUseGQL.mock.calls as GqlCall[];
    expect(gqlCalls).toEqual(
      expect.arrayContaining([
        [
          STABLES_CHANGES,
          expect.objectContaining({
            limit: 400,
            offset: 0,
          }),
        ],
        [
          STABLES_CHANGES,
          expect.objectContaining({
            limit: 400,
            offset: 400,
          }),
        ],
      ]),
    );
    expect(result.events).toHaveLength(200);
    expect(result.events[0]?.id).toBe("visible-0");
    expect(result.capped).toBe(true);
  });

  it("keeps the capped warning when the max fetched raw pages may hide older rows", () => {
    mockUseGQL.mockImplementation((query: string | null) => ({
      data:
        query === null
          ? undefined
          : {
              StableSupplyChangeEvent: Array.from({ length: 400 }, (_, index) =>
                changeEvent({
                  id: `dust-${index}`,
                  amount: "1",
                }),
              ),
            },
      error: null,
      isLoading: false,
    }));

    const result = renderHook(1);

    expect(mockUseGQL).toHaveBeenCalledWith(
      STABLES_CHANGES,
      expect.objectContaining({
        limit: 400,
        offset: 1_200,
      }),
    );
    expect(result.events).toEqual([]);
    expect(result.capped).toBe(true);
  });

  it("keeps visible rows when a follow-up page fails", () => {
    const followUpError = new Error("second page unavailable");
    mockUseGQL.mockImplementation((query: string | null, variables) => {
      if (query === null) {
        return {
          data: undefined,
          error: null,
          isLoading: false,
        };
      }
      const offset = (variables as { offset: number }).offset;
      if (offset === 400) {
        return {
          data: undefined,
          error: followUpError,
          isLoading: false,
        };
      }
      return {
        data: {
          StableSupplyChangeEvent: [
            changeEvent({
              id: "visible-first-page",
              amount: "10000000000000000",
            }),
            ...Array.from({ length: 399 }, (_, index) =>
              changeEvent({
                id: `dust-${index}`,
                amount: "1",
              }),
            ),
          ],
        },
        error: null,
        isLoading: false,
      };
    });

    const result = renderHook();

    expect(result.events.map((event) => event.id)).toEqual([
      "visible-first-page",
    ]);
    expect(result.error).toBeNull();
    expect(result.capped).toBe(true);
  });
});
