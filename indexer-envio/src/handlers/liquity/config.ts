import { requireContractAddress } from "../../contractAddresses.js";
import { asAddress } from "../../helpers.js";

export type LiquityMarketConfig = {
  chainId: number;
  collIndex: number;
  symbol: string;
  debtToken: string;
  collToken: string;
  collateralRegistry: string;
  troveManager: string;
  stabilityPool: string;
  borrowerOperations: string;
  troveNFT: string;
  sortedTroves: string;
  activePool: string;
  defaultPool: string;
  collSurplusPool: string;
  addressesRegistry: string;
  systemParams: string;
  cdpLiquidityStrategy: string;
  slug: string;
};

// ---------------------------------------------------------------------------
// v3 Liquity token addresses
//
// Debt tokens (GBPm / CHFm / JPYm) live in `@mento-protocol/contracts` under
// their bare symbol key and match `AddressesRegistry.boldToken()` on-chain.
// `USDm` in the package still resolves to v2 cUSD (`0x765de8…`) because the
// upstream entry hasn't been republished — kept hand-typed below until that
// lands. The dead-contract diagnostic in `systemParams.ts` catches the case
// where any of these go dead.
//
// Address-collision note: `CHFm` and `JPYm` here also appear in
// `config.multichain.mainnet.yaml` under `WormholeNttManager` and in
// `nttAddresses.json` as `nttManagerProxy`. That is intentional — Mento's v3
// stable tokens implement NttManager at the same proxy (single-contract NTT
// mode). Do not "consolidate" these.
// ---------------------------------------------------------------------------
type Sym = "GBPm" | "CHFm" | "JPYm";
const V3_COLL_TOKEN_USDM = "0x106cc9ff5a2c488780635be8afc07c68522b7ea5";

// Liquity's CollateralRegistry assigns each market a fixed index at deployment
// time (`addCollateral(index, ...)`). Order matches the on-chain registry; not
// derivable from contracts.json.
const COLL_INDEX_BY_SYMBOL: Record<Sym, number> = {
  GBPm: 0,
  CHFm: 1,
  JPYm: 2,
};

const SYMBOLS: ReadonlyArray<Sym> = ["GBPm", "CHFm", "JPYm"];
const LIQUITY_CHAIN_ID = 42220;

type Role =
  | "CollateralRegistry"
  | "TroveManager"
  | "StabilityPool"
  | "BorrowerOperations"
  | "TroveNFT"
  | "SortedTroves"
  | "ActivePool"
  | "DefaultPool"
  | "CollSurplusPool"
  | "AddressesRegistry"
  | "SystemParams";

const requireSymbolAddress = (
  chainId: number,
  role: Role,
  symbol: Sym,
): string => {
  // StabilityPool is the only CDP role behind a TransparentUpgradeableProxy
  // (the rest are direct CREATE3 deployments). `@mento-protocol/contracts`
  // publishes the proxy address under `StabilityPool${symbol}` (no v300
  // suffix) and the implementation singleton under
  // `StabilityPoolv300${symbol}`. We want the proxy — that's what
  // `AddressesRegistry.stabilityPool()` returns and what emits the events
  // we subscribe to. Confirmed on-chain for GBPm, CHFm, JPYm on 2026-05-19.
  const key =
    role === "StabilityPool" ? `${role}${symbol}` : `${role}v300${symbol}`;
  return asAddress(requireContractAddress(chainId, key));
};

const requireSharedAddress = (chainId: number, name: string): string =>
  asAddress(requireContractAddress(chainId, name));

