import _contractsJson from "@mento-protocol/contracts/contracts.json" with { type: "json" };
import nttAddresses from "../../../config/nttAddresses.json" with { type: "json" };
import { V3_HUB_USDM_ADDRESS } from "../../constants.js";
import {
  CONTRACT_NAMESPACE_BY_CHAIN,
  type ContractsJson,
} from "../../contractAddresses.js";
import { asAddress } from "../../helpers.js";

// ---------------------------------------------------------------------------
// Mento stablecoin registry for the /stables dashboard page.
//
// Subscribes Transfer(from=0, to=0) events on each token via the V2StableToken
// contract entry in `config.multichain.mainnet.yaml`. For each event the
// handler writes a StableSupplyDailySnapshot + V2StableSupplyChangeEvent row
// using the canonical `source` discriminator below.
//
// Three discriminators:
//   V2_RESERVE          — reserve-backed stables that mint/burn via Broker or
//                         Wormhole NTT. 12 Celo tokens are brand-named in
//                         @mento-protocol/contracts (USDm aliases the V2 cUSD
//                         address 0x765de8…). Monad EURm/USDm are generated
//                         from the NTT manifest and tracked the same way.
//   V3_HUB_COLLATERAL   — the V3 hub USDm at 0x106cc… (a distinct contract
//                         from V2 cUSD-USDm). Hand-typed below because the
//                         contracts package's bare `USDm` key still resolves
//                         to V2 cUSD — see indexer-envio/src/handlers/liquity/
//                         config.ts:28-33 for the same rationale.
//   V3_LIQUITY          — Bold-style CDP debt tokens (GBPm/CHFm/JPYm). Celo
//                         supply is derived from LiquityInstance.systemDebt in
//                         src/handlers/liquity/instance.ts at daily flush.
//                         Monad bridged debt tokens are burn/mint NTT tokens,
//                         so their Monad supply is tracked from Transfer-zero
//                         events and classified with this same source.
//
// Celo CHFm/GBPm/JPYm are lock/mint NTT tokens. Their Celo token supply is
// already covered by Liquity systemDebt, so they are intentionally excluded
// from V2_STABLES and tracked by the custody handler only. The dashboard
// subtracts their NTT manager balances from Celo supply to avoid double
// counting the same units that exist as minted Monad supply.
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
const MONAD_CHAIN_ID = 143;

// V3 Liquity Bold debt tokens — supply tracked via LiquityInstance.systemDebt,
// not via the Celo V2 Transfer-zero subscription.
const EXCLUDED_FROM_V2 = new Set(["GBPm", "CHFm", "JPYm"]);
// External bridged stables — not Mento-issued.
const EXTERNAL_STABLES = new Set(["USDC", "USDT", "axlUSDC", "axlEUROC"]);
// Native gas tokens — never appear as a Mento stable.
const NATIVE_GAS = new Set(["CELO"]);

// Sanity check at module load. If @mento-protocol/contracts drops or renames
// one of these symbols, throw immediately rather than silently producing an
// incomplete registry on the next sync.
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

const EXPECTED_MONAD_NTT_SYMBOLS = new Set([
  "CHFm",
  "EURm",
  "GBPm",
  "JPYm",
  "USDm",
]);

export type NttBridgeMode = "LOCKING" | "BURNING";

type NttAddressEntry = {
  chainId: number;
  tokenSymbol: string;
  tokenAddress: string;
  tokenDecimals: number;
  nttManagerProxy: string;
};

export type NttStableInfo = V2StableInfo & {
  bridgeMode: NttBridgeMode;
  nttManagerAddress: string;
};

