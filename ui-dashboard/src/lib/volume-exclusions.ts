import type { BrokerTraderDailyRow, TraderDailyRow } from "@/lib/volume";
import type { AggregatorDailyRowBase } from "@/lib/volume-aggregators";

export type VolumeExclusionState = {
  addresses: string[];
  sources: string[];
};

export type VolumeExclusionParseResult = VolumeExclusionState & {
  invalid: string[];
};

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const SOURCE_RE = /^[a-z0-9][a-z0-9._:-]{0,79}$/;
const TOKEN_SPLIT_RE = /[\s,;]+/;

export function hasVolumeExclusions(exclusions: VolumeExclusionState): boolean {
  return exclusions.addresses.length > 0 || exclusions.sources.length > 0;
}

export function parseVolumeExclusionInput(
  input: string,
): VolumeExclusionParseResult {
  const addresses: string[] = [];
  const sources: string[] = [];
  const invalid: string[] = [];

  for (const rawToken of input.split(TOKEN_SPLIT_RE)) {
    const token = cleanToken(rawToken);
    if (!token) continue;
    const address = normalizeVolumeExclusionAddress(token);
    if (address) {
      appendUnique(addresses, address);
      continue;
    }
    const source = normalizeVolumeExclusionSource(token);
    if (source) {
      appendUnique(sources, source);
      continue;
    }
    appendUnique(invalid, token);
  }

  return { addresses, sources, invalid };
}

export function normalizeVolumeExclusionAddress(value: string): string | null {
  const token = cleanToken(value);
  return ADDRESS_RE.test(token) ? token.toLowerCase() : null;
}

export function normalizeVolumeExclusionSource(value: string): string | null {
  const token = cleanToken(value)
    .toLowerCase()
    .replace(/^source:/, "");
  if (!SOURCE_RE.test(token)) return null;
  return token === "0x" || !token.startsWith("0x") ? token : null;
}

export function mergeVolumeExclusions(
  current: VolumeExclusionState,
  added: VolumeExclusionState,
): VolumeExclusionState {
  return {
    addresses: mergeUnique(current.addresses, added.addresses),
    sources: mergeUnique(current.sources, added.sources),
  };
}

export function filterTraderRowsByVolumeExclusions(
  rows: readonly TraderDailyRow[],
  exclusions: VolumeExclusionState,
): TraderDailyRow[] {
  if (!hasVolumeExclusions(exclusions)) return [...rows];
  const excludedAddresses = new Set(exclusions.addresses);
  const excludedSources = new Set(exclusions.sources);
  return rows.filter((row) => {
    if (excludedAddresses.has(row.trader.toLowerCase())) return false;
    return !rowHasExcludedSource(row, excludedSources);
  });
}

export function filterBrokerTraderRowsByVolumeExclusions(
  rows: readonly BrokerTraderDailyRow[],
  exclusions: VolumeExclusionState,
): BrokerTraderDailyRow[] {
  if (exclusions.addresses.length === 0) return [...rows];
  const excludedAddresses = new Set(exclusions.addresses);
  return rows.filter((row) => !excludedAddresses.has(row.trader.toLowerCase()));
}

export function filterAggregatorRowsByVolumeExclusions<
  T extends AggregatorDailyRowBase,
>(rows: readonly T[], exclusions: VolumeExclusionState): T[] {
  if (!hasVolumeExclusions(exclusions)) return [...rows];
  const excludedAddresses = new Set(exclusions.addresses);
  const excludedSources = new Set(exclusions.sources);
  return rows.filter((row) => {
    if (excludedSources.has(row.aggregator.toLowerCase())) return false;
    return !excludedAddresses.has(row.lastSeenAggregatorAddress.toLowerCase());
  });
}

function rowHasExcludedSource(
  row: TraderDailyRow,
  excludedSources: ReadonlySet<string>,
): boolean {
  if (excludedSources.size === 0) return false;
  return (row.aggregatorKeys ?? []).some((key) =>
    excludedSources.has(key.toLowerCase()),
  );
}

function cleanToken(value: string): string {
  return value.trim().replace(/^[<([{'"`]+|[>\])}'"`]+$/g, "");
}

function mergeUnique(a: readonly string[], b: readonly string[]): string[] {
  const out = [...a];
  for (const value of b) appendUnique(out, value);
  return out;
}

function appendUnique(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value);
}
