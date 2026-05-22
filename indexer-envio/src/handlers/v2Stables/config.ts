import _contractsJson from "@mento-protocol/contracts/contracts.json" with { type: "json" };
import { V3_HUB_USDM_ADDRESS } from "../../constants.js";
import {
  CONTRACT_NAMESPACE_BY_CHAIN,
  type ContractsJson,
} from "../../contractAddresses.js";
import { asAddress } from "../../helpers.js";

// ---------------------------------------------------------------------------
// V2 Mento stablecoin registry for the /stables dashboard page.
//
// Subscribes Transfer(from=0, to=0) events on each token via the V2StableToken
// contract entry in `config.multichain.mainnet.yaml`. For each event the
// handler writes a StableSupplyDailySnapshot + V2StableSupplyChangeEvent row
// using the canonical `source` discriminator below.
//
// Three discriminators:
//   V2_RESERVE          — reserve-backed stables that mint/burn via Broker.
//                         12 tokens; brand-named in @mento-protocol/contracts
//                         (USDm aliases the V2 cUSD address 0x765de8…).
//   V3_HUB_COLLATERAL   — the V3 hub USDm at 0x106cc… (a distinct contract
//                         from V2 cUSD-USDm). Hand-typed below because the
//                         contracts package's bare `USDm` key still resolves
//                         to V2 cUSD — see indexer-envio/src/handlers/liquity/
//                         config.ts:28-33 for the same rationale.
//   V3_LIQUITY          — Bold-style CDP debt tokens (GBPm/CHFm/JPYm). NOT
//                         covered by this V2 subscription; supply is derived
//                         from LiquityInstance.systemDebt in
//                         src/handlers/liquity/instance.ts at daily flush.
//                         Listed in EXCLUDED_FROM_V2 below so we don't double-
//                         track when iterating @mento-protocol/contracts.
// ---------------------------------------------------------------------------

export type StableSupplySource =
  | "V2_RESERVE"
  | "V3_HUB_COLLATERAL"
  | "V3_LIQUITY";

export type V2StableInfo = {
  chainId: number;
  address: string; // lowercased
  symbol: string; // Mento brand name (USDm/EURm/BRLm/...)
  decimals: number;
  source: StableSupplySource;
};

const V2_STABLE_CHAIN_ID = 42220;

// V3 Liquity Bold debt tokens — supply tracked via LiquityInstance.systemDebt,
// not via this V2 Transfer subscription.
const EXCLUDED_FROM_V2 = new Set(["GBPm", "CHFm", "JPYm"]);
// External bridged stables — not Mento-issued.
const EXTERNAL_STABLES = new Set(["USDC", "USDT", "axlUSDC", "axlEUROC"]);
// Native gas tokens — never appear as a Mento stable.
const NATIVE_GAS = new Set(["CELO"]);

// Sanity check at module load. If @mento-protocol/contracts drops or renames
// one of these symbols, throw immediately rather than silently producing an
// 11- or 13-token registry on the next sync.
const EXPECTED_V2_RESERVE_SYMBOLS: ReadonlyArray<string> = [
  "USDm",
  "EURm",
  "BRLm",
  "AUDm",
  "CADm",
  "COPm",
  "GHSm",
  "KESm",
  "NGNm",
  "PHPm",
  "XOFm",
  "ZARm",
];

// V3 hub USDm — distinct on-chain contract from V2 cUSD-USDm. The address
// constant lives in `src/constants.ts` and is also imported by
// `handlers/liquity/config.ts`; single-source so the two hardcodes can never
// drift.
const V3_HUB_USDM_INFO: V2StableInfo = {
  chainId: V2_STABLE_CHAIN_ID,
  address: V3_HUB_USDM_ADDRESS,
  symbol: "USDm",
  decimals: 18,
  source: "V3_HUB_COLLATERAL",
};

const buildV2Stables = (): ReadonlyArray<V2StableInfo> => {
  const ns = CONTRACT_NAMESPACE_BY_CHAIN[String(V2_STABLE_CHAIN_ID)];
  const entries =
    ns && (_contractsJson as ContractsJson)[String(V2_STABLE_CHAIN_ID)]?.[ns];
  if (!entries) return [];

  const out: V2StableInfo[] = [];
  for (const [name, info] of Object.entries(entries)) {
    if (info.type !== "token") continue;
    if (EXCLUDED_FROM_V2.has(name)) continue;
    if (EXTERNAL_STABLES.has(name)) continue;
    if (NATIVE_GAS.has(name)) continue;
    if (typeof info.decimals !== "number") continue; // skip malformed
    out.push({
      chainId: V2_STABLE_CHAIN_ID,
      address: info.address.toLowerCase(),
      symbol: name,
      decimals: info.decimals,
      source: "V2_RESERVE",
    });
  }

  // Append V3 hub USDm (not derivable from the package today).
  out.push(V3_HUB_USDM_INFO);
  return out;
};

