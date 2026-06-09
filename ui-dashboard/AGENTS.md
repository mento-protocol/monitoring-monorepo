---
title: Monitoring Dashboard Instructions
status: active
owner: eng
canonical: true
last_verified: 2026-05-20
---

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

## Browser target — ES2017, no polyfill

`tsconfig.json` sets `"target": "ES2017"`. There's no `browserslist` override or polyfill installed. The TS `lib: ["dom", "dom.iterable", "esnext"]` provides type definitions for ES2023+ methods, so they compile cleanly — but at runtime they throw `TypeError: <fn> is not a function` on Safari ≤15 / Chrome ≤109 / Firefox ≤114.

**Never use** in client-shipped code: `Array.prototype.toSorted`, `findLast`, `findLastIndex`, `with`, `Object.groupBy`, `String.prototype.isWellFormed`, etc. Use the ES2017-safe forms instead (`[...arr].sort(...)`, manual loops). PR #371 was flagged 5× on `arr.toSorted()` sites; reverted to `[...arr].sort()` with inline `react-doctor-disable-next-line react-doctor/js-tosorted-immutable` disables.

**Server-only paths where ES2023+ IS safe** (run on Node ≥20): `app/api/**/route.ts`, OG helpers (`lib/homepage-og.ts`, `lib/pool-og.ts`), `*.test.ts(x)`. Anything imported by a `"use client"` component, or by code that flows into one (e.g. `lib/tag-suggestions.ts` → `address-label-form.tsx`), ships to the browser.

If we ever raise the TS target to ES2022+ or install a global polyfill (`core-js`), all existing `react-doctor/js-tosorted-immutable` inline disables become candidates for cleanup.

## Commands

```bash
pnpm dev     # Start dev server
pnpm build   # Production build
pnpm start   # Start production server
pnpm lint    # Run ESLint
pnpm test:browser  # Fixture-driven Playwright browser interaction tests
pnpm test:browser:production  # Build-backed fixture browser tests via next start
pnpm test:mutation  # Targeted StrykerJS baseline for src/lib/weekend.ts
pnpm react-doctor  # Full react-doctor scan (also: `pnpm dashboard:react-doctor` from repo root)
pnpm react-doctor:score  # Full react-doctor score gate; must end at 100
REACT_DOCTOR_BASE_REF=origin/main pnpm react-doctor:diff  # Diff gate used by the local agent quality gate
pnpm dashboard:react-doctor:diff  # CI-equivalent diff scan from repo root
```

## Local Dev Server And Auth States

For UI work, verify both public and authenticated states when the changed
surface behaves differently by session. Examples: nav links, address-label edit
affordances, `/address-book`, `/entities`, `/integrations`, and `/volume`
Organic/All controls.

Use a fixed localhost port so the user can inspect the exact URL you verified:

```bash
cd ui-dashboard
AUTH_SECRET=local-dev-dashboard-auth-secret-do-not-use-in-prod \
AUTH_GOOGLE_ID=local-dev-google-id \
AUTH_GOOGLE_SECRET=local-dev-google-secret \
pnpm dev --hostname 127.0.0.1 --port 3210
```

The required local data env is:

- `NEXT_PUBLIC_HASURA_URL` for hosted multichain Hasura data. `pnpm dev`
  defaults to the live production Envio endpoint when this is unset, so fresh
  worktrees use real data without copying `.env.local`. Set it explicitly only
  when you need a non-prod or fixture endpoint.
- `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` when address labels,
  reports, entities, or authenticated editing surfaces need real data.
- `AUTH_SECRET`, `AUTH_GOOGLE_ID`, and `AUTH_GOOGLE_SECRET` for local Auth.js
  session handling. Placeholder Google values are fine for agent-side simulated
  sessions; they only need to be non-empty so protected middleware is active.

Other Vercel vars, Blob vars, cron secrets, and automation-bypass secrets are
not needed for ordinary localhost UI review unless the task directly touches
that route.

Logged-out verification:

