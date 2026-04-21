import { describe, expect, it } from "vitest";
import {
  buildReceiveMessageCalldata,
  canManuallyRedeemTransfer,
  redeemHelperHref,
  vaaBase64ToHex,
} from "@/lib/bridge-flows/redeem";
import type { BridgeTransfer } from "@/lib/types";

function makeTransfer(overrides: Partial<BridgeTransfer> = {}): BridgeTransfer {
  return {
    id: "wormhole-1",
    provider: "WORMHOLE",
    providerMessageId: "0x1",
    status: "SENT",
    tokenSymbol: "USDm",
    tokenAddress: "0x1",
    tokenDecimals: 18,
    sourceChainId: 143,
    sourceContract: null,
    destChainId: 42220,
    destContract: null,
    sender: "0xabc",
    recipient: "0xdef",
    amount: "1",
    sentBlock: null,
    sentTimestamp: "1",
    sentTxHash:
      "0xafcd83c3b46adf004aa602ac8cb8ef2b14a25eae5802c0cd2b4c42b75cb26799",
    attestationCount: 0,
    firstAttestedTimestamp: null,
    lastAttestedTimestamp: null,
    deliveredBlock: null,
    deliveredTimestamp: null,
    deliveredTxHash: null,
    cancelledTimestamp: null,
    failedReason: null,
    usdPriceAtSend: null,
    usdValueAtSend: null,
    firstSeenAt: "1",
    lastUpdatedAt: "1",
    ...overrides,
  };
}

describe("bridge redeem helpers", () => {
  it("flags in-flight Wormhole transfers to Celo as manually redeemable", () => {
    expect(canManuallyRedeemTransfer(makeTransfer())).toBe(true);
    expect(
      canManuallyRedeemTransfer(makeTransfer({ status: "DELIVERED" })),
    ).toBe(false);
    expect(
      canManuallyRedeemTransfer(makeTransfer({ destChainId: 143 })),
    ).toBe(false);
  });

  it("builds a helper href with the source tx hash", () => {
    expect(
      redeemHelperHref(
        "0xafcd83c3b46adf004aa602ac8cb8ef2b14a25eae5802c0cd2b4c42b75cb26799",
      ),
    ).toContain("txHash=0xafcd83c3b46adf004aa602ac8cb8ef2b14a25eae5802c0cd2b4c42b75cb26799");
  });

  it("decodes a base64 VAA into calldata for receiveMessage(bytes)", () => {
    const vaaHex = vaaBase64ToHex("AQID");
    expect(vaaHex).toBe("0x010203");
    const calldata = buildReceiveMessageCalldata(vaaHex);
    expect(calldata.startsWith("0xf953cec7")).toBe(true);
  });
});
