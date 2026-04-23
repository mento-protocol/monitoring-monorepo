# AGENTS.md — Monitoring Dashboard

## What This Is

Next.js 16 monitoring dashboard for Mento v3 pools. Displays real-time pool data (reserves, swaps, mints, burns) using Plotly.js charts, sourced from Hasura GraphQL.

## Before Opening PRs

If your dashboard change touches stateful data flow — pagination, sort, search, charts tied to table state, GraphQL shape changes, degraded/error behavior, or any indexer→query→UI field path — read and apply:

- `../docs/pr-checklists/stateful-data-ui.md`

This is mandatory for cross-layer/stateful UI work. The checklist exists because this repo repeatedly burned review cycles on exactly these failure modes.

## Key Files

- `src/app/` — Next.js App Router pages and layouts
- `src/lib/` — Data fetching utilities, GraphQL queries, address book
- `src/lib/networks.ts` — All network definitions; derives token symbols and address labels from `@mento-protocol/contracts` using the active namespace from `shared-config`
- `next.config.ts` — Next.js configuration
- `vercel.json` — Vercel deployment settings
- `eslint.config.mjs` — ESLint flat config
- `postcss.config.mjs` — PostCSS + Tailwind CSS 4

## Commands

```bash
pnpm dev    # Start dev server
pnpm build  # Production build
pnpm start  # Start production server
pnpm lint   # Run ESLint
```

## Tech Stack

- **Next.js 16** (App Router, React Server Components)
- **React 19** + React DOM 19
- **Plotly.js** (via react-plotly.js) for charts
- **SWR** for data fetching + real-time updates
- **graphql-request** for Hasura queries
- **Tailwind CSS 4** for styling

## Multi-Chain Support

The dashboard supports multiple network targets (all defined in `src/lib/networks.ts`):

| ID                   | Chain         | Mode  |
| -------------------- | ------------- | ----- |
| `devnet`             | Celo devnet   | local |
| `celo-sepolia-local` | Celo Sepolia  | local |
| `celo-mainnet-local` | Celo Mainnet  | local |
| `celo-mainnet`       | Celo Mainnet  | prod  |
| `monad-mainnet`      | Monad Mainnet | prod  |

Token symbols and address labels are derived automatically from `@mento-protocol/contracts` using the active treb namespace from `shared-config/deployment-namespaces.json`. Custom address labels (stored in Upstash Redis) merge on top and take precedence. Individual networks can also declare custom `addressLabels` overrides in `makeNetwork(...)`.

Prod networks share a single `NEXT_PUBLIC_HASURA_URL` (the multichain Envio endpoint) and filter by `chainId`. Explorer URLs are per-network (`NEXT_PUBLIC_EXPLORER_URL_<NETWORK>`).

## Notes

- Contract addresses come from `@mento-protocol/contracts` — no vendored JSON
- The dashboard is purely read-only — no transactions, no wallet connections
- Charts auto-refresh via SWR polling

## UI patterns the bots keep catching

These are the rules `cursor[bot]` and Codex have raised repeatedly across PRs #185–#202. Apply them locally; don't make reviewers re-derive them.

### SWR / `useGQL`

- Every Hasura-polling hook MUST set `revalidateOnFocus: false` AND `revalidateOnReconnect: false`. Fix the default at `src/lib/graphql.ts` (the `useGQL` wrapper at line 25), NOT at every call site
- Canonical good example: `src/lib/bridge-flows/use-bridge-gql.ts:42-51` — copy that block (and its comment) when wiring a new polling hook outside `useGQL`
- Pair `AbortSignal.timeout(8_000)` with the 10s refresh interval; a wedged TCP connection otherwise compounds into unbounded backpressure
- If you set both revalidation gates to `false`, SWR's `onErrorRetry` no longer pauses for hidden/offline tabs — gate retries explicitly on `document.visibilityState` or keep one revalidation gate enabled
- `refreshInterval: 0` STOPS scheduling. Don't use a "pause when hidden" helper that returns 0 — return a large number instead, or pair with a revalidation gate
- See `../docs/pr-checklists/swr-polling-hasura.md` for the full checklist

### Loading vs zero vs empty

- `data === undefined && !error` is the loading state — render `—` or a skeleton, NEVER a happy-path zero ("100% / no breaches")
- Gate display on `isLoading`, not just on `error` and "data is truthy". PR #194 shipped `breaches = data ?? []` and rendered "100.000% / no breaches" before the query resolved

### Async button race + cleanup

- Buttons that trigger async work MUST be disabled until completion (otherwise a fast double-click submits twice)
- Wire an `AbortController` to fetch and abort it on unmount
- Transient RPC errors during teardown MUST NOT fire toasts — check the abort signal before surfacing the error

### Dynamic content accessibility

- Toasts and any dynamically-changing status text MUST live inside an element with `role="status"` (polite) or `role="alert"` (assertive)
- Sortable table headers expose `aria-sort` (already enforced by the stateful-data-ui checklist)

### Time-unit math (FX-pool weekend)

- FX pools close Fri 21:00 UTC → Sun 23:00 UTC. All uptime / breach math uses **trading-seconds** (weekend subtracted)
- Live "open breach" math MUST use `tradingSecondsInRange(start, now)` (`src/lib/weekend.ts:110`), NEVER `now - start` directly
- The same column / KPI MUST NOT switch units between open and closed rows — closed rows read `criticalDurationSeconds` (already trading-seconds); the open-row branch must use the helper

### Threshold-derived metrics

- Per-event metrics that depend on a pool config value (e.g. peak severity % uses `rebalanceThreshold`) MUST capture the threshold at event time, NOT read the live `pool.rebalanceThreshold`
- Re-scoring history with the current threshold means a config change retroactively rewrites past severity — bad for incident review

### Hasura query hygiene

- Lifetime-aggregate metrics (uptime %, total breach count, cumulative volume) MUST come from a pre-rolled snapshot/rollup entity — NOT from a paginated list
- Hasura silently caps every query at 1000 rows; any `limit:` in a UI query also silently drops data. Curl-verify against hosted before shipping
- `_aggregate` queries are disabled on hosted Hasura — don't ship them
- Multi-field `order_by` MUST use array syntax `[{a: desc}, {b: asc}]`. Object syntax silently drops fields after the first