- Use an isolated browser context, or clear both `authjs.session-token` and
  `__Secure-authjs.session-token` cookies for `127.0.0.1`.
- Expect public pages to show `Sign in`.
- Expect protected pages (`/address-book`, `/entities`, `/integrations`) to
  redirect to `/sign-in?callbackUrl=...` when auth env is configured.

Logged-in verification:

1. Start the dev server with the same `AUTH_SECRET` value used below.
2. Mint a local Auth.js JWT with `next-auth/jwt` from `ui-dashboard/`:

```bash
AUTH_SECRET=local-dev-dashboard-auth-secret-do-not-use-in-prod node --input-type=module -e 'import { encode } from "next-auth/jwt"; const secret = process.env.AUTH_SECRET; if (!secret) throw new Error("AUTH_SECRET is required"); const token = await encode({ secret, salt: "authjs.session-token", token: { email: "dev@mentolabs.xyz", refresh_token: "local-dev", expires_at: Math.floor(Date.now() / 1000) + 3600 }, maxAge: 30 * 24 * 60 * 60 }); console.log(token);'
```

3. In Chrome DevTools MCP, set the cookie on the localhost page, replacing
   `<TOKEN>` with the command output:

```js
document.cookie =
  "authjs.session-token=<TOKEN>; Path=/; SameSite=Lax; Max-Age=2592000";
location.reload();
```

4. Expect the nav to show `dev@mentolabs.xyz` and `Sign out`. Authenticated-only
   routes should render instead of redirecting, and authenticated-only controls
   should be visible.

Never use production OAuth secrets just to simulate local login. If a task needs
the real OAuth callback flow, say that explicitly and verify it separately.

Interactive `next dev` can rewrite `ui-dashboard/next-env.d.ts` to import
`./.next/dev/types/routes.d.ts`. Before committing, restore it to
`./.next/types/routes.d.ts` if the dev server dirtied the worktree.

## Browser Interaction Tests

`pnpm test:browser` starts the real Next.js app plus
`tests/browser/fixtures/hasura-fixture-server.mjs`, then runs Playwright tests
under `tests/browser/`. The fixture server is the only GraphQL source for these
tests; never point browser tests at hosted Hasura/Envio. The current pilot
intentionally uses an app-level harness instead of Playwright Component Testing
because the covered risks are App Router navigation, URL state, hydration, CSP,
SWR request behavior, and real browser focus. The agent quality gate installs
Playwright Chromium before running this command; for direct fresh-checkout runs,
run `pnpm exec playwright install chromium` once first.

Use `pnpm test:browser:production` when the verification target should match a
built app (`next build` plus `next start`) instead of dev mode. It allocates the
same fixture ports up front, starts the Hasura fixture before `next build`,
bakes the live fixture GraphQL URL into the production build, and then runs the
same Playwright suite against `next start` while reusing that fixture server.
Use `PLAYWRIGHT_NEXT_START_TIMEOUT_MS` to tune the production `next start`
timeout; `PLAYWRIGHT_NEXT_TIMEOUT_MS` remains the dev-server timeout knob.

## React Doctor

CI runs `react-doctor --diff origin/<base> --fail-on warning` on every PR
(see `.github/workflows/ci.yml` `ui` job). The CLI's `--diff` is
**file-level, not line-level**: it scans every source file the PR
touches in full. Because the full-score floor is 100, touched files should
normally be clean; any newly unsilenced diagnostic anywhere in a touched file
fails CI. Two ways through:

- Fix the warnings (preferred — keeps the score floor meaningful).
- Add an inline `// react-doctor-disable-next-line <rule-id>` above the
  offending line with a one-line rationale, if the warning isn't
  actionable in your PR's scope.

Run `pnpm dashboard:react-doctor:diff` from the repo root for the
CI-equivalent diff scan, or `pnpm react-doctor` locally for a full scan.

CI also runs a full-score floor and fails unless
`react-doctor --full --score --offline` returns `100`.
Some high-noise React Doctor rules are intentionally disabled in ESLint to keep
IDE signal useful; the standalone CLI/diff gate and `BACKLOG.md` remain the
source of truth for those rules.

