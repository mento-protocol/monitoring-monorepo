/**
 * ERC20 ABI fragments shared by every consumer that walks pool/token contracts
 * (ui-dashboard's pool-detail probe, metrics-bridge's reserve-collateral
 * enrichment). String-array form rather than viem-typed ABI so the
 * shared-config package stays viem-free — consumers feed this list into
 * `parseAbi(...)` to materialise a typed ABI on their side.
 *
 * Drift between the dashboard and the bridge here is harmless (ERC20 +
 * pool-pair shapes are stable interfaces) but duplicating selectors verbatim
 * across packages was ~30 LOC of pure copy-paste. Single canonical list
 * keeps `function symbol()` / `function decimals()` etc. in lockstep.
 *
 * Implementation note: the `as const` annotation preserves literal types so
 * `parseAbi(ERC20_ABI_SOURCES)` produces a strongly-typed ABI on the consumer
 * side rather than collapsing to `string[]`.
 */
export const ERC20_ABI_SOURCES = [
  "function balanceOf(address account) external view returns (uint256)",
  "function decimals() external view returns (uint8)",
  "function symbol() external view returns (string)",
  "function totalSupply() external view returns (uint256)",
] as const;

/**
 * Pool-pair token-getter ABI. `function token0() / token1()` — used during
 * reserve-collateral enrichment to identify the non-debt leg of the pool.
 * Stable across every FPMM pool implementation, kept here for parity with
 * the ERC20 fragments.
 */
export const POOL_PAIR_ABI_SOURCES = [
  "function token0() external view returns (address)",
  "function token1() external view returns (address)",
] as const;
