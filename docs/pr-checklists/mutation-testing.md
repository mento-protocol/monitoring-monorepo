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
- Keep mutation testing out of required pull-request CI until runtime and noise
  are re-evaluated. The current workflow is scheduled/manual only.
- Revisit `docs/mutation-testing.md` when adding a new target or changing the
  accepted survivor classification.
