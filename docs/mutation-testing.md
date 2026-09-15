---
title: "Mutation Testing"
status: active
owner: eng
canonical: true
last_verified: 2026-09-15
doc_type: reference
scope: repo-wide
review_interval_days: 7
garden_lane: package-readmes-reference
---

# Mutation Testing

Mutation testing is intentionally scoped to proven pure-logic targets:

- `indexer-envio/src/helpers.ts`
- `indexer-envio/src/tradingLimits.ts`
- `indexer-envio/src/brokerTradingLimits.ts`
- `indexer-envio/src/handlers/stables/classifyKind.ts`
- `indexer-envio/src/handlers/stables/dailyFlush.ts`
- `ui-dashboard/src/lib/weekend.ts`
- `ui-dashboard/src/lib/pool-id.ts`
- `metrics-bridge/src/rebalance-probe.ts`

## Harness Canary

Each package also carries a harness canary: a fixture whose every mutant its
own direct test kills, mutated by `stryker.canary.config.mjs` with
`break: 100`. Run it from the repo root before the real run:

```bash
pnpm indexer:mutation:canary
pnpm bridge:mutation:canary
pnpm dashboard:mutation:canary
```

The canary answers one question the real run cannot: is a low score a weak
test suite or a dead harness? It reuses the package's own
`vitest.mutation.config.ts`, so it proves mutant activation for the exact
runner and config the real run uses. Its test imports the fixture by a
relative path, so it does not prove that a path alias such as the dashboard's
`@` still resolves inside the sandbox. Point a canary fixture at the alias if
a real target ever becomes reachable only through one.
`scripts/repo-health/mutation-harness-canary.mjs` runs Stryker and then reads
the canary's own JSON report, because a run that generates no mutants scores
`NaN`, clears every `break` floor and exits 0. It requires at least one mutant
and every mutant detected. On failure it prints `MUTATION HARNESS BROKEN` with
the reason and the installed vitest and Stryker versions.
`.github/workflows/mutation-testing.yml` runs it before each package's
baseline. Never lower a `break` floor to clear a canary failure.

Vitest stays on 4.x in the three mutation packages. Under vitest 5 the
Stryker vitest runner's per-test name filter matches nothing, so every
covered mutant survives while the tests pass
(stryker-mutator/stryker-js#6210). `@stryker-mutator/vitest-runner` 10.0.0,
the newest release, does not fix it; the fix PRs #6214 and #6220 are
unreleased. `.github/dependabot.yml` ignores vitest major updates until a
released runner passes all three canaries on the newer vitest.

## Current Baseline

This document is the canonical record for current mutation measurements,
runtimes, and accepted survivor classifications. The package configs own only
the enforced floors; the checklist owns the recurring workflow policy.

The 2026-09-15 baseline ran the three commands serially from a clone of
[`a57133c21ea8ef4f998b848b80f64d52b14b75a9`](https://github.com/mento-protocol/monitoring-monorepo/commit/a57133c21ea8ef4f998b848b80f64d52b14b75a9)
(`feat(indexer,dashboard): surface v2 Broker trading limits on VirtualPool pages (#2446)`)
with the vitest 4.x pin of this PR applied, on macOS 26.5.2, Node v24.13.1,
and pnpm 11.9.0. Stryker's native JSON and HTML reports were emitted under
each package's ignored `reports/mutation/` directory; the table below is the
retained, reviewable extraction from those reports.
It replaces the 2026-07-26 baseline, which predated both
`brokerTradingLimits.ts` (added to the indexer `mutate` list by #2446) and the
vitest 5 harness break (#2449). The indexer row records a rerun after one
added test that kills the `shouldRefreshBrokerState` threshold survivor.

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

| Target         | Native report                                                     | Runtime | Score (total / covered) | Mutants (killed / timed out / survived / no coverage / errors) | `break` / margin |
| -------------- | ----------------------------------------------------------------- | ------: | ----------------------- | -------------------------------------------------------------- | ---------------- |
| Metrics bridge | `metrics-bridge/reports/mutation/{mutation.json,html/index.html}` |     11s | 88.89% / 88.89%         | 141 / 3 / 18 / 0 / 0                                           | 86 / 2.89 points |
| Dashboard      | `ui-dashboard/reports/mutation/{mutation.json,html/index.html}`   |     16s | 88.83% / 91.50%         | 172 / 11 / 17 / 6 / 0                                          | 86 / 2.83 points |
| Indexer        | `indexer-envio/reports/mutation/{mutation.json,html/index.html}`  |   1m31s | 95.98% / 97.38%         | 305 / 29 / 9 / 5 / 0                                           | 94 / 1.98 points |

The canary runs are a few seconds each: 7s indexer, 1s bridge, 2s dashboard.

The floor is `floor(measured total score) - 2`. Stryker counts timed-out
mutants as detected in its total score, while retaining their count separately
in the reports. No floor changes: the indexer measured 95.98%, whose policy
floor of 93 is looser than the 94 already enforced, so 94 stands. The bridge
and dashboard floors of 86 match their measurements. The indexer runtime grew
from 58s to 1m31s because #2446 added `brokerTradingLimits.ts`, roughly
doubling its mutant count.

Per-file results:

- Indexer: `helpers.ts` 92.98%, `tradingLimits.ts` 96.63%,
  `brokerTradingLimits.ts` 95.86% total / 98.78% covered,
  `stables/classifyKind.ts` 100.00%, and `stables/dailyFlush.ts` 100.00%.
- Dashboard: `weekend.ts` 87.71% total / 90.75% covered and `pool-id.ts`
  96.30% total / covered.
- Metrics bridge: `rebalance-probe.ts` 88.89% total / covered.

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

The 2026-09-15 survivors are accepted noise or equivalent mutants in the
current target scope. Treat a new survivor as a test gap unless it fits one of
these classifications. A run in which every mutant survives is not a
classification problem: run the canary first.

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

**Indexer (9 survived, 5 no coverage)**

- `helpers.ts` (4 survived): `extractAddressFromPoolId()` has three
  error-message/regex-shape survivors; they do not change the currently
  asserted valid extraction, bare-address, or double-namespacing behavior. The
  `addr === undefined` guard is unreachable after the preceding capture-group
  match succeeds and remains defensive against future regex edits.
- `tradingLimits.ts` (3 survived): the three `<` to `<=` absolute-value mutants
  are equivalent for zero because negating `0n` still yields `0n`.
- `brokerTradingLimits.ts` (2 survived): both are in `statusRank()` and are
  equivalent because `foldPoolLimitFields()` reads the rank back through
  `STATUS_BY_SEVERITY[worstRank] ?? "N/A"`. Dropping the `rank < 0` clamp
  leaves `-1`, which indexes to `undefined` and falls back to the same `N/A`;
  widening it to `rank <= 0` returns `0` for a rank that was already `0`.
- `brokerTradingLimits.ts` (5 no coverage): `brokerLimitConfigFromRow()` and
  `brokerLimitStateFromRow()` are row-to-struct projections exercised only by
  `test/brokerTradingLimits.handler.test.ts`, which the mutation Vitest config
  does not include; the `?? "N/A"` fallback literal is unreachable for the same
  reason the two `statusRank()` survivors are.

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
