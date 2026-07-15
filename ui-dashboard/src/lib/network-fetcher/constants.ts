export const SNAPSHOT_PAGE_SIZE = 1000;
export const SECONDS_PER_DAY = 86_400;

/**
 * Number of recent UTC-day PoolDailySnapshot buckets carried across the
 * Server → Client boundary for `/` and `/pools`. Thirty-day charts and KPI
 * windows fit entirely inside this seed; the projection also keeps one older
 * anchor per pool so TVL can forward-fill quiet pools. The "All" range
 * explicitly requests the normal full-history client payload before rendering.
 */
export const INITIAL_SNAPSHOT_HISTORY_DAYS = 30;
