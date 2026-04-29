import { encodeFunctionData, getContractAddress, parseAbi } from "viem";
import { contractEntries } from "@mento-protocol/monitoring-config/tokens";
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

// NttDeployHelper deploys its NttManager + WormholeTransceiver proxies
// sequentially from a fresh account, so CREATE(helper, nonce=4) is
// deterministic and matches the proxy at runtime. See
// indexer-envio/scripts/generateNttAddresses.mjs for the full nonce table.
// Deriving from contracts.json means a contracts bump auto-extends
// manual-redeem support to any new bridged token.
const HELPER_PREFIX = "NttDeployHelper";

function buildTransceiverIndex(): Record<
  number,
  Record<string, `0x${string}`>
> {
  const out: Record<number, Record<string, `0x${string}`>> = {};
  for (const chainIdStr of Object.keys(CHAIN_CONFIGS)) {
    const chainId = Number(chainIdStr);
    const perToken: Record<string, `0x${string}`> = {};
    for (const entry of contractEntries(chainId)) {
      if (entry.type !== "contract") continue;
      if (!entry.rawName.startsWith(HELPER_PREFIX)) continue;
      const symbol = entry.rawName.slice(HELPER_PREFIX.length);
      const transceiver = getContractAddress({
        from: entry.address as `0x${string}`,
        nonce: BigInt(4),
      });
      perToken[symbol] = transceiver.toLowerCase() as `0x${string}`;
    }
    out[chainId] = perToken;
  }
  return out;
}

const TRANSCEIVER_BY_CHAIN_AND_TOKEN = buildTransceiverIndex();

export function getChainRedeemConfig(
  chainId: number,
): ChainRedeemConfig | null {
  return CHAIN_CONFIGS[chainId] ?? null;
}

export function getTransceiverForToken(
  chainId: number,
  tokenSymbol: string,
): `0x${string}` | null {
  return TRANSCEIVER_BY_CHAIN_AND_TOKEN[chainId]?.[tokenSymbol] ?? null;
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
  if (!getTransceiverForToken(transfer.destChainId, transfer.tokenSymbol))
    return false;
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
