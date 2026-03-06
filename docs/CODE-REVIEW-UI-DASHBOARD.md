# Code Review — `ui-dashboard`

> Reviewed by Giskard · 2026-03-05  
> Branch: `chore/ui-dashboard-cleanup`  
> Scope: `ui-dashboard/src/` (all app pages, components, lib modules, tests)

---

## Summary

The dashboard is well-structured and readable overall. The main themes are:

1. **Dead exports** that were never wired up to the UI
2. **Copy-pasted Plotly layout config** across three chart components
3. A **React Rules of Hooks violation** in `AnalyticsTab`
4. **No tests** for `format.ts` despite it being pure utility logic with edge cases

Applied refactors are marked ✅. Suggestions for follow-up are marked 💡.

---

## 1. Dead Code ✅ (removed in this PR)

### Dead query exports (`lib/queries.ts`)

Three exports were never imported anywhere in the dashboard source:

| Export              | Status                                         |
| ------------------- | ---------------------------------------------- |
| `ALL_POOLS`         | Dead — superseded by `ALL_POOLS_WITH_HEALTH`   |
| `POOL_DETAIL`       | Dead — superseded by `POOL_DETAIL_WITH_HEALTH` |
| `GLOBAL_AGGREGATES` | Dead — no UI consumption                       |

**Action:** Removed all three. If needed for future tooling/scripts, they can be re-added then.

### Unused import (`app/pools/page.tsx`)

`TxHashCell` was imported but never rendered (the `SwapTable` in this file shows sender/recipient but not tx hash).

**Action:** Removed the import.

### Stale React import (`components/table.tsx`)

```ts
// Before
import React from "react";

// After
import type { ReactNode } from "react";
```

With the modern JSX transform (`"jsx": "react-jsx"` in tsconfig), `React` doesn't need to be in scope. The only reason it was needed was for `React.ReactNode` type annotations. Changed to a type-only import of `ReactNode` directly.

---

## 2. Duplication ✅ (refactored in this PR)

### Plotly layout boilerplate

Three chart components (`oracle-chart.tsx`, `reserve-chart.tsx`, `snapshot-chart.tsx`) each had ~50 lines of near-identical Plotly layout config:

```ts
// Repeated verbatim in all three charts:
paper_bgcolor: "transparent",
plot_bgcolor: "transparent",
font: { color: "#94a3b8", size: 12 },
// xaxis with rangeslider + rangeselector...
// legend styling...
// margin: { t: 16, r: 60, b: 8, l: 60 }
```

**Action:** Extracted to `lib/plot.ts` with:

- `PLOTLY_BASE_LAYOUT` — canvas/font defaults
- `PLOTLY_AXIS_DEFAULTS` — grid/line/tick colors
- `PLOTLY_LEGEND` — legend styling
- `PLOTLY_MARGIN` — standard margins
- `PLOTLY_CONFIG` — standard Plotly config object
- `RANGE_SELECTOR_BUTTONS_DAILY` / `RANGE_SELECTOR_BUTTONS_HOURLY` — time presets
- `makeDateXAxis(buttons)` — factory for date-type xaxis with rangeslider + rangeselector

Charts now import and spread these constants, reducing layout config to ~10 lines each.

### Repeated table header row

💡 Every tab/table repeats:

```tsx
<tr className="border-b border-slate-800 bg-slate-900/50">
```

This appears ~8 times. Consider adding a `<Thead>` component to `table.tsx`:

```tsx
export function Thead({ children }: { children: React.ReactNode }) {
  return (
    <tr className="border-b border-slate-800 bg-slate-900/50">{children}</tr>
  );
}
```

### Swap direction logic

💡 This block is duplicated in `SwapsTab` (`pool/[poolId]/page.tsx`) and `SwapTable` (`pools/page.tsx`):

```ts
const soldToken0 = BigInt(s.amount0In) > BigInt(0);
const soldAmt = soldToken0 ? s.amount0In : s.amount1In;
const boughtAmt = soldToken0 ? s.amount1Out : s.amount0Out;
```

Consider extracting to a helper in `lib/format.ts` or a shared utility:

```ts
export function resolveSwapDirection(swap: SwapEvent) {
  const soldToken0 = BigInt(swap.amount0In) > 0n;
  return {
    soldAmt: soldToken0 ? swap.amount0In : swap.amount1In,
    boughtAmt: soldToken0 ? swap.amount1Out : swap.amount0Out,
    soldToken0,
  };
}
```