const NTT_BRIDGE_MODE_BY_TOKEN = new Map<string, NttBridgeMode>([
  // Live NttManager.mode() on 2026-06-03:
  // 0 = LOCKING, 1 = BURNING. See Wormhole NTT manager mode().
  ["42220:0xb55a79f398e759e43c95b979163f30ec87ee131d", "LOCKING"], // CHFm
  ["42220:0xd8763cba276a3738e6de85b4b3bf5fded6d6ca73", "BURNING"], // EURm
  ["42220:0xccf663b1ff11028f0b19058d0f7b674004a40746", "LOCKING"], // GBPm
  ["42220:0xc45ecf20f3cd864b32d9794d6f76814ae8892e20", "LOCKING"], // JPYm
  ["42220:0x765de816845861e75a25fca122bb6898b8b1282a", "BURNING"], // USDm
  ["143:0xf64e91ffef7ef43aa314f0bc2ac39f770797990c", "BURNING"], // CHFm
  ["143:0x4d502d735b4c574b487ed641ae87ceae884731c7", "BURNING"], // EURm
  ["143:0x39bb4e0a204412bb98e821d25e7d955e69d40fd1", "BURNING"], // GBPm
  ["143:0x22f6a6752800eab67b84748fefc3cc658384af72", "BURNING"], // JPYm
  ["143:0xbc69212b8e4d445b2307c9d32dd68e2a4df00115", "BURNING"], // USDm
]);

const nttEntries = (nttAddresses as { entries: NttAddressEntry[] }).entries;

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

const sourceForNttStable = (entry: NttAddressEntry): StableSupplySource => {
  if (EXCLUDED_FROM_V2.has(entry.tokenSymbol)) return "V3_LIQUITY";
  return "V2_RESERVE";
};

const buildNttStables = (): ReadonlyArray<NttStableInfo> => {
  const out: NttStableInfo[] = [];
  for (const entry of nttEntries) {
    const tokenAddress = entry.tokenAddress.toLowerCase();
    const managerAddress = entry.nttManagerProxy.toLowerCase();
    const bridgeMode = NTT_BRIDGE_MODE_BY_TOKEN.get(
      `${entry.chainId}:${tokenAddress}`,
    );
    if (!bridgeMode) {
      throw new Error(
        `[v2Stables/config] Missing NTT bridge mode for ${entry.tokenSymbol} ${tokenAddress} on chain ${entry.chainId}. ` +
          `Verify NttManager.mode() and update NTT_BRIDGE_MODE_BY_TOKEN.`,
      );
    }
    out.push({
      chainId: entry.chainId,
      address: tokenAddress,
      symbol: entry.tokenSymbol,
      decimals: entry.tokenDecimals,
      source: sourceForNttStable(entry),
      bridgeMode,
      nttManagerAddress: managerAddress,
    });
  }
  return out;
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

  // Append Monad NTT supplies. These are all burn/mint on Monad, so the
  // chain-local totalSupply is real supply and can be added directly to the
  // Celo circulating supply after the dashboard subtracts any Celo lock
  // custody.
  for (const ntt of NTT_STABLES) {
    if (ntt.chainId !== MONAD_CHAIN_ID) continue;
    out.push({
      chainId: ntt.chainId,
      address: ntt.address,
      symbol: ntt.symbol,
      decimals: ntt.decimals,
      source: ntt.source,
    });
  }
  return out;
};

export const NTT_STABLES: ReadonlyArray<NttStableInfo> = buildNttStables();

export const LOCK_AND_MINT_NTT_STABLES: ReadonlyArray<NttStableInfo> =
  NTT_STABLES.filter((s) => s.bridgeMode === "LOCKING");

export const V2_STABLES: ReadonlyArray<V2StableInfo> = buildV2Stables();

