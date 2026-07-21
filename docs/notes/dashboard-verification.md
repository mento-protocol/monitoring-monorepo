---
title: Dashboard Local and Browser Verification
status: active
owner: eng
canonical: true
last_verified: 2026-07-17
doc_type: runbook
scope: ui-dashboard
review_interval_days: 90
garden_lane: operator-runbooks
---

# Dashboard Local and Browser Verification

Use this runbook for manual browser review and for the dashboard's deterministic
Playwright, Lighthouse, and React Doctor gates. UI changes are not complete
until the changed behavior has been exercised in a browser; when session state
changes the surface, verify both public and authenticated states.

## Local server and data

Use a fixed port so the verified URL is reproducible:

```bash
cd ui-dashboard
AUTH_SECRET=local-dev-dashboard-auth-secret-do-not-use-in-prod \
AUTH_GOOGLE_ID=local-dev-google-id \
AUTH_GOOGLE_SECRET=local-dev-google-secret \
pnpm dev --hostname 127.0.0.1 --port 3210
```

`pnpm dev` defaults `NEXT_PUBLIC_HASURA_URL` to the live production Envio
endpoint. Set it explicitly only for a non-production or fixture endpoint.
Provide `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` when labels,
reports, entities, or authenticated editing need real state. Placeholder Google
credentials are sufficient for a simulated local session; never use production
OAuth secrets merely to simulate login.

Vercel previews may redirect an agent browser to Vercel login. Unless the
change concerns preview protection, verify on localhost and use the trusted CI
preview/Lighthouse checks as deployment proof. Changes to preview access must
exercise the preview with the workflow's configured bypass path.

Interactive `next dev` can rewrite `next-env.d.ts` to import
`./.next/dev/types/routes.d.ts`. Restore the production
`./.next/types/routes.d.ts` import before committing if the server changed it.

## Session-state verification

Logged-out checks must use an isolated browser context or clear both
`authjs.session-token` and `__Secure-authjs.session-token` for `127.0.0.1`.
Public pages show `Sign in`; protected pages (`/address-book`, `/entities`,
`/integrations`, and `/revenue`) redirect to
`/sign-in?callbackUrl=...` when auth is configured.

For a simulated authenticated session:

1. Start the dev server with the `AUTH_SECRET` above.
2. From `ui-dashboard/`, mint an Auth.js token with the same secret:

   ```bash
   AUTH_SECRET=local-dev-dashboard-auth-secret-do-not-use-in-prod node --input-type=module -e 'import { encode } from "next-auth/jwt"; const secret = process.env.AUTH_SECRET; if (!secret) throw new Error("AUTH_SECRET is required"); const token = await encode({ secret, salt: "authjs.session-token", token: { email: "dev@mentolabs.xyz", refresh_token: "local-dev", expires_at: Math.floor(Date.now() / 1000) + 3600 }, maxAge: 30 * 24 * 60 * 60 }); console.log(token);'
   ```

3. Set the cookie in the localhost page, replacing `<TOKEN>`:

   ```js
   document.cookie =
     "authjs.session-token=<TOKEN>; Path=/; SameSite=Lax; Max-Age=2592000";
   location.reload();
   ```

4. Confirm the nav shows `dev@mentolabs.xyz` and `Sign out`, protected routes
   render, and authenticated controls are visible.

The `/volume` Organic/All protocol-actor control is authenticated-only.
Logged-out sessions intentionally hide it and force all-volume queries, so a
protocol actor appearing while logged out does not disprove organic filtering.
Verify that filter in a simulated session or query with
`isProtocolActorIn: [false]`.

## Production-build differences

For `pnpm build` plus `pnpm start`:

- `NEXT_PUBLIC_HASURA_URL` must exist at build time; only `pnpm dev` supplies a
  production default.
- Sentry initializes only when `VERCEL_ENV` is set at build time. Use
  `VERCEL_ENV=preview` and a placeholder-format `NEXT_PUBLIC_SENTRY_DSN` for
  local Sentry behavior. `next.config.ts` owns the
  `NEXT_PUBLIC_VERCEL_ENV` mirror; do not set that mirror directly.
