/**
 * Bridge-flows-specific layout constants. Chart-height constant now lives
 * in `@/lib/plot` so the shared TimeSeriesChartCard + these sibling cards
 * stay aligned together.
 */

/** Default / expanded row count for the Top Bridgers list so its card
 *  visual size matches the adjacent chart cards in the same row. */
export const TOP_BRIDGERS_DEFAULT = 5;
export const TOP_BRIDGERS_EXPANDED = 25;

/** Sample window for the per-route avg delivery time tile. Drives both the
 *  `BRIDGE_DELIVERED_RECENT` query limit in page.tsx and the "last N delivered"
 *  label inside RouteDeliveryTile. */
export const ROUTE_STATS_LIMIT = 100;