Project-wide silences live in `react-doctor.config.json`. Current state:

- **Silenced project-wide** (stylistic, ~805 noise hits): the four
  `react-doctor/design-*` rules — `no-default-tailwind-palette`,
  `no-em-dash-in-jsx-text`, `no-redundant-size-axes`, `no-bold-heading`.
  `tailwind-palette` would require a brand-token migration; em-dashes
  are legitimate punctuation in our copy.
- **Silenced in tests/scripts only** (`__tests__`, `*.test.{ts,tsx}`,
  `*.spec.{ts,tsx}`, `scripts/**`): `react-doctor/no-secrets-in-client-code`
  because fixtures use placeholder public addresses.
- **Silenced project-wide for compatibility/noise:** `react-doctor/js-tosorted-immutable`
  (client code intentionally keeps spread+sort for older browser support) and
  `effect/no-event-handler` from the companion effect plugin (false-positives
  on debounced search and URL-state sync helpers).
- **Silenced for local test harness entrypoints:** `knip/files` on
  `tests/browser/fixtures/**`, which Playwright loads at runtime, and
  `vitest.mutation.config.ts`, which Stryker loads by filename from
  `stryker.config.mjs`.
- **Silenced in `src/lib/graphql.ts` only:** `knip/exports` for the
  `HASURA_TIMEOUT_MS` backward-compat re-export. New imports still target
  `@/lib/hasura-timeout` directly so server code does not pull in SWR.

### Historical Cleanup Notes

The dashboard's enforced React Doctor state is **100 / 100 (0 diagnostics)**.
Historical cleanup notes live in `BACKLOG.md` under "Follow-ups deferred from
PR #367 (react-doctor diff gate)". Single source of truth — update there, not
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
| `celo-sepolia-local` | Celo Sepolia  | local |
| `celo-mainnet-local` | Celo Mainnet  | local |
| `celo-mainnet`       | Celo Mainnet  | prod  |
| `monad-mainnet`      | Monad Mainnet | prod  |

Token symbols and address labels come from `@mento-protocol/monitoring-config/tokens` — the shared derivation also used by metrics-bridge. Custom address labels (stored in Upstash Redis) merge on top and take precedence. Individual networks can also declare custom `addressLabels` overrides in `makeNetwork(...)`.

