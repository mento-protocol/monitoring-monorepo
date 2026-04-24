import chainMetadataJson from "../chain-metadata.json" with { type: "json" };

interface ChainMetadataEntry {
  slug: string;
  label: string;
  explorerBaseUrl: string;
}

const CHAIN_METADATA = chainMetadataJson as Record<string, ChainMetadataEntry>;

function entry(chainId: number): ChainMetadataEntry | undefined {
  return CHAIN_METADATA[String(chainId)];
}

// True when the chainId has an entry in chain-metadata.json. Callers that
// need to detect "missing chain" should use this instead of comparing
// `chainSlug(id) === String(id)` — `chainSlug` is pass-through on miss
// and that sentinel string can collide with valid future slugs.
export function hasChain(chainId: number): boolean {
  return entry(chainId) !== undefined;
}

export function chainSlug(chainId: number): string {
  return entry(chainId)?.slug ?? String(chainId);
}

export function chainLabel(chainId: number): string {
  return entry(chainId)?.label ?? chainSlug(chainId);
}

export function explorerBaseUrl(chainId: number): string | null {
  return entry(chainId)?.explorerBaseUrl ?? null;
}

export function explorerAddressUrl(
  chainId: number,
  address: string,
): string | null {
  const base = explorerBaseUrl(chainId);
  return base ? `${base}/address/${address}` : null;
}

export function explorerTxUrl(chainId: number, txHash: string): string | null {
  const base = explorerBaseUrl(chainId);
  return base ? `${base}/tx/${txHash}` : null;
}
