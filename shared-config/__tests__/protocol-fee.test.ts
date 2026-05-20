import { describe, it, expect } from "vitest";
import { PROTOCOL_FEE_RECIPIENT_ADDRESS } from "../src/protocol-fee";
import contractsData from "@mento-protocol/contracts/contracts.json" with { type: "json" };

describe("PROTOCOL_FEE_RECIPIENT_ADDRESS", () => {
  it("is a lowercase 0x-prefixed 20-byte address", () => {
    expect(PROTOCOL_FEE_RECIPIENT_ADDRESS).toMatch(/^0x[0-9a-f]{40}$/);
  });

  it("matches the YieldSplitAddress entry on Celo mainnet", () => {
    // Same address across chains by Mento's deterministic-deploy convention;
    // the package publishes it as YieldSplitAddress on Celo mainnet only —
    // that's our canonical source. If this assertion breaks, either the
    // upstream package renamed the key or redeployed the recipient.
    const onChain = (
      contractsData as Record<
        string,
        Record<string, Record<string, { address: string }>>
      >
    )["42220"].mainnet.YieldSplitAddress.address.toLowerCase();
    expect(PROTOCOL_FEE_RECIPIENT_ADDRESS).toBe(onChain);
  });
});
