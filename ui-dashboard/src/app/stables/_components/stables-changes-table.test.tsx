import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StablesChangesTable } from "./stables-changes-table";

describe("StablesChangesTable", () => {
  it("explains the display threshold in the empty capped state", () => {
    const html = renderToStaticMarkup(
      <StablesChangesTable
        events={[]}
        minimumUsdValue={0.01}
        onMinimumUsdValueChange={() => undefined}
        onMinimumUsdValueReset={() => undefined}
        isLoading={false}
        hasError={false}
        capped={true}
        unpricedEventsCount={0}
      />,
    );

    expect(html).toContain("No supply changes at or above");
    expect(html).toContain("$0.01 equivalent");
    expect(html).toContain("the most recent fetched rows");
    expect(html).toContain("Minimum USD-equivalent supply change");
  });

  it("surfaces unpriced visible rows in the header", () => {
    const html = renderToStaticMarkup(
      <StablesChangesTable
        events={[
          {
            id: "change-1",
            chainId: 42220,
            tokenAddress: "0xusd",
            tokenSymbol: "USDm",
            tokenDecimals: 18,
            source: "RESERVE",
            kind: "RESERVE_MINT",
            counterparty: "0xcounterparty",
            caller: "0xcaller",
            txTo: "0xto",
            isSystemCaller: true,
            amount: "1000000000000000000",
            txHash: "0xtx",
            blockNumber: "1",
            blockTimestamp: "1780617600",
          },
        ]}
        minimumUsdValue={1}
        onMinimumUsdValueChange={() => undefined}
        onMinimumUsdValueReset={() => undefined}
        isLoading={false}
        hasError={false}
        capped={false}
        unpricedEventsCount={1}
      />,
    );

    expect(html).toContain("Hiding changes below $1.00 equivalent");
    expect(html).toContain("Keeping 1 unpriced event visible");
  });
});
