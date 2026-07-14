/**
 * Row counts for the `/volume` table skeletons — shared between the
 * client-side tables (`../_components/volume-table.tsx`,
 * `../_components/aggregator-breakdown-section.tsx`) and the route-level
 * `../loading.tsx` fallback.
 *
 * Zero-dependency module (no imports) so the Server Component route
 * fallback can import these directly: `volume-table.tsx` /
 * `aggregator-breakdown-section.tsx` are `"use client"` (SWR-backed), and
 * per this package's "Server vs client module boundaries" rule, shared
 * constants needed on both sides live in a standalone module rather than
 * being duplicated as bare numbers kept in sync by a comment (see
 * `src/lib/hasura-timeout.ts` for the established pattern).
 */

// The default (7d, v3) top-traders view consistently fills to `PAGE_LIMIT`
// (20, in volume-table.tsx) in production (verified via a live
// monitoring.mento.org measurement, 2026-07-13: 20 rows, thead 45px, each
// row 40px -> 845px real table height). `TableSkeleton`'s generic per-row
// geometry (36px header + 44px/row, calibrated off other tables) doesn't
// match this table's real rhythm exactly, so reserving all 20 rows
// overshoots (36 + 20*44 = 916px, +71px vs the 845px measurement). 18 rows
// (36 + 18*44 = 828px) lands within 24px of the measured full-page case —
// the closest achievable parity without editing the shared skeleton
// primitive's fixed row height. Windows with fewer than ~18 active traders
// will still shrink on load; that's an accepted tradeoff for a
// client-fetched table that can't know the real count before the query
// resolves.
export const TOP_TRADERS_TABLE_SKELETON_ROWS = 18;

// Aggregator/entry-point breakdowns typically resolve to a much smaller
// distinct-row count than `PAGE_LIMIT` (50, in
// aggregator-breakdown-section.tsx) — reserving the full cap would
// over-shoot the real table's height on every load. 6 matches the
// production skeleton-parity audit's measured aggregator-section delta
// (issue #1221).
export const AGGREGATOR_TABLE_SKELETON_ROWS = 6;