### `parseOraclePrice` duplicated

💡 A `parseOraclePrice` private function exists in both `health-panel.tsx` and `oracle-price-chart.tsx`. They do slightly different things (one returns a string, one a number), but the core division logic is identical. Consider moving to `lib/format.ts`.

---

## 3. React Rules of Hooks Violation ✅ (fixed in this PR)

**File:** `app/pool/[poolId]/page.tsx` — `AnalyticsTab` function

```tsx
// BEFORE — hooks called after conditional return (rules of hooks violation!)
function AnalyticsTab({ poolId, limit, pool }) {
  const { network } = useNetwork();

  if (pool && !isFpmm(pool)) {          // ← early return
    return <EmptyBox ... />;
  }

  const { data, error, isLoading } = useGQL(POOL_SNAPSHOTS, ...);   // ← hook after conditional!
  const { data: oracleData } = useGQL(ORACLE_SNAPSHOTS, ...);       // ← hook after conditional!
```

React requires all hooks to be called unconditionally on every render. Calling `useGQL` (which wraps `useSWR`) after a conditional early return means the hook call count changes between renders, leading to subtle bugs.

**Fix:** Move both `useGQL` calls before the conditional, and pass `null` as the query key (which `useGQL` already supports to skip fetching) when the pool is a VirtualPool:

```tsx
const isFpmmPool = pool ? isFpmm(pool) : true;
const { data, error, isLoading } = useGQL(isFpmmPool ? POOL_SNAPSHOTS : null, ...);
const { data: oracleData } = useGQL(isFpmmPool ? ORACLE_SNAPSHOTS : null, ...);

if (pool && !isFpmmPool) {
  return <EmptyBox ... />;
}
```

---

## 4. Type Safety

### Unused `Pool` type fields

💡 `types.ts` defines `blockTimestampInPool` on `ReserveUpdate`, but it's never used in any component or query. The field should be removed to keep the type in sync with what's actually consumed.

```ts
// types.ts — ReserveUpdate
blockTimestampInPool: string; // ← never used, remove
```

### Unused GQL fields

💡 `POOL_SNAPSHOTS` query requests `reserves0`, `reserves1`, `cumulativeVolume0`, `cumulativeVolume1` — none of these are rendered anywhere in the UI. They inflate payload size for no benefit.

Similarly, `POOL_DETAIL_WITH_HEALTH` requests `oracleExpiry` but `HealthPanel` never renders it.

### `healthStatus` typed as `string` not `HealthStatus`

💡 `Pool.healthStatus` is typed as `string | undefined` in `types.ts`, but there's a perfectly good `HealthStatus` union type in `lib/health.ts`. Using the union would give compile-time safety:

```ts
// types.ts
import type { HealthStatus } from "./health";

export type Pool = {
  // ...
  healthStatus?: HealthStatus;
};
```

### `OracleSnapshot.rebalanceThreshold` typed as `number`

💡 This field comes from GraphQL (Hasura) as a numeric type. If the schema ever returns it as a string (common with large integers), runtime code like `s.rebalanceThreshold === 0` would silently fail. Worth adding a note or normalising at the query layer.

---

## 5. Component Structure

### `pool/[poolId]/page.tsx` is ~650 lines

💡 This single file contains 8 component functions (`PoolDetail`, `PoolHeader`, `Stat`, `SwapsTab`, `ReservesTab`, `RebalancesTab`, `LiquidityTab`, `OracleTab`, `AnalyticsTab`), each with its own data-fetching via SWR. Splitting into separate files (e.g. `pool-tabs/swaps-tab.tsx`) would improve navigability. No functional problem, just maintainability.

### `Stat` component is private to pool detail page

💡 The `Stat` (label/value definition-list item) component in `pool/[poolId]/page.tsx` would be useful elsewhere. Consider exporting from a shared UI file.

---

## 6. Naming

### `app/pools/page.tsx` exports `HomePage`

💡 The file at `src/app/pools/page.tsx` (route: `/pools`) exports a component named `HomePage`. This is misleading — `HomeContent` is the real home page component at `src/app/page.tsx`. Should be renamed to `PoolsPage` / `PoolsContent` to match the route.

