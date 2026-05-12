import type { AddressEntryRecord } from "@/lib/address-labels";

export const SUGGESTED_TAGS = [
  // Behavioral
  "Whale",
  "ETH Staker",
  "MEV Bot",
  "Arbitrageur",
  "Market Maker",
  "Liquidity Provider",
  "Yield Farmer",
  "NFT Trader",
  // Institutional
  "CEX",
  "DEX",
  "DAO",
  "Treasury",
  "Team",
  "Protocol",
  "Fund",
  // Identity
  "ENS Holder",
  "Lens Profile",
  "Farcaster User",
  // Network-specific
  "Celo Validator",
  "Celo Voter",
  "Monad Early User",
] as const;

/**
 * Extract all unique tags already used across existing entries, sorted
 * alphabetically. Useful for autocomplete suggestions alongside SUGGESTED_TAGS.
 */
export function getUsedTags(entries: AddressEntryRecord[]): string[] {
  const set = new Set<string>();
  for (const entry of entries) {
    for (const tag of entry.tags) {
      set.add(tag);
    }
  }
  // ES2023 `toSorted` requires Safari 16+/Chrome 110+; TS target is
  // ES2017 with no polyfill — keep the spread+sort form (codex P2).
  // react-doctor-disable-next-line react-doctor/js-tosorted-immutable
  return [...Array.from(set)].sort((a, b) => a.localeCompare(b));
}
