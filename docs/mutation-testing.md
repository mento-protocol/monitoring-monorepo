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

- Runtime: 10s on the final root-script run (8-10s observed locally)
- Mutation score: 90.27% total / covered
- Mutants: 97 killed, 5 timed out, 11 survived, 0 no coverage

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

Remaining metrics-bridge survivors are accepted noise for this baseline:

- `_resetProbeInProgressForTests()` and module-scope boolean initializer mutants
  affect test scaffolding/static initialization more than production behavior.
- Timeout abort-name and abort-branch mutants collapse to the same logged
  `transport_error` because the fallback still returns the timeout message.
- Empty-array and no-eligible-cycle mutants are equivalent with the current
  runner: arrays expand by index assignment, and an empty eligible list still
  reaches the same last-run timestamp without probes.
- The loop-bound / missing-result guards are defensive against impossible
  result-array holes under `runWithConcurrency()`.

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
