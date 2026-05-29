# Stateful Data + UI PR Checklist

Use this checklist for any PR that changes stateful data flow across layers.

## Operating rule

> **Any PR that adds or changes stateful data flow across layers must ship with explicit invariants, degraded-mode behavior, and interaction tests before opening.**

If the change touches any combination of:

- Envio schema/entities
- event handlers / entity writers
- generated types / GraphQL queries / dashboard types
- paginated, sortable, filterable, or searchable UI state
- partial failure behavior (count query failure, stale RPC, missing metadata, old rows after schema rollout)

then this checklist is mandatory.

---

## 1. Define invariants first

Write down the rules the system must obey before coding.

Examples:

- Every event/snapshot entity must persist `txHash`
- Charts must not depend on paginated table slices
- Paginated tables must have deterministic ordering
- Aggregate-query failure must degrade visibly, not silently
- Client-side search over large datasets must be bounded and disclosed

If you cannot state the invariant in one sentence, the design is not ready.

---

## 2. Cross-layer audit

For every new field / changed field / changed behavior, walk the full path:

### Schema / source of truth

- [ ] `schema.graphql` updated if entity shape changed
- [ ] field names/types/nullability are intentional
- [ ] backward-compatibility / rollout behavior considered for old rows

### Writers

- [ ] every entity constructor / writer is updated consistently
- [ ] all event handlers that produce the entity were checked, not just the obvious one
- [ ] generated/codegen artifacts refreshed where applicable

### Readers

- [ ] GraphQL queries updated
- [ ] dashboard/runtime types updated
- [ ] derived formatting / rendering logic updated
- [ ] search/sort/filter fields updated intentionally

### Tests

- [ ] producer/indexer tests updated
- [ ] consumer/UI tests updated
- [ ] fixtures reflect the new schema reality

If one layer is missing, stop and fix it before opening the PR.

---

## 3. Stateful table rubric

If the PR touches a table with pagination, sort, filter, search, or linked charts, answer all of these explicitly.

### Sorting

- [ ] Is sorting server-side, client-side, or hybrid?
- [ ] Are page boundaries deterministic for non-unique sort fields?
- [ ] Is there a unique tiebreaker (`id`, tx hash, composite key, etc.)?
- [ ] Do headers expose sort state accessibly (`aria-sort`)?

### Pagination

- [ ] What determines total row count?
- [ ] What happens when count/aggregate fails?
- [ ] Does pagination remain usable after transient failure?
- [ ] Are controls actual buttons with `type="button"`?

### Search / filtering

- [ ] Does search operate on current page, fetched window, or full dataset?
- [ ] Is that behavior documented in code comments and PR notes?
- [ ] If bounded, is the cap explicit and user-visible?
- [ ] If unbounded, can the backend/query path actually support it?

### Coupled visualizations

- [ ] Do charts use dedicated queries instead of inheriting paginated/sorted table state?
- [ ] If not, is that coupling intentional and documented?

### Time units (FX-pool metrics)

- [ ] Are all duration values on the entity in the same unit (trading-seconds, not wall-clock)?
- [ ] Does the live "open" path use `tradingSecondsInRange(start, now)` (`ui-dashboard/src/lib/weekend.ts:110`) instead of `now - start`?
- [ ] Do open and closed rows of the same column use the same unit?
- [ ] Are threshold-derived metrics (peak severity %, etc.) computed from the per-event threshold captured at event time, NOT from the live `pool.rebalanceThreshold`?

### URL / local state

- [ ] Is table state URL-backed or intentionally local?
- [ ] If local-only, is that explicitly called out as an intentional scope decision?
- [ ] If URL-backed, does the URL canonicalize after data-driven clamping (no stale `?page=N` past totalPages, no `?page=1` default, no malformed `?page=foo` lingering)? Pattern: `lib/use-table-sort.ts:156-174` mount-time canonicalization + the bridge-flows pager `page=1` URL-clearing test. PR #653 shipped with this failure mode: `?page=999` rendered page 2 (clamped) but kept `?page=999` in the address bar, breaking refresh/share fidelity.

---

## 4. Degraded-mode checklist

For each non-happy path, decide the behavior explicitly.

- [ ] count query fails
- [ ] chart query fails
- [ ] some rows predate a new schema field
- [ ] RPC-derived metadata is missing
- [ ] total dataset is much larger than the current happy-path sample
- [ ] search term matches data outside the currently fetched window
- [ ] empty state vs loading state vs partial-data state are distinct

The key question:

> What will the user see, and will they understand that the data is partial or degraded?

Silent degradation is not acceptable.

---

## 5. Required test matrix

For nontrivial stateful data/UI changes, tests must cover all 3 buckets:

### Happy path

- [ ] normal render / query wiring
- [ ] new field is displayed/used correctly

### State transition

- [ ] sort toggle changes query/order state
- [ ] page transition changes offset/page state
- [ ] search input resets/updates the right state
- [ ] links/actions resolve to the expected target

