# Mutation Testing Checklist

Use this checklist when changing mutation-test config, mutation-test scripts, or
one of the current mutation targets.

- Keep `mutate` narrowly scoped to proven pure logic. Do not add generated files,
  tests, GraphQL barrels, ABIs, config-only files, or runtime-heavy RPC/dev-server
  paths.
- Run the affected baseline (`pnpm indexer:mutation`,
  `pnpm dashboard:mutation`, and/or `pnpm bridge:mutation`) and record the
  runtime plus mutation score in the PR.
  In sandboxed agent sessions, Stryker may need command approval because it opens
  a local logging socket.
- Classify every survivor as a real test gap, equivalent mutant/noise, or tool
  limitation. Add tests only for real gaps.
- **All three mutation baselines are PR-blocking.** Each `stryker.config.mjs`
  sets a `break` floor at "rounded baseline score − 2" for measurement
  noise. `.github/workflows/mutation-testing.yml` runs on every PR
  (required-status safe — no `paths:` filter at workflow level). Each
  per-package job has an internal `filter` step (`continue-on-error: true`)
  so a path-detection failure can't flip the workflow red; the matching
  `decide` step then interprets "filter failed" as fail-closed and runs
  the full gate. The mutation step actually runs when (a) the trigger
  isn't `pull_request`, (b) the filter failed, or (c) the diff touched
  that package's inputs.

  | Package          | Config                              | `break` | Baseline | Job                               |
  | ---------------- | ----------------------------------- | ------: | -------: | --------------------------------- |
  | `metrics-bridge` | `metrics-bridge/stryker.config.mjs` |      84 |   86.01% | `bridge-rebalance-probe-baseline` |
  | `ui-dashboard`   | `ui-dashboard/stryker.config.mjs`   |      86 |   88.81% | `dashboard-logic-baseline`        |
  | `indexer-envio`  | `indexer-envio/stryker.config.mjs`  |      92 |   94.78% | `indexer-logic-baseline`          |

  When a mutation step runs and the score drops below the package's
  `break` floor, the job fails. If your PR fails the gate, treat any new
  surviving mutant as a real test gap unless you can classify it against
  the existing taxonomy in `docs/mutation-testing.md` and update that doc
  in the same PR.

- Revisit `docs/mutation-testing.md` when adding a new target or changing the
  accepted survivor classification.
