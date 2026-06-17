# React Compiler annotation-mode pilot

Issue: #709

## Scope

- Enable `babel-plugin-react-compiler` for `ui-dashboard`.
- Keep global compilation off with `reactCompiler: { compilationMode: "annotation" }`.
- Opt in only `ui-dashboard/src/app/pools/_components/pools-page-client.tsx` via `"use memo"` on `PoolsContent`.

`/pools` was chosen as the first high-churn surface because it combines live pool data, URL-backed filter and limit controls, derived pool maps, sortable global pools, and recent-swap table rendering. Existing browser coverage already exercises navigation, layout, degraded query handling, and weekend-banner hydration on this route.

## Baseline

Local command:

```bash
command time -p pnpm dashboard:build
```

Result before enabling the compiler:

- Build status: pass when run outside the Codex sandbox.
- Wall time: 23.28s.
- Next compile phase: 9.7s.
- TypeScript phase: 8.3s.

The same command can fail in restricted local sandboxes when Turbopack attempts to bind a local port and macOS denies it with `Operation not permitted`.

## Compiler-enabled evidence

Local command:

```bash
command time -p pnpm dashboard:build
```

Result after enabling annotation mode and adding `"use memo"` to `PoolsContent`:

- Build status: pass when run outside the Codex sandbox.
- Wall time: 26.30s.
- Next compile phase: 11.1s.
- TypeScript phase: 9.8s.
- Delta vs baseline: +3.02s wall time and +1.4s compile time.

Browser interaction evidence:

- Added a `/pools` browser regression for raw pool-address filtering while preserving `poolsSort` / `poolsDir` URL state.
- Focused run: `pnpm --filter @mento-protocol/ui-dashboard test:browser --grep "filters pools swaps"` passed in 2.6s.
- Traced focused run: `pnpm --filter @mento-protocol/ui-dashboard test:browser --grep "filters pools swaps" --trace on` passed in 2.4s and wrote `ui-dashboard/test-results/dashboard-flows-dashboard--8fb52-erving-table-sort-URL-state/trace.zip`.
- Full fixture-backed browser run: `pnpm --filter @mento-protocol/ui-dashboard test:browser` passed 17/17 in 47.4s; the new `/pools` test passed in 828ms within that run.

## Rollout decision

Keep annotation mode for now. This pilot proves the annotated `/pools` surface still builds and passes interaction coverage, but it does not show a build-time win and the captured browser evidence is functional/trace evidence rather than a repeatable render-count improvement. Do not switch to `reactCompiler: true` until at least one measured interaction on `/pools` shows a repeatable render or responsiveness win and the dashboard gate stays green with more annotated surfaces.

No `"use no memo"` exclusions are currently required.
