---
title: Dashboard Local and Browser Verification
status: active
owner: eng
canonical: true
last_verified: 2026-08-25
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

Before Vercel CLI use, run
`vercel project inspect monitoring-dashboard --scope mentolabs`; require
`mentolabs/monitoring-dashboard` and its ID to match `.vercel/project.json`.
Never run `vercel curl --yes` unlinked: it can create/link a project and
protection bypass secret. If so, record project, organization, and bypass-secret
IDs; preserve Terraform targets. Remote deletion needs human approval; remove
only confirmed accidental local links.

Interactive `next dev` can rewrite `next-env.d.ts` to import
`./.next/dev/types/routes.d.ts`. Restore the production
`./.next/types/routes.d.ts` import before committing if the server changed it.

## Session-state verification

Logged-out checks must use an isolated browser context or clear both
`authjs.session-token` and `__Secure-authjs.session-token` for `127.0.0.1`.
Public pages show `Sign in`; protected pages (`/address-book` and its nested
`/address-book/entities` section, `/integrations`, and `/revenue`) redirect to
`/sign-in?callbackUrl=...` when auth is configured.

When API proof needs an existing authenticated browser session, keep the page
on the target origin and run a read-only same-origin request through page
evaluation:

```js
async function authenticatedApiCheck() {
  const response = await fetch("/api/...", {
    cache: "no-store",
    credentials: "same-origin",
  });
  const status = response.status;
  const text = await response.text();
  let body = null;
  let parseError = null;
  if (text !== "") {
    try {
      body = JSON.parse(text);
    } catch {
      parseError = "invalid-json";
    }
  }
  return {
    status,
    parseError,
    fields:
      body === null
        ? null
        : {
            // Select only the non-sensitive fields needed for this check.
            expectedField: body.expectedField,
          },
  };
}
```

Keep the raw response text and the full parsed body local. Record only the
status and the minimum non-sensitive fields that prove the acceptance criteria.
Set `parseError` to the fixed `invalid-json` category when non-empty response
text cannot be parsed. Do not include response text or parser details in it.
Redact secrets, private labels, forensic reports, and personal data. Do not
inspect cookies or browser storage. Do not use this path for a cross-origin
request or a mutation.

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
Logged-out sessions intentionally hide it and force all-actor queries, so a
protocol actor appearing while logged out is expected and does not exercise the
Organic filter. Verify that filter in a simulated session or query with
`isProtocolActorIn: [false]`.

## Route-specific assertions

Apply these when a change touches the surface. The `/verify-ui` command owns the
route-level smoke sequence and points here for the assertions.

### Polygon coverage

- `/pools` and `/volume`: select Polygon, verify `chain=137` in the URL, only Polygon rows/series remain, refresh keeps the selection, and selecting All removes the default query parameter without an RSC refetch.
- Polygon pool detail: EURm/EUROP renders each active strategy (Open and Reserve once promoted schema/data exist); during schema rollout, the page degrades to the legacy pointer without blanking the rest of the pool.
- `/stables`: Polygon USDm and EURm appear as distinct chain-qualified supplies not merged with another chain's token row.
- `/integrations`: Polygon appears per configured adapter; empty/error states stay distinct from unsupported coverage.

### `/bridge-flows`

- **KPI row (3 tiles):** `Total Bridge Transfers` (BreakdownTile, 24h/7d/30d), `Pending` (count or "1,000+"), `Avg deliver time` (h/m/s). None should be "—" or "…" on a healthy load.
- **Charts row (3 columns):** `Bridged Volume (USD)` time-series with 7d/30d/all buttons, `Token Breakdown` donut, `Top Bridgers` ranked list with address links.
- **Recent transfers table (25 rows):** columns Provider, Route, Status, Token, Amount (USD/native), Sender, Receiver, Txs, Time. Per-cell click targets:
  - **Wormholescan** (`wormholescan.io/#/tx/{sentTxHash}`): Provider badge, Amount (USD), Amount, and the `wh` pill in the Txs column
  - **Chain explorer** (Celoscan / Monadscan / Polygonscan): Token cell (`token contract`), Sender, Receiver, and the `src` pill in the Txs column