const buildMarket = (symbol: Sym): LiquityMarketConfig => {
  const chainId = LIQUITY_CHAIN_ID;
  return {
    chainId,
    collIndex: COLL_INDEX_BY_SYMBOL[symbol],
    symbol,
    slug: symbol.toLowerCase(),
    debtToken: asAddress(requireContractAddress(chainId, symbol)),
    collToken: asAddress(V3_COLL_TOKEN_USDM),
    collateralRegistry: requireSymbolAddress(
      chainId,
      "CollateralRegistry",
      symbol,
    ),
    troveManager: requireSymbolAddress(chainId, "TroveManager", symbol),
    stabilityPool: requireSymbolAddress(chainId, "StabilityPool", symbol),
    borrowerOperations: requireSymbolAddress(
      chainId,
      "BorrowerOperations",
      symbol,
    ),
    troveNFT: requireSymbolAddress(chainId, "TroveNFT", symbol),
    sortedTroves: requireSymbolAddress(chainId, "SortedTroves", symbol),
    activePool: requireSymbolAddress(chainId, "ActivePool", symbol),
    defaultPool: requireSymbolAddress(chainId, "DefaultPool", symbol),
    collSurplusPool: requireSymbolAddress(chainId, "CollSurplusPool", symbol),
    addressesRegistry: requireSymbolAddress(
      chainId,
      "AddressesRegistry",
      symbol,
    ),
    systemParams: requireSymbolAddress(chainId, "SystemParams", symbol),
    cdpLiquidityStrategy: requireSharedAddress(chainId, "CDPLiquidityStrategy"),
  };
};

export const LIQUITY_MARKETS: ReadonlyArray<LiquityMarketConfig> =
  SYMBOLS.map(buildMarket);

export const makeCollateralId = (market: {
  chainId: number;
  troveManager: string;
}): string => `${market.chainId}-${asAddress(market.troveManager)}`;

export const marketByCollateralId = new Map(
  LIQUITY_MARKETS.map((market) => [makeCollateralId(market), market]),
);

export const marketByDebtToken = new Map(
  LIQUITY_MARKETS.map((market) => [
    `${market.chainId}-${market.debtToken}`,
    market,
  ]),
);

export const marketByAddressesRegistry = new Map(
  LIQUITY_MARKETS.map((market) => [
    `${market.chainId}-${market.addressesRegistry}`,
    market,
  ]),
);

const addressRoles = [
  "collateralRegistry",
  "troveManager",
  "stabilityPool",
  "borrowerOperations",
  "troveNFT",
  "activePool",
  "defaultPool",
] as const;

export const marketByContractAddress = new Map<string, LiquityMarketConfig>();

for (const market of LIQUITY_MARKETS) {
  for (const role of addressRoles) {
    marketByContractAddress.set(`${market.chainId}-${market[role]}`, market);
  }
}

export const findLiquityMarketByEventSource = (
  chainId: number,
  srcAddress: string,
): LiquityMarketConfig | undefined =>
  marketByContractAddress.get(`${chainId}-${asAddress(srcAddress)}`);

export const findLiquityMarketByDebtToken = (
  chainId: number,
  debtToken: string,
): LiquityMarketConfig | undefined =>
  marketByDebtToken.get(`${chainId}-${asAddress(debtToken)}`);

export const findLiquityMarketByAddressesRegistry = (
  chainId: number,
  addressesRegistry: string,
): LiquityMarketConfig | undefined =>
  marketByAddressesRegistry.get(`${chainId}-${asAddress(addressesRegistry)}`);

// Always-empty map preserved as a forward hook: historically liquity.json
// carried `poolFallbacks` to recover a collateralId for `CdpPool` events that
// arrive before the pool is associated with a market. No entries have ever
// been needed; keeping the lookup keeps callers stable if a future deployment
// requires one. To add an entry, populate this object directly with
// `${chainId}-${address.toLowerCase()}` keys mapping to the collateralId.
const POOL_FALLBACKS: Record<string, string> = {};

export const findCollateralIdByPoolFallback = (
  chainId: number,
  poolAddress: string,
): string | undefined => POOL_FALLBACKS[`${chainId}-${asAddress(poolAddress)}`];

const liquidityStrategyAddresses = new Set(
  LIQUITY_MARKETS.map((m) => `${m.chainId}-${m.cdpLiquidityStrategy}`),
);

/** Used by the Redemption handler to split rebalance-driven redemptions
 * (PR #31 in mento-protocol/bold — only the LiquidityStrategy can call
 * `redeemCollateralRebalancing`) from user-driven ones. The two paths fire
 * identical `Redemption` events on TroveManager; the discriminator is the
 * transaction's outer `to` address. */
export const isLiquidityStrategyAddress = (
  chainId: number,
  address: string | null | undefined,
): boolean =>
  address != null &&
  liquidityStrategyAddresses.has(`${chainId}-${asAddress(address)}`);
