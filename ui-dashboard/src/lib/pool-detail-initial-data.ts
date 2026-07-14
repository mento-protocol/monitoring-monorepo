import type { PoolBreakerConfigResponse } from "@/lib/queries/config";
import type { BrokerExchangeDailySnapshots24hResponse } from "@/lib/queries/broker";
import type {
  PoolDetailResponse,
  PoolThresholdsKnownExtResponse,
  PoolV2ExchangeResponse,
  PoolVpDeprecationExtResponse,
  PoolVpLifecycleDeprecationExtResponse,
  PoolVpOracleFreshnessExtResponse,
} from "@/lib/queries/pool-detail";

export type PoolDetailInitialData = {
  pool: PoolDetailResponse;
  thresholds?: PoolThresholdsKnownExtResponse | undefined;
  vpOracleFreshness?: PoolVpOracleFreshnessExtResponse | undefined;
  vpDeprecation?: PoolVpDeprecationExtResponse | undefined;
  vpLifecycleDeprecation?: PoolVpLifecycleDeprecationExtResponse | undefined;
  v2Exchange?: PoolV2ExchangeResponse | undefined;
  brokerExchange24h?: BrokerExchangeDailySnapshots24hResponse | undefined;
  /** Per-feed breaker config (trip-able breaker + MARKET_HOURS rows). Threaded
   *  to `<BreakerPanel />` and `<MarketHoursPill />` as `fallbackData` so both
   *  know their resolved shape on first paint. Only populated for FPMM pools
   *  with a `referenceRateFeedID` (mirrors the client query gate). */
  breakerConfig?: PoolBreakerConfigResponse | undefined;
  /** `Date.now()` at fetch completion. `fetchPoolDetailForSSR` age-gates the
   *  cached `breakerConfig` off this so a stale-while-revalidate cache entry
   *  can't serve arbitrarily-old operator-safety breaker state as first-paint
   *  fallback (issue #1257). Optional so test fixtures can omit it. */
  fetchedAt?: number | undefined;
};
