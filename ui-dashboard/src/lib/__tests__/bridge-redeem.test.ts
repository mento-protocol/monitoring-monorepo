import { describe, expect, it } from "vitest";
import {
  buildReceiveMessageCalldata,
  canManuallyRedeemTransfer,
  getTransceiverForToken,
  vaaBase64ToHex,
} from "@/lib/bridge-flows/redeem";
import type { BridgeTransfer } from "@/lib/types";
import nttManifest from "../../../../indexer-envio/config/nttAddresses.json";

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
  });

  it("flags in-flight Wormhole transfers to Monad as manually redeemable", () => {
    expect(
      canManuallyRedeemTransfer(
        makeTransfer({ sourceChainId: 42220, destChainId: 143 }),
      ),
    ).toBe(true);
  });

  it("rejects transfers to unsupported destination chains", () => {
    expect(canManuallyRedeemTransfer(makeTransfer({ destChainId: 999 }))).toBe(
      false,
    );
  });

  it("rejects transfers with a null destChainId", () => {
    expect(canManuallyRedeemTransfer(makeTransfer({ destChainId: null }))).toBe(
      false,
    );
  });

  it("rejects transfers without a sentTxHash", () => {
    expect(canManuallyRedeemTransfer(makeTransfer({ sentTxHash: null }))).toBe(
      false,
    );
  });

  it("rejects transfers with an unknown token symbol", () => {
    expect(
      canManuallyRedeemTransfer(makeTransfer({ tokenSymbol: "UNKNOWN" })),
    ).toBe(false);
  });

  it("rejects CANCELLED transfers", () => {
    expect(
      canManuallyRedeemTransfer(makeTransfer({ status: "CANCELLED" })),
    ).toBe(false);
  });

  it("rejects FAILED transfers", () => {
    expect(canManuallyRedeemTransfer(makeTransfer({ status: "FAILED" }))).toBe(
      false,
    );
  });

  it("rejects QUEUED_INBOUND transfers (already received at transceiver)", () => {
    expect(
      canManuallyRedeemTransfer(makeTransfer({ status: "QUEUED_INBOUND" })),
    ).toBe(false);
  });

  it("decodes a base64 VAA into calldata for receiveMessage(bytes)", () => {
    const vaaHex = vaaBase64ToHex("AQID");
    expect(vaaHex).toBe("0x010203");
    const calldata = buildReceiveMessageCalldata(vaaHex);
    expect(calldata.slice(0, 10)).toBe("0xf953cec7");
  });

  it("decodes an empty base64 string to an empty hex payload", () => {
    expect(vaaBase64ToHex("")).toBe("0x");
  });
});

// Cross-layer invariant: dashboard's contracts.json-derived transceiver
// addresses must match the indexer's generated nttAddresses.json manifest
// for every (chainId, tokenSymbol). Drift here means the manual-redeem
// button submits transactions to the wrong transceiver address.
describe("getTransceiverForToken — manifest sync", () => {
  for (const entry of nttManifest.entries) {
    it(`matches manifest for ${entry.tokenSymbol} on chain ${entry.chainId}`, () => {
      expect(getTransceiverForToken(entry.chainId, entry.tokenSymbol)).toBe(
        entry.transceiverProxy.toLowerCase(),
      );
    });
  }
});

describe("canManuallyRedeemTransfer — coverage for every bridged token", () => {
  for (const entry of nttManifest.entries) {
    it(`accepts in-flight ${entry.tokenSymbol} transfer to chain ${entry.chainId}`, () => {
      const sourceChainId = entry.chainId === 42220 ? 143 : 42220;
      expect(
        canManuallyRedeemTransfer(
          makeTransfer({
            tokenSymbol: entry.tokenSymbol,
            sourceChainId,
            destChainId: entry.chainId,
          }),
        ),
      ).toBe(true);
    });
  }
});
