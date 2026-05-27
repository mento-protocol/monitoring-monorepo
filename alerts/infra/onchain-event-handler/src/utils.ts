/**
 * Utility functions for webhook processing
 */

import { createPublicClient, hashMessage, http, recoverAddress } from "viem";
import { celo, mainnet } from "viem/chains";
import config from "./config";
import {
  DEFAULT_TOKEN_DECIMALS,
  KNOWN_CHAINS,
  MULTISIGS_BY_CHAIN,
  SECURITY_EVENTS,
  getChainConfig,
} from "./constants";
import { logger } from "./logger";
import type { NotificationField, QuickNodeDecodedLog } from "./types";

/**
 * Map chain names to viem chain objects
 */
const VIEM_CHAINS: Record<string, typeof celo | typeof mainnet> = {
  celo,
  ethereum: mainnet,
};
const MAX_SAFE_DYNAMIC_OFFSET_WORD = BigInt(
  Math.floor(Number.MAX_SAFE_INTEGER / 2),
);

/**
 * Get multisig key from contract address and chain
 * @param address - The multisig contract address
 * @param chain - Chain name (e.g., "celo", "ethereum")
 * @returns The multisig key, or null if not found
 */
export function getMultisigKey(address: string, chain: string): string | null {
  const normalizedAddress = address.toLowerCase();
  const normalizedChain = chain.toLowerCase();
  const compositeKey = `${normalizedAddress}:${normalizedChain}`;
  return MULTISIGS_BY_CHAIN[compositeKey] || null;
}

/**
 * Verify if a block hash exists on a given chain
 * @param blockHash - The block hash to verify
 * @param chainName - The chain name to check (e.g., "celo", "ethereum")
 * @returns true if block exists on the chain, false otherwise
 */
async function verifyBlockHashOnChain(
  blockHash: string,
  chainName: string,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    if (signal?.aborted) {
      return false;
    }

    const chainConfig = getChainConfig(chainName);
    if (!chainConfig) {
      return false;
    }

    const viemChain = VIEM_CHAINS[chainName.toLowerCase()];
    if (!viemChain) {
      return false;
    }

    const publicClient = createPublicClient({
      chain: viemChain,
      transport: http(chainConfig.rpcEndpoint, {
        timeout: 5000, // 5 second timeout to prevent hanging
      }),
    });

    // Try to get the block by hash - if it exists, this will succeed
    await withAbort(
      publicClient.getBlock({
        blockHash: blockHash as `0x${string}`,
      }),
      signal,
    );

    return true;
  } catch {
    // Block doesn't exist on this chain or RPC call failed/timed out
    return false;
  }
}

/**
 * Find the chain for a given multisig address by trying all known chains
 * QuickNode webhooks don't include network information, so we determine it from the address
 * @param address - The multisig contract address
 * @returns The chain name if found, or null if not found in any chain
 */
export function findChainForAddress(address: string): string | null {
  const normalizedAddress = address.toLowerCase();
  const knownChains = KNOWN_CHAINS;

  const matches = knownChains.filter(
    (chain) => MULTISIGS_BY_CHAIN[`${normalizedAddress}:${chain}`],
  );

  // Unambiguous: exactly one chain has this multisig configured.
  if (matches.length === 1) return matches[0];

  // Ambiguous (multiple chains) or unknown (zero chains): return null so the
  // caller raises ChainDetectionError instead of silently misattributing.
  return null;
}

/**
 * Determine chain from block hash by verifying it exists on each chain
 * This is the most reliable method when the same address exists on multiple chains
 * @param blockHash - The block hash from the webhook payload
 * @param address - The multisig address (used as fallback)
 * @returns The chain name if determined, or null if not found
 */