- **Key interactions to spot-check:**
  - Set source or destination to Polygon → URL contains `source=137` or `destination=137`, the opposite filter/status survives, and pagination resets to page 1
  - Refresh/back/forward preserves source, destination, status, and page; malformed/default parameters canonicalize out of the URL
  - Click a sortable header (e.g. "Amount (USD)") → rows re-sort, arrow flips on second click
  - Click an `AddressLink` → opens the correct explorer (Celoscan for 42220, MonadExplorer for 143, Polygonscan for 137)
  - Click the Wormholescan `wh` pill → opens `wormholescan.io/#/tx/{sentTxHash}?network=Mainnet` (NOT the digest)
- **STUCK overlay:** the status badge should read "Stuck" in red once a row remains `SENT` for more than 1h, `ATTESTED` for more than 15m, or `QUEUED_INBOUND` for more than 24h.
- **Empty / error states:** an error from one query should NOT blank the whole page — each KPI/chart/table gates on its own backing query.

## Production-build differences

For `pnpm build` plus `pnpm start`:

- `NEXT_PUBLIC_HASURA_URL` must exist at build time; only `pnpm dev` supplies a
  production default.
- Client Sentry initializes only when `VERCEL_ENV` is set at build time because
  `next.config.ts` inlines its `NEXT_PUBLIC_VERCEL_ENV` mirror. Server and edge
  instrumentation also read `VERCEL_ENV` at runtime, so keep it set when
  starting the built app. Use `VERCEL_ENV=preview` and a placeholder-format
  `NEXT_PUBLIC_SENTRY_DSN` for local Sentry behavior; do not set the public
  mirror directly.
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

`pnpm test:browser` serves a fixture-mode production build (`next build` into
`.next-fixture`) via `next start`, alongside
`tests/browser/fixtures/hasura-fixture-server.mjs`, then runs Playwright under
`tests/browser/`. There is no `next dev` server: the build is produced at most
once per gate run (the turbo `test:browser` task `dependsOn` the cached
`fixture-build` task) and reused across re-runs. Direct callers compare the
stored Turbo task hash with the current `fixture-build` hash and rebuild stale
or unverifiable output. The fixture server publishes an identity over its local
source closure, scenario, and response delay; the runner reuses port 3211 only
when that identity matches this checkout and fails without stopping an unknown
process on mismatch. Use the package scripts, not a direct `playwright test`,
so this preflight runs. The fixture server is the
only GraphQL source for these tests; never point it at hosted Hasura/Envio. The app-level
harness covers App Router navigation, URL state, hydration, CSP, SWR request
behavior, and real browser focus. On a fresh checkout, install Chromium once
with `pnpm exec playwright install chromium`; the quality gate does this
automatically. The fixture build snapshots and restores `next-env.d.ts` around
the `next build` that rewrites it.

The fixture Hasura server listens on a fixed port (`3211`) baked into the build;
the Next server port is OS-assigned at runtime. Only the fixture URL, not the
Next port, is inlined, so the build stays byte-stable and turbo-cacheable. Run
`pnpm test:browser:production` to force a fresh fixture build first. For
no-refetch assertions, filter `?_rsc=` requests to the current route: production
`next/link` may prefetch unrelated routes after load. `PLAYWRIGHT_NEXT_TIMEOUT_MS`
tunes how long Playwright waits for `next start`.

For local macOS runs with Chromium frame-detach flakes, use
`PLAYWRIGHT_FORCE_SINGLE_PROCESS=true`. To fall back to a dev server (e.g. a
Turbopack production-build panic), set
`PLAYWRIGHT_NEXT_COMMAND='pnpm dev --webpack --hostname 127.0.0.1 --port {port}'`.
CI leaves both overrides unset.

## Lighthouse pool fixture