### Failure / degraded mode

- [ ] count error fallback
- [ ] capped search behavior
- [ ] missing field / legacy row behavior
- [ ] user-visible warning or fallback state

If the risky behavior is interactive, a static markup assertion is not enough.

---

## 6. PR description requirements

Before opening the PR, include these sections:

### What this PR changes

Short factual summary.

### Invariants

List the system rules this PR relies on or introduces.

### Degraded behavior

What happens on count/query/RPC failure, old rows, large datasets, etc.

### Intentional non-goals

Examples:

- URL-backed sort/page state deferred
- full server-side search deferred
- abstraction cleanup out of scope

This prevents reviews from repeatedly rediscovering scope boundaries.

---

## 7. Per-window state collapses

If a refactor removes per-window state (e.g. `unpriced{24h,7d,30d}` collapsed into a single `unpriced` flag), prove no consumer reads the window-scoped values BEFORE shipping.

- [ ] Grep every consumer of the entry type for the per-window field names. A single cell that reads `entry.unpriced24h` is enough to break the collapse — old data outside the recent window will then incorrectly mark the recent column.
- [ ] If the producer emits per-day or per-event timestamps, the window flags are derivable: scope `markUnpriced(entry, in24h, in7d, in30d)` to only set the flags whose cutoffs include the row's timestamp. Don't drop precision the renderer needs.
- [ ] Add at least two test cases: (a) a recent unpriced entry inside all windows flags every column; (b) an OLD unpriced entry outside the recent windows flags ONLY all-time and leaves 24h/7d/30d exact.

### Day-aligned cutoff math for daily-bucket data

When aggregating UTC-day-bucketed snapshot rows over rolling 24h/7d/30d windows, the cutoff math must be day-aligned, not rolling-by-second.

- [ ] Anchor cutoffs on `dayStart(now) - (N-1)*86400`, NOT `nowSeconds - N*86400`. The latter drops the oldest day's bucket once the wall clock passes midnight (silent N→N-1 day undercount mid-period; fees, volume, etc. shrink without any UI signal).
- [ ] For chart/series builders that take an hour-aligned `[from, to)` window, floor `to - 1` (not `to`) when deriving the last day-bucket — half-open windows where `to` lands exactly on a midnight boundary otherwise advance to the next day.
- [ ] When the chart and a KPI tile share the same window length, derive both from the same anchor (`dayStart - (N-1)*86400`) so the headline number and the chart's last bucket sum to identical totals. PR #319 had a chart-vs-tile mismatch (8 buckets vs 7) caught by codex.

PR #306 added the per-window precision specifically to avoid stale-data pollution; PR #317 dropped it as "simplification" and reintroduced the regression. PR-snapshot-2 also had the rolling-cutoff bug in `aggregateFeeSnapshotsByPool`, only caught one PR later in #319.

## 8. Repo-specific lessons already paid for

These are not theoretical.

- New UI fields must not assume schema support without verifying all writers.
- Shared presentational components should forward DOM props unless intentionally constrained.
- Count fallback must preserve prior total, not collapse to current page length.
- Search behavior must be bounded and disclosed when not truly global.
- Charts and tables should usually be decoupled.
- Cross-layer features need both indexer and UI regression coverage.
- Approximate-data badges on rolled-up rows must derive from the data's actual coverage (e.g. the chain's oldest returned transfer's timestamp vs each window's lower bound), not just a global `isTruncated` flag — otherwise busy chains that cross the cap inside a recent window render as exact (PR #306).
- URL-backed stateful UI controls that write via async `router.replace` (Next.js App Router) must dedupe rapid successive interactions via a ref-tracked intent — reading state from the `useCallback` closure on a fast double-click reads the stale pre-navigation URL and silently drops the second toggle (PR #307).
- Client components that read URL state via Next's `useSearchParams()` only see the snapshot from the last RSC payload — own writes via `window.history.replaceState` (e.g. `lib/use-table-sort.ts:139`, `leaderboard/_lib/url-state.ts`) don't refresh it, and `popstate` only fires for back/forward navigation, never for own `replaceState` calls. If you need the live URL at click/action time (callbackUrl construction, share-link copy, deep-link generation, etc.), read `window.location.{pathname,search}` directly with an SSR-safe fallback to `useSearchParams`. Bit PR #335 (header "Sign in" link sent OAuth through a stale `callbackUrl` on `/pools` and `/leaderboard`).

---

## 9. Final pre-PR questions

If you answer “no” to any of these, do not open yet.

- [ ] Could another engineer explain the invariants from the PR description alone?
- [ ] Would a transient backend failure produce a sensible UI instead of a misleading one?
- [ ] Are the largest-cardinality paths still bounded?
- [ ] Do tests prove behavior, not just markup?
- [ ] Did review stop being the place where design gets finished?

If not, one more local pass is cheaper than three more review rounds.