Prod networks share a single `NEXT_PUBLIC_HASURA_URL` (the multichain Envio endpoint) and filter by `chainId`. The package `dev` script supplies the live endpoint by default for local worktrees; explicit env values still override it. Explorer URL defaults come from `@mento-protocol/monitoring-config/chains` with per-network env overrides (`NEXT_PUBLIC_EXPLORER_URL_<NETWORK>`) for local dev.

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
- The lazy-init source MUST be `useSearchParams()`, not `window.location.search`. `useState` lazy initializers run on the SSR pass and the resulting state is serialized into the HTML payload — they DO NOT re-run on client hydration. Reading `window.location.search` directly returns `undefined`/empty on the server, so a user landing on `/volume?range=90d&venue=v2` directly would hydrate to defaults and the `popstate` listener never fires on initial load (it's back/forward only). Use `useSearchParams()` for the SSR-pass read; switch to `window.location.search` only AFTER mount (e.g. inside `popstate` handlers and write-time URL rebuilds, where `replaceState` writes lag the `useSearchParams` snapshot). Caught by Cursor Bugbot bbc20b5f on PR #371.
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

### Server vs client module boundaries

- Modules that import `useSWR` / `useNetwork` / `next-auth` / any React-only API (e.g. `lib/graphql.ts` — exports `useGQL`) are **client-only**. They cannot be imported by server-side code: `lib/homepage-og.ts`, `lib/pool-og.ts`, `lib/bridge-flows-og.ts`, `app/.../opengraph-image.tsx`, `app/api/**` route handlers. Next.js RSC bundling pulls the full transitive graph into the server bundle and breaks `next build` (or worse, ships React/SWR to the OG image renderer).
- Shared constants needed on both sides go in zero-dependency modules — e.g. `lib/hasura-timeout.ts` (single `export const HASURA_TIMEOUT_MS = 5000`). The client-side `lib/graphql.ts` re-exports for backwards compat, but new server-side imports MUST target the zero-dep module directly.
- Caused codex P1 on PR #372 — `HASURA_TIMEOUT_MS` was added to `lib/graphql.ts` and three OG modules imported it; CI didn't catch it because the next build step isn't gated, but it would have leaked SWR into the server bundle.

### CDP page — derived metrics

`systemDebt` / `systemColl` / `spDeposits` are read straight from `LiquityInstance` (delta-tracked by `applySystemDebtDelta` in the indexer since commit 026c629, promoted 2026-05-20). The `/cdps` list and detail pages still derive the **open-trove count** client-side from active+zombie `Trove` entities because the indexer's `activeTroveCount` excludes zombies; the UX-meaningful "positions with outstanding debt" count is `active + zombie`. The derivation lives in `_lib/health.ts:aggregateTroves`: the list page runs it on the trimmed `CDP_MARKETS` Trove fetch (`id collateralId status` only, max 500), while the detail page runs it on the `OpenTrove` branch from `CDP_MARKET_DETAIL` (full detail rows, max 1000) so the KPI matches the table. If the indexer ever grows an `openTroveCount` field maintained alongside `activeTroveCount` in the same delta path, drop the client-side count too.

The CDP detail page surfaces a redemption split (`Total` / `User` / `Rebalance`) from the indexer's `redemption*Cum` + `rebalanceRedemption*Cum` fields. The rebalance subset is discriminated by `tx.to == cdpLiquidityStrategy` in the indexer (PR #31 in `mento-protocol/bold`); user-driven = total − rebalance.

The CDP health badge state machine is in `_lib/health.ts:deriveCdpHealth`. Today's signals: shutdown flag (terminal), SP-empty + outstanding debt (critical), SP coverage tiers (<5% critical, <50% warning). ICR/TCR percentiles are stubbed to `-1` in the indexer (no live price feed yet); when those become real, add ratio-based signals to the state machine.

### Unsigned vs signed wei formatting

`src/app/cdps/_lib/format.ts` exposes two helpers and the distinction matters: `formatTokenAmount(value, symbol)` for unsigned values (balances, deposits, cumulative totals) — treats `-1` as the indexer's "unknown" sentinel (e.g. `spHeadroom`, ICR percentiles before the price feed lands) and renders `—`. `formatSignedWei(value, symbol)` for signed values (int256 deltas like `TroveOperationEvent.collChange` / `debtChange`) — does NOT treat `-1` as a sentinel since a `-1 wei` withdrawal is a legitimate amount; only `null`/`undefined` resolve to `—`. Pick the helper based on the source field's sign semantics — a hypothetical `-1 wei` `collChange` under `formatTokenAmount` would collapse to `—` instead of the actual amount.

### Content-Security-Policy (nonce-based)

- CSP is set **exclusively in middleware** (`src/middleware.ts`). There is no CSP in `next.config.ts`; a duplicate header would cause browsers to apply the intersection of both policies.
- A fresh 16-byte nonce is generated per request via `crypto.getRandomValues`. `buildCspWithNonce` (`src/lib/csp.ts`) assembles the full policy string. The nonce is injected into request headers (so Next.js App Router attaches it to its inline `<script>` tags) and echoed on response headers (so the browser enforces it).
- `script-src` does NOT contain `'unsafe-inline'`. Any inline script that isn't a Next.js RSC/hydration script needs to either use the nonce via `nonce={nonce}` (read from request headers in the layout) or be moved to an external file.
- `style-src` KEEPS `'unsafe-inline'`. React `style={}` props compile to HTML `style="..."` attributes; nonces only apply to `<style>` tag elements, not attribute-level inline styles.
- The `connect-src` allowlist in `src/lib/csp.ts` is **load-bearing** — changing it breaks live data fetching. Always update `csp.test.ts` alongside any allowlist edit.
