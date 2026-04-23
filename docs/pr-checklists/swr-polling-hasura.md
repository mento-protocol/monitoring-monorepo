# SWR + Hasura polling checklist

Use this checklist for any change that adds, removes, or reconfigures an SWR hook against Hasura. The dashboard fans out 15–20 polling hooks per pool page, so misconfigured defaults compound quickly into 429s and stale UIs.

## Operating rule

> **Every SWR hook polling the indexer's Hasura endpoint MUST disable focus/reconnect revalidation. Fix the default at the source — `useGQL` — not at every call site.**

## 1. Required SWR options for any Hasura-polling hook

For any hook that polls Hasura on an interval (default 10s):

- [ ] `revalidateOnFocus: false` — every alt-tab fans every active query at the endpoint, tripping Envio's 429 rate limit
- [ ] `revalidateOnReconnect: false` — same fan-out on network blip
- [ ] An explicit `refreshInterval` (caller-overridable, default 10_000)
- [ ] An `AbortSignal.timeout(...)` on the request well below the refresh interval (e.g. 8s for a 10s interval) so a wedged TCP connection can't compound into unbounded backpressure

The canonical good example: `ui-dashboard/src/lib/bridge-flows/use-bridge-gql.ts:42-51`. The comment explains the why; copy that comment when wiring a new hook.

The current bug to fix: `useGQL` at `ui-dashboard/src/lib/graphql.ts:33-37` passes only `{ refreshInterval }` to `useSWR`. Every consumer of `useGQL` inherits the SWR defaults, which means **every pool-page query revalidates on focus**. Fix it at the wrapper so all call sites benefit at once. Do NOT push the fix into individual call sites — that creates drift.

## 2. Pause/retry interactions

If you set BOTH `revalidateOnFocus: false` AND `revalidateOnReconnect: false`, then SWR's `onErrorRetry` no longer pauses for hidden/offline tabs (`onErrorRetry` is gated by `!revalidateOnFocus || !revalidateOnReconnect || isActive()`).

- [ ] If the hook also uses `onErrorRetry`, gate retries explicitly on `document.visibilityState === "visible"` and `navigator.onLine`, OR keep one revalidation gate enabled
- [ ] If the hook uses a "pause when hidden" interval helper that returns `0`, remember that `refreshInterval: 0` in SWR v2 STOPS scheduling the next tick. Either return a large interval instead (e.g. 1 hour) or pair with one of the revalidation gates so the loop resumes

## 3. Pagination + result-set caps

Hasura silently caps every query at **1000 rows** (Envio hosted Hasura config). On top of that, any custom `limit:` in the query (e.g. `limit: 100`) silently drops older data without a warning.

- [ ] If the query feeds a metric that aggregates over the full lifetime (uptime %, breach count, cumulative volume), the data MUST come from a pre-rolled snapshot/rollup entity on the indexer — NOT from a paginated list
- [ ] If pagination is genuinely needed, use `fetchAllSnapshotPages`
- [ ] Never ship `_aggregate` queries to the dashboard against hosted Hasura — they're disabled
- [ ] **Curl-verify** every new KPI query against the hosted endpoint with a representative pool (one with >1000 rows of history). Confirm the page count matches your local-dev assumption

## 4. Loading vs zero vs empty

`UptimeValue` (PR #194) shipped with `breaches = data ?? []` and rendered "100.000% / no breaches" before the query resolved — a flash of false-good content.

- [ ] Distinguish `isLoading` from "data resolved to empty/zero"
- [ ] Render a loading skeleton (or `—`) until `data !== undefined`
- [ ] An `error` early-return is not enough; `data === undefined && !error` is the loading state

## 5. Tests

- [ ] Test the loading state explicitly (mock SWR with `data: undefined, isLoading: true`)
- [ ] Test the error state (mock SWR with `error: new Error(...)`)
- [ ] Test the populated state with both empty array and >0 entries
- [ ] If the hook sets `revalidateOnFocus: false`, write a regression test that asserts the option is set — otherwise it gets removed in a future refactor

## 6. Lessons already paid for

- PRs #202 (open) and #194 — focus/reconnect revalidation was missing from `useGQL` and `UptimeValue`'s breach hook; bots flagged it as the cause of bursty 429s
- PR #194 — `POOL_DEVIATION_BREACHES` capped at `limit: 100` silently inflated uptime % for pools with >100 breaches; fix was to use the indexer-side cumulative counter
- PR #194 — `UptimeValue` rendered 100% during initial load
- PR #185 — bridge-redeem hook fired toasts on transient RPC errors during component teardown; AbortSignal now bounds the request
