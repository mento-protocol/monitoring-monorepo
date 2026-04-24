// Canonical token-symbol derivation from @mento-protocol/contracts.
// `indexer-envio/src/feeToken.ts:buildKnownTokenMeta` is a deliberate mirror
// with a stricter allowlist (`Mock*` exclusion + `decimals` required) — the
// indexer can't import this package because Envio builds outside the pnpm
// workspace. Keep the Spoke/StableToken rules in sync.

import contractsData from "@mento-protocol/contracts/contracts.json" with { type: "json" };
import namespaces from "../deployment-namespaces.json" with { type: "json" };

type RawEntry = {
  address: string;
  type?: string;
  decimals?: number;
};

type ContractsJson = Record<string, Record<string, Record<string, RawEntry>>>;

export interface ContractEntry {
  chainId: number;
  namespace: string;
  address: string;
  rawName: string;
  canonicalName: string;
  type: "token" | "pool" | "contract";
  decimals?: number;
}

const NAMESPACES = namespaces as Record<string, string>;
const CONTRACTS = contractsData as ContractsJson;

// Monad NTT tokens are published as `USDmSpoke`, `EURmSpoke`, etc.; strip the
// suffix on tokens only (implementation contracts like `StableTokenSpoke`
// stay raw for the address book). Guard against `name === "Spoke"` so a
// hypothetical malformed entry can't canonicalize to an empty symbol.
function canonicalTokenSymbol(name: string): string {
  return name.length > 5 && name.endsWith("Spoke") ? name.slice(0, -5) : name;
}

// `StableToken*` are implementation contracts; they must not surface as
// pool-token symbols. `Mock*` is deliberately kept — Sepolia MockERC20*
// deployments ARE the real pool tokens there.
function isInternalTokenName(name: string): boolean {
  return name.startsWith("StableToken");
}

function coerceType(raw: string | undefined): ContractEntry["type"] {
  return raw === "token" || raw === "pool" ? raw : "contract";
}

const ALL_ENTRIES: ContractEntry[] = (() => {
  const out: ContractEntry[] = [];
  for (const [chainIdStr, perNamespace] of Object.entries(CONTRACTS)) {
    const ns = NAMESPACES[chainIdStr];
    if (!ns) continue;
    const entries = perNamespace[ns];
    if (!entries) continue;
    const chainId = Number(chainIdStr);
    for (const [rawName, info] of Object.entries(entries)) {
      const type = coerceType(info.type);
      const canonicalName =
        type === "token" ? canonicalTokenSymbol(rawName) : rawName;
      out.push({
        chainId,
        namespace: ns,
        address: info.address.toLowerCase(),
        rawName,
        canonicalName,
        type,
        decimals: info.decimals,
      });
    }
  }
  return out;
})();

const ENTRIES_BY_CHAIN: Map<number, ContractEntry[]> = new Map();
for (const e of ALL_ENTRIES) {
  const list = ENTRIES_BY_CHAIN.get(e.chainId) ?? [];
  list.push(e);
  ENTRIES_BY_CHAIN.set(e.chainId, list);
}

const TOKEN_SYMBOL_INDEX: Map<string, string> = new Map();
for (const e of ALL_ENTRIES) {
  if (e.type !== "token") continue;
  if (isInternalTokenName(e.rawName)) continue;
  TOKEN_SYMBOL_INDEX.set(`${e.chainId}:${e.address}`, e.canonicalName);
}

export function contractEntries(chainId?: number): ContractEntry[] {
  if (chainId === undefined) return ALL_ENTRIES.slice();
  return (ENTRIES_BY_CHAIN.get(chainId) ?? []).slice();
}

export function tokenSymbol(
  chainId: number,
  address: string | null,
): string | null {
  if (!address) return null;
  return TOKEN_SYMBOL_INDEX.get(`${chainId}:${address.toLowerCase()}`) ?? null;
}

const USDM_SYMBOL = "USDm";

// Pool display name like "GBPm/USDm" with USDm always last. Returns null if
// either leg cannot be resolved.
export function poolName(
  chainId: number,
  token0: string | null,
  token1: string | null,
): string | null {
  const sym0 = tokenSymbol(chainId, token0);
  const sym1 = tokenSymbol(chainId, token1);
  if (!sym0 || !sym1) return null;
  if (sym0 === USDM_SYMBOL && sym1 !== USDM_SYMBOL) return `${sym1}/${sym0}`;
  return `${sym0}/${sym1}`;
}

export function chainTokenSymbols(chainId: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of ENTRIES_BY_CHAIN.get(chainId) ?? []) {
    if (e.type !== "token") continue;
    if (isInternalTokenName(e.rawName)) continue;
    out[e.address] = e.canonicalName;
  }
  return out;
}

// Every entry for a chain (tokens + non-tokens) as address → name. Token
// names canonicalized; implementation names kept raw for address-book use.
export function chainAddressLabels(chainId: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of ENTRIES_BY_CHAIN.get(chainId) ?? []) {
    out[e.address] = e.canonicalName;
  }
  return out;
}
