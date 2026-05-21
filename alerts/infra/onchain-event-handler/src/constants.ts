/**
 * Constants for event signatures, multisig addresses, and configuration
 * Event signatures are extracted from the Safe contract ABI (single source of truth)
 * Multisig addresses are loaded from environment variables
 */

import keccak from "keccak";
import { celo, mainnet } from "viem/chains";
import safeAbi from "../safe-abi.json";
import config from "./config";
import type { EventName, EventSignature, MultisigKey } from "./types";

/**
 * Security event names that should be routed to the alerts channel
 */
const SECURITY_EVENT_NAMES = new Set([
  "SafeSetup",
  "AddedOwner",
  "RemovedOwner",
  "ChangedThreshold",
  "ChangedFallbackHandler",
  "EnabledModule",
  "DisabledModule",
  "ChangedGuard",
]);

/**
 * Compute keccak256 hash of a string (for event signatures)
 */
function keccak256(input: string): string {
  const hash = keccak("keccak256").update(input).digest("hex");
  return `0x${hash}`;
}

/**
 * Extract event signatures from ABI and compute their hashes
 */
function extractEventSignatures() {
  const eventSignatures: Record<EventSignature, EventName> = {} as Record<
    EventSignature,
    EventName
  >;
  const securityEvents: EventName[] = [];

  for (const item of safeAbi) {
    if (item.type === "event" && item.name) {
      const eventName = item.name;
      const inputs = item.inputs || [];

      // Build signature string: EventName(type1,type2,...)
      const paramTypes = inputs
        .map((input: { type?: string }) => input?.type)
        .filter(
          (type: string | undefined): type is string =>
            typeof type === "string",
        );
      const signatureStr = `${eventName}(${paramTypes.join(",")})`;

      // Compute keccak256 hash
      const signatureHash = keccak256(signatureStr) as EventSignature;

      // Store mapping
      eventSignatures[signatureHash] = eventName;

      // Categorize
      if (SECURITY_EVENT_NAMES.has(eventName)) {
        securityEvents.push(eventName);
      }
    }
  }

  return { eventSignatures, securityEvents };
}

const { securityEvents } = extractEventSignatures();

/**
 * Security events that should be routed to the alerts channel
 */
export const SECURITY_EVENTS: EventName[] = securityEvents;

/**
 * Chain-aware mapping of address+chain to multisig key
 * This prevents collisions when the same address exists on multiple chains
 */
export const MULTISIGS_BY_CHAIN: Record<string, MultisigKey> = (() => {
  const multisigsByChain: Record<string, MultisigKey> = {};

  // Load multisig config from JSON environment variable
  const multisigConfigJson = config.MULTISIG_CONFIG;

  try {
    const multisigConfig = JSON.parse(multisigConfigJson) as Record<
      string,
      { address: string; name: string; chain: string }
    >;

    // Build mapping: address:chain -> key
    for (const [key, multisigConfigItem] of Object.entries(multisigConfig)) {
      const normalizedAddress = multisigConfigItem.address.toLowerCase();
      const chain = multisigConfigItem.chain.toLowerCase();
      const compositeKey = `${normalizedAddress}:${chain}`;
      multisigsByChain[compositeKey] = key;
    }
  } catch (error) {
    throw new Error(
      `Failed to parse MULTISIG_CONFIG: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return multisigsByChain;
})();

/**
 * Chain configuration mapping chain names to their properties
 * Uses viem chain definitions where possible
 */
interface ChainConfig {
  blockExplorer: {
    baseUrl: string;
    tx: (hash: string) => string;
    block: (number: string) => string;
    address: (addr: string) => string;
  };
  nativeToken: {
    symbol: string;
    decimals: number;
  };
  rpcEndpoint: string;
}

/**
 * Build block explorer helpers from viem chain blockExplorers
 */
function buildBlockExplorer(chain: typeof celo | typeof mainnet) {
  const explorer = chain.blockExplorers?.default;
  if (!explorer) {
    throw new Error(
      `Chain ${chain.name} does not have a default block explorer`,
    );
  }

  return {
    baseUrl: explorer.url,
    tx: (hash: string) => `${explorer.url}/tx/${hash}`,
    block: (number: string) => `${explorer.url}/block/${number}`,
    address: (addr: string) => `${explorer.url}/address/${addr}`,
  };
}

const CHAIN_CONFIGS: Record<string, ChainConfig> = {
  celo: {
    blockExplorer: buildBlockExplorer(celo),
    nativeToken: {
      symbol: celo.nativeCurrency.symbol,
      decimals: celo.nativeCurrency.decimals,
    },
    rpcEndpoint: celo.rpcUrls.default.http[0] || "https://forno.celo.org",
  },
  ethereum: {
    blockExplorer: buildBlockExplorer(mainnet),
    nativeToken: {
      symbol: mainnet.nativeCurrency.symbol,
      decimals: mainnet.nativeCurrency.decimals,
    },
    rpcEndpoint: mainnet.rpcUrls.default.http[0] || "https://eth.llamarpc.com",
  },
} as const;

/**
 * Get chain configuration for a given chain name
 */
export function getChainConfig(chainName: string): ChainConfig | null {
  return CHAIN_CONFIGS[chainName.toLowerCase()] || null;
}

/**
 * Color codes for Discord embeds
 */
export const DISCORD_COLORS = {
  ALERT: 0xff4757, // Red for security events
  EVENT: 0x5f27cd, // Purple for operational events
} as const;

/**
 * Discord webhook timeout in milliseconds (10 seconds)
 */
export const DISCORD_WEBHOOK_TIMEOUT_MS = 10000;

/**
 * Default token decimals (most EVM chains use 18)
 */
export const DEFAULT_TOKEN_DECIMALS = 18;
