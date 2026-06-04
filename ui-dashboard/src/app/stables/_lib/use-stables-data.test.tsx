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
    mockUseGQL.mockReturnValue({
      data: { StableSupplyChangeEvent: [] },
      error: null,
      isLoading: false,
    });
  });

  it("queries a larger raw page and hides rows below table display precision", () => {
    mockUseGQL.mockReturnValue({
      data: {
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
    });

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

  it("keeps the capped warning when the fetched raw page may hide older rows", () => {
    mockUseGQL.mockReturnValue({
      data: {
        StableSupplyChangeEvent: Array.from({ length: 400 }, (_, index) =>
          changeEvent({
            id: `dust-${index}`,
            amount: "1",
          }),
        ),
      },
      error: null,
      isLoading: false,
    });

    const result = renderHook(1);

    expect(mockUseGQL).toHaveBeenCalledWith(
      STABLES_CHANGES,
      expect.objectContaining({
        limit: 400,
        offset: 400,
      }),
    );
    expect(result.events).toEqual([]);
    expect(result.capped).toBe(true);
  });
});
