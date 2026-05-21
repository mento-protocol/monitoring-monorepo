# Agent Gate Dashboard Cache Safety

Status: implemented by `chore/agent-gate-dashboard-turbo`.

This note defines the conservative input surface and regression tests required
for caching dashboard build or browser-test commands in the agent quality gate.
The Turbo worker PR established the repo's canonical local cache runner and
command mapping shape; dashboard build, size-limit, and browser-test local
agent-gate commands now use that runner with the input surface below.

## Scope

Candidate commands:

- `pnpm dashboard:build`
- `pnpm dashboard:size-limit` when it consumes the build output
- `pnpm --filter @mento-protocol/ui-dashboard test:browser`

`size-limit` depends on `build` in `turbo.json` because it reads `.next/`
output. Other cached gate tasks intentionally avoid broad workspace dependency
pipelines.

Do not cache:

- `pnpm --filter @mento-protocol/ui-dashboard exec playwright install chromium`
- `pnpm --filter @mento-protocol/ui-dashboard test:browser:update-snapshots`

The browser suite may be cached locally for the agent gate only. CI should keep
running the suite normally because it is the Linux snapshot authority and
uploads failure artifacts from `ui-dashboard/test-results/`.

## Required Cache Inputs

Use root-relative paths. The safe default is broader than the currently observed
import graph; it should only be narrowed after a failing regression test proves a
path is unnecessary.

Dashboard build and size-limit inputs:

- `ui-dashboard/src/**`
- `ui-dashboard/public/**` if added later
- `ui-dashboard/package.json`
- `ui-dashboard/next.config.*`
- `ui-dashboard/postcss.config.*`
- `ui-dashboard/tsconfig*.json`
- `ui-dashboard/sentry.*.config.*`
- `ui-dashboard/sentry.shared.ts`
- `ui-dashboard/.size-limit.cjs`
- `ui-dashboard/vercel.json`
- `ui-dashboard/.env.production.local.example`
- `shared-config/src/**`
- `shared-config/*.json`
- `shared-config/package.json`
- `shared-config/tsconfig*.json`
- `shared-config/dist/**` if generated outputs are committed or restored by the
  cache runner
- `package.json`
- `pnpm-lock.yaml`
- `pnpm-workspace.yaml`
- `.npmrc`
- `.node-version`
- `.github/actions/pnpm-install/**`
- `.github/workflows/size-limit.yml`
- the cache runner/config files introduced by the Turbo worker PR

Dashboard build environment key:

- `VERCEL_ENV`, because `next.config.ts` mirrors it into
  `NEXT_PUBLIC_VERCEL_ENV`

Browser-test inputs:

- dashboard source/runtime config inputs above, because Playwright starts
  `next dev`; exclude `.size-limit.cjs` because browser tests do not read the
  size-budget file
- `ui-dashboard/playwright.config.ts`
- `ui-dashboard/scripts/run-browser-tests.mjs`
- `ui-dashboard/tests/browser/**`
- `ui-dashboard/next-env.d.ts`
- `.github/workflows/ci.yml`
- `.github/workflows/update-snapshots.yml`
- the cache runner/config files introduced by the Turbo worker PR

Browser-test environment key:

- `PLAYWRIGHT_NEXT_PORT`
- `PLAYWRIGHT_FIXTURE_PORT`
- `CI`
- `NEXT_TELEMETRY_DISABLED`
- `NEXT_PUBLIC_HASURA_URL`
- `NEXT_PUBLIC_BROWSER_TEST_FIXTURES`
- `VERCEL_ENV`

The Playwright config overrides the Hasura fixture env for its own web server,
but include the public env names anyway so a future config simplification cannot
silently reuse an incompatible cached result.

## Regression Tests To Add With Implementation

Add these tests next to the Turbo worker's command-mapping tests, not by
rewriting the quality-gate dispatcher.

1. `shared-config/src/chains.ts` invalidates both dashboard build and browser
   tests.

   This is the mandatory guard for the previously unsafe naive Turbo prototype:
   changing `shared-config/src/chains.ts` did not invalidate
   `ui-dashboard` tests. The test should fail if the cache key only includes
   direct `ui-dashboard/**` inputs or only package dependency declarations.

2. `shared-config/fx-calendar.json` invalidates dashboard build and browser
   tests.

   This covers JSON exports consumed by `ui-dashboard/src/lib/weekend.ts` and
   the existing Playwright deterministic-weekend fixtures.

3. `ui-dashboard/tests/browser/fixtures/hasura-fixture-server.mjs` invalidates
   browser tests but does not force a dashboard build-only cache miss.

   Current gate note: this path does map to `pnpm dashboard:build` today because
   the shell `case` pattern `ui-dashboard/*.mjs` also matches nested `.mjs`
   paths. If PR 3 changes that routing, do it as an explicit narrow fix with a
   regression test; otherwise keep routing as-is and still keep the build cache
   key separate from browser fixture inputs.

4. `ui-dashboard/playwright.config.ts` invalidates browser tests but does not
   force a dashboard build-only cache miss.

5. `ui-dashboard/postcss.config.mjs`, `ui-dashboard/next.config.ts`, and
   `ui-dashboard/src/instrumentation-client.ts` invalidate the dashboard build.

6. Root package-manager inputs (`package.json`, `pnpm-lock.yaml`,
   `pnpm-workspace.yaml`, `.npmrc`, `.node-version`) invalidate both commands.

7. Cache runner/config changes invalidate both commands.

8. Snapshot update command is never cacheable.

## Command-Mapping Expectations

Current agent-gate behavior:

- Direct `ui-dashboard/*` changes map to dashboard package checks,
  Playwright Chromium install, browser tests, and React Doctor checks. The
  build/size-limit routing is bundle-affecting paths only. Browser fixtures and
  Playwright config invalidate browser-test cache entries without forcing an
  unrelated dashboard build cache miss.
- `shared-config/*` changes map to shared-config package checks, shared-config
  build, dashboard and metrics-bridge typechecks, plus dashboard build and
  size-limit.
- `shared-config/*` changes do not currently map to local browser tests. The
  browser-test cache key still must include shared-config inputs so a manual or
  future mapped `test:browser` invocation cannot hit stale dashboard metadata.
- Workspace-wide package-manager changes deliberately skip local browser tests
  today because the browser suite is high-cost and uses macOS sandbox
  workarounds locally.

PR 3 should preserve that routing policy unless the user explicitly asks to make
workspace-wide changes run browser tests locally. Caching should speed up
commands that already map; it should not broaden when browser tests run as a
side effect of the cache work.

## Risk Assessment

The biggest correctness risk is under-keying cross-package imports. The
dashboard imports `@mento-protocol/monitoring-config` TypeScript exports and
JSON exports at build/dev time, so `shared-config/src/**` and
`shared-config/*.json` must both be first-class inputs.

The second risk is treating browser tests like a pure unit-test task. They are
fixture-driven but still depend on Next dev-server compilation, Playwright
config, browser-test fixtures, snapshots, sandbox detection, and env-derived
ports. Cache only the local agent-gate result, not generated snapshots or CI
artifacts.

The third risk is stale generated package output. `shared-config/dist/**` is not
committed today, but the cache runner must either build linked workspace
packages before dashboard commands or include restored generated outputs in the
key. A green cache hit with stale `dist/` is unsafe.