export const V2_STABLES: ReadonlyArray<V2StableInfo> = buildV2Stables();

// Invariant check: every EXPECTED V2 reserve symbol resolved successfully.
// If the package drops one, throw at module load so the indexer fails fast
// rather than silently under-tracking a token.
{
  const v2ReserveSymbols = new Set(
    V2_STABLES.filter((s) => s.source === "V2_RESERVE").map((s) => s.symbol),
  );
  for (const expected of EXPECTED_V2_RESERVE_SYMBOLS) {
    if (!v2ReserveSymbols.has(expected)) {
      throw new Error(
        `[v2Stables/config] Expected V2 reserve stable ${expected} missing from ` +
          `@mento-protocol/contracts (chain ${V2_STABLE_CHAIN_ID}). Update ` +
          `EXPECTED_V2_RESERVE_SYMBOLS or bump the contracts package.`,
      );
    }
  }
  // Also sanity-check that V2 cUSD-USDm and the hardcoded V3 hub USDm are
  // at DISTINCT on-chain addresses. The two USDm entries must differ — if
  // the upstream package starts publishing USDm at the V3 hub address
  // (`0x106cc…`), the length check below alone would pass with two
  // duplicate-address rows, and `_byAddress` would silently collapse them
  // (last-write-wins). Asserting distinctness here fails loud at module
  // load so an operator removes V3_HUB_USDM_INFO before deploy.
  const usdmEntries = V2_STABLES.filter((s) => s.symbol === "USDm");
  if (usdmEntries.length !== 2) {
    throw new Error(
      `[v2Stables/config] Expected exactly 2 USDm entries (V2 cUSD-USDm + V3 hub USDm), found ${usdmEntries.length}. ` +
        `If @mento-protocol/contracts now ships USDm at ${V3_HUB_USDM_ADDRESS}, remove V3_HUB_USDM_INFO from this file.`,
    );
  }
  // `usdmEntries.length === 2` guaranteed by the prior throw, so index
  // access is safe; the local-binding pattern keeps TS strict-null happy.
  const [firstUsdm, secondUsdm] = usdmEntries;
  if (firstUsdm && secondUsdm && firstUsdm.address === secondUsdm.address) {
    throw new Error(
      `[v2Stables/config] Both USDm entries resolved to the same address ${firstUsdm.address}. ` +
        `@mento-protocol/contracts likely republished USDm at the V3 hub address — remove V3_HUB_USDM_INFO from this file.`,
    );
  }
  // Belt-and-braces: assert no duplicate (chainId, address) keys overall.
  // `_byAddress` below silently collapses duplicates; the test in
  // test/v2Stables.test.ts catches drift at YAML time, but a registry-side
  // collision should fail at module load with a clearer error than the
  // downstream map-build losing a row.
  const seenKeys = new Set<string>();
  for (const s of V2_STABLES) {
    const key = `${s.chainId}-${s.address}`;
    if (seenKeys.has(key)) {
      throw new Error(
        `[v2Stables/config] Duplicate (chainId, address) entry in V2_STABLES: ${key}. ` +
          `Check EXCLUDED_FROM_V2 / EXTERNAL_STABLES / NATIVE_GAS filters and the hardcoded V3_HUB_USDM_INFO.`,
      );
    }
    seenKeys.add(key);
  }
}

// Address-keyed lookup used by the Transfer handler. Key shape mirrors the
// other indexer maps: `{chainId}-{lowercaseAddress}`.
const _byAddress = new Map<string, V2StableInfo>(
  V2_STABLES.map((s) => [`${s.chainId}-${s.address}`, s]),
);

export const findV2StableByAddress = (
  chainId: number,
  address: string,
): V2StableInfo | undefined =>
  _byAddress.get(`${chainId}-${asAddress(address)}`);

// All lowercased addresses, for the YAML drift gate test in v2Stables.test.ts.
export const V2_STABLE_ADDRESSES: ReadonlyArray<string> = V2_STABLES.map(
  (s) => s.address,
);

// Stable identifier for the running-supply entity. Same shape as makePoolId.
export const makeV2StableSupplyId = (
  chainId: number,
  tokenAddress: string,
): string => `${chainId}-${asAddress(tokenAddress)}`;

// Stable identifier for the daily snapshot rows. Day is the UTC midnight
// timestamp (ts / 86400 * 86400).
export const makeStableSupplyDailySnapshotId = (
  chainId: number,
  tokenAddress: string,
  dayTimestamp: bigint,
): string => `${chainId}-${asAddress(tokenAddress)}-${dayTimestamp}`;
