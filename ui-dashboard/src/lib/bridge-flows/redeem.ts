import { encodeFunctionData, parseAbi } from "viem";
import type { BridgeTransfer } from "@/lib/types";

export type ChainRedeemConfig = {
  chainId: number;
  chainIdHex: string;
  chainName: string;
  rpcUrl: string;
  explorerUrl: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
};

const CHAIN_CONFIGS: Record<number, ChainRedeemConfig> = {
  42220: {
    chainId: 42220,
    chainIdHex: "0xa4ec",
    chainName: "Celo",
    rpcUrl: "https://forno.celo.org",
    explorerUrl: "https://celoscan.io",
    nativeCurrency: { name: "CELO", symbol: "CELO", decimals: 18 },
  },
  143: {
    chainId: 143,
    chainIdHex: "0x8f",
    chainName: "Monad",
    rpcUrl: "https://rpc2.monad.xyz",
    explorerUrl: "https://monadscan.com",
    nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  },
};

const TRANSCEIVER_BY_TOKEN: Record<string, `0x${string}`> = {
  USDm: "0x40f8650acd6ca771a822b6d8da71b46b0bde4c1b",
  EURm: "0x6467cfca82184657f32f1195f9a26b5578399479",
  GBPm: "0xcb55fe41c5437ad6449c2978b061958c1ec1ab5f",
};

export function getChainRedeemConfig(
  chainId: number,
): ChainRedeemConfig | null {
  return CHAIN_CONFIGS[chainId] ?? null;
}

export function getTransceiverForToken(
  tokenSymbol: string,
): `0x${string}` | null {
  return TRANSCEIVER_BY_TOKEN[tokenSymbol] ?? null;
}

export function canManuallyRedeemTransfer(
  transfer: Pick<
    BridgeTransfer,
    "provider" | "status" | "destChainId" | "sentTxHash" | "tokenSymbol"
  >,
): boolean {
  if (transfer.provider !== "WORMHOLE") return false;
  if (!transfer.sentTxHash) return false;
  if (transfer.destChainId === null || !(transfer.destChainId in CHAIN_CONFIGS))
    return false;
  if (!getTransceiverForToken(transfer.tokenSymbol)) return false;
  return !["DELIVERED", "CANCELLED", "FAILED", "QUEUED_INBOUND"].includes(
    transfer.status,
  );
}

const RECEIVE_MESSAGE_ABI = parseAbi(["function receiveMessage(bytes)"]);

export function vaaBase64ToHex(vaaBase64: string): `0x${string}` {
  const bytes =
    typeof window === "undefined"
      ? Buffer.from(vaaBase64, "base64")
      : Uint8Array.from(atob(vaaBase64), (char) => char.charCodeAt(0));
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function buildReceiveMessageCalldata(
  vaaHex: `0x${string}`,
): `0x${string}` {
  return encodeFunctionData({
    abi: RECEIVE_MESSAGE_ABI,
    functionName: "receiveMessage",
    args: [vaaHex],
  });
}

export type BridgeRedeemPayload = {
  chainId: number;
  chainIdHex: string;
  chainName: string;
  rpcUrl: string;
  explorerUrl: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  transceiver: `0x${string}`;
  vaaHex: `0x${string}`;
};
