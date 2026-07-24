---
title: "Mutation Testing"
status: active
owner: eng
canonical: false
last_verified: 2026-07-24
doc_type: reference
scope: repo-wide
review_interval_days: 180
garden_lane: package-readmes-reference
---

# Mutation Testing

Mutation testing is intentionally scoped to proven pure-logic targets:

- `indexer-envio/src/helpers.ts`
- `indexer-envio/src/tradingLimits.ts`
- `indexer-envio/src/handlers/stables/classifyKind.ts`
- `indexer-envio/src/handlers/stables/dailyFlush.ts`
- `ui-dashboard/src/lib/weekend.ts`
- `ui-dashboard/src/lib/pool-id.ts`
- `metrics-bridge/src/rebalance-probe.ts`

## Current Baseline

Run from the repo root:

```bash
pnpm indexer:mutation
pnpm dashboard:mutation
pnpm bridge:mutation
```

Each command runs StrykerJS with the Vitest runner and a dedicated mutation
Vitest config so each baseline executes only the direct unit tests for the
mutated files. The indexer baseline writes Stryker's temp sandbox to the repo
root under `.stryker-tmp/indexer-envio` so the package lint gate can run in
parallel without scanning transient mutation files.

Latest indexer result:

- Runtime: 15s on the final root-script run (15-26s observed locally)
- Mutation score: 94.19% total / covered
- Mutants: 162 killed, 0 timed out, 10 survived, 0 no coverage
- Per-file: `helpers.ts` 91.11% total / covered; `tradingLimits.ts`
  96.63% total / covered; `stables/classifyKind.ts` 90.00% total /
  covered; `stables/dailyFlush.ts` 100.00% total / covered
- `indexer-envio/stryker.config.mjs` sets `break: 92` (current baseline
  94.19% with the standard 2-pt margin). All remaining survivors are
  classified as equivalent mutants or accepted noise — see the
  Survivor Classification section below.

The indexer scope is limited to deterministic helpers with direct tests:
chain/event/pool/snapshot ID helpers, trading-limit derivation, and stables
classification/daily-flush helpers. A trial that also mutated `healthScore.ts`
and `priceDifference.ts` ran in 1m07s but scored 65.19% total / 79.03% covered
because broad branchy math helpers produced many survivors/no-coverage mutants.
Revisit those one file at a time after adding smaller direct tests; adding them
now would dilute the baseline.

Latest dashboard result:

- Runtime: 9s on the final root-script run (5-14s observed locally)
- Mutation score: 88.81% total / 92.70% covered
- Mutants: 122 killed, 5 timed out, 10 survived, 6 no coverage
- Per-file: `weekend.ts` 87.07% total / 91.82% covered; `pool-id.ts`
  96.30% total / covered
- `ui-dashboard/stryker.config.mjs` sets `break: 86` (current baseline
  88.81% with the standard 2-pt margin). All remaining survivors are
  classified as equivalent mutants or accepted noise — see the
  Survivor Classification section below.

Latest metrics-bridge result:

- Runtime: 9s locally on 2026-07-24
- Mutation score: **87.65% total / covered**
- Mutants: 139 killed, 3 timed out, 20 survived, 0 no coverage
- `metrics-bridge/stryker.config.mjs` sets `break: 85`, leaving a 2.65-point
  margin below the verified score.

The first dashboard run was worth doing: it found real assertion gaps in the
default `Date.now()` path, reversed weekend-overlap ranges, and the exact/future
contract for the next market-hours transition. Those are now covered in
`weekend.test.ts`.

The `pool-id.ts` expansion was also worth adding: the first run exposed that the
exported `stripChainIdFromPoolId()` helper had no direct coverage, and that the
namespaced-ID regex was not pinned against leading/trailing garbage. Those gaps
are now covered in `pool-id.test.ts`.

The metrics-bridge evaluation was mixed:

- `rebalance-probe.ts` is a good baseline target. It is pure enough under mocks,
  runs quickly, and found useful missing assertions for log truncation, missing
  RPC diagnostics, exact Unix-second self-monitoring, and avoiding diagnostic
  log spam for ordinary blocked probes.
- `rebalance-check.ts` is not included. A trial mutating both rebalance files ran
  in 16s but scored 67.02% overall, with `rebalance-check.ts` at 59.02% and many
  survivors/no-coverage mutants in defensive decoder internals. Revisit it only
  after the decoder helpers are split or given direct tests; adding it now would
  dilute the signal.

## Survivor Classification

Remaining dashboard survivors are accepted noise:

- `isWeekend()` day-gap mutants are equivalent with the current calendar because
  close day and reopen day return before the generic modulo branch.
- `weekendOverlapSeconds()` half-open boundary mutants add or skip zero seconds
  when a range starts or ends exactly on a weekend boundary.
- `tradingSecondsInRange()` `<=` to `<` is equivalent for equal timestamps
  because the subtraction path still returns zero.
- `nextMarketHoursTransition()` loop-bound/update mutants return the same
  boundary for reachable inputs; the final fallback remains an unreachable
  defensive return.
