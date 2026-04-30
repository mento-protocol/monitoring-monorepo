// Tab identifiers, in display order. The first entry doubles as the default
// tab when the URL has no `?tab=` param.
export const TABS = [
  "providers",
  "swaps",
  "reserves",
  "rebalances",
  "liquidity",
  "oracle",
  "limits",
  "breaches",
  "ols",
] as const;

export type Tab = (typeof TABS)[number];

// Per-tab URL search-param key used to persist the search input. Stored as
// distinct keys (vs a single `?q=`) so switching tabs doesn't clobber the
// other tab's filter.
export const SEARCH_PARAM_BY_TAB: Record<Tab, string> = {
  providers: "providersQ",
  swaps: "swapsQ",
  reserves: "reservesQ",
  rebalances: "rebalancesQ",
  liquidity: "liquidityQ",
  oracle: "oracleQ",
  limits: "limitsQ",
  breaches: "breachesQ",
  ols: "olsQ",
};

export const MAX_TAB_LIMIT = 200;

// Below this many positive reward samples, p90/p95 are statistical noise —
// skip outlier highlighting on the rebalances table.
export const MIN_REWARD_SAMPLE_SIZE = 20;