`pnpm lighthouse:pool-fixture` is the deterministic production-build gate for
the canonical pool-detail LCP contract. It builds against the local
`lighthouse-pool` Hasura scenario, proves the SSR breaker and exact all-time
Volume headline stay visible while client revalidation is delayed, rejects
fixture GraphQL/request/browser errors, and collects three exact
`?lhci=fixture` Lighthouse runs against the blocking 1,700 ms median ceiling.
This command starts its non-default fixture scenario on a fresh OS-assigned
port and checks the unqualified health endpoint; it does not reuse Playwright's
fixed-port server. Both callers use the same scenario and delay normalizer.

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
- `js-tosorted-immutable` for the browser-floor compatibility workaround and
  `effect/no-event-handler` for debounced/URL-state false positives;
- `knip/files` for scripts, runtime-loaded browser fixtures, mutation config,
  and generated GraphQL;
- `knip/exports` and `knip/types` for generated GraphQL; outside generated
  code, the only `knip/exports` exception is the compatibility
  `HASURA_TIMEOUT_MS` re-export in `src/lib/graphql.ts`. New server imports use
  `@/lib/hasura-timeout`.

Do not broaden these silences to make a changed file pass.

## Visual comparison in the PR description

A UI PR carries a `## Visual comparison` section immediately after
`## The Solution`, before `## Details`. Capture the pair only after every
intended file and review fix is committed and the worktree is clean, recording
the final local `HEAD` OID first.

- Resolve and record the base commit OID before capture —
  `$BASE_REMOTE/$baseRefName` (both from the ship flow's target binding)
  moves, and a base advancing mid-capture puts a different commit behind
  **Before** than the PR is measured against. Render that immutable OID in an
  isolated worktree for **Before** and the recorded `HEAD` for **After**;
  never simulate the old state with DOM edits, stale deployments, or
  remembered screenshots.
- Use the same route, viewport, theme, auth state, and deterministic fixture
  data for both images. Crop to the product surface; expose no secrets,
  personal data, account identifiers, or unrelated browser chrome.
- Cover each materially different route or state the PR changes. A new route
  still needs a pair: the base route's prior result (its 404 or nearest parent
  state) against the new route at the recorded `HEAD`.
- Name the route or state, both recorded OIDs, the viewport, and the fixture
  or data source. Label the images **Before** and **After** side by side in a
  Markdown table.

Store review images outside the repository; never add them to the product
commit unless the repository already owns screenshot fixtures for that purpose.
Upload through the authenticated GitHub web description editor (`gh` and the
public Issues API cannot attach local images), then reopen the description and
verify both attachment URLs render and the labels map to the correct revisions.
A local path, broken Markdown, or an unverified upload is not visual evidence.

If either revision cannot be rendered, or the authenticated attachment surface
is unavailable, stop before publication and report the blocker; do not call the
UI PR shipped or ready. The user may waive visual evidence for a specific PR.

## Dynamic social-preview verification

For a change to dynamic route metadata or an Open Graph image route, verify the
final deployed origin in the browser. Do not use a local render as production
proof.

- Read the exact document title, description, and canonical URL; Open Graph
  type, URL, title, description, and image values; and Twitter card type,
  title, description, and image values from the raw initial HTML response of
  an isolated, cookie-free request. Confirm that each value matches the route
  and its public-data policy.
- Inspect the deployed document's `Cache-Control` and `Age` headers. Confirm
  that they match the route's declared freshness or revalidation policy. For
  metadata that can become private, require a policy that prevents stale
  public data from remaining in a shared cache, or perform an equivalent
  public-to-private revocation check.
- Compare those values with the live DOM when client-side hydration is
  relevant. The hydrated DOM alone does not prove what a crawler receives.
- Fetch the exact image URL from the deployed document with the browser cache
  disabled. Require HTTP 200, the expected image content type, and the declared
  pixel dimensions. Inspect `Cache-Control` and `Age`, and confirm that they
  match the route's declared freshness or revalidation policy. Disabling the
  browser cache does not bypass a CDN cache.
- Inspect the rendered image. Confirm that it identifies the correct route,
  shows the expected data or fallback state, and has no blank or clipped
  content.
- Check browser console errors after the route and image load.
- Use a URL that Slack has not expanded before when testing the unfurl. Slack
  can retain the first unfurl for a shared URL, so an existing message does not
  prove that the current metadata or image is live. Inspect the new unfurl and
  confirm that its content matches the rendered image.
