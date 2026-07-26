import { describe, expect, it } from "vitest";
import { combinedTooltip } from "../pool-table-utils";
import type { Network } from "../networks";
import type { Pool } from "../types";

const network = { chainId: 42220 } as Network;

const pool = {
  id: "42220:0xpool",
  source: "fpmm_factory",
} as Pool;

describe("combinedTooltip", () => {
  it("does not describe unresolved FPMM health as a VirtualPool", () => {
    expect(combinedTooltip("N/A", "OK", pool, network, null)).toBe(
      "Health status pending live browser time",
    );
  });

  it("keeps the VirtualPool explanation for VirtualPool N/A", () => {
    expect(
      combinedTooltip(
        "N/A",
        "OK",
        { ...pool, source: "virtual_pool_factory" },
        network,
        null,
      ),
    ).toBe("VirtualPool — oracle health not tracked");
  });
});
