/**
 * Utility functions for webhook processing
 */

import { createPublicClient, http, recoverAddress } from "viem";
import { celo, mainnet } from "viem/chains";
import config from "./config";
import {
  DEFAULT_TOKEN_DECIMALS,
  MULTISIGS_BY_CHAIN,
  SECURITY_EVENTS,
  getChainConfig,
} from "./constants";
import { logger } from "./logger";
import type { DiscordEmbedField, QuickNodeDecodedLog } from "./types";

/**
 * Map chain names to viem chain objects
 */
const VIEM_CHAINS: Record<string, typeof celo | typeof mainnet> = {
  celo,
  ethereum: mainnet,
};

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
): Promise<boolean> {
  try {
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
    await publicClient.getBlock({
      blockHash: blockHash as `0x${string}`,
    });

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
  const knownChains = ["celo", "ethereum"];

  for (const chain of knownChains) {
    const compositeKey = `${normalizedAddress}:${chain}`;
    if (MULTISIGS_BY_CHAIN[compositeKey]) {
      return chain;
    }
  }

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
): Promise<string | null> {
  // First, try to find chains that have this address
  const possibleChains: string[] = [];
  const normalizedAddress = address.toLowerCase();
  const knownChains = ["celo", "ethereum"];

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

  // If address exists on multiple chains, verify block hash on each
  // Check all possible chains in parallel for speed
  const verificationResults = await Promise.allSettled(
    possibleChains.map(async (chain) => {
      const exists = await verifyBlockHashOnChain(blockHash, chain);
      return { chain, exists };
    }),
  );

  // Find the chain where the block hash exists
  for (const result of verificationResults) {
    if (result.status === "fulfilled" && result.value.exists) {
      return result.value.chain;
    }
  }

  // If block hash verification failed for all chains, fall back to first possible chain
  // This handles cases where RPC calls fail but we still want to process the event
  logger.warn("Could not verify block hash on any chain, using first match", {
    blockHash,
    address,
    possibleChains,
  });
  return possibleChains[0];
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
 * Get Discord webhook URL from environment variables
 * All multisigs share the same two webhook URLs
 */
export function getWebhookUrl(
  _multisigKey: string,
  channelType: "alerts" | "events",
): string | null {
  // All multisigs use the same webhook URLs
  const envKey =
    `DISCORD_WEBHOOK_${channelType.toUpperCase()}` as keyof typeof config;

  const webhookUrl = config[envKey];
  if (typeof webhookUrl === "string") {
    return webhookUrl;
  }

  return null;
}

/**
 * Extract signer addresses from Safe transaction signatures
 * Safe signatures can be:
 * - Standard ECDSA signatures (65 bytes: r, s, v) where v is 27 or 28
 * - Contract signatures (v = 0 or 1, followed by 32 bytes address + 32 bytes data = 129 bytes total)
 *
 * Safe contract signature format:
 * - v = 0 or 1 (not 27/28) indicates contract signature
 * - Next 32 bytes: address (right-padded, address in last 20 bytes)
 * - Next 32 bytes: signature data
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
    while (i < sigBytes.length) {
      // Check if we have at least 65 bytes (130 hex chars) for a signature
      if (i + 130 > sigBytes.length) break;

      const sigHex = sigBytes.slice(i, i + 130);
      const r = ("0x" + sigHex.slice(0, 64)) as `0x${string}`;
      const s = ("0x" + sigHex.slice(64, 128)) as `0x${string}`;
      const vByte = parseInt(sigHex.slice(128, 130), 16);

      // Check if r contains an address (contract signature variant where address is in r)
      // This happens when r starts with many zeros and contains an address, and s is all zeros
      // This check must come BEFORE the standard contract signature check
      const rHex = sigHex.slice(0, 64);
      const sHex = sigHex.slice(64, 128);
      // Check if r has 24 leading zeros (12 hex chars) followed by an address, and s is all zeros
      if (
        rHex.startsWith("000000000000000000000000") &&
        sHex ===
          "0000000000000000000000000000000000000000000000000000000000000000"
      ) {
        // Extract address from r (last 40 hex chars)
        const address = "0x" + rHex.slice(24);
        if (address !== "0x0000000000000000000000000000000000000000") {
          signers.push(address.toLowerCase());
        }
        // Move to next signature
        i += 130;
        continue;
      }

      // Check if this is a contract signature (v = 0 or 1, not 27/28)
      // Contract signatures are 129 bytes: 65 bytes (r, s, v) + 32 bytes (address) + 32 bytes (data)
      if ((vByte === 0 || vByte === 1) && i + 258 <= sigBytes.length) {
        // Contract signature: extract the address directly
        // Address is in bytes 65-96 (32 bytes), right-padded, address in last 20 bytes
        const addressHex = sigBytes.slice(i + 130, i + 194); // 64 hex chars = 32 bytes
        // Address is in the last 40 hex chars (20 bytes)
        const address = "0x" + addressHex.slice(24); // Extract last 40 chars (20 bytes)
        if (address !== "0x0000000000000000000000000000000000000000") {
          signers.push(address.toLowerCase());
        }
        // Skip the full contract signature: 65 bytes (sig) + 32 bytes (addr) + 32 bytes (data) = 129 bytes = 258 hex chars
        i += 258;
        continue;
      }

      // Standard ECDSA signature recovery (v = 27 or 28)
      if (vByte === 27 || vByte === 28) {
        try {
          // viem's recoverAddress expects v as 0 or 1 (recovery id)
          const v: 0 | 1 = vByte === 27 ? 0 : 1;

          // Construct signature as hex string: r + s + v (v as 0 or 1)
          const signatureHex = (r +
            s.slice(2) +
            v.toString(16).padStart(2, "0")) as `0x${string}`;

          // Safe's txHash is the EIP-712 hash of the transaction
          // Safe signs the EIP-712 hash directly (not with EIP-191 encoding)
          // The signature is over the EIP-712 hash itself
          const recoveredAddress = await recoverAddress({
            hash: txHash as `0x${string}`,
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

/**
 * Extract event data from decoded log using registry pattern
 * @param eventName - The Safe event name (e.g., "AddedOwner", "ExecutionSuccess")
 * @param log - QuickNode decoded log entry containing decoded event parameters
 * @param txHash - Optional Safe transaction hash for extracting signers
 * @param chainName - Chain name (e.g., "celo", "ethereum") for chain-specific formatting
 * @returns Array of Discord embed fields with event parameters
 */
export async function decodeEventData(
  eventName: string,
  log: QuickNodeDecodedLog,
  txHash?: string,
  chainName: string = "celo",
): Promise<DiscordEmbedField[]> {
  const chainConfig = getChainConfig(chainName);
  const chainTokenConfig = {
    decimals: chainConfig?.nativeToken.decimals || DEFAULT_TOKEN_DECIMALS,
    symbol: chainConfig?.nativeToken.symbol || "",
  };

  // Use registry pattern to get formatter
  const { getEventFormatter } = await import("./event-formatters");
  const formatter = getEventFormatter(eventName);

  if (formatter) {
    // Special handling for SafeMultiSigTransaction which needs chainName
    if (eventName === "SafeMultiSigTransaction") {
      const { formatSafeMultiSigTransactionEvent } =
        await import("./event-formatters/transaction-formatters");
      return formatSafeMultiSigTransactionEvent(
        log,
        chainTokenConfig,
        chainName,
        txHash,
      );
    }

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
): Promise<string | null> {
  try {
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
      transport: http(chainConfig.rpcEndpoint),
    });

    const tx = await publicClient.getTransaction({
      hash: transactionHash as `0x${string}`,
    });

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
