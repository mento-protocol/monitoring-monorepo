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
};