// Invariant check: every EXPECTED V2 reserve symbol resolved successfully.
// If the package drops one, throw at module load so the indexer fails fast
// rather than silently under-tracking a token.
{
  const v2ReserveSymbols = new Set(
    V2_STABLES.filter(
      (s) => s.chainId === V2_STABLE_CHAIN_ID && s.source === "V2_RESERVE",
    ).map((s) => s.symbol),
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
  if (usdmEntries.length !== 3) {
    throw new Error(
      `[v2Stables/config] Expected exactly 3 USDm entries (Celo V2 cUSD-USDm + Celo V3 hub USDm + Monad USDm), found ${usdmEntries.length}. ` +
        `If @mento-protocol/contracts now ships USDm at ${V3_HUB_USDM_ADDRESS}, remove V3_HUB_USDM_INFO from this file.`,
    );
  }
  const celoUsdmEntries = usdmEntries.filter(
    (s) => s.chainId === V2_STABLE_CHAIN_ID,
  );
  if (celoUsdmEntries.length !== 2) {
    throw new Error(
      `[v2Stables/config] Expected exactly 2 Celo USDm entries (V2 cUSD-USDm + V3 hub USDm), found ${celoUsdmEntries.length}.`,
    );
  }
  const [firstUsdm, secondUsdm] = celoUsdmEntries;
  if (firstUsdm && secondUsdm && firstUsdm.address === secondUsdm.address) {
    throw new Error(
      `[v2Stables/config] Both Celo USDm entries resolved to the same address ${firstUsdm.address}. ` +
        `@mento-protocol/contracts likely republished USDm at the V3 hub address — remove V3_HUB_USDM_INFO from this file.`,
    );
  }
  const monadSymbols = new Set(
    V2_STABLES.filter((s) => s.chainId === MONAD_CHAIN_ID).map((s) => s.symbol),
  );
  for (const expected of EXPECTED_MONAD_NTT_SYMBOLS) {
    if (!monadSymbols.has(expected)) {
      throw new Error(
        `[v2Stables/config] Expected Monad NTT stable ${expected} missing from config/nttAddresses.json.`,
      );
    }
  }
  for (const lockAndMint of LOCK_AND_MINT_NTT_STABLES) {
    if (lockAndMint.chainId !== V2_STABLE_CHAIN_ID) {
      throw new Error(
        `[v2Stables/config] Unexpected lock/mint NTT token ${lockAndMint.symbol} on chain ${lockAndMint.chainId}. ` +
          `Dashboard custody subtraction only handles source-chain locked balances.`,
      );
    }
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

const _lockAndMintNttByAddress = new Map<string, NttStableInfo>(
  LOCK_AND_MINT_NTT_STABLES.map((s) => [`${s.chainId}-${s.address}`, s]),
);

export const findV2StableByAddress = (
  chainId: number,
  address: string,
): V2StableInfo | undefined =>
  _byAddress.get(`${chainId}-${asAddress(address)}`);

export const findLockAndMintNttStableByAddress = (
  chainId: number,
  address: string,
): NttStableInfo | undefined =>
  _lockAndMintNttByAddress.get(`${chainId}-${asAddress(address)}`);

// All lowercased addresses, for the YAML drift gate test in v2Stables.test.ts.
export const V2_STABLE_ADDRESSES: ReadonlyArray<string> = V2_STABLES.map(
  (s) => s.address,
);

export const LOCK_AND_MINT_NTT_STABLE_ADDRESSES: ReadonlyArray<string> =
  LOCK_AND_MINT_NTT_STABLES.map((s) => s.address);

export const STABLE_TOKEN_CUSTODY_TRANSFER_WHERE_PARAMS: ReadonlyArray<
  { from: `0x${string}` } | { to: `0x${string}` }
> = LOCK_AND_MINT_NTT_STABLES.flatMap((s) => [
  { from: s.nttManagerAddress as `0x${string}` },
  { to: s.nttManagerAddress as `0x${string}` },
]);

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

export const makeStableTokenCustodyId = (
  chainId: number,
  tokenAddress: string,
): string => `${chainId}-${asAddress(tokenAddress)}`;

export const makeStableTokenCustodyDailySnapshotId = (
  chainId: number,
  tokenAddress: string,
  dayTimestamp: bigint,
): string => `${chainId}-${asAddress(tokenAddress)}-${dayTimestamp}`;