export async function findChainFromBlockHash(
  blockHash: string,
  address: string,
  signal?: AbortSignal,
): Promise<string | null> {
  // First, try to find chains that have this address
  const possibleChains: string[] = [];
  const normalizedAddress = address.toLowerCase();
  const knownChains = KNOWN_CHAINS;

  for (const chain of knownChains) {
    const compositeKey = `${normalizedAddress}:${chain}`;
    if (MULTISIGS_BY_CHAIN[compositeKey]) {
      possibleChains.push(chain);
    }
  }

  // If address only exists on one chain, return it immediately
  if (possibleChains.length === 1) {
    return possibleChains[0];
  }

  // If address doesn't exist on any chain, return null
  if (possibleChains.length === 0) {
    return null;
  }

  // If address exists on multiple chains, verify block hash on each.
  // Check all possible chains in parallel for speed.
  const verificationResults = await Promise.allSettled(
    possibleChains.map(async (chain) => {
      const exists = await verifyBlockHashOnChain(blockHash, chain, signal);
      return { chain, exists };
    }),
  );

  // Collect every chain on which the block hash verified. Fail closed both
  // when zero chains match (the original behavior) AND when more than one
  // chain matches — picking the first match in iteration order would
  // mislabel events for any block hash that happens to exist on multiple
  // chains (extremely rare but, since collisions would silently misroute,
  // not worth a probabilistic bet).
  const matched = verificationResults.flatMap((r) =>
    r.status === "fulfilled" && r.value.exists ? [r.value.chain] : [],
  );

  if (matched.length === 1) {
    return matched[0];
  }

  if (matched.length === 0) {
    logger.warn("Could not verify block hash on any chain — failing closed", {
      blockHash,
      address,
      possibleChains,
    });
  } else {
    logger.warn(
      "Block hash verified on multiple chains — failing closed to avoid mislabel",
      { blockHash, address, possibleChains, matched },
    );
  }
  return null;
}

function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return promise;
  }

  if (signal.aborted) {
    return Promise.reject(new Error("Operation aborted"));
  }

  let cleanup: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    const onAbort = () => reject(new Error("Operation aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    cleanup = () => signal.removeEventListener("abort", onAbort);
  });

  return Promise.race([promise, aborted]).finally(() => cleanup?.());
}

/**
 * Determine if event is a security event
 */
export function isSecurityEvent(eventName: string): boolean {
  return SECURITY_EVENTS.includes(
    eventName as (typeof SECURITY_EVENTS)[number],
  );
}

/**
 * Get Slack channel ID from environment variables.
 * All multisigs share the same two destination channels.
 */
export function getNotificationChannelId(
  _multisigKey: string,
  channelType: "alerts" | "events",
): string | null {
  const envKey =
    `SLACK_CHANNEL_${channelType.toUpperCase()}` as keyof typeof config;

  const channelId = config[envKey];
  if (typeof channelId === "string") {
    return channelId;
  }

  return null;
}

/**
 * Extract signer addresses from Safe transaction signatures.
 *
 * Safe packs each static signature entry as r(32) + s(32) + v(1). For
 * contract signatures (v=0) and approved-hash signatures (v=1), the owner is
 * encoded in r. Contract signatures put a dynamic-data offset in s; that
 * dynamic payload is not another static signature and must not be parsed as
 * one. eth_sign signatures use v > 30 and recover against the EIP-191 hash.
 *
 * @param signatures - Hex string of concatenated signatures
 * @param txHash - Safe transaction hash (EIP-712 hash) that was signed
 * @returns Array of signer addresses
 */
