---
title: Retire the duplicate bundle-size advisory workflow
status: active
owner: eng
canonical: true
last_verified: 2026-09-14
scope: ci/process
date: 2026-09
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0099 — retire the duplicate bundle-size advisory workflow

**Status:** Accepted (Sep 2026), in force.
**Scope:** ci/process

## Context

[ADR 0078](0078-staged-verification-redesign.md) M3 gave the required `ci`
sentinel's `ui` job "the normal production build and bundle-size limit" and
noted that "the separate Infra validation and bundle-size workflows duplicate
required coverage," but chose to keep both rather than remove the duplicate in
that PR. `.github/workflows/size-limit.yml` runs the same `next build` and
checks the same `ui-dashboard/.size-limit.cjs` budget that `ci.yml`'s
`ui-static` job already runs via `pnpm exec turbo run size-limit`, on the same
runner label.
It has no unique coverage: every path it triggers on already selects `ui`,
either through `ci.yml`'s `ui` filter anchor or through the `forceAll`
fallback (`.npmrc`, the one path outside that anchor, sits in the
`controlPlane` filter, which forces `ui` regardless). A failing budget on that
workflow shows up as a second, non-required "Bundle Size" check that a
reviewer can ignore, instead of the required `ci` check the required path
already produces.

## Decision

Delete `.github/workflows/size-limit.yml`. The bundle-size budget keeps
running exactly as before, in the required `ci` sentinel's `ui-static` job
(`scripts/workflows/check-ci-contract.mjs` pins that command). Every reference
the deletion strands moves to point at `ci.yml`'s `ui` filter or turbo's
`build`/`size-limit` task inputs instead — the latter for the operating-card
author-check row and its `guardrail-prose.json` pin, since it (unlike the `ui`
filter) also covers root `.npmrc`. The advisory-`paths:` exemplar list in
`docs/pr-checklists/ci-workflow-gates.md`, the local pre-PR gate's `why`
strings in `scripts/gate/routing-table/arms-packages.mjs` and
`arms-services.mjs`, and the file's three `turbo.json` cache-key entries.

## Alternatives considered

- **Keep both, as ADR 0078 did.** Rejected: a pure duplicate boot at measured
  cost (hundreds of runner boots a month) with no coverage benefit.
- **Add `.npmrc` to the `ci.yml` `ui` filter first, to "close a coverage
  gap."** Rejected: no gap exists — `.npmrc` already sits in the
  `controlPlane` filter, which forces `ui` unconditionally.
- **Move the budget check out of `ci.yml` into `size-limit.yml`.** Rejected:
  that would make the budget enforceable only through a non-required
  workflow, weakening rather than preserving the gate.

## Consequences

- "Bundle Size" no longer appears as an independently named PR check; the
  identical failure now surfaces as `ci` failing at "Production build and
  bundle-size budget".
- The budget check runs after `ui-static`'s earlier steps (lint, knip,
  react-doctor), so a PR failing one of those no longer gets an independent
  bundle-size signal in the same run; `turbo.json`'s `build`, `size-limit`,
  and `test:browser` task inputs each drop one now-nonexistent cache-key input.

## Evidence

- `.github/workflows/ci.yml`'s `ui-static` job runs
  `VERCEL_DEPLOYMENT_ID=ci pnpm exec turbo run size-limit --filter=@mento-protocol/ui-dashboard`
  against the same `ui-dashboard/.size-limit.cjs` budget, already selected by
  its `ui` filter anchor plus the `controlPlane`/`forceAll` fallback on every
  path the deleted workflow triggered on; `scripts/workflows/check-ci-contract.mjs`
  pins that command, and `check-ci-contract.test.mjs` asserts `.npmrc` forces
  `forceAll` today, refuting the coverage-gap premise.
- Raised on [issue #2403](https://github.com/mento-protocol/monitoring-monorepo/issues/2403).
