import { encodeFunctionData, parseAbi } from "viem";
import type { BridgeTransfer } from "@/lib/types";

export const CELO_MAINNET_CHAIN_ID = 42220;
export const CELO_MAINNET_CHAIN_ID_HEX = "0xa4ec";
export const CELO_MAINNET_RPC_URL = "https://forno.celo.org";
export const CELO_MAINNET_EXPLORER_URL = "https://celoscan.io";
export const WORMHOLE_CELO_TRANSCEIVER =
  "0x40f8650acd6ca771a822b6d8da71b46b0bde4c1b" as const;

const RECEIVE_MESSAGE_ABI = parseAbi(["function receiveMessage(bytes)"]);

export function canManuallyRedeemTransfer(transfer: BridgeTransfer): boolean {
  if (transfer.provider !== "WORMHOLE") return false;
  if (!transfer.sentTxHash) return false;
  if (transfer.destChainId !== CELO_MAINNET_CHAIN_ID) return false;
  return ![
    "DELIVERED",
    "CANCELLED",
    "FAILED",
  ].includes(transfer.status);
}

export function redeemHelperHref(sentTxHash: string): string {
  return `/bridge-flows/redeem?txHash=${encodeURIComponent(sentTxHash)}`;
}

export function vaaBase64ToHex(vaaBase64: string): `0x${string}` {
  const bytes =
    typeof window === "undefined"
      ? Buffer.from(vaaBase64, "base64")
      : Uint8Array.from(atob(vaaBase64), (char) => char.charCodeAt(0));
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function buildReceiveMessageCalldata(vaaHex: `0x${string}`): `0x${string}` {
  return encodeFunctionData({
    abi: RECEIVE_MESSAGE_ABI,
    functionName: "receiveMessage",
    args: [vaaHex],
  });
}

export type BridgeRedeemPayload = {
  txHash: string;
  chainId: number;
  chainIdHex: string;
  chainName: string;
  rpcUrl: string;
  explorerUrl: string;
  transceiver: string;
  vaaHex: `0x${string}`;
  calldata: `0x${string}`;
};
