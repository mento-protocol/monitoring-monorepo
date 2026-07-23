---
title: Monitoring Dashboard Instructions
status: active
owner: eng
canonical: true
last_verified: 2026-07-23
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

## Browser Target — ES2017, No Polyfill

Client code targets ES2017 with no polyfill. Do not use `toSorted`,
`toReversed`, `toSpliced`, `findLast`, `findLastIndex`, `Array.prototype.with`,
`Object.groupBy`, `String.prototype.isWellFormed`, or another newer runtime API
merely because `lib: esnext` supplies types. Use `sortedCopy` from
`@/lib/immutable-sort` for immutable sorting; lint bans the unsafe array APIs.

ES2023+ is allowed only in server-only API routes, OG helpers, and tests. Any
module imported directly or transitively by a `"use client"` component ships to
the browser. See
[ADR 0023](../docs/adr/0023-es2017-no-polyfill.md) before changing the target,
polyfill posture, or restriction.

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
for every Hasura-polling hook. In particular:

- keep focus and reconnect revalidation disabled in `useGQL`, keep retry
  behavior visibility-aware, and use an explicit abort timeout below the
  refresh interval only for polling paths that must fail or degrade quickly;
- distinguish loading (`data === undefined && !error`) from resolved zero or
  empty data;
- use pre-rolled entities for lifetime aggregates. Hosted Hasura caps rows at
  1,000 and disables `_aggregate`; multi-field `order_by` uses array syntax;
- isolate new schema fields so an older hosted schema degrades only the new
  annotation during deploy/resync.

FX durations use trading-seconds and live paths call
`tradingSecondsInRange`; threshold-derived history uses the threshold captured
at event time. The stateful checklist owns the full time-unit contract.

## Interaction, URL, and Accessibility Invariants

- Async mutations require a synchronous in-flight ref guard in addition to
  disabled React state; wire abort cleanup and suppress teardown-only errors.
- URL state that does not require server involvement uses
  `history.replaceState`. Initialize from `useSearchParams`, use
  `window.location.search` after mount/action time, and preserve sibling params
  when history-only and router-backed writers coexist. Apply the URL section of
  the stateful checklist.
- Dynamic status uses `role="status"` or `role="alert"`; sortable headers expose
  `aria-sort`. Add deterministic axe coverage for new shared semantic controls.
- Source files have a 600-line soft cap and 1,000-line lint cap. Split route
  pages into `_lib`, `_components`, or `_tabs` before crossing the soft cap;
  see
  [`../docs/pr-checklists/recurring-review-patterns.md`](../docs/pr-checklists/recurring-review-patterns.md).

## Server Boundaries and CSP

Apply the dashboard server/client and Security/CSP sections of
[`../docs/pr-checklists/recurring-review-patterns.md`](../docs/pr-checklists/recurring-review-patterns.md).
Client-hook modules cannot enter OG, API, or server-route import graphs; shared
constants belong in zero-dependency modules. CSP is set only by middleware with
a per-request nonce. Keep `script-src` free of unsafe inline/eval, retain
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
