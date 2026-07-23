---
title: Shared Config Instructions
status: active
owner: eng
canonical: true
last_verified: 2026-07-23
doc_type: agent-instructions
scope: shared-config
review_interval_days: 90
garden_lane: agent-entry-points
---

# AGENTS.md — Shared Config

> **Architecture decisions** for this package live in [`docs/adr/`](../docs/adr/README.md) (scope: `shared-config`) — read the relevant ADR before changing how something here is built; it records why the code is built that way.

## Scope

`shared-config/` publishes as `@mento-protocol/config` and is the source of truth for chain metadata, deployment namespaces, token/pool label derivation, FX calendar data, thresholds, and shared ABIs.

## Operating Rules

- Add or change config data with a cross-reference test.
- Keep exported modules stable for direct workspace consumers; dashboard, bridge,
  and integration-probes typechecks are part of the change surface. The indexer
  consumes checked-in mirrors of selected shared config.
- Keep the indexer's checked-in mirrors of `aggregators.json`,
  `deployment-namespaces.json`, `fx-calendar.json`, and
  `oracle-reporters.json` synchronized with this package. If the FX calendar
  changes, also verify trading-seconds assumptions in dashboard and indexer
  code paths.
- Do not hand-edit `dist/` as the source of truth. Update `src/` or JSON inputs, then run the package build.
- Avoid importing runtime-heavy packages here. `shared-config` is consumed by client bundle code and should stay low-dependency.
- Public npm releases are tag-driven through `.github/workflows/publish-config.yml`; publish tags must be `config-v<shared-config/package.json version>` and reference a commit reachable from `origin/main`. Manual `workflow_dispatch` runs validate and pack the package but do not publish. npm trusted publishing cannot create a brand-new package, so an npm org/package maintainer must seed `@mento-protocol/config` once through an approved maintainer publish before configuring trusted publishing for GitHub Actions with workflow filename `publish-config.yml`, allowed action `npm publish`, repository `mento-protocol/monitoring-monorepo`. Keep the publish job on GitHub-hosted runners because npm trusted publishing does not support self-hosted or third-party runners.
- The package's Node engine follows the repo `.node-version` throughout the pre-1.0 release line. Do not lower the engine floor without adding a matching consumer and publish verification matrix.

## Verification

Run `pnpm agent:quality-gate --run`. Its shared-config mapping covers package
lint, typecheck, tests, coverage, knip, build, direct-consumer typechecks, the
dashboard bundle-size limit, and conditional indexer mirror checks.
