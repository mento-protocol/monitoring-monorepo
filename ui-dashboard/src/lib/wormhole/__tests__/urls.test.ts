import { describe, it, expect } from "vitest";
import { wormholescanUrl } from "../urls";

describe("wormholescanUrl", () => {
  it("builds a Wormholescan tx-trace URL keyed on the source-chain tx hash", () => {
    // Wormholescan resolves by source tx hash (verified via
    // api.wormholescan.io), not by NTT digest. Callers must pass
    // sentTxHash, not providerMessageId.
    expect(
      wormholescanUrl(
        "0xf1da2959c06252dae3dfe3858a3366ef4d9453fa7013f1b53ffbe89270d9a8f1",
      ),
    ).toBe(
      "https://wormholescan.io/#/tx/0xf1da2959c06252dae3dfe3858a3366ef4d9453fa7013f1b53ffbe89270d9a8f1",
    );
  });
});
