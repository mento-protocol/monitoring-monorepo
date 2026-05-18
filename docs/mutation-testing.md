# Mutation Testing

Mutation testing is intentionally scoped to proven pure-logic targets:

- `indexer-envio/src/helpers.ts`
- `indexer-envio/src/tradingLimits.ts`
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
mutated files.

Latest indexer result after adding the baseline:

- Runtime: 5s on the final root-script run
- Mutation score: 94.78% total / covered
- Mutants: 127 killed, 0 timed out, 7 survived, 0 no coverage
- Per-file: `helpers.ts` 91.11% total / covered; `tradingLimits.ts`
  96.63% total / covered

The initial indexer scope is limited to deterministic helpers with direct tests:
chain/event/pool/snapshot ID helpers and trading-limit derivation. A trial that
also mutated `healthScore.ts` and `priceDifference.ts` ran in 1m07s but scored
65.19% total / 79.03% covered because broad branchy math helpers produced many
survivors/no-coverage mutants. Revisit those one file at a time after adding
smaller direct tests; adding them now would dilute the baseline.

Latest dashboard result after adding focused assertions:

- Runtime: 14s on the final root-script run (5-14s observed locally)
- Mutation score: 88.81% total / 92.70% covered
- Mutants: 122 killed, 5 timed out, 10 survived, 6 no coverage
- Per-file: `weekend.ts` 87.07% total / 91.82% covered; `pool-id.ts`
  96.30% total / covered

Latest metrics-bridge result after narrowing to the probe runner:

- Runtime: 22s on the 2026-05-18 CI run / 8-9s locally
- Mutation score: **86.01% total / covered**. PR 436 had landed at 88.32%;
  the strict-TS PR added defensive null-checks for `noUncheckedIndexedAccess`
  (extra mutants in the `if (!pool || !result) continue` /
  `if (item === undefined) return` guards). The 2.3-pt drop is from new
  equivalent mutants (see taxonomy below). The gate is `break: 84` to keep
  the 2-pt margin for measurement noise.
- Mutants: 121 killed, 2 timed out, 20 survived, 0 no coverage

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

Remaining 16 metrics-bridge survivors after the PR 436 triage — all are
classified as accepted noise or equivalent mutants. Counts in parentheses
indicate how many mutation variants on the same line collapse to the same
category.

**Test scaffolding (3)** — affect test cleanup, not production behavior:

- `_resetProbeInProgressForTests()` body emptied (line 53).
- Module-scope `let probeInProgress = false` flipped to `true` (line 44);
  `runRebalanceProbes()` re-sets it every cycle before reading.
- Module-scope `let reentryWarnedThisWindow = false` flipped to `true`
  (line 49); reset in the `finally` block.

**`eligibleForProbe` optimization branches (5)** — equivalent mutants
because NaN-comparison semantics naturally short-circuit downstream:

- `if (!Number.isFinite(ratio)) return false` (line 72): removing the
  early-return still excludes the pool — `NaN <= TOLERANCE` is false,
  `NaN > 1.05` is false, so `crossedCritical` is false → excluded anyway.
- `Number.isFinite(openBreachPeak) && openBreachPeak > 0` mutated to
  `true` / `&&` → `||` / `> 0` → `>= 0` (lines 80, 80:42): when peak is 0
  or NaN, every variant yields `openBreachPeakRatio = 0` (either via the
  guard or via 0/threshold). The boundary tests added in PR 436 lock the
  threshold-divisor selection, but these guard-removal mutants flatten
  to the same ratio.

**`probeOne` timeout-error branch (3)** — equivalent because the
unexpected-error fallback returns the same `transport_error` message:

- `timeoutErr.name = "AbortError"` mutated to `""` (line 124): with an
  empty name, `isAbortError(err)` returns false and the catch falls to
  the fallback path which builds `transport_error` from the same
  `scrubUrls(timeoutErr.message)` — the message is the literal
  `timeoutMessage` with no URLs to scrub, so the observable error string
  is unchanged.
- `if (isAbortError(err)) { ... }` mutated to `if (false)` / `{}`
  (line 138): same fallback collapse — the body returned
  `transport_error: timeoutMessage` and the fallback now returns
  `transport_error: scrubUrls(timeoutMessage)`, which for our timeout
  string is the same value.

**`runWithConcurrency` array pre-sizing (1)** — equivalent:

- `new Array(items.length)` mutated to `new Array()` (line 170):
  JavaScript arrays grow dynamically on `arr[idx] = ...` assignment, and
  the runner only reads results AFTER the workers finish. Final array
  shape is identical.

**`runRebalanceProbes` + `runWithConcurrency` defensive guards (~7)** —
equivalent under the current callgraph. Several of these guards were
added by the strict-TS PR to satisfy `noUncheckedIndexedAccess`; mutants
on them survive because the bounds checks above prove the indexes are
valid:

- `if (eligible.length === 0) { ...; return; }` mutated to
  `if (false)` / `{}`: with an empty list,
  `runWithConcurrency([], ..., ...)` returns `[]`, the for-loop runs
  zero iterations, and the function still reaches the same final
  `rebalanceProbeLastRun` gauge update at the end of the `try` block.
- `for (let i = 0; i < eligible.length; i++)` mutated to `i <=`:
  accessing `eligible[eligible.length]` returns `undefined`, the
  `if (!pool || !result) continue` line skips, no observable change.
- `if (!pool || !result) continue` mutated to `if (false) continue` /
  flipped to `&&`: `pool` and `result` are always defined when the loop
  body runs (`runWithConcurrency` writes every slot, `eligible[i]` is
  in-range). The guard is defensive against the
  `noUncheckedIndexedAccess` TS rule, not a runtime case.
- `if (item === undefined) return` inside `runWithConcurrency` workers:
  same pattern — `items[idx]` is provably defined after the
  `idx >= items.length` bound check above, so the secondary guard is
  unreachable. The guard exists because the TS compiler can't prove the
  invariant under `noUncheckedIndexedAccess`.

Remaining indexer survivors are accepted noise for this baseline:

- `extractAddressFromPoolId()` regex anchor and error-string mutants do not
  change the currently asserted valid extraction / bare-address /
  double-namespacing behavior.
- The `addr === undefined` guard mutant is unreachable after the preceding
  capture-group match succeeds; it is defensive against future regex edits.
- Trading-limit `<` to `<=` absolute-value mutants are equivalent for zero,
  because negating `0n` still yields `0n`.

## Expansion Guidance

This is worth keeping as a targeted manual/nightly signal, not as a broad
required PR gate. Expand only when the target is pure logic with direct tests and
an expected runtime under roughly one minute.

Concrete expansion plan:

- Add one file at a time to an existing package baseline only after a trial run
  shows real assertion gaps or a covered score near/above the low threshold.
- Keep `rebalance-check.ts` out until decoder helpers are split or directly
  tested; otherwise the baseline is dominated by defensive-decoder noise.
- Prefer small formatting, classification, time math, and runner-gating helpers.
  Avoid targets that need real RPC, a browser, generated code, or large
  integration fixtures.

Avoid generated files, test files, GraphQL barrels, ABIs, config-only files, and
runtime-heavy RPC/dev-server paths.
