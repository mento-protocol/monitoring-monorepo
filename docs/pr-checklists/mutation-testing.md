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
- **Mutation runs weekly + on-demand, not per-PR.** Each `stryker.config.mjs`
  sets a `break` floor at "rounded baseline score − 2" for measurement
  noise; a run whose score drops below the floor fails the job. As of the
  CI-cost work, `.github/workflows/mutation-testing.yml` triggers on the
  weekly `schedule` cron and `workflow_dispatch` only — it is **not** in the
  `main` ruleset's required checks, and per-PR mutation testing (3 runner
  boots on every push) was the single largest avoidable CI-cost line.
  Mutation testing measures test-suite strength, not per-commit regression,
  so a weekly cadence is the right altitude. To get a mutation signal for a
  specific branch before merge, trigger the workflow on demand via the
  GitHub "Run workflow" button (or `gh workflow run "Mutation Testing"
--ref <branch>`). Each per-package job keeps its internal `filter`/`decide`
  steps; on a non-`pull_request` trigger the gate always runs.

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
