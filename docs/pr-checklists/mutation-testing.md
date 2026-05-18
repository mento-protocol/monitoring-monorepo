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
- **`metrics-bridge/src/rebalance-probe.ts` mutation is PR-blocking** (since
  PR 436):
  `metrics-bridge/stryker.config.mjs` sets `break: 86` (current baseline
  88.32% with a 2-pt margin for measurement noise), and
  `.github/workflows/mutation-testing.yml` runs on every PR (required-status
  safe — no `paths:` filter). The bridge job's internal `filter` step is
  `continue-on-error: true` so a path-detection failure can't flip the
  workflow red; a `decide` step then interprets "filter failed" as
  fail-closed and runs the full gate. The mutation step actually runs when
  (a) the trigger isn't `pull_request`, (b) the filter failed, or (c) the
  diff touched bridge inputs (`metrics-bridge/src/**`,
  `metrics-bridge/test/**`, `metrics-bridge/stryker.config.mjs`,
  `metrics-bridge/vitest.mutation.config.ts`,
  `metrics-bridge/package.json`, `metrics-bridge/tsconfig.json`,
  shared-config inputs, or root package-manager files `package.json` /
  `pnpm-lock.yaml` / `pnpm-workspace.yaml` / `.npmrc`). When the mutation
  step does run and the score is below 86%, the job fails. If your PR
  fails the gate, treat
  any new surviving mutant as a real test gap unless you can classify it
  against the existing taxonomy in `docs/mutation-testing.md` and update
  that doc in the same PR.
- The dashboard + indexer mutation baselines remain advisory
  (`break: null`):
  the dashboard job has an `if: github.event_name != 'pull_request'`
  guard so it only runs on cron + manual dispatch. Promotion follows the
  bridge pattern: prove runtime/noise sane in CI runs, then flip
  `break`, add a new always-runs job for that package with the same
  inline `filter` + `decide` + `continue-on-error` shape (NOT a
  workflow-level `pull_request.paths` filter — required-status workflows
  must keep the trigger unfiltered per `AGENTS.md`).
- Revisit `docs/mutation-testing.md` when adding a new target or changing the
  accepted survivor classification.
