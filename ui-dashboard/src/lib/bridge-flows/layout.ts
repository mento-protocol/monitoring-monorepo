/**
 * Shared layout tokens for the `/bridge-flows` charts row. Three cards
 * (volume, token-breakdown, top-bridgers) share the row and need to stay
 * close in height to read as a unit — centralizing the numbers here stops
 * silent drift when any one of them is tweaked.
 */

/** Plot / content area height in pixels — matches TimeSeriesChartCard. */
export const ROW_CHART_HEIGHT_PX = 200;

/** Default row count for the Top Bridgers list so its card matches the
 *  chart cards in the same row. Expanding to all entries is controlled by
 *  a separate constant. */
export const TOP_BRIDGERS_DEFAULT = 5;
export const TOP_BRIDGERS_EXPANDED = 25;