### `OracleTab` in `pool/[poolId]/page.tsx` vs `OracleChart` / `OraclePriceChart`

💡 There are two oracle-related chart components: `OracleChart` (in the Analytics tab, shows history + deviation) and `OraclePriceChart` (in the Oracle tab). The naming is confusingly swapped — `OraclePriceChart` shows the simpler view while `OracleChart` is the more complex analytics view. Consider renaming: `OracleAnalyticsChart` vs `OraclePriceHistoryChart`.

---

## 7. Test Coverage ✅ (added in this PR)

Added `src/lib/__tests__/format.test.ts` with 31 tests covering:

- `truncateAddress` — null, short, and standard addresses
- `parseWei` — empty, zero, 18-decimal, custom decimals
- `formatWei` — zero, 1 token, large numbers, very small (exponential)
- `formatBlock` — locale formatting
- `formatTimestamp` — zero/empty sentinel, valid timestamp
- `relativeTime` — zero/empty, seconds, minutes, hours, days, future timestamps
- `isValidAddress` — valid, missing prefix, too short, invalid chars, empty

### Remaining coverage gaps

💡 `lib/tokens.ts` tests only cover `tokenSymbol` and `poolName`. Missing:

- `buildPoolNameMap`
- `hasLabel`
- `addressLabel`
- `isFpmm`
- `explorerAddressUrl` / `explorerTxUrl`

---

## 8. Performance

### `BigInt` allocation in render hot path

💡 In `SwapsTab` and `SwapTable`, every swap row creates two `BigInt` objects per render:

```ts
const soldToken0 = BigInt(s.amount0In) > BigInt(0);
```

`BigInt("0")` is equivalent to `0n` (literal). For large tables this is minor but avoidable:

```ts
const soldToken0 = s.amount0In !== "0" && s.amount0In !== "";
```

(since the indexer always stores `"0"` for the zero side of a swap)

### SWR `refreshInterval` not configurable per call site

💡 `useGQL` hardcodes `refreshInterval = 10_000` (10s). This is a reasonable default but some views (e.g. oracle snapshots that update rarely) might benefit from a longer interval to reduce load. Consider making the parameter configurable per call site.

---

## 9. Next.js Patterns

### All pages are `"use client"` components

💡 `app/page.tsx`, `app/pools/page.tsx`, and `app/pool/[poolId]/page.tsx` are all client components. This means the initial HTML is empty until JS hydrates. Metadata (`<title>`, SEO) benefits are limited for pool-specific pages.

Consider a hybrid approach: a Server Component shell that renders metadata + a `<Suspense>`-wrapped client component for the interactive parts. The current architecture works fine, this is a quality-of-life improvement.

### Correct: `Suspense` wrapping for `useSearchParams`

The existing pattern of wrapping each page's `*Content` component in `<Suspense>` is correct for Next.js App Router. `useSearchParams()` requires a Suspense boundary. ✅

### Correct: `"use client"` directive placement

All components that use hooks (`useState`, `useSWR`, context) correctly have `"use client"` at the top. Pure presentational components (`table.tsx`, `feedback.tsx`, `badges.tsx`) are server-compatible (no directive needed). ✅

---

## Files Changed in This PR

| File                                | Change                                                               |
| ----------------------------------- | -------------------------------------------------------------------- |
| `src/lib/queries.ts`                | Remove dead exports: `ALL_POOLS`, `POOL_DETAIL`, `GLOBAL_AGGREGATES` |
| `src/lib/plot.ts`                   | **New** — shared Plotly layout constants and helpers                 |
| `src/lib/__tests__/format.test.ts`  | **New** — 31 tests for `lib/format.ts`                               |
| `src/app/pools/page.tsx`            | Remove unused `TxHashCell` import                                    |
| `src/app/pool/[poolId]/page.tsx`    | Fix Rules of Hooks violation in `AnalyticsTab`                       |
| `src/components/table.tsx`          | Fix `React` import → `import type { ReactNode }`                     |
| `src/components/oracle-chart.tsx`   | Use shared Plotly layout from `lib/plot.ts`                          |
| `src/components/reserve-chart.tsx`  | Use shared Plotly layout from `lib/plot.ts`                          |
| `src/components/snapshot-chart.tsx` | Use shared Plotly layout from `lib/plot.ts`                          |
