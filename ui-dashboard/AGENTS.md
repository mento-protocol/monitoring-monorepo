---
title: Monitoring Dashboard Instructions
status: active
owner: eng
canonical: true
last_verified: 2026-08-31
doc_type: agent-instructions
scope: ui-dashboard
review_interval_days: 90
garden_lane: agent-entry-points
---

# AGENTS.md — Monitoring Dashboard

Read the `ui-dashboard` records in
[`docs/adr/`](../docs/adr/README.md) before changing architecture. The root
README and [`SPEC.md`](../SPEC.md) own topology; `src/lib/networks.ts` is the
runtime source for supported networks and shared-config overrides.

Production targets include `celo-mainnet`, `monad-mainnet`, and
`polygon-mainnet`; they share `NEXT_PUBLIC_HASURA_URL` and filter by `chainId`.
Testnet targets include `celo-sepolia`, `monad-testnet`, and `polygon-amoy`;
Polygon Amoy shares `NEXT_PUBLIC_HASURA_URL_TESTNET` with Monad Testnet and stays
hidden unless testnet networks are enabled and that endpoint is configured.

## Before Opening PRs

For pagination, sort/search, charts tied to table state, GraphQL shapes,
degraded/error behavior, or any indexer→query→UI field path, apply
[`../docs/pr-checklists/stateful-data-ui.md`](../docs/pr-checklists/stateful-data-ui.md).
Cross-layer/stateful UI work must define invariants, degraded behavior, and
interaction coverage before review.

## Key Sources and Commands

- `src/app/` — App Router pages and route-private components.
- `src/lib/` — GraphQL/data utilities, network configuration, and shared UI
  logic.
- `next.config.ts`, `src/middleware.ts`, and `src/lib/csp.ts` — build/runtime
  configuration and the single nonce-based CSP path.
- `tests/browser/` — fixture-driven Playwright interaction coverage.
- `react-doctor.config.json` and `eslint.config.mjs` — React/browser policy.

Use package scripts in `package.json` or the root command reference in
[`../docs/notes/quick-commands.md`](../docs/notes/quick-commands.md). Regenerate
`src/lib/__generated__/graphql.ts` after changing query strings,
`../indexer-envio/schema.graphql`, or `../scripts/envio-schema-stubs.graphql`.
Keep runtime Zod guards for hosted-Hasura rollout drift.

## Browser Target — Explicit Runtime Floor, No Blocklist Polyfills

Client code is transpiled to ES2017 and the app adds no blocklist polyfill. The
runtime floor is Chrome 111+, Edge 111+, Firefox 111+, and Safari 16.4+, pinned
in `package.json`. Lint owns the closed blocklist of post-floor APIs in
client-shipped code — any module a `"use client"` component imports directly or
transitively ships to the browser — so use `sortedCopy` from
`@/lib/immutable-sort` for immutable sorting. The blocklist is not an exhaustive
compatibility checker: update the policy and its regression fixtures before
adding an API outside the floor, and read
[ADR 0023](../docs/adr/0023-es2017-no-polyfill.md) before changing the
transpilation target, floor, or polyfill posture.

## Browser and Quality Verification

Browser verification is mandatory for UI changes. Follow
[`../docs/notes/dashboard-verification.md`](../docs/notes/dashboard-verification.md)
for the fixed localhost server, production data default, simulated Auth.js
session, logged-in/out expectations, production-build env, Playwright fixtures,
Lighthouse contract, and local macOS fallbacks. Verify both auth states when
the changed surface differs by session.

Fixture browser tests use only their local Hasura server; never point them at
hosted Envio. React Doctor scans every touched file in full and the enforced
score is 100/100. Run the root CI-equivalent diff command and fix diagnostics or
use only a narrowly justified inline suppression.

## Data and Polling Invariants

Apply
[`../docs/pr-checklists/swr-polling-hasura.md`](../docs/pr-checklists/swr-polling-hasura.md)
to every Hasura-polling hook; it owns revalidation, retry, loading-versus-empty
semantics, row caps, and schema-rollout isolation. Two domain facts it does not
carry: lifetime aggregates read pre-rolled entities, and FX durations use
trading-seconds — live paths call `tradingSecondsInRange`, and
threshold-derived history uses the threshold captured at event time.

## Interaction, URL, and Accessibility Invariants

- Async mutations need a synchronous in-flight ref guard alongside disabled
  React state; wire abort cleanup and suppress teardown-only errors.
- Server-free URL state uses `history.replaceState`: initialize from
  `useSearchParams`, read `window.location.search` after mount or action time,
  and preserve sibling params when history-only and router-backed writers
  coexist.
- Dynamic status uses `role="status"` or `role="alert"`; sortable headers expose
  `aria-sort`. Add deterministic axe coverage for new shared semantic controls.
- Source files have a soft cap of 600 effective lines and a lint cap of 1,000
  effective lines. The package `max-lines` rule skips blank lines and comments.
  Generated files under `src/lib/__generated__/`, tests, and `src/lib/types.ts`
  are exempt. Compare the effective count with the merge base. A change that
  reduces an already-over-threshold file does not require another split. For a
  route page, split net growth that leaves the file above the soft cap into
  `_lib`, `_components`, or `_tabs`. For an oversized non-route file, split
  such growth into cohesive sibling modules.

## Server Boundaries and CSP

Apply the dashboard server/client and Security/CSP sections of
[`../docs/pr-checklists/recurring-review-patterns.md`](../docs/pr-checklists/recurring-review-patterns.md).
Client-hook modules cannot enter OG, API, or server-route import graphs; shared
constants belong in zero-dependency modules. Only middleware sets CSP, with a
per-request nonce. Keep `script-src` free of unsafe inline/eval, retain
attribute-style support in `style-src`, and update CSP tests with every
`connect-src` change.

## Liquity / CDP

Read
[`../docs/notes/liquity-monitoring-invariants.md`](../docs/notes/liquity-monitoring-invariants.md)
before changing CDP queries, derived metrics, health, redemption attribution, or
formatting. Open positions mean active plus zombie Troves until the indexer
ships a delta-maintained `openTroveCount`. Rebalance redemptions are a subset of
totals. Choose unsigned-versus-signed wei formatters from the source field's
semantics so a legitimate `-1 wei` delta is not treated as the unknown sentinel.
