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
- `src/lib/networks.ts` — All network definitions; delegates token/address-label derivation to `@mento-protocol/monitoring-config/tokens` (shared with metrics-bridge) and explorer URL defaults to `@mento-protocol/monitoring-config/chains`. Per-network `addressLabels` overrides still merge on top
- `next.config.ts` — Next.js configuration
- `vercel.json` — Vercel deployment settings
- `eslint.config.mjs` — ESLint flat config
- `postcss.config.mjs` — PostCSS + Tailwind CSS 4

## Commands

```bash
pnpm dev     # Start dev server
pnpm build   # Production build
pnpm start   # Start production server
pnpm lint    # Run ESLint
pnpm react-doctor  # Full react-doctor scan (also: `pnpm dashboard:react-doctor` from repo root)
```

## React Doctor

CI runs `react-doctor --diff origin/<base> --fail-on warning` on every PR
(see `.github/workflows/ci.yml` `ui` job). The CLI's `--diff` is
**file-level, not line-level**: it scans every source file the PR
touches in full, so editing a file that already has backlog warnings
will fail CI even if your change isn't what triggered them. Two ways
through:

- Fix the warnings (preferred — chips at the cleanup backlog).
- Add an inline `// react-doctor-disable-next-line <rule-id>` above the
  offending line with a one-line rationale, if the warning isn't
  actionable in your PR's scope.

Run `pnpm react-doctor` locally for a full scan.

Project-wide silences live in `react-doctor.config.json`. Current state:

- **Silenced project-wide** (stylistic, ~805 noise hits): the four
  `react-doctor/design-*` rules — `no-default-tailwind-palette`,
  `no-em-dash-in-jsx-text`, `no-redundant-size-axes`, `no-bold-heading`.
  `tailwind-palette` would require a brand-token migration; em-dashes
  are legitimate punctuation in our copy.
- **Silenced in tests/scripts only** (`__tests__`, `*.test.{ts,tsx}`,
  `*.spec.{ts,tsx}`, `scripts/**`): `react-doctor/no-secrets-in-client-code`
  (test fixtures use placeholder addresses) and `react-hooks/rules-of-hooks`
  (legitimate when shimming hook-shaped mocks).

### Cleanup backlog

After silencing, the codebase has 1 error and ~128 warnings. The
prioritized cleanup list, ratchet plan (un-silence design rules), and
operational follow-ups (bumping `react-doctor`, score-floor job, etc.)
all live in `BACKLOG.md` under "Follow-ups deferred from PR #367
(react-doctor diff gate)". Single source of truth — update there, not
here.

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

Token symbols and address labels come from `@mento-protocol/monitoring-config/tokens` — the shared derivation also used by metrics-bridge. Custom address labels (stored in Upstash Redis) merge on top and take precedence. Individual networks can also declare custom `addressLabels` overrides in `makeNetwork(...)`.

Prod networks share a single `NEXT_PUBLIC_HASURA_URL` (the multichain Envio endpoint) and filter by `chainId`. Explorer URL defaults come from `@mento-protocol/monitoring-config/chains` with per-network env overrides (`NEXT_PUBLIC_EXPLORER_URL_<NETWORK>`) for local dev.

## Notes

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
- High-signal axe-core checks live under `src/__tests__/a11y/` (badges, sortable tables, controls, skeletons). They run as part of `pnpm test`. Add a test there for any new shared semantic component (badge / pill / radiogroup / tablist / labelled control) so a refactor that drops the accessible name fails CI deterministically. Plotly internals are explicitly out of scope.

### URL state in client-only tables / filters

- Do **NOT** use `router.replace` for URL-as-state writes that don't need server involvement (sort key/dir, in-page filters, pagination, tabs). In the App Router it triggers an RSC payload refetch on the current segment (`?_rsc=...`) — measured ~700ms on the homepage in PR #314, which was the entire sort-click lag (~1.8s). Use `window.history.replaceState` instead, lazy-initialized from `useSearchParams` and synced via a `popstate` listener for browser back/forward. Canonical example: `src/lib/use-table-sort.ts`
- The lazy-init source MUST be `useSearchParams()`, not `window.location.search`. `useState` lazy initializers run on the SSR pass and the resulting state is serialized into the HTML payload — they DO NOT re-run on client hydration. Reading `window.location.search` directly returns `undefined`/empty on the server, so a user landing on `/leaderboard?range=90d&venue=v2` directly would hydrate to defaults and the `popstate` listener never fires on initial load (it's back/forward only). Use `useSearchParams()` for the SSR-pass read; switch to `window.location.search` only AFTER mount (e.g. inside `popstate` handlers and write-time URL rebuilds, where `replaceState` writes lag the `useSearchParams` snapshot). Caught by Cursor Bugbot bbc20b5f on PR #371.
- When mixing `replaceState`-based and `router.replace`-based URL writers on the **same page**, read sibling-written params from `window.location.search` (NOT from the closed-over `useSearchParams` snapshot) — `replaceState` doesn't notify Next's router, so `useSearchParams` lags. Concrete failure caught by Cursor + Codex on PR #314: `/pools` `setURL` was rebuilding URLs from the stale snapshot and silently dropping `poolsSort`/`poolsDir` on the next filter change. Pattern fix: `src/app/pools/page.tsx` `setURL`

### Time-unit math (FX-pool weekend)

- FX pools close Fri 21:00 UTC → Sun 23:00 UTC. All uptime / breach math uses **trading-seconds** (weekend subtracted)
- Live "open breach" math MUST use `tradingSecondsInRange(start, now)` (`src/lib/weekend.ts:110`), NEVER `now - start` directly
- The same column / KPI MUST NOT switch units between open and closed rows — closed rows read `criticalDurationSeconds` (already trading-seconds); the open-row branch must use the helper

### Threshold-derived metrics

- Per-event metrics that depend on a pool config value (e.g. peak severity % uses `rebalanceThreshold`) MUST capture the threshold at event time, NOT read the live `pool.rebalanceThreshold`
- Re-scoring history with the current threshold means a config change retroactively rewrites past severity — bad for incident review

### File-size budget

- Soft cap: 600 lines/file (split in the same PR before crossing). Hard cap: 1,000 lines, enforced by `max-lines` in `eslint.config.mjs`. See `/AGENTS.md` for full rule + rationale.
- Tab/route pages especially: if a file approaches 600 lines, extract per-tab modules under `_lib/` / `_components/` / `_tabs/` (Next.js App Router excludes underscore-prefixed dirs from routing). Reference: `src/app/pool/[poolId]/` for the pattern from PR #263.

### Hasura query hygiene

- Lifetime-aggregate metrics (uptime %, total breach count, cumulative volume) MUST come from a pre-rolled snapshot/rollup entity — NOT from a paginated list
- Hasura silently caps every query at 1000 rows; any `limit:` in a UI query also silently drops data. Curl-verify against hosted before shipping
- `_aggregate` queries are disabled on hosted Hasura — don't ship them
- Multi-field `order_by` MUST use array syntax `[{a: desc}, {b: asc}]`. Object syntax silently drops fields after the first
