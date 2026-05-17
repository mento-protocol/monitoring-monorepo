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
  PR 436): `metrics-bridge/stryker.config.mjs` sets `break: 80`, and
  `.github/workflows/mutation-testing.yml` runs the bridge job on PRs that
  touch probe code, the stryker config, the mutation vitest config, or the
  bridge `package.json`. If your PR fails the gate, treat any new surviving
  mutant as a real test gap unless you can classify it against the existing
  taxonomy in `docs/mutation-testing.md` and update that doc in the same PR.
- The dashboard + indexer mutation baselines remain advisory (`break: null`)
  — the dashboard job is gated on the PR trigger so it only runs on cron +
  manual dispatch. Promotion follows the same pattern: prove runtime/noise
  sane in CI runs, then flip `break` and add the package's files to the
  `pull_request.paths` block.
- Revisit `docs/mutation-testing.md` when adding a new target or changing the
  accepted survivor classification.
