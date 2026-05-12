# Mutation Testing

Mutation testing is intentionally scoped to one proven dashboard target for now:
`ui-dashboard/src/lib/weekend.ts`.

## Current Baseline

Run from the repo root:

```bash
pnpm dashboard:mutation
```

The command runs StrykerJS with the Vitest runner, mutating only
`src/lib/weekend.ts` and executing `src/lib/__tests__/weekend.test.ts` via
`ui-dashboard/vitest.mutation.config.ts`.

Latest local result after adding focused assertions:

- Runtime: 6s on the final root-script run (6-13s observed locally)
- Mutation score: 87.07% total / 91.82% covered
- Mutants: 96 killed, 5 timed out, 9 survived, 6 no coverage

The first meaningful run was worth doing: it found real assertion gaps in the
default `Date.now()` path, reversed weekend-overlap ranges, and the exact/future
contract for the next market-hours transition. Those are now covered in
`weekend.test.ts`.

## Survivor Classification

Remaining survivors are accepted noise for this baseline:

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

## Expansion Guidance

This is worth keeping as a targeted manual/nightly signal, not as a broad
required PR gate. Expand only when the target is pure logic with direct tests and
an expected runtime under roughly one minute.

Good next candidates:

- `ui-dashboard` pool ID/helpers
- `metrics-bridge` rebalance probe/check logic

Avoid generated files, test files, GraphQL barrels, ABIs, config-only files, and
runtime-heavy RPC/dev-server paths.