- The no-coverage mutants are in that defensive fallback.
- `stripChainIdFromPoolId()` has one equivalent separator mutant: after
  `slice(1)`, the namespaced format leaves a single address segment, so
  `join("")` and `join("-")` return the same value.

The 20 metrics-bridge survivors from the 2026-07-24 run are classified as
accepted noise or equivalent mutants:

**Test scaffolding (3)** — affect test cleanup, not production behavior:

- `_resetProbeInProgressForTests()` body emptied.
- Module-scope `let probeInProgress = false` flipped to `true`;
  `runRebalanceProbes()` re-sets it every cycle before reading.
- Module-scope `let reentryWarnedThisWindow = false` flipped to `true`
  and then reset in the `finally` block.

**`eligibleForProbe` optimization branches (5)** — equivalent mutants
because NaN-comparison semantics naturally short-circuit downstream:

- Removing the `if (!Number.isFinite(ratio)) return false` early return still
  excludes the pool: `NaN <= TOLERANCE` is false,
  `NaN > 1.05` is false, so `crossedCritical` is false → excluded anyway.
- `Number.isFinite(openBreachPeak) && openBreachPeak > 0` mutated to
  `true` / `&&` → `||` / `> 0` → `>= 0`: when the peak is 0 or NaN, every
  variant yields `openBreachPeakRatio = 0` either through the guard or through
  `0 / threshold`.

**Registry normalization and dedupe (4)** — equivalent for the current
case-insensitive address contract:

- Lowercase-to-uppercase mutants on the dedupe key and sort operands preserve
  normalized equality and ordering.
- Replacing the first-row guard with an unconditional map write is equivalent
  because the downstream probe consumes only the deduplicated strategy
  address.

**`probeOne` timeout-error branch (3)** — equivalent because the
unexpected-error fallback returns the same `transport_error` message:

- `timeoutErr.name = "AbortError"` mutated to `""`: with an empty name,
  `isAbortError(err)` returns false and the catch falls to
  the fallback path which builds `transport_error` from the same
  `scrubUrls(timeoutErr.message)` — the message is the literal
  `timeoutMessage` with no URLs to scrub, so the observable error string
  is unchanged.
- `if (isAbortError(err)) { ... }` mutated to `if (false)` / `{}`
  has the same fallback collapse: the body returned `transport_error:
timeoutMessage` and the fallback now returns
  `transport_error: scrubUrls(timeoutMessage)`, which for our timeout
  string is the same value.

**`runWithConcurrency` defensive operations (3)** — equivalent:

- `new Array(items.length)` mutated to `new Array()`:
  JavaScript arrays grow dynamically on `arr[idx] = ...` assignment, and
  the runner only reads results AFTER the workers finish. Final array
  shape is identical.
- The `idx >= items.length` boundary mutated to `>` and the secondary
  `item === undefined` guard mutated to false. Both are equivalent under the
  preceding monotonic index allocation and array-length bound.

**Empty eligible-set guard (2)** — equivalent under the current callgraph:

- `if (eligible.length === 0) { ...; return; }` mutated to
  `if (false)` / `{}`: with an empty list,
  `runWithConcurrency([], ..., ...)` returns `[]`, the for-loop runs
  zero iterations, and the function still reaches the same final
  `rebalanceProbeLastRun` gauge update at the end of the `try` block.

Remaining indexer survivors are accepted noise for this baseline:

- `extractAddressFromPoolId()` regex anchor and error-string mutants do not
  change the currently asserted valid extraction / bare-address /
  double-namespacing behavior.
- The `addr === undefined` guard mutant is unreachable after the preceding
  capture-group match succeeds; it is defensive against future regex edits.
- Trading-limit `<` to `<=` absolute-value mutants are equivalent for zero,
  because negating `0n` still yields `0n`.
- `classifyStableSupplyChangeKind()` broker-cache branch mutants are accepted
  noise: the test suite already proves first-call classification for broker,
  NTT helper, NTT transceiver, unknown, null, and cross-chain broker inputs; the
  surviving mutants only change the cached-repeat path or collapse to the same
  returned address/null semantics.
- `_resetBrokerAddressCacheForTest()` body removal affects test cleanup only,
  not production behavior.

## Expansion Guidance

This is worth keeping as a targeted manual/nightly signal, not as a broad
required PR gate. Expand only when the target is pure logic with direct tests and
an expected runtime under roughly one minute.

Concrete expansion plan:

- Add one file at a time to an existing package baseline only after a trial run
  shows real assertion gaps or a covered score near/above the low threshold.
- `src/handlers/liquity/math.ts` and `src/handlers/liquity/troves.ts` were
  trialed on 2026-06-16 and deferred: the combined run scored 64.64% total /
  85.12% covered, with `math.ts` at 54.93% total and `troves.ts` at 45.96%
  total because direct tests do not cover enough helper branches yet.
- Keep `rebalance-check.ts` out until decoder helpers are split or directly
  tested; otherwise the baseline is dominated by defensive-decoder noise.
- Prefer small formatting, classification, time math, and runner-gating helpers.
  Avoid targets that need real RPC, a browser, generated code, or large
  integration fixtures.

Avoid generated files, test files, GraphQL barrels, ABIs, config-only files, and
runtime-heavy RPC/dev-server paths.
