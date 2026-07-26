---
title: "Mutation Testing"
status: active
owner: eng
canonical: true
last_verified: 2026-07-26
doc_type: reference
scope: repo-wide
review_interval_days: 7
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

This document is the canonical record for current mutation measurements,
runtimes, and accepted survivor classifications. The package configs own only
the enforced floors; the checklist owns the recurring workflow policy.

The 2026-07-26 baseline ran the three commands serially from a clean checkout
of [`e86c638d7feed52228afd658bf742ff5124a6da5`](https://github.com/mento-protocol/monitoring-monorepo/commit/e86c638d7feed52228afd658bf742ff5124a6da5)
(`docs: finish notes and plans garden (#1612)`) on macOS 26.5.2, Node
v24.13.1, and pnpm 11.9.0. Stryker's native JSON and HTML reports were emitted
under each package's ignored `reports/mutation/` directory; the table below is
the retained, reviewable extraction from those reports.
Review then identified the bridge's `probeInProgress = true` and
`reentryWarnedThisWindow = true` survivors as real first-cycle test gaps. The
metrics-bridge row records the corrected rerun from this proposed tree after
adding one first-window test that kills both; the other two rows retain the
clean-checkout measurements.

Run from the repo root:

```bash
pnpm bridge:mutation
pnpm dashboard:mutation
pnpm indexer:mutation
```

Each command runs StrykerJS with the Vitest runner and a dedicated mutation
Vitest config so each baseline executes only the direct unit tests for the
mutated files. The indexer baseline writes Stryker's temp sandbox to the repo
root under `.stryker-tmp/indexer-envio` so the package lint gate can run in
parallel without scanning transient mutation files.

| Target         | Native report                                                   | Runtime | Score (total / covered) | Mutants (killed / timed out / survived / no coverage / errors) | `break` / margin |
| -------------- | --------------------------------------------------------------- | ------: | ----------------------- | -------------------------------------------------------------- | ---------------- |
| Metrics bridge | `metrics-bridge/reports/mutation/{mutation.json,mutation.html}` |      8s | 88.89% / 88.89%         | 140 / 4 / 18 / 0 / 0                                           | 86 / 2.89 points |
| Dashboard      | `ui-dashboard/reports/mutation/{mutation.json,mutation.html}`   |     12s | 88.83% / 91.50%         | 172 / 11 / 17 / 6 / 0                                          | 86 / 2.83 points |
| Indexer        | `indexer-envio/reports/mutation/{mutation.json,mutation.html}`  |     58s | 96.09% / 96.09%         | 161 / 11 / 7 / 0 / 0                                           | 94 / 2.09 points |

The floor is `floor(measured total score) - 2`. Stryker counts timed-out
mutants as detected in its total score, while retaining their count separately
in the reports. The corrected bridge floor moves from 85 to 86, and the indexer
floor moves from 92 to 94, because these measured baselines support the existing
two-point policy; no targets or schedule change.

Per-file results:

- Indexer: `helpers.ts` 92.98%, `tradingLimits.ts` 96.63%,
  `stables/classifyKind.ts` 100.00%, and `stables/dailyFlush.ts` 100.00%.
- Dashboard: `weekend.ts` 87.71% total / 90.75% covered and `pool-id.ts`
  96.30% total / covered.

The indexer scope is limited to deterministic helpers with direct tests:
chain/event/pool/snapshot ID helpers, trading-limit derivation, and stables
classification/daily-flush helpers. A trial that also mutated `healthScore.ts`
and `priceDifference.ts` ran in 1m07s but scored 65.19% total / 79.03% covered
because broad branchy math helpers produced many survivors/no-coverage mutants.
Revisit those one file at a time after adding smaller direct tests; adding them
now would dilute the baseline.

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

The 2026-07-26 survivors are accepted noise or equivalent mutants in the
current target scope. Treat a new survivor as a test gap unless it fits one of
these classifications.

**Dashboard (17 survived, 6 no coverage)**

- `isWeekend()` day-gap mutants are equivalent with the current calendar
  because close and reopen days return before the generic modulo branch.
- `fxWeekendBands()` and `weekendOverlapSeconds()` boundary mutants only change
  zero-width ranges or empty-shape presentation at half-open boundaries.
- `tradingSecondsInRange()` `<=` to `<` is equivalent for equal timestamps
  because the subtraction path still returns zero.
- `nextMarketHoursTransition()` loop-bound and update mutants return the same
  boundary for reachable inputs. Its final fallback is defensive and has the
  six no-coverage mutants.
- `stripChainIdFromPoolId()` has one equivalent separator mutant: after
  `slice(1)`, the namespaced format leaves a single address segment, so
  `join("")` and `join("-")` return the same value.

**Metrics bridge (18 survived)**

The survivors are classified as accepted noise or equivalent mutants:

**Test scaffolding (1)** — affects test cleanup, not production behavior:

- `_resetProbeInProgressForTests()` body emptied.

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

**Indexer (7 survived)**

- `extractAddressFromPoolId()` has three error-message/regex-shape survivors;
  they do not change the currently asserted valid extraction, bare-address, or
  double-namespacing behavior. The `addr === undefined` guard is unreachable
  after the preceding capture-group match succeeds and remains defensive
  against future regex edits.
- The three trading-limit `<` to `<=` absolute-value mutants are equivalent for
  zero because negating `0n` still yields `0n`.

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
