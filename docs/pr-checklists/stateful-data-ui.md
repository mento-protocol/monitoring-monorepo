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

## 7. Repo-specific lessons already paid for

These are not theoretical.

- New UI fields must not assume schema support without verifying all writers.
- Shared presentational components should forward DOM props unless intentionally constrained.
- Count fallback must preserve prior total, not collapse to current page length.
- Search behavior must be bounded and disclosed when not truly global.
- Charts and tables should usually be decoupled.
- Cross-layer features need both indexer and UI regression coverage.

---

## 8. Final pre-PR questions

If you answer “no” to any of these, do not open yet.

- [ ] Could another engineer explain the invariants from the PR description alone?
- [ ] Would a transient backend failure produce a sensible UI instead of a misleading one?
- [ ] Are the largest-cardinality paths still bounded?
- [ ] Do tests prove behavior, not just markup?
- [ ] Did review stop being the place where design gets finished?

If not, one more local pass is cheaper than three more review rounds.