export async function extractSignersFromSignatures(
  signatures: string,
  txHash: string,
): Promise<string[]> {
  const signers: string[] = [];

  try {
    // Remove 0x prefix if present
    const sigBytes = signatures.startsWith("0x")
      ? signatures.slice(2)
      : signatures;

    let i = 0;
    let staticSignaturesEnd = sigBytes.length;
    while (i < staticSignaturesEnd) {
      // Check if we have at least 65 bytes (130 hex chars) for a signature
      if (i + 130 > staticSignaturesEnd) break;

      const sigHex = sigBytes.slice(i, i + 130);
      const r = ("0x" + sigHex.slice(0, 64)) as `0x${string}`;
      const s = ("0x" + sigHex.slice(64, 128)) as `0x${string}`;
      const vByte = parseInt(sigHex.slice(128, 130), 16);
      const rHex = sigHex.slice(0, 64);
      const sHex = sigHex.slice(64, 128);

      if (vByte === 0 || vByte === 1) {
        const address = addressFromPaddedWord(rHex);
        if (address) {
          signers.push(address);
        }

        if (vByte === 0) {
          const dynamicOffsetWord = BigInt(`0x${sHex}`);
          if (dynamicOffsetWord <= MAX_SAFE_DYNAMIC_OFFSET_WORD) {
            const dynamicOffset = Number(dynamicOffsetWord) * 2;
            if (dynamicOffset >= i + 130 && dynamicOffset <= sigBytes.length) {
              staticSignaturesEnd = Math.min(
                staticSignaturesEnd,
                dynamicOffset,
              );
            }
          }
        }

        i += 130;
        continue;
      }

      // Standard ECDSA signature recovery (v = 27 or 28) or eth_sign
      // recovery (v > 30, stored as original v + 4 by Safe).
      if (vByte === 27 || vByte === 28 || vByte > 30) {
        try {
          const normalizedV = vByte > 30 ? vByte - 4 : vByte;
          if (normalizedV !== 27 && normalizedV !== 28) {
            throw new Error(`Unsupported Safe signature v=${vByte}`);
          }

          // viem's recoverAddress expects v as 0 or 1 (recovery id).
          const v: 0 | 1 = normalizedV === 27 ? 0 : 1;

          // Construct signature as hex string: r + s + v (v as 0 or 1)
          const signatureHex = (r +
            s.slice(2) +
            v.toString(16).padStart(2, "0")) as `0x${string}`;

          const hash =
            vByte > 30
              ? hashMessage({ raw: txHash as `0x${string}` })
              : (txHash as `0x${string}`);
          const recoveredAddress = await recoverAddress({
            hash,
            signature: signatureHex,
          });

          signers.push(recoveredAddress.toLowerCase());
        } catch (error) {
          // If recovery fails, skip this signature
          logger.warn(
            `Failed to recover address from signature at offset ${i}:`,
            { error: error instanceof Error ? error.message : String(error) },
          );
        }
      } else {
        // Unknown v value, skip this signature
        logger.warn(
          `Unknown v value ${vByte} at offset ${i}, skipping signature`,
        );
      }

      // Move to next signature (65 bytes = 130 hex chars)
      i += 130;
    }
  } catch (error) {
    logger.warn("Failed to extract signers from signatures", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return signers;
}

function addressFromPaddedWord(wordHex: string): string | null {
  if (!wordHex.startsWith("000000000000000000000000")) {
    return null;
  }

  const address = `0x${wordHex.slice(24)}`.toLowerCase();
  return address === "0x0000000000000000000000000000000000000000"
    ? null
    : address;
}

/**
 * Extract event data from decoded log using registry pattern
 * @param eventName - The Safe event name (e.g., "AddedOwner", "ExecutionSuccess")
 * @param log - QuickNode decoded log entry containing decoded event parameters
 * @param txHash - Optional Safe transaction hash for extracting signers
 * @param chainName - Chain name (e.g., "celo", "ethereum") for chain-specific formatting
 * @returns Array of notification fields with event parameters
 */
export async function decodeEventData(
  eventName: string,
  log: QuickNodeDecodedLog,
  txHash?: string,
  chainName: string = "celo",
  signal?: AbortSignal,
): Promise<NotificationField[]> {
  const chainConfig = getChainConfig(chainName);
  const chainTokenConfig = {
    decimals: chainConfig?.nativeToken.decimals || DEFAULT_TOKEN_DECIMALS,
    symbol: chainConfig?.nativeToken.symbol || "",
  };

  // SafeMultiSigTransaction isn't in EVENT_FORMATTERS because its formatter
  // takes an extra chainName argument. Dispatch it before the registry
  // lookup so it doesn't fall through to the empty-fields default.
  if (eventName === "SafeMultiSigTransaction") {
    const { formatSafeMultiSigTransactionEvent } =
      await import("./event-formatters/transaction-formatters");
    return formatSafeMultiSigTransactionEvent(
      log,
      chainTokenConfig,
      chainName,
      txHash,
      signal,
    );
  }

  // Use registry pattern for all other events
  const { getEventFormatter } = await import("./event-formatters");
  const formatter = getEventFormatter(eventName);
  if (formatter) {
    return formatter(log, chainTokenConfig, txHash);
  }

  // Fallback: return empty fields for unknown events
  return [];
}

/**
 * Get the executor address (from) of a transaction
 * @param transactionHash - The transaction hash to look up
 * @param chainName - The chain name (e.g., "celo", "ethereum")
 * @returns The executor address, or null if not found/error
 */
export async function getTransactionExecutor(
  transactionHash: string,
  chainName: string,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    if (signal?.aborted) {
      return null;
    }

    const chainConfig = getChainConfig(chainName);
    if (!chainConfig) {
      logger.warn(`Unknown chain: ${chainName}`);
      return null;
    }

    const viemChain = VIEM_CHAINS[chainName.toLowerCase()];
    if (!viemChain) {
      logger.warn(`No viem chain config for: ${chainName}`);
      return null;
    }

    const publicClient = createPublicClient({
      chain: viemChain,
      transport: http(chainConfig.rpcEndpoint, {
        // 5s matches verifyBlockHashOnChain. Without a timeout, a stalled
        // public RPC node hangs the Cloud Function until Cloud Functions
        // kills the request (~60s), QuickNode 5xx's, and retries the whole
        // batch → duplicate notification deliveries for events that already fired.
        timeout: 5000,
      }),
    });

    const tx = await withAbort(
      publicClient.getTransaction({
        hash: transactionHash as `0x${string}`,
      }),
      signal,
    );

    return tx.from.toLowerCase();
  } catch (error) {
    logger.warn(`Failed to fetch transaction executor for ${transactionHash}`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Get multisig display name from MULTISIG_CONFIG
 */
export function getMultisigName(multisigKey: string): string {
  try {
    const multisigConfigJson = config.MULTISIG_CONFIG;
    const multisigConfig = JSON.parse(multisigConfigJson) as Record<
      string,
      { address: string; name: string; chain: string }
    >;

    const multisigInfo = multisigConfig[multisigKey];
    if (multisigInfo?.name) {
      return multisigInfo.name;
    }
  } catch {
    // Fallback if config parsing fails
  }
  return multisigKey;
}

/**
 * Get chain info from multisig config
 */
export function getMultisigChainInfo(multisigKey: string): {
  chain: string;
} | null {
  try {
    const multisigConfigJson = config.MULTISIG_CONFIG;
    const multisigConfig = JSON.parse(multisigConfigJson) as Record<
      string,
      { address: string; name: string; chain: string }
    >;

    const multisigInfo = multisigConfig[multisigKey];
    if (!multisigInfo) {
      return null;
    }

    return {
      chain: multisigInfo.chain,
    };
  } catch {
    return null;
  }
}

/**
 * Get block explorer for a given chain
 */
export function getBlockExplorer(chainName: string) {
  const chainConfig = getChainConfig(chainName);
  if (!chainConfig) {
    // Fallback to Celo if chain not found
    const celoConfig = getChainConfig("celo");
    if (!celoConfig) {
      throw new Error(
        `Chain config not found for: ${chainName} and fallback celo also not found`,
      );
    }
    return celoConfig.blockExplorer;
  }
  return chainConfig.blockExplorer;
}

/**
 * Build Safe UI URL for a transaction
 * Format: https://app.safe.global/transactions/tx?safe={chain}:{address}&id=multisig_{address}_{txHash}
 */
export function getSafeUiUrl(
  safeAddress: string,
  txHash: string,
  multisigKey: string,
): string {
  const chainInfo = getMultisigChainInfo(multisigKey);

  if (chainInfo) {
    // Use chain:address format for safe parameter
    // Use multisig_{address}_{txHash} format for id parameter
    const normalizedAddress = safeAddress.toLowerCase();
    return `https://app.safe.global/transactions/tx?safe=${chainInfo.chain}:${normalizedAddress}&id=multisig_${normalizedAddress}_${txHash}`;
  }

  // Fallback to simple format if chain info not available
  const normalizedAddress = safeAddress.toLowerCase();
  return `https://app.safe.global/transactions/tx?safe=${normalizedAddress}&id=multisig_${normalizedAddress}_${txHash}`;
}