- The persisted SWR build salt is derived from
  `VERCEL_DEPLOYMENT_ID ?? VERCEL_GIT_COMMIT_SHA ?? "dev"` and inlined as
  `NEXT_PUBLIC_SWR_CACHE_BUILD_SALT`. Do not configure the public mirror. The
  agent quality gate supplies its own stable local deployment identity for the
  build-backed size check, so operator-local Vercel placeholders are ignored on
  that path.
- `.next/cache/fetch-cache` survives `next start` restarts; remove it before a
  true cold-cache measurement.

Production Sentry traffic is tunneled through `/monitoring`. A Sentry-only 429
with `x-sentry-rate-limits` such as `transaction_usage_exceeded` is quota noise
when page-data requests still return 200 and the UI renders. Report it
separately. Non-Sentry 429s and failed GraphQL/API calls are regressions.

## Fixture browser tests

`pnpm test:browser` starts the real Next app and
`tests/browser/fixtures/hasura-fixture-server.mjs`, then runs Playwright under
`tests/browser/`. The fixture server is the only GraphQL source for these
tests; never point them at hosted Hasura/Envio. The app-level harness covers App
Router navigation, URL state, hydration, CSP, SWR request behavior, and real
browser focus. On a fresh checkout, install Chromium once with
`pnpm exec playwright install chromium`; the quality gate does this
automatically. The wrapper restores `next-env.d.ts` and removes dev route types.

Use `pnpm test:browser:production` for `next build` plus `next start`. It
allocates fixture ports before build, starts Hasura first, bakes the fixture URL
into the build, and reuses the same Playwright suite. For no-refetch assertions,
filter `?_rsc=` requests to the current route: production `next/link` may
prefetch unrelated routes after load. `PLAYWRIGHT_NEXT_START_TIMEOUT_MS` tunes
the production server; `PLAYWRIGHT_NEXT_TIMEOUT_MS` tunes dev.

For local macOS runs with Chromium frame-detach flakes, use
`PLAYWRIGHT_FORCE_SINGLE_PROCESS=true`. If Turbopack panics locally, use
`PLAYWRIGHT_NEXT_COMMAND='pnpm dev --webpack --hostname 127.0.0.1 --port {port}'`.
CI leaves both overrides unset.

## Lighthouse pool fixture

`pnpm lighthouse:pool-fixture` is the deterministic production-build gate for
the canonical pool-detail LCP contract. It builds against the local
`lighthouse-pool` Hasura scenario, proves the SSR breaker and exact all-time
Volume headline stay visible while client revalidation is delayed, rejects
fixture GraphQL/request/browser errors, and collects three exact
`?lhci=fixture` Lighthouse runs against the blocking 1,700 ms median ceiling.

The browser smoke requires exactly one delayed breaker completion. Lighthouse
may make additional valid retries or prefetches but requires at least four
cumulative completions afterward. Diagnostics must contain exactly three runs,
each proving GraphQL duration above 1,700 ms and completion after LCP, plus a
real blocking LHCI result across all three values. Artifacts live under
`reports/lighthouse-pool/`. The trusted preview's `?lhci=live` run remains the
source for Vercel, live-indexer, and production-service variance.

## React Doctor

CI runs `react-doctor --diff origin/<base> --fail-on warning`. The diff is
file-level, so it scans every touched source file in full. Touched files should
normally be clean because the full-score floor is 100. Fix warnings or use a
narrow `// react-doctor-disable-next-line <rule-id>` with a one-line rationale
when a finding is genuinely inapplicable.

Run `pnpm dashboard:react-doctor:diff` from the root for the CI-equivalent diff
scan, `pnpm react-doctor` inside the package for a full scan, and
`pnpm react-doctor:score` for the enforced 100/100 score. The standalone CLI
and `react-doctor.config.json` are authoritative even where noisy rules are
disabled in ESLint.

Current intentional silences are:

- project-wide stylistic `react-doctor/design-*` rules;
- `no-secrets-in-client-code` in tests/scripts with placeholder public data;
- `js-tosorted-immutable` for the ES2017 compatibility workaround and
  `effect/no-event-handler` for debounced/URL-state false positives;
- `knip/files` for runtime-loaded browser fixtures and mutation config;
- `knip/exports` only for the compatibility `HASURA_TIMEOUT_MS` re-export in
  `src/lib/graphql.ts`; new server imports use `@/lib/hasura-timeout`.

Do not broaden these silences to make a changed file pass.
